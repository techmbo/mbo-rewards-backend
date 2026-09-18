/**
 * The in-process sync scheduler, retired.
 *
 * This module used to hold a setTimeout/setInterval pair that called syncAll through the
 * fire-and-forget launcher every six hours. That was never reachable on Vercel — the serverless
 * entry is src/app.js, so no process lived long enough for the interval to fire — but it armed
 * itself on any long-running host, and it armed itself ONCE PER INSTANCE. Its only exclusion
 * guard was `isSyncRunning()`, which reads module memory, so three instances behind a load
 * balancer would have meant three independent schedulers with nothing between them. The same
 * reasoning is already written down in syncAccountLock.service.js.
 *
 * Scheduling now lives outside the process entirely: GitHub Actions calls the machine-authed
 * /api/internal/cron routes today, and AWS EventBridge will take that role for production. Both
 * drive the durable planner/worker, where a run is rows in JobRun and every unit is bounded,
 * attempt-limited and resumable.
 *
 * What remains here is a status descriptor and nothing else. This module starts no work, imports
 * neither the monolithic job nor the background launcher, and holds no timer. It exists so that
 * /health and the network ops projection keep the field shape they already read, rather than
 * being rewritten inside a phase whose subject is sync.
 */
import { getSyncStatus } from "./syncState.js";

/** Marks this module as the retired scheduler, for anything that wants to assert on it. */
export const LEGACY_SCHEDULER_RETIRED = true;

/**
 * A static retired descriptor.
 *
 * Every key the previous implementation returned is still present, so /health (enabled, running,
 * intervalMinutes) and networkOps (enabled, intervalMinutes, lastAttemptAt) read what they always
 * read. The interval fields are null rather than numbers because there is no interval to report;
 * a stale 360 would describe a cadence that nothing runs at.
 *
 * `syncStatus` stays live: it reads the in-memory block, which the manual per-network route and
 * the operator CLI still populate.
 */
export function getSchedulerStatus() {
  return {
    enabled: false,
    retired: true,
    running: false,
    startedAt: null,
    intervalMinutes: null,
    initialDelayMs: null,
    lastAttemptAt: null,
    lastSkipReason: "The in-process scheduler is retired; scheduling is external.",
    syncStatus: getSyncStatus().status,
  };
}
