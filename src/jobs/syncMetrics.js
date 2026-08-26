/**
 * Phase 11 — detailed timing instrumentation for sync jobs.
 * Timings are attached to SyncJobLog.metadata and in-memory sync status.
 */

export function createSyncTimer() {
  const starts = new Map();
  const durations = {};

  return {
    start(label) {
      starts.set(label, Date.now());
    },
    end(label) {
      const startedAt = starts.get(label);
      if (startedAt != null) {
        durations[label] = Date.now() - startedAt;
        starts.delete(label);
      }
    },
    add(label, durationMs) {
      durations[label] = (durations[label] || 0) + durationMs;
    },
    get(label) {
      return durations[label] ?? 0;
    },
    toObject() {
      return { ...durations };
    },
  };
}

export function mergeTimings(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "number") {
        merged[key] = (merged[key] || 0) + value;
      }
    }
  }
  return merged;
}
