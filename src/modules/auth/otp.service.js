import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../database/prisma.js";
import { sendOtpEmail } from "./email.service.js";

const OTP_SALT_ROUNDS = 10;

const OTP_EXPIRY_MINUTES = 10;
const OTP_RESEND_COOLDOWN_SECONDS = 60;
const MAX_VERIFY_ATTEMPTS = 5;
const VERIFICATION_TOKEN_EXPIRY = "15m";

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }
  return secret;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

export function signEmailVerificationToken(email) {
  return jwt.sign(
    {
      email: normalizeEmail(email),
      purpose: "email_verification",
    },
    getJwtSecret(),
    { expiresIn: VERIFICATION_TOKEN_EXPIRY },
  );
}

export function verifyEmailVerificationToken(token) {
  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (payload?.purpose !== "email_verification" || !payload?.email) {
      const error = new Error("Invalid or expired verification token.");
      error.statusCode = 401;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
    const wrapped = new Error("Invalid or expired verification token.");
    wrapped.statusCode = 401;
    throw wrapped;
  }
}

export async function sendSignupOtp(email) {
  const normalizedEmail = normalizeEmail(email);
  const now = new Date();

  const recentOtp = await prisma.emailOtp.findFirst({
    where: {
      email: normalizedEmail,
      createdAt: { gte: new Date(now.getTime() - OTP_RESEND_COOLDOWN_SECONDS * 1000) },
    },
    orderBy: { createdAt: "desc" },
  });

  if (recentOtp) {
    const error = new Error("Please wait a minute before requesting another code.");
    error.statusCode = 429;
    throw error;
  }

  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, OTP_SALT_ROUNDS);
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await prisma.emailOtp.create({
    data: {
      email: normalizedEmail,
      otpHash,
      expiresAt,
    },
  });

  await sendOtpEmail({ to: normalizedEmail, otp });

  return {
    message: "Verification code sent.",
    expiresInMinutes: OTP_EXPIRY_MINUTES,
  };
}

export async function verifySignupOtp(email, otp) {
  const normalizedEmail = normalizeEmail(email);
  const now = new Date();

  const record = await prisma.emailOtp.findFirst({
    where: {
      email: normalizedEmail,
      verifiedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!record) {
    const error = new Error("No active verification code found. Request a new one.");
    error.statusCode = 400;
    throw error;
  }

  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    const error = new Error("Too many invalid attempts. Request a new code.");
    error.statusCode = 429;
    throw error;
  }

  const isValid = await bcrypt.compare(String(otp), record.otpHash);

  if (!isValid) {
    await prisma.emailOtp.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    const error = new Error("Invalid OTP. Please try again.");
    error.statusCode = 400;
    throw error;
  }

  await prisma.emailOtp.update({
    where: { id: record.id },
    data: { verifiedAt: now },
  });

  return {
    message: "Email verified.",
    verificationToken: signEmailVerificationToken(normalizedEmail),
  };
}

export async function consumeEmailVerification(email) {
  const normalizedEmail = normalizeEmail(email);
  await prisma.emailOtp.deleteMany({
    where: { email: normalizedEmail },
  });
}
