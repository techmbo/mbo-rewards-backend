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
import { planAccountUnits, planSourcesFor, sourcesMaterialisedAfter } from "./syncSourcePlan.js";
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

export const ORCHESTRATION_JOB_NAME = "sync:orchestration";
export const UNIT_JOB_NAME = "sync:unit";

export const UNIT_KINDS = Object.freeze({
  NETWORK: "network",
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
 * Why a unit was terminalised without ever reporting a failure: its worker was killed (a
 * serverless invocation timeout, a crash, an instance reclaim) and its lease ran out.
 */
export const ABANDONED_UNIT_REASON = "worker lease expired before completion";

/**
 * Kinds a worker may execute TODAY. Post-sync stages are planned as non-executable placeholders
 * until their bounded (paged / per-day) implementation exists: the existing global PromotionJob,
 * conversion promotion and 14-day rebuild must never be run as one unit inside an invocation.
 */
export const EXECUTABLE_UNIT_KINDS = Object.freeze([UNIT_KINDS.NETWORK]);
export const UNIT_BLOCKED_REASON = "bounded_units_not_implemented";

/** Platforms in the established syncAll order; account-labelled ones enumerate connected accounts. */
const ACCOUNT_LABELLED_PLATFORMS = ["boostiny", "optimise_sea", "optimise_mena", "optimise_uk", "trackier"];
const SINGLE_ACCOUNT_PLATFORMS = ["impact", "partnerize", "awin", "admitad", "rakuten", "cj"];

const ACTIVE_STATUSES = ["PENDING", "RUNNING"];
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
  const networkOptions = { fastSync: kind === "incremental" ? true : Boolean(fastSync), promoteAfter: false };
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
function summarizeUnits(units, { postSyncStages = "none" } = {}) {
  const counters = { totalUnits: units.length, completedUnits: 0, failedUnits: 0, pendingUnits: 0, runningUnits: 0, blockedUnits: 0 };
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
    } else if (unit.status === "DEAD_LETTER" || unit.status === "FAILED" || unit.status === "CANCELLED") {
      counters.failedUnits += 1;
      if (unit.lastError) latestError = unit.lastError;
    } else if (unit.status === "RUNNING") {
      counters.runningUnits += 1;
      if (!current) current = unit;
    } else if (!isUnitExecutable(unit)) {
      // Planned but not runnable in this phase: never offered to a worker, never silently "done".
      counters.blockedUnits += 1;
    } else {
      counters.pendingUnits += 1;
      if (unit.lastError && !latestError) latestError = unit.lastError;
    }
  }
  const terminal = counters.completedUnits + counters.failedUnits;
  const unitsPercentComplete = counters.totalUnits > 0 ? Math.min(100, Math.round((terminal / counters.totalUnits) * 100)) : 0;
  const settled = terminal + counters.blockedUnits === counters.totalUnits && counters.totalUnits > 0;
  // 1 — an unrecoverable unit failure beats any outstanding post-sync work.
  const permanentlyFailed = settled && counters.failedUnits > 0;
  // 2 — otherwise, requested post-sync work that does not exist yet keeps the run open.
  const awaitingPostSync = settled && !permanentlyFailed && postSyncStages === "deferred";
  const blocked = settled && !permanentlyFailed && !awaitingPostSync && counters.blockedUnits > 0;
  const finished = settled && (permanentlyFailed || (!awaitingPostSync && counters.blockedUnits === 0));
  // The overall denominator is unknown while promotion is requested but not materialised — except
  // once the run is finished, when nothing further will be materialised.
  const totalWorkKnown = postSyncStages !== "deferred" || finished;
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
  ].join("|");
}

/**
 * Safe chunk metadata: WHICH slice of an account's campaigns this unit covers and how big it is.
 * Deliberately counts and positions only — the campaign identifiers themselves are supplier data
 * and never leave the unit payload.
 */
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

export class SyncOrchestrationService {
  constructor({ prisma = defaultPrisma, now = () => new Date(), leaseMs = DEFAULT_LEASE_MS, maxAttempts = DEFAULT_UNIT_MAX_ATTEMPTS, listAccounts = defaultListAccounts, loadAccountState = defaultLoadAccountState, planCommissionGroupChunks = planOptimiseCommissionGroupChunks, locks = null } = {}) {
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
  }

