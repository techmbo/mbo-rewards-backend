/**
 * TEMPORARY — Preview-only, READ-ONLY internal (staff) user metadata audit.
 *
 * REMOVE THIS FILE AND ITS ROUTE REGISTRATION once the staff-account evidence
 * has been captured. It exists because the production database is reachable
 * only from inside the Vercel runtime and no unauthenticated endpoint may
 * reveal whether an ADMIN account exists; GET /users needs an ADMIN session.
 *
 * Guarantees:
 *   - Serves ONLY when VERCEL_ENV === "preview". Everywhere else the route
 *     answers 404 exactly like an unknown path.
 *   - In Preview it fails closed: ADMIN_USER_AUDIT_TOKEN unset/empty → 403,
 *     x-audit-token header absent → 401, header present but wrong → 403.
 *     Comparison is constant-time over SHA-256 digests. The token value is
 *     never logged, echoed or stored (this module imports no logger).
 *   - The database layer is loaded lazily, AFTER every gate. A rejected request
 *     never touches Prisma.
 *   - READ ONLY. Prisma is wrapped in a reader exposing only user.findMany and
 *     user.groupBy. No write method, raw SQL, transaction, job, scheduler or
 *     aggregation code path is reachable from this module. Request body and
 *     query are never read.
 *   - Output is an ALLOWLIST: id / email / name / role / isActive / createdAt
 *     per staff user, plus counts. passwordHash, inviteTokenHash,
 *     inviteExpiresAt, passwordSetAt, clientId and updatedAt are never selected
 *     and a final guard refuses to serialize any key that is not allowed or that
 *     looks like a credential.
 *   - CLIENT (portal) users are excluded in the query AND dropped again after it.
 *   - Database errors are replaced with a generic message so a driver error
 *     cannot echo connection details through the app error handler.
 */

import crypto from "node:crypto";

/** Temporary route path, mounted under the app's /api prefix. */
export const PREVIEW_ADMIN_USER_AUDIT_ROUTE = "/internal/audit/admin-users";
export const ADMIN_USER_AUDIT_TOKEN_HEADER = "x-audit-token";
export const ADMIN_USER_AUDIT_TOKEN_ENV = "ADMIN_USER_AUDIT_TOKEN";

/** Hard cap on returned rows; staff user sets are small, this only bounds the payload. */
export const USER_ROW_LIMIT = 200;

/** Internal roles reported (CLIENT is excluded by design). */
export const STAFF_ROLES = Object.freeze(["ADMIN", "OPERATIONS", "ANALYST", "TECH", "SUPPORT"]);
export const EXCLUDED_ROLE = "CLIENT";

/** The ONLY columns ever selected from User, and the ONLY keys a user row may carry. */
export const ALLOWED_USER_FIELDS = Object.freeze(["id", "email", "name", "role", "isActive", "createdAt"]);
export const ALLOWED_USER_SELECT = Object.freeze({
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  createdAt: true,
});

/** Column names that must never be selected or serialized. */
export const FORBIDDEN_USER_FIELDS = Object.freeze([
  "passwordHash",
  "inviteTokenHash",
  "inviteExpiresAt",
  "passwordSetAt",
  "clientId",
  "client",
  "updatedAt",
  "accessLogs",
]);

/** Any key that looks credential-shaped is refused wherever it appears in the body. */
const CREDENTIAL_KEY_PATTERN = /password|token|secret|hash|credential|apikey|api_key|jwt|cookie|session/i;

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Preview runtime only. Production and development are indistinguishable from an unknown route. */
export function isPreviewRuntime(env = process.env) {
  return env?.VERCEL_ENV === "preview";
}

/**
 * Constant-time token comparison over SHA-256 digests, so neither the token
 * value nor its length leaks through timing.
 */
export function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const providedDigest = crypto.createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

