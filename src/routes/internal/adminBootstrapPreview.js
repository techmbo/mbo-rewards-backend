/**
 * TEMPORARY — Preview-only, token-gated bootstrap of ONE fixed ADMIN user.
 *
 * REMOVE THIS FILE AND ITS ROUTE REGISTRATION once the owner account exists.
 * It exists because the production database is reachable only from inside the
 * Vercel runtime, the public signup flow requires an emailed OTP, and creating
 * a staff user through the API requires an ADMIN session that does not exist yet.
 *
 * Guarantees:
 *   - Serves ONLY when VERCEL_ENV === "preview". Everywhere else the route
 *     answers 404 exactly like an unknown path (production never exposes it).
 *   - In Preview it fails closed: ADMIN_BOOTSTRAP_TOKEN unset/blank → 403,
 *     x-bootstrap-token header absent → 401, wrong → 403 (constant-time compare
 *     over SHA-256 digests). Token, password and hash are never logged: this
 *     module imports no logger and the request logger never records bodies.
 *   - The password is accepted ONLY from the JSON body (`password`), validated
 *     for length, and hashed with the auth service's own hashPassword()
 *     (bcrypt, same cost) — no second hashing implementation exists here.
 *   - The target identity is FIXED: email is the constant below, normalized the
 *     same way the auth service normalizes emails (trim + lowercase); role is
 *     ADMIN; isActive is true. Nothing in the request can change any of that.
 *   - Prisma and the auth service are loaded lazily, AFTER every gate. Prisma is
 *     wrapped in an access object exposing only user.findUnique and a
 *     user.create that refuses any data shape other than the fixed one.
 *   - If the user already exists NOTHING is written; only email/role/isActive
 *     are returned. Otherwise exactly one User row is created.
 *   - A final guard refuses to serialize the plaintext password, any bcrypt
 *     hash, or any credential-shaped key. Database errors are replaced with a
 *     generic message.
 */

import crypto from "node:crypto";

/** Temporary route path, mounted under the app's /api prefix. */
export const PREVIEW_ADMIN_BOOTSTRAP_ROUTE = "/internal/bootstrap/admin-user";
export const ADMIN_BOOTSTRAP_TOKEN_HEADER = "x-bootstrap-token";
export const ADMIN_BOOTSTRAP_TOKEN_ENV = "ADMIN_BOOTSTRAP_TOKEN";

/** The ONLY identity this route can create. */
export const BOOTSTRAP_EMAIL = "mbo@marketingblueocean.com";
export const BOOTSTRAP_ROLE = "ADMIN";

/** Same bounds as the auth service (registerSchema: min 8) and bcrypt's 72-byte input limit. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

/** The ONLY keys a user object in the response may carry. */
export const SAFE_USER_FIELDS = Object.freeze(["email", "role", "isActive"]);
export const SAFE_USER_SELECT = Object.freeze({ email: true, role: true, isActive: true });

const CREDENTIAL_KEY_PATTERN = /password|token|secret|hash|credential|apikey|api_key|jwt|cookie|session/i;
const BCRYPT_HASH_PATTERN = /\$2[aby]\$\d{2}\$/;

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

/** Preview runtime only. Production and development are indistinguishable from an unknown route. */
export function isPreviewRuntime(env = process.env) {
  return env?.VERCEL_ENV === "preview";
}

/** Constant-time token comparison over SHA-256 digests. */
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

