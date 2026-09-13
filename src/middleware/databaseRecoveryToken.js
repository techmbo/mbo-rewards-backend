import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Break-glass authentication for the temporary database recovery diagnostic.
 *
 * TEMPORARY. Delete this file together with the route it guards.
 *
 * The normal gate cannot be used while the incident is live: `authenticate` resolves the caller
 * through the runtime Prisma client, which is the client that cannot connect. An endpoint whose
 * authentication depends on the database cannot diagnose the database. So this route — and only
 * this route — is gated on a pre-shared secret instead, which needs nothing but the process
 * environment.
 *
 * A secret in a header is a weaker gate than a session, so the surface is kept as small as it can
 * be: one route, one header, one env var, read-only, no parameters, and a response that already
 * cannot contain anything sensitive.
 */

/** The only header this gate reads. Lower-case: Node normalises incoming header names. */
export const DB_RECOVERY_TOKEN_HEADER = "x-db-recovery-token";

/** The env var holding the expected value. */
export const DB_RECOVERY_TOKEN_ENV = "DB_RECOVERY_DIAGNOSTIC_TOKEN";

/**
 * Minimum length for the configured secret.
 *
 * A break-glass credential sits on a public route with no session behind it, so a short or guessable
 * value would be the whole of the security. Refusing to start rather than accepting a weak secret
 * keeps that decision out of the hands of whoever is pasting values in during an incident.
 */
export const MIN_TOKEN_LENGTH = 32;

/**
 * Fixed-length constant-time comparison.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and catching that would itself leak
 * the expected length. Hashing both sides first makes every comparison 32 bytes against 32 bytes,
 * so neither the length nor the content of the presented value can be recovered from timing.
 */
export function constantTimeEquals(presented, expected) {
  const a = createHash("sha256").update(String(presented ?? ""), "utf8").digest();
  const b = createHash("sha256").update(String(expected ?? ""), "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Whether the configured token is a copy of some other secret in the environment.
 *
 * Written as a scan of every other variable rather than a denylist of known names. A denylist would
 * have to be kept in step with every credential the platform grows, and the failure mode of missing
 * one is that a break-glass header silently becomes a way to present JWT_SECRET. The scan cannot
 * miss a name it has never heard of.
 *
 * Returns a boolean only. The matching variable's name is never reported, because the answer is
 * always the same either way: choose a fresh value.
 */
export function isTokenReused(token, env = process.env) {
  if (!token) return false;
  return Object.entries(env).some(
    ([key, value]) => key !== DB_RECOVERY_TOKEN_ENV && typeof value === "string" && value === token,
  );
}

/**
 * Whether the gate is usable at all.
 *
 * Three ways to be unusable, and they are reported as one state on purpose: an unconfigured gate, a
 * weak secret and a reused secret are all "this route is not available", and distinguishing them to
 * an unauthenticated caller would describe the deployment's configuration to them.
 */
export function isGateConfigured(env = process.env) {
  const token = env[DB_RECOVERY_TOKEN_ENV];
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH) return false;
  return !isTokenReused(token, env);
}

/**
 * The gate.
 *
 * Never reads, writes, or forwards the token anywhere but the comparison — it is not attached to
 * `req`, not placed on an error, and not logged. `requestLoggerMiddleware` logs a fixed field list
 * that has never included headers, so the token cannot reach a log line through the request log
 * either; `SENSITIVE_KEYS` covers the header name as a second line of defence for any future code
 * that logs a header bag.
 */
export function requireDatabaseRecoveryToken(req, res, next) {
  if (!isGateConfigured(process.env)) {
    // 503, not 401: the caller has done nothing wrong and no credential would help them.
    res.status(503).json({ ok: false, message: "Diagnostic is not enabled." });
    return;
  }

  const presented = req.headers?.[DB_RECOVERY_TOKEN_HEADER];
  // A repeated header arrives as an array. Refuse rather than pick one, so a proxy that folds
  // headers cannot turn a wrong value into an accepted one.
  if (typeof presented !== "string" || !presented) {
    res.status(401).json({ ok: false, message: "Authentication required." });
    return;
  }

  if (!constantTimeEquals(presented, process.env[DB_RECOVERY_TOKEN_ENV])) {
    // Byte-identical to the missing-token response: a caller cannot learn whether a header was
    // seen, only that the request was refused.
    res.status(401).json({ ok: false, message: "Authentication required." });
    return;
  }

  next();
}
