/**
 * Phase 6d — the durable post-sync dependency gate.
 *
 * Everything here is a PURE function of durable JobRun rows. Nothing reads an entity, nothing
 * calls a supplier, nothing consults module memory, and nothing uses the wall clock except the one
 * place that is explicitly pinned to an immutable run timestamp. Two workers that read the same
 * rows compute the same answer, which is what makes the gate safe to run concurrently and safe to
 * replay.
 *
 * The order is not a preference, it is a set of hard data dependencies discovered in 6b and 6c:
 *
 *   network phase complete
 *     → promotion       campaign walk per network, THEN that network's coupon walk, and for
 *                       Rakuten also its offer walk
 *     → conversion promotion
 *     → aggregation
 *     → parent terminal success
 *
 * Why each edge exists:
 *   - Promotion and conversion promotion page by UUID primary key. A row staged mid-walk may sort
 *     before the cursor and be missed, so staging must be FROZEN before any walk begins.
 *   - Coupon promotion connects to its parent SupplierCampaign by id and throws when it is absent.
 *   - Rakuten offer promotion resolves the advertiser's promoted campaign and its normalised
 *     source, so it follows the Rakuten campaign walk.
 *   - Conversion attribution reads promoted SupplierCampaign and SupplierCoupon rows; without them
 *     it writes null merchant and campaign links.
 *   - Aggregation buckets are built from those conversions.
 */

import { AGGREGATION_AFTER_SYNC_DAYS } from "./syncConfig.js";
import { UNIT_KINDS } from "./syncOrchestration.service.js";
import { CONVERSION_PROMOTION_PAGE_SIZE } from "./conversionPromotionUnit.js";
import { OFFER_ENTITY_TYPE, OFFER_NETWORK_SOURCE, PROMOTION_PAGE_SIZE } from "./promotionUnit.js";

const TERMINAL_STATUSES = Object.freeze(["COMPLETED", "FAILED", "CANCELLED", "DEAD_LETTER"]);
const FAILED_STATUSES = Object.freeze(["FAILED", "CANCELLED", "DEAD_LETTER"]);

/** The derived post-sync stage of a parent run. Never stored as a database status. */
export const POST_SYNC_STAGES = Object.freeze({
  NONE: "none",
  AWAITING: "awaiting_post_sync",
  PROMOTING: "promoting",
  CONVERSION_PROMOTING: "conversion_promoting",
  AGGREGATING: "aggregating",
  COMPLETED: "completed",
  FAILED: "failed",
});

/** The stage a failure belongs to. Kept distinct so a post-sync failure is never read as a network one. */
export const FAILURE_STAGES = Object.freeze({
  NETWORK: "network",
  PROMOTION: "promotion",
  CONVERSION_PROMOTION: "conversion_promotion",
  AGGREGATION: "aggregation",
});

/** The entity types a network's promotion stage walks, in dependency order. */
export const PROMOTION_FIRST_TYPE = "campaign";
export const PROMOTION_FOLLOWING_TYPES = Object.freeze(["coupon", OFFER_ENTITY_TYPE]);

const descriptorOf = (unit) => unit?.payload ?? unit ?? {};
const kindOf = (unit) => descriptorOf(unit).kind ?? null;
const statusOf = (unit) => unit?.status ?? null;

/** A planning marker from an older planner: a post-sync kind with no bounded page in its payload. */
export function isPlaceholderUnit(unit) {
  const descriptor = descriptorOf(unit);
  if (descriptor.kind === UNIT_KINDS.NETWORK) return false;
  return descriptor.executable === false;
}

/** A bounded unit of a post-sync stage — one that actually names a page or a day. */
function isBoundedStageUnit(unit, kind) {
  return kindOf(unit) === kind && !isPlaceholderUnit(unit);
}

