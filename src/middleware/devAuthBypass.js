/**
 * TEMPORARY DEVELOPMENT AUTH BYPASS — REMOVE WHEN THE LOGIN FLOW IS USABLE AGAIN.
 *
 * Lets Preview builds of the admin panel be worked on without a login round-trip while the
 * production database connection is being repaired. It is NOT a production feature and is written
 * so that it cannot become one by accident.
 *
 * Two independent conditions must BOTH hold, and the environment test is a positive allowlist
 * rather than a "not production" check:
 *
 *   1. ALLOW_DEV_AUTH_BYPASS is exactly the string "true".
 *   2. The environment is provably Preview or Development.
 *
 * On Vercel, NODE_ENV is "production" for EVERY deployment, Preview included, so NODE_ENV alone
 * cannot tell Preview from Production and must never be used as the discriminator here. VERCEL_ENV
 * is the authoritative signal: "production" | "preview" | "development". When VERCEL_ENV is absent
 * (local or self-hosted) we fall back to NODE_ENV, which is meaningful there.
 *
 * The bypass mints an in-memory identity only. Nothing is written to the database, no real user is
 * read or modified, no password or JWT is involved, and no credential appears in any response.
 */
import { getPermissionsForRole } from "../auth/permissions.js";
import { logger } from "../platform/logging/logger.js";

export const DEV_AUTH_BYPASS_ENV = "ALLOW_DEV_AUTH_BYPASS";

/** Deployment environments where the bypass may operate. Production is deliberately absent. */
export const BYPASS_ELIGIBLE_VERCEL_ENVS = Object.freeze(["preview", "development"]);

/** The synthetic identity. Not a real account: this id exists in no database. */
export const DEV_BYPASS_USER = Object.freeze({
  id: "dev-bypass-admin",
  email: "dev-bypass@invalid.local",
  name: "Dev Bypass Admin",
  role: "ADMIN",
  isActive: true,
  clientId: null,
  isDevBypass: true,
});

let warnedAboutProduction = false;

/**
 * True only when the runtime is provably NOT production.
 *
 * Absence of evidence is not evidence of Preview: an unrecognised VERCEL_ENV value returns false.
 */
export function isBypassEligibleEnvironment(env = process.env) {
  const vercelEnv = typeof env.VERCEL_ENV === "string" ? env.VERCEL_ENV.trim().toLowerCase() : "";

  if (vercelEnv) {
    return BYPASS_ELIGIBLE_VERCEL_ENVS.includes(vercelEnv);
  }

  // No VERCEL_ENV: local or self-hosted, where NODE_ENV is meaningful.
  const nodeEnv = typeof env.NODE_ENV === "string" ? env.NODE_ENV.trim().toLowerCase() : "";
  return nodeEnv !== "production";
}

/** The flag must be the exact string "true"; "1", "yes" and "TRUE" do not enable it. */
export function isBypassFlagSet(env = process.env) {
  return env[DEV_AUTH_BYPASS_ENV] === "true";
}

/**
 * The single decision point. Both conditions must hold.
 *
 * If the flag is set in production the bypass stays off and the mistake is logged once, loudly,
 * so it is visible rather than silent.
 */
export function isDevAuthBypassActive(env = process.env) {
  const flagSet = isBypassFlagSet(env);
  if (!flagSet) return false;

  const eligible = isBypassEligibleEnvironment(env);
  if (!eligible) {
    if (!warnedAboutProduction) {
      warnedAboutProduction = true;
      logger.error(
        { deploymentEnvironment: env.VERCEL_ENV ?? null },
        `${DEV_AUTH_BYPASS_ENV} is set in a non-eligible environment and has been REFUSED. ` +
          "Remove this variable: it must never be set outside Preview or Development.",
      );
    }
    return false;
  }

  return true;
}

/** Exposed for tests; the warning is one-shot in a running process. */
export function resetDevAuthBypassWarning() {
  warnedAboutProduction = false;
}

/** Attach the synthetic identity to a request. Never touches the database. */
export function applyDevBypassIdentity(req) {
  req.user = { ...DEV_BYPASS_USER };
  req.permissions = getPermissionsForRole(DEV_BYPASS_USER.role);
  req.devAuthBypass = true;
  return req;
}

/**
 * Public, credential-free status for the admin frontend.
 *
 * The frontend deliberately holds no flag of its own: it asks the backend whether the bypass is
 * live. A production backend always answers false, so a production frontend cannot enable itself
 * even if it were built with the wrong variables.
 */
export function devAuthBypassStatus(env = process.env) {
  const active = isDevAuthBypassActive(env);
  return {
    active,
    environment: typeof env.VERCEL_ENV === "string" && env.VERCEL_ENV ? env.VERCEL_ENV : "local",
    banner: active ? "DEV AUTH BYPASS ACTIVE" : null,
  };
}
