/**
 * Durable sync orchestration — Phase 1: model + service. No execution, no routes.
 *
 * On serverless hosting an invocation cannot own a long-running sync: it is frozen once its
 * response is sent and hard-killed at the function limit. A full sync is therefore modelled as a
 * durable PARENT run plus one durable row per BOUNDED UNIT of work, all on the existing JobRun
 * table (no schema change):
 *
 *   parent  JobRun { jobName: "sync:orchestration", correlationId: <own id>, payload: { kind,
 *                    trigger, options, totalUnits }, result: <projected counters>, progress }
 *   unit    JobRun { jobName: "sync:unit", correlationId: <parent id>, priority: <sequence>,
 *                    payload: { parentRunId, sequence, kind, platform, accountLabel,
 *                    sourceObject, options, lockKey }, result: { claim, outcome } }
 *
 * Units are claimed ATOMICALLY (conditional updateMany PENDING → RUNNING), held under a LEASE
 * longer than any invocation can live (a RUNNING unit whose lease expired is reclaimable), and
 * mutually excluded across runs by a LOCK KEY (the same network/account/source object is never
 * RUNNING twice). Failures return the unit to PENDING while attempts remain — no in-process
 * sleep or retry loop — and end in DEAD_LETTER otherwise. The parent's status is a projection
 * of its units, recomputed after every outcome, so progress survives cold starts and instances.
 *
 * Execution of a unit (Phase 3) and the routes (Phases 2–5) build on these primitives.
 */

import { prisma as defaultPrisma } from "../database/prisma.js";
import { listMarketplaceAccounts } from "../modules/integrations/oauth.service.js";
import { getAccountSyncTimestamps } from "./syncTimestamps.js";
import { nextPagedUnit, planAccountUnits, planSourcesFor, sourcesMaterialisedAfter } from "./syncSourcePlan.js";
import {
  OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE,
  planOptimiseCommissionGroupChunks,
} from "./optimiseCommissionGroupSync.js";
import {
  DEFAULT_LEASE_MS as LOCK_LEASE_MS,
  SyncAccountLockService,
  accountLockKey,
  stageLockKey,
} from "./syncAccountLock.service.js";
// Phase 6d — the durable post-sync dependency gate. Pure functions over JobRun rows; see the
// module comment for why each stage edge exists.
import {
  FAILURE_STAGES,
  POST_SYNC_STAGES,
  failureStageOf,
  planPostSyncTransition,
  postSyncMayAppendUnits,
  postSyncStageOf,
} from "./postSyncStages.js";
// The durable Entity-staging barrier. The gate is the one place that TRANSITIONS into the frozen
// state, so it is the one place that needs the announce-then-verify handshake.
import { EntityStagingBarrier, STAGING_FROZEN_CODE } from "./entityStagingBarrier.js";

export const ORCHESTRATION_JOB_NAME = "sync:orchestration";
export const UNIT_JOB_NAME = "sync:unit";

export const UNIT_KINDS = Object.freeze({
  NETWORK: "network",
  /**
   * Awin has no programmes to stage, so its campaign parents are derived from staged offers. That
   * is a STAGING step, not a promotion, and it must finish before the Awin campaign walk begins —
   * a campaign page only sees the Entities that existed when it ran. Its own kind is what lets
   * postSyncStages express that as a barrier instead of a hope.
   */
  AWIN_PARENT_MATERIALIZATION: "awin-parent-materialization",
  PROMOTION: "promotion",
  CONVERSION_PROMOTION: "conversion-promotion",
  AGGREGATION: "aggregation",
});

/**
 * Lease and lock semantics are OWNED BY the shared durable lock service, so an orchestration unit
 * and a manual per-network run take the same key under the same lease. Re-exported here for
 * callers that only import the orchestrator.
 */
export const DEFAULT_LEASE_MS = LOCK_LEASE_MS;
export const DEFAULT_UNIT_MAX_ATTEMPTS = 3;

/**
 * What KIND of plan a run's units are, recorded durably on the parent.
 *
 * A run is only reusable by a request that would plan the same shape of work. Kind and options
 * are not enough for that: a pre-Phase-5 run's units are whole accounts, a Phase 5 run's are
 * platform + account + source object [+ window]. They answer the same `/sync/all` and match on
 * every option, yet resuming one when the caller asked for the other silently does entirely
 * different work — which is exactly what happened in production, where a full sync resumed a
 * 9-unit account-wide run instead of planning 124 bounded units.
 *
 * Bump this whenever a change makes previously planned units incompatible with newly planned
 * ones. Runs created before it existed carry no version at all and are compatible with nothing.
 *
 * 6 — Optimise campaigns became a PAGED source. A version-5 campaigns unit carries no page
 * descriptor, so it would walk the whole catalog and hit the invocation limit exactly as run
 * 0991cd7f did, and its completion would materialise commission groups from a catalog only
 * partly staged. Version-5 runs are therefore neither reused nor executed by this planner; they
 * stay readable and are retired deliberately.
 *
 * 7 — Awin offers became a DURABLE PAGED source. It was one unit that fetched the whole
 * catalogue and staged it; production proved that cannot fit one invocation — 5,000 offers is
 * ~96s of supplier time and ~247s of staging against a 300s cap. It is now one supplier page per
 * unit, with the next unit planned from what the previous one reported.
 *
 * A version-6 Awin offers unit carries NO campaignPage descriptor and no campaignPageCarry. It
 * therefore cannot be executed as a version-7 unit: with no slice it has no page to fetch and no
 * digests to recognise a re-delivered page by, so running it would mean the whole-catalogue walk
 * this version exists to retire. Version-6 runs are neither reused nor executed by this planner;
 * like version-5 runs they stay readable and are retired deliberately.
 */
export const PLANNER_VERSION = 7;

/**
 * Why a unit was terminalised without ever reporting a failure: its worker was killed (a
 * serverless invocation timeout, a crash, an instance reclaim) and its lease ran out.
 */
export const ABANDONED_UNIT_REASON = "worker lease expired before completion";

/**
 * Kinds a worker may execute TODAY, widened one bounded stage at a time.
 *
 * AGGREGATION is executable because one unit is one DAY: it runs
 * rebuild({ from: day, to: day }) and nothing else. CONVERSION_PROMOTION is one cursor PAGE of one
 * network. PROMOTION is one cursor PAGE of one network and one entity TYPE. Each of them replaces
 * a stage that used to walk every entity of every network in a single call.
 *
 * Being executable is not the same as being ORDERED. The post-sync stages still depend on each
 * other — promotion, then conversion promotion, then aggregation — and nothing in this list
 * enforces that. The parent transition gate owns it.
 *
 * A unit planned with `executable: false` stays refused whatever this list says: isUnitExecutable
 * checks the stored flag first, so widening this can never silently un-block an older run's
 * placeholders.
 */
export const EXECUTABLE_UNIT_KINDS = Object.freeze([
  UNIT_KINDS.NETWORK,
  UNIT_KINDS.AGGREGATION,
  UNIT_KINDS.CONVERSION_PROMOTION,
  UNIT_KINDS.PROMOTION,
  UNIT_KINDS.AWIN_PARENT_MATERIALIZATION,
]);
export const UNIT_BLOCKED_REASON = "bounded_units_not_implemented";

/** Platforms in the established syncAll order; account-labelled ones enumerate connected accounts. */
const ACCOUNT_LABELLED_PLATFORMS = ["boostiny", "optimise_sea", "optimise_mena", "optimise_uk", "trackier"];
const SINGLE_ACCOUNT_PLATFORMS = ["impact", "partnerize", "awin", "admitad", "rakuten", "cj"];

const ACTIVE_STATUSES = ["PENDING", "RUNNING"];
/** Stable, operator-facing reason recorded on an administratively cancelled run and its units. */
export const ADMIN_CANCELLED_REASON = "cancelled_by_operator";
const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED", "DEAD_LETTER"];

