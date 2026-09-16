/**
 * Stale-claim recovery — an abandoned attempt is an attempt.
 *
 * A killed worker (serverless invocation timeout, crash, instance reclaim) never reports a
 * failure, so maxAttempts used to apply only to explicit failures and a unit whose worker kept
 * dying was reclaimed for ever. An expired RUNNING claim now counts as a spent attempt: while
 * attempts remain the unit is reclaimed exactly once more; at maxAttempts it is terminalised as
 * DEAD_LETTER without running supplier work again, which fails the parent through the existing
 * precedence and frees the account lock.
 *
 * Modelled on production run c9e3e699: sequence 2, optimise_sea/default, RUNNING, attempt 1 of 3,
 * lease expired.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { triggerSyncWorker } from "../src/controllers/sync.controller.js";
import {
  ABANDONED_UNIT_REASON,
  DEFAULT_LEASE_MS,
  UNIT_JOB_NAME,
  UNIT_KINDS,
  SyncOrchestrationService,
} from "../src/jobs/syncOrchestration.service.js";
import { SyncAccountLockService, accountLockKey } from "../src/jobs/syncAccountLock.service.js";

// Never let a plan reach the real database from a unit test: the account state the planner
// measures its window span from is injected.
const loadAccountState = async () => ({ lastSuccessfulSync: null });

const SERVICE_SRC = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");

function createStore() {
  const rows = [];
  let seq = 0;
  const clone = (r) => JSON.parse(JSON.stringify(r));
  const match = (row, where = {}) => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "AND") { if (!cond.every((w) => match(row, w))) return false; continue; }
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
      rows.push(row); return clone(row);
    },
    async update({ where, data }) { const row = rows.find((r) => r.id === where.id); apply(row, data); return clone(row); },
    async updateMany({ where, data }) { let count = 0; for (const row of rows) if (match(row, where)) { apply(row, data); count += 1; } return { count }; },
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { const list = sort(rows.filter((r) => match(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
  };
  return { rows, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

let clock = new Date("2026-09-15T12:00:00.000Z");
const now = () => clock;
const resetClock = () => { clock = new Date("2026-09-15T12:00:00.000Z"); };
const expireLease = () => { clock = new Date(clock.getTime() + DEFAULT_LEASE_MS + 1000); };

const OPTIMISE_KEY = accountLockKey({ platform: "optimise_sea", accountLabel: "default" });

/** A run shaped like production c9e3e699: unit 1 completed, unit 2 claimed then abandoned. */
async function productionShape({ syncImpl } = {}) {
  resetClock();
  const { rows, prisma } = createStore();
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts: async () => ["default"], loadAccountState });
  const locks = new SyncAccountLockService({ prisma, now });
  const calls = [];
  const locals = {
    syncOrchestration: orchestration,
    syncAccountLocks: locks,
    syncPlatformAccount: async (platform, accountLabel, options) => {
      calls.push({ platform, accountLabel, options });
      if (syncImpl) return syncImpl({ platform, accountLabel, options });
      return { [accountLabel ?? "default"]: { campaigns: 1 } };
    },
  };
  const run = await orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [
    { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: {} },
    { kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", options: {} },
    { kind: UNIT_KINDS.NETWORK, platform: "trackier", accountLabel: "default", options: {} },
  ] });
  const first = await orchestration.nextUnit(run.id);
  await orchestration.claimUnit(first.id, { workerId: "w1" });
  await orchestration.completeUnit(first.id, { counts: { campaigns: 7 } });
  const stale = await orchestration.nextUnit(run.id);
  await orchestration.claimUnit(stale.id, { workerId: "killed-invocation" });
  const worker = async () => {
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await triggerSyncWorker({ app: { locals } }, res, (error) => { throw error; });
    return res;
  };
  return { rows, prisma, orchestration, locks, calls, run, stale, worker, row: (id) => rows.find((r) => r.id === id) };
}

