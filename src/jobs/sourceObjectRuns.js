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
import { SYNC_TRIGGER } from "../modules/networkOps/syncObservability.contract.js";
import { getNetworkAccountSyncFlags } from "../modules/integrations/oauth.service.js";
import { explicitSyncWindow, getSyncOptions, runWithSyncOptions, sourceObjectCompanions } from "./syncContext.js";
import { activeSyncTrigger } from "./syncState.js";
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

/**
 * Which Network Connection switch governs each source object. Anything not listed (supporting
 * calls such as a Trackier profile) is governed only by the connection-level pause.
 */
export const SOURCE_OBJECT_CONNECTION_TOGGLE = Object.freeze({
  // campaigns / programmes and their terms
  campaigns: "campaignSyncEnabled",
  programmes: "campaignSyncEnabled",
  programs: "campaignSyncEnabled",
  advertisers: "campaignSyncEnabled",
  partnerships: "campaignSyncEnabled",
  commissioning_lists: "campaignSyncEnabled",
  commission_groups: "campaignSyncEnabled",
  // coupons / vouchers / offers
  voucher_codes: "couponSyncEnabled",
  coupons: "couponSyncEnabled",
  deals: "couponSyncEnabled",
  offers: "couponSyncEnabled",
  // products
  products: "productSyncEnabled",
  catalogs: "productSyncEnabled",
  product_feeds: "productSyncEnabled",
  // conversions and the performance reports built from them
  conversions: "conversionSyncEnabled",
  transactions: "conversionSyncEnabled",
  actions: "conversionSyncEnabled",
  events: "conversionSyncEnabled",
  api_reports: "conversionSyncEnabled",
  reporting: "conversionSyncEnabled",
  reports: "conversionSyncEnabled",
  tracking: "conversionSyncEnabled",
  analytics: "conversionSyncEnabled",
  link_reports: "conversionSyncEnabled",
  reports_kpi: "conversionSyncEnabled",
  // finance
  payment_overview: "financeSyncEnabled",
  invoices: "financeSyncEnabled",
  payment_information: "financeSyncEnabled",
  advanced_reports: "financeSyncEnabled",
  settlement: "financeSyncEnabled",
  finance: "financeSyncEnabled",
});

/**
 * Run one account's sync inside its Network Connection scope. With no connection record (legacy
 * env-configured networks) nothing changes. With one, a paused connection enables nothing and each
 * disabled switch removes its source objects from includeSourceObject — the same predicate every
 * sync already uses for BOTH fetching and persisting, so a disabled object is never fetched and
 * its staged data is never touched.
 */
export async function withConnectionScope(platform, accountLabel, fn, deps = {}) {
  const flagsFor = deps.getFlags ?? getNetworkAccountSyncFlags;
  let flags = null;
  try {
    flags = await flagsFor(platform, accountLabel || "default");
  } catch {
    flags = null;
  }
  if (!flags?.exists) return fn();
  // A paused connection syncs nothing and stamps nothing: no fetch, no health verdict, no checkpoint.
  if (flags.paused) {
    return {
      skipped: true,
      connectionPaused: true,
      reason: `Network connection ${platform}/${accountLabel || "default"} is paused (${flags.pausedReason || "PAUSED"}).`,
    };
  }
  const disabled = Object.keys(SOURCE_OBJECT_CONNECTION_TOGGLE).filter(
    (object) => flags[SOURCE_OBJECT_CONNECTION_TOGGLE[object]] === false,
  );
  return runWithSyncOptions(
    {
      ...getSyncOptions(),
      connectionScope: { platform, accountLabel: accountLabel || "default", disabled },
    },
    fn,
  );
}

function disabledByConnection(sourceObject) {
  const scope = getSyncOptions()?.connectionScope;
  if (!scope) return false;
  return Array.isArray(scope.disabled) && scope.disabled.includes(String(sourceObject || "").toLowerCase());
}

/** The trigger recorded on NetworkSyncRun: the run's own origin, never a hard-coded default. */
export function currentSyncTrigger() {
  // The run's own origin when the caller supplied one (worker units carry their run's), else the
  // in-process slot's (a manual per-network route or the canary holds it as "api").
  const trigger = String(getSyncOptions()?.trigger || activeSyncTrigger() || "").toLowerCase();
  if (trigger === SYNC_TRIGGER.MANUAL || trigger === SYNC_TRIGGER.API) return SYNC_TRIGGER.MANUAL;
  if (trigger === SYNC_TRIGGER.REPROCESS) return SYNC_TRIGGER.REPROCESS;
  return SYNC_TRIGGER.SCHEDULER;
}

/**
 * checkpointBefore for a run: the connection's last successful sync and the bounded window the
 * run was asked for (null when unbounded). Recorded before the fetch, never after.
 */
export async function currentCheckpointBefore(networkAccountId, db = prisma) {
  let lastSuccessfulSync = null;
  if (networkAccountId) {
    try {
      const row = await db.marketplaceAccount.findUnique({
        where: { id: networkAccountId },
        select: { lastSuccessfulSync: true },
      });
      lastSuccessfulSync = row?.lastSuccessfulSync ? new Date(row.lastSuccessfulSync).toISOString() : null;
    } catch {
      lastSuccessfulSync = null;
    }
  }
  let window = null;
  try {
    window = explicitSyncWindow();
  } catch {
    window = null;
  }
  return { lastSuccessfulSync, requestWindow: window };
}

async function runDefaults(networkAccountId) {
  return { trigger: currentSyncTrigger(), checkpointBefore: await currentCheckpointBefore(networkAccountId) };
}

export function requestedSourceObject(explicit) {
  const value = explicit ?? getSyncOptions()?.sourceObject;
  if (value == null || value === "") return null;
  return String(value).trim().toLowerCase();
}

export function includeSourceObject(requested, sourceObject) {
  const key = String(sourceObject || "").toLowerCase();
  if (disabledByConnection(key)) return false;
  if (!requested) return true;
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
    trigger: currentSyncTrigger(),
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
  checkpointBefore = null,
}) {
  const defaults = await runDefaults(networkAccountId);
  return executeSourceObjectRun({
    network,
    networkAccountId,
    sourceObject,
    endpoint,
    execute,
    trigger: defaults.trigger,
    checkpointBefore: checkpointBefore ?? defaults.checkpointBefore,
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

  const optimiseDefaults = await runDefaults(ctx.networkAccountId);
  const run = await executeSourceObjectRun({
    network: ctx.network,
    networkAccountId: ctx.networkAccountId,
    sourceObject: identity.sourceObject,
    endpoint: identity.endpoint,
    trigger: optimiseDefaults.trigger,
    checkpointBefore: ctx.checkpointBefore ?? optimiseDefaults.checkpointBefore,
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

  const trackierDefaults = await runDefaults(ctx.networkAccountId);
  const run = await executeSourceObjectRun({
    network: ctx.network || "trackier",
    networkAccountId: ctx.networkAccountId,
    sourceObject: identity.sourceObject,
    endpoint: identity.endpoint,
    trigger: trackierDefaults.trigger,
    checkpointBefore: ctx.checkpointBefore ?? trackierDefaults.checkpointBefore,
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