function text(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/**
 * The durable mutual-exclusion key of a unit, from the SHARED lock vocabulary. A network unit
 * locks the whole ACCOUNT, whatever its source-object scope: a full account sync covers every
 * source object, so a campaigns-only run and a full run of the same account must conflict.
 */
export function unitLockKey(unit = {}) {
  if (unit.kind === UNIT_KINDS.NETWORK) {
    return accountLockKey({ platform: unit.platform, accountLabel: unit.accountLabel });
  }
  return stageLockKey(unit.kind, unit.kind === UNIT_KINDS.AGGREGATION ? unit.day : null);
}

/** Whether a planned/stored unit may be executed by a worker in the current phase. */
export function isUnitExecutable(unit = {}) {
  const descriptor = unit?.payload ?? unit;
  if (descriptor?.executable === false) return false;
  return EXECUTABLE_UNIT_KINDS.includes(descriptor?.kind);
}

/** Throw the refusal a worker must surface rather than running an unbounded stage. */
export function assertUnitExecutable(unit = {}) {
  if (isUnitExecutable(unit)) return true;
  const descriptor = unit?.payload ?? unit;
  const error = new Error(
    `Unit kind "${descriptor?.kind}" is not executable yet: ${descriptor?.blockedReason ?? UNIT_BLOCKED_REASON}`,
  );
  error.code = "unit_not_executable";
  throw error;
}

/**
 * Connected accounts of a platform, each with the timestamp the plan's span is measured from.
 * The rows are returned in a STABLE order (accountLabel ascending) rather than in connection
 * order, so two `/sync/all` requests and a retry all plan the same sequence numbers.
 */
async function defaultListAccounts(platform) {
  const accounts = await listMarketplaceAccounts(platform);
  const seen = new Map();
  for (const account of accounts) {
    const label = account?.accountLabel;
    if (!label || seen.has(label)) continue;
    seen.set(label, { accountLabel: label, lastSuccessfulSync: account?.lastSuccessfulSync ?? null });
  }
  return [...seen.values()];
}

async function defaultLoadAccountState(platform, accountLabel) {
  try {
    const row = await getAccountSyncTimestamps(platform, accountLabel);
    return { lastSuccessfulSync: row?.lastSuccessfulSync ?? null };
  } catch {
    // A missing MarketplaceAccount row (env-credential networks) is not an error: the plan simply
    // falls back to the network's own initial lookback.
    return { lastSuccessfulSync: null };
  }
}

/**
 * Accept both account shapes: the rich rows this module produces and the bare labels older
 * callers and tests supply. Sorted by label so the plan order never depends on the DB's order.
 */
function normalizeAccountEntries(entries) {
  const list = (entries ?? []).map((entry) =>
    typeof entry === "string"
      ? { accountLabel: entry, lastSuccessfulSync: undefined }
      : { accountLabel: entry?.accountLabel ?? null, lastSuccessfulSync: entry?.lastSuccessfulSync },
  );
  return list
    .filter((entry) => entry.accountLabel)
    .sort((a, b) => (a.accountLabel < b.accountLabel ? -1 : a.accountLabel > b.accountLabel ? 1 : 0));
}

/**
 * Plan the bounded units of one run, in execution order:
 *
 *   platform (the established syncAll order)
 *     → account (label ascending, so retries and duplicate requests agree)
 *       → source object (the audited per-network order)
 *         → date window (chronological, contiguous, no overlap and no gap)
 *
 * A unit is therefore platform + accountLabel + sourceObject [+ windowStart..windowEnd], small
 * enough to finish inside one invocation. Network units NEVER run the global post-sync stages
 * themselves (promoteAfter:false); those are their own units, present only when asked for.
 *
 * A source object the audit could not bound (Optimise commission groups: one request per
 * campaign, no date filter) produces no unit. It is returned as an EXCLUSION, recorded on the run
 * and shown in status, rather than silently widened back into an unbounded pull.
 *
 * Returns { units, exclusions }.
 */
export async function buildSyncPlan({
  kind = "full",
  fastSync = false,
  promoteAfter = true,
  includePostSyncUnits = false,
  listAccounts = defaultListAccounts,
  loadAccountState = defaultLoadAccountState,
  now = new Date(),
} = {}) {
  const units = [];
  const exclusions = [];
  const deferred = [];
  // fastSync comes from options and ONLY from options. It used to be forced true when
  // kind was "incremental", which made the run payload disagree with its own units: the
  // payload recorded the caller's raw value while every unit carried the coerced one.
  // The kinds plan an identical unit set either way, so the coercion bought nothing and
  // cost the reuse key its accuracy.
  const networkOptions = { fastSync: Boolean(fastSync), promoteAfter: false };
  const planAccount = async (platform, entry) => {
    const lastSuccessfulSync =
      entry.lastSuccessfulSync === undefined
        ? (await loadAccountState(platform, entry.accountLabel))?.lastSuccessfulSync ?? null
        : entry.lastSuccessfulSync;
    const planned = planAccountUnits({
      platform,
      accountLabel: entry.accountLabel,
      lastSuccessfulSync,
      now,
      networkOptions,
    });
    exclusions.push(...planned.exclusions);
    deferred.push(...planned.deferred);
    // A platform with no audited source objects keeps the pre-Phase-5 shape: one account-wide
    // unit. Nothing is dropped because the audit does not cover it yet.
    if (!planned.units.length && !planned.exclusions.length) {
      units.push({ kind: UNIT_KINDS.NETWORK, platform, accountLabel: entry.accountLabel, options: { ...networkOptions } });
      return;
    }
    for (const unit of planned.units) units.push({ kind: UNIT_KINDS.NETWORK, ...unit });
  };

  for (const platform of ACCOUNT_LABELLED_PLATFORMS) {
    const entries = normalizeAccountEntries(await listAccounts(platform));
    for (const entry of entries) await planAccount(platform, entry);
  }
  for (const platform of SINGLE_ACCOUNT_PLATFORMS) {
    await planAccount(platform, { accountLabel: "default", lastSuccessfulSync: undefined });
  }
  // Post-sync stages are NOT planned by default. The existing promotion, conversion-promotion and
  // 14-day rebuild are unbounded; until they are generated as bounded units they may only be
  // materialised as explicit, non-executable placeholders that a worker must refuse.
  if (promoteAfter && includePostSyncUnits) {
    for (const kindName of [UNIT_KINDS.PROMOTION, UNIT_KINDS.CONVERSION_PROMOTION, UNIT_KINDS.AGGREGATION]) {
      units.push({ kind: kindName, options: {}, executable: false, blockedReason: UNIT_BLOCKED_REASON });
    }
  }
  return {
    units: units.map((unit, index) => ({ ...unit, sequence: index + 1, lockKey: unitLockKey(unit) })),
    exclusions,
    deferred,
  };
}

export { planSourcesFor };

/**
 * Safe, aggregate description of a plan: counts and date boundaries only.
 *
 * Built by reading the plan's own shape — it never copies a unit payload, so a campaign id, a
 * credential or a supplier row cannot reach a caller through it. Every number here is derivable
 * from the plan alone, which is what makes it comparable with what `/sync/all` would enqueue.
 */
export function summarisePlan(plan = {}, { kind = "full", options = {} } = {}) {
  const units = Array.isArray(plan.units) ? plan.units : [];
  const exclusions = Array.isArray(plan.exclusions) ? plan.exclusions : [];
  const deferred = Array.isArray(plan.deferred) ? plan.deferred : [];

  const byPlatform = {};
  const byAccount = {};
  const bySourceObject = {};
  const windows = new Map();
  let windowedUnits = 0;
  let catalogUnits = 0;

  for (const unit of units) {
    const platform = unit.platform ?? "(none)";
    const account = `${platform}/${unit.accountLabel ?? "(none)"}`;
    const sourceObject = unit.sourceObject ?? "(account-wide)";
    byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;
    byAccount[account] = (byAccount[account] ?? 0) + 1;
    bySourceObject[sourceObject] = (bySourceObject[sourceObject] ?? 0) + 1;
    if (unit.windowStart && unit.windowEnd) {
      windowedUnits += 1;
      const key = `${platform}:${sourceObject}`;
      const span = windows.get(key) ?? { platform, sourceObject, windows: 0, earliest: unit.windowStart, latest: unit.windowEnd };
      span.windows += 1;
      if (unit.windowStart < span.earliest) span.earliest = unit.windowStart;
      if (unit.windowEnd > span.latest) span.latest = unit.windowEnd;
      windows.set(key, span);
    } else {
      catalogUnits += 1;
    }
  }

  return {
    kind,
    options: { fastSync: Boolean(options.fastSync), promoteAfter: options.promoteAfter !== false },
    totalUnits: units.length,
    // A deferred source materialises its units later, so the initial total is a floor.
    totalUnitsMayIncrease: deferred.length > 0,
    windowedUnits,
    catalogUnits,
    byPlatform,
    byAccount,
    bySourceObject,
    // Earliest and latest day each windowed source would cover, and how many windows tile it.
    windowSpans: [...windows.values()].sort((a, b) =>
      a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : a.sourceObject < b.sourceObject ? -1 : 1,
    ),
    deferredSourceCount: deferred.length,
    deferredSources: deferred.map((entry) => ({
      platform: entry.platform,
      accountLabel: entry.accountLabel,
      sourceObject: entry.sourceObject,
      after: entry.after,
    })),
    exclusions: exclusions.map((entry) => ({
      platform: entry.platform,
      accountLabel: entry.accountLabel,
      sourceObject: entry.sourceObject,
      reason: entry.reason,
    })),
  };
}

/**
 * Project the run from its units. `postSyncStages` is the PARENT's record of what was requested:
 *   "none"     — promotion was not requested; the run is done when its units are done
 *   "deferred" — promotion WAS requested but its bounded units do not exist yet
 *   "blocked"  — non-executable placeholders are present
 *
 * Precedence once every materialised unit has settled:
 *   1. a permanently failed unit (DEAD_LETTER / FAILED / CANCELLED) finalises the parent FAILED —
 *      an unrecoverable failure in the network phase is NOT waited on, and no post-sync work is
 *      materialised after it, unless a partial-success continuation policy is designed later;
 *   2. otherwise requested-but-outstanding post-sync work keeps the parent non-terminal;
 *   3. otherwise every requested unit completed and the parent finalises.
 *
 * Progress: `unitsPercentComplete` is the truthful progress of the units that EXIST. Overall
 * `percentComplete` is null while the run's total work is not yet knowable (promotion requested,
 * bounded units not materialised) — the denominator is unknown, and no weighting is invented.
 */
function summarizeUnits(units, { postSyncStages = "none", postSyncMayAppend = false } = {}) {
  const counters = { totalUnits: units.length, completedUnits: 0, failedUnits: 0, cancelledUnits: 0, pendingUnits: 0, runningUnits: 0, blockedUnits: 0, supersededUnits: 0 };
  let partial = false;
  let latestError = null;
  let latestWarning = null;
  let current = null;
  for (const unit of units) {
    if (unit.status === "COMPLETED") {
      counters.completedUnits += 1;
      if (unit.result?.outcome?.partialSuccess) partial = true;
      const warnings = unit.result?.outcome?.warnings;
      if (Array.isArray(warnings) && warnings.length) latestWarning = String(warnings[warnings.length - 1]);
    } else if (unit.status === "CANCELLED") {
      // A deliberate administrative stop is NOT a failure. Counting it as one made a cancelled run
      // read as a sync that broke, with one "failure" per unit the operator chose not to run.
      counters.cancelledUnits += 1;
    } else if (unit.status === "DEAD_LETTER" || unit.status === "FAILED") {
      counters.failedUnits += 1;
      if (unit.lastError) latestError = unit.lastError;
    } else if (unit.status === "RUNNING") {
      counters.runningUnits += 1;
      if (!current) current = unit;
    } else if (!isUnitExecutable(unit)) {
      // Planned but not runnable in this phase: never offered to a worker, never silently "done".
      // A placeholder the post-sync gate has SUPERSEDED with bounded units is different: it is a
      // historical planning marker whose work now exists as real units, so it neither runs nor
      // holds the run open. It stays visible rather than being cancelled, because cancelling it
      // would count as a failure.
      if (unit?.payload?.supersededBy) counters.supersededUnits += 1;
      else counters.blockedUnits += 1;
    } else {
      counters.pendingUnits += 1;
      if (unit.lastError && !latestError) latestError = unit.lastError;
    }
  }
  // Cancelled units are terminal even though they are not failures: nothing will run them.
  const terminal = counters.completedUnits + counters.failedUnits + counters.cancelledUnits;
  const unitsPercentComplete = counters.totalUnits > 0 ? Math.min(100, Math.round((terminal / counters.totalUnits) * 100)) : 0;
  const settled = terminal + counters.blockedUnits + counters.supersededUnits === counters.totalUnits && counters.totalUnits > 0;
  // 1 — an unrecoverable unit failure beats any outstanding post-sync work.
  const permanentlyFailed = settled && counters.failedUnits > 0;
  // 2 — otherwise, post-sync work that is still to come keeps the run open. "Still to come" is
  // read from the ROWS by the gate, not from a stored label: before Phase 6d that could only mean
  // "requested but never materialised", and now it also means "this stage is done but the next one
  // has not been seeded yet". A run that has reached its aggregation days can append nothing more,
  // so it is free to finalise. "blocked" keeps its pre-6d meaning exactly: placeholders alone are
  // not outstanding work, because nothing will ever materialise them.
  const postSyncOutstanding = (postSyncStages === "deferred" || postSyncStages === "materialised") && postSyncMayAppend;
  const awaitingPostSync = settled && !permanentlyFailed && postSyncOutstanding;
  const blocked = settled && !permanentlyFailed && !awaitingPostSync && counters.blockedUnits > 0;
  const finished = settled && (permanentlyFailed || (!awaitingPostSync && counters.blockedUnits === 0));
  // The overall denominator is unknown while a stage can still append units — except once the run
  // is finished, when nothing further will be materialised.
  const totalWorkKnown = !postSyncOutstanding || finished;
  const percentComplete = totalWorkKnown ? unitsPercentComplete : null;
  let status = "running";
  if (finished) status = counters.failedUnits > 0 ? "failed" : partial ? "partial" : "success";
  else if (blocked) status = "blocked";
  else if (awaitingPostSync) status = "awaiting_post_sync";
  return {
    ...counters,
    unitsPercentComplete,
    percentComplete,
    totalWorkKnown,
    postSyncOutstanding,
    finished,
    settled,
    permanentlyFailed,
    awaitingPostSync,
    blocked,
    status,
    latestError,
    latestWarning,
    current,
  };
}

/**
 * Truthful progress of ONE phase: settled units over units that exist in that phase, or null when
 * the phase has no units at all. Never a claim about work that has not been planned yet.
 */
function phasePercent(units, belongs) {
  const phase = units.filter(belongs);
  if (!phase.length) return null;
  const settled = phase.filter((unit) => TERMINAL_STATUSES.includes(unit.status)).length;
  return Math.min(100, Math.round((settled / phase.length) * 100));
}

/** The one account's block of a sync result, without assuming which key it sits under. */
function accountOutcome(result, accountLabel) {
  if (!result || typeof result !== "object") return null;
  const direct = accountLabel ? result[accountLabel] : null;
  if (direct && typeof direct === "object") return direct;
  // Optimise nests its account block under the region: { sea: { default: {...} } }.
  for (const value of Object.values(result)) {
    if (!value || typeof value !== "object") continue;
    if (accountLabel && value[accountLabel] && typeof value[accountLabel] === "object") return value[accountLabel];
    if (value.campaignPage !== undefined) return value;
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object" && nested.campaignPage !== undefined) return nested;
    }
  }
  return null;
}