  /**
   * The active (PENDING/RUNNING) parent run matching a kind AND the execution options that change
   * what the work IS, oldest first, or null. Matching on kind alone would silently fold an
   * incompatible request (e.g. ?fast=true) into an unrelated run and give the caller a run id
   * whose units do different work than they asked for.
   */
  async findActiveRun({ kind = null, options = null } = {}) {
    const conditions = [];
    if (kind) conditions.push({ payload: { path: ["kind"], equals: kind } });
    if (options) {
      conditions.push({ payload: { path: ["options", "fastSync"], equals: Boolean(options.fastSync) } });
      conditions.push({ payload: { path: ["options", "promoteAfter"], equals: options.promoteAfter !== false } });
    }
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
            options: { fastSync: Boolean(options.fastSync), promoteAfter: options.promoteAfter !== false },
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
    return { id: parent.id, kind, trigger, totalUnits: planned.length, excludedSources: exclusions, deferredSources, created: true };
  }

  /** Every active run doing the same work, earliest first. The first is the canonical one. */
  async listActiveCompatibleRuns({ kind = null, options = null } = {}) {
    const conditions = [];
    if (kind) conditions.push({ payload: { path: ["kind"], equals: kind } });
    if (options) {
      conditions.push({ payload: { path: ["options", "fastSync"], equals: Boolean(options.fastSync) } });
      conditions.push({ payload: { path: ["options", "promoteAfter"], equals: options.promoteAfter !== false } });
    }
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

  /** Collapse every active compatible duplicate after the canonical one. Idempotent. */
  async #collapseDuplicatesOf(canonicalRunId, { kind, options }) {
    const active = await this.listActiveCompatibleRuns({ kind, options });
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
  async getOrCreateRun({ kind = "full", trigger = "api", options = {} } = {}) {
    const existing = await this.findActiveRun({ kind, options });
    if (existing) {
      await this.#collapseDuplicatesOf(existing.id, { kind, options });
      return this.#reuseView(existing, kind);
    }

    const created = await this.createRun({ kind, trigger, options });

    // Resolve a possible concurrent creation. This read happens after our own rows are committed,
    // so a racer that committed before us is visible here.
    const canonical = (await this.listActiveCompatibleRuns({ kind, options }))[0] ?? null;
    if (canonical && canonical.id !== created.id) {
      const collapse = await this.collapseDuplicateRun(created.id, { canonicalRunId: canonical.id });
      if (collapse.collapsed) return { ...this.#reuseView(canonical, kind), collapsedRunId: created.id };
      // Our own run could not be collapsed (a worker already claimed a unit): keep it as its own
      // run rather than orphaning started work, and report it truthfully as created.
      return { ...created, options: { fastSync: Boolean(options.fastSync), promoteAfter: options.promoteAfter !== false } };
    }

    await this.#collapseDuplicatesOf(created.id, { kind, options });
    return { ...created, options: { fastSync: Boolean(options.fastSync), promoteAfter: options.promoteAfter !== false } };
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
  async materialiseFollowOnUnits(runId, descriptor = {}) {
    const platform = text(descriptor?.platform);
    const sourceObject = text(descriptor?.sourceObject);
    if (!runId || !platform || !sourceObject) return { appended: 0, skipped: 0 };
    const targets = sourcesMaterialisedAfter(platform, sourceObject);
    if (!targets.includes(OPTIMISE_COMMISSION_GROUPS_SOURCE)) return { appended: 0, skipped: 0 };

    const accountLabel = text(descriptor?.accountLabel) ?? "default";
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

  async completeUnit(unitId, outcome = null) {
    const unit = await this.db.jobRun.findUnique({ where: { id: unitId } });
    if (!unit) return null;
    const updated = await this.db.jobRun.update({
      where: { id: unitId },
      data: { status: "COMPLETED", progress: 100, completedAt: this.now(), lastError: null, result: { ...(unit.result ?? {}), outcome: outcome ?? null } },
    });
    await this.refreshRun(unit.correlationId);
    return updated;
  }

  /** Retryable while attempts remain (back to PENDING, no sleep); DEAD_LETTER otherwise. */
  async failUnit(unitId, error) {
    const unit = await this.db.jobRun.findUnique({ where: { id: unitId } });
    if (!unit) return null;
    const message = String(error?.message ?? error ?? "unit failed").slice(0, 2000);
    const retry = (unit.attempt ?? 0) < (unit.maxAttempts ?? this.maxAttempts);
    const updated = await this.db.jobRun.update({
      where: { id: unitId },
      data: retry
        ? { status: "PENDING", lastError: message }
        : { status: "DEAD_LETTER", lastError: message, completedAt: this.now() },
    });
    await this.refreshRun(unit.correlationId);
    return updated;
  }

  /** Recompute the parent's counters/progress from its units; finalise when every unit is terminal. */
  async refreshRun(runId) {
    if (!runId) return null;
    const [parent, units] = await Promise.all([this.db.jobRun.findUnique({ where: { id: runId } }), this.listUnits(runId)]);
    if (!parent) return null;
    const summary = summarizeUnits(units, { postSyncStages: parent.payload?.postSyncStages ?? "none" });
    const data = {
      // The Int column carries the progress of the units that exist; the nullable overall
      // percentage lives in `result`, where "unknown" can be represented truthfully.
      progress: summary.unitsPercentComplete,
      result: {
        totalUnits: summary.totalUnits,
        completedUnits: summary.completedUnits,
        failedUnits: summary.failedUnits,
        pendingUnits: summary.pendingUnits,
        runningUnits: summary.runningUnits,
        blockedUnits: summary.blockedUnits,
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
      platform: p.platform ?? null,
      accountLabel: p.accountLabel ?? null,
      sourceObject: p.sourceObject ?? null,
      window: unitWindow(p),
      campaignChunk: unitCampaignChunk(p),
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
      where: { jobName: ORCHESTRATION_JOB_NAME, status: { in: ACTIVE_STATUSES } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const run of runs) {
      // eslint-disable-next-line no-await-in-loop
      const unit = await this.nextUnit(run.id);
      if (unit) return { run, unit };
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
    const summary = summarizeUnits(units, { postSyncStages });
    const status = TERMINAL_STATUSES.includes(parent.status) && !summary.finished
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
      status,
      trigger: parent.payload?.trigger ?? null,
      startedAt: parent.startedAt ?? parent.createdAt ?? null,
      finishedAt: parent.completedAt ?? null,
      totalUnits: summary.totalUnits,
      completedUnits: summary.completedUnits,
      failedUnits: summary.failedUnits,
      pendingUnits: summary.pendingUnits,
      runningUnits: summary.runningUnits,
      blockedUnits: summary.blockedUnits,
      postSyncStages,
      // What this run does NOT cover, and why. Empty for a run with nothing excluded.
      excludedSources: parent.payload?.excludedSources ?? [],
      // Source objects whose units are planned by another unit's completion. Each entry carries
      // its own state: "pending" (not materialised yet) or "materialised" with the number of
      // units it produced — zero when the account had no eligible campaign.
      deferredSources,
      // True while any deferred source is still unmaterialised. While it is true `totalUnits` is
      // a floor, not a total: completing the unit a deferral depends on legitimately ADDS units.
      deferredPending,
      totalUnitsMayIncrease: deferredPending,
      // Post-sync work that still has to happen: requested (deferred) or materialised but not
      // runnable (blocked), on a run that has not been finalised. A run finalised by an
      // unrecoverable failure is waiting for nothing, so it reports false.
      postSyncPending: (postSyncStages === "deferred" || postSyncStages === "blocked") && !summary.finished,
      currentUnit: current,
      // Truthful progress of the units that exist; `percentComplete` is null while the run's total
      // work is not yet knowable (see summarizeUnits).
      unitsPercentComplete: summary.unitsPercentComplete,
      percentComplete: summary.percentComplete,
      totalWorkKnown: summary.totalWorkKnown,
      // Redacted at the projection boundary: these come from supplier-produced text, and this
      // projection is what /sync/status, /sync/all and the worker all return.
      latestError: safeUnitError(summary.latestError ?? parent.lastError ?? null),
      latestWarning: safeUnitError(summary.latestWarning),
      options: parent.payload?.options ?? null,
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