function reply(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

/**
 * Evaluate every gate without touching the database. Returns null when the
 * request may proceed, otherwise { status, message }. The token value itself is
 * never included in any result.
 */
export function evaluateGates(env, headers) {
  if (!isPreviewRuntime(env)) return { status: 404, message: "Not found." };
  const expectedToken = env?.[ADMIN_USER_AUDIT_TOKEN_ENV];
  if (typeof expectedToken !== "string" || expectedToken.trim().length === 0) {
    // Fail closed: the audit is not configured in this Preview.
    return { status: 403, message: "Audit is not enabled." };
  }
  const providedToken = headers?.[ADMIN_USER_AUDIT_TOKEN_HEADER];
  if (typeof providedToken !== "string" || providedToken.length === 0) {
    return { status: 401, message: "Audit token required." };
  }
  if (!tokenMatches(providedToken, expectedToken)) {
    return { status: 403, message: "Invalid audit token." };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read-only data access
// ---------------------------------------------------------------------------

/**
 * Only the two read methods this audit needs. Nothing else on the client is
 * reachable from the handler, so a coding mistake cannot become a write.
 */
export function readOnlyUserReader(prisma) {
  const model = prisma?.user;
  if (!model || typeof model.findMany !== "function" || typeof model.groupBy !== "function") {
    throw new Error("user read methods are unavailable.");
  }
  return Object.freeze({
    findMany: (args) => model.findMany(args),
    groupBy: (args) => model.groupBy(args),
  });
}

async function loadDefaultDependencies() {
  // Loaded only after every gate has passed.
  const { prisma } = await import("../../database/prisma.js");
  return { prisma };
}

// ---------------------------------------------------------------------------
// Projection and output guards (pure, unit-testable)
// ---------------------------------------------------------------------------

function toIso(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Project one database row onto EXACTLY the allowed keys; extra keys are dropped. */
export function projectUserRow(row) {
  return {
    id: row?.id == null ? null : String(row.id),
    email: row?.email == null ? null : String(row.email),
    name: row?.name == null ? null : String(row.name),
    role: row?.role == null ? null : String(row.role),
    isActive: row?.isActive === true,
    createdAt: toIso(row?.createdAt),
  };
}

/** Keep only internal (non-CLIENT) rows, even if the database layer returned others. */
export function isStaffRow(row) {
  return row != null && String(row.role ?? "").toUpperCase() !== EXCLUDED_ROLE;
}

/** Zero-filled role counts from a groupBy result; CLIENT and unknown roles are ignored. */
export function buildCountsByRole(groups) {
  const counts = Object.fromEntries(STAFF_ROLES.map((role) => [role, 0]));
  for (const group of Array.isArray(groups) ? groups : []) {
    const role = String(group?.role ?? "").toUpperCase();
    if (!STAFF_ROLES.includes(role)) continue;
    const n = Number(group?._count?._all ?? group?._count ?? 0);
    counts[role] = Number.isFinite(n) ? n : 0;
  }
  return counts;
}

/**
 * Final guard before serialization:
 *   - every user row must have exactly ALLOWED_USER_FIELDS,
 *   - no key anywhere in the body may be forbidden or credential-shaped.
 */
export function assertSafeOutput(body) {
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_USER_FIELDS.includes(key) || CREDENTIAL_KEY_PATTERN.test(key)) {
          throw new Error(`Forbidden key "${key}" at ${path}`);
        }
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(body, "$");
  for (const [index, row] of (body?.users ?? []).entries()) {
    const keys = Object.keys(row).sort();
    const allowed = [...ALLOWED_USER_FIELDS].sort();
    if (keys.length !== allowed.length || keys.some((k, i) => k !== allowed[i])) {
      throw new Error(`User row ${index} carries keys outside the allowlist.`);
    }
    if (!isStaffRow(row)) throw new Error(`User row ${index} is not a staff role.`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createAdminUserAuditPreviewHandler({
  env = process.env,
  loadDependencies = loadDefaultDependencies,
  now = () => new Date(),
} = {}) {
  return async function adminUserAuditPreviewHandler(req, res, next) {
    const rejection = evaluateGates(env, req?.headers);
    if (rejection) return reply(res, rejection.status, rejection.message);

    try {
      const { prisma } = await loadDependencies();
      const reader = readOnlyUserReader(prisma);
      const staffWhere = { role: { not: EXCLUDED_ROLE } };

      const [rows, roleGroups] = await Promise.all([
        reader.findMany({
          where: staffWhere,
          select: ALLOWED_USER_SELECT,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: USER_ROW_LIMIT,
        }),
        reader.groupBy({ by: ["role"], where: staffWhere, _count: { _all: true } }),
      ]);

      const users = (Array.isArray(rows) ? rows : []).filter(isStaffRow).map(projectUserRow);
      const countsByRole = buildCountsByRole(roleGroups);
      const totalStaffUsers = Object.values(countsByRole).reduce((sum, n) => sum + n, 0);

      const body = {
        ok: true,
        audit: "admin-user-metadata",
        scope: "preview-only, read-only, staff users only (CLIENT excluded)",
        generatedAt: toIso(now()),
        totalStaffUsers,
        adminCount: countsByRole.ADMIN,
        activeAdminCount: users.filter((u) => u.role === "ADMIN" && u.isActive).length,
        countsByRole,
        users,
        truncated: users.length >= USER_ROW_LIMIT && totalStaffUsers > USER_ROW_LIMIT,
      };

      assertSafeOutput(body);
      return res.json(body);
    } catch (error) {
      // The app error handler echoes err.message to the client; a driver error
      // can name the database host. Only a generic message and a short code pass.
      const safe = new Error(`Admin user audit failed (${error?.name ?? "Error"}).`);
      safe.statusCode = 500;
      if (typeof error?.code === "string" && /^[A-Z0-9_]{1,16}$/.test(error.code)) safe.code = error.code;
      return next(safe);
    }
  };
}

export const adminUserAuditPreviewHandler = createAdminUserAuditPreviewHandler();