/**
 * Whether the NETWORK phase is completely and successfully finished.
 *
 * Row-level, never from counters: a counter cannot tell a retryable failure (back to PENDING with
 * an error recorded) from work that has not started, and both must block. A deferred source that
 * has not materialised also blocks, because its units do not exist yet and their absence would
 * otherwise read as completeness.
 */
export function networkPhaseState(units = [], { deferredSources = [] } = {}) {
  const network = units.filter((unit) => kindOf(unit) === UNIT_KINDS.NETWORK);
  if (!network.length) return { complete: false, reason: "no_network_units" };

  for (const unit of network) {
    const status = statusOf(unit);
    if (FAILED_STATUSES.includes(status)) return { complete: false, reason: "network_unit_failed" };
    if (status === "RUNNING") return { complete: false, reason: "network_unit_running" };
    if (!TERMINAL_STATUSES.includes(status)) return { complete: false, reason: "network_unit_pending" };
  }
  const unresolved = (Array.isArray(deferredSources) ? deferredSources : []).some(
    (entry) => (entry?.status ?? "pending") === "pending",
  );
  if (unresolved) return { complete: false, reason: "deferred_source_unresolved" };
  return { complete: true, reason: null };
}

/**
 * The networks a post-sync stage covers, read from THIS RUN's own completed network units.
 *
 * Not a hardcoded list: a run that excluded a platform, or that was planned when a platform had no
 * connected account, must not have promotion seeded for it. The network unit's `platform` IS the
 * staged entity's `networkSource` — the sync job writes the platform key into the entity — so the
 * two vocabularies are the same and no translation is invented here.
 */
export function postSyncNetworks(units = []) {
  const networks = new Set();
  for (const unit of units) {
    if (kindOf(unit) !== UNIT_KINDS.NETWORK) continue;
    if (statusOf(unit) !== "COMPLETED") continue;
    const platform = descriptorOf(unit).platform;
    if (typeof platform === "string" && platform !== "") networks.add(platform);
  }
  return [...networks].sort();
}

/**
 * The state of ONE bounded walk: a (kind, networkSource, entityType) triple, or a single day.
 *
 *   "absent"      — no unit of this walk exists yet; it has not been seeded
 *   "outstanding" — at least one unit is pending or running, including a continuation
 *   "failed"      — at least one unit is permanently failed
 *   "resolved"    — every unit of the walk completed, and none can append another
 *
 * A short or empty first page is RESOLVED. A walk that promoted nothing is still a walk that ran:
 * requiring at least one promoted row would stall a network that legitimately has no coupons.
 */
export function walkState(units = [], { kind, networkSource = null, entityType = null, day = null } = {}) {
  const matching = units.filter((unit) => {
    if (!isBoundedStageUnit(unit, kind)) return false;
    const descriptor = descriptorOf(unit);
    if (networkSource !== null && descriptor.networkSource !== networkSource) return false;
    if (entityType !== null && descriptor.entityType !== entityType) return false;
    if (day !== null && descriptor.day !== day) return false;
    return true;
  });
  if (!matching.length) return "absent";
  if (matching.some((unit) => FAILED_STATUSES.includes(statusOf(unit)))) return "failed";
  if (matching.some((unit) => !TERMINAL_STATUSES.includes(statusOf(unit)))) return "outstanding";
  return "resolved";
}

/** The state of a whole stage across every walk it contains. */
function stageState(units, kind) {
  const matching = units.filter((unit) => isBoundedStageUnit(unit, kind));
  if (!matching.length) return "absent";
  if (matching.some((unit) => FAILED_STATUSES.includes(statusOf(unit)))) return "failed";
  if (matching.some((unit) => !TERMINAL_STATUSES.includes(statusOf(unit)))) return "outstanding";
  return "resolved";
}

/**
 * Whether the promotion stage is finished: every seeded network has a resolved campaign walk, a
 * resolved coupon walk, Rakuten has a resolved offer walk if Rakuten was promoted at all, and
 * nothing is pending, running or failed.
 *
 * The expectation comes from the seeded rows themselves. A network whose campaign walk was seeded
 * but whose coupon walk has not been is NOT complete, which is exactly the "absent" case.
 */
