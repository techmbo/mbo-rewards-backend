import { syncPlatformAccount } from "../jobs/sync.job.js";
import { normalizeBoostinyCanaryOptions } from "../modules/commercial/boostinyCommissionCanary.js";
import { formatSyncError, getSyncErrorMessage } from "../jobs/syncErrors.js";
import { getSyncStatus, runExclusiveSync } from "../jobs/syncState.js";
import { getSchedulerStatus, triggerScheduledSync } from "../jobs/syncScheduler.js";
import { SyncOrchestrationService } from "../jobs/syncOrchestration.service.js";

const SUPPORTED_SYNC_PLATFORMS = new Set([
  "boostiny",
  "optimise_sea",
  "optimise_mena",
  "optimise_uk",
  "trackier",
  "impact",
  "partnerize",
  "awin",
]);

function parseBoolQuery(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

/**
 * The durable orchestration service. Overridable per app (tests, or a future worker sharing one
 * instance) through app.locals; otherwise the default, backed by the runtime Prisma client.
 */
function orchestrationServiceFor(req) {
  return req?.app?.locals?.syncOrchestration ?? new SyncOrchestrationService();
}

/**
 * Run a sync to completion inside the request and answer only when it has finished. On serverless
 * hosting an un-awaited promise does not survive the HTTP response (the instance is frozen once
 * the response is sent), so a manual per-network sync must be awaited. Same slot and status
 * bookkeeping as every other sync (runExclusiveSync); 200 on success/partial, 409 when the
 * exclusive slot is already held, 500 with the sync's own error message when the run fails.
 */
export async function respondWithExclusiveSync({ jobName, syncFn, res, trigger = "api" }) {
  const run = await runExclusiveSync(jobName, syncFn, { trigger });
  if (!run.started) {
    return res.status(409).json({ ok: false, status: "running", message: run.reason, syncStatus: run.status });
  }
  if (run.error) {
    return res.status(500).json({
      ok: false,
      status: run.status?.status ?? "failed",
      message: getSyncErrorMessage(run.error),
      syncStatus: run.status,
    });
  }
  return res.status(200).json({
    ok: true,
    status: run.status?.status ?? "success",
    message: "Sync completed.",
    syncStatus: run.status,
  });
}

export function getSyncStatusHandler(_req, res) {
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    ...getSyncStatus(),
    scheduler: getSchedulerStatus(),
  });
}

/**
 * Enqueue (or resume) a durable full-sync run. This route does NO work: an un-awaited sync does
 * not survive the HTTP response on serverless hosting, and a full sync cannot fit in one
 * invocation anyway. It creates the parent run and its bounded network units transactionally and
 * returns 202 with the run id; the units are executed later, one per invocation, by the worker.
 *
 * A request that matches an active run resumes it rather than duplicating the work; a request
 * whose execution options differ gets its own run.
 */
export async function triggerSyncAll(req, res, next) {
  try {
    // Manual sync refreshes campaigns/coupons by default; pass ?fast=true for incremental-only.
    const fastSync = parseBoolQuery(req.query?.fast, false);
    // A full sync still asks for post-sync promotion; it is recorded on the run and stays deferred
    // until its bounded units exist, so the run cannot report success before that work is done.
    const options = { fastSync, promoteAfter: true };
    const orchestration = orchestrationServiceFor(req);
    const run = await orchestration.getOrCreateRun({ kind: "full", trigger: "api", options });
    const syncStatus = await orchestration.describeRun(run.id);
    return res.status(202).json({
      ok: true,
      status: syncStatus?.status ?? "running",
      message: run.created
        ? "Full sync run created. Poll /sync/status for progress."
        : "A matching full sync run is already active; resuming it.",
      runId: run.id,
      created: run.created,
      syncStatus,
    });
  } catch (error) {
    next(formatSyncError(error));
  }
}

/**
 * Only an EXPLICIT false ("false", "0", "no"; case-insensitive, trimmed) switches a flag off.
 * Anything else — absent, empty, unknown text — keeps the default, so the default never changes
 * silently on a typo.
 */
function explicitFalse(value) {
  if (typeof value !== "string") return false;
  return ["false", "0", "no"].includes(value.trim().toLowerCase());
}