describe("an expired claim is an abandoned attempt", () => {
  it("stale at attempt 1 of 3 → reclaimed as attempt 2, exactly once", async () => {
    const h = await productionShape();
    assert.equal(h.row(h.stale.id).attempt, 1);
    expireLease();
    const reclaim = await h.orchestration.claimUnit(h.stale.id, { workerId: "next" });
    assert.equal(reclaim.claimed, true);
    assert.equal(reclaim.reclaimed, true);
    assert.equal(h.row(h.stale.id).attempt, 2);
    assert.equal(h.row(h.stale.id).status, "RUNNING");
    resetClock();
  });

  it("stale at attempt 2 of 3 → reclaimed as attempt 3", async () => {
    const h = await productionShape();
    expireLease();
    await h.orchestration.claimUnit(h.stale.id, { workerId: "second" });
    expireLease();
    const reclaim = await h.orchestration.claimUnit(h.stale.id, { workerId: "third" });
    assert.equal(reclaim.claimed, true);
    assert.equal(h.row(h.stale.id).attempt, 3);
    assert.equal(h.row(h.stale.id).status, "RUNNING");
    resetClock();
  });

  it("stale AT maxAttempts → DEAD_LETTER with a safe reason, terminal timestamps, and no reclaim", async () => {
    const h = await productionShape();
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "second" });
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "third" });
    assert.equal(h.row(h.stale.id).attempt, 3, "attempts are spent");

    expireLease();
    const refused = await h.orchestration.claimUnit(h.stale.id, { workerId: "fourth" });
    assert.equal(refused.claimed, false);
    assert.equal(refused.reason, "abandoned");
    assert.equal(refused.status, "DEAD_LETTER");
    assert.equal(refused.abandonedReason, ABANDONED_UNIT_REASON);

    const row = h.row(h.stale.id);
    assert.equal(row.status, "DEAD_LETTER");
    assert.equal(row.attempt, 3, "terminalising does not spend another attempt");
    assert.equal(row.lastError, ABANDONED_UNIT_REASON);
    assert.ok(row.completedAt, "terminal timestamp set");
    assert.ok(!/token|secret|http/i.test(row.lastError), "the reason is safe text");
    resetClock();
  });

  it("the failed unit is counted at once, and the parent fails once every unit has settled", async () => {
    const h = await productionShape();
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "b" });
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "c" });
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "d" });

    // Counted immediately — but another account's unit is still outstanding, and terminalising
    // this one does not abandon it. The parent finalises only when every unit has settled, which
    // is the existing precedence, unchanged.
    let status = await h.orchestration.describeRun(h.run.id);
    assert.equal(status.failedUnits, 1);
    assert.equal(status.completedUnits, 1, "the Boostiny unit's success is preserved");
    assert.equal(status.status, "running");
    assert.equal(h.row(h.run.id).status, "RUNNING");
    assert.equal(h.row(h.run.id).result.failedUnits, 1, "the parent's durable counters carry it");

    const last = await h.orchestration.nextUnit(h.run.id);
    assert.equal(last.payload.platform, "trackier", "the abandoned unit is never offered again");
    await h.orchestration.claimUnit(last.id, { workerId: "e" });
    await h.orchestration.completeUnit(last.id, { counts: { campaigns: 2 } });

    const parent = h.row(h.run.id);
    assert.equal(parent.status, "FAILED");
    assert.ok(parent.completedAt);
    status = await h.orchestration.describeRun(h.run.id);
    assert.equal(status.status, "failed");
    assert.equal(status.failedUnits, 1);
    assert.equal(status.completedUnits, 2);
    assert.equal(status.latestError, ABANDONED_UNIT_REASON);
    assert.ok(status.finishedAt);
    resetClock();
  });

  it("the account lock is free once the unit is terminal", async () => {
    const h = await productionShape();
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "b" });
    // Freshly reclaimed: the account is held again.
    assert.equal(await h.locks.isFree(OPTIMISE_KEY), false);
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "c" });
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "d" });
    assert.equal(h.row(h.stale.id).status, "DEAD_LETTER");
    assert.equal(await h.locks.isFree(OPTIMISE_KEY), true, "a terminal unit holds nothing");
    assert.equal((await h.locks.acquire(OPTIMISE_KEY, { holderId: "manual" })).acquired, true);
    resetClock();
  });

  it("terminalisation refuses a live claim — an unexpired RUNNING unit is untouched", async () => {
    const h = await productionShape();
    const result = await h.orchestration.abandonStaleUnit(h.stale.id);
    assert.equal(result.abandoned, false, "a worker still inside its lease is not declared dead");
    const row = h.row(h.stale.id);
    assert.equal(row.status, "RUNNING");
    assert.equal(row.attempt, 1);
    assert.equal(row.lastError, null);
    assert.equal(row.completedAt, null);
    assert.equal(h.row(h.run.id).status, "RUNNING");
    resetClock();
  });

  it("concurrent reclaim of the same stale unit increments the attempt exactly once", async () => {
    const h = await productionShape();
    expireLease();
    const [a, b] = await Promise.all([
      h.orchestration.claimUnit(h.stale.id, { workerId: "a" }),
      h.orchestration.claimUnit(h.stale.id, { workerId: "b" }),
    ]);
    assert.equal([a.claimed, b.claimed].filter(Boolean).length, 1, "exactly one winner");
    assert.equal(h.row(h.stale.id).attempt, 2, "not 3 — no double increment");
    resetClock();
  });

  it("concurrent terminalisation happens exactly once", async () => {
    const h = await productionShape();
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "b" });
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "c" });
    expireLease();
    const [a, b] = await Promise.all([
      h.orchestration.claimUnit(h.stale.id, { workerId: "x" }),
      h.orchestration.claimUnit(h.stale.id, { workerId: "y" }),
    ]);
    assert.ok(!a.claimed && !b.claimed);
    const abandoned = [a, b].filter((r) => r.reason === "abandoned");
    assert.equal(abandoned.length, 1, "one terminalisation, the other sees it already gone");
    assert.equal(h.row(h.stale.id).attempt, 3);
    assert.equal(h.row(h.stale.id).status, "DEAD_LETTER");
    resetClock();
  });
});

