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
