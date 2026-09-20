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

/**
 * The explicit date window a bounded orchestration unit was planned with, as inclusive ISO days,
 * or null when the caller did not supply one (manual routes, the scheduler, the canary).
 *
 * Fail-closed on purpose: a half-supplied window is a planning bug, and quietly falling back to
 * the network's own 180-day lookback would silently widen a unit that was supposed to be bounded.
 */
export function explicitSyncWindow() {
  const { windowStart, windowEnd } = getSyncOptions();
  const start = normalizeWindowDay(windowStart);
  const end = normalizeWindowDay(windowEnd);
  if (!start && !end) return null;
  if (!start || !end) {
    throw new Error("Bounded sync window requires both windowStart and windowEnd");
  }
  if (start > end) {
    throw new Error("Bounded sync window ends before it starts");
  }
  return { start, end };
}

function normalizeWindowDay(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("Bounded sync window carries an unparseable date");
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Source objects that ride along with the requested one because they are DERIVED from the same
 * fetch (Impact `reports` from actions, Partnerize `analytics` from conversions). Supplied only by
 * the bounded planner; a manual `?sourceObject=` request never sets it, so its behaviour is
 * unchanged.
 */
export function sourceObjectCompanions() {
  const value = getSyncOptions().sourceObjectCompanions;
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
}

/**
 * The campaign ids a bounded commission-group unit was planned with, or null when the caller
 * supplied none (manual routes, the scheduler, an old account-wide unit). A unit that carries
 * ids fetches exactly those campaigns and no others.
 */
export function boundedCampaignIds() {
  const value = getSyncOptions().campaignIds;
  if (!Array.isArray(value)) return null;
  const ids = value.map((id) => String(id ?? "").trim()).filter(Boolean);
  return ids.length ? ids : null;
}

/**
 * The slice of the Optimise campaign catalog a bounded unit was planned with, or null when the
 * caller supplied none (a manual sync, the scheduler, a pre-6 unit). Offsets are the supplier's
 * own offset/limit paging, so a retry re-requests exactly the same pages.
 */
export function boundedCampaignPage() {
  const { campaignPageOffset, campaignPageLimit, campaignPageBudget, campaignPageCarry } =
    getSyncOptions();
  if (campaignPageOffset === null || campaignPageOffset === undefined) return null;
  const offset = Number(campaignPageOffset);
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error("Bounded campaign page carries an unusable offset");
  }
  const limit = Number(campaignPageLimit);
  const maxPages = Number(campaignPageBudget);
  return {
    offset: Math.floor(offset),
    ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.floor(limit) } : {}),
    ...(Number.isFinite(maxPages) && maxPages > 0 ? { maxPages: Math.floor(maxPages) } : {}),
    // Opaque slice state the previous slice asked to carry. Passed through untouched: this
    // function knows the shape of a page, not the shape of a source's continuation state.
    ...(campaignPageCarry === undefined || campaignPageCarry === null
      ? {}
      : { carry: campaignPageCarry }),
  };
}