export const OPTIMISE_COMMISSION_GROUPS_SOURCE = "commission_groups";
export { OPTIMISE_COMMISSION_GROUP_CHUNK_SIZE };

/**
 * What makes two unit descriptors the same piece of work. Used to keep an appended unit from
 * being planned twice when a completion is replayed.
 */
function unitIdentity(descriptor = {}) {
  return [
    descriptor.kind ?? "",
    descriptor.platform ?? "",
    descriptor.accountLabel ?? "",
    descriptor.sourceObject ?? "",
    descriptor.windowStart ?? "",
    descriptor.windowEnd ?? "",
    descriptor.campaignChunkIndex ?? "",
    descriptor.campaignPageOffset ?? "",
    // Two aggregation units differ only by the day they rebuild; without it every day would
    // collapse to one identity and appendUnits would keep just the first.
    descriptor.day ?? "",
    // A conversion-promotion page is identified by its network and its exclusive cursor. Without
    // both, every page of a walk would collapse to one identity and only the first would append.
    descriptor.networkSource ?? "",
    descriptor.cursorId ?? "",
    // A promotion page adds the entity TYPE: the campaign walk and the coupon walk of one network
    // share a cursor space, so without it the two walks would collide on identity.
    descriptor.entityType ?? "",
  ].join("|");
}

/**
 * Safe chunk metadata: WHICH slice of an account's campaigns this unit covers and how big it is.
 * Deliberately counts and positions only — the campaign identifiers themselves are supplier data
 * and never leave the unit payload.
 */
/** Safe slice metadata: which page window this unit covers. Offsets and counts only. */
function unitCampaignPage(descriptor = {}) {
  const offset = descriptor?.campaignPageOffset;
  if (offset === null || offset === undefined) return null;
  return {
    index: descriptor?.campaignPageIndex ?? null,
    offset,
    limit: descriptor?.campaignPageLimit ?? null,
    pages: descriptor?.campaignPageBudget ?? null,
  };
}

function unitCampaignChunk(descriptor = {}) {
  const index = descriptor?.campaignChunkIndex;
  if (index === null || index === undefined) return null;
  return {
    index,
    of: descriptor?.campaignChunkCount ?? null,
    campaignCount: Array.isArray(descriptor?.campaignIds) ? descriptor.campaignIds.length : null,
  };
}

/** The inclusive day boundaries a unit was planned with, or null when it is not date-bounded. */
function unitWindow(descriptor = {}) {
  const start = descriptor?.windowStart ?? null;
  const end = descriptor?.windowEnd ?? null;
  return start && end ? { start, end } : null;
}

function unitView(unit) {
  if (!unit) return null;
  const p = unit.payload ?? {};
  return {
    unitId: unit.id,
    sequence: p.sequence ?? unit.priority ?? null,
    kind: p.kind ?? null,
    platform: p.platform ?? null,
    accountLabel: p.accountLabel ?? null,
    sourceObject: p.sourceObject ?? null,
    // The unit's bounded scope, or null for a catalog object that carries no date filter and for
    // a pre-Phase-5 account-wide unit.
    window: unitWindow(p),
    campaignChunk: unitCampaignChunk(p),
    campaignPage: unitCampaignPage(p),
    lockKey: p.lockKey ?? null,
    status: unit.status,
    attempt: unit.attempt ?? 0,
    startedAt: unit.startedAt ?? null,
    executable: isUnitExecutable(unit),
    blockedReason: isUnitExecutable(unit) ? null : (p.blockedReason ?? UNIT_BLOCKED_REASON),
  };
}

/**
 * Redact anything that looks like a credential out of a durable error before it is shown.
 * Deliberately local: the status projection must not depend on a heavier module, and this runs on
 * text that a supplier client produced.
 */
export function safeUnitError(message) {
  if (message == null || message === "") return null;
  let text = String(message);
  text = text.replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/gi, "Bearer [redacted]");
  text = text.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token)\s*[:=]\s*\S+/gi,
    "$1=[redacted]",
  );
  text = text.replace(/https?:\/\/\S+/gi, "[url]");
  text = text.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * A compact, durable record of what one network unit did. Counts and flags only: the raw supplier
 * result is never copied into the job row.
 */
export function summariseSyncUnitOutcome(result, { accountLabel = null } = {}) {
  const account = accountLabel && result?.[accountLabel] && typeof result[accountLabel] === "object"
    ? result[accountLabel]
    : (result && typeof result === "object" ? Object.values(result).find((v) => v && typeof v === "object") ?? {} : {});
  const warnings = [];
  const collect = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    if (Array.isArray(node.warnings)) warnings.push(...node.warnings.filter(Boolean).map((w) => String(w).slice(0, 500)));
    for (const value of Object.values(node)) if (value && typeof value === "object") collect(value, depth + 1);
  };
  collect(result);
  const counts = {};
  for (const [key, value] of Object.entries(account)) {
    if (typeof value === "number" && Number.isFinite(value)) counts[key] = value;
  }
  const hasPartial = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 4) return false;
    if (node.partialSuccess === true) return true;
    return Object.values(node).some((value) => value && typeof value === "object" && hasPartial(value, depth + 1));
  };
  return {
    partialSuccess: hasPartial(result),
    skipped: account?.skipped === true,
    failed: account?.failed === true,
    ...(account?.reason ? { reason: String(account.reason).slice(0, 500) } : {}),
    counts,
    warnings: warnings.slice(0, 5),
  };
}

/**
 * What makes an active run REUSABLE by a new request: the same kind, the same execution options,
 * and the same planner version. The version condition matches on an exact stored value, so a run
 * that predates versioning — no `plannerVersion` key at all — is matched by nothing and is left
 * strictly alone.
 *
 * A null `plannerVersion` means "do not filter on it", used by the read-only status lookups that
 * must still be able to see a legacy run.
 */
/**
 * EXACT identity: two runs are the same work, so one is a duplicate of the other.
 *
 * This is the predicate behind duplicate COLLAPSE, which cancels runs, so it must never be
 * loosened. A non-fast run and a fast run are not duplicates — one does strictly more — and
 * treating them as such would cancel the broader run and silently lose its catalog refresh.
 *
 * kind is deliberately absent. It no longer changes what a run plans (see buildSyncPlan), so two
 * runs that differ only by that label are the same work under different names.
 */
function identityConditions({ options = null, plannerVersion = null } = {}) {
  const conditions = [];
  if (options) {
    conditions.push({ payload: { path: ["options", "fastSync"], equals: Boolean(options.fastSync) } });
    conditions.push({ payload: { path: ["options", "promoteAfter"], equals: options.promoteAfter !== false } });
  }
  if (plannerVersion !== null && plannerVersion !== undefined) {
    conditions.push({ payload: { path: ["plannerVersion"], equals: plannerVersion } });
  }
  return conditions;
}

/**
 * REUSE: which active run may satisfy this request. Asymmetric, because breadth is asymmetric.
 *
 * fastSync only skips a catalog re-fetch whose TTL has not expired; windowed pulls and the
 * post-sync stages happen either way. A non-fast run therefore does everything a fast run would
 * and more, so a fast request may be satisfied by a non-fast run — expressed by omitting the
 * condition entirely rather than by an OR, since "either value will do" is no constraint at all.
 * A non-fast request is NOT satisfied by a fast run, which may have skipped the very refresh it
 * asked for, so there the condition stays exact.
 *
 * promoteAfter and plannerVersion are never relaxed: they change what the work IS, not how much
 * of it there is.
 */
function compatibilityConditions({ options = null, plannerVersion = null } = {}) {
  const conditions = [];
  if (options) {
    if (!options.fastSync) {
      conditions.push({ payload: { path: ["options", "fastSync"], equals: false } });
    }
    conditions.push({ payload: { path: ["options", "promoteAfter"], equals: options.promoteAfter !== false } });
  }
  if (plannerVersion !== null && plannerVersion !== undefined) {
    conditions.push({ payload: { path: ["plannerVersion"], equals: plannerVersion } });
  }
  return conditions;
}

export class SyncOrchestrationService {
  constructor({ prisma = defaultPrisma, now = () => new Date(), leaseMs = DEFAULT_LEASE_MS, maxAttempts = DEFAULT_UNIT_MAX_ATTEMPTS, listAccounts = defaultListAccounts, loadAccountState = defaultLoadAccountState, planCommissionGroupChunks = planOptimiseCommissionGroupChunks, locks = null, barrier = null } = {}) {
    this.db = prisma;
    this.now = now;
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    this.listAccounts = listAccounts;
    this.loadAccountState = loadAccountState;
    // Injected so a unit test never reaches the staging tables, and so the discovery step stays
    // where it belongs: with the module that owns Optimise campaign selection.
    this.planCommissionGroupChunks = planCommissionGroupChunks;
    // One shared durable lock vocabulary for orchestration units AND (later) the manual route.
    this.locks = locks ?? new SyncAccountLockService({ prisma, now, leaseMs });
    // The Entity-staging freeze. Injected in tests; otherwise backed by the same rows and clock.
    this.barrier = barrier ?? new EntityStagingBarrier({ prisma, now, leaseMs });
  }

  /**
   * The active (PENDING/RUNNING) parent run matching a kind AND the execution options that change
   * what the work IS, oldest first, or null. Matching on kind alone would silently fold an
   * incompatible request (e.g. ?fast=true) into an unrelated run and give the caller a run id
   * whose units do different work than they asked for.
   */
  async findActiveRun({ kind = null, options = null, plannerVersion = null } = {}) {
    // kind is accepted and ignored: it no longer changes what a run plans, so it cannot decide
    // whether an active run satisfies this request.
    void kind;
    const conditions = compatibilityConditions({ options, plannerVersion });
    return this.db.jobRun.findFirst({
      where: {
        jobName: ORCHESTRATION_JOB_NAME,
        status: { in: ACTIVE_STATUSES },
        ...(conditions.length ? { AND: conditions } : {}),
      },
      orderBy: [{ createdAt: "asc" }],
    });
  }

