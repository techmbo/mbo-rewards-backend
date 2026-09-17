/**
 * The internal scheduler entrypoints.
 *
 * Phase 7 drives the durable orchestration from GitHub Actions rather than from a person running
 * curl. These two routes are what the scheduler calls. They are deliberately thin: the drain
 * DELEGATES to the same worker handler `/api/sync/worker` uses, so there is exactly one
 * implementation of "execute one unit" and the two routes can never drift apart.
 *
 * The scheduling itself lives in the scheduler. Nothing here loops, retries, sleeps, or decides
 * when to run again — one request performs one bounded action and returns. A loop inside a
 * serverless invocation is precisely what the whole of Phase 6 exists to avoid.
 */

import { PLANNER_VERSION } from "../jobs/syncOrchestration.service.js";
import { formatSyncError } from "../jobs/syncErrors.js";
import { orchestrationServiceFor, triggerSyncWorker } from "./sync.controller.js";

/**
 * POST /api/internal/cron/sync-start — create the daily full run, or report the active one.
 *
 * One bounded action: plan and enqueue. It executes NO unit, so a scheduler that calls this every
 * day cannot accidentally do supplier work inside the request.
 *
 * It is idempotent by construction. `getOrCreateRun` reuses an active run whose planner version
 * and execution options match, and collapses a concurrent duplicate, so a retried or doubled
 * scheduler tick converges on one run rather than creating a second.
 *
 * The response is the scheduler's whole contract: counts and identifiers only, never the durable
 * run projection, so no account label, campaign identifier or supplier payload can leave here.
 */
export async function cronSyncStartHandler(req, res, next) {
  try {
    // The same shape `/api/sync/all` enqueues: a full run that also asks for post-sync promotion.
    // Post-sync stays deferred until its bounded units exist, exactly as before.
    const orchestration = orchestrationServiceFor(req);
    const run = await orchestration.getOrCreateRun({
      kind: "full",
      trigger: "scheduler",
      options: { fastSync: false, promoteAfter: true },
    });
    return res.status(202).json({
      ok: true,
      runId: run.id,
      created: Boolean(run.created),
      reused: !run.created,
      status: run.created ? "created" : "reused",
      plannerVersion: PLANNER_VERSION,
    });
  } catch (error) {
    next(formatSyncError(error));
  }
}

/**
 * POST /api/internal/cron/sync-drain — advance the durable run by EXACTLY ONE unit.
 *
 * This is `triggerSyncWorker` itself, not a copy of it. Every guarantee that route carries is
 * therefore carried here unchanged: one claim, one unit, the shared account and stage locks, the
 * lease and stale-claim handling, the staging-freeze deferral that consumes no attempt, and the
 * post-sync gate that opens the next stage only when the rows allow it.
 *
 * It also means the outcome vocabulary is identical — idle, unit_completed, unit_deferred,
 * unit_retry, unit_failed, unit_abandoned and busy — which is what the scheduler branches on.
 */
export async function cronSyncDrainHandler(req, res, next) {
  return triggerSyncWorker(req, res, next);
}
