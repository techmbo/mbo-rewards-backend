function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.replace(/\/+$/, "");
}

export const BACKEND_URL = requireEnv("BACKEND_URL");
/** Full app URL, may include path (e.g. https://www.mborewards.com/mbointegratedPlatform). */
export const FRONTEND_URL = requireEnv("FRONTEND_URL");
/** Browser Origin only — used for CORS (path is never part of Origin). */
export const FRONTEND_ORIGIN = new URL(FRONTEND_URL).origin;
/**
 * Extra allowed CORS origins (comma-separated), e.g.
 * FRONTEND_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173
 */
export const FRONTEND_ORIGINS = [
  FRONTEND_ORIGIN,
  ...String(process.env.FRONTEND_ORIGINS || "")
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
].filter((value, index, all) => all.indexOf(value) === index);

export const FRONTEND_INTEGRATIONS_URL = `${FRONTEND_URL}/dashboard/integrations`;

export function oauthCallbackUrl(platform) {
  return `${BACKEND_URL}/api/auth/callback/marketplace/${platform}`;
}