export function promotionStageState(units = []) {
  const state = stageState(units, UNIT_KINDS.PROMOTION);
  if (state !== "resolved") return state;
  for (const networkSource of promotionNetworksSeeded(units)) {
    for (const entityType of [PROMOTION_FIRST_TYPE, "coupon"]) {
      if (walkState(units, { kind: UNIT_KINDS.PROMOTION, networkSource, entityType }) !== "resolved") {
        return "outstanding";
      }
    }
    if (networkSource === OFFER_NETWORK_SOURCE) {
      if (walkState(units, { kind: UNIT_KINDS.PROMOTION, networkSource, entityType: OFFER_ENTITY_TYPE }) !== "resolved") {
        return "outstanding";
      }
    }
  }
  return "resolved";
}

/** The networks that actually have bounded promotion units on this run. */
export function promotionNetworksSeeded(units = []) {
  const networks = new Set();
  for (const unit of units) {
    if (!isBoundedStageUnit(unit, UNIT_KINDS.PROMOTION)) continue;
    const networkSource = descriptorOf(unit).networkSource;
    if (typeof networkSource === "string" && networkSource !== "") networks.add(networkSource);
  }
  return [...networks].sort();
}

/** The networks that actually have bounded conversion-promotion units on this run. */
export function conversionNetworksSeeded(units = []) {
  const networks = new Set();
  for (const unit of units) {
    if (!isBoundedStageUnit(unit, UNIT_KINDS.CONVERSION_PROMOTION)) continue;
    const networkSource = descriptorOf(unit).networkSource;
    if (typeof networkSource === "string" && networkSource !== "") networks.add(networkSource);
  }
  return [...networks].sort();
}

/* ------------------------------------------------------------- the pinned aggregation window - */

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The aggregation window of a run, pinned to the run's OWN immutable timestamp.
 *
 * This deliberately does not read the clock. The legacy post-sync rebuild used `new Date()` at the
 * moment it ran, which was fine when it ran seconds after the sync. A durable run can be
 * materialised days later, and recalculating then would silently rebuild a different fortnight
 * than the one the run gathered data for. The run's start is immutable, so the window is too.
 *
 * Semantics are the legacy ones exactly: `to` is the run day in UTC, `from` is that minus
 * AGGREGATION_AFTER_SYNC_DAYS, and the range is INCLUSIVE, so the default 14 is fifteen days.
 */
export function aggregationWindowFor(runStartedAt, { daysBack = AGGREGATION_AFTER_SYNC_DAYS } = {}) {
  const anchor = runStartedAt instanceof Date ? new Date(runStartedAt) : new Date(String(runStartedAt));
  if (Number.isNaN(anchor.getTime())) {
    throw new Error("A run's aggregation window needs the run's own immutable start timestamp.");
  }
  const to = new Date(anchor);
  const from = new Date(anchor);
  from.setUTCDate(from.getUTCDate() - Math.max(1, daysBack));
  return { from: isoDay(from), to: isoDay(to), days: Math.max(1, daysBack) + 1 };
}