  /**
   * Create a parent run and its unit rows in one transaction. `units` may be supplied (e.g. a
   * single manual unit); otherwise the plan is built from connected accounts.
   */
  async createRun({ kind = "full", trigger = "api", options = {}, units = null } = {}) {
    const plan = units
      ? { units: units.map((unit, index) => ({ ...unit, sequence: index + 1, lockKey: unitLockKey(unit) })), exclusions: [] }
      : await buildSyncPlan({
          kind,
          fastSync: options.fastSync,
          promoteAfter: options.promoteAfter !== false,
          includePostSyncUnits: options.includePostSyncUnits === true,
          listAccounts: this.listAccounts,
          loadAccountState: this.loadAccountState,
          // One clock for the whole plan: every window of every account is measured from the same
          // instant, so a plan built across a midnight boundary cannot leave a one-day hole.
          now: this.now(),
        });
    const planned = plan.units;
    const exclusions = plan.exclusions;
    const deferredSources = plan.deferred ?? [];
    const startedAt = this.now();
    const run = async (tx) => {
      const parent = await tx.jobRun.create({
        data: {
          jobName: ORCHESTRATION_JOB_NAME,
          status: "RUNNING",
          priority: 100,
          maxAttempts: 1,
          startedAt,
          payload: {
            kind,
            trigger,
            // The shape of this run's units. A later request only reuses a run that plans the
            // same shape; see PLANNER_VERSION.
            plannerVersion: PLANNER_VERSION,
            options: {
              fastSync: Boolean(options.fastSync),
              promoteAfter: options.promoteAfter !== false,
              // Recorded only when present, so an estate run's payload keeps exactly the shape it
              // has always had. It is what makes a scoped run findable as ITS OWN work rather
              // than as any active run whose breadth happens to be compatible.
              ...(options.scopeKey ? { scopeKey: String(options.scopeKey) } : {}),
            },
            // Explicit, never silent: "none" when promotion was not requested, "blocked" when
            // placeholders exist, "deferred" when promotion was asked for but has no bounded units.
            // "blocked" is about POST-SYNC stages only: a non-executable NETWORK source object
            // (an unbounded per-campaign fan-out) says nothing about whether promotion was
            // materialised, and conflating the two would misreport every run that plans one.
            postSyncStages:
              options.promoteAfter === false
                ? "none"
                : planned.some((unit) => unit.kind !== UNIT_KINDS.NETWORK && unit.executable === false)
                  ? "blocked"
                  : "deferred",
            totalUnits: planned.length,
            // Source objects the bounded planner deliberately did NOT plan, with the reason.
            // Recorded on the run so an operator can see what a run does not cover.
            ...(exclusions.length ? { excludedSources: exclusions } : {}),
            // Source objects whose units are materialised later in this run, once the unit they
            // depend on has completed. Present so a run states up front that this work is
            // coming, not that it was dropped.
            ...(deferredSources.length ? { deferredSources } : {}),
          },
          result: { totalUnits: planned.length, completedUnits: 0, failedUnits: 0, pendingUnits: planned.length, runningUnits: 0, percentComplete: 0 },
        },
      });
      await tx.jobRun.update({ where: { id: parent.id }, data: { correlationId: parent.id } });
      const unitRows = planned.map((unit) => ({
        jobName: UNIT_JOB_NAME,
        status: "PENDING",
        priority: unit.sequence,
        maxAttempts: this.maxAttempts,
        correlationId: parent.id,
        payload: { parentRunId: parent.id, ...unit },
      }));
      // One statement for the whole plan. A bounded plan is hundreds of units, and one INSERT
      // round trip each would put the enqueue transaction — and the request that holds it — at the
      // mercy of network latency, well past the interactive-transaction timeout. The per-row
      // fallback keeps clients without createMany working unchanged.
      if (typeof tx.jobRun.createMany === "function") {
        await tx.jobRun.createMany({ data: unitRows });
      } else {
        for (const data of unitRows) {
          // eslint-disable-next-line no-await-in-loop
          await tx.jobRun.create({ data });
        }
      }
      return parent;
    };
    const parent = typeof this.db.$transaction === "function" ? await this.db.$transaction(run) : await run(this.db);
    return { id: parent.id, kind, trigger, plannerVersion: PLANNER_VERSION, totalUnits: planned.length, excludedSources: exclusions, deferredSources, created: true };
  }

  /**
   * The plan `/sync/all` WOULD produce right now, without producing it.
   *
   * Deliberately calls buildSyncPlan with the same arguments createRun does — same kind, same
   * options, same account and account-state loaders, one clock for the whole plan — so a preview
   * cannot drift from what an enqueue would really create. It is a pure read: no JobRun row is
   * created, updated or deleted, no lock is taken, no timestamp is written.
   */
  async previewPlan({ kind = "full", options = {} } = {}) {
    const resolvedOptions = {
      fastSync: Boolean(options.fastSync),
      promoteAfter: options.promoteAfter !== false,
    };
    const plan = await buildSyncPlan({
      kind,
      fastSync: options.fastSync,
      promoteAfter: options.promoteAfter !== false,
      includePostSyncUnits: options.includePostSyncUnits === true,
      listAccounts: this.listAccounts,
      loadAccountState: this.loadAccountState,
      now: this.now(),
    });
    return { ...plan, kind, options: resolvedOptions };
  }

