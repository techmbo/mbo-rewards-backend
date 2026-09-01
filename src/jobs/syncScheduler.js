import {
  ENABLE_SCHEDULER,
  SYNC_INTERVAL_MINUTES,
  SYNC_SCHEDULER_INITIAL_DELAY_MS,
} from "./syncConfig.js";
import { syncAll } from "./sync.job.js";
import { getSyncStatus, isSyncRunning, runSyncInBackground } from "./syncState.js";
import { logger } from "../platform/logging/logger.js";

let timer = null;
let initialTimer = null;
let startedAt = null;
let lastAttemptAt = null;
let lastSkipReason = null;

function intervalMs() {
  return Math.max(1, SYNC_INTERVAL_MINUTES) * 60 * 1000;
}

/**
 * Trigger an incremental (fast) supplier sync if none is already running.
 * Skips quietly when a sync is in progress — no duplicate fetch.
 */
export function triggerScheduledSync({ reason = "interval" } = {}) {
  lastAttemptAt = new Date().toISOString();

  if (isSyncRunning()) {
    lastSkipReason = "A sync is already in progress";
    logger.info({ reason, skipReason: lastSkipReason }, "scheduled sync skipped");
    return { started: false, reason: lastSkipReason, status: getSyncStatus() };
  }

  lastSkipReason = null;
  logger.info({ reason, intervalMinutes: SYNC_INTERVAL_MINUTES }, "scheduled supplier sync starting");

  return runSyncInBackground(
    "scheduledSyncAll",
    () =>
      syncAll({
        // Incremental: date windows from lastSuccessfulSync; campaigns/coupons only if TTL expired
        fastSync: true,
        promoteAfter: true,
      }),
    { trigger: "scheduler" },
  );
}

export function getSchedulerStatus() {
  return {
    enabled: ENABLE_SCHEDULER,
    running: Boolean(timer || initialTimer),
    startedAt,
    intervalMinutes: SYNC_INTERVAL_MINUTES,
    initialDelayMs: SYNC_SCHEDULER_INITIAL_DELAY_MS,
    lastAttemptAt,
    lastSkipReason,
    syncStatus: getSyncStatus().status,
  };
}

export function startSyncScheduler() {
  if (!ENABLE_SCHEDULER) {
    logger.info("supplier sync scheduler disabled (ENABLE_SCHEDULER=false)");
    return getSchedulerStatus();
  }

  if (timer || initialTimer) {
    return getSchedulerStatus();
  }

  startedAt = new Date().toISOString();
  const delay = Math.max(0, SYNC_SCHEDULER_INITIAL_DELAY_MS);
  const every = intervalMs();

  logger.info(
    {
      initialDelayMs: delay,
      intervalMinutes: SYNC_INTERVAL_MINUTES,
      intervalMs: every,
    },
    "supplier sync scheduler enabled",
  );

  initialTimer = setTimeout(() => {
    initialTimer = null;
    triggerScheduledSync({ reason: "startup" });
    timer = setInterval(() => {
      triggerScheduledSync({ reason: "interval" });
    }, every);
    if (typeof timer.unref === "function") timer.unref();
  }, delay);

  if (typeof initialTimer.unref === "function") initialTimer.unref();

  return getSchedulerStatus();
}

export function stopSyncScheduler() {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  startedAt = null;
  return getSchedulerStatus();
}
