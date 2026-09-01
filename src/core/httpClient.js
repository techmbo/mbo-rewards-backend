import axios from "axios";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterSeconds(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);

  const retryAt = Date.parse(String(value));
  if (Number.isNaN(retryAt)) return null;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

function parseMinutesFromMessage(message) {
  const match = String(message || "").match(/retry after (\d+)\s*minute/i);
  if (!match) return null;
  return Number(match[1]);
}

export function extractUpstreamErrorMessage(data) {
  if (!data || typeof data !== "object") return null;

  const payload = data.payload ?? data;
  const errors = payload?.errors;

  if (typeof errors === "string") return errors;
  if (errors?.message) return String(errors.message);
  if (Array.isArray(errors) && errors[0]?.message) return String(errors[0].message);

  if (payload?.message) return String(payload.message);
  if (data.message) return String(data.message);
  if (data.error) return String(data.error);

  return null;
}

export function getRateLimitWaitMs(error) {
  const retryAfterHeader = error?.response?.headers?.["retry-after"];
  const headerSeconds = parseRetryAfterSeconds(retryAfterHeader);
  if (headerSeconds != null) return headerSeconds * 1000;

  const body = error?.response?.data;
  const payload = body?.payload ?? body;
  const bodySeconds =
    parseRetryAfterSeconds(payload?.retry_after) ??
    parseRetryAfterSeconds(payload?.retryAfter) ??
    parseRetryAfterSeconds(payload?.reset_in) ??
    parseRetryAfterSeconds(payload?.resetIn) ??
    parseRetryAfterSeconds(body?.retry_after) ??
    parseRetryAfterSeconds(body?.retryAfter);
  if (bodySeconds != null) return bodySeconds * 1000;

  const message = extractUpstreamErrorMessage(body);
  const minutes = parseMinutesFromMessage(message);
  if (minutes != null) return minutes * 60 * 1000;

  return null;
}

export function shouldRetryRateLimit(error) {
  const waitMs = getRateLimitWaitMs(error);
  // Boostiny lockouts ("Retry after 10 minutes") must not be hammered with short retries.
  if (waitMs != null && waitMs >= 60000) return false;

  const message = extractUpstreamErrorMessage(error?.response?.data);
  if (/too many attempts/i.test(message || "")) return false;

  return true;
}

export function createHttpClient({ baseURL, apiKey, headers = {} }) {
  return axios.create({
    baseURL,
    headers: {
      Authorization: apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...headers,
    },
    timeout: 30000,
  });
}

export function extractRateLimitTelemetry(errorOrResponse) {
  const headers = errorOrResponse?.response?.headers || errorOrResponse?.headers || {};
  const retryAfter =
    headers["retry-after"] ??
    headers["Retry-After"] ??
    errorOrResponse?.retryAfter ??
    null;
  const remaining =
    headers["x-ratelimit-remaining"] ??
    headers["X-RateLimit-Remaining"] ??
    headers["ratelimit-remaining"] ??
    null;
  const reset =
    headers["x-ratelimit-reset"] ??
    headers["X-RateLimit-Reset"] ??
    headers["ratelimit-reset"] ??
    null;
  if (retryAfter == null && remaining == null && reset == null) return null;
  return {
    retryAfter: retryAfter != null ? String(retryAfter) : null,
    remaining: remaining != null ? String(remaining) : null,
    reset: reset != null ? String(reset) : null,
    httpStatus: errorOrResponse?.response?.status ?? errorOrResponse?.status ?? null,
    capturedAt: new Date().toISOString(),
  };
}

export async function requestWithRetry(fn, { retries = 3, delayMs = 750 } = {}) {
  let lastError;
  let lastAttempt = 0;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    lastAttempt = attempt;
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;

      const status = error?.response?.status;
      if (status && ![429, 500, 502, 503, 504].includes(status)) {
        break;
      }

      if (status === 429 && !shouldRetryRateLimit(error)) {
        break;
      }

      const rateLimitWaitMs = status === 429 ? getRateLimitWaitMs(error) : null;
      const backoffMs = status === 429 ? Math.max(delayMs * attempt, 5000) : delayMs * attempt;
      const waitMs = rateLimitWaitMs != null ? Math.min(rateLimitWaitMs, 60000) : backoffMs;
      await sleep(waitMs);
    }
  }

  if (lastError && typeof lastError === "object") {
    lastError.syncAttemptCount = lastAttempt;
    lastError.rateLimitTelemetry = extractRateLimitTelemetry(lastError);
  }

  throw lastError;
}