  /**
   * Every active run doing EXACTLY the same work, earliest first. The first is the canonical one.
   *
   * Exact, not breadth-aware: this feeds duplicate collapse, which cancels runs. Reusing a
   * broader run is safe; cancelling one as a "duplicate" of a narrower request is not.
   */
  async listActiveCompatibleRuns({ kind = null, options = null, plannerVersion = null } = {}) {
    void kind;
    const conditions = identityConditions({ options, plannerVersion });
    return this.db.jobRun.findMany({
      where: {
        jobName: ORCHESTRATION_JOB_NAME,
        status: { in: ACTIVE_STATUSES },
        ...(conditions.length ? { AND: conditions } : {}),
      },
      // A TOTAL order every racer computes identically, so they all agree on the same winner.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  /**
   * Cancel a duplicate run and its units — internal race resolution ONLY, never the administrative
   * cancellation that is still to be designed. A duplicate is collapsible only while NOTHING has
   * started: if any unit has left PENDING, a worker may be holding an account lock and doing real
   * work, so the run is left alone and callers are simply steered to the canonical run.
   */
  async collapseDuplicateRun(runId, { reason = "duplicate_active_run", canonicalRunId = null } = {}) {
    const parent = await this.db.jobRun.findUnique({ where: { id: runId } });
    if (!parent || parent.jobName !== ORCHESTRATION_JOB_NAME || !ACTIVE_STATUSES.includes(parent.status)) {
      return { collapsed: false, reason: "already_terminal" };
    }
    // Never collapse a run this planner did not create. A legacy run is not a duplicate of a
    // Phase 5 run — it is different work — and cancelling one as "a duplicate" would destroy an
    // operator's in-flight run. The version filter should already have excluded it; this refuses
    // it outright in case a caller ever passes one in directly.
    if ((parent.payload?.plannerVersion ?? null) !== PLANNER_VERSION) {
      return { collapsed: false, reason: "foreign_planner_version" };
    }
    const units = await this.listUnits(runId);
    if (units.some((unit) => unit.status !== "PENDING")) return { collapsed: false, reason: "work_started" };
    const cancelledAt = this.now();
    const cancel = async (tx) => {
      const { count } = await tx.jobRun.updateMany({
        where: { id: runId, jobName: ORCHESTRATION_JOB_NAME, status: { in: ACTIVE_STATUSES } },
        data: { status: "CANCELLED", completedAt: cancelledAt, lastError: reason },
      });
      // The row can change between the checks above and this write (another instance finishing or
      // collapsing it); the status guard makes the cancel a no-op rather than a resurrection.
      if (count === 0) return { collapsed: false, reason: "already_terminal" };
      await tx.jobRun.updateMany({
        where: { jobName: UNIT_JOB_NAME, correlationId: runId, status: "PENDING" },
        data: { status: "CANCELLED", completedAt: cancelledAt, lastError: reason },
      });
      return { collapsed: true, runId, canonicalRunId };
    };
    return typeof this.db.$transaction === "function" ? this.db.$transaction(cancel) : cancel(this.db);
  }

  /**
   * ADMINISTRATIVE cancellation. Deliberately NOT collapseDuplicateRun.
   *
   * collapseDuplicateRun refuses a run whose units have left PENDING ("work_started"), because as
   * internal race resolution it must never cancel a run that is really doing something. That is
   * exactly the run an operator needs this for, so the restriction is dropped here and replaced by
   * a different safety rule: a RUNNING unit is LEFT RUNNING.
   *
   * Why leave it: a live worker owns that unit's account lock. Forcing the row terminal would hand
   * the lock to another run while supplier writes were still landing — a real race traded for a
   * tidy row. Instead the worker is contained. It cannot append units (appendUnits refuses a
   * terminal run), cannot advance post-sync (advancePostSync refuses one), and cannot complete or
   * fail its unit (both now check the parent). Its claim expires by lease like any other.
   *
   * So cancellation is EVENTUAL, not instantaneous, and the caller is told how many units are
   * still running rather than being implied a dead stop.
   *
   * Current planner only. A foreign-planner run may be executing under code that does not honour
   * these guards, so cancelling it is not proven safe: it is refused, and nothing about it — not
   * its parent, not its units, not the barrier rows it may hold — is touched.
   *
   * This stops FUTURE orchestration. It does not roll back supplier, staging or promotion work
   * that already committed; nothing here attempts to.
   */
  async cancelRun(runId, { reason = ADMIN_CANCELLED_REASON, actor = null } = {}) {
    if (!runId) return { cancelled: false, code: "run_not_found" };
    const parent = await this.db.jobRun.findUnique({ where: { id: runId } });
    if (!parent || parent.jobName !== ORCHESTRATION_JOB_NAME) {
      return { cancelled: false, code: "run_not_found" };
    }
    if ((parent.payload?.plannerVersion ?? null) !== PLANNER_VERSION) {
      return { cancelled: false, code: "run_foreign_planner_version", runId };
    }
    if (TERMINAL_STATUSES.includes(parent.status)) {
      return { cancelled: false, code: "run_already_terminal", runId, status: parent.status };
    }

    const cancelledAt = this.now();
    const cancellation = { reason, cancelledAt: cancelledAt.toISOString(), actor: actor ?? null };
    const apply = async (tx) => {
      // Conditional: a concurrent cancel, or a run finishing on its own, makes this a no-op rather
      // than a resurrection. Whichever writer lands first wins and the other reports terminal.
      const { count } = await tx.jobRun.updateMany({
        where: { id: runId, jobName: ORCHESTRATION_JOB_NAME, status: { in: ACTIVE_STATUSES } },
        data: {
          status: "CANCELLED",
          completedAt: cancelledAt,
          lastError: reason,
          payload: { ...(parent.payload ?? {}), cancellation },
        },
      });
      if (count === 0) return { cancelled: false, code: "run_already_terminal", runId };
      // PENDING units hold no lock and have no worker: safe to terminalise now.
      const { count: unitsCancelled } = await tx.jobRun.updateMany({
        where: { jobName: UNIT_JOB_NAME, correlationId: runId, status: "PENDING" },
        data: { status: "CANCELLED", completedAt: cancelledAt, lastError: reason },
      });
      return { cancelled: true, code: "run_cancelled", runId, unitsCancelled };
    };
    const result = typeof this.db.$transaction === "function" ? await this.db.$transaction(apply) : await apply(this.db);
    if (!result.cancelled) return result;

    const stillRunning = await this.db.jobRun.findMany({
      where: { jobName: UNIT_JOB_NAME, correlationId: runId, status: "RUNNING" },
    });

    // The DERIVED freeze already released: it only scans PENDING/RUNNING parents, and this one is
    // now CANCELLED. The intent MARKER is separate and lease-bounded, so it would lapse on its own
    // within the worker lease — clearing it here is for promptness, not correctness, so a failure
    // to clear must not fail the cancellation.
    let freezeIntentCleared = 0;
    try {
      freezeIntentCleared = await this.barrier.clearFreezeIntent();
    } catch {
      freezeIntentCleared = 0;
    }
    // Staging participants and account locks are deliberately NOT touched: both are held by live
    // workers and both are owned by their leases.

    return {
      ...result,
      status: "CANCELLED",
      cancelledAt: cancellation.cancelledAt,
      unitsLeftRunning: stillRunning.length,
      freezeIntentCleared,
      cancellation,
    };
  }

  /** Collapse every active compatible duplicate after the canonical one. Idempotent. */
  async #collapseDuplicatesOf(canonicalRunId, { options, plannerVersion = null }) {
    const active = await this.listActiveCompatibleRuns({ options, plannerVersion });
    for (const run of active) {
      if (run.id === canonicalRunId) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.collapseDuplicateRun(run.id, { canonicalRunId });
    }
  }

  #reuseView(run, fallbackKind) {
    return {
      id: run.id,
      kind: run.payload?.kind ?? fallbackKind,
      trigger: run.payload?.trigger ?? null,
      options: run.payload?.options ?? null,
      totalUnits: run.payload?.totalUnits ?? null,
      plannerVersion: run.payload?.plannerVersion ?? null,
      excludedSources: run.payload?.excludedSources ?? [],
      deferredSources: run.payload?.deferredSources ?? [],
      created: false,
    };
  }

  /**
   * Resume the active run that does the SAME work, or create one. A reused run reports its own
   * recorded trigger and options, never the caller's, so a resume never misrepresents the run.
   *
   * Concurrency: checking then creating is not atomic, so two instances can both find nothing and
   * both create. Rather than a schema change or a database advisory lock, the race is resolved
   * OPTIMISTICALLY and durably: each racer creates, then re-reads the active compatible runs in a
   * total order both compute identically (createdAt, id). The earliest is canonical; any other
   * racer cancels its own parent and its still-PENDING units and returns the canonical run. The
   * racer that commits last always sees both rows, so exactly one active run survives. The same
   * pass also self-heals a duplicate left behind by an earlier crash.
   */
  async getOrCreateRun({ kind = "full", trigger = "api", options = {}, units = null } = {}) {
    // Reuse is scoped to this planner version: an active run whose units are a different shape —
    // a pre-Phase-5 account-wide run, or one from a future version — is not this request's run,
    // and resuming it would quietly do different work than the caller asked for.
    const plannerVersion = PLANNER_VERSION;
    /**
     * A run that plans ONE source object is not the estate's run, and the estate's run is not
     * its. `scopeKey` says which, and reuse must match it EXACTLY in both directions — otherwise
     * a second Awin-offers request would adopt an unrelated active run and silently do different
     * work, which is the failure findActiveRun exists to prevent for breadth and options.
     *
     * The SQL predicate deliberately does not learn about scope: distinguishing an absent JSON
     * key from a JSON null is driver-dependent, and getting it subtly wrong would be worse than
     * filtering in one obvious line here. A scoped request reads the full compatible list and
     * takes the first exact match; an unscoped one keeps findActiveRun untouched, so /sync/all
     * behaves exactly as it did.
     */
    const scopeKey = options?.scopeKey ?? null;
    const existing = scopeKey
      ? (await this.listActiveCompatibleRuns({ kind, options, plannerVersion })).find(
          (run) => (run.payload?.options?.scopeKey ?? null) === scopeKey,
        ) ?? null
      : await this.#unscopedActiveRun({ kind, options, plannerVersion });
    if (!existing) {
      // Nothing satisfies this request. Before creating a parent, refuse if an INCOMPATIBLE one is
      // already active — otherwise a non-fast request beside an active fast run silently produces
      // a second orchestration parent, which duplicates supplier work and makes /sync/status
      // ambiguous (the unfiltered reader returns the oldest active run and hides the other).
      //
      // Refuse rather than auto-cancel or upgrade. Auto-cancelling infers a destructive act from a
      // request to START something, and "untouched" is a read followed by a write that a worker
      // can claim between. Upgrading would relabel a run whose completed units already ran under
      // the other breadth, making its own record false.
      const blocker = await this.#activeIncompatibleRun({ plannerVersion });
      if (blocker) {
        const error = new Error("An active sync run is incompatible with this request.");
        error.code = "active_run_incompatible";
        error.statusCode = 409;
        error.retryable = true;
        error.activeRunId = blocker.id;
        throw error;
      }
    }
    if (existing) {
      // Collapse duplicates of the run being REUSED, keyed by the options that run actually
      // recorded rather than the ones this request asked for. When a fast request is satisfied by
      // a broader non-fast run, that difference is the whole point: keying the collapse off the
      // request would sweep the reused run's own identity class with the wrong predicate.
      const canonicalOptions = existing.payload?.options ?? options;
      await this.#collapseDuplicatesOf(existing.id, { options: canonicalOptions, plannerVersion });
      return this.#reuseView(existing, kind);
    }

    const created = await this.createRun({ kind, trigger, options, units });

    // Resolve a possible concurrent creation. This read happens after our own rows are committed,
    // so a racer that committed before us is visible here.
    const canonical = (await this.listActiveCompatibleRuns({ options, plannerVersion }))[0] ?? null;
    if (canonical && canonical.id !== created.id) {
      const collapse = await this.collapseDuplicateRun(created.id, { canonicalRunId: canonical.id });
      if (collapse.collapsed) return { ...this.#reuseView(canonical, kind), collapsedRunId: created.id };
      // Our own run could not be collapsed (a worker already claimed a unit): keep it as its own
      // run rather than orphaning started work, and report it truthfully as created.
      return { ...created, options: this.#optionsView(options) };
    }

    await this.#collapseDuplicatesOf(created.id, { options, plannerVersion });
    return { ...created, options: this.#optionsView(options) };
  }

  /** The options a caller is told its run has, in the same shape the payload records. */
  #optionsView(options = {}) {
    return {
      fastSync: Boolean(options.fastSync),
      promoteAfter: options.promoteAfter !== false,
      ...(options.scopeKey ? { scopeKey: String(options.scopeKey) } : {}),
    };
  }

  /**
   * findActiveRun, but never a run that was planned for ONE source object.
   *
   * The compatibility predicate reads breadth and options, not scope, so without this an estate
   * request could adopt an Awin-offers-only run and believe the whole estate was syncing. Such a
   * run is left to the incompatibility check, which reports it and names the cancel route rather
   * than quietly widening it.
   */
  async #unscopedActiveRun({ kind, options, plannerVersion }) {
    const run = await this.findActiveRun({ kind, options, plannerVersion });
    if (!run) return null;
    return (run.payload?.options?.scopeKey ?? null) === null ? run : null;
  }

  /**
   * An active run that this request can NEITHER reuse NOR safely coexist with, or null.
   *
   * Two kinds. A current-planner run whose breadth or options do not satisfy the request — today
   * that is exactly "active fast, non-fast requested", since every other combination is reusable.
   * And ANY active foreign-planner run: its unit shape is different and its worker semantics may
   * predate the cancellation guards, so creating a current-planner parent beside it would put two
   * orchestration systems on the same accounts. It is reported, never mutated.
   */
  async #activeIncompatibleRun({ plannerVersion }) {
    const active = await this.db.jobRun.findMany({
      where: { jobName: ORCHESTRATION_JOB_NAME, status: { in: ACTIVE_STATUSES } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // CURRENT-planner runs only. Reaching here means findActiveRun already declined every one of
    // them, so any that remains is genuinely incompatible — today that is exactly "active fast,
    // non-fast requested", since every other combination is reusable under Phase 8B.
    //
    // A FOREIGN-planner run is deliberately NOT a blocker. The planner-version design guarantees a
    // current run can be created and worked beside a legacy one, and this phase refuses to cancel
    // a foreign run, so blocking on one would leave the estate unable to sync at all with no route
    // to recover. It is surfaced instead — see activeForeignPlannerRun — so it is never silent.
    return active.find((run) => (run.payload?.plannerVersion ?? null) === plannerVersion) ?? null;
  }

  /**
   * The oldest active run from a DIFFERENT planner version, or null. Read-only and never mutated.
   *
   * Surfaced on enqueue so a current-planner run created beside a legacy one is reported rather
   * than silently coexisting with it. An operator seeing this knows two orchestration vocabularies
   * are live on the same accounts and can retire the old one deliberately.
   */
  async activeForeignPlannerRun() {
    const active = await this.db.jobRun.findMany({
      where: { jobName: ORCHESTRATION_JOB_NAME, status: { in: ACTIVE_STATUSES } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const foreign = active.find((run) => (run.payload?.plannerVersion ?? null) !== PLANNER_VERSION);
    return foreign ? { id: foreign.id, plannerVersion: foreign.payload?.plannerVersion ?? null } : null;
  }

  /**
   * Append units to a run that is already in flight, after the units it exists for.
   *
   * Used by the follow-on materialisation below: a unit whose scope is only knowable once another
   * unit has run cannot be planned at enqueue time, and dropping it would silently omit the work.
   * Appending is safe for the projection — the parent's counters are recomputed from its units on
   * every refresh — and it is IDEMPOTENT: a descriptor whose identity already exists on the run is
   * skipped, so a replayed completion cannot double-plan a chunk.
   *
   * It refuses a run that is already terminal: resurrecting a finished run would make its recorded
   * outcome a lie.
   */
  async appendUnits(runId, units = []) {
    if (!runId || !units.length) return { appended: 0, skipped: 0 };
    const parent = await this.db.jobRun.findUnique({ where: { id: runId } });
    if (!parent || parent.jobName !== ORCHESTRATION_JOB_NAME) return { appended: 0, skipped: 0, reason: "not_found" };
    if (TERMINAL_STATUSES.includes(parent.status)) return { appended: 0, skipped: units.length, reason: "run_terminal" };

    const existing = await this.listUnits(runId);
    const identities = new Set(existing.map((unit) => unitIdentity(unit.payload ?? {})));
    let sequence = existing.reduce((max, unit) => Math.max(max, unit.priority ?? 0), 0);
    let appended = 0;
    let skipped = 0;
    for (const unit of units) {
      if (identities.has(unitIdentity(unit))) {
        skipped += 1;
        continue;
      }
      sequence += 1;
      identities.add(unitIdentity({ ...unit, sequence }));
      // eslint-disable-next-line no-await-in-loop
      await this.db.jobRun.create({
        data: {
          jobName: UNIT_JOB_NAME,
          status: "PENDING",
          priority: sequence,
          maxAttempts: this.maxAttempts,
          correlationId: runId,
          payload: { parentRunId: runId, ...unit, sequence, lockKey: unitLockKey(unit) },
        },
      });
      appended += 1;
    }
    if (appended > 0) {
      // Two workers can reach this at the same moment (a retried invocation, a replayed
      // completion): both read the same empty identity set and both create. The pre-check above
      // cannot prevent that, so the duplicates are collapsed durably afterwards — every racer
      // computes the same identity for the same work, so they converge on the same survivor.
      const removed = await this.#collapseDuplicateUnits(runId);
      const units = await this.listUnits(runId);
      await this.db.jobRun.update({
        where: { id: runId },
        data: { payload: { ...(parent.payload ?? {}), totalUnits: units.length } },
      });
      await this.refreshRun(runId);
      return { appended: appended - removed, skipped: skipped + removed };
    }
    return { appended, skipped };
  }

  /**
   * Delete units that duplicate work already planned on this run, keeping the earliest.
   *
   * Deleted rather than cancelled on purpose: a CANCELLED unit counts as a failed unit in the
   * parent's projection, and a row this code created twice by accident is not a failure of the
   * run. Only a still-PENDING duplicate is removed, so a unit another worker has already claimed
   * is never pulled out from under it.
   */
  async #collapseDuplicateUnits(runId) {
    const units = await this.listUnits(runId);
    const seen = new Set();
    const duplicates = [];
    const ordered = [...units].sort(
      (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const unit of ordered) {
      const identity = unitIdentity(unit.payload ?? {});
      if (!seen.has(identity)) {
        seen.add(identity);
        continue;
      }
      duplicates.push(unit);
    }
    let removed = 0;
    for (const duplicate of duplicates) {
      // eslint-disable-next-line no-await-in-loop
      const { count } = await this.db.jobRun.deleteMany({
        where: { id: duplicate.id, jobName: UNIT_JOB_NAME, status: "PENDING" },
      });
      removed += count;
    }
    return removed;
  }

  /**
   * How many units of one account's source object are still in flight, EXCLUDING any that are
   * already terminal. The unit whose completion triggered this is terminal by then, so a lone
   * final slice counts zero and the deferred work proceeds.
   */
  async #unsettledUnitsFor(runId, { platform, accountLabel, sourceObject, excludeUnitId = null }) {
    const units = await this.listUnits(runId);
    return units.filter(
      (unit) =>
        unit.id !== excludeUnitId &&
        unit.payload?.platform === platform &&
        unit.payload?.accountLabel === accountLabel &&
        unit.payload?.sourceObject === sourceObject &&
        !TERMINAL_STATUSES.includes(unit.status),
    ).length;
  }

  /**
   * Record on the parent that a deferred source object has been materialised — including when it
   * materialised ZERO units because the account had no eligible campaigns. Without this a run
   * would keep reporting work that is never coming.
   */
  async #resolveDeferredSource(runId, { platform, accountLabel, sourceObject }, { units = 0 } = {}) {
    const parent = await this.db.jobRun.findUnique({ where: { id: runId } });
    const deferred = parent?.payload?.deferredSources;
    if (!Array.isArray(deferred) || !deferred.length) return false;
    const resolvedAt = this.now().toISOString();
    const next = deferred.map((entry) =>
      entry.platform === platform && entry.accountLabel === accountLabel && entry.sourceObject === sourceObject
        ? { ...entry, status: "materialised", units, resolvedAt }
        : entry,
    );
    await this.db.jobRun.update({
      where: { id: runId },
      data: { payload: { ...(parent.payload ?? {}), deferredSources: next } },
    });
    return true;
  }

  /**
   * Materialise the units that a just-completed unit unlocks.
   *
   * Optimise commission groups are the case this exists for: the work is one supplier request per
   * campaign, so a unit has to name a campaign slice, and the campaign list is only known once the
   * account's campaigns unit has staged it. Discovery is a single read of those staged rows — no
   * supplier call — and the chunks are appended to the same run under the SAME account lock.
   */
  async materialiseFollowOnUnits(runId, descriptor = {}, outcome = null, { completingUnitId = null } = {}) {
    const platform = text(descriptor?.platform);
    const sourceObject = text(descriptor?.sourceObject);
    if (!runId || !platform || !sourceObject) return { appended: 0, skipped: 0 };
    const accountLabel = text(descriptor?.accountLabel) ?? "default";

    // A paged source plans its NEXT slice from what the supplier just said, and nothing else
    // happens until the catalog is fully walked.
    const pagination = accountOutcome(outcome, accountLabel)?.campaignPage ?? null;
    const continuation = nextPagedUnit({ ...descriptor, platform, accountLabel }, pagination);
    if (continuation) {
      const appended = await this.appendUnits(runId, [{
        kind: UNIT_KINDS.NETWORK,
        platform,
        accountLabel,
        sourceObject,
        options: { ...(descriptor?.options ?? {}), promoteAfter: false },
        ...continuation,
      }]);
      return { ...appended, continued: true };
    }

    const targets = sourcesMaterialisedAfter(platform, sourceObject);
    if (!targets.includes(OPTIMISE_COMMISSION_GROUPS_SOURCE)) return { appended: 0, skipped: 0 };

    // Commission groups are planned from the STAGED campaign list, so they may only be planned
    // once every slice of that list has settled — including slices another worker is still on.
    const outstanding = await this.#unsettledUnitsFor(runId, {
      platform,
      accountLabel,
      sourceObject,
      // The unit whose completion brought us here has done its supplier work and staged its rows;
      // the caller completes it immediately after. Counting it would deadlock the deferral.
      excludeUnitId: completingUnitId,
    });
    if (outstanding > 0) return { appended: 0, skipped: 0, waitingOnUnits: outstanding };
    const key = { platform, accountLabel, sourceObject: OPTIMISE_COMMISSION_GROUPS_SOURCE };
    const plan = await this.planCommissionGroupChunks({ platform, accountLabel });
    const chunks = plan?.chunks ?? [];
    if (!chunks.length) {
      // A successful campaigns fetch with no eligible campaign is a RESOLVED deferral, not a
      // pending one: there is no commission-group work for this account, and the run must be
      // free to settle instead of waiting for units that will never exist.
      const resolved = await this.#resolveDeferredSource(runId, key, { units: 0 });
      return { appended: 0, skipped: 0, units: 0, resolved };
    }
    const options = { ...(descriptor?.options ?? {}), promoteAfter: false };
    const result = await this.appendUnits(
      runId,
      chunks.map((chunk) => ({
        kind: UNIT_KINDS.NETWORK,
        platform,
        accountLabel,
        sourceObject: OPTIMISE_COMMISSION_GROUPS_SOURCE,
        campaignChunkIndex: chunk.index,
        campaignChunkCount: chunks.length,
        campaignIds: [...chunk.campaignIds],
        options,
      })),
    );
    // The deferral is only resolved once the rows exist. A failed or refused append leaves it
    // pending, so the work stays visible and the next attempt picks it up.
    if (result.reason) return { ...result, units: chunks.length, resolved: false };
    const resolved = await this.#resolveDeferredSource(runId, key, { units: chunks.length });
    return { ...result, units: chunks.length, resolved };
  }

  async listUnits(runId) {
    return this.db.jobRun.findMany({
      where: { jobName: UNIT_JOB_NAME, correlationId: runId },
      orderBy: [{ priority: "asc" }],
    });
  }

  /**
   * The next unit to work: lowest sequence that is PENDING, or RUNNING with an expired lease.
   * Non-executable units are never offered — a worker cannot pick up an unbounded stage by accident.
   */
  async nextUnit(runId) {
    const staleBefore = new Date(this.now().getTime() - this.leaseMs);
    const units = await this.listUnits(runId);
    return (
      units.find(
        (u) =>
          isUnitExecutable(u) &&
          (u.status === "PENDING" || (u.status === "RUNNING" && u.startedAt && new Date(u.startedAt) < staleBefore)),
      ) ?? null
    );
  }

  /**
   * Any live holder of the key — another orchestration unit OR an explicit lock row taken by a
   * different path (e.g. the manual per-network route) — or null. Delegated to the shared service
   * so both paths see each other across instances.
   */
  async lockHolder(lockKey, { excludeUnitId = null } = {}) {
    return this.locks.findHolder(lockKey, { excludeId: excludeUnitId });
  }

  /**
   * Atomically claim a unit for this worker. Exactly one of concurrent claimers wins: the claim
   * is a conditional update (PENDING → RUNNING, or RUNNING with an EXPIRED lease → RUNNING).
   * Refused with `lock_held` when the unit's lock key is RUNNING elsewhere under a live lease.
   */
  async claimUnit(unitId, { workerId = null } = {}) {
    const unit = await this.db.jobRun.findUnique({ where: { id: unitId } });
    if (!unit || unit.jobName !== UNIT_JOB_NAME) return { claimed: false, reason: "not_found" };
    if (!isUnitExecutable(unit)) {
      return { claimed: false, reason: "not_executable", blockedReason: unit.payload?.blockedReason ?? UNIT_BLOCKED_REASON };
    }
    const lockKey = unit.payload?.lockKey ?? null;
    if (lockKey) {
      const holder = await this.lockHolder(lockKey, { excludeUnitId: unitId });
      if (holder) return { claimed: false, reason: "lock_held", heldBy: holder.id };
    }
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.leaseMs);
    const leaseExpired = unit.status === "RUNNING" && unit.startedAt && new Date(unit.startedAt) < staleBefore;
    // An expired claim IS an abandoned attempt: it was counted when the unit was claimed, and the
    // worker that took it never reported an outcome. maxAttempts is therefore enforced here as
    // well as on an explicit failure — otherwise a unit whose worker keeps dying would be
    // reclaimed for ever and its run could never terminate.
    if (leaseExpired && (unit.attempt ?? 0) >= (unit.maxAttempts ?? this.maxAttempts)) {
      const abandoned = await this.abandonStaleUnit(unit.id, { staleBefore });
      return abandoned.abandoned
        ? { claimed: false, reason: "abandoned", status: "DEAD_LETTER", unitId, attempt: abandoned.attempt, abandonedReason: ABANDONED_UNIT_REASON }
        : { claimed: false, reason: "already_claimed" };
    }
    const previousWorker = unit.status === "RUNNING" ? unit.result?.claim?.workerId ?? null : null;
    const claim = { workerId, claimedAt: now.toISOString(), ...(unit.status === "RUNNING" ? { reclaimedFrom: previousWorker } : {}) };
    const data = { status: "RUNNING", startedAt: now, attempt: { increment: 1 }, result: { ...(unit.result ?? {}), claim } };
    const fresh = await this.db.jobRun.updateMany({ where: { id: unitId, status: "PENDING" }, data });
    if (fresh.count === 1) return { claimed: true, reclaimed: false, unitId };
    const stale = await this.db.jobRun.updateMany({ where: { id: unitId, status: "RUNNING", startedAt: { lt: staleBefore } }, data });
    if (stale.count === 1) return { claimed: true, reclaimed: true, unitId };
    return { claimed: false, reason: "already_claimed" };
  }

  /**
   * Terminalise a unit whose worker died with no attempts left: DEAD_LETTER with a safe reason and
   * consistent terminal timestamps, then refresh the parent so the existing failure precedence
   * finalises the run. The transition is conditional on the row still being the same expired
   * RUNNING claim, so two workers racing on it produce exactly one terminalisation and no extra
   * attempt. Once terminal the unit is no longer RUNNING, so it no longer holds its account lock.
   */
  async abandonStaleUnit(unitId, { staleBefore = null, reason = ABANDONED_UNIT_REASON } = {}) {
    const cutoff = staleBefore ?? new Date(this.now().getTime() - this.leaseMs);
    const at = this.now();
    const { count } = await this.db.jobRun.updateMany({
      where: { id: unitId, jobName: UNIT_JOB_NAME, status: "RUNNING", startedAt: { lt: cutoff } },
      data: { status: "DEAD_LETTER", completedAt: at, lastError: reason },
    });
    if (count !== 1) return { abandoned: false, reason: "already_terminal" };
    const unit = await this.db.jobRun.findUnique({ where: { id: unitId } });
    await this.refreshRun(unit?.correlationId);
    return { abandoned: true, unitId, attempt: unit?.attempt ?? null, reason };
  }

  /**
   * Record a unit's success — conditionally.
   *
   * This used to be an unconditional update by id, which was the one way an in-flight worker could
   * defeat an administrative cancellation: it would flip its own CANCELLED unit back to COMPLETED
   * under a CANCELLED parent, leaving the run's record contradicting itself. Two guards close it:
   * the unit must still be the RUNNING row this worker claimed, and the parent must still be
   * active.
   *
   * A cancelled parent is NOT an error. The worker's supplier work already committed — that cannot
   * be unwound — so the honest outcome is "the run this belonged to was stopped", recorded on the
   * unit's own result for an operator to find, with no status change and no parent refresh.
   */
  async completeUnit(unitId, outcome = null) {
    const unit = await this.db.jobRun.findUnique({ where: { id: unitId } });
    if (!unit) return null;
    const parentActive = await this.#parentIsActive(unit.correlationId);
    if (!parentActive) {
      await this.#recordTerminalParentOutcome(unit, outcome, "completed_after_run_terminal");
      return this.db.jobRun.findUnique({ where: { id: unitId } });
    }
    const { count } = await this.db.jobRun.updateMany({
      where: { id: unitId, jobName: UNIT_JOB_NAME, status: "RUNNING" },
      data: { status: "COMPLETED", progress: 100, completedAt: this.now(), lastError: null, result: { ...(unit.result ?? {}), outcome: outcome ?? null } },
    });
    if (count !== 1) {
      // Someone else terminalised it between the read and the write (a cancel, or a reclaim that
      // abandoned it). Leave it alone and do not refresh a parent on its behalf.
      await this.#recordTerminalParentOutcome(unit, outcome, "completed_after_unit_terminal");
      return this.db.jobRun.findUnique({ where: { id: unitId } });
    }
    await this.refreshRun(unit.correlationId);
    return this.db.jobRun.findUnique({ where: { id: unitId } });
  }

  /** True when the unit's parent is still PENDING/RUNNING. A missing parent counts as inactive. */
  async #parentIsActive(runId) {
    if (!runId) return false;
    const parent = await this.db.jobRun.findUnique({ where: { id: runId } });
    if (!parent || parent.jobName !== ORCHESTRATION_JOB_NAME) return false;
    return ACTIVE_STATUSES.includes(parent.status);
  }

  /**
   * Keep the worker's outcome without changing the unit's lifecycle.
   *
   * Written to `result` only, and only while the row is unchanged, so a late worker leaves a trace
   * an operator can read rather than silently discarding what it did. It never resurrects a
   * terminal row and never touches the parent.
   */
  async #recordTerminalParentOutcome(unit, outcome, reason) {
    await this.db.jobRun.updateMany({
      where: { id: unit.id, jobName: UNIT_JOB_NAME },
      data: {
        result: {
          ...(unit.result ?? {}),
          outcome: outcome ?? null,
          discardedOutcome: { reason, at: this.now().toISOString() },
        },
      },
    });
  }

