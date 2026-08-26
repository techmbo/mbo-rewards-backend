import pino from "pino";
import { getRequestContext, sanitizeForLog } from "./context.js";

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug");

export const logger = pino({
  level,
  base: {
    service: "mbo-api",
    env: process.env.NODE_ENV || "development",
  },
  formatters: {
    level(label) {
      return { level: label.toUpperCase() };
    },
    log(object) {
      const ctx = getRequestContext();
      return sanitizeForLog({
        ...object,
        requestId: object.requestId ?? ctx.requestId,
        traceId: object.traceId ?? ctx.traceId,
        userId: object.userId ?? ctx.userId,
        clientId: object.clientId ?? ctx.clientId,
        tenantId: object.tenantId ?? ctx.tenantId,
      });
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export function childLogger(bindings = {}) {
  return logger.child(sanitizeForLog(bindings));
}
