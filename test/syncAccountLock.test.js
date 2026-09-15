/**
 * Durable cross-instance account locking.
 *
 * Module memory (`runExclusiveSync`) only excludes work inside ONE serverless instance. These
 * tests drive TWO independent service instances over ONE shared store — the shape of two Vercel
 * instances hitting the same database — and prove the lock is account-scoped, lease-bound, and
 * shared between the orchestration worker (unit rows) and any other path (explicit lock rows).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LEASE_MS,
  SYNC_LOCK_JOB_NAME,
  SyncAccountLockService,
  accountLockKey,
  stageLockKey,
} from "../src/jobs/syncAccountLock.service.js";
import { SyncOrchestrationService, UNIT_KINDS, UNIT_JOB_NAME } from "../src/jobs/syncOrchestration.service.js";

/** One shared store, many service instances — the cross-instance case. */
function createStore() {
  const rows = [];
  let seq = 0;
  const clone = (r) => JSON.parse(JSON.stringify(r));
  const match = (row, where = {}) => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "payload") {
        let value = row.payload;
        for (const p of cond.path ?? []) value = value?.[p];
        if ("equals" in cond && value !== cond.equals) return false;
        continue;
      }
      const value = row[key];
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        if ("in" in cond && !cond.in.includes(value)) return false;
        if ("not" in cond && value === cond.not) return false;
        if ("gte" in cond && !(value != null && new Date(value) >= new Date(cond.gte))) return false;
        if ("lt" in cond && !(value != null && new Date(value) < new Date(cond.lt))) return false;
        if ("equals" in cond && value !== cond.equals) return false;
      } else if (value !== cond) return false;
    }
    return true;
  };
  const sort = (list, orderBy) => {
    const specs = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => {
      for (const spec of specs) {
        const [field, dir] = Object.entries(spec)[0];
        const av = a[field] instanceof Date ? a[field].getTime() : a[field];
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
        if (av === bv) continue;
        return (av > bv ? 1 : -1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  };
  const apply = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
      else row[k] = v;
    }
  };
  const jobRun = {
    async create({ data }) {
      seq += 1;
      const row = { id: `row-${String(seq).padStart(3, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(Date.now() + seq), ...data };
      rows.push(row);
      return clone(row);
    },
    async update({ where, data }) { const row = rows.find((r) => r.id === where.id); apply(row, data); return clone(row); },
    async updateMany({ where, data }) { let count = 0; for (const row of rows) if (match(row, where)) { apply(row, data); count += 1; } return { count }; },
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { const list = sort(rows.filter((r) => match(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy, take }) { let list = sort(rows.filter((r) => match(r, where ?? {})), orderBy); if (take) list = list.slice(0, take); return list.map(clone); },
  };
  return { rows, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

let clock = new Date("2026-09-15T12:00:00.000Z");
const now = () => clock;
const reset = () => { clock = new Date("2026-09-15T12:00:00.000Z"); };
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };

const BOOSTINY_DEFAULT = accountLockKey({ platform: "boostiny", accountLabel: "default" });

describe("the lock key is account-scoped, never source-object-scoped", () => {
  it("the same account is one key whatever the caller intends to sync", () => {
    assert.equal(BOOSTINY_DEFAULT, "network:boostiny:default");
    assert.equal(accountLockKey({ platform: "BOOSTINY", accountLabel: " default " }), BOOSTINY_DEFAULT);
    assert.equal(accountLockKey({ network: "boostiny", accountLabel: null }), BOOSTINY_DEFAULT, "missing label is the default account");
    assert.notEqual(accountLockKey({ platform: "boostiny", accountLabel: "second" }), BOOSTINY_DEFAULT);
    assert.notEqual(accountLockKey({ platform: "optimise_sea", accountLabel: "default" }), BOOSTINY_DEFAULT);
    assert.equal(stageLockKey("AGGREGATION", "2026-09-15"), "aggregation:2026-09-15");
    assert.equal(stageLockKey("promotion"), "promotion");
  });
});

describe("cross-instance exclusion — two service instances, one store", () => {
  it("holder A holds Boostiny/default; holder B on another instance cannot take it, even for a different sourceObject", async () => {
    reset();
    const { prisma, rows } = createStore();
    const instanceA = new SyncAccountLockService({ prisma, now });
    const instanceB = new SyncAccountLockService({ prisma, now });

    const a = await instanceA.acquire(BOOSTINY_DEFAULT, { holderId: "instance-a:full-account" });
    assert.equal(a.acquired, true);

    // Instance B wants a campaigns-only run of the SAME account: same key, so it is refused.
    const b = await instanceB.acquire(accountLockKey({ platform: "boostiny", accountLabel: "default" }), { holderId: "instance-b:campaigns-only" });
    assert.equal(b.acquired, false);
    assert.equal(b.reason, "lock_held");
    assert.equal(b.heldBy, a.lockId);
    assert.equal(await instanceB.isFree(BOOSTINY_DEFAULT), false);
    // A refused acquire writes nothing: the key is checked before any row is created.
    assert.equal(rows.filter((r) => r.jobName === SYNC_LOCK_JOB_NAME).length, 1, "no speculative lock row for the refused caller");

    await instanceA.release(a.lockId);
    assert.equal(await instanceB.isFree(BOOSTINY_DEFAULT), true);
    const after = await instanceB.acquire(BOOSTINY_DEFAULT, { holderId: "instance-b" });
    assert.equal(after.acquired, true, "released keys are immediately reusable");
  });

  it("different accounts and different networks proceed independently", async () => {
    reset();
    const { prisma } = createStore();
    const a = new SyncAccountLockService({ prisma, now });
    const b = new SyncAccountLockService({ prisma, now });
    const held = await a.acquire(BOOSTINY_DEFAULT, { holderId: "a" });
    assert.equal(held.acquired, true);
    for (const key of [
      accountLockKey({ platform: "boostiny", accountLabel: "second" }),
      accountLockKey({ platform: "optimise_sea", accountLabel: "default" }),
      accountLockKey({ platform: "trackier", accountLabel: "default" }),
    ]) {
      const other = await b.acquire(key, { holderId: "b" });
      assert.equal(other.acquired, true, key);
    }
  });

  it("a stale holder (frozen or crashed invocation) is reclaimable once the lease expires, never before", async () => {
    reset();
    const { prisma } = createStore();
    const a = new SyncAccountLockService({ prisma, now });
    const b = new SyncAccountLockService({ prisma, now });
    const crashed = await a.acquire(BOOSTINY_DEFAULT, { holderId: "crashed-instance" });
    assert.equal(crashed.acquired, true);

    advance(DEFAULT_LEASE_MS - 1000);
    assert.equal((await b.acquire(BOOSTINY_DEFAULT, { holderId: "b" })).acquired, false, "a live lease is never stolen");

    advance(2000);
    const reclaimed = await b.acquire(BOOSTINY_DEFAULT, { holderId: "b" });
    assert.equal(reclaimed.acquired, true, "an expired lease is reclaimable");
    assert.notEqual(reclaimed.lockId, crashed.lockId);
    reset();
  });

  it("renew extends a lease so long work is not reclaimed underneath it", async () => {
    reset();
    const { prisma } = createStore();
    const a = new SyncAccountLockService({ prisma, now });
    const b = new SyncAccountLockService({ prisma, now });
    const lock = await a.acquire(BOOSTINY_DEFAULT, { holderId: "a" });
    advance(DEFAULT_LEASE_MS - 1000);
    assert.equal(await a.renew(lock.lockId), true);
    advance(2000);
    assert.equal((await b.acquire(BOOSTINY_DEFAULT, { holderId: "b" })).acquired, false, "renewed lease still live");
    reset();
  });

  it("two instances acquiring the same key at the same moment: exactly one wins, the loser leaves no live row", async () => {
    reset();
    const { prisma, rows } = createStore();
    const a = new SyncAccountLockService({ prisma, now });
    const b = new SyncAccountLockService({ prisma, now });
    const [ra, rb] = await Promise.all([
      a.acquire(BOOSTINY_DEFAULT, { holderId: "a" }),
      b.acquire(BOOSTINY_DEFAULT, { holderId: "b" }),
    ]);
    assert.equal([ra.acquired, rb.acquired].filter(Boolean).length, 1);
    const live = rows.filter((r) => r.jobName === SYNC_LOCK_JOB_NAME && r.status === "RUNNING");
    assert.equal(live.length, 1, "the loser cancelled its own row");
    const winner = ra.acquired ? ra : rb;
    assert.equal(live[0].id, winner.lockId);
  });

  it("withLock releases the key on success and on failure", async () => {
    reset();
    const { prisma } = createStore();
    const service = new SyncAccountLockService({ prisma, now });
    const ok = await service.withLock(BOOSTINY_DEFAULT, async () => "zzdonezz", { holderId: "a" });
    assert.deepEqual(ok, { ran: true, result: "zzdonezz" });
    assert.equal(await service.isFree(BOOSTINY_DEFAULT), true);

    await assert.rejects(() => service.withLock(BOOSTINY_DEFAULT, async () => { throw new Error("zzboomzz"); }, { holderId: "a" }), /zzboomzz/);
    assert.equal(await service.isFree(BOOSTINY_DEFAULT), true, "released after a throw");

    const held = await service.acquire(BOOSTINY_DEFAULT, { holderId: "holder" });
    let ran = false;
    const refused = await service.withLock(BOOSTINY_DEFAULT, async () => { ran = true; }, { holderId: "b" });
    assert.equal(refused.ran, false);
    assert.equal(refused.reason, "lock_held");
    assert.equal(refused.heldBy, held.lockId);
    assert.equal(ran, false, "the body never ran");
  });
});

describe("one vocabulary — orchestration units and explicit lock rows exclude each other", () => {
  const listAccounts = async () => ["default"];

  it("an orchestration unit holding an account blocks any other path taking the same account lock", async () => {
    reset();
    const { prisma } = createStore();
    const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts });
    const manualInstance = new SyncAccountLockService({ prisma, now });

    const run = await orchestration.createRun({ kind: "full", trigger: "scheduler", options: { promoteAfter: false }, units: [{ kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: {} }] });
    const unit = await orchestration.nextUnit(run.id);
    assert.equal((await orchestration.claimUnit(unit.id, { workerId: "cron" })).claimed, true);

    // The manual per-network path (another instance) asks for the same account, scoped to campaigns.
    const manual = await manualInstance.acquire(BOOSTINY_DEFAULT, { holderId: "manual:campaigns" });
    assert.equal(manual.acquired, false);
    assert.equal(manual.reason, "lock_held");
    assert.equal(manual.heldBy, unit.id);
    assert.equal(manual.heldByJob, UNIT_JOB_NAME);

    await orchestration.completeUnit(unit.id, { ok: true });
    assert.equal((await manualInstance.acquire(BOOSTINY_DEFAULT, { holderId: "manual" })).acquired, true);
  });

  it("an explicit lock held by another path blocks the orchestration worker from claiming that account", async () => {
    reset();
    const { prisma } = createStore();
    const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts });
    const manualInstance = new SyncAccountLockService({ prisma, now });

    const manual = await manualInstance.acquire(BOOSTINY_DEFAULT, { holderId: "manual:campaigns" });
    assert.equal(manual.acquired, true);

    const run = await orchestration.createRun({ kind: "full", trigger: "scheduler", options: { promoteAfter: false }, units: [{ kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: {} }] });
    const unit = await orchestration.nextUnit(run.id);
    const claim = await orchestration.claimUnit(unit.id, { workerId: "cron" });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, "lock_held");
    assert.equal(claim.heldBy, manual.lockId);

    await manualInstance.release(manual.lockId);
    assert.equal((await orchestration.claimUnit(unit.id, { workerId: "cron" })).claimed, true, "free again once the manual run ends");
  });

  it("the orchestrator and the lock service agree on the lease, so neither can steal a live claim", async () => {
    reset();
    const { prisma } = createStore();
    const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts });
    const locks = new SyncAccountLockService({ prisma, now });
    const run = await orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [{ kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: {} }] });
    const unit = await orchestration.nextUnit(run.id);
    await orchestration.claimUnit(unit.id, { workerId: "frozen" });

    advance(DEFAULT_LEASE_MS - 1000);
    assert.equal((await locks.acquire(BOOSTINY_DEFAULT, { holderId: "manual" })).acquired, false);
    advance(2000);
    assert.equal((await locks.acquire(BOOSTINY_DEFAULT, { holderId: "manual" })).acquired, true, "a frozen unit's lease expires for both paths");
    reset();
  });
});