  /** Retryable while attempts remain (back to PENDING, no sleep); DEAD_LETTER otherwise. */
  /**
   * Hand a claimed unit BACK without consuming an attempt.
   *
   * A staging freeze is a temporary condition owned by ANOTHER run's post-sync phase. A second
   * orchestration run whose network unit cannot stage right now has done nothing wrong, and three
   * such invocations must not dead-letter work that would succeed an hour later. So the claim is
   * undone rather than recorded: status back to PENDING, the lease dropped, and the attempt
   * decremented by exactly the one that claimUnit added.
   */
  async deferUnit(unitId, { reason = STAGING_FROZEN_CODE, workerId = null } = {}) {
    const unit = await this.db.jobRun.findUnique({ where: { id: unitId } });
    if (!unit) return null;

    // Only a unit this caller is CURRENTLY holding may be handed back. Each of these guards closes
    // a way the naive "update by id" version could corrupt state:
    //   - not RUNNING  → it completed, failed or dead-lettered while we were away; reviving it to
    //                    PENDING would re-run finished work or resurrect terminal work.
    //   - another claim → its lease expired and a second worker took it; returning it would drop
    //                    that worker's claim out from under it.
    //   - attempt 0    → nothing to give back; decrementing would go negative and hand the unit
    //                    more attempts than maxAttempts allows.
    if (unit.status !== "RUNNING") return unit;
    const holder = unit.result?.claim?.workerId ?? null;
    if (workerId && holder && holder !== workerId) return unit;
    if ((unit.attempt ?? 0) <= 0) return unit;

    // Conditional on RUNNING, so two concurrent deferrals cannot both apply: the first flips the
    // row to PENDING and the second matches nothing. The attempt is written as an ABSOLUTE value
    // computed from the row we read and clamped at zero, never as a blind decrement.
    const { count } = await this.db.jobRun.updateMany({
      where: { id: unitId, jobName: UNIT_JOB_NAME, status: "RUNNING" },
      data: {
        status: "PENDING",
        startedAt: null,
        attempt: Math.max(0, (unit.attempt ?? 1) - 1),
        // Visible, but NOT lastError: this is not a failure and must not read as one, and it must
        // not overwrite a real execution error recorded by an earlier attempt.
        result: { ...(unit.result ?? {}), deferred: { reason, at: this.now().toISOString() } },
      },
    });
    if (!count) return unit;
    await this.refreshRun(unit.correlationId);
    return this.db.jobRun.findUnique({ where: { id: unitId } });
  }

