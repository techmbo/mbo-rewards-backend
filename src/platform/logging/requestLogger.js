import { randomUUID } from "node:crypto";
import { createRequestContext, requestContext } from "./context.js";
import { logger } from "./logger.js";

export function requestLoggerMiddleware() {
  return (req, res, next) => {
    const incomingTrace = req.headers["x-trace-id"] || req.headers["x-request-id"];
    const ctx = createRequestContext({
      requestId: String(req.headers["x-request-id"] || randomUUID()),
      traceId: String(incomingTrace || randomUUID()),
    });

    requestContext.run(ctx, () => {
      req.requestId = ctx.requestId;
      req.traceId = ctx.traceId;
      res.setHeader("x-request-id", ctx.requestId);
      res.setHeader("x-trace-id", ctx.traceId);

      const startedAt = process.hrtime.bigint();

      res.on("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        const logPayload = {
          requestId: ctx.requestId,
          traceId: ctx.traceId,
          userId: req.user?.id,
          clientId: req.headers["x-client-id"] || undefined,
          tenantId: req.headers["x-tenant-id"] || undefined,
          ip: req.ip,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          duration: Math.round(durationMs * 100) / 100,
        };

        if (res.statusCode >= 500) {
          logger.error(logPayload, "request completed");
        } else if (res.statusCode >= 400) {
          logger.warn(logPayload, "request completed");
        } else {
          logger.info(logPayload, "request completed");
        }
      });

      next();
    });
  };
}
