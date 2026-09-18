/**
 * Per-source-object sync helpers. Wraps live adapter fetches in isolated SyncRuns.
 * Cache skips and finance-disabled skips are not persisted (avoids overwriting last live run).
 */

import { prisma } from "../database/prisma.js";
import { toSyncObservabilityDto } from "../modules/networkOps/syncObservability.contract.js";
import { pagedOutcome, withSourceOutcome } from "./sourceFetchOutcome.js";
import {
  executeSourceObjectRun,
  resultRows,
  sourceObjectSync,
} from "../modules/networkOps/sourceObjectSync.service.js";
import { getSourceObject } from "../modules/networkOps/sourceObjects.catalog.js";
import { getSyncOptions, sourceObjectCompanions } from "./syncContext.js";
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
  const key = String(sourceObject || "").toLowerCase();
  if (requested === key) return true;
  // A DERIVED object computed from the requested one's rows (Impact reports, Partnerize
  // analytics) cannot be its own bounded unit — it travels with its parent. Only the bounded
  // planner sets companions, so a manual ?sourceObject= request is unaffected.
  return sourceObjectCompanions().includes(key);
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
  commissionGroups: {
    sourceObject: "commission_groups",
    endpoint: "GET /campaigns/{campaignId}/commission-groups",
  },
});

/**
 * Phase 5 — the single predicate deciding whether an Optimise resource belongs to the requested
 * source object. Fetching and every downstream persistence, promotion and enrichment step must
 * consult this same function, so a bounded unit can never skip a fetch and still write that
 * resource's data.
 */
export function includeOptimiseResource(requested, resource) {
  const identity = OPTIMISE_RESOURCE_IDENTITY[resource];
  if (!identity) return true;
  return includeSourceObject(requested, identity.sourceObject);
}

export async function fetchOptimiseSourceObject(
  resource,
  credentials,
  fn,
  options = {},
  ctx = {},
) {
  const identity = OPTIMISE_RESOURCE_IDENTITY[resource];
  const requested = requestedSourceObject(ctx.sourceObject);

  if (identity && !includeOptimiseResource(requested, resource)) {
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
    // options.exhaustionStats is the bag THIS call's pager writes its exhaustion reason to. It is
    // created per call by the caller rather than per account, because these resources are fetched
    // concurrently: one shared bag would be written by several walks at once and no snapshot could
    // tell them apart. Absent for the resources whose pagers record nothing, and then this reduces
    // to exactly what it was.
    execute: async () =>
      withSourceOutcome(options.exhaustionStats ?? null, async () => {
        const result = await fetchOptimiseResource(resource, credentials, fn, options);
        if (result.error) throw result.error;
        // The walk's own completeness evidence used to stop here: only `rows` was returned, so a
        // slice that KNEW more pages remained reported an indistinguishable SUCCESS. It lives in a
        // closure the fetch fn fills rather than on the resource result, so it is handed in through
        // a ref and read back once fn() has run. A sliced walk is expected and healthy, so this is
        // metadata and never `partial`: it exists so a later reader can answer "was this slice the
        // terminal page of the catalog walk?" without re-deriving it.
        const pagination = options.paginationRef?.value ?? null;
        return pagination ? pagedOutcome(result.rows, pagination) : result.rows;
      }),
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

/** A non-array supplier body, as opposed to an array of rows or an outcome envelope wrapping one. */
function isResourceBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return !Array.isArray(value.rows);
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
    // Same per-call bag as Optimise, for the same reason: this job awaits its Trackier source
    // objects with Promise.all.
    execute: async () =>
      withSourceOutcome(options.exhaustionStats ?? null, async () => {
        const result = await fetchTrackierResource(resource, credentials, fn, options);
        if (result.error) throw result.error;
        if (Array.isArray(result.rows) && result.rows.length) return result.rows;
        return result.data ?? result.rows;
      }),
  });

  const rows = resultRows(run);
  return {
    resource,
    endpoint: identity.endpoint,
    rows,
    // `data` is the non-array body a resource like campaignsCount answers with. An outcome object
    // — {rows, metadata} — is NOT that: it is this run's own envelope, and handing it back as the
    // resource's body would present pagination evidence as supplier data.
    data: !rows.length && isResourceBody(run.result) ? run.result : null,
    error: run.status === "FAILED" ? { message: run.error?.message } : null,
    skipped: false,
    syncRun: summarizeSourceObjectRun(run),
  };
}
