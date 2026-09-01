import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export const requestContext = new AsyncLocalStorage();

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "apikey",
  "secret",
  "otp",
  "creditcard",
  "ssn",
  "encryptedaccesstoken",
  "encryptedrefreshtoken",
  "apisecret",
  "applicationkey",
  "userapikey",
  "clientsecret",
  "client_secret",
  "access_token",
  "refresh_token",
  "api_key",
]);

export function sanitizeForLog(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 2000) return `${value.slice(0, 2000)}…`;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitizeForLog(val, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function getRequestContext() {
  return requestContext.getStore() ?? {};
}

export function createRequestContext(overrides = {}) {
  return {
    requestId: randomUUID(),
    traceId: randomUUID(),
    ...overrides,
  };
}

export function runWithRequestContext(context, fn) {
  return requestContext.run(context, fn);
}