  /**
   * Record a unit's failure — conditionally, for the same reason completeUnit is.
   *
   * The retry branch is the sharper hazard: it sets status back to PENDING, so an unguarded write
   * would make a CANCELLED unit look runnable again. It is inert today only because
   * nextWorkableUnit filters parents by ACTIVE_STATUSES, which is a guarantee living in a
   * different function. Guard it here too rather than rely on that.
   */
  async failUnit(unitId, error) {
    const unit = await this.db.jobRun.findUnique({ where: { id: unitId } });
    if (!unit) return null;
    const message = String(error?.message ?? error ?? "unit failed").slice(0, 2000);
    const parentActive = await this.#parentIsActive(unit.correlationId);
    if (!parentActive) {
      await this.#recordTerminalParentOutcome(unit, null, "failed_after_run_terminal");
      return this.db.jobRun.findUnique({ where: { id: unitId } });
    }
    const retry = (unit.attempt ?? 0) < (unit.maxAttempts ?? this.maxAttempts);
    const { count } = await this.db.jobRun.updateMany({
      where: { id: unitId, jobName: UNIT_JOB_NAME, status: "RUNNING" },
      data: retry
        ? { status: "PENDING", lastError: message }
        : { status: "DEAD_LETTER", lastError: message, completedAt: this.now() },
    });
    if (count !== 1) {
      await this.#recordTerminalParentOutcome(unit, null, "failed_after_unit_terminal");
      return this.db.jobRun.findUnique({ where: { id: unitId } });
    }
    await this.refreshRun(unit.correlationId);
    return this.db.jobRun.findUnique({ where: { id: unitId } });
  }

  /** Recompute the parent's counters/progress from its units; finalise when every unit is terminal. */
  /**
   * Advance the parent through the post-sync stages, appending at most one stage's seeds.
   *
   * This is the Phase 6d gate. It is a pure read of durable rows followed by an idempotent append:
   * no entity scan, no supplier call, no clock except the run's own immutable start, and no module
   * memory. Two workers that reach it at the same moment compute the same seeds and `appendUnits`
   * collapses them to one, so a race, a replayed completion and a worker that died between the
   * append and the refresh all converge on the same rows.
   *
   * It never skips a stage and never advances past a failure.
   */
  async advancePostSync(runId) {
    if (!runId) return { stage: null, appended: 0, reason: "no_run" };
    const parent = await this.db.jobRun.findUnique({ where: { id: runId } });
    if (!parent || parent.jobName !== ORCHESTRATION_JOB_NAME) {
      return { stage: null, appended: 0, reason: "not_found" };
    }
    if (TERMINAL_STATUSES.includes(parent.status)) {
      return { stage: null, appended: 0, reason: "run_terminal" };
    }
    // A run from an older planner has a different unit shape; seeding bounded stages into it would
    // mix two vocabularies on one parent.
    if ((parent.payload?.plannerVersion ?? null) !== PLANNER_VERSION) {
      return { stage: null, appended: 0, reason: "planner_version_mismatch" };
    }
    const postSyncStages = parent.payload?.postSyncStages ?? "none";
    if (postSyncStages === "none") return { stage: POST_SYNC_STAGES.NONE, appended: 0, reason: "post_sync_not_requested" };

    const units = await this.listUnits(runId);
    const plan = planPostSyncTransition(units, {
      postSyncRequested: true,
      deferredSources: parent.payload?.deferredSources ?? [],
      // PINNED, never the wall clock: a run materialised days later must rebuild the fortnight it
      // gathered data for, not the fortnight around whenever a worker happened to reach it.
      runStartedAt: parent.startedAt ?? parent.createdAt ?? null,
    });
    if (!plan.seeds.length) {
      return { stage: plan.stage, appended: 0, reason: plan.reason, ...(plan.failureStage ? { failureStage: plan.failureStage } : {}) };
    }

    // THE transition. Seeding the first promotion units is the moment the Entity cursor walks
    // begin, so it is the moment staging must already have stopped. Announce the intent FIRST so a
    // stager racing this call sees it, THEN look for participants already in flight. If any are,
    // the marker stays up — new stagers keep refusing, in-flight ones drain, and a later invocation
    // seeds. Releasing the marker here instead would let the two sides abort each other forever.
    //
    // Every LATER seed (coupons, offers, conversion pages, aggregation days) needs no handshake:
    // bounded promotion units already exist by then, so the DERIVED freeze is authoritative.
    if (plan.reason === "promotion_campaign_seeded") {
      await this.barrier.announceFreezeIntent({ correlationId: runId });
      const inFlight = await this.barrier.activeParticipants();
      if (inFlight.length) {
        // A deferral, not a failure: nothing is seeded, nothing is consumed, and the caller is told
        // exactly why so a stalled run can be explained from its rows.
        return { stage: plan.stage, appended: 0, reason: "staging_in_flight", stagingParticipants: inFlight.length };
      }
    }

    // An old planner's placeholder for a stage we are now seeding becomes a historical marker. It
    // is never executed and never deleted; it simply stops standing for work that now exists.
    const seededKinds = new Set(plan.seeds.map((seed) => seed.kind));
    await this.#supersedePlaceholders(runId, units, seededKinds);

    const appended = await this.appendUnits(runId, plan.seeds);

    // Record what could not be recomputed safely: the pinned window, and that post-sync has begun.
    const fresh = await this.db.jobRun.findUnique({ where: { id: runId } });
    const payload = fresh?.payload ?? parent.payload ?? {};
    const postSync = { ...(payload.postSync ?? {}) };
    if (plan.window && !postSync.aggregation) {
      postSync.aggregation = { ...plan.window, pinnedTo: parent.startedAt ? "startedAt" : "createdAt" };
    }
    await this.db.jobRun.update({
      where: { id: runId },
      data: { payload: { ...payload, postSyncStages: "materialised", postSync } },
    });
    // The bounded promotion units now exist, so the derived freeze holds on its own and the marker
    // is redundant. Dropping it means a gate that dies later cannot leave a lease-shaped freeze
    // behind that outlives the walk it was protecting.
    if (plan.reason === "promotion_campaign_seeded") await this.barrier.clearFreezeIntent();
    return { stage: plan.stage, appended: appended.appended ?? 0, skipped: appended.skipped ?? 0, reason: plan.reason, ...(plan.window ? { window: plan.window } : {}) };
  }

