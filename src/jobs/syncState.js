import { getSyncErrorMessage, joinUserMessages } from "./syncErrors.js";

let activeSync = null;
let activeSyncPromise = null;

function collectWarnings(result, warnings = []) {
  if (!result || typeof result !== "object") return warnings;
  if (Array.isArray(result.warnings)) {
    warnings.push(...result.warnings.filter(Boolean));
  }
  for (const value of Object.values(result)) {
    collectWarnings(value, warnings);
  }
  return warnings;
}

function hasPartialSuccess(result) {
  if (!result || typeof result !== "object") return false;
  if (result.partialSuccess) return true;
  return Object.values(result).some((value) => hasPartialSuccess(value));
}

function defaultProgress() {
  return {
    totalAccounts: 0,
    completedAccounts: 0,
    failedAccounts: 0,
    currentStage: null,
    percentComplete: 0,
  };
}

export function isSyncRunning() {
  return activeSync?.status === "running";
}

/**
 * Phase 9 — optional progress fields (additive; existing status shape preserved).
 */
export function initSyncProgress({ totalAccounts = 0, currentStage = null } = {}) {
  if (!activeSync) return;
  activeSync.progress = {
    totalAccounts,
    completedAccounts: 0,
    failedAccounts: 0,
    currentStage,
    percentComplete: totalAccounts > 0 ? 0 : 0,
  };
}

export function setSyncStage(currentStage) {
  if (!activeSync?.progress) return;
  activeSync.progress.currentStage = currentStage;
}

export function recordAccountSyncComplete({ success }) {
  if (!activeSync?.progress) return;
  activeSync.progress.completedAccounts += 1;
  if (!success) {
    activeSync.progress.failedAccounts += 1;
  }
  const { totalAccounts, completedAccounts } = activeSync.progress;
  activeSync.progress.percentComplete =
    totalAccounts > 0 ? Math.min(100, Math.round((completedAccounts / totalAccounts) * 100)) : 0;
}

export function getSyncStatus() {
  if (!activeSync) {
    return { status: "idle" };
  }

  const payload = {
    status: activeSync.status,
    jobName: activeSync.jobName,
    startedAt: activeSync.startedAt,
    finishedAt: activeSync.finishedAt,
    result: activeSync.result,
    warning: activeSync.warning,
    error: activeSync.error,
    trigger: activeSync.trigger || null,
  };

  // Phase 9 — additive progress fields only when a sync is/was active
  if (activeSync.progress) {
    payload.totalAccounts = activeSync.progress.totalAccounts;
    payload.completedAccounts = activeSync.progress.completedAccounts;
    payload.failedAccounts = activeSync.progress.failedAccounts;
    payload.currentStage = activeSync.progress.currentStage;
    payload.percentComplete = activeSync.progress.percentComplete;
  }

  if (activeSync.timings) {
    payload.timings = activeSync.timings;
  }

  return payload;
}

export function setSyncTimings(timings) {
  if (!activeSync) return;
  activeSync.timings = timings;
}

function beginSyncSlot(jobName, { trigger = "api" } = {}) {
  if (activeSync?.status === "running") {
    return { acquired: false, reason: "A sync is already in progress", status: getSyncStatus() };
  }

  activeSync = {
    jobName,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    warning: null,
    error: null,
    progress: defaultProgress(),
    timings: null,
    trigger,
  };

  return { acquired: true, status: getSyncStatus() };
}

function finishSyncSlot(result) {
  const warnings = collectWarnings(result);
  activeSync = {
    ...activeSync,
    status: hasPartialSuccess(result) ? "partial" : "success",
    finishedAt: new Date().toISOString(),
    result,
    warning: warnings.length > 0 ? joinUserMessages(warnings) : null,
  };
  if (activeSync.progress) {
    activeSync.progress.percentComplete = 100;
  }
}

function failSyncSlot(error) {
  activeSync = {
    ...activeSync,
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: getSyncErrorMessage(error),
  };
}

/**
 * Run sync exclusively (blocks overlapping API/CLI/scheduler runs in this process).
 * Returns { started:false } when another sync is already running.
 */
export async function runExclusiveSync(jobName, syncFn, { trigger = "api" } = {}) {
  const slot = beginSyncSlot(jobName, { trigger });
  if (!slot.acquired) {
    return { started: false, reason: slot.reason, status: slot.status };
  }

  const promise = (async () => {
    try {
      const result = await syncFn();
      finishSyncSlot(result);
      return result;
    } catch (error) {
      failSyncSlot(error);
      throw error;
    } finally {
      activeSyncPromise = null;
    }
  })();

  activeSyncPromise = promise;

  try {
    const result = await promise;
    return { started: true, result, status: getSyncStatus() };
  } catch (error) {
    return { started: true, error, status: getSyncStatus() };
  }
}

export function runSyncInBackground(jobName, syncFn, { trigger = "api" } = {}) {
  if (activeSync?.status === "running") {
    return { started: false, reason: "A sync is already in progress", status: getSyncStatus() };
  }

  const slot = beginSyncSlot(jobName, { trigger });
  if (!slot.acquired) {
    return { started: false, reason: slot.reason, status: slot.status };
  }

  const promise = (async () => {
    try {
      const result = await syncFn();
      finishSyncSlot(result);
      return result;
    } catch (error) {
      failSyncSlot(error);
      throw error;
    } finally {
      activeSyncPromise = null;
    }
  })();

  activeSyncPromise = promise;
  // Fire-and-forget; status is polled via getSyncStatus
  promise.catch(() => {});

  return { started: true, status: getSyncStatus() };
}

export function getActiveSyncPromise() {
  return activeSyncPromise;
}
