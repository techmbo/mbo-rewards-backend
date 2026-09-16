/**
 * The durable Entity-staging barrier.
 *
 * Phases 6b and 6c page through `Entity` by PRIMARY KEY, and `Entity.id` is a random v4 UUID. A
 * row staged while a walk is in flight gets an id that may sort BELOW the walk's cursor, and that
 * row is then never promoted: invisible to conversion attribution, absent from every aggregation
 * bucket built on it, with the run still reporting zero failures. Silent loss, not a visible one.
 *
 * Phase 6d's comment asserted that staging is frozen before a walk begins. It was not: the network
 * account lock is `network:<platform>:<label>` and the promotion stage lock is `promotion`, two
 * different strings that can never exclude each other. This module is that freeze.
 *
 * Two mechanisms, deliberately:
 *
 *  1. The STEADY STATE is DERIVED, never stored. The freeze is active whenever an active
 *     planner-6 run is in `promoting` or `conversion_promoting`. Derived state needs no lease,
 *     cannot drift from the rows it describes, survives a cold start, and is already true of a run
 *     that was mid-walk before this code ever deployed.
 *
 *  2. The TRANSITION into that state is guarded by an announce-then-verify handshake on one shared
 *     key, because that is the only moment a check-then-act can interleave. A stager announces
 *     itself and then looks; the gate announces its intent and then looks. Whoever announced first
 *     is seen by the other. Ties go to the FREEZE: its intent marker is sticky, so new stagers keep
 *     refusing while in-flight ones drain monotonically, and the gate seeds on a later invocation.
 *     Aborting both sides instead would livelock.
 *
 * No module-memory state, no schema migration: participants and the intent marker are ordinary
 * `sync:lock` JobRun rows, the same family the account locks already use, so they expire under the
 * same lease and are visible to every serverless instance.
 */

import { prisma as defaultPrisma } from "../database/prisma.js";
import { DEFAULT_LEASE_MS, SYNC_LOCK_JOB_NAME } from "./syncAccountLock.service.js";
import {
  ORCHESTRATION_JOB_NAME,
  PLANNER_VERSION,
  UNIT_JOB_NAME,
} from "./syncOrchestration.service.js";
import { POST_SYNC_STAGES, postSyncStageOf } from "./postSyncStages.js";

/** The one key both sides contend on. Participants hang off it; the intent marker IS it. */
export const ENTITY_STAGING_BARRIER_KEY = "entity-staging";

/** The machine-readable refusal. 409 on an HTTP route; a DEFERRAL, never a failure, on a unit. */
export const STAGING_FROZEN_CODE = "entity_staging_frozen";

/**
 * How long a staging participant stays live, deliberately LONGER than the worker lease.
 *
 * The two failure modes are not symmetric. If a participant expires while its stager is still
 * writing, the gate seeds promotion under an active writer and the walk can miss rows: silent data
 * loss. If a participant outlives a crashed stager, the gate merely defers and retries on a later
 * invocation: a delay, nothing more. So the lease is sized for the worse failure.
 *
 * Thirty minutes against the durations that actually bound a staging call: Vercel caps an
 * invocation at 300s, so on production hosting no stager can survive its own lease by a factor of
 * six. The long-running container path has no such cap, which is exactly why this is not simply the
 * ten-minute worker lease.
 */
export const STAGING_PARTICIPANT_LEASE_MS = 30 * 60 * 1000;

/**
 * The stages during which no Entity may be staged. Both are cursor walks over Entity.
 *
 * Resolved at CALL time, never at module load. This module and postSyncStages.js import each
 * other, and a top-level read of POST_SYNC_STAGES throws "Cannot access before initialization"
 * whenever the cycle is entered from the postSyncStages side — which import order alone decides.
 * A function body is evaluated long after both modules are initialised, so the cycle is harmless.
 */
const frozenStages = () => [POST_SYNC_STAGES.PROMOTING, POST_SYNC_STAGES.CONVERSION_PROMOTING];

const ACTIVE_RUN_STATUSES = Object.freeze(["PENDING", "RUNNING"]);

/** One staging participant's key. Scoped so many stagers coexist; the marker's key is unscoped. */
export function stagingParticipantKey(scope = null) {
  const suffix = String(scope ?? "").trim().toLowerCase();
  return suffix ? `${ENTITY_STAGING_BARRIER_KEY}:${suffix}` : `${ENTITY_STAGING_BARRIER_KEY}:unscoped`;
}

