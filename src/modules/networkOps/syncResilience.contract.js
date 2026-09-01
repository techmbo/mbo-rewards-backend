/**
 * Pointer 29 — Sync resilience requirements.
 * Production sync must survive real network/API conditions; HTTP 200 alone is not success.
 */
import { SYNC_OBS_STATUS } from "./syncObservability.contract.js";

export const CONTRACT_POINTER = 29;

export const SYNC_RESILIENCE_SUMMARY = Object.freeze({
  successDefinition:
    "A successful HTTP response does not prove a complete sync. A sync is successful only when all expected pages/windows are processed and the checkpoint is safely advanced.",
  historicalRetentionRule:
    "Do not delete historical facts merely because a network stops returning them. Mark records stale, ended, unavailable, or superseded only through an approved rule.",
});

/** Required production sync capabilities — order matches contract. */
export const SYNC_RESILIENCE_REQUIREMENTS = Object.freeze([
  {
    key: "pagination",
    label: "Pagination",
    description: "Process every expected result page/window until exhaustion.",
    enforcedBy: ["jobs/sync.job.js", "core/pagination.js", "modules/raw/raw.service.js"],
  },
  {
    key: "rate_limits",
    label: "Rate limits",
    description: "Detect rate-limit responses and honour retry-after/backoff semantics.",
    enforcedBy: ["core/httpClient.js", "modules/ops/syncAlert.service.js", "syncObservability.contract.js"],
  },
  {
    key: "retries_with_backoff",
    label: "Retries with backoff",
    description: "Retry transient failures with bounded exponential/backoff delays.",
    enforcedBy: ["core/httpClient.js", "modules/networkOps/sourceObjectSync.service.js"],
  },
  {
    key: "api_timeouts",
    label: "API timeouts",
    description: "Handle upstream timeouts without corrupting checkpoint state.",
    enforcedBy: ["core/httpClient.js", "modules/networkOps/sourceObjectSync.service.js"],
  },
  {
    key: "token_expiry_refresh",
    label: "Token expiry/refresh",
    description: "Refresh or re-authenticate tokens where the network adapter requires it.",
    enforcedBy: ["controllers/oauth.controller.js", "modules/networkOps/networkAccount.contract.js"],
  },
  {
    key: "partial_failures",
    label: "Partial failures",
    description: "Record PARTIAL status when some records fail without losing completed work.",
    enforcedBy: ["syncObservability.contract.js", "sourceObjectSync.service.js"],
  },
  {
    key: "incremental_checkpoints",
    label: "Incremental checkpoints",
    description: "Advance checkpointAfter only after all expected pages/windows succeed.",
    enforcedBy: ["sourceObjectSync.service.js", "syncObservability.contract.js", "raw/raw.service.js"],
  },
  {
    key: "historical_backfill",
    label: "Historical backfill",
    description: "Support backfill windows without overwriting immutable historical facts.",
    enforcedBy: ["syncObservability.contract.js", "jobs/sync.job.js"],
  },
  {
    key: "duplicate_pages",
    label: "Duplicate pages",
    description: "Treat duplicate page responses idempotently without double-counting facts.",
    enforcedBy: ["modules/mapping/engine.js", "modules/order/orderIngestion.service.js"],
  },
  {
    key: "late_conversion_updates",
    label: "Late conversion updates",
    description: "Accept late-arriving conversion status/value changes without duplicate orders.",
    enforcedBy: ["modules/order/orderIngestion.service.js", "modules/reporting/services/attribution.service.js"],
  },
  {
    key: "deleted_expired_stale_records",
    label: "Deleted/expired/stale campaign records",
    description: "Handle lifecycle changes through approved stale/ended/unavailable/superseded rules.",
    enforcedBy: ["jobs/sync.job.js", "modules/ops/importedRecords.service.js"],
  },
]);

export const APPROVED_LIFECYCLE_MARKERS = Object.freeze([
  "stale",
  "ended",
  "unavailable",
  "superseded",
]);

export const SYNC_SUCCESS_CRITERIA = Object.freeze({
  requiresAllPagesProcessed: true,
  requiresCheckpointSafelyAdvanced: true,
  httpResponseAloneInsufficient: true,
  terminalStatuses: Object.freeze([
    SYNC_OBS_STATUS.SUCCESS,
    SYNC_OBS_STATUS.PARTIAL,
  ]),
});