/**
 * Options of the manual per-network sync, from the query string:
 *  - fast=true            → fastSync (incremental windows)
 *  - sourceObject=<key>   → restrict fetch/staging to one source object
 *  - promote=false        → skip the post-sync promotion / conversion promotion / aggregation
 *                           (the unscoped, all-network stage that does not fit a serverless
 *                           request); default stays promoteAfter: true.
 */
export function resolvePlatformSyncOptions(query = {}) {
  const q = query && typeof query === "object" ? query : {};
  return {
    fastSync: parseBoolQuery(q.fast, false),
    promoteAfter: !explicitFalse(q.promote),
    sourceObject: q.sourceObject || q.source_object || undefined,
  };
}

export async function triggerSyncPlatform(req, res, next) {
  try {
    const { platform, accountLabel } = req.params;
    if (!SUPPORTED_SYNC_PLATFORMS.has(platform)) {
      return res.status(400).json({ ok: false, message: `Unsupported platform: ${platform}` });
    }

    const { fastSync, promoteAfter, sourceObject } = resolvePlatformSyncOptions(req.query);
    const jobName = accountLabel
      ? `sync:${platform}:${accountLabel}${sourceObject ? `:${sourceObject}` : ""}`
      : `sync:${platform}${sourceObject ? `:${sourceObject}` : ""}`;
    // Awaited: the manual per-network sync finishes before the response (see respondWithExclusiveSync).
    return respondWithExclusiveSync({
      jobName,
      syncFn: () =>
        syncPlatformAccount(platform, accountLabel || undefined, {
          fastSync,
          promoteAfter,
          sourceObject: sourceObject || undefined,
        }),
      res,
      trigger: "api",
    });
  } catch (error) {
    next(formatSyncError(error));
  }
}

/**
 * Admin-only Boostiny commission canary: one account, one supplier campaign, dry run unless
 * dryRun=false is stated. Runs the ordinary Boostiny account sync restricted to the campaigns
 * source object with the canary filter applied inside the sync, before any commission write.
 * The response carries the finished status (result[accountLabel].canary / .commissionRules); the
 * same payload stays readable from GET /sync/status on the instance that ran it.
 */
export async function triggerBoostinyCanarySync(req, res, next) {
  try {
    const accountLabel = String(req.params?.accountLabel ?? "").trim();
    if (!accountLabel) {
      return res.status(400).json({ ok: false, message: "accountLabel is required." });
    }
    let canary;
    try {
      canary = normalizeBoostinyCanaryOptions({
        supplierCampaignId: req.body?.supplierCampaignId ?? req.query?.supplierCampaignId,
        dryRun: req.body?.dryRun ?? req.query?.dryRun,
      });
    } catch (error) {
      return res.status(error.status ?? 400).json({ ok: false, message: error.message });
    }
    const jobName = `sync:boostiny:${accountLabel}:canary:${canary.dryRun ? "dry-run" : "live"}`;
    // Certification path: the run is AWAITED, not launched in the background. On serverless hosting
    // an un-awaited promise does not survive the HTTP response (the instance is frozen once the
    // response is sent), so the canary must finish — real Boostiny fetch, dry-run plan, status
    // finalised — before anything is written to the client. The same in-process slot and status
    // bookkeeping as every other sync is used; only this route waits for it.
    const run = await runExclusiveSync(
      jobName,
      () =>
        syncPlatformAccount("boostiny", accountLabel, {
          fastSync: false,
          promoteAfter: false,
          sourceObject: "campaigns",
          canary,
        }),
      { trigger: "api" },
    );
    if (!run.started) {
      return res.status(409).json({ ok: false, status: "running", message: run.reason, syncStatus: run.status });
    }
    if (run.error) {
      return res.status(500).json({
        ok: false,
        status: run.status?.status ?? "failed",
        message: getSyncErrorMessage(run.error),
        syncStatus: run.status,
      });
    }
    return res.status(200).json({
      ok: true,
      status: run.status?.status ?? "success",
      message: "Boostiny canary completed.",
      syncStatus: run.status,
    });
  } catch (error) {
    next(formatSyncError(error));
  }
}

/** Ops helper — trigger the same incremental path the scheduler uses. */
export async function triggerIncrementalSync(_req, res) {
  const launch = triggerScheduledSync({ reason: "api" });
  return res.status(202).json({
    ok: true,
    status: launch.started ? "running" : "skipped",
    message: launch.started
      ? "Incremental sync started. Poll /sync/status for progress."
      : launch.reason,
    syncStatus: launch.status,
    scheduler: getSchedulerStatus(),
  });
}
