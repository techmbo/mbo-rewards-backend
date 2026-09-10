function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.replace(/\/+$/, "");
}

/**
 * Normalize a single optional origin (ADMIN_FRONTEND_ORIGIN) the same way
 * FRONTEND_ORIGINS entries are normalized (`new URL(value).origin`), but never
 * fall back to a raw string: a blank, unparsable, non-http(s) or opaque ("null")
 * value yields null so a misconfiguration can only leave the allowlist unchanged,
 * never broaden it.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeOptionalOrigin(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.origin || parsed.origin === "null") return null;
  return parsed.origin;
}

/**
 * Build the CORS allowlist from the frontend URL, the comma-separated extra
 * origins, and the optional single admin origin. Order and normalization of the
 * first two inputs are unchanged from the original inline implementation.
 *
 * @param {{ frontendUrl: string, frontendOrigins?: unknown, adminFrontendOrigin?: unknown }} input
 * @returns {string[]}
 */
export function buildFrontendOrigins({ frontendUrl, frontendOrigins, adminFrontendOrigin }) {
  const adminOrigin = normalizeOptionalOrigin(adminFrontendOrigin);
  return [
    new URL(frontendUrl).origin,
    ...String(frontendOrigins || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((value) => {
        try {
          return new URL(value).origin;
        } catch {
          return value.replace(/\/+$/, "");
        }
      }),
    ...(adminOrigin ? [adminOrigin] : []),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

export const BACKEND_URL = requireEnv("BACKEND_URL");
/** Full app URL, may include path (e.g. https://www.mborewards.com/mbointegratedPlatform). */
export const FRONTEND_URL = requireEnv("FRONTEND_URL");
/** Browser Origin only — used for CORS (path is never part of Origin). */
export const FRONTEND_ORIGIN = new URL(FRONTEND_URL).origin;
/**
 * Optional single extra CORS origin for the separately hosted admin frontend, e.g.
 * ADMIN_FRONTEND_ORIGIN=https://mbo-rewards-admin.vercel.app
 * Null when unset, blank, or not a valid http(s) origin.
 */
export const ADMIN_FRONTEND_ORIGIN = normalizeOptionalOrigin(process.env.ADMIN_FRONTEND_ORIGIN);
/**
 * Extra allowed CORS origins (comma-separated), e.g.
 * FRONTEND_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173
 * ADMIN_FRONTEND_ORIGIN (if valid) is appended after these.
 */
export const FRONTEND_ORIGINS = buildFrontendOrigins({
  frontendUrl: FRONTEND_URL,
  frontendOrigins: process.env.FRONTEND_ORIGINS,
  adminFrontendOrigin: process.env.ADMIN_FRONTEND_ORIGIN,
});

export const FRONTEND_INTEGRATIONS_URL = `${FRONTEND_URL}/dashboard/integrations`;

export function oauthCallbackUrl(platform) {
  return `${BACKEND_URL}/api/auth/callback/marketplace/${platform}`;
}
