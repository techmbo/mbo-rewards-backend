import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import routes from "./routes/index.js";
import { publicTrackingRedirectHandler, publicTrackingRedirectLegacyHandler, publicProductTrackingRedirectHandler } from "./controllers/trackingRedirect.controller.js";
import { attachPrismaMetrics } from "./database/prismaMetrics.js";
import { registerPlatformJobs } from "./platform/bootstrap.js";
import { validateEnvironment } from "./platform/config/env.js";
import { registerPlatformRoutes } from "./platform/health/routes.js";
import { requestLoggerMiddleware } from "./platform/logging/requestLogger.js";
import { logger } from "./platform/logging/logger.js";
import { metricsMiddleware } from "./platform/metrics/prometheus.js";
import { registerOpenApi } from "./platform/openapi/spec.js";
import {
  corsOptions,
  globalRateLimiter,
  securityMiddleware,
} from "./platform/security/index.js";
import { isPrismaUniqueViolation } from "./core/prismaErrors.js";
import { sanitizeForLog } from "./platform/logging/context.js";
import { sanitizeSecretError } from "./modules/networkOps/networkAccount.contract.js";

let platformInitialized = false;

export function initializePlatform() {
  if (platformInitialized) return;
  validateEnvironment();
  attachPrismaMetrics();
  registerPlatformJobs();
  platformInitialized = true;
  logger.info("platform layer initialized");
}

export function createApp() {
  initializePlatform();

  const app = express();
  app.set("trust proxy", 1);

  app.use(securityMiddleware);
  app.use(cors(corsOptions()));
  app.use(globalRateLimiter);
  app.use(requestLoggerMiddleware());
  app.use(metricsMiddleware());
  app.use(express.json({ limit: "10mb" }));

  registerPlatformRoutes(app);
  registerOpenApi(app);

  // Public MBO tracking redirect (not under /api)
  // Prefer /r/:slug/:token; keep /r/:token for historical links.
  app.get("/r/:slug/:token", publicTrackingRedirectHandler);
  app.get("/r/:token", publicTrackingRedirectLegacyHandler);
  // Epic 4 — product-level MBO tracking wrapper
  app.get("/t/product/:token", publicProductTrackingRedirectHandler);

  app.use("/api", routes);

  app.use((err, req, res, _next) => {
    logger.error(
      sanitizeForLog({
        err: sanitizeSecretError(err.message) || err.message,
        requestId: req.requestId,
        traceId: req.traceId,
        path: req.originalUrl,
      }),
      "unhandled error",
    );

    if (err instanceof ZodError) {
      res.status(400).json({
        ok: false,
        message: "Validation failed.",
        issues: err.issues,
      });
      return;
    }

    if (isPrismaUniqueViolation(err)) {
      const fields = Array.isArray(err?.meta?.target) ? err.meta.target : [];
      const fieldLabel = fields.includes("slug")
        ? "slug"
        : fields.length
          ? fields.join(", ")
          : "value";
      res.status(409).json({
        ok: false,
        message:
          fieldLabel === "slug"
            ? "That client slug is already in use. Choose a different slug."
            : `A record with this ${fieldLabel} already exists.`,
      });
      return;
    }

    const upstreamStatus = err?.response?.status;
    const status =
      err?.statusCode ||
      (upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 500);
    const payload = err?.response?.data?.payload;
    const upstreamMessage =
      payload?.errors?.message ||
      payload?.message ||
      err?.response?.data?.message ||
      err?.response?.data?.error;
    let message = upstreamMessage || err?.message || "Unexpected server error";
    if (/OAUTH_TOKEN_ENCRYPTION_KEY/i.test(message)) {
      message = "Server is missing encryption configuration. Contact your administrator.";
    }
    message = sanitizeSecretError(message) || message;

    res.status(status).json({
      ok: false,
      message,
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.existingAssignmentId ? { existingAssignmentId: err.existingAssignmentId } : {}),
      ...(err?.details && typeof err.details === "object"
        ? { details: sanitizeForLog(err.details) }
        : {}),
    });
  });

  return app;
}

const app = createApp();

export default app;