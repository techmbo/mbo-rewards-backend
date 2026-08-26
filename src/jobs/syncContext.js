import { AsyncLocalStorage } from "node:async_hooks";
import { FAST_SYNC } from "./syncConfig.js";

const store = new AsyncLocalStorage();

/**
 * Run a sync with per-run options (e.g. scheduled fast/incremental sync)
 * without mutating process-wide env.
 */
export function runWithSyncOptions(options, fn) {
  return store.run({ ...(options || {}) }, fn);
}

export function getSyncOptions() {
  return store.getStore() || {};
}

/** Prefer explicit per-run override; fall back to FAST_SYNC env. */
export function isFastSyncEnabled() {
  const options = getSyncOptions();
  if (typeof options.fastSync === "boolean") return options.fastSync;
  return FAST_SYNC;
}

export function shouldPromoteAfterSync() {
  const options = getSyncOptions();
  if (typeof options.promoteAfter === "boolean") return options.promoteAfter;
  return null;
}
