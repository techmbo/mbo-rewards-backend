import { z } from "zod";
import {
  loginUser,
  logAccess,
  registerUser,
  signAccessToken,
  toPublicUser,
  findUserByEmail,
} from "../modules/auth/auth.service.js";
import { sendSignupOtp, verifySignupOtp } from "../modules/auth/otp.service.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters."),
  name: z.string().trim().min(1).max(120).optional(),
  verificationToken: z.string().min(1, "Email verification is required."),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const sendOtpSchema = z.object({
  email: z.string().email(),
});

const verifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().regex(/^\d{6}$/, "OTP must be a 6-digit code."),
});

function handleAuthError(res, next, error) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ ok: false, message: error.issues[0]?.message || "Invalid input." });
    return;
  }
  if (error.statusCode) {
    res.status(error.statusCode).json({ ok: false, message: error.message });
    return;
  }
  next(error);
}

export async function sendOtpHandler(req, res, next) {
  try {
    const body = sendOtpSchema.parse(req.body);
    const existing = await findUserByEmail(body.email);
    if (existing) {
      res.status(409).json({ ok: false, message: "An account with this email already exists." });
      return;
    }

    const result = await sendSignupOtp(body.email);
    res.json({ ok: true, ...result });
  } catch (error) {
    handleAuthError(res, next, error);
  }
}

export async function verifyOtpHandler(req, res, next) {
  try {
    const body = verifyOtpSchema.parse(req.body);
    const result = await verifySignupOtp(body.email, body.otp);
    res.json({ ok: true, ...result });
  } catch (error) {
    handleAuthError(res, next, error);
  }
}

export async function registerHandler(req, res, next) {
  try {
    const body = registerSchema.parse(req.body);
    const user = await registerUser(body);
    const accessToken = signAccessToken(user);

    await logAccess({
      userId: user.id,
      action: "auth.register",
      resource: "auth",
      ipAddress: req.ip,
    });

    res.status(201).json({
      ok: true,
      accessToken,
      user: toPublicUser(user),
      message:
        user.role === "ADMIN"
          ? "Welcome! You are the first user and have been assigned the Admin role."
          : "Account created. You have Support access until an admin updates your role.",
    });
  } catch (error) {
    handleAuthError(res, next, error);
  }
}

export async function loginHandler(req, res, next) {
  try {
    const body = loginSchema.parse(req.body);
    const user = await loginUser(body);
    const accessToken = signAccessToken(user);

    await logAccess({
      userId: user.id,
      action: "auth.login",
      resource: "auth",
      ipAddress: req.ip,
    });

    res.json({
      ok: true,
      accessToken,
      user: toPublicUser(user),
    });
  } catch (error) {
    handleAuthError(res, next, error);
  }
}

export async function meHandler(req, res) {
  res.json({
    ok: true,
    user: toPublicUser(req.user),
  });
}

export async function logoutHandler(req, res) {
  await logAccess({
    userId: req.user.id,
    action: "auth.logout",
    resource: "auth",
    ipAddress: req.ip,
  });

  res.json({ ok: true, message: "Logged out." });
}