/** The refusal every guarded path throws. `statusCode` is what the HTTP layer turns into a 409. */
export function stagingFrozenError(detail = {}) {
  const where = detail.stage ? ` while post-sync is ${detail.stage}` : "";
  const error = new Error(
    `Entity staging is frozen${where}: promotion pages Entity by primary key, and a row staged now could be skipped by the walk.`,
  );
  error.code = STAGING_FROZEN_CODE;
  error.statusCode = 409;
  error.retryable = true;
  if (detail.runId) error.runId = detail.runId;
  if (detail.stage) error.stage = detail.stage;
  if (detail.reason) error.reason = detail.reason;
  return error;
}

/** Whether an error is the barrier's refusal, from any depth of the call stack. */
export function isStagingFrozenError(error) {
  return Boolean(error) && error.code === STAGING_FROZEN_CODE;
}

export class EntityStagingBarrier {
  constructor({
    prisma = defaultPrisma,
    now = () => new Date(),
    leaseMs = DEFAULT_LEASE_MS,
    participantLeaseMs = STAGING_PARTICIPANT_LEASE_MS,
  } = {}) {
    this.db = prisma;
    this.now = now;
    // The intent marker's lease: a gate that dies mid-handshake must not freeze staging forever.
    this.leaseMs = leaseMs;
    // The participant lease: longer, because expiring early loses data and expiring late only waits.
    this.participantLeaseMs = participantLeaseMs;
  }

