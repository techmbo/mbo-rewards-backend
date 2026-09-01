import { syncAll, syncPlatformAccount } from "../jobs/sync.job.js";
import { formatSyncError } from "../jobs/syncErrors.js";
import { getSyncStatus, runSyncInBackground } from "../jobs/syncState.js";
import { getSchedulerStatus, triggerScheduledSync } from "../jobs/syncScheduler.js";

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

function startBackgroundSync(jobName, syncFn, res, { trigger = "api" } = {}) {
  const launch = runSyncInBackground(jobName, syncFn, { trigger });
  if (!launch.started) {
    return res.status(202).json({
      ok: true,
      status: "running",
      message: launch.reason,
      syncStatus: launch.status,
    });
  }

  return res.status(202).json({
    ok: true,
    status: "running",
    message: "Sync started in background. Poll /sync/status for progress.",
    syncStatus: launch.status,
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

export async function triggerSyncAll(req, res) {
  // Manual sync refreshes campaigns/coupons by default; pass ?fast=true for incremental-only.
  const fastSync = parseBoolQuery(req.query?.fast, false);
  return startBackgroundSync(
    "syncAll",
    () => syncAll({ fastSync, promoteAfter: true }),
    res,
    { trigger: "api" },
  );
}

export async function triggerSyncPlatform(req, res, next) {
  try {
    const { platform, accountLabel } = req.params;
    if (!SUPPORTED_SYNC_PLATFORMS.has(platform)) {
      return res.status(400).json({ ok: false, message: `Unsupported platform: ${platform}` });
    }

    const fastSync = parseBoolQuery(req.query?.fast, false);
    const sourceObject =
      req.query?.sourceObject || req.query?.source_object || undefined;
    const jobName = accountLabel
      ? `sync:${platform}:${accountLabel}${sourceObject ? `:${sourceObject}` : ""}`
      : `sync:${platform}${sourceObject ? `:${sourceObject}` : ""}`;
    return startBackgroundSync(
      jobName,
      () =>
        syncPlatformAccount(platform, accountLabel || undefined, {
          fastSync,
          promoteAfter: true,
          sourceObject: sourceObject || undefined,
        }),
      res,
      { trigger: "api" },
    );
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
