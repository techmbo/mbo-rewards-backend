/**
 * Machine authentication for the internal scheduler routes.
 *
 * These routes are called by a scheduler, never by a person, so they must not depend on the user
 * JWT the human `/sync/*` routes use. An access token here would be the wrong credential twice
 * over: it is issued to a real user account, and it expires after seven days, which would stop the
 * scheduler silently one week after it was set up.
 *
 * The credential is a single shared secret in `CRON_SECRET`, presented as an ordinary bearer
 * token. Nothing about the secret is ever logged, returned, or echoed — the refusal is the same
 * opaque 401 whatever went wrong, so the response cannot be used to probe which part was wrong.
 */

import { timingSafeEqual } from "node:crypto";

/** The machine-readable refusal. Deliberately identical for every failure mode. */
export const CRON_AUTH_REFUSAL_CODE = "cron_auth_failed";

const BEARER = /^Bearer[ \t]+(\S+)$/;

/**
 * The presented secret, or null.
 *
 * Only the exact `Bearer <token>` shape is accepted. A header that is absent, not a string, of
 * another scheme, or missing its token is not "nearly right" — it is simply not a credential.
 */
export function presentedCronSecret(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== "string" || header === "") return null;
  const match = BEARER.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Whether a presented value matches the configured secret.
 *
 * Two guards before the comparison, in this order:
 *
 *  1. **Fail closed on no configuration.** A missing or empty `CRON_SECRET` rejects everything. It
 *     must never mean "no authentication required", which is how an unset variable in a fresh
 *     environment would otherwise open these routes to the internet.
 *  2. **Explicit length check.** `timingSafeEqual` THROWS on buffers of different lengths, so
 *     comparing without this would turn a wrong-length guess into a 500 and leak the length
 *     through the status code. Checking first makes it a clean rejection.
 *
 * Only then is the comparison itself constant-time, so a correct prefix cannot be found one byte
 * at a time by measuring the response.
 */
export function cronSecretMatches(presented, configured = process.env.CRON_SECRET) {
  if (typeof configured !== "string" || configured.trim() === "") return false;
  if (typeof presented !== "string" || presented === "") return false;

  const expected = Buffer.from(configured, "utf8");
  const actual = Buffer.from(presented, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Gate an internal scheduler route on the shared secret and nothing else.
 *
 * No user is loaded, no role is read and no permission is resolved: this is not a person. The
 * human `/sync/*` routes keep their own JWT, admin and permission chain, untouched.
 */
export function requireCronSecret(req, res, next) {
  if (cronSecretMatches(presentedCronSecret(req))) {
    next();
    return;
  }
  // One response for every failure: no header, wrong scheme, wrong length, wrong value, or no
  // secret configured at all. A caller learns only that it is not authorised.
  res.status(401).json({ ok: false, code: CRON_AUTH_REFUSAL_CODE, message: "Not authorised." });
}
