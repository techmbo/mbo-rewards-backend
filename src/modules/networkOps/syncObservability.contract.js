/**
 * Pointer 20 — Sync observability contract.
 * Every automated/manual ingestion run stores full telemetry.
 */

import { iso } from "../ops/v15FieldContract.js";
import { assertNoSecrets, sanitizeSecretError } from "./networkAccount.contract.js";

/** Canonical contract statuses. */
export const SYNC_OBS_STATUS = Object.freeze({
  RUNNING: "RUNNING",
  SUCCESS: "SUCCESS",
  PARTIAL: "PARTIAL",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

/** Legacy statuses still readable from older rows. */
export const LEGACY_SYNC_STATUS = Object.freeze({
  STARTED: "STARTED",
  SUCCEEDED: "SUCCEEDED",
  SKIPPED: "SKIPPED",
  NOT_AVAILABLE: "NOT_AVAILABLE",
});

export const SYNC_JOB_TYPE = Object.freeze({
  CAMPAIGNS: "CAMPAIGNS",
  CONVERSIONS: "CONVERSIONS",
  COUPONS: "COUPONS",
  REPORTING: "REPORTING",
  PAYMENTS: "PAYMENTS",
  BACKFILL: "BACKFILL",
  REPROCESS: "REPROCESS",
  MANUAL: "MANUAL",
  ORCHESTRATOR: "ORCHESTRATOR",
});

export const SYNC_TRIGGER = Object.freeze({
  SCHEDULER: "scheduler",
  API: "api",
  MANUAL: "manual",
  REPROCESS: "reprocess",
});

export function normalizeSyncObsStatus(status) {
  const key = String(status || "").toUpperCase();
  if (key === LEGACY_SYNC_STATUS.STARTED) return SYNC_OBS_STATUS.RUNNING;
  if (key === LEGACY_SYNC_STATUS.SUCCEEDED) return SYNC_OBS_STATUS.SUCCESS;
  if (Object.values(SYNC_OBS_STATUS).includes(key)) return key;
  if (key === LEGACY_SYNC_STATUS.SKIPPED || key === LEGACY_SYNC_STATUS.NOT_AVAILABLE) return key;
  return key || null;
}

export function inferJobType(sourceObject, explicit = null) {
  if (explicit) return String(explicit).toUpperCase();
  const obj = String(sourceObject || "").toLowerCase();
  if (obj.includes("campaign")) return SYNC_JOB_TYPE.CAMPAIGNS;
  if (obj.includes("conversion") || obj === "orders") return SYNC_JOB_TYPE.CONVERSIONS;
  if (obj.includes("coupon") || obj.includes("voucher")) return SYNC_JOB_TYPE.COUPONS;
  if (obj.includes("report") || obj.includes("performance") || obj === "tracking") {
    return SYNC_JOB_TYPE.REPORTING;
  }
  if (obj.includes("payment") || obj.includes("invoice")) return SYNC_JOB_TYPE.PAYMENTS;
  return SYNC_JOB_TYPE.BACKFILL;
}

export function emptyIngestCounters() {
  return {
    recordsFetched: 0,
    recordsCreated: 0,
    recordsUpdated: 0,
    recordsUnchanged: 0,
    recordsQuarantined: 0,
  };
}

export function rollupIngestCounters(base = {}, patch = {}) {
  const out = { ...emptyIngestCounters(), ...base };
  for (const key of Object.keys(emptyIngestCounters())) {
    if (patch[key] != null) out[key] += Number(patch[key]) || 0;
  }
  return out;
}

/** Roll up raw payload persist outcomes. */
export function rollupRawPayloadOutcomes(outcomes = []) {
  let recordsCreated = 0;
  let recordsUnchanged = 0;
  let recordsQuarantined = 0;
  for (const o of outcomes) {
    if (o?.failed) {
      recordsQuarantined += 1;
      continue;
    }
    if (o?.created) recordsCreated += 1;
    else if (o?.duplicate || o?.record) recordsUnchanged += 1;
  }
  return { recordsCreated, recordsUnchanged, recordsQuarantined };
}

export function resolveTerminalStatus({ counters = {}, hadError = false, partial = false } = {}) {
  if (hadError) return SYNC_OBS_STATUS.FAILED;
  if (partial || Number(counters.recordsQuarantined || 0) > 0) return SYNC_OBS_STATUS.PARTIAL;
  return SYNC_OBS_STATUS.SUCCESS;
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

export function toSyncObservabilityDto(row) {
  if (!row) return null;
  const dto = {
    syncRunId: row.id ?? row.syncRunId ?? null,
    network: row.network ?? null,
    networkAccountId: row.networkAccountId ?? null,
    sourceObject: row.sourceObject ?? null,
    sourceEndpointOrReport: row.endpoint ?? null,
    endpoint: row.endpoint ?? null,
    jobType: row.jobType ?? null,
    status: normalizeSyncObsStatus(row.status),
    legacyStatus: row.status ?? null,
    trigger: row.trigger ?? null,
    parentSyncRunId: row.parentSyncRunId ?? null,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    checkpointBefore: row.checkpointBefore ?? null,
    checkpointAfter: row.checkpointAfter ?? null,
    recordsFetched: row.recordsFetched ?? row.recordCount ?? null,
    recordsCreated: row.recordsCreated ?? null,
    recordsUpdated: row.recordsUpdated ?? null,
    recordsUnchanged: row.recordsUnchanged ?? null,
    recordsQuarantined: row.recordsQuarantined ?? null,
    retryCount: row.retryCount ?? null,
    rateLimitTelemetry: row.rateLimitTelemetry ?? null,
    recordCount: row.recordCount ?? row.recordsFetched ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: sanitizeSecretError(row.errorMessage),
    metadata: row.metadata ?? null,
    availability: row.availability ?? null,
    label: row.label ?? null,
  };
  return assertNoSecrets(dto);
}
