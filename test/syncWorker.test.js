/**
 * Phase 3 — one bounded unit per invocation, and the manual route on the SAME durable lock.
 *
 * POST /sync/worker claims exactly one executable network unit, awaits exactly one account sync
 * with promoteAfter forced false, records the outcome and returns. The manual per-network route
 * now takes the same account-scoped durable lock, so a worker unit and a manual run of the same
 * account can never overlap across instances — which module memory could never guarantee.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { triggerSyncWorker, triggerSyncPlatform } from "../src/controllers/sync.controller.js";
import {
  UNIT_JOB_NAME,
  UNIT_KINDS,
  UNIT_BLOCKED_REASON,
  SyncOrchestrationService,
  summariseSyncUnitOutcome,
} from "../src/jobs/syncOrchestration.service.js";
import { DEFAULT_LEASE_MS, SyncAccountLockService, accountLockKey } from "../src/jobs/syncAccountLock.service.js";

// Never let a plan reach the real database from a unit test: the account state the planner
// measures its window span from is injected.
const loadAccountState = async () => ({ lastSuccessfulSync: null });

const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");
const ROUTES_SRC = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
const handlerOf = (name) => CONTROLLER_SRC.split(`export async function ${name}`)[1].split("\nexport ")[0];

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
      rows.push(row);
      return clone(row);
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
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };

/** One app: one store, one orchestration service, one lock vocabulary, one stubbed account sync. */
function app({ syncImpl } = {}) {
  const { rows, prisma } = createStore();
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts: async () => ["default"], loadAccountState });
  const locks = new SyncAccountLockService({ prisma, now });
  const calls = [];
  const syncPlatformAccount = async (platform, accountLabel, options) => {
    calls.push({ platform, accountLabel, options });
    if (syncImpl) return syncImpl({ platform, accountLabel, options });
    return { [accountLabel ?? "default"]: { campaigns: 7, conversions: 3 } };
  };
  const locals = { syncOrchestration: orchestration, syncAccountLocks: locks, syncPlatformAccount };
  const makeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  };
  return {
    rows, prisma, orchestration, locks, calls,
    async worker() {
      const res = makeRes();
      await triggerSyncWorker({ app: { locals } }, res, (error) => { throw error; });
      return res;
    },
    async manual(platform, accountLabel, query = {}) {
      const res = makeRes();
      await triggerSyncPlatform({ params: { platform, accountLabel }, query, app: { locals } }, res, (error) => { throw error; });
      return res;
    },
    unit(runId) { return rows.find((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId); },
    units(runId) { return rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId); },
  };
}

const networkUnit = (platform, accountLabel, extra = {}) => ({ kind: UNIT_KINDS.NETWORK, platform, accountLabel, options: { fastSync: false, promoteAfter: false }, ...extra });