describe("the worker never runs supplier work for an abandoned unit", () => {
  it("reports unit_abandoned, executes nothing, and moves on to the next unit afterwards", async () => {
    const h = await productionShape();
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "b" });
    expireLease(); await h.orchestration.claimUnit(h.stale.id, { workerId: "c" });
    expireLease();

    const res = await h.worker();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.worked, false);
    assert.equal(res.body.status, "unit_abandoned");
    assert.equal(res.body.reason, ABANDONED_UNIT_REASON);
    assert.equal(res.body.unit.platform, "optimise_sea");
    assert.equal(res.body.unit.status, "DEAD_LETTER");
    assert.equal(h.calls.length, 0, "no supplier work ran for the abandoned unit");
    assert.equal(res.body.syncStatus.failedUnits, 1);

    // The abandoned unit is never offered again: the next invocation works the NEXT account.
    const next = await h.worker();
    assert.equal(next.body.worked, true);
    assert.equal(next.body.unit.platform, "trackier");
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls.every((c) => c.platform !== "optimise_sea"), "the dead unit never reaches a supplier");

    const done = await h.worker();
    assert.equal(done.body.worked, false);
    assert.equal(done.body.status, "idle");
    assert.equal(h.calls.length, 1);
    const status = await h.orchestration.describeRun(h.run.id);
    assert.equal(status.status, "failed");
    assert.equal(status.failedUnits, 1);
    resetClock();
  });

  it("a stale unit WITH attempts left is simply reclaimed and executed", async () => {
    const h = await productionShape();
    expireLease();
    const res = await h.worker();
    assert.equal(res.body.worked, true);
    assert.equal(res.body.status, "unit_completed");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].platform, "optimise_sea");
    assert.equal(h.row(h.stale.id).status, "COMPLETED");
    assert.equal(h.row(h.stale.id).attempt, 2, "the abandoned attempt still counted");
    resetClock();
  });
});

describe("explicit failure semantics are unchanged", () => {
  it("failUnit still retries while attempts remain and dead-letters with its own error", async () => {
    const h = await productionShape();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await h.orchestration.failUnit(h.stale.id, new Error("zzexplicitzz"));
      const row = h.row(h.stale.id);
      assert.equal(row.attempt, attempt, "an explicit failure never spends an extra attempt");
      if (attempt < 3) {
        assert.equal(row.status, "PENDING", "retryable, exactly as before");
        assert.equal(row.lastError, "zzexplicitzz");
        await h.orchestration.claimUnit(h.stale.id, { workerId: "w" });
      }
    }
    const row = h.row(h.stale.id);
    assert.equal(row.status, "DEAD_LETTER");
    assert.ok(row.completedAt);
    assert.equal(row.lastError, "zzexplicitzz", "its own error, not the abandonment reason");
    assert.notEqual(row.lastError, ABANDONED_UNIT_REASON);
    const status = await h.orchestration.describeRun(h.run.id);
    assert.equal(status.failedUnits, 1);
    assert.equal(status.latestError, "zzexplicitzz");
    resetClock();
  });

  it("a PENDING unit is never treated as abandoned, whatever the clock says", async () => {
    const h = await productionShape();
    await h.orchestration.failUnit(h.stale.id, new Error("zzbackzz"));
    assert.equal(h.row(h.stale.id).status, "PENDING");
    expireLease();
    const claim = await h.orchestration.claimUnit(h.stale.id, { workerId: "w" });
    assert.equal(claim.claimed, true);
    assert.equal(claim.reclaimed, false, "a fresh PENDING claim, not a reclaim");
    resetClock();
  });
});

describe("source guards", () => {
  it("terminalisation is conditional, uses no new mechanism, and leaves failUnit alone", () => {
    const fn = SERVICE_SRC.split("  async abandonStaleUnit(")[1].split("\n  }")[0];
    assert.match(fn, /status: "RUNNING", startedAt: \{ lt: cutoff \}/, "only an expired RUNNING claim");
    assert.match(fn, /status: "DEAD_LETTER", completedAt: at, lastError: reason/);
    assert.match(fn, /if \(count !== 1\) return \{ abandoned: false/, "raced terminalisation is a no-op");
    assert.match(fn, /await this\.refreshRun\(/, "parent finalised through the existing precedence");
    for (const forbidden of ["prisma.$queryRaw", "advisory", "CREATE TABLE", "migrate", "new Table"]) {
      assert.ok(!fn.includes(forbidden), forbidden);
    }
    const failUnit = SERVICE_SRC.split("  async failUnit(")[1].split("\n  }")[0];
    assert.match(failUnit, /const retry = \(unit\.attempt \?\? 0\) < \(unit\.maxAttempts \?\? this\.maxAttempts\);/);
    assert.ok(!failUnit.includes(ABANDONED_UNIT_REASON), "explicit failures keep their own error");
  });

  it("the attempts check sits before the reclaim, so no supplier work follows it", () => {
    const claim = SERVICE_SRC.split("  async claimUnit(")[1].split("\n  }")[0];
    assert.ok(claim.indexOf("abandonStaleUnit") < claim.indexOf("const fresh ="), "checked before any reclaim");
    assert.match(claim, /leaseExpired && \(unit\.attempt \?\? 0\) >= \(unit\.maxAttempts \?\? this\.maxAttempts\)/);
  });
});