/** Returns null when the request may proceed, otherwise { status, message }. Never includes token values. */
export function evaluateGates(env, headers) {
  if (!isPreviewRuntime(env)) return { status: 404, message: "Not found." };
  const expectedToken = env?.[ADMIN_BOOTSTRAP_TOKEN_ENV];
  if (typeof expectedToken !== "string" || expectedToken.trim().length === 0) {
    return { status: 403, message: "Bootstrap is not enabled." };
  }
  const providedToken = headers?.[ADMIN_BOOTSTRAP_TOKEN_HEADER];
  if (typeof providedToken !== "string" || providedToken.length === 0) {
    return { status: 401, message: "Bootstrap token required." };
  }
  if (!tokenMatches(providedToken, expectedToken)) {
    return { status: 403, message: "Invalid bootstrap token." };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Same normalization as the auth service (registerUser / createUserByAdmin). */
export function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

/**
 * Accept the password from the JSON body only. Returns { password } or
 * { error } with a generic message that never echoes the input.
 */
export function readPassword(body) {
  const password = body && typeof body === "object" && !Array.isArray(body) ? body.password : undefined;
  if (typeof password !== "string") return { error: "password is required in the JSON body." };
  if (password.length < PASSWORD_MIN_LENGTH) return { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) return { error: `Password must be at most ${PASSWORD_MAX_BYTES} bytes.` };
  return { password };
}

// ---------------------------------------------------------------------------
// Constrained data access
// ---------------------------------------------------------------------------

const FIXED_CREATE_KEYS = Object.freeze(["email", "name", "role", "isActive", "passwordHash"]);

/**
 * Only user.findUnique and a constrained user.create are reachable. create()
 * refuses any data that is not exactly the fixed bootstrap identity, so a
 * coding mistake cannot create a different user, role or field set.
 */
export function bootstrapUserAccess(prisma) {
  const model = prisma?.user;
  if (!model || typeof model.findUnique !== "function" || typeof model.create !== "function") {
    throw new Error("user access methods are unavailable.");
  }
  return Object.freeze({
    findUnique: (args) => model.findUnique(args),
    create: (args) => {
      const data = args?.data;
      const keys = Object.keys(data ?? {}).sort();
      const expected = [...FIXED_CREATE_KEYS].sort();
      const shapeOk =
        data &&
        keys.length === expected.length &&
        keys.every((k, i) => k === expected[i]) &&
        data.email === BOOTSTRAP_EMAIL &&
        data.name === null &&
        data.role === BOOTSTRAP_ROLE &&
        data.isActive === true &&
        typeof data.passwordHash === "string" &&
        BCRYPT_HASH_PATTERN.test(data.passwordHash);
      if (!shapeOk) throw new Error("Refusing to create anything other than the fixed bootstrap admin.");
      return model.create(args);
    },
  });
}

async function loadDefaultDependencies() {
  // Loaded only after every gate has passed. hashPassword is the auth service's own bcrypt hashing.
  const [{ prisma }, { hashPassword }] = await Promise.all([
    import("../../database/prisma.js"),
    import("../../modules/auth/auth.service.js"),
  ]);
  return { prisma, hashPassword };
}

// ---------------------------------------------------------------------------
// Output guard
// ---------------------------------------------------------------------------

export function projectSafeUser(row) {
  return {
    email: row?.email == null ? null : String(row.email),
    role: row?.role == null ? null : String(row.role),
    isActive: row?.isActive === true,
  };
}

/**
 * Final guard before serialization: no plaintext password, no bcrypt hash,
 * no credential-shaped key anywhere, and user objects carry exactly SAFE_USER_FIELDS.
 */
export function assertSafeOutput(body, plaintextPassword) {
  const serialized = JSON.stringify(body);
  if (plaintextPassword && serialized.includes(plaintextPassword)) throw new Error("Refusing to serialize the plaintext password.");
  if (BCRYPT_HASH_PATTERN.test(serialized)) throw new Error("Refusing to serialize a password hash.");
  const walk = (value, path) => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (CREDENTIAL_KEY_PATTERN.test(key)) throw new Error(`Forbidden key "${key}" at ${path}`);
        walk(child, `${path}.${key}`);
      }
    }
  };
  walk(body, "$");
  if (body?.user) {
    const keys = Object.keys(body.user).sort();
    const allowed = [...SAFE_USER_FIELDS].sort();
    if (keys.length !== allowed.length || keys.some((k, i) => k !== allowed[i])) throw new Error("user carries keys outside the allowlist.");
  }
  return body;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createAdminBootstrapPreviewHandler({
  env = process.env,
  loadDependencies = loadDefaultDependencies,
} = {}) {
  return async function adminBootstrapPreviewHandler(req, res, next) {
    const rejection = evaluateGates(env, req?.headers);
    if (rejection) return reply(res, rejection.status, rejection.message);

    const input = readPassword(req?.body);
    if (input.error) return reply(res, 400, input.error);
    const { password } = input;
    const email = normalizeEmail(BOOTSTRAP_EMAIL);

    try {
      const { prisma, hashPassword } = await loadDependencies();
      if (typeof hashPassword !== "function") throw new Error("hashPassword unavailable.");
      const access = bootstrapUserAccess(prisma);

      const existing = await access.findUnique({ where: { email }, select: SAFE_USER_SELECT });
      if (existing) {
        const body = { ok: true, created: false, message: "User already exists. Nothing was changed.", user: projectSafeUser(existing) };
        assertSafeOutput(body, password);
        return res.status(200).json(body);
      }

      const passwordHash = await hashPassword(password);
      let createdRow;
      try {
        createdRow = await access.create({
          data: { email, name: null, role: BOOTSTRAP_ROLE, isActive: true, passwordHash },
          select: SAFE_USER_SELECT,
        });
      } catch (error) {
        // Unique-violation race: someone created the row between the read and the write. Never overwrite.
        if (error?.code === "P2002") {
          const raced = await access.findUnique({ where: { email }, select: SAFE_USER_SELECT });
          if (raced) {
            const body = { ok: true, created: false, message: "User already exists. Nothing was changed.", user: projectSafeUser(raced) };
            assertSafeOutput(body, password);
            return res.status(200).json(body);
          }
        }
        throw error;
      }

      const body = { ok: true, created: true, message: "Bootstrap admin created.", user: projectSafeUser(createdRow) };
      assertSafeOutput(body, password);
      return res.status(201).json(body);
    } catch (error) {
      // The app error handler echoes err.message to the client; a driver error
      // can name the database host. Only a generic message and a short code pass.
      const safe = new Error(`Admin bootstrap failed (${error?.name ?? "Error"}).`);
      safe.statusCode = 500;
      if (typeof error?.code === "string" && /^[A-Z0-9_]{1,16}$/.test(error.code)) safe.code = error.code;
      return next(safe);
    }
  };
}

export const adminBootstrapPreviewHandler = createAdminBootstrapPreviewHandler();
