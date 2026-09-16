import { syncPlatformAccount } from "../jobs/sync.job.js";
import { normalizeBoostinyCanaryOptions } from "../modules/commercial/boostinyCommissionCanary.js";
import { formatSyncError, getSyncErrorMessage } from "../jobs/syncErrors.js";
import { getSyncStatus, runExclusiveSync } from "../jobs/syncState.js";
import { getSchedulerStatus, triggerScheduledSync } from "../jobs/syncScheduler.js";
import {
  SyncOrchestrationService,
  assertUnitExecutable,
  summarisePlan,
  summariseSyncUnitOutcome,
} from "../jobs/syncOrchestration.service.js";
import { SyncAccountLockService, accountLockKey } from "../jobs/syncAccountLock.service.js";

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
 * The shared durable account lock. Taken from the orchestration service when one is provided, so
 * every path in a process speaks the same lock vocabulary; otherwise the default, backed by the
 * runtime Prisma client. Module memory cannot exclude another serverless instance — this can.
 */
function accountLocksFor(req) {
  return (
    req?.app?.locals?.syncAccountLocks ??
    req?.app?.locals?.syncOrchestration?.locks ??
    new SyncAccountLockService()
  );
}

/** The account sync entrypoint; overridable per app so the worker can be driven in tests. */
function accountSyncFor(req) {
  return req?.app?.locals?.syncPlatformAccount ?? syncPlatformAccount;
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

/**
 * Durable sync status, readable from any instance.
 *
 * The in-memory projection only describes the instance that happens to answer, so on serverless
 * hosting it is blind to work done elsewhere and is lost on a cold start. This reads the durable
 * JobRun state instead: the parent run, its counters, and a safe per-unit summary showing
 * PENDING / RUNNING / COMPLETED / FAILED / DEAD_LETTER, with no supplier payload and no
 * credentials. `?runId=` inspects one specific run; without it, the active run, else the latest.
 *
 * STRICTLY READ-ONLY: it never refreshes, claims, collapses, resumes or finalises anything.
 * The legacy in-memory block is kept under `inMemory` for anything that still reads it, and a
 * database failure degrades to that block rather than failing the one endpoint used to diagnose
 * database trouble.
 */
export async function getSyncStatusHandler(req, res) {
  res.set("Cache-Control", "no-store");
  const inMemory = getSyncStatus();
  const scheduler = getSchedulerStatus();
  const requestedRunId = typeof req?.query?.runId === "string" ? req.query.runId.trim() : "";

  let run = null;
  let durableError = null;
  try {
    const orchestration = orchestrationServiceFor(req);
    run = requestedRunId
      ? await orchestration.inspectRun(requestedRunId)
      : await orchestration.inspectLatestRun();
    if (requestedRunId && !run) {
      return res.status(404).json({
        ok: false,
        source: "durable",
        message: "No orchestration run with that id.",
        runId: requestedRunId,
      });
    }
  } catch (error) {
    durableError = getSyncErrorMessage(error);
  }

  const { units = [], ...summary } = run ?? {};
  return res.json({
    ok: true,
    source: run ? "durable" : "in-memory",
    status: run ? run.status : inMemory.status,
    runId: run?.runId ?? null,
    run: run ? summary : null,
    units,
    durableError,
    inMemory,
    scheduler,
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
 * Read-only preview of the plan a new `/sync/all` would enqueue, against the CURRENT account
 * state. Admin-only, and a pure read in the strongest sense: it goes through the orchestration
 * service's own planner with the same options `/sync/all` would use, and writes nothing — no
 * JobRun row, no lock, no timestamp — and calls no supplier.
 *
 * The response carries aggregate planning metadata only: counts, window boundaries and the
 * options in force. No unit payload is copied into it, so no campaign identifier, credential or
 * supplier row can leave through this endpoint.
 */
export async function previewSyncPlanHandler(req, res, next) {
  try {
    // The same options `/sync/all` resolves from its query string, so the preview describes the
    // run that request would actually create rather than a differently-configured one.
    const fastSync = parseBoolQuery(req.query?.fast, false);
    const options = { fastSync, promoteAfter: true };
    const kind = "full";
    const orchestration = orchestrationServiceFor(req);
    const plan = await orchestration.previewPlan({ kind, options });
    return res.status(200).json({
      ok: true,
      preview: true,
      message: "Planned units only. Nothing was enqueued, claimed, fetched or written.",
      plan: summarisePlan(plan, { kind, options }),
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
    // Durable, cross-instance exclusion on the ACCOUNT, the same key and lease the orchestration
    // worker uses: a manual run and a worker unit for the same account can never overlap, whatever
    // source object either is scoped to. The in-process runExclusiveSync below remains only as a
    // local guard; it is not the authoritative lock. The lock is released on success and failure.
    const lockKey = accountLockKey({ platform, accountLabel });
    const locks = accountLocksFor(req);
    const outcome = await locks.withLock(
      lockKey,
      // Awaited: the manual per-network sync finishes before the response (see respondWithExclusiveSync).
      () =>
        respondWithExclusiveSync({
          jobName,
          syncFn: () =>
            accountSyncFor(req)(platform, accountLabel || undefined, {
              fastSync,
              promoteAfter,
              sourceObject: sourceObject || undefined,
            }),
          res,
          trigger: "api",
        }),
      { holderId: `manual:${jobName}` },
    );
    if (!outcome.ran) {
      return res.status(409).json({
        ok: false,
        status: "running",
        message: "This account is already being synced (durable account lock held).",
        lock: { key: lockKey, heldBy: outcome.heldBy ?? null, heldByJob: outcome.heldByJob ?? null },
      });
    }
    return outcome.result;
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

/**
 * Advance a durable sync run by EXACTLY ONE bounded unit, then return.
 *
 * One invocation does one unit: find the oldest active run with executable work, claim its next
 * unit (which verifies the shared durable account lock), await exactly one account sync, record
 * the outcome and refresh the parent. No loop, no recursion, no background promise, and no
 * promotion, conversion-promotion or aggregation — those stages are not executable yet and are
 * refused. Call it again to advance the next unit.
 */
export async function triggerSyncWorker(req, res, next) {
  try {
    const orchestration = orchestrationServiceFor(req);
    const workable = await orchestration.nextWorkableUnit();
    if (!workable) {
      return res.status(200).json({
        ok: true,
        worked: false,
        status: "idle",
        message: "No executable sync unit is ready.",
      });
    }

    const { run, unit } = workable;
    const descriptor = unit.payload ?? {};
    // Defence in depth: nextUnit already withholds non-executable kinds.
    assertUnitExecutable(unit);

    const workerId = `worker:${process.env.VERCEL_DEPLOYMENT_ID || process.pid}:${Date.now()}`;
    const claim = await orchestration.claimUnit(unit.id, { workerId });
    if (!claim.claimed && claim.reason === "abandoned") {
      // Its previous worker was killed and it had no attempts left: the unit is now terminal and
      // no supplier work runs for it. The next invocation picks up the following unit.
      const syncStatus = await orchestration.describeRun(run.id);
      return res.status(200).json({
        ok: false,
        worked: false,
        status: "unit_abandoned",
        message: "The next unit had no attempts left after its worker was lost; it is now terminal.",
        reason: claim.abandonedReason ?? null,
        runId: run.id,
        unit: { unitId: unit.id, sequence: descriptor.sequence ?? null, kind: descriptor.kind ?? null, platform: descriptor.platform ?? null, accountLabel: descriptor.accountLabel ?? null, sourceObject: descriptor.sourceObject ?? null, window: descriptor.windowStart && descriptor.windowEnd ? { start: descriptor.windowStart, end: descriptor.windowEnd } : null, status: "DEAD_LETTER", attempt: claim.attempt ?? null },
        syncStatus,
      });
    }
    if (!claim.claimed) {
      return res.status(409).json({
        ok: false,
        worked: false,
        status: "busy",
        message: "The next unit could not be claimed; another worker or a manual sync holds it.",
        reason: claim.reason,
        runId: run.id,
        unitId: unit.id,
        lock: { key: descriptor.lockKey ?? null, heldBy: claim.heldBy ?? null },
      });
    }

    const unitView = {
      unitId: unit.id,
      sequence: descriptor.sequence ?? null,
      kind: descriptor.kind ?? null,
      platform: descriptor.platform ?? null,
      accountLabel: descriptor.accountLabel ?? null,
      sourceObject: descriptor.sourceObject ?? null,
      window:
        descriptor.windowStart && descriptor.windowEnd
          ? { start: descriptor.windowStart, end: descriptor.windowEnd }
          : null,
      // Position and size only: the campaign identifiers stay in the unit payload.
      campaignChunk:
        descriptor.campaignChunkIndex === null || descriptor.campaignChunkIndex === undefined
          ? null
          : {
              index: descriptor.campaignChunkIndex,
              of: descriptor.campaignChunkCount ?? null,
              campaignCount: Array.isArray(descriptor.campaignIds) ? descriptor.campaignIds.length : null,
            },
    };

    let result;
    try {
      result = await accountSyncFor(req)(descriptor.platform, descriptor.accountLabel || undefined, {
        // The unit's own recorded options…
        fastSync: Boolean(descriptor.options?.fastSync),
        // …except promotion, which a unit NEVER runs: the global post-sync stages do not fit an
        // invocation and are their own (not yet executable) units.
        promoteAfter: false,
        // The unit's bounded scope, forwarded verbatim. A pre-Phase-5 unit carries neither, and
        // then the account sync behaves exactly as it always did.
        sourceObject: descriptor.sourceObject || undefined,
        ...(descriptor.windowStart && descriptor.windowEnd
          ? { windowStart: descriptor.windowStart, windowEnd: descriptor.windowEnd }
          : {}),
        ...(Array.isArray(descriptor.sourceObjectCompanions) && descriptor.sourceObjectCompanions.length
          ? { sourceObjectCompanions: [...descriptor.sourceObjectCompanions] }
          : {}),
        // A commission-group unit's own campaign slice: this chunk's campaigns and no others.
        ...(Array.isArray(descriptor.campaignIds) && descriptor.campaignIds.length
          ? { campaignIds: [...descriptor.campaignIds] }
          : {}),
      });
    } catch (error) {
      const failed = await orchestration.failUnit(unit.id, error);
      const syncStatus = await orchestration.describeRun(run.id);
      return res.status(200).json({
        ok: false,
        worked: true,
        status: failed?.status === "DEAD_LETTER" ? "unit_failed" : "unit_retry",
        message: getSyncErrorMessage(error),
        runId: run.id,
        unit: { ...unitView, status: failed?.status ?? null, attempt: failed?.attempt ?? null },
        syncStatus,
      });
    }

    // Some work can only be scoped once another unit has run — an Optimise account's commission
    // groups are one request per campaign, and the campaign list is what this unit just staged.
    //
    // This runs BEFORE the unit is completed, and the order matters: completing the last pending
    // unit finalises the parent, and a finalised run refuses new units. Materialising first means
    // the chunks exist while this unit is still RUNNING, so the parent cannot terminate between
    // the two. If it throws, the unit is never completed, its lease expires and the whole step is
    // retried — the failure is visible and recoverable rather than a silently short run.
    const followOn = await orchestration.materialiseFollowOnUnits(run.id, descriptor);
    await orchestration.completeUnit(unit.id, summariseSyncUnitOutcome(result, { accountLabel: descriptor.accountLabel }));
    const syncStatus = await orchestration.describeRun(run.id);
    return res.status(200).json({
      ok: true,
      worked: true,
      status: "unit_completed",
      message: "One sync unit completed.",
      runId: run.id,
      unit: { ...unitView, status: "COMPLETED" },
      ...(followOn?.appended ? { unitsMaterialised: followOn.appended } : {}),
      syncStatus,
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
