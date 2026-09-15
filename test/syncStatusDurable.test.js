/**
 * Phase 4 — durable /sync/status, and what a killed worker actually leaves behind.
 *
 * The in-memory projection only knows about the instance answering the request. These tests drive
 * the status handler over a store that a DIFFERENT instance wrote, prove it reports the durable
 * JobRun state without mutating it, and then reproduce a worker dying mid-unit (the production
 * FUNCTION_INVOCATION_TIMEOUT) to establish exactly which durable states survive and when they
 * become recoverable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getSyncStatusHandler } from "../src/controllers/sync.controller.js";
import {
  ORCHESTRATION_JOB_NAME,
  UNIT_JOB_NAME,
  UNIT_KINDS,
  UNIT_BLOCKED_REASON,
  DEFAULT_LEASE_MS,
  SyncOrchestrationService,
  safeUnitError,
} from "../src/jobs/syncOrchestration.service.js";
import { SyncAccountLockService, accountLockKey } from "../src/jobs/syncAccountLock.service.js";

const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");
const handlerOf = (name) => CONTROLLER_SRC.split(`export async function ${name}`)[1].split("\nexport ")[0];

function createStore() {
  const rows = [];
  const ops = [];
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
      ops.push("create"); seq += 1;
      const row = { id: `row-${String(seq).padStart(3, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(Date.now() + seq), ...data };
      rows.push(row); return clone(row);
    },
    async update({ where, data }) { ops.push("update"); const row = rows.find((r) => r.id === where.id); apply(row, data); return clone(row); },
    async updateMany({ where, data }) { ops.push("updateMany"); let count = 0; for (const row of rows) if (match(row, where)) { apply(row, data); count += 1; } return { count }; },
    async findUnique({ where }) { ops.push("read"); const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { ops.push("read"); const list = sort(rows.filter((r) => match(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy }) { ops.push("read"); return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
  };
  return { rows, ops, prisma: { jobRun, async $transaction(fn) { ops.push("$transaction"); return fn({ jobRun }); } } };
}

let clock = new Date("2026-09-15T12:00:00.000Z");
const now = () => clock;
const resetClock = () => { clock = new Date("2026-09-15T12:00:00.000Z"); };
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };

function harness({ prisma: injected } = {}) {
  const store = injected ? { prisma: injected, rows: [], ops: [] } : createStore();
  const orchestration = new SyncOrchestrationService({ prisma: store.prisma, now, listAccounts: async () => ["default"] });
  const locks = new SyncAccountLockService({ prisma: store.prisma, now });
  const status = async (query = {}) => {
    const res = { statusCode: 200, body: null, headers: {} };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    await getSyncStatusHandler({ query, app: { locals: { syncOrchestration: orchestration } } }, res);
    return res;
  };
  return { ...store, orchestration, locks, status };
}

const networkUnit = (platform, accountLabel, extra = {}) => ({ kind: UNIT_KINDS.NETWORK, platform, accountLabel, options: { fastSync: false, promoteAfter: false }, ...extra });

describe("durable status — read from JobRun, never module memory", () => {
  it("reports a run written by another instance, with parent counters and per-unit rows", async () => {
    resetClock();
    const h = harness();
    // A different instance created the run and completed its first unit.
    const writer = new SyncOrchestrationService({ prisma: h.prisma, now, listAccounts: async () => ["default"] });
    const run = await writer.createRun({ kind: "full", trigger: "api", options: { promoteAfter: true }, units: [
      networkUnit("boostiny", "default"),
      networkUnit("optimise_sea", "default", { sourceObject: "campaigns" }),
      { kind: UNIT_KINDS.PROMOTION, options: {}, executable: false, blockedReason: UNIT_BLOCKED_REASON },
    ] });
    const first = await writer.nextUnit(run.id);
    await writer.claimUnit(first.id, { workerId: "another-instance" });
    await writer.completeUnit(first.id, { counts: { campaigns: 7 }, partialSuccess: false });

    const res = await h.status();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.source, "durable");
    assert.equal(res.body.runId, run.id);
    assert.equal(res.headers["Cache-Control"], "no-store");

    assert.equal(res.body.run.status, "running");
    assert.equal(res.body.run.totalUnits, 3);
    assert.equal(res.body.run.completedUnits, 1);
    assert.equal(res.body.run.failedUnits, 0);
    assert.equal(res.body.run.pendingUnits, 1);
    assert.equal(res.body.run.blockedUnits, 1);
    assert.equal(res.body.run.postSyncPending, true);

    assert.equal(res.body.units.length, 3);
    assert.deepEqual(res.body.units.map((u) => [u.sequence, u.platform, u.status]), [
      [1, "boostiny", "COMPLETED"],
      [2, "optimise_sea", "PENDING"],
      [3, null, "PENDING"],
    ]);
    assert.equal(res.body.units[1].sourceObject, "campaigns");
    assert.equal(res.body.units[2].executable, false);
    assert.equal(res.body.units[2].blockedReason, UNIT_BLOCKED_REASON);
    // The in-memory block is still carried, and is plainly not the source of truth.
    assert.equal(res.body.inMemory.status, "idle");
    assert.notEqual(res.body.status, res.body.inMemory.status);
  });

  it("?runId= inspects one specific run; an unknown id is a 404, not the latest run", async () => {
    resetClock();
    const h = harness();
    const older = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    const newer = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { fastSync: true, promoteAfter: false }, units: [networkUnit("trackier", "default")] });

    assert.equal((await h.status({ runId: older.id })).body.runId, older.id);
    assert.equal((await h.status({ runId: newer.id })).body.runId, newer.id);
    assert.equal((await h.status({ runId: ` ${older.id} ` })).body.runId, older.id, "trimmed");
    const missing = await h.status({ runId: "zzdoes-not-existzz" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.runId, "zzdoes-not-existzz");
    assert.equal(missing.body.run, undefined, "a 404 never falls back to another run");
  });

  it("exposes no supplier payload, credential or raw result", async () => {
    resetClock();
    const h = harness();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    const unit = await h.orchestration.nextUnit(run.id);
    await h.orchestration.claimUnit(unit.id, { workerId: "w" });
    await h.orchestration.completeUnit(unit.id, { counts: { campaigns: 7 }, warnings: ["zzwarnzz"], rawRows: [{ zzsecretzz: "zzpayloadzz" }] });

    const body = JSON.stringify((await h.status()).body);
    for (const secret of ["zzsecretzz", "zzpayloadzz", "rawRows", "apiKey", "Authorization", "Bearer"]) {
      assert.ok(!body.includes(secret), secret);
    }
    const summary = (await h.status()).body.units[0];
    assert.deepEqual(summary.counts, { campaigns: 7 }, "counts are safe and useful");
    assert.equal(summary.partialSuccess, null, "not reported by this outcome, and not invented");
  });

  it("redacts a failing unit's error IN THE RESPONSE, not just in the helper", async () => {
    resetClock();
    const h = harness();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    const unit = await h.orchestration.nextUnit(run.id);
    await h.orchestration.claimUnit(unit.id, { workerId: "w" });
    await h.orchestration.failUnit(unit.id, new Error("GET https://api.supplier.test/v1/reports failed: Bearer zzsupersecrettokenvaluezz api_key=zzleakedkeyzz"));

    const summary = (await h.status()).body.units[0];
    assert.equal(summary.status, "PENDING", "retryable, so still pending");
    assert.ok(summary.lastError, "the failure is reported…");
    const body = JSON.stringify((await h.status()).body);
    for (const secret of ["zzsupersecrettokenvaluezz", "zzleakedkeyzz", "api.supplier.test"]) {
      assert.ok(!body.includes(secret), `…without ${secret}`);
    }
    assert.match(summary.lastError, /Bearer \[redacted\]/);
    assert.match(summary.lastError, /\[url\]/);
  });

  it("redacts credentials and URLs out of a unit error", async () => {
    assert.equal(safeUnitError(null), null);
    assert.match(safeUnitError("failed with Bearer abcdefghijklmnop"), /Bearer \[redacted\]/);
    assert.match(safeUnitError("api_key=zzsupersecretzz denied"), /api_key=\[redacted\]/);
    assert.match(safeUnitError("GET https://api.example.test/v1/reports?key=1 failed"), /\[url\]/);
    assert.ok(safeUnitError("z".repeat(500)).length <= 301);
  });

  it("is strictly read-only: no write of any kind reaches the store", async () => {
    resetClock();
    const h = harness();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: true }, units: [networkUnit("boostiny", "default")] });
    const unit = await h.orchestration.nextUnit(run.id);
    await h.orchestration.claimUnit(unit.id, { workerId: "w" });

    const before = JSON.stringify(h.rows);
    h.ops.length = 0;
    await h.status();
    await h.status({ runId: run.id });
    assert.deepEqual(h.ops.filter((o) => o !== "read"), [], "reads only: no create, update, updateMany or transaction");
    assert.equal(JSON.stringify(h.rows), before, "not one row changed");
  });

  it("degrades to the in-memory block when the durable read fails, instead of failing the diagnostic endpoint", async () => {
    const broken = { jobRun: { findFirst: async () => { throw new Error("zzpool timeoutzz"); }, findUnique: async () => { throw new Error("zzpool timeoutzz"); }, findMany: async () => { throw new Error("zzpool timeoutzz"); } } };
    const h = harness({ prisma: broken });
    const res = await h.status();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.source, "in-memory");
    assert.equal(res.body.run, null);
    assert.ok(res.body.durableError, "the failure is reported, not hidden");
    assert.equal(res.body.inMemory.status, "idle");
  });
});

describe("a worker killed mid-unit — what survives, and when it recovers", () => {
  /** Claim a unit and then abandon it: the shape of a Vercel FUNCTION_INVOCATION_TIMEOUT. */
  async function claimThenDie(h, run) {
    const unit = await h.orchestration.nextUnit(run.id);
    const claim = await h.orchestration.claimUnit(unit.id, { workerId: "killed-invocation" });
    assert.equal(claim.claimed, true);
    return unit;
  }

  it("leaves the unit RUNNING with its claim, the parent RUNNING, and no orphan lock row", async () => {
    resetClock();
    const h = harness();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: true }, units: [networkUnit("boostiny", "default"), networkUnit("optimise_sea", "default")] });
    const unit = await claimThenDie(h, run);

    const row = h.rows.find((r) => r.id === unit.id);
    assert.equal(row.status, "RUNNING", "no completeUnit and no failUnit ever ran");
    assert.equal(row.attempt, 1);
    assert.ok(row.startedAt);
    assert.equal(row.completedAt, null);
    assert.equal(row.lastError, null, "a killed worker records no error at all");
    assert.equal(h.rows.find((r) => r.id === run.id).status, "RUNNING");
    assert.equal(h.rows.filter((r) => r.jobName === "sync:lock").length, 0, "the worker path holds the lock through the unit row, so no lock row leaks");

    // Visible as such in durable status.
    const summary = (await h.status()).body.units[0];
    assert.equal(summary.status, "RUNNING");
    assert.equal(summary.attempt, 1);
    assert.ok(summary.leaseExpiresAt);
    assert.equal(summary.staleClaim, false, "still within its lease");
  });

  it("holds the account lock until the lease expires, then the unit is offered and reclaimed", async () => {
    resetClock();
    const h = harness();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    const unit = await claimThenDie(h, run);
    const key = accountLockKey({ platform: "boostiny", accountLabel: "default" });

    // Within the lease: the account is locked and the unit is not offered again.
    assert.equal(await h.locks.isFree(key), false);
    assert.equal(await h.orchestration.nextUnit(run.id), null, "not retried while the lease is live");
    assert.equal((await h.locks.acquire(key, { holderId: "manual" })).acquired, false);

    advance(DEFAULT_LEASE_MS + 1000);

    // After the lease: reclaimable by either path.
    assert.equal(await h.locks.isFree(key), true, "the dead worker no longer holds the account");
    assert.equal((await h.status()).body.units[0].staleClaim, true, "durable status flags the stale claim");
    const offered = await h.orchestration.nextUnit(run.id);
    assert.equal(offered?.id, unit.id, "the abandoned unit is offered again");
    const reclaim = await h.orchestration.claimUnit(unit.id, { workerId: "next-worker" });
    assert.equal(reclaim.claimed, true);
    assert.equal(reclaim.reclaimed, true);
    assert.equal(h.rows.find((r) => r.id === unit.id).attempt, 2, "the reclaim counts as an attempt");
    resetClock();
  });

  it("GAP: a unit whose worker keeps dying is reclaimed for ever and never dead-letters", async () => {
    resetClock();
    const h = harness();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    const unit = await claimThenDie(h, run);

    // Five successive timeouts — well past maxAttempts (3).
    for (let i = 0; i < 5; i += 1) {
      advance(DEFAULT_LEASE_MS + 1000);
      const reclaim = await h.orchestration.claimUnit(unit.id, { workerId: `killed-${i}` });
      assert.equal(reclaim.claimed, true, `reclaim ${i} still succeeds`);
    }
    const row = h.rows.find((r) => r.id === unit.id);
    assert.equal(row.attempt, 6, "attempts keep climbing");
    assert.ok(row.attempt > row.maxAttempts, "past maxAttempts…");
    assert.equal(row.status, "RUNNING", "…yet the unit is still RUNNING, never DEAD_LETTER");
    assert.equal(h.rows.find((r) => r.id === run.id).status, "RUNNING", "so the parent never terminates either");
    // maxAttempts is only enforced on an EXPLICIT failure, which a killed invocation never reports.
    const status = await h.status();
    assert.equal(status.body.run.failedUnits, 0);
    assert.equal(status.body.run.status, "running");
    resetClock();
  });

  it("an explicitly failing unit still dead-letters normally — the gap is specific to silent death", async () => {
    resetClock();
    const h = harness();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    const unit = await h.orchestration.nextUnit(run.id);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await h.orchestration.claimUnit(unit.id, { workerId: "w" });
      await h.orchestration.failUnit(unit.id, new Error("zzboomzz"));
    }
    assert.equal(h.rows.find((r) => r.id === unit.id).status, "DEAD_LETTER");
    assert.equal(h.rows.find((r) => r.id === run.id).status, "FAILED");
  });
});

