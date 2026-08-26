/**
 * Centralized sync optimization configuration (env-driven).
 * Defaults preserve backward compatibility when vars are unset.
 */

function readBool(name, defaultValue = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === "true" || raw === "1" || raw === "yes";
}

function readInt(name, defaultValue) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

/** Phase 2 — parallel account sync limit */
export const SYNC_ACCOUNT_CONCURRENCY = readInt("SYNC_ACCOUNT_CONCURRENCY", 3);

/** Phase 7 — parallel DB upsert workers (raised default for throughput) */
export const SYNC_UPSERT_CONCURRENCY = readInt("SYNC_UPSERT_CONCURRENCY", 50);

/** Phase 6 — chunk size for batched field-registry writes */
export const SYNC_UPSERT_CHUNK_SIZE = readInt("SYNC_UPSERT_CHUNK_SIZE", 100);

/** Phase 5 — skip static resource re-fetch when synced within this window */
export const CAMPAIGN_REFRESH_HOURS = readInt("CAMPAIGN_REFRESH_HOURS", 24);
export const COUPON_REFRESH_HOURS = readInt("COUPON_REFRESH_HOURS", 24);

/**
 * Phase 10 — delta-only mode:
 * - Skips campaign/coupon API re-fetch unless cache TTL expired
 * - Date-windowed resources still use lastSuccessfulSync (with overlap)
 * Scheduled auto-fetch always runs in fast mode regardless of this flag.
 */
export const FAST_SYNC = readBool("FAST_SYNC", false);

/** Default historical lookback when no incremental timestamp exists */
export const DEFAULT_DAYS_BACK = 180;

/**
 * Days to re-fetch before lastSuccessfulSync to catch late-arriving conversions.
 * Does not re-pull the full historical window — only a small overlap.
 */
export const SYNC_OVERLAP_DAYS = readInt("SYNC_OVERLAP_DAYS", 2);

/** Enable in-process auto-fetch scheduler (default true outside tests). */
export const ENABLE_SCHEDULER = readBool(
  "ENABLE_SCHEDULER",
  process.env.NODE_ENV !== "test",
);

/** Auto-fetch interval in minutes (default 360 = 6 hours). */
export const SYNC_INTERVAL_MINUTES = readInt("SYNC_INTERVAL_MINUTES", 360);

/** Delay before the first scheduled sync after server start (default 2 minutes). */
export const SYNC_SCHEDULER_INITIAL_DELAY_MS = readInt("SYNC_SCHEDULER_INITIAL_DELAY_MS", 120_000);

/** After successful sync + promotion, rebuild DailyReport for this many trailing days. */
export const AGGREGATION_AFTER_SYNC_DAYS = readInt("AGGREGATION_AFTER_SYNC_DAYS", 14);

/** After a successful (or partial) network sync, promote raw entities into supplier tables. */
export const AUTO_PROMOTE_AFTER_SYNC = readBool("AUTO_PROMOTE_AFTER_SYNC", true);

/** After conversion promotion, run DailyReport aggregation for the trailing window. */
export const AUTO_AGGREGATE_AFTER_SYNC = readBool("AUTO_AGGREGATE_AFTER_SYNC", true);
