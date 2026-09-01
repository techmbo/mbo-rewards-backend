/**
 * Per-source-object sync helpers. Wraps live adapter fetches in isolated SyncRuns.
 * Cache skips and finance-disabled skips are not persisted (avoids overwriting last live run).
 */

import { prisma } from "../database/prisma.js";
import { toSyncObservabilityDto } from "../modules/networkOps/syncObservability.contract.js";
import {
  executeSourceObjectRun,
  resultRows,
  sourceObjectSync,
} from "../modules/networkOps/sourceObjectSync.service.js";
import { getSourceObject } from "../modules/networkOps/sourceObjects.catalog.js";
import { getSyncOptions } from "./syncContext.js";
import { fetchOptimiseResource } from "./optimiseResourceSync.js";
import { fetchTrackierResource } from "./trackierResourceSync.js";

export { evidenceFromRunSummary } from "../modules/networkOps/sourceEvidence.context.js";

export async function resolveNetworkAccountId(platform, accountLabel, db = prisma) {
  try {
    const row = await db.marketplaceAccount.findUnique({
      where: {
        platform_accountLabel: {
          platform,
          accountLabel: accountLabel || "default",
        },
      },
      select: { id: true },
    });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export function requestedSourceObject(explicit) {
  const value = explicit ?? getSyncOptions()?.sourceObject;
  if (value == null || value === "") return null;
  return String(value).trim().toLowerCase();
}

export function includeSourceObject(requested, sourceObject) {
  if (!requested) return true;
  return requested === String(sourceObject || "").toLowerCase();
}

export function summarizeSourceObjectRun(run) {
  if (!run?.identity) return null;
  const dto = toSyncObservabilityDto({
    id: run.identity.sync_run_id,
    network: run.identity.network,
    networkAccountId: run.identity.network_account_id,
    sourceObject: run.identity.source_object,
    endpoint: run.identity.endpoint,
    status: run.status,
    recordCount: recordCountFromRun(run),
    recordsFetched: recordCountFromRun(run),
    errorCode: run.error?.code ?? null,
    errorMessage: run.error?.message ?? null,
    jobType: run.jobType ?? null,
    checkpointBefore: run.checkpointBefore ?? null,
    checkpointAfter: run.checkpointAfter ?? null,
    recordsCreated: run.recordsCreated ?? null,
    recordsUpdated: run.recordsUpdated ?? null,
    recordsUnchanged: run.recordsUnchanged ?? null,
    recordsQuarantined: run.recordsQuarantined ?? null,
    retryCount: run.retryCount ?? null,
    rateLimitTelemetry: run.rateLimitTelemetry ?? null,
    trigger: run.trigger ?? null,
    parentSyncRunId: run.parentSyncRunId ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
  });
  return {
    syncRunId: dto.syncRunId,
    network: dto.network,
    networkAccountId: dto.networkAccountId,
    sourceObject: dto.sourceObject,
    endpoint: dto.endpoint,
    sourceEndpointOrReport: dto.sourceEndpointOrReport,
    status: dto.status,
    recordCount: dto.recordCount,
    recordsFetched: dto.recordsFetched,
    recordsCreated: dto.recordsCreated,
    recordsUpdated: dto.recordsUpdated,
    recordsUnchanged: dto.recordsUnchanged,
    recordsQuarantined: dto.recordsQuarantined,
    jobType: dto.jobType,
    checkpointBefore: dto.checkpointBefore,
    checkpointAfter: dto.checkpointAfter,
    retryCount: dto.retryCount,
    rateLimitTelemetry: dto.rateLimitTelemetry,
    errorCode: dto.errorCode,
    errorMessage: dto.errorMessage,
  };
}

function recordCountFromRun(run) {
  if (Array.isArray(run.result)) return run.result.length;
  if (Array.isArray(run.result?.rows)) return run.result.rows.length;
  return run.result?.recordCount ?? run.result?.recordsFetched ?? null;
}

/**
 * When a caller asks for one object that is unknown or declared-not-live,
 * persist a NOT_AVAILABLE run and skip the rest of the account job.
 * Live objects return null so the job can fetch that object only.
 */
export async function runUnavailableIfRequested({ network, networkAccountId, requested }) {
  if (!requested) return null;
  const catalog = getSourceObject(network, requested);
  if (catalog?.live) return null;
  const run = await executeSourceObjectRun({
    network,
    networkAccountId,
    sourceObject: requested,
  });
  return {
    skipped: true,
    reason: run.error?.message || `Source object ${requested} is not available for ${network}`,
    sourceObjectRuns: [summarizeSourceObjectRun(run)].filter(Boolean),
  };
}

export async function runLiveSourceObject({
  network,
  networkAccountId,
  sourceObject,
  endpoint,
  execute,
}) {
  return executeSourceObjectRun({
    network,
    networkAccountId,
    sourceObject,
    endpoint,
    execute,
  });
}

export const OPTIMISE_RESOURCE_IDENTITY = Object.freeze({
  campaigns: { sourceObject: "campaigns", endpoint: "GET /campaigns" },
  conversions: { sourceObject: "conversions", endpoint: "GET /conversions" },
  conversionsByPayment: {
    sourceObject: "conversions",
    endpoint: "GET /conversions (conversionsByPayment)",
  },
  reporting: { sourceObject: "reporting", endpoint: "POST /reporting/" },
  invoiceReporting: {
    sourceObject: "reporting",
    endpoint: "POST /reporting/ (invoice date)",
  },
  payments: { sourceObject: "payment_overview", endpoint: "GET /payments" },
  invoices: { sourceObject: "invoices", endpoint: "GET /invoices" },
  voucherCodes: { sourceObject: "voucher_codes", endpoint: "GET /vouchercodes" },
});

export async function fetchOptimiseSourceObject(
  resource,
  credentials,
  fn,
  options = {},
  ctx = {},
) {
  const identity = OPTIMISE_RESOURCE_IDENTITY[resource];
  const requested = requestedSourceObject(ctx.sourceObject);

  if (requested && identity && !includeSourceObject(requested, identity.sourceObject)) {
    return fetchOptimiseResource(resource, credentials, async () => [], {
      skipped: true,
      skipReason: "source_object_filter",
    });
  }

  if (options.skipped || !identity) {
    return fetchOptimiseResource(resource, credentials, fn, options);
  }

  const run = await executeSourceObjectRun({
    network: ctx.network,
    networkAccountId: ctx.networkAccountId,
    sourceObject: identity.sourceObject,
    endpoint: identity.endpoint,
    execute: async () => {
      const result = await fetchOptimiseResource(resource, credentials, fn, options);
      if (result.error) throw result.error;
      return result.rows;
    },
  });

  return {
    resource,
    endpoint: identity.endpoint,
    rows: resultRows(run),
    error: run.status === "FAILED" ? { message: run.error?.message } : null,
    skipped: false,
    syncRun: summarizeSourceObjectRun(run),
  };
}

export const TRACKIER_RESOURCE_IDENTITY = Object.freeze({
  campaigns: { sourceObject: "campaigns", endpoint: "GET /v2/publisher/campaigns" },
  conversions: { sourceObject: "conversions", endpoint: "GET /v2/publishers/conversions" },
  reports: { sourceObject: "tracking", endpoint: "GET /v2/publishers/reports" },
  coupons: { sourceObject: "coupons", endpoint: "GET /v2/publishers/coupons" },
  deals: { sourceObject: "coupons", endpoint: "GET /v2/publishers/deals" },
});

const TRACKIER_SUPPORTING = {
  campaigns: ["profile", "categories", "campaignsCount"],
  conversions: ["profile"],
  tracking: ["profile", "reportsKpi"],
  coupons: ["profile"],
};

export function includeTrackierResource(requested, resource) {
  if (!requested) return true;
  const identity = TRACKIER_RESOURCE_IDENTITY[resource];
  if (identity && includeSourceObject(requested, identity.sourceObject)) return true;
  return (TRACKIER_SUPPORTING[requested] || []).includes(resource);
}

export async function fetchTrackierSourceObject(
  resource,
  credentials,
  fn,
  options = {},
  ctx = {},
) {
  const requested = requestedSourceObject(ctx.sourceObject);
  if (!includeTrackierResource(requested, resource)) {
    return fetchTrackierResource(resource, credentials, async () => [], {
      skipped: true,
      skipReason: "source_object_filter",
    });
  }

  const identity = TRACKIER_RESOURCE_IDENTITY[resource];
  if (options.skipped || !identity) {
    return fetchTrackierResource(resource, credentials, fn, options);
  }

  const run = await executeSourceObjectRun({
    network: ctx.network || "trackier",
    networkAccountId: ctx.networkAccountId,
    sourceObject: identity.sourceObject,
    endpoint: identity.endpoint,
    execute: async () => {
      const result = await fetchTrackierResource(resource, credentials, fn, options);
      if (result.error) throw result.error;
      if (Array.isArray(result.rows) && result.rows.length) return result.rows;
      return result.data ?? result.rows;
    },
  });

  const rows = resultRows(run);
  return {
    resource,
    endpoint: identity.endpoint,
    rows,
    data: !rows.length && run.result && !Array.isArray(run.result) ? run.result : null,
    error: run.status === "FAILED" ? { message: run.error?.message } : null,
    skipped: false,
    syncRun: summarizeSourceObjectRun(run),
  };
}