  /**
   * Mark a stage's inert placeholders as superseded by the bounded units just seeded.
   *
   * A payload write only: no status change, so a placeholder can never be counted as a failure,
   * and no row is removed, so the original plan stays auditable.
   */
  async #supersedePlaceholders(runId, units, kinds) {
    const at = this.now().toISOString();
    for (const unit of units) {
      const descriptor = unit.payload ?? {};
      if (descriptor.executable !== false) continue;
      if (descriptor.kind === UNIT_KINDS.NETWORK) continue;
      if (!kinds.has(descriptor.kind)) continue;
      if (descriptor.supersededBy) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.db.jobRun.update({
        where: { id: unit.id },
        data: { payload: { ...descriptor, supersededBy: "bounded_units", supersededAt: at } },
      });
    }
  }

  async refreshRun(runId) {
    if (!runId) return null;
    const [parent, units] = await Promise.all([this.db.jobRun.findUnique({ where: { id: runId } }), this.listUnits(runId)]);
    if (!parent) return null;
    const postSyncStages = parent.payload?.postSyncStages ?? "none";
    const summary = summarizeUnits(units, {
      postSyncStages,
      postSyncMayAppend: postSyncMayAppendUnits(units, { postSyncRequested: postSyncStages !== "none" }),
    });
    const data = {
      // The Int column carries the progress of the units that exist; the nullable overall
      // percentage lives in `result`, where "unknown" can be represented truthfully.
      progress: summary.unitsPercentComplete,
      result: {
        totalUnits: summary.totalUnits,
        completedUnits: summary.completedUnits,
        failedUnits: summary.failedUnits,
        cancelledUnits: summary.cancelledUnits,
        pendingUnits: summary.pendingUnits,
        runningUnits: summary.runningUnits,
        blockedUnits: summary.blockedUnits,
        supersededUnits: summary.supersededUnits,
        unitsPercentComplete: summary.unitsPercentComplete,
        percentComplete: summary.percentComplete,
        totalWorkKnown: summary.totalWorkKnown,
        status: summary.status,
        latestError: summary.latestError,
        latestWarning: summary.latestWarning,
        currentUnit: unitView(summary.current),
      },
    };
    if (summary.finished && !TERMINAL_STATUSES.includes(parent.status)) {
      data.status = summary.failedUnits > 0 ? "FAILED" : "COMPLETED";
      data.completedAt = this.now();
      data.lastError = summary.latestError;
      // WHICH stage failed, durably. The database status stays exactly as it was — FAILED is still
      // FAILED — but a successful 134-unit network phase must never be readable as a network
      // failure because an aggregation day dead-lettered days later.
      const failureStage = summary.failedUnits > 0 ? failureStageOf(units) : null;
      if (failureStage) {
        data.payload = { ...(parent.payload ?? {}), failureStage };
      }
    }
    return this.db.jobRun.update({ where: { id: runId }, data });
  }

  /**
   * A safe, durable summary of one unit row: identity, lifecycle and lease only. No supplier
   * payload, no credentials, no raw sync result — the stored outcome counts are reported as
   * counts, and any error text is redacted.
   */
  unitSummary(unit) {
    const p = unit?.payload ?? {};
    const startedAt = unit?.startedAt ?? null;
    const leaseExpiresAt = startedAt && unit?.status === "RUNNING"
      ? new Date(new Date(startedAt).getTime() + this.leaseMs)
      : null;
    const outcome = unit?.result?.outcome ?? null;
    return {
      unitId: unit?.id ?? null,
      sequence: p.sequence ?? unit?.priority ?? null,
      kind: p.kind ?? null,
      // The calendar day an aggregation unit rebuilds; null for every other kind.
      day: p.day ?? null,
      // The page a promotion or conversion-promotion unit walks. Position only — never an entity
      // payload.
      networkSource: p.networkSource ?? null,
      entityType: p.entityType ?? null,
      cursorId: p.cursorId ?? null,
      platform: p.platform ?? null,
      accountLabel: p.accountLabel ?? null,
      sourceObject: p.sourceObject ?? null,
      window: unitWindow(p),
      campaignChunk: unitCampaignChunk(p),
      campaignPage: unitCampaignPage(p),
      lockKey: p.lockKey ?? null,
      status: unit?.status ?? null,
      attempt: unit?.attempt ?? 0,
      maxAttempts: unit?.maxAttempts ?? null,
      executable: isUnitExecutable(unit),
      blockedReason: isUnitExecutable(unit) ? null : (p.blockedReason ?? UNIT_BLOCKED_REASON),
      startedAt,
      completedAt: unit?.completedAt ?? null,
      leaseExpiresAt,
      // A RUNNING unit whose lease has expired: its worker died or was killed mid-flight, and the
      // unit is reclaimable by the next worker.
      staleClaim: Boolean(leaseExpiresAt && leaseExpiresAt <= this.now()),
      counts: outcome?.counts ?? null,
      partialSuccess: outcome?.partialSuccess ?? null,
      lastError: safeUnitError(unit?.lastError),
    };
  }

  /** Read-only per-unit summaries of a run, in execution order. Never mutates. */
  async listUnitSummaries(runId) {
    const units = await this.listUnits(runId);
    return units.map((unit) => this.unitSummary(unit));
  }

  /**
   * Read-only inspection of one run: the durable projection plus safe per-unit summaries.
   * Performs NO write: it never refreshes, claims, collapses or resumes anything.
   */
  async inspectRun(runId) {
    const run = await this.describeRun(runId);
    if (!run) return null;
    return { ...run, units: await this.listUnitSummaries(runId) };
  }

  /** The run to show when no id is given: the active one, else the most recent. Read-only. */
  async inspectLatestRun() {
    const active = await this.findActiveRun();
    const parent = active ?? (await this.db.jobRun.findFirst({ where: { jobName: ORCHESTRATION_JOB_NAME }, orderBy: [{ createdAt: "desc" }] }));
    return parent ? this.inspectRun(parent.id) : null;
  }

  /**
   * The oldest active run that has executable work, with the one unit to work next, or null.
   * Non-executable units are never offered (see nextUnit), so a worker cannot reach an unbounded
   * stage; a run whose remaining work is all blocked is simply skipped.
   */
  async nextWorkableUnit() {
    const runs = await this.db.jobRun.findMany({
      where: {
        jobName: ORCHESTRATION_JOB_NAME,
        status: { in: ACTIVE_STATUSES },
        // Only runs THIS planner created. A run from an older planner is a different shape of
        // work — its units are whole accounts, which is exactly what could not fit an invocation
        // — and a worker must never execute one by picking up the oldest active run. The
        // condition matches an exact stored value, so an unversioned legacy run is selected by
        // nothing. It is left alone, not cancelled: retiring it is a deliberate administrative
        // act, not a side effect of asking for work.
        AND: compatibilityConditions({ plannerVersion: PLANNER_VERSION }),
      },
      // Unchanged among current-version runs: a TOTAL order every worker computes identically.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const run of runs) {
      // eslint-disable-next-line no-await-in-loop
      const unit = await this.nextUnit(run.id);
      if (unit) return { run, unit };
      // Nothing workable on this run. That is exactly the moment a post-sync stage may be ready to
      // open: the previous stage has settled and its successor has not been seeded. Seeding here
      // also repairs a run whose worker died between appending a continuation and refreshing the
      // parent, because the gate reads rows and not what that worker was about to do.
      // eslint-disable-next-line no-await-in-loop
      const advanced = await this.advancePostSync(run.id);
      if (!advanced?.appended) continue;
      // eslint-disable-next-line no-await-in-loop
      const seeded = await this.nextUnit(run.id);
      if (seeded) return { run, unit: seeded };
    }
    return null;
  }

  /** Durable status projection of one run (null when unknown). */
  async describeRun(runId) {
    if (!runId) return null;
    const parent = await this.db.jobRun.findUnique({ where: { id: runId } });
    if (!parent || parent.jobName !== ORCHESTRATION_JOB_NAME) return null;
    const units = await this.listUnits(runId);
    const postSyncStages = parent.payload?.postSyncStages ?? "none";
    const postSyncRequested = postSyncStages !== "none";
    const postSyncMayAppend = postSyncMayAppendUnits(units, { postSyncRequested });
    const summary = summarizeUnits(units, { postSyncStages, postSyncMayAppend });
    // A cancelled run is reported as cancelled at every point, finished or not. It used to fall
    // into the "not COMPLETED, therefore failed" branch, so a deliberate stop read as a broken
    // sync. Cancellation STOPS future orchestration; it does not undo committed work, and it is
    // not a failure of the work that did run.
    const cancellation = parent.payload?.cancellation ?? null;
    const status = parent.status === "CANCELLED"
      ? "cancelled"
      : TERMINAL_STATUSES.includes(parent.status) && !summary.finished
        ? (parent.status === "COMPLETED" ? "success" : "failed")
        : summary.status;
    const current = unitView(summary.current);
    const kind = parent.payload?.kind ?? null;
    const deferredSources = (parent.payload?.deferredSources ?? []).map((entry) => ({
      ...entry,
      status: entry.status ?? "pending",
      units: entry.units ?? null,
    }));
    const deferredPending = deferredSources.some((entry) => entry.status === "pending");
    return {
      runId: parent.id,
      kind,
      // null for a run planned before versioning existed: its units are whole accounts.
      plannerVersion: parent.payload?.plannerVersion ?? null,
      status,
      trigger: parent.payload?.trigger ?? null,
      startedAt: parent.startedAt ?? parent.createdAt ?? null,
      finishedAt: parent.completedAt ?? null,
      totalUnits: summary.totalUnits,
      completedUnits: summary.completedUnits,
      failedUnits: summary.failedUnits,
      cancelledUnits: summary.cancelledUnits,
      pendingUnits: summary.pendingUnits,
      runningUnits: summary.runningUnits,
      blockedUnits: summary.blockedUnits,
      // Inert planning markers from an older planner whose work now exists as bounded units.
      supersededUnits: summary.supersededUnits,
      postSyncStages,
      // The stage the run is in, DERIVED from its rows rather than read from a stored label: a
      // payload can be written by one worker and read by another mid-transition, and rows cannot
      // disagree with themselves. One of awaiting_post_sync, promoting, conversion_promoting,
      // aggregating, completed, failed or none.
      postSyncStage: postSyncStageOf(units, {
        postSyncRequested,
        deferredSources: parent.payload?.deferredSources ?? [],
      }),
      // The stage a permanent failure belongs to, or null. Distinct from the database status so a
      // post-sync failure is never mistaken for a network one.
      failureStage: failureStageOf(units) ?? parent.payload?.failureStage ?? null,
      // The window the aggregation days were pinned to, once they exist.
      postSyncAggregation: parent.payload?.postSync?.aggregation ?? null,
      // What this run does NOT cover, and why. Empty for a run with nothing excluded.
      excludedSources: parent.payload?.excludedSources ?? [],
      // Source objects whose units are planned by another unit's completion. Each entry carries
      // its own state: "pending" (not materialised yet) or "materialised" with the number of
      // units it produced — zero when the account had no eligible campaign.
      deferredSources,
      // True while any deferred source is still unmaterialised. While it is true `totalUnits` is
      // a floor, not a total: completing the unit a deferral depends on legitimately ADDS units.
      deferredPending,
      // True while ANY stage can still add units: a deferred network source, a cursor walk that
      // can append a continuation, or a post-sync stage that has not been seeded yet. It becomes
      // false only once the aggregation days exist, because an aggregation unit is one day and
      // appends nothing. While it is true `totalUnits` is a floor, not a total.
      totalUnitsMayIncrease: deferredPending || postSyncMayAppend,
      // Post-sync work that still has to happen: requested (deferred) or materialised but not
      // runnable (blocked), on a run that has not been finalised. A run finalised by an
      // unrecoverable failure is waiting for nothing, so it reports false.
      postSyncPending:
        (postSyncStages === "deferred" || postSyncStages === "materialised" || postSyncStages === "blocked") &&
        !summary.finished,
      currentUnit: current,
      // Truthful progress of the units that exist; `percentComplete` is null while the run's total
      // work is not yet knowable (see summarizeUnits).
      unitsPercentComplete: summary.unitsPercentComplete,
      percentComplete: summary.percentComplete,
      totalWorkKnown: summary.totalWorkKnown,
      // Two honest tracks instead of one misleading number. The network phase has a known
      // denominator from the moment the run is planned; the post-sync phase does not until its
      // last stage is seeded, so its percentage is null until then rather than a guess.
      networkPercentComplete: phasePercent(units, (unit) => unit.payload?.kind === UNIT_KINDS.NETWORK),
      postSyncPercentComplete: postSyncMayAppend
        ? null
        : phasePercent(units, (unit) => unit.payload?.kind && unit.payload.kind !== UNIT_KINDS.NETWORK && unit.payload?.executable !== false),
      // Redacted at the projection boundary: these come from supplier-produced text, and this
      // projection is what /sync/status, /sync/all and the worker all return.
      latestError: safeUnitError(summary.latestError ?? parent.lastError ?? null),
      latestWarning: safeUnitError(summary.latestWarning),
      options: parent.payload?.options ?? null,
      // Safe cancellation metadata only: why, when, and who asked. No supplier data.
      cancellation: cancellation
        ? { reason: cancellation.reason ?? null, cancelledAt: cancellation.cancelledAt ?? null, actor: cancellation.actor ?? null }
        : null,
      // Backward-compatible names used by the in-memory status readers.
      jobName: kind === "incremental" ? "scheduledSyncAll" : kind === "manual" ? "sync:manual" : "syncAll",
      totalAccounts: summary.totalUnits,
      completedAccounts: summary.completedUnits,
      failedAccounts: summary.failedUnits,
      currentStage: current ? (current.kind === UNIT_KINDS.NETWORK ? current.platform : current.kind) : summary.finished ? null : "starting",
    };
  }

  /** The most recent run of any kind (active first, else latest), or null when none exists. */
  async describeLatestRun() {
    const active = await this.findActiveRun();
    const parent = active ?? (await this.db.jobRun.findFirst({ where: { jobName: ORCHESTRATION_JOB_NAME }, orderBy: [{ createdAt: "desc" }] }));
    return parent ? this.describeRun(parent.id) : null;
  }
}
