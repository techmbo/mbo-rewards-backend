import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { FRONTEND_ORIGINS } from "../../config/urls.js";

export const securityMiddleware = helmet({
  contentSecurityPolicy: process.env.NODE_ENV === "production" ? undefined : false,
  crossOriginEmbedderPolicy: false,
  // API is called cross-origin from the marketing site / Vite dev server.
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

export const globalRateLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many requests. Please try again later." },
});

export const authRateLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 900_000),
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many authentication attempts." },
});

/**
 * Certification probe limiter — one run per network + region + accountLabel per 5 minutes.
 *
 * The probe initiates outbound supplier calls with production credentials, so the limit is keyed
 * on the supplier account being probed rather than on the caller: two admins must not be able to
 * double the traffic against one affiliate account by each running it once.
 *
 * LIMITATION: express-rate-limit's default store is in-memory and per-process. On serverless this
 * counts per warm instance, not globally, so concurrent cold instances could each admit one run.
 * That is acceptable for a one-record-per-endpoint probe and is documented rather than papered
 * over; a shared store (Redis) would be required for a true distributed limit, and REDIS_URL is
 * not configured in this project today.
 */
export const certificationRateLimiter = rateLimit({
  windowMs: Number(process.env.CERTIFICATION_RATE_LIMIT_WINDOW_MS || 300_000),
  max: Number(process.env.CERTIFICATION_RATE_LIMIT_MAX || 1),
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed on the supplier account, not the caller or IP.
  keyGenerator: (req) =>
    [
      String(req.params?.network || "unknown").toLowerCase(),
      String(req.body?.region || "sea").toLowerCase(),
      String(req.body?.accountLabel || "default").toLowerCase(),
    ].join("|"),
  message: {
    ok: false,
    message: "Certification for this network account was run recently. Try again shortly.",
  },
});

export function corsOptions() {
  return {
    origin(origin, callback) {
      // Non-browser clients (curl, server-to-server) send no Origin.
      if (!origin || FRONTEND_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Api-Key",
      "X-Request-Id",
      "X-Trace-Id",
      "X-Client-Id",
      "X-Tenant-Id",
    ],
  };
}
