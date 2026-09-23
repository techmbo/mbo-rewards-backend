import { syncPlatformAccount } from "../jobs/sync.job.js";
import { normalizeBoostinyCanaryOptions } from "../modules/commercial/boostinyCommissionCanary.js";
import { formatSyncError, getSyncErrorMessage } from "../jobs/syncErrors.js";
import { getSyncStatus, runExclusiveSync } from "../jobs/syncState.js";
import { getSchedulerStatus } from "../jobs/syncScheduler.js";
import {
  ADMIN_CANCELLED_REASON,
  SyncOrchestrationService,
  UNIT_KINDS,
  assertUnitExecutable,
  summarisePlan,
  summariseSyncUnitOutcome,
} from "../jobs/syncOrchestration.service.js";
import {
  executeAggregationUnit,
  summariseAggregationUnitOutcome,
} from "../jobs/aggregationUnit.js";
import {
  CONVERSION_PROMOTION_PAGE_SIZE,
  executeConversionPromotionUnit,
  nextConversionPromotionUnit,
  summariseConversionPromotionUnitOutcome,
} from "../jobs/conversionPromotionUnit.js";
import {
  PROMOTION_PAGE_SIZE,
  executePromotionUnit,
  nextPromotionUnit,
  summarisePromotionUnitOutcome,
} from "../jobs/promotionUnit.js";
import {
  AWIN_MATERIALIZATION_NETWORK_SOURCE,
  AWIN_MATERIALIZATION_PAGE_SIZE,
  executeAwinParentMaterializationUnit,
  nextAwinParentMaterializationUnit,
  summariseAwinParentMaterializationUnitOutcome,
} from "../jobs/awinParentMaterializationUnit.js";
import { planScopedSourceUnits } from "../jobs/syncSourcePlan.js";
import { SyncAccountLockService, accountLockKey } from "../jobs/syncAccountLock.service.js";
import { isStagingFrozenError } from "../jobs/entityStagingBarrier.js";