  /** Rows of the lock family that are still within `leaseMs`. Stale ones are simply not live. */
  #liveWhere(extra = {}, leaseMs = this.leaseMs) {
    return {
      jobName: SYNC_LOCK_JOB_NAME,
      status: "RUNNING",
      startedAt: { gte: new Date(this.now().getTime() - leaseMs) },
      ...extra,
    };
  }

  /**
   * The DERIVED freeze: is any active planner-6 run inside a cursor walk?
   *
   * Reads rows only. A run whose promotion units already exist is frozen the instant this code is
   * deployed — no marker has to be written, and nothing has to have observed the transition.
   */
  async derivedFreeze() {
    const runs = await this.db.jobRun.findMany({
      where: { jobName: ORCHESTRATION_JOB_NAME, status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: [{ createdAt: "asc" }],
    });
    for (const run of runs) {
      // A legacy run plans whole accounts, not bounded pages; it owns no Entity cursor walk.
      if ((run.payload?.plannerVersion ?? null) !== PLANNER_VERSION) continue;
      const postSyncStages = run.payload?.postSyncStages ?? "none";
      if (postSyncStages === "none") continue;
      // eslint-disable-next-line no-await-in-loop
      const units = await this.db.jobRun.findMany({
        where: { jobName: UNIT_JOB_NAME, correlationId: run.id },
        orderBy: [{ priority: "asc" }],
      });
      const stage = postSyncStageOf(units, {
        postSyncRequested: true,
        deferredSources: run.payload?.deferredSources ?? [],
      });
      if (frozenStages().includes(stage)) return { frozen: true, runId: run.id, stage, reason: "derived" };
    }
    return { frozen: false, runId: null, stage: null, reason: null };
  }

  /** The live freeze-intent marker, or null. Written by the gate just before it seeds promotion. */
  async freezeIntent() {
    return (
      (await this.db.jobRun.findFirst({
        where: this.#liveWhere({ payload: { path: ["lockKey"], equals: ENTITY_STAGING_BARRIER_KEY } }),
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      })) ?? null
    );
  }

  /** Live staging participants, optionally excluding one row (the caller's own ticket). */
  async activeParticipants({ excludeId = null } = {}) {
    const rows = await this.db.jobRun.findMany({
      // The PARTICIPANT lease, not the worker lease: see STAGING_PARTICIPANT_LEASE_MS.
      where: this.#liveWhere(
        { payload: { path: ["barrier"], equals: ENTITY_STAGING_BARRIER_KEY } },
        this.participantLeaseMs,
      ),
      orderBy: [{ startedAt: "asc" }],
    });
    return excludeId ? rows.filter((row) => row.id !== excludeId) : rows;
  }

  /** The freeze as a staging entrant sees it: derived state first, then a pending transition. */
  async freezeState() {
    const derived = await this.derivedFreeze();
    if (derived.frozen) return derived;
    const intent = await this.freezeIntent();
    if (intent) {
      return { frozen: true, runId: intent.correlationId ?? null, stage: POST_SYNC_STAGES.PROMOTING, reason: "freeze_intent" };
    }
    return { frozen: false, runId: null, stage: null, reason: null };
  }

  /** Read-only: throw the refusal if staging is frozen right now. Registers nothing. */
  async assertStagingAllowed() {
    const state = await this.freezeState();
    if (state.frozen) throw stagingFrozenError(state);
    return true;
  }

  /**
   * Announce this stager, THEN look. The order is the whole point: the participant row is visible
   * to the gate before this call can decide it may proceed, so a gate that announces its intent
   * concurrently either sees this participant (and waits) or is seen by it (and this refuses).
   * There is no interleaving in which both proceed.
   */
  async enterStaging(scope = null, { holderId = null, correlationId = null } = {}) {
    const startedAt = this.now();
    const ticket = await this.db.jobRun.create({
      data: {
        jobName: SYNC_LOCK_JOB_NAME,
        status: "RUNNING",
        priority: 100,
        maxAttempts: 1,
        startedAt,
        correlationId,
        payload: {
          lockKey: stagingParticipantKey(scope),
          // The field the participant query matches on, so a participant is never confused with an
          // account lock that merely happens to be live.
          barrier: ENTITY_STAGING_BARRIER_KEY,
          scope: scope ?? null,
          holderId,
          acquiredAt: startedAt.toISOString(),
        },
      },
    });

    const state = await this.freezeState();
    if (state.frozen) {
      await this.leaveStaging(ticket.id, { status: "CANCELLED" });
      throw stagingFrozenError(state);
    }
    return { ticketId: ticket.id, scope: scope ?? null };
  }

  /** Release a participant. Always called from a finally, so a throwing stager still drains. */
  async leaveStaging(ticketId, { status = "COMPLETED" } = {}) {
    if (!ticketId) return false;
    const { count } = await this.db.jobRun.updateMany({
      // RUNNING only: a replayed release must be a no-op rather than re-stamping a ticket that was
      // already given back, so "released" always means "this call released it".
      where: { id: ticketId, jobName: SYNC_LOCK_JOB_NAME, status: "RUNNING" },
      data: { status, completedAt: this.now() },
    });
    return count === 1;
  }

  /** Run `fn` as a registered staging participant, releasing the ticket whatever happens. */
  async withStaging(scope, fn, options = {}) {
    const ticket = await this.enterStaging(scope, options);
    try {
      return await fn(ticket);
    } finally {
      await this.leaveStaging(ticket.ticketId);
    }
  }

  /**
   * Announce the gate's intent to freeze, THEN look for participants. Mirror of enterStaging.
   *
   * The marker is refreshed rather than duplicated, so a repeated gate invocation leaves exactly
   * one. It is leased like every other lock row: if the gate dies here, the marker expires and
   * staging resumes rather than being frozen forever by a process that no longer exists.
   */
  async announceFreezeIntent({ correlationId = null } = {}) {
    const existing = await this.freezeIntent();
    const startedAt = this.now();
    if (existing) {
      await this.db.jobRun.update({ where: { id: existing.id }, data: { startedAt } });
      return { intentId: existing.id, refreshed: true };
    }
    const row = await this.db.jobRun.create({
      data: {
        jobName: SYNC_LOCK_JOB_NAME,
        status: "RUNNING",
        priority: 100,
        maxAttempts: 1,
        startedAt,
        correlationId,
        payload: {
          lockKey: ENTITY_STAGING_BARRIER_KEY,
          freezeIntent: true,
          announcedAt: startedAt.toISOString(),
        },
      },
    });
    return { intentId: row.id, refreshed: false };
  }

  /**
   * Drop the intent marker. Safe once bounded promotion units exist, because the DERIVED freeze is
   * authoritative from then on and does not depend on any marker surviving.
   */
  async clearFreezeIntent() {
    const { count } = await this.db.jobRun.updateMany({
      where: this.#liveWhere({ payload: { path: ["lockKey"], equals: ENTITY_STAGING_BARRIER_KEY } }),
      data: { status: "COMPLETED", completedAt: this.now() },
    });
    return count;
  }
}

/** The process-wide barrier. Holds no state of its own; every answer comes from durable rows. */
export const entityStagingBarrier = new EntityStagingBarrier();
