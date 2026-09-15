/**
 * Durable, cross-instance sync locking.
 *
 * Module memory (`runExclusiveSync`) only excludes work inside ONE serverless instance: two
 * instances answering two requests each hold their own `activeSync`, so the same supplier account
 * can be synced twice at once. This service is the shared durable primitive both paths use:
 *
 *   - orchestration worker network units (claimed unit rows), and
 *   - the manual per-network sync route (an explicit lock row) — NOT wired yet, by design;
 *     the abstraction exists so both can take the SAME key under the SAME lease semantics.
 *
 * The lock is ACCOUNT-SCOPED, never source-object-scoped: a full-account run covers every source
 * object, so a campaigns-only run and a full run of the same account MUST conflict.
 *
 * A lock is a durable row on the existing JobRun table (no schema change). A holder is live while
 * it is RUNNING and its lease has not expired; the lease is longer than any serverless invocation
 * can live, so a live claim is never stolen, while a crashed or frozen holder is reclaimable.
 */

import { prisma as defaultPrisma } from "../database/prisma.js";

/** Explicit lock rows taken by callers that are not orchestration units (e.g. the manual route). */
export const SYNC_LOCK_JOB_NAME = "sync:lock";
/** Orchestration unit rows hold the same keys; both are consulted by every lock query. */
export const SYNC_UNIT_JOB_NAME = "sync:unit";
export const LOCK_HOLDER_JOB_NAMES = Object.freeze([SYNC_UNIT_JOB_NAME, SYNC_LOCK_JOB_NAME]);

/** Longer than a serverless invocation can live (Vercel hard limit 300 s). */
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/**
 * The durable lock key of a supplier account. `sourceObject` is deliberately NOT part of the key:
 * narrowing a run to one source object does not make it safe to run beside a full account sync.
 */
export function accountLockKey({ platform = null, network = null, accountLabel = null } = {}) {
  const key = String(platform ?? network ?? "").trim().toLowerCase();
  const label = String(accountLabel ?? "").trim() || "default";
  return `network:${key}:${label}`;
}

/** Stage locks (promotion, aggregation, …) so one stage never runs twice concurrently. */
export function stageLockKey(stage, scope = null) {
  const base = String(stage ?? "").trim().toLowerCase();
  return scope ? `${base}:${String(scope).trim().toLowerCase()}` : base;
}

export class SyncAccountLockService {
  constructor({ prisma = defaultPrisma, now = () => new Date(), leaseMs = DEFAULT_LEASE_MS } = {}) {
    this.db = prisma;
    this.now = now;
    this.leaseMs = leaseMs;
  }

  #liveWhere(lockKey, { excludeId = null } = {}) {
    return {
      jobName: { in: LOCK_HOLDER_JOB_NAMES },
      status: "RUNNING",
      payload: { path: ["lockKey"], equals: lockKey },
      startedAt: { gte: new Date(this.now().getTime() - this.leaseMs) },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    };
  }

  /**
   * The current live holder of a key — an orchestration unit or an explicit lock row — or null.
   * Ordered so every caller agrees on ONE winner: earliest claim, then id.
   */
  async findHolder(lockKey, { excludeId = null } = {}) {
    if (!lockKey) return null;
    return (
      (await this.db.jobRun.findFirst({
        where: this.#liveWhere(lockKey, { excludeId }),
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      })) ?? null
    );
  }

  /** Whether a key is free right now (no live holder). */
  async isFree(lockKey, { excludeId = null } = {}) {
    return (await this.findHolder(lockKey, { excludeId })) === null;
  }

  /**
   * Take an explicit lock row for a non-unit caller. Optimistic and safe under a race: the row is
   * written, then the earliest live holder is re-read; a caller that is not the winner releases
   * its own row and reports the winner. Exactly one caller keeps the key.
   */
  async acquire(lockKey, { holderId = null, correlationId = null, metadata = null } = {}) {
    if (!lockKey) return { acquired: false, reason: "no_lock_key" };
    const existing = await this.findHolder(lockKey);
    if (existing) return { acquired: false, reason: "lock_held", heldBy: existing.id, heldByJob: existing.jobName };

    const now = this.now();
    const row = await this.db.jobRun.create({
      data: {
        jobName: SYNC_LOCK_JOB_NAME,
        status: "RUNNING",
        priority: 100,
        maxAttempts: 1,
        startedAt: now,
        correlationId,
        payload: { lockKey, holderId, acquiredAt: now.toISOString(), ...(metadata ? { metadata } : {}) },
      },
    });

    const winner = await this.findHolder(lockKey);
    if (winner && winner.id !== row.id) {
      await this.release(row.id, { status: "CANCELLED" });
      return { acquired: false, reason: "lock_held", heldBy: winner.id, heldByJob: winner.jobName };
    }
    return { acquired: true, lockId: row.id, lockKey };
  }

  /** Extend the lease of a held lock row (long unit, still alive). */
  async renew(lockId) {
    if (!lockId) return null;
    const { count } = await this.db.jobRun.updateMany({
      where: { id: lockId, jobName: SYNC_LOCK_JOB_NAME, status: "RUNNING" },
      data: { startedAt: this.now() },
    });
    return count === 1;
  }

  /** Release a lock row. Always safe to call; a lock already gone is not an error. */
  async release(lockId, { status = "COMPLETED", error = null } = {}) {
    if (!lockId) return false;
    const { count } = await this.db.jobRun.updateMany({
      where: { id: lockId, jobName: SYNC_LOCK_JOB_NAME },
      data: {
        status,
        completedAt: this.now(),
        ...(error ? { lastError: String(error?.message ?? error).slice(0, 2000) } : {}),
      },
    });
    return count === 1;
  }

  /** Run `fn` while holding `lockKey`, releasing it whatever happens. Returns the refusal instead. */
  async withLock(lockKey, fn, { holderId = null, correlationId = null, metadata = null } = {}) {
    const lock = await this.acquire(lockKey, { holderId, correlationId, metadata });
    if (!lock.acquired) return { ran: false, ...lock };
    try {
      const result = await fn({ lockId: lock.lockId, lockKey });
      await this.release(lock.lockId, { status: "COMPLETED" });
      return { ran: true, result };
    } catch (error) {
      await this.release(lock.lockId, { status: "FAILED", error });
      throw error;
    }
  }
}