describe("worker — exactly one bounded unit per invocation", () => {
  it("claims one unit, awaits one account sync, records the outcome and returns", async () => {
    resetClock();
    const h = app();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default"), networkUnit("trackier", "default")] });

    const res = await h.worker();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.worked, true);
    assert.equal(res.body.status, "unit_completed");
    assert.equal(res.body.runId, run.id);
    assert.equal(res.body.unit.platform, "boostiny");
    assert.equal(res.body.unit.status, "COMPLETED");

    // Exactly one sync, exactly one unit advanced.
    assert.equal(h.calls.length, 1, "one account sync only");
    assert.equal(h.calls[0].platform, "boostiny");
    const [first, second] = h.units(run.id);
    assert.equal(first.status, "COMPLETED");
    assert.equal(second.status, "PENDING", "the next unit is left for the next invocation");
    assert.equal(res.body.syncStatus.completedUnits, 1);
    assert.equal(res.body.syncStatus.totalUnits, 2);
    assert.deepEqual(first.result.outcome.counts, { campaigns: 7, conversions: 3 });

    // A second invocation advances exactly one more.
    const next = await h.worker();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].platform, "trackier");
    assert.equal(next.body.syncStatus.completedUnits, 2);
    // …and then there is nothing left to do.
    const idle = await h.worker();
    assert.equal(idle.statusCode, 200);
    assert.equal(idle.body.worked, false);
    assert.equal(idle.body.status, "idle");
    assert.equal(h.calls.length, 2, "an idle worker runs nothing");
  });

  it("works the OLDEST active run first, so an older run is never starved by a newer one", async () => {
    resetClock();
    const h = app();
    // Two legitimately distinct active runs (different execution options, so neither collapses).
    const older = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { fastSync: false, promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    const newer = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { fastSync: true, promoteAfter: false }, units: [networkUnit("trackier", "default")] });
    assert.notEqual(older.id, newer.id);

    const first = await h.worker();
    assert.equal(first.body.runId, older.id, "the older run is advanced first");
    assert.equal(h.calls[0].platform, "boostiny");
    const second = await h.worker();
    assert.equal(second.body.runId, newer.id, "then the newer one");
    assert.equal(h.calls[1].platform, "trackier");
  });

  it("passes the unit's recorded fastSync and sourceObject, and ALWAYS forces promoteAfter false", async () => {
    resetClock();
    const h = app();
    await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [
      networkUnit("boostiny", "second", { options: { fastSync: true, promoteAfter: true }, sourceObject: "campaigns" }),
    ] });
    await h.worker();
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].platform, "boostiny");
    assert.equal(h.calls[0].accountLabel, "second");
    assert.equal(h.calls[0].options.fastSync, true, "the unit's own fastSync");
    assert.equal(h.calls[0].options.sourceObject, "campaigns", "the unit's own sourceObject");
    assert.equal(h.calls[0].options.promoteAfter, false, "a unit never runs the global stages, whatever it recorded");
  });

  it("never runs a post-sync placeholder: it is not offered, not claimable, and not executed", async () => {
    resetClock();
    const h = app();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: true, includePostSyncUnits: true }, units: [
      { kind: UNIT_KINDS.PROMOTION, options: {}, executable: false, blockedReason: UNIT_BLOCKED_REASON },
      { kind: UNIT_KINDS.AGGREGATION, options: {}, executable: false, blockedReason: UNIT_BLOCKED_REASON },
    ] });
    const res = await h.worker();
    assert.equal(res.body.worked, false);
    assert.equal(res.body.status, "idle");
    assert.equal(h.calls.length, 0, "no promotion, conversion-promotion or aggregation is executed");
    assert.ok(h.units(run.id).every((u) => u.status === "PENDING"));
    const refused = await h.orchestration.claimUnit(h.units(run.id)[0].id, { workerId: "w" });
    assert.equal(refused.claimed, false);
    assert.equal(refused.reason, "not_executable");
  });

  it("a failing unit returns to PENDING while attempts remain, and DEAD_LETTERs on the last attempt, failing the parent", async () => {
    resetClock();
    let attempts = 0;
    const h = app({ syncImpl: () => { attempts += 1; throw new Error("zzupstream downzz"); } });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default")] });

    for (const attempt of [1, 2]) {
      const res = await h.worker();
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.worked, true);
      assert.equal(res.body.status, "unit_retry", `attempt ${attempt} is retryable`);
      assert.equal(h.unit(run.id).status, "PENDING");
      assert.equal(h.unit(run.id).attempt, attempt);
      assert.equal(h.rows.find((r) => r.id === run.id).status, "RUNNING");
    }
    const last = await h.worker();
    assert.equal(last.body.status, "unit_failed");
    assert.equal(h.unit(run.id).status, "DEAD_LETTER");
    assert.equal(attempts, 3, "one execution per invocation, never a retry loop inside one request");
    const parent = h.rows.find((r) => r.id === run.id);
    assert.equal(parent.status, "FAILED", "a permanently failed unit fails the parent");
    assert.equal(last.body.syncStatus.status, "failed");
    assert.equal(last.body.syncStatus.failedUnits, 1);
    // Nothing is left workable.
    assert.equal((await h.worker()).body.worked, false);
  });

  it("records partial success and warnings from the unit result", async () => {
    resetClock();
    const h = app({ syncImpl: () => ({ default: { partialSuccess: true, warnings: ["zzrate limitedzz"], campaigns: 2 } }) });
    const run = await h.orchestration.createRun({ kind: "full", trigger: "api", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    const res = await h.worker();
    assert.equal(res.body.status, "unit_completed");
    assert.equal(h.unit(run.id).result.outcome.partialSuccess, true);
    assert.deepEqual(h.unit(run.id).result.outcome.warnings, ["zzrate limitedzz"]);
    assert.equal(res.body.syncStatus.status, "partial");
  });

  it("summariseSyncUnitOutcome keeps counts and flags only — never the raw supplier payload", () => {
    const outcome = summariseSyncUnitOutcome({
      default: { campaigns: 7, conversions: 3, skipped: false, rawRows: [{ zzsecretzz: "zzvaluezz" }], nested: { warnings: ["zzwzz"] } },
    }, { accountLabel: "default" });
    assert.deepEqual(outcome.counts, { campaigns: 7, conversions: 3 });
    assert.deepEqual(outcome.warnings, ["zzwzz"]);
    assert.equal(outcome.partialSuccess, false);
    assert.equal(outcome.skipped, false);
    assert.ok(!JSON.stringify(outcome).includes("zzsecretzz"));
    assert.ok(!JSON.stringify(outcome).includes("zzvaluezz"));
    const skipped = summariseSyncUnitOutcome({ default: { skipped: true, reason: "zznot connectedzz" } }, { accountLabel: "default" });
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, "zznot connectedzz");
  });
});