/** Every calendar day of the window, ascending. One day is one aggregation unit. */
export function aggregationDaysFor(runStartedAt, options = {}) {
  const window = aggregationWindowFor(runStartedAt, options);
  const days = [];
  const cursor = new Date(`${window.from}T00:00:00.000Z`);
  const last = new Date(`${window.to}T00:00:00.000Z`);
  while (cursor.getTime() <= last.getTime()) {
    days.push(isoDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/* --------------------------------------------------------------------- the transition plan -- */

const promotionSeed = (networkSource, entityType) => ({
  kind: UNIT_KINDS.PROMOTION,
  networkSource,
  entityType,
  cursorId: null,
  pageSize: PROMOTION_PAGE_SIZE,
  options: {},
});

const conversionSeed = (networkSource) => ({
  kind: UNIT_KINDS.CONVERSION_PROMOTION,
  networkSource,
  cursorId: null,
  pageSize: CONVERSION_PROMOTION_PAGE_SIZE,
  options: {},
});

const aggregationSeed = (day) => ({ kind: UNIT_KINDS.AGGREGATION, day, options: {} });

/**
 * The units to append RIGHT NOW, given the rows as they are.
 *
 * It returns at most one stage's worth of seeds and never skips a stage. Every seed carries a unit
 * identity that already exists on the run if it was seeded before, so appending is idempotent and
 * a replay adds nothing — the dedupe lives in appendUnits, and this function does not try to
 * remember anything itself.
 *
 * `reason` always says why nothing was seeded, so a stalled run can be explained from its rows.
 */
export function planPostSyncTransition(
  units = [],
  { postSyncRequested = true, deferredSources = [], runStartedAt = null } = {},
) {
  if (!postSyncRequested) return { stage: POST_SYNC_STAGES.NONE, seeds: [], reason: "post_sync_not_requested" };

  // A failure anywhere stops the whole progression. No stage is skipped past a failure, and no
  // later stage is seeded to "make progress" on top of broken data.
  const failure = failureStageOf(units);
  if (failure) return { stage: POST_SYNC_STAGES.FAILED, seeds: [], reason: `${failure}_failed`, failureStage: failure };

  const network = networkPhaseState(units, { deferredSources });
  if (!network.complete) return { stage: POST_SYNC_STAGES.AWAITING, seeds: [], reason: network.reason };

  /* ---- promotion ---- */
  const promotion = stageState(units, UNIT_KINDS.PROMOTION);
  if (promotion === "absent") {
    const networks = postSyncNetworks(units);
    if (!networks.length) return { stage: POST_SYNC_STAGES.AWAITING, seeds: [], reason: "no_completed_network" };
    // ONLY campaign first pages. Coupons and Rakuten offers depend on this walk and are seeded
    // per network as each network's campaign walk resolves.
    return {
      stage: POST_SYNC_STAGES.PROMOTING,
      seeds: networks.map((networkSource) => promotionSeed(networkSource, PROMOTION_FIRST_TYPE)),
      reason: "promotion_campaign_seeded",
    };
  }

  if (promotion === "outstanding" || promotionStageState(units) !== "resolved") {
    // Per network: once the campaign walk has fully settled, its dependants may be seeded. Each is
    // appended exactly once because its identity is already on the run the second time around.
    const seeds = [];
    for (const networkSource of promotionNetworksSeeded(units)) {
      const campaign = walkState(units, { kind: UNIT_KINDS.PROMOTION, networkSource, entityType: PROMOTION_FIRST_TYPE });
      if (campaign !== "resolved") continue;
      for (const entityType of PROMOTION_FOLLOWING_TYPES) {
        if (entityType === OFFER_ENTITY_TYPE && networkSource !== OFFER_NETWORK_SOURCE) continue;
        if (walkState(units, { kind: UNIT_KINDS.PROMOTION, networkSource, entityType }) !== "absent") continue;
        seeds.push(promotionSeed(networkSource, entityType));
      }
    }
    return {
      stage: POST_SYNC_STAGES.PROMOTING,
      seeds,
      reason: seeds.length ? "promotion_dependants_seeded" : "promotion_outstanding",
    };
  }

  /* ---- conversion promotion ---- */
  const conversion = stageState(units, UNIT_KINDS.CONVERSION_PROMOTION);
  if (conversion === "absent") {
    const networks = postSyncNetworks(units);
    return {
      stage: POST_SYNC_STAGES.CONVERSION_PROMOTING,
      seeds: networks.map((networkSource) => conversionSeed(networkSource)),
      reason: "conversion_promotion_seeded",
    };
  }
  if (conversion !== "resolved") {
    return { stage: POST_SYNC_STAGES.CONVERSION_PROMOTING, seeds: [], reason: "conversion_promotion_outstanding" };
  }

  /* ---- aggregation ---- */
  const aggregation = stageState(units, UNIT_KINDS.AGGREGATION);
  if (aggregation === "absent") {
    if (!runStartedAt) {
      return { stage: POST_SYNC_STAGES.CONVERSION_PROMOTING, seeds: [], reason: "aggregation_window_unpinned" };
    }
    return {
      stage: POST_SYNC_STAGES.AGGREGATING,
      seeds: aggregationDaysFor(runStartedAt).map((day) => aggregationSeed(day)),
      reason: "aggregation_seeded",
      window: aggregationWindowFor(runStartedAt),
    };
  }
  if (aggregation !== "resolved") {
    return { stage: POST_SYNC_STAGES.AGGREGATING, seeds: [], reason: "aggregation_outstanding" };
  }

  return { stage: POST_SYNC_STAGES.COMPLETED, seeds: [], reason: "post_sync_complete" };
}

/**
 * Which stage a permanent failure belongs to, or null.
 *
 * A successful 134-unit network phase must never be reported as a network failure because an
 * aggregation day dead-lettered days later. Earliest stage wins, because that is the one that
 * stopped the progression.
 */
export function failureStageOf(units = []) {
  const failedOf = (kind) =>
    units.some((unit) => kindOf(unit) === kind && !isPlaceholderUnit(unit) && FAILED_STATUSES.includes(statusOf(unit)));
  if (failedOf(UNIT_KINDS.NETWORK)) return FAILURE_STAGES.NETWORK;
  if (failedOf(UNIT_KINDS.PROMOTION)) return FAILURE_STAGES.PROMOTION;
  if (failedOf(UNIT_KINDS.CONVERSION_PROMOTION)) return FAILURE_STAGES.CONVERSION_PROMOTION;
  if (failedOf(UNIT_KINDS.AGGREGATION)) return FAILURE_STAGES.AGGREGATION;
  return null;
}

/**
 * The derived post-sync stage, from rows alone. No stored stage string is trusted: a payload can
 * be written by one worker and read by another mid-transition, and the rows cannot disagree with
 * themselves.
 *
 * This reports what HAS happened, never what is about to. A run whose network phase just finished
 * is `awaiting_post_sync` until a promotion unit actually exists, even though the gate would seed
 * one if asked this instant — the transition PLAN is what looks forward, and conflating the two
 * would have a status endpoint announce a stage that no row supports yet.
 */
export function postSyncStageOf(units = [], { postSyncRequested = true, deferredSources = [] } = {}) {
  if (!postSyncRequested) return POST_SYNC_STAGES.NONE;
  if (failureStageOf(units)) return POST_SYNC_STAGES.FAILED;

  const aggregation = stageState(units, UNIT_KINDS.AGGREGATION);
  if (aggregation === "resolved") return POST_SYNC_STAGES.COMPLETED;
  if (aggregation !== "absent") return POST_SYNC_STAGES.AGGREGATING;

  if (stageState(units, UNIT_KINDS.CONVERSION_PROMOTION) !== "absent") return POST_SYNC_STAGES.CONVERSION_PROMOTING;
  if (stageState(units, UNIT_KINDS.PROMOTION) !== "absent") return POST_SYNC_STAGES.PROMOTING;
  return POST_SYNC_STAGES.AWAITING;
}

/**
 * Whether more units can still appear. True while any cursor walk can append a continuation or any
 * stage is still to be seeded; false only once the aggregation days exist, because an aggregation
 * unit is one day and appends nothing.
 */
export function postSyncMayAppendUnits(units = [], { postSyncRequested = true } = {}) {
  if (!postSyncRequested) return false;
  if (failureStageOf(units)) return false;
  return stageState(units, UNIT_KINDS.AGGREGATION) === "absent";
}