export class SyncResilienceError extends Error {
  constructor(message, { code = "SYNC_RESILIENCE_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "SyncResilienceError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

/**
 * Assert a sync run meets Pointer 29 success criteria — not merely HTTP 200.
 */
export function assertSyncSuccessCriteria({
  httpStatus = null,
  allPagesProcessed = false,
  checkpointSafelyAdvanced = false,
  terminalStatus = null,
} = {}) {
  if (httpStatus === 200 && !allPagesProcessed) {
    throw new SyncResilienceError(
      "HTTP 200 does not prove a complete sync — all expected pages/windows must be processed.",
      {
        code: "HTTP_SUCCESS_INCOMPLETE_SYNC",
        details: { httpStatus, allPagesProcessed, checkpointSafelyAdvanced },
      },
    );
  }

  if (allPagesProcessed && !checkpointSafelyAdvanced) {
    throw new SyncResilienceError(
      "Sync processed pages but checkpoint was not safely advanced.",
      {
        code: "CHECKPOINT_NOT_ADVANCED",
        details: { allPagesProcessed, checkpointSafelyAdvanced },
      },
    );
  }

  if (terminalStatus === SYNC_OBS_STATUS.SUCCESS && (!allPagesProcessed || !checkpointSafelyAdvanced)) {
    throw new SyncResilienceError("SUCCESS status requires complete pages and safe checkpoint advance.", {
      code: "SUCCESS_WITHOUT_RESILIENCE_CRITERIA",
      details: { terminalStatus, allPagesProcessed, checkpointSafelyAdvanced },
    });
  }

  return true;
}

/**
 * Assert historical facts are retained — networks stopping delivery must not hard-delete records.
 */
export function assertHistoricalRetentionCompliance({
  action,
  lifecycleMarker = null,
  approvedRule = null,
} = {}) {
  if (action === "hard_delete_historical_fact") {
    throw new SyncResilienceError(
      "Do not delete historical facts merely because a network stops returning them.",
      {
        code: "HISTORICAL_FACT_DELETION_FORBIDDEN",
        details: { action, lifecycleMarker, approvedRule },
      },
    );
  }

  if (["mark_stale", "mark_ended", "mark_unavailable", "mark_superseded"].includes(action)) {
    const marker = String(lifecycleMarker || action.replace(/^mark_/, ""));
    if (!APPROVED_LIFECYCLE_MARKERS.includes(marker)) {
      throw new SyncResilienceError(`Unsupported lifecycle marker: ${marker}`, {
        code: "UNKNOWN_LIFECYCLE_MARKER",
        details: { action, lifecycleMarker: marker },
      });
    }
    if (!approvedRule) {
      throw new SyncResilienceError(
        "Lifecycle markers require an approved rule — stale/ended/unavailable/superseded cannot be ad hoc.",
        {
          code: "LIFECYCLE_MARKER_WITHOUT_APPROVED_RULE",
          details: { action, lifecycleMarker: marker },
        },
      );
    }
  }

  return true;
}

export function buildSyncResilienceGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...SYNC_RESILIENCE_SUMMARY },
    requirements: SYNC_RESILIENCE_REQUIREMENTS.map((item) => ({ ...item })),
    successCriteria: { ...SYNC_SUCCESS_CRITERIA },
    approvedLifecycleMarkers: [...APPROVED_LIFECYCLE_MARKERS],
    runtimeRefs: Object.freeze({
      syncRunService: "modules/networkOps/sourceObjectSync.service.js",
      syncObservability: "modules/networkOps/syncObservability.contract.js",
      httpClient: "core/httpClient.js",
      syncAlerts: "modules/ops/syncAlert.service.js",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      sourceObjectSync: "modules/networkOps/sourceObjectSync.service.js",
      syncJob: "jobs/sync.job.js",
      catalogEntry: `modules/networkOps/sourceObjects.catalog.js (${family}/${obj})`,
    });
  }

  return guide;
}

export function applySyncResilienceContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    syncResiliencePointer: CONTRACT_POINTER,
    syncResilienceNetwork: network || null,
    syncResilienceSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