describe("cross-path exclusion — worker units and the manual route share one durable lock", () => {
  it("a worker unit holding Boostiny/default blocks the manual Boostiny/default route with 409", async () => {
    resetClock();
    const h = app();
    const run = await h.orchestration.createRun({ kind: "full", trigger: "scheduler", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    // Another instance's worker has claimed the unit and is mid-sync.
    const unit = await h.orchestration.nextUnit(run.id);
    assert.equal((await h.orchestration.claimUnit(unit.id, { workerId: "other-instance" })).claimed, true);

    const res = await h.manual("boostiny", "default", { sourceObject: "campaigns", promote: "false" });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.lock.key, accountLockKey({ platform: "boostiny", accountLabel: "default" }));
    assert.equal(res.body.lock.heldBy, unit.id);
    assert.equal(res.body.lock.heldByJob, UNIT_JOB_NAME);
    assert.equal(h.calls.length, 0, "the manual sync never ran");

    // Once the unit finishes, the account is free again.
    await h.orchestration.completeUnit(unit.id, { ok: true });
    const after = await h.manual("boostiny", "default", { promote: "false" });
    assert.equal(after.statusCode, 200);
    assert.equal(h.calls.length, 1);
  });

  it("a manual run holding the lock blocks the worker from claiming or executing that account", async () => {
    resetClock();
    const h = app();
    await h.orchestration.createRun({ kind: "full", trigger: "scheduler", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    // Another instance is running the manual route for the same account right now.
    const manual = await h.locks.acquire(accountLockKey({ platform: "boostiny", accountLabel: "default" }), { holderId: "manual:other-instance" });
    assert.equal(manual.acquired, true);

    const res = await h.worker();
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.worked, false);
    assert.equal(res.body.status, "busy");
    assert.equal(res.body.reason, "lock_held");
    assert.equal(res.body.lock.heldBy, manual.lockId);
    assert.equal(h.calls.length, 0, "the worker executed nothing");

    await h.locks.release(manual.lockId);
    const after = await h.worker();
    assert.equal(after.body.worked, true);
    assert.equal(h.calls.length, 1);
  });

  it("different accounts proceed independently", async () => {
    resetClock();
    const h = app();
    await h.orchestration.createRun({ kind: "full", trigger: "scheduler", options: { promoteAfter: false }, units: [networkUnit("boostiny", "second")] });
    const held = await h.locks.acquire(accountLockKey({ platform: "boostiny", accountLabel: "default" }), { holderId: "manual" });
    assert.equal(held.acquired, true);

    const worker = await h.worker();
    assert.equal(worker.body.worked, true, "a different account is not blocked");
    assert.equal(h.calls[0].accountLabel, "second");

    const manual = await h.manual("trackier", "default", { promote: "false" });
    assert.equal(manual.statusCode, 200, "a different network is not blocked either");
  });

  it("a stale durable lock is reclaimed by both paths once the lease expires", async () => {
    resetClock();
    const h = app();
    await h.orchestration.createRun({ kind: "full", trigger: "scheduler", options: { promoteAfter: false }, units: [networkUnit("boostiny", "default")] });
    const crashed = await h.locks.acquire(accountLockKey({ platform: "boostiny", accountLabel: "default" }), { holderId: "crashed-instance" });
    assert.equal(crashed.acquired, true);

    assert.equal((await h.worker()).statusCode, 409, "a live lease is never stolen");
    advance(DEFAULT_LEASE_MS + 1000);
    const worker = await h.worker();
    assert.equal(worker.body.worked, true, "an expired lease is reclaimable by the worker");
    resetClock();
  });

  it("the manual route releases the durable lock on success AND on failure", async () => {
    resetClock();
    const key = accountLockKey({ platform: "boostiny", accountLabel: "default" });
    const ok = app();
    assert.equal((await ok.manual("boostiny", "default", { promote: "false" })).statusCode, 200);
    assert.equal(await ok.locks.isFree(key), true, "released after success");

    const bad = app({ syncImpl: () => { throw new Error("zzsupplier downzz"); } });
    const res = await bad.manual("boostiny", "default", { promote: "false" });
    assert.equal(res.statusCode, 500, "the existing failure response is preserved");
    assert.equal(await bad.locks.isFree(key), true, "released after failure");
  });
});

describe("source guards — one unit, nothing in the background, nothing else changed", () => {
  const worker = handlerOf("triggerSyncWorker");
  const platform = handlerOf("triggerSyncPlatform");

  const executeUnit = CONTROLLER_SRC.split("async function executeUnit(")[1].split("\n}\n")[0];

  it("the worker awaits one unit and never loops, recurses or detaches work", () => {
    assert.match(worker, /await orchestration\.nextWorkableUnit\(\)/);
    assert.match(worker, /await orchestration\.claimUnit\(/);
    assert.match(worker, /await executeUnit\(req, descriptor\)/);
    assert.match(worker, /await orchestration\.completeUnit\(/);
    assert.match(worker, /await orchestration\.failUnit\(/);
    assert.match(worker, /assertUnitExecutable\(unit\)/);
    // Phase 6a — per-kind execution lives in executeUnit; the network branch still refuses
    // promotion and the aggregation branch is one bounded day.
    assert.match(executeUnit, /await accountSyncFor\(req\)\(|return accountSyncFor\(req\)\(/);
    assert.match(executeUnit, /promoteAfter: false,/);
    // No loop, no recursion, no detached work, in EITHER half of the worker path.
    for (const source of [worker, executeUnit]) {
      for (const forbidden of ["for (", "while (", "triggerSyncWorker(", "setTimeout", "setInterval", "setImmediate", ".then(", ".catch(", "void ", "Promise.all", "Promise.race"]) {
        assert.ok(!source.includes(forbidden), forbidden);
      }
    }
    // The unbounded post-sync entrypoints stay out of the controller entirely. AggregationJob and
    // ConversionPromotionService are reachable, but ONLY through their bounded entrypoints: the
    // whole-catalog stages are not.
    for (const forbidden of ["runTrackedJob", "maybePromoteAfterSync", "syncAll"]) {
      assert.ok(!worker.includes(forbidden), forbidden);
      assert.ok(!CONTROLLER_SRC.includes(forbidden), `${forbidden} in the controller`);
    }
    // A CALL, not the word: the module comments explain why rebuild is used instead of
    // runForDate and runPage instead of run, and explaining it is the point.
    assert.ok(!CONTROLLER_SRC.includes("runForDate("), "runForDate called in the controller");
    // Phase 6b — the conversion-promotion service's own run() drains EVERY page in a loop. A
    // bounded unit may only ever reach the single-page entrypoint.
    assert.ok(
      !/ConversionPromotionService\(\)\s*\.\s*run\(/.test(CONTROLLER_SRC),
      "the unbounded ConversionPromotionService.run() drain is called in the controller",
    );
    assert.ok(
      !/conversionPromotion(Service)?\s*\.\s*run\(/.test(CONTROLLER_SRC),
      "an unbounded conversion-promotion drain is called in the controller",
    );
    assert.match(CONTROLLER_SRC, /new ConversionPromotionService\(\)\.runPage\(input\)/);
    // Phase 6c — PromotionJob.run() drains every page of every requested type AND fires the
    // whole-sweep Rakuten commission hook. A bounded unit may only reach the single-page
    // entrypoint, and the retry path must stay out of the worker entirely.
    assert.ok(
      !/PromotionJob\(\)\s*\.\s*run\(/.test(CONTROLLER_SRC),
      "the unbounded PromotionJob.run() drain is called in the controller",
    );
    assert.ok(!CONTROLLER_SRC.includes("runPromotionJob"), "runPromotionJob in the controller");
    assert.ok(!CONTROLLER_SRC.includes("retryPromotionJob"), "retryPromotionJob in the controller");
    assert.ok(!CONTROLLER_SRC.includes("persistRakutenCommissionOffers"), "the Rakuten whole sweep in the controller");
    assert.match(CONTROLLER_SRC, /new PromotionJob\(\)\.runPage\(input\)/);
    assert.ok(!worker.includes("PromotionJob"), "the worker itself never reaches for the job");
    assert.ok(!worker.includes("AggregationJob"), "the worker itself never reaches for the job");
    assert.ok(!worker.includes("ConversionPromotionService"), "the worker itself never reaches for the service");
    // Every promise in the worker path is awaited.
    for (const source of [worker, executeUnit]) {
      for (const call of source.match(/(?<!await )(?<!return )(?<![\w.])(orchestration|accountSyncFor\(req\))\.[a-zA-Z]+\(/g) ?? []) {
        assert.fail(`un-awaited call: ${call}`);
      }
    }
  });

  it("the manual route holds the shared account lock and keeps its awaited 200/409/500 shape", () => {
    assert.match(platform, /const lockKey = accountLockKey\(\{ platform, accountLabel \}\);/);
    assert.match(platform, /await locks\.withLock\(/);
    assert.match(platform, /respondWithExclusiveSync\(\{/);
    assert.match(platform, /if \(!outcome\.ran\) \{\s*return res\.status\(409\)/);
    assert.match(platform, /return outcome\.result;/);
    assert.match(platform, /resolvePlatformSyncOptions\(req\.query\)/, "promote=false still honoured");
    const helper = CONTROLLER_SRC.split("export async function respondWithExclusiveSync")[1].split("\n}")[0];
    assert.match(helper, /const run = await runExclusiveSync\(jobName, syncFn, \{ trigger \}\);/, "kept as a local-instance guard");
    assert.match(helper, /res\.status\(200\)/);
    assert.match(helper, /res\.status\(409\)/);
    assert.match(helper, /res\.status\(500\)/);
  });

  it("the worker route is admin-only, audited, and registered before the generic platform routes", () => {
    const route = ROUTES_SRC.split('"/sync/worker"')[1].split(");")[0];
    for (const guard of ["authenticate,", "requireAdminRole,", "requirePermission(PERMISSIONS.SYNC_TRIGGER),", 'auditAction("sync.worker"', "triggerSyncWorker,"]) {
      assert.ok(route.includes(guard), guard);
    }
    assert.ok(ROUTES_SRC.indexOf('"/sync/worker"') < ROUTES_SRC.indexOf('"/sync/:platform"'), "matched before /sync/:platform");
    assert.ok(!ROUTES_SRC.includes('router.get(\n  "/sync/worker"'), "no GET worker route");
  });

  it("/sync/incremental, /sync/status, the canary and the scheduler are untouched", () => {
    const incremental = handlerOf("triggerIncrementalSync");
    assert.match(incremental, /triggerScheduledSync\(\{ reason: "api" \}\)/);
    assert.ok(!incremental.includes("nextWorkableUnit") && !incremental.includes("withLock"));
    // Phase 4 made status durable; it must still carry the in-memory block and never mutate.
    const status = CONTROLLER_SRC.split("export async function getSyncStatusHandler")[1].split("\nexport ")[0];
    assert.match(status, /inMemory,/);
    assert.match(status, /inspectLatestRun\(\)/);
    assert.ok(!status.includes("claimUnit") && !status.includes("refreshRun"));
    // The canary IS re-wired by the staging-barrier phase: runExclusiveSync guards on module
    // memory, which is per-instance and worthless across serverless invocations, so a live canary
    // could stage Boostiny campaigns with no durable exclusion. It now takes the SAME account lock
    // key as the worker unit and the manual route, and still awaits its run.
    const canary = handlerOf("triggerBoostinyCanarySync");
    assert.match(canary, /const lockKey = accountLockKey\(\{ platform: "boostiny", accountLabel \}\);/);
    // The run is still fully awaited before the response: withLock awaits the function it is given,
    // and that function is what calls runExclusiveSync. Nothing is detached.
    assert.match(canary, /const outcome = await locks\.withLock\(/);
    assert.match(canary, /runExclusiveSync\(/);
    for (const detached of [".then(", "void ", "setTimeout", "setInterval"]) {
      assert.ok(!canary.includes(detached), detached);
    }
    assert.match(canary, /if \(!outcome\.ran\)/, "a held account lock refuses the canary rather than running it");
    assert.ok(!canary.includes("nextWorkableUnit"), "the canary never reaches for orchestration work");
  });
});