describe("source guards", () => {
  const handler = handlerOf("getSyncStatusHandler");

  it("the status handler reads durable state and mutates nothing", () => {
    assert.match(handler, /orchestration\.inspectRun\(requestedRunId\)/);
    assert.match(handler, /orchestration\.inspectLatestRun\(\)/);
    assert.match(handler, /req\?\.query\?\.runId/);
    assert.match(handler, /res\.status\(404\)/);
    assert.match(handler, /source: run \? "durable" : "in-memory"/);
    for (const forbidden of ["refreshRun", "claimUnit", "completeUnit", "failUnit", "createRun", "getOrCreateRun", "collapseDuplicateRun", "acquire(", "release(", "syncPlatformAccount"]) {
      assert.ok(!handler.includes(forbidden), forbidden);
    }
  });

  it("inspection helpers on the service are read-only too", () => {
    const src = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");
    for (const name of ["inspectRun", "inspectLatestRun", "listUnitSummaries", "unitSummary"]) {
      const fn = src.split(`  ${name}(`)[1] ?? src.split(`  async ${name}(`)[1];
      assert.ok(fn, name);
      const body = fn.split("\n  }")[0];
      for (const forbidden of ["update(", "updateMany(", "create(", "$transaction"]) {
        assert.ok(!body.includes(forbidden), `${name} must not ${forbidden}`);
      }
    }
  });
});