const SUPPORTED_SYNC_PLATFORMS = new Set([
  "boostiny",
  "optimise_sea",
  "optimise_mena",
  "optimise_uk",
  "trackier",
  "impact",
  "partnerize",
  "awin",
  // Dispatched by syncPlatformAccount like the rest; they were only missing from this allow-list,
  // so an account connected from the admin could not be synced on demand.
  "admitad",
  "cj",
  "rakuten",
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
export function orchestrationServiceFor(req) {
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
 * The aggregation rebuild entrypoint; overridable per app so the worker can be driven in tests.
 *
 * Phase 6a — a day unit rebuilds exactly its own day. `rebuild` is deliberate and audited:
 * AggregationService.rebuild deletes the day's DailyReport rows before re-aggregating, while
 * runForDate only upserts and would leave stale dimensions behind.
 */
function aggregationRebuildFor(req) {
  const override = req?.app?.locals?.aggregationRebuild;
  if (typeof override === "function") return override;
  return async (input) => {
    const { AggregationJob } = await import("../jobs/aggregation.job.js");
    return new AggregationJob().rebuild(input);
  };
}

/**
 * The conversion-promotion page entrypoint; overridable per app so the worker can be driven in
 * tests.
 *
 * Phase 6b — a unit promotes exactly ONE page. `runPage` is deliberate and audited: the service's
 * own `run()` drains every page in a `for (;;)` loop, which is precisely the unbounded stage a
 * bounded unit exists to replace. Only the single-page entrypoint is reachable from here.
 */
function conversionPromotionPageFor(req) {
  const override = req?.app?.locals?.conversionPromotionPage;
  if (typeof override === "function") return override;
  return async (input) => {
    const { ConversionPromotionService } = await import(
      "../modules/reporting/services/conversionPromotion.service.js"
    );
    return new ConversionPromotionService().runPage(input);
  };
}

/**
 * Append the ONE unit that continues a conversion-promotion walk, or nothing when the walk is
 * done. At most one unit per completed page: the successor's cursor is the last id this page saw,
 * which the service filters EXCLUSIVELY (`id > cursor`), so no entity is promoted twice and none
 * is skipped.
 *
 * Appending is idempotent on the run — a replayed completion computes the same unit identity and
 * is collapsed — so a retried invocation cannot fork the walk into two tails.
 */
async function appendConversionPromotionContinuation(orchestration, runId, result) {
  const next = nextConversionPromotionUnit(result, { kind: UNIT_KINDS.CONVERSION_PROMOTION });
  if (!next) return { appended: 0 };
  return await orchestration.appendUnits(runId, [next]);
}

/**
 * The entity-promotion page entrypoint; overridable per app so the worker can be driven in tests.
 *
 * Phase 6c — a unit promotes exactly ONE page of ONE entity type. `runPage` is deliberate and
 * audited: the job's own `run()` drains every page of every requested type in a `while (true)`
 * loop and then fires the whole-sweep Rakuten commission hook, which is precisely the unbounded
 * stage a bounded unit exists to replace. Only the single-page entrypoint is reachable from here.
 */
function promotionPageFor(req) {
  const override = req?.app?.locals?.promotionPage;
  if (typeof override === "function") return override;
  return async (input) => {
    const { PromotionJob } = await import("../jobs/promotion.job.js");
    return new PromotionJob().runPage(input);
  };
}

/**
 * The Awin parent-materialization page entrypoint; overridable per app so the worker can be driven
 * in tests.
 *
 * `materializePage` is deliberate and audited: the service's own `materialize()` drains every page
 * in a `while (true)` loop, which is precisely the unbounded step a bounded unit exists to
 * replace. Only the single-page entrypoint is reachable from here, and neither calls a supplier.
 */
function awinParentMaterializationPageFor(req) {
  const override = req?.app?.locals?.awinParentMaterializationPage;
  if (typeof override === "function") return override;
  return async (input) => {
    const { materializeAwinAdvertiserParentPage } = await import(
      "../modules/supplier/services/awinAdvertiserParent.service.js"
    );
    return materializeAwinAdvertiserParentPage(input);
  };
}

/** Append the ONE unit that continues the Awin materialization walk, or nothing when it is done. */
async function appendAwinParentMaterializationContinuation(orchestration, runId, result) {
  const next = nextAwinParentMaterializationUnit(result, {
    kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION,
  });
  if (!next) return { appended: 0 };
  return await orchestration.appendUnits(runId, [next]);
}

/**
 * Append the ONE unit that continues a promotion walk, or nothing when this type's walk is done.
 *
 * At most one unit per completed page, and never one that crosses into another entity type: a
 * coupon needs its parent campaign promoted first, so moving from campaigns to coupons is the
 * parent gate's decision, not a page's.
 */
async function appendPromotionContinuation(orchestration, runId, result) {
  const next = nextPromotionUnit(result, { kind: UNIT_KINDS.PROMOTION });
  if (!next) return { appended: 0 };
  return await orchestration.appendUnits(runId, [next]);
}

/**
 * Run one unit. A network unit syncs one bounded account scope; an aggregation unit rebuilds one
 * day. Nothing here loops: a worker invocation is one unit.
 */
async function executeUnit(req, descriptor) {
  if (descriptor.kind === UNIT_KINDS.AGGREGATION) {
    return executeAggregationUnit(descriptor, { runRebuild: aggregationRebuildFor(req) });
  }
  if (descriptor.kind === UNIT_KINDS.CONVERSION_PROMOTION) {
    return executeConversionPromotionUnit(descriptor, { runPage: conversionPromotionPageFor(req) });
  }
  if (descriptor.kind === UNIT_KINDS.PROMOTION) {
    return executePromotionUnit(descriptor, { runPage: promotionPageFor(req) });
  }
  if (descriptor.kind === UNIT_KINDS.AWIN_PARENT_MATERIALIZATION) {
    return executeAwinParentMaterializationUnit(descriptor, {
      runPage: awinParentMaterializationPageFor(req),
    });
  }
  return accountSyncFor(req)(descriptor.platform, descriptor.accountLabel || undefined, {
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
    // A bounded catalog slice: the supplier's own offset/limit paging, so a retry re-requests
    // exactly the pages this unit named and nothing else.
    ...(descriptor.campaignPageOffset === null || descriptor.campaignPageOffset === undefined
      ? {}
      : {
          campaignPageOffset: descriptor.campaignPageOffset,
          campaignPageLimit: descriptor.campaignPageLimit,
          campaignPageBudget: descriptor.campaignPageBudget,
          ...(descriptor.campaignPageCarry === null || descriptor.campaignPageCarry === undefined
            ? {}
            : { campaignPageCarry: descriptor.campaignPageCarry }),
        }),
  });
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
    // A fast request can be satisfied by a broader non-fast run, because non-fast does everything
    // fast would and more. Say so rather than letting the caller read the 202 as "your fast run
    // is running": the run they were given refreshes catalogs their request would have skipped.
    const reusedBroaderRun = !run.created && Boolean(fastSync) && run.options?.fastSync === false;
    // A legacy run may still be active. The planner-version design lets this run be created and
    // worked beside it, and Phase 8C refuses to cancel a foreign-planner run, so it is reported
    // rather than blocked — two orchestration vocabularies on one estate should never be silent.
    const foreignPlannerRun = await orchestration.activeForeignPlannerRun();
    return res.status(202).json({
      ok: true,
      status: syncStatus?.status ?? "running",
      message: run.created
        ? "Full sync run created. Poll /sync/status for progress."
        : reusedBroaderRun
          ? "A broader non-fast run is already active; resuming that instead of starting a fast one."
          : "A matching full sync run is already active; resuming it.",
      runId: run.id,
      created: run.created,
      reusedBroaderRun,
      ...(foreignPlannerRun
        ? { foreignPlannerRunActive: { runId: foreignPlannerRun.id, plannerVersion: foreignPlannerRun.plannerVersion } }
        : {}),
      syncStatus,
    });
  } catch (error) {
    // Answered here rather than through formatSyncError, which carries code/statusCode/retryable
    // but not activeRunId — and the whole point of this refusal is telling the caller WHICH run
    // blocks them. Widening the generic formatter for one field would leak that concern into
    // every sync error.
    if (error?.code === "active_run_incompatible") {
      return res.status(409).json({
        ok: false,
        code: "active_run_incompatible",
        message:
          "Another sync run is already active and cannot satisfy this request. Wait for it to "
          + "finish, or cancel it explicitly with POST /api/sync/runs/:runId/cancel.",
        activeRunId: error.activeRunId ?? null,
      });
    }
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
/**
 * The platform/source pairs a scoped durable run may be created for.
 *
 * An allow-list rather than a free parameter. A durable run that plans one source object is a
 * certification instrument, not a general sync API: opening it to any platform and any string
 * would let a caller plan work nobody has reasoned about, beside an estate run, under one account
 * lock. Awin offers is here because it is the source that cannot complete in a single invocation
 * and therefore has to be certified page by page.
 */
export const SCOPED_DURABLE_SOURCES = Object.freeze({
  awin: Object.freeze(["offers"]),
});

/**
 * Create (or resume) a durable run containing ONLY one account's one source object.
 *
 * Everything here is the estate's own machinery, narrowed: planScopedSourceUnits filters the
 * SAME planAccountUnits output the full plan uses, so the unit descriptor is byte-identical to
 * the one /sync/all would have produced for this source; getOrCreateRun records it, dedupes it
 * and collapses racers exactly as it does for a full run; and the worker, the account lock, the
 * continuation planner and the post-sync gate are untouched.
 *
 * Only the FIRST page is planned. Pages 2..N are appended by materialiseFollowOnUnits from what
 * each completed unit reports, which is the property being certified — pre-creating 25 units
 * would test a queue rather than the resumable walk.
 *
 * promoteAfter is false and post-sync units are never included: a run that syncs one source
 * object has no business promoting the estate.
 */
export async function triggerScopedDurableSync(req, res, next) {
  try {
    const platform = String(req.params?.platform ?? "").trim().toLowerCase();
    const accountLabel = String(req.params?.accountLabel ?? "").trim() || "default";
    const sourceObject = String(req.query?.sourceObject ?? req.body?.sourceObject ?? "")
      .trim()
      .toLowerCase();

    const allowed = SCOPED_DURABLE_SOURCES[platform];
    if (!allowed) {
      return res.status(400).json({
        ok: false,
        code: "scoped_durable_platform_unsupported",
        message: `Scoped durable runs are not available for platform "${platform}".`,
        supported: Object.keys(SCOPED_DURABLE_SOURCES),
      });
    }
    if (!sourceObject) {
      return res.status(400).json({
        ok: false,
        code: "scoped_durable_source_required",
        message: "sourceObject is required.",
        supported: [...allowed],
      });
    }
    if (!allowed.includes(sourceObject)) {
      return res.status(400).json({
        ok: false,
        code: "scoped_durable_source_unsupported",
        message: `Scoped durable runs are not available for ${platform}/${sourceObject}.`,
        supported: [...allowed],
      });
    }

    const orchestration = orchestrationServiceFor(req);
    const units = planScopedSourceUnits({ platform, accountLabel, sourceObject }).map((unit) => ({
      kind: UNIT_KINDS.NETWORK,
      ...unit,
    }));
    if (!units.length) {
      // The audit does not bound this source, or it is deferred behind another. Either way there
      // is no unit to plan, and inventing one would put unaudited work on the estate.
      return res.status(409).json({
        ok: false,
        code: "scoped_durable_source_unplannable",
        message: `${platform}/${sourceObject} produced no bounded unit and cannot be run durably.`,
      });
    }

    const options = {
      fastSync: false,
      promoteAfter: false,
      // The reuse identity. Two requests for the same account and source share a run; a request
      // for anything else — including the whole estate — never adopts it.
      scopeKey: `${platform}:${accountLabel}:${sourceObject}`,
    };
    const run = await orchestration.getOrCreateRun({ kind: "full", trigger: "api", options, units });
    const syncStatus = await orchestration.describeRun(run.id);
    return res.status(202).json({
      ok: true,
      status: syncStatus?.status ?? "running",
      message: run.created
        ? `Durable ${platform}/${sourceObject} run created. Advance it with POST /api/sync/worker.`
        : `A matching durable ${platform}/${sourceObject} run is already active; resuming it.`,
      runId: run.id,
      created: run.created,
      plannerVersion: run.plannerVersion ?? null,
      scope: { platform, accountLabel, sourceObject },
      // Counts and descriptors only — never a supplier payload.
      plan: summarisePlan({ units }, { kind: "full", options }),
      syncStatus,
    });
  } catch (error) {
    if (error?.code === "active_run_incompatible") {
      return res.status(409).json({
        ok: false,
        code: "active_run_incompatible",
        message:
          "Another sync run is already active and cannot satisfy this request. Wait for it to "
          + "finish, or cancel it explicitly with POST /api/sync/runs/:runId/cancel.",
        activeRunId: error.activeRunId ?? null,
      });
    }
    next(formatSyncError(error));
  }
}

/**
 * The reuse identity of the Awin staged-offer backfill. One run at a time, and never adopted by
 * an unrelated request: an estate run carries no scopeKey, so it can neither reuse this nor be
 * reused by it.
 */
export const AWIN_BACKFILL_SCOPE_KEY = "awin-staged-offers-backfill";

/**
 * POST /api/sync/awin/backfill-staged-offers — start the durable Awin parent backfill.
 *
 * Awin's programmes endpoint returns nothing, so its campaign parents are derived from offers that
 * are ALREADY STAGED. Every mechanism to do that bounded exists — the materialization unit, its
 * continuations, the stage barrier and the planner's support for an explicitly seeded run — and
 * this is the one thing that was missing: a way to start it.
 *
 * It creates a run with exactly ONE unit and stops. No network unit is planned, so no supplier is
 * contacted, nothing is refetched, and the 5,011 offers already on disk are the entire input. The
 * existing orchestration then owns everything after: materialization pages continue themselves,
 * the barrier opens the campaign walk when they resolve, the campaign walk opens the coupon walk,
 * and conversion promotion and aggregation follow as they always do.
 *
 * Advancing it is the worker's job, one unit per invocation, exactly as for any other durable run.
 * Nothing here loops, and nothing here writes a JobRun outside SyncOrchestrationService.
 */
export async function triggerAwinStagedOfferBackfill(req, res, next) {
  try {
    const orchestration = orchestrationServiceFor(req);

    // Exactly one, and a first page: cursorId null is the start of the walk, and pageSize is the
    // unit's own fixed width rather than anything a caller may choose.
    const units = [
      {
        kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION,
        networkSource: AWIN_MATERIALIZATION_NETWORK_SOURCE,
        cursorId: null,
        pageSize: AWIN_MATERIALIZATION_PAGE_SIZE,
        options: {},
      },
    ];

    const options = {
      fastSync: false,
      // The barrier and every downstream walk live in post-sync. Without this the run would
      // materialize parents and then stop before promoting anything.
      promoteAfter: true,
      scopeKey: AWIN_BACKFILL_SCOPE_KEY,
    };

    const run = await orchestration.getOrCreateRun({ kind: "full", trigger: "api", options, units });
    const syncStatus = await orchestration.describeRun(run.id);

    return res.status(202).json({
      ok: true,
      status: syncStatus?.status ?? "running",
      message: run.created
        ? "Durable Awin parent backfill created from staged offers. No supplier fetch was started. "
          + "Advance it with POST /api/sync/worker."
        : "An Awin parent backfill is already active; resuming it. No supplier fetch was started.",
      runId: run.id,
      created: Boolean(run.created),
      reused: !run.created,
      plannerVersion: run.plannerVersion ?? null,
      scope: { networkSource: AWIN_MATERIALIZATION_NETWORK_SOURCE, scopeKey: AWIN_BACKFILL_SCOPE_KEY },
      // Counts and a page width only — never an entity id or a supplier payload.
      plan: {
        initialUnits: units.length,
        unitKind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION,
        networkUnits: 0,
        supplierFetch: false,
        pageSize: AWIN_MATERIALIZATION_PAGE_SIZE,
      },
      syncStatus,
    });
  } catch (error) {
    if (error?.code === "active_run_incompatible") {
      return res.status(409).json({
        ok: false,
        code: "active_run_incompatible",
        message:
          "Another sync run is already active and cannot satisfy this request. Wait for it to "
          + "finish, or cancel it explicitly with POST /api/sync/runs/:runId/cancel.",
        activeRunId: error.activeRunId ?? null,
      });
    }
    next(formatSyncError(error));
  }
}

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
    // The canary used to rely on runExclusiveSync alone, which guards on module memory and is
    // therefore per-instance and worthless across serverless invocations: a live canary could stage
    // Boostiny campaigns with no durable exclusion at all. It now takes the SAME account lock key
    // and lease as the worker unit and the manual route, so all three exclude each other. A dry run
    // takes it too: it is cheap, and it keeps one rule rather than two.
    const lockKey = accountLockKey({ platform: "boostiny", accountLabel });
    const locks = accountLocksFor(req);
    const outcome = await locks.withLock(
      lockKey,
      () =>
        runExclusiveSync(
          jobName,
          () =>
            syncPlatformAccount("boostiny", accountLabel, {
              fastSync: false,
              promoteAfter: false,
              sourceObject: "campaigns",
              canary,
            }),
          { trigger: "api" },
        ),
      { holderId: jobName },
    );
    if (!outcome.ran) {
      return res.status(409).json({
        ok: false,
        status: "locked",
        message: "Another sync holds this Boostiny account; the canary did not run.",
        reason: outcome.reason,
        lock: { key: lockKey, heldBy: outcome.heldBy ?? null },
      });
    }
    const run = outcome.result;
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
 * unit (which verifies the shared durable account lock), await exactly one bounded piece of work,
 * record the outcome and refresh the parent. No loop, no recursion, no background promise. A unit
 * is one account scope, one aggregation day, one conversion-promotion page, or one entity
 * promotion page of one type. Being executable is not being ordered: the post-sync stages still
 * depend on each other, and the parent transition gate owns that. Call it again to advance the
 * next unit.
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

    const isAggregation = descriptor.kind === UNIT_KINDS.AGGREGATION;
    const isConversionPromotion = descriptor.kind === UNIT_KINDS.CONVERSION_PROMOTION;
    const isPromotion = descriptor.kind === UNIT_KINDS.PROMOTION;
    const isAwinMaterialization = descriptor.kind === UNIT_KINDS.AWIN_PARENT_MATERIALIZATION;
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
      // The calendar day an aggregation unit rebuilds; null for every other kind.
      day: descriptor.day ?? null,
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
      // Which network and entity type this promotion page walks, and whether it continues one.
      // Never the cursor id itself, which is an entity identifier and stays in the unit payload.
      promotionPage: isPromotion
        ? {
            networkSource: descriptor.networkSource ?? null,
            entityType: descriptor.entityType ?? null,
            pageSize: descriptor.pageSize ?? PROMOTION_PAGE_SIZE,
            continued: Boolean(descriptor.cursorId),
          }
        : null,
      // Whether this page continues the Awin materialization walk, and how wide it is. Counts and
      // a page size only — never the cursor id, which is an entity identifier.
      materializationPage: isAwinMaterialization
        ? {
            networkSource: descriptor.networkSource ?? null,
            pageSize: descriptor.pageSize ?? AWIN_MATERIALIZATION_PAGE_SIZE,
            continued: Boolean(descriptor.cursorId),
          }
        : null,
      // Which network's walk and whether this page continues one; never the cursor id itself,
      // which is an entity identifier and stays in the unit payload.
      conversionPage: isConversionPromotion
        ? {
            networkSource: descriptor.networkSource ?? null,
            pageSize: descriptor.pageSize ?? CONVERSION_PROMOTION_PAGE_SIZE,
            continued: Boolean(descriptor.cursorId),
          }
        : null,
      // Offsets and counts only; never a supplier row.
      campaignPage:
        descriptor.campaignPageOffset === null || descriptor.campaignPageOffset === undefined
          ? null
          : {
              index: descriptor.campaignPageIndex ?? null,
              offset: descriptor.campaignPageOffset,
              limit: descriptor.campaignPageLimit ?? null,
              pages: descriptor.campaignPageBudget ?? null,
            },
    };

    let result;
    try {
      result = await executeUnit(req, descriptor);
    } catch (error) {
      // A staging freeze belongs to ANOTHER run's post-sync phase. It is temporary and this unit
      // did nothing wrong, so the claim is handed back without consuming an attempt; three of these
      // must never dead-letter work that would succeed once the walk finishes.
      if (isStagingFrozenError(error)) {
        const deferred = await orchestration.deferUnit(unit.id, { reason: error.code, workerId });
        const syncStatus = await orchestration.describeRun(run.id);
        return res.status(200).json({
          ok: true,
          worked: false,
          status: "unit_deferred",
          message: "Entity staging is frozen by an active post-sync phase; the unit was returned unworked.",
          reason: error.code,
          runId: run.id,
          unit: { ...unitView, status: deferred?.status ?? "PENDING", attempt: deferred?.attempt ?? null },
          syncStatus,
        });
      }
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
    // An aggregation unit is one day and has no continuation: there is nothing to materialise,
    // and walking to an adjacent day is exactly what a bounded unit must not do.
    //
    // A conversion-promotion unit continues the SAME walk: if its page was full it appends
    // exactly one successor, carrying the last id it saw as an exclusive cursor. One unit, never
    // a second page in this invocation, and never a successor repeating this unit's own cursor.
    const followOn = isAggregation
      ? { appended: 0 }
      : isConversionPromotion
        ? await appendConversionPromotionContinuation(orchestration, run.id, result)
        : isPromotion
          ? await appendPromotionContinuation(orchestration, run.id, result)
          : isAwinMaterialization
            ? await appendAwinParentMaterializationContinuation(orchestration, run.id, result)
            : await orchestration.materialiseFollowOnUnits(run.id, descriptor, result, {
                completingUnitId: unit.id,
              });
    await orchestration.completeUnit(
      unit.id,
      isAggregation
        ? summariseAggregationUnitOutcome(result)
        : isConversionPromotion
          ? summariseConversionPromotionUnitOutcome(result)
          : isPromotion
            ? summarisePromotionUnitOutcome(result)
            : isAwinMaterialization
              ? summariseAwinParentMaterializationUnitOutcome(result)
              : summariseSyncUnitOutcome(result, { accountLabel: descriptor.accountLabel }),
    );
    // Phase 6d — completing this unit may have settled a whole stage. The gate opens the next one
    // if and only if the rows say every dependency is finished; it appends nothing otherwise, and
    // it never advances past a failure. Running it AFTER completion is what makes "the last unit
    // of a stage" observable at all.
    const staged = await orchestration.advancePostSync(run.id);
    const syncStatus = await orchestration.describeRun(run.id);
    return res.status(200).json({
      ok: true,
      worked: true,
      status: "unit_completed",
      message: "One sync unit completed.",
      runId: run.id,
      unit: { ...unitView, status: "COMPLETED" },
      ...(followOn?.appended ? { unitsMaterialised: followOn.appended } : {}),
      // Which post-sync stage this completion opened, and how many first pages or days it seeded.
      // Counts and a stage name only — never a network's data.
      ...(staged?.appended ? { postSyncStaged: { stage: staged.stage, units: staged.appended } } : {}),
      syncStatus,
    });
  } catch (error) {
    next(formatSyncError(error));
  }
}

/**
 * Administratively stop a durable run.
 *
 * STOPS FUTURE ORCHESTRATION ONLY. Supplier, staging and promotion work that already committed is
 * not rolled back and no attempt is made to unwind it — a cancelled run is stopped, not undone.
 *
 * Eventual, not instantaneous: units a worker is currently running are left RUNNING and expire by
 * lease, so `unitsLeftRunning` is reported rather than implying a dead stop. The worker is
 * contained meanwhile — it cannot complete or fail its unit, append follow-on units, or advance a
 * post-sync stage under a cancelled parent.
 *
 * Current planner only, by design: a foreign-planner run may be executing under code that predates
 * those guards, so cancelling it is not proven safe and it is refused untouched.
 */
export async function cancelSyncRunHandler(req, res, next) {
  try {
    const runId = typeof req.params?.runId === "string" ? req.params.runId.trim() : "";
    if (!runId) {
      return res.status(404).json({ ok: false, code: "run_not_found", message: "No run id was supplied." });
    }
    const orchestration = orchestrationServiceFor(req);
    const actor = req.user?.id ?? null;
    const outcome = await orchestration.cancelRun(runId, { reason: ADMIN_CANCELLED_REASON, actor });

    if (outcome.code === "run_not_found") {
      return res.status(404).json({ ok: false, code: "run_not_found", message: "No orchestration run with that id." });
    }
    if (outcome.code === "run_foreign_planner_version") {
      return res.status(409).json({
        ok: false,
        code: "run_foreign_planner_version",
        message: "That run was planned by a different planner version and was left untouched.",
        runId,
      });
    }
    // Idempotent: cancelling an already-terminal run is a success, not an error.
    if (outcome.code === "run_already_terminal") {
      const syncStatus = await orchestration.describeRun(runId);
      return res.status(200).json({
        ok: true,
        code: "run_already_terminal",
        message: "That run had already finished; nothing was changed.",
        runId,
        status: syncStatus?.status ?? null,
        cancelledAt: syncStatus?.cancellation?.cancelledAt ?? null,
        unitsCancelled: 0,
        unitsLeftRunning: 0,
        syncStatus,
      });
    }

    const syncStatus = await orchestration.describeRun(runId);
    return res.status(200).json({
      ok: true,
      code: "run_cancelled",
      message:
        "The run is cancelled: no further units will be planned or executed. Work already committed "
        + "to suppliers, staging or promotion is NOT rolled back. Units still running finish or "
        + "expire by lease.",
      runId,
      status: syncStatus?.status ?? "cancelled",
      cancelledAt: outcome.cancelledAt ?? null,
      unitsCancelled: outcome.unitsCancelled ?? 0,
      unitsLeftRunning: outcome.unitsLeftRunning ?? 0,
      syncStatus,
    });
  } catch (error) {
    next(formatSyncError(error));
  }
}

/** The refusal code this route answers with. Exported so callers and tests pin the same string. */
export const LEGACY_INCREMENTAL_RETIRED_CODE = "legacy_incremental_retired";

/**
 * Retired. This route used to hand its work to the in-process scheduler's launcher and answer 202
 * immediately, which made it the one fire-and-forget sync path reachable in production: the
 * serverless invocation could be frozen or reclaimed the moment after the response was written,
 * mid-run, leaving partial supplier writes and no durable record of what had been done.
 *
 * 410 rather than a removal or a 404. The route stays registered behind its existing auth chain so
 * a caller learns the endpoint is gone on purpose instead of reading a missing path as a typo, and
 * the audit entry is still written.
 *
 * Deliberately NOT an internal redirect to a durable incremental run. The planner already knows
 * the "incremental" kind, but kind takes part in run-reuse compatibility, so an incremental
 * request would not fold into an active full run — two active parent runs could coexist and
 * contend for account locks. That is a decision about run identity, and it does not belong in a
 * retirement patch.
 */
export async function triggerIncrementalSync(_req, res) {
  return res.status(410).json({
    ok: false,
    code: LEGACY_INCREMENTAL_RETIRED_CODE,
    message:
      "This endpoint is retired. Incremental work now runs through durable orchestration: "
      + "POST /api/sync/all plans a run, and each unit is advanced by POST /api/sync/worker.",
  });
}
