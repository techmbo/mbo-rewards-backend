const REQUIRED = ["DATABASE_URL", "JWT_SECRET", "OAUTH_TOKEN_ENCRYPTION_KEY"];

const RECOMMENDED_PRODUCTION = ["FRONTEND_URL", "BACKEND_URL", "TRACKING_BASE_URL"];

export function validateEnvironment({ exitOnError = false } = {}) {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  const warnings = RECOMMENDED_PRODUCTION.filter((key) => !process.env[key]);

  const result = {
    ok: missing.length === 0,
    missing,
    warnings,
  };

  if (missing.length && exitOnError && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return result;
}
