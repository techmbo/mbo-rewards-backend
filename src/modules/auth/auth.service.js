import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "../../database/prisma.js";
import { getPermissionsForRole } from "../../auth/permissions.js";
import { verifyEmailVerificationToken } from "./otp.service.js";

const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = "7d";

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured.");
  }
  return secret;
}

export function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    clientId: user.clientId ?? null,
    createdAt: user.createdAt,
    permissions: getPermissionsForRole(user.role),
  };
}

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      clientId: user.clientId ?? null,
    },
    getJwtSecret(),
    { expiresIn: TOKEN_EXPIRY },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, getJwtSecret());
}

export async function findUserById(id) {
  return prisma.user.findUnique({ where: { id } });
}

export async function findUserByEmail(email) {
  return prisma.user.findUnique({ where: { email: email.toLowerCase() } });
}

/**
 * The one response public signup gives once the platform has any user at all. Deliberately the
 * same for every email address, so the closed door cannot be used to learn which addresses hold
 * an account.
 */
export const PUBLIC_REGISTRATION_CLOSED_MESSAGE =
  "Public registration is closed. Ask an administrator for an invitation.";

/**
 * Postgres advisory lock name for the bootstrap decision. `pg_advisory_xact_lock` is held until
 * the surrounding transaction ends, so the "is the table still empty?" check and the first-admin
 * INSERT are one indivisible step across every instance sharing the database.
 */
const BOOTSTRAP_REGISTRATION_LOCK = "auth.bootstrap_registration";

function publicRegistrationClosedError() {
  const error = new Error(PUBLIC_REGISTRATION_CLOSED_MESSAGE);
  error.statusCode = 403;
  return error;
}

/**
 * Public signup exists for exactly one purpose: creating the FIRST administrator of an empty
 * platform. It is open while no User row exists and closed forever after. Staff and client
 * accounts are created through the admin and invitation flows, never through this door.
 */
export async function isPublicRegistrationOpen(db = prisma) {
  const userCount = await db.user.count();
  return userCount === 0;
}

/**
 * Bootstrap the first administrator from a verified public signup.
 *
 * Refuses with 403 whenever any user already exists, and that refusal is enforced HERE, not only
 * in the OTP-send handler: a caller holding a valid verification token still cannot create an
 * account after bootstrap. The role is always ADMIN; there is no second role this path can grant.
 *
 * The decision and the insert run in one transaction under an advisory lock, so two concurrent
 * first signups cannot both observe an empty table: the loser waits for the winner's commit, then
 * re-reads a non-empty table and gets the same 403 as any later caller. The verification OTP rows
 * are consumed inside that transaction, so a refused registration consumes nothing and a
 * successful one cannot be replayed.
 */
export async function registerUser({ email, password, name, verificationToken }) {
  const normalizedEmail = email.trim().toLowerCase();
  const tokenPayload = verifyEmailVerificationToken(verificationToken);
  if (tokenPayload.email !== normalizedEmail) {
    const error = new Error("Email verification does not match this signup request.");
    error.statusCode = 400;
    throw error;
  }

  // Cheap early refusal before the password is hashed; the authoritative check is inside the
  // transaction below.
  if (!(await isPublicRegistrationOpen())) {
    throw publicRegistrationClosedError();
  }

  const passwordHash = await hashPassword(password);

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${BOOTSTRAP_REGISTRATION_LOCK}))`;

      if (!(await isPublicRegistrationOpen(tx))) {
        throw publicRegistrationClosedError();
      }

      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          name: name?.trim() || null,
          role: "ADMIN",
        },
      });

      // Consume the email verification in the same transaction as the account it authorised.
      await tx.emailOtp.deleteMany({ where: { email: normalizedEmail } });

      return user;
    });
  } catch (error) {
    // Only the conflict this path can legitimately hit: a unique-email violation means another
    // registration for the same address committed first, so the door is closed for this one too.
    if (error?.code === "P2002") {
      throw publicRegistrationClosedError();
    }
    throw error;
  }
}

export async function loginUser({ email, password }) {
  const user = await findUserByEmail(email);
  if (!user) {
    const error = new Error("Invalid email or password.");
    error.statusCode = 401;
    throw error;
  }

  if (!user.isActive) {
    const error = new Error("This account has been deactivated. Contact an administrator.");
    error.statusCode = 403;
    throw error;
  }

  if (user.inviteTokenHash) {
    const error = new Error("Please set your password using the invitation link before signing in.");
    error.statusCode = 403;
    throw error;
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    const error = new Error("Invalid email or password.");
    error.statusCode = 401;
    throw error;
  }

  return user;
}

export async function listUsers() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return users;
}

export async function createUserByAdmin({ email, password, name, role, clientId }) {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await findUserByEmail(normalizedEmail);
  if (existing) {
    const error = new Error("An account with this email already exists.");
    error.statusCode = 409;
    throw error;
  }

  if (role === "CLIENT" && !clientId) {
    const error = new Error("clientId is required for CLIENT portal users.");
    error.statusCode = 400;
    throw error;
  }

  const passwordHash = await hashPassword(password);
  return prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash,
      name: name?.trim() || null,
      role,
      clientId: role === "CLIENT" ? clientId : null,
    },
  });
}

export async function updateUserByAdmin(userId, { role, isActive, name }) {
  const data = {};
  if (role !== undefined) data.role = role;
  if (isActive !== undefined) data.isActive = isActive;
  if (name !== undefined) data.name = name?.trim() || null;

  return prisma.user.update({
    where: { id: userId },
    data,
  });
}

export async function logAccess({ userId, action, resource, metadata, ipAddress }) {
  try {
    await prisma.accessLog.create({
      data: {
        userId: userId || null,
        action,
        resource: resource || null,
        metadata: metadata || null,
        ipAddress: ipAddress || null,
      },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to write access log:", error.message);
  }
}

export async function listAccessLogs({ page = 1, pageSize = 50 }) {
  const skip = (page - 1) * pageSize;
  const [rows, total] = await Promise.all([
    prisma.accessLog.findMany({
      skip,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: { email: true, name: true, role: true },
        },
      },
    }),
    prisma.accessLog.count(),
  ]);

  return { rows, total, page, pageSize, totalPages: Math.max(Math.ceil(total / pageSize), 1) };
}
