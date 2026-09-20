/**
 * Phase 8C — administrative run cancellation, and the guards that make it real.
 *
 * Cancelling a parent is the easy half. The half that matters is what a worker already in flight
 * can still do afterwards: before this phase `completeUnit` was an unconditional update by id, so
 * a worker could flip its own CANCELLED unit back to COMPLETED under a CANCELLED parent and leave
 * the run's record contradicting itself. The cancel route is worthless without that guard, so most
 * of this file is about the aftermath rather than the transition.
 *
 * Cancellation STOPS future orchestration. It does not roll back supplier, staging or promotion
 * work already committed, and nothing here pretends otherwise.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  ADMIN_CANCELLED_REASON,
  ORCHESTRATION_JOB_NAME,
  PLANNER_VERSION,
  SyncOrchestrationService,
  UNIT_JOB_NAME,
  UNIT_KINDS,
} from "../src/jobs/syncOrchestration.service.js";
import { EntityStagingBarrier, ENTITY_STAGING_BARRIER_KEY } from "../src/jobs/entityStagingBarrier.js";
import { DEFAULT_LEASE_MS, SYNC_LOCK_JOB_NAME, accountLockKey } from "../src/jobs/syncAccountLock.service.js";
import { cancelSyncRunHandler } from "../src/controllers/sync.controller.js";

const SERVICE_SRC = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");
const ROUTES_SRC = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");

/* ------------------------------------------------------------------ durable JobRun fake ----- */

function createStore() {
  const rows = [];
  let seq = 0;
  const clone = (r) => JSON.parse(JSON.stringify(r));
  const match = (row, where = {}) => {
    for (const [k, c] of Object.entries(where)) {
      if (k === "AND") { if (!c.every((w) => match(row, w))) return false; continue; }
      if (k === "payload") {
        let v = row.payload;
        for (const p of c.path ?? []) v = v?.[p];
        if ("equals" in c && v !== c.equals) return false;
        continue;
      }
      const v = row[k];
      if (c && typeof c === "object" && !(c instanceof Date)) {
        if ("in" in c && !c.in.includes(v)) return false;
        if ("not" in c && v === c.not) return false;
        if ("gte" in c && !(v != null && new Date(v) >= new Date(c.gte))) return false;
        if ("lt" in c && !(v != null && new Date(v) < new Date(c.lt))) return false;
        if ("equals" in c && v !== c.equals) return false;
      } else if (v !== c) return false;
    }
    return true;
  };
  const sort = (list, orderBy) => {
    const specs = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...list].sort((a, b) => {
      for (const s of specs) {
        const [f, d] = Object.entries(s)[0];
        const av = a[f] instanceof Date ? a[f].getTime() : a[f];
        const bv = b[f] instanceof Date ? b[f].getTime() : b[f];
        if (av === bv) continue;
        return (av > bv ? 1 : -1) * (d === "desc" ? -1 : 1);
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
      const row = { id: `row-${String(seq).padStart(4, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(Date.now() + seq), ...data };
      rows.push(row);
      return clone(row);
    },
    async createMany({ data }) { for (const d of data) await jobRun.create({ data: d }); return { count: data.length }; },
    async update({ where, data }) { const r = rows.find((x) => x.id === where.id); apply(r, data); return clone(r); },
    async updateMany({ where, data }) { let n = 0; for (const r of rows) if (match(r, where)) { apply(r, data); n += 1; } return { count: n }; },
    async deleteMany({ where }) { const d = rows.filter((r) => match(r, where ?? {})); for (const r of d) rows.splice(rows.indexOf(r), 1); return { count: d.length }; },
    async findUnique({ where }) { const r = rows.find((x) => x.id === where.id); return r ? clone(r) : null; },
    async findFirst({ where, orderBy }) { const l = sort(rows.filter((r) => match(r, where)), orderBy); return l.length ? clone(l[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
  };
  return { rows, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

const RUN_STARTED_AT = new Date("2026-09-18T04:00:00.000Z");
let clock = new Date(RUN_STARTED_AT);
const now = () => clock;
const resetClock = () => { clock = new Date(RUN_STARTED_AT); };
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };

/** A run with a mix of unit states, so every transition is exercised at once. */
function seedRun(store, { plannerVersion = PLANNER_VERSION, status = "RUNNING", units = [] } = {}) {
  const runId = `run-${store.rows.filter((r) => r.jobName === ORCHESTRATION_JOB_NAME).length + 1}`;
  store.rows.push({
    id: runId, jobName: ORCHESTRATION_JOB_NAME, status, priority: 100, attempt: 0, maxAttempts: 1,
    correlationId: runId, startedAt: RUN_STARTED_AT, completedAt: null, createdAt: RUN_STARTED_AT,
    payload: { kind: "full", trigger: "api", plannerVersion, postSyncStages: "deferred", options: { fastSync: false, promoteAfter: true } },
    result: null, lastError: null, progress: 0,
  });
  units.forEach((u, i) => {
    store.rows.push({
      id: `${runId}-u${i + 1}`, jobName: UNIT_JOB_NAME, status: u.status, priority: i + 1,
      attempt: u.attempt ?? (u.status === "RUNNING" ? 1 : 0), maxAttempts: 3, correlationId: runId,
      startedAt: u.status === "RUNNING" ? (u.startedAt ?? RUN_STARTED_AT) : null,
      completedAt: null, createdAt: RUN_STARTED_AT,
      payload: { kind: UNIT_KINDS.NETWORK, platform: u.platform ?? "boostiny", accountLabel: "default", lockKey: accountLockKey({ platform: u.platform ?? "boostiny", accountLabel: "default" }) },
      result: null, lastError: null, progress: 0,
    });
  });
  return runId;
}

const serviceFor = (store) => new SyncOrchestrationService({
  prisma: store.prisma,
  now,
  listAccounts: async () => [],
  loadAccountState: async () => ({ lastSuccessfulSync: null }),
  barrier: new EntityStagingBarrier({ prisma: store.prisma, now }),
});

const unitsOf = (store, runId) => store.rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId);
const parentOf = (store, runId) => store.rows.find((r) => r.id === runId);

/* =============================================================== the cancel transition ====== */

describe("Phase 8C — the cancellation transition", () => {
  it("cancels the parent and PENDING units, and LEAVES running units alone", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [
      { status: "COMPLETED", platform: "boostiny" },
      { status: "RUNNING", platform: "optimise" },
      { status: "PENDING", platform: "awin" },
      { status: "PENDING", platform: "admitad" },
      { status: "DEAD_LETTER", platform: "cj" },
    ] });

    const out = await serviceFor(store).cancelRun(runId, { reason: ADMIN_CANCELLED_REASON, actor: "user-1" });
    assert.equal(out.cancelled, true);
    assert.equal(out.code, "run_cancelled");
    assert.equal(out.unitsCancelled, 2, "both PENDING units");
    assert.equal(out.unitsLeftRunning, 1, "the RUNNING unit is reported, not cancelled");

    const parent = parentOf(store, runId);
    assert.equal(parent.status, "CANCELLED");
    assert.equal(parent.lastError, ADMIN_CANCELLED_REASON);
    assert.ok(parent.completedAt, "completedAt is set");
    assert.equal(parent.payload.cancellation.reason, ADMIN_CANCELLED_REASON);
    assert.equal(parent.payload.cancellation.actor, "user-1");
    assert.ok(parent.payload.cancellation.cancelledAt);
    // The rest of the payload survives — cancellation is additive, not a replacement.
    assert.equal(parent.payload.plannerVersion, PLANNER_VERSION);
    assert.equal(parent.payload.options.promoteAfter, true);

    const byStatus = Object.fromEntries(unitsOf(store, runId).map((u) => [u.payload.platform, u.status]));
    assert.deepEqual(byStatus, {
      boostiny: "COMPLETED",   // terminal, untouched
      optimise: "RUNNING",     // live worker owns it
      awin: "CANCELLED",
      admitad: "CANCELLED",
      cj: "DEAD_LETTER",       // terminal, untouched
    });
  });

  it("is idempotent: a second cancel changes nothing and reports already-terminal", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "PENDING" }] });
    const service = serviceFor(store);

    const first = await service.cancelRun(runId);
    assert.equal(first.code, "run_cancelled");
    const completedAt = parentOf(store, runId).completedAt;

    const second = await service.cancelRun(runId);
    assert.equal(second.cancelled, false);
    assert.equal(second.code, "run_already_terminal");
    assert.equal(parentOf(store, runId).completedAt, completedAt, "the first cancellation's timestamp stands");
  });

  it("two simultaneous cancels produce exactly one cancellation", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "PENDING" }, { status: "PENDING" }] });
    const service = serviceFor(store);

    const [a, b] = await Promise.all([service.cancelRun(runId), service.cancelRun(runId)]);
    const codes = [a.code, b.code].sort();
    assert.deepEqual(codes, ["run_already_terminal", "run_cancelled"], "exactly one winner");
    assert.equal(parentOf(store, runId).status, "CANCELLED");
  });

  it("refuses a foreign-planner run and mutates NOTHING", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { plannerVersion: 3, units: [{ status: "PENDING" }, { status: "RUNNING" }] });
    const before = JSON.stringify(store.rows);

    const out = await serviceFor(store).cancelRun(runId);
    assert.equal(out.cancelled, false);
    assert.equal(out.code, "run_foreign_planner_version");
    assert.equal(JSON.stringify(store.rows), before, "not one row changed");
  });

  it("refuses an unknown id and a unit id", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "PENDING" }] });
    const service = serviceFor(store);
    assert.equal((await service.cancelRun("nope")).code, "run_not_found");
    assert.equal((await service.cancelRun(null)).code, "run_not_found");
    // A child unit is not an orchestration parent.
    assert.equal((await service.cancelRun(unitsOf(store, runId)[0].id)).code, "run_not_found");
  });
});

/* ============================================================== the aftermath guards ======== */

describe("Phase 8C — an in-flight worker cannot mutate a cancelled run", () => {
  const seedInFlight = () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "RUNNING", platform: "optimise" }, { status: "PENDING" }] });
    return { store, runId, service: serviceFor(store), unitId: `${runId}-u1` };
  };

  it("completeUnit does NOT resurrect a unit under a cancelled parent", async () => {
    const { store, runId, service, unitId } = seedInFlight();
    await service.cancelRun(runId);

    await service.completeUnit(unitId, { rowsUpserted: 12 });

    const unit = store.rows.find((r) => r.id === unitId);
    assert.equal(unit.status, "RUNNING", "still RUNNING — not COMPLETED");
    assert.equal(unit.completedAt, null);
    // The work it did is not thrown away silently: it is recorded for an operator to find.
    assert.equal(unit.result.discardedOutcome.reason, "completed_after_run_terminal");
    assert.deepEqual(unit.result.outcome, { rowsUpserted: 12 });
    assert.equal(parentOf(store, runId).status, "CANCELLED", "the parent was not refreshed back to life");
  });

  it("failUnit does NOT return a unit to PENDING under a cancelled parent", async () => {
    const { store, runId, service, unitId } = seedInFlight();
    await service.cancelRun(runId);

    await service.failUnit(unitId, new Error("supplier timeout"));

    const unit = store.rows.find((r) => r.id === unitId);
    assert.equal(unit.status, "RUNNING", "not PENDING — a cancelled run must not become runnable again");
    assert.equal(unit.result.discardedOutcome.reason, "failed_after_run_terminal");
    assert.equal(parentOf(store, runId).status, "CANCELLED");
  });

  it("completeUnit still works normally on an ACTIVE run — the guard is not a blanket refusal", async () => {
    const { store, service, unitId, runId } = seedInFlight();
    await service.completeUnit(unitId, { rowsUpserted: 3 });
    const unit = store.rows.find((r) => r.id === unitId);
    assert.equal(unit.status, "COMPLETED");
    assert.equal(unit.progress, 100);
    assert.deepEqual(unit.result.outcome, { rowsUpserted: 3 });
    assert.ok(!unit.result.discardedOutcome, "nothing was discarded");
    assert.equal(parentOf(store, runId).status, "RUNNING", "parent refreshed, still active");
  });

  it("failUnit still retries normally on an ACTIVE run", async () => {
    const { store, service, unitId } = seedInFlight();
    await service.failUnit(unitId, new Error("transient"));
    const unit = store.rows.find((r) => r.id === unitId);
    assert.equal(unit.status, "PENDING", "attempts remain, so it retries");
    assert.equal(unit.lastError, "transient");
  });

  it("appendUnits and advancePostSync both refuse a cancelled parent", async () => {
    const { store, runId, service } = seedInFlight();
    await service.cancelRun(runId);
    const unitCountBefore = unitsOf(store, runId).length;

    const appended = await service.appendUnits(runId, [{ kind: UNIT_KINDS.NETWORK, platform: "awin", accountLabel: "default", options: {} }]);
    assert.equal(appended.appended, 0);
    assert.equal(appended.reason, "run_terminal");

    const staged = await service.advancePostSync(runId);
    assert.equal(staged.appended, 0);
    assert.equal(staged.reason, "run_terminal");
    assert.equal(unitsOf(store, runId).length, unitCountBefore, "no unit row was added");
  });

  it("cancel versus claim: a PENDING unit cancelled first cannot then be claimed", async () => {
    const { store, runId, service } = seedInFlight();
    const pendingId = `${runId}-u2`;
    await service.cancelRun(runId);
    const claim = await service.claimUnit(pendingId, { workerId: "w1" });
    assert.equal(claim.claimed, false, "a CANCELLED unit is not claimable");
    assert.equal(store.rows.find((r) => r.id === pendingId).status, "CANCELLED");
  });

  it("cancel versus the drain: a cancelled run is never offered as workable", async () => {
    const { store, runId, service } = seedInFlight();
    await service.cancelRun(runId);
    const workable = await service.nextWorkableUnit();
    assert.equal(workable, null, "nextWorkableUnit filters parents by ACTIVE_STATUSES");
  });
});

/* ================================================================ staging + locks =========== */

describe("Phase 8C — staging freeze and locks after cancellation", () => {
  it("a CANCELLED parent drops out of derivedFreeze", async () => {
    resetClock();
    const store = createStore();
    // A run mid-promotion: the state that freezes Entity staging.
    const runId = seedRun(store, { units: [{ status: "COMPLETED" }] });
    parentOf(store, runId).payload.postSyncStages = "materialised";
    store.rows.push({
      id: `${runId}-p1`, jobName: UNIT_JOB_NAME, status: "PENDING", priority: 50, attempt: 0, maxAttempts: 3,
      correlationId: runId, startedAt: null, completedAt: null, createdAt: RUN_STARTED_AT,
      payload: { kind: UNIT_KINDS.PROMOTION, entityType: "campaign" }, result: null, lastError: null, progress: 0,
    });
    const barrier = new EntityStagingBarrier({ prisma: store.prisma, now });

    const before = await barrier.derivedFreeze();
    assert.equal(before.frozen, true, "the fixture really is frozen");
    assert.equal(before.runId, runId);

    await serviceFor(store).cancelRun(runId);

    const after = await barrier.derivedFreeze();
    assert.equal(after.frozen, false, "CANCELLED is not an active status, so the freeze released");
    assert.equal(after.runId, null);
  });

  it("the freeze-intent marker is cleared on cancellation", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "PENDING" }] });
    const barrier = new EntityStagingBarrier({ prisma: store.prisma, now });
    await barrier.announceFreezeIntent({ correlationId: runId });
    assert.ok(await barrier.freezeIntent(), "the intent marker exists");

    const out = await serviceFor(store).cancelRun(runId);
    assert.equal(out.freezeIntentCleared, 1);
    assert.equal(await barrier.freezeIntent(), null, "cleared promptly rather than waiting for its lease");
  });

  it("staging participants are NOT forcibly removed — their lease owns them", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "RUNNING" }] });
    const barrier = new EntityStagingBarrier({ prisma: store.prisma, now });
    const ticket = await barrier.enterStaging("boostiny", { holderId: "w1", correlationId: runId });
    assert.ok(ticket, "a participant exists");
    const participantsBefore = await barrier.activeParticipants();
    assert.equal(participantsBefore.length, 1);

    await serviceFor(store).cancelRun(runId);

    const participantsAfter = await barrier.activeParticipants();
    assert.equal(participantsAfter.length, 1, "still held: a live worker may be mid cursor walk");
    assert.equal(participantsAfter[0].status, "RUNNING");
  });

  it("a RUNNING unit keeps its account lock — cancellation does not release it", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "RUNNING", platform: "optimise" }] });
    const service = serviceFor(store);
    const lockKey = accountLockKey({ platform: "optimise", accountLabel: "default" });
    assert.ok(await service.lockHolder(lockKey), "the running unit holds its lock");

    await service.cancelRun(runId);

    assert.ok(await service.lockHolder(lockKey), "still held while the worker may be writing");
    // …and it is the LEASE that releases it, not the cancellation.
    advance(DEFAULT_LEASE_MS + 1000);
    assert.equal(await service.lockHolder(lockKey), null, "released by lease expiry");
  });
});

/* ================================================================ status projection ========= */

describe("Phase 8C — a cancelled run reports cancelled, not failed", () => {
  it("status is 'cancelled' and cancelled units do not inflate failedUnits", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [
      { status: "COMPLETED" }, { status: "PENDING" }, { status: "PENDING" }, { status: "PENDING" },
    ] });
    const service = serviceFor(store);
    await service.cancelRun(runId, { actor: "user-9" });

    const status = await service.describeRun(runId);
    assert.equal(status.status, "cancelled", "NOT 'failed'");
    assert.equal(status.failedUnits, 0, "three cancelled units are not three failures");
    assert.equal(status.cancelledUnits, 3);
    assert.equal(status.completedUnits, 1);
    assert.equal(status.cancellation.reason, ADMIN_CANCELLED_REASON);
    assert.equal(status.cancellation.actor, "user-9");
    assert.ok(status.cancellation.cancelledAt);
  });

  it("a genuinely failed run still reports failed", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "COMPLETED" }, { status: "DEAD_LETTER" }] });
    const status = await serviceFor(store).describeRun(runId);
    assert.equal(status.failedUnits, 1);
    assert.notEqual(status.status, "cancelled");
  });

  it("a cancelled run stays queryable by id and is what status returns when nothing is active", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "PENDING" }] });
    const service = serviceFor(store);
    await service.cancelRun(runId);

    assert.equal((await service.describeRun(runId))?.status, "cancelled", "queryable by id");
    assert.equal(await service.findActiveRun(), null, "no active run remains");
    const latest = await service.describeLatestRun();
    assert.equal(latest.runId ?? latest.id ?? runId, runId);
    assert.equal(latest.status, "cancelled");
  });

  it("with one active parent enforced, status without a runId is deterministic", async () => {
    resetClock();
    const store = createStore();
    const a = seedRun(store, { units: [{ status: "PENDING" }] });
    const service = serviceFor(store);
    // Only one active current-planner parent can exist, so the unfiltered reader is unambiguous.
    assert.equal((await service.findActiveRun())?.id, a);
    await service.cancelRun(a);
    assert.equal(await service.findActiveRun(), null);
  });
});

/* ==================================================================== the API ================ */

describe("Phase 8C — the cancel API", () => {
  const res = () => {
    const sent = {};
    return { sent, status(c) { sent.status = c; return this; }, json(b) { sent.body = b; return this; } };
  };
  const reqFor = (store, runId) => ({
    params: { runId },
    user: { id: "admin-1" },
    app: { locals: { syncOrchestration: serviceFor(store) } },
  });

  it("200 run_cancelled with safe fields only", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "PENDING" }, { status: "RUNNING" }] });
    const r = res();
    await cancelSyncRunHandler(reqFor(store, runId), r, (e) => { throw e; });

    assert.equal(r.sent.status, 200);
    assert.equal(r.sent.body.ok, true);
    assert.equal(r.sent.body.code, "run_cancelled");
    assert.equal(r.sent.body.runId, runId);
    assert.equal(r.sent.body.status, "cancelled");
    assert.equal(r.sent.body.unitsCancelled, 1);
    assert.equal(r.sent.body.unitsLeftRunning, 1);
    assert.ok(r.sent.body.cancelledAt);
    // The message must not imply a rollback.
    assert.match(r.sent.body.message, /NOT rolled back/);
    // Safe fields only — no supplier data leaked through the response envelope.
    assert.deepEqual(
      Object.keys(r.sent.body).sort(),
      ["cancelledAt", "code", "message", "ok", "runId", "status", "syncStatus", "unitsCancelled", "unitsLeftRunning"],
    );
  });

  it("200 run_already_terminal on a repeat, 404 on an unknown id, 409 on a foreign planner", async () => {
    resetClock();
    const store = createStore();
    const runId = seedRun(store, { units: [{ status: "PENDING" }] });
    const foreignId = seedRun(store, { plannerVersion: 2, units: [{ status: "PENDING" }] });

    const first = res();
    await cancelSyncRunHandler(reqFor(store, runId), first, (e) => { throw e; });
    assert.equal(first.sent.status, 200);

    const again = res();
    await cancelSyncRunHandler(reqFor(store, runId), again, (e) => { throw e; });
    assert.equal(again.sent.status, 200);
    assert.equal(again.sent.body.code, "run_already_terminal");
    assert.equal(again.sent.body.ok, true, "idempotent, so not an error");

    const missing = res();
    await cancelSyncRunHandler(reqFor(store, "no-such-run"), missing, (e) => { throw e; });
    assert.equal(missing.sent.status, 404);
    assert.equal(missing.sent.body.code, "run_not_found");

    const foreignBefore = JSON.stringify(store.rows.filter((r) => r.correlationId === foreignId));
    const foreign = res();
    await cancelSyncRunHandler(reqFor(store, foreignId), foreign, (e) => { throw e; });
    assert.equal(foreign.sent.status, 409);
    assert.equal(foreign.sent.body.code, "run_foreign_planner_version");
    assert.equal(
      JSON.stringify(store.rows.filter((r) => r.correlationId === foreignId)),
      foreignBefore,
      "the foreign run and its units were not touched",
    );
  });

  it("the route is admin + sync:trigger + audited, and registered before the dynamic patterns", () => {
    const block = ROUTES_SRC.split('"/sync/runs/:runId/cancel"')[1].split(");")[0];
    assert.match(block, /authenticate/);
    assert.match(block, /requireAdminRole/);
    assert.match(block, /requirePermission\(PERMISSIONS\.SYNC_TRIGGER\)/);
    assert.match(block, /auditAction\("sync\.run\.cancel"/);
    assert.match(block, /cancelSyncRunHandler/);
    assert.ok(
      ROUTES_SRC.indexOf('"/sync/runs/:runId/cancel"') < ROUTES_SRC.indexOf('"/sync/:platform"'),
      "registered before the dynamic platform patterns",
    );
  });

  it("cancellation needs no schema change and does not move the planner version", () => {
    // Cancellation does not move the planner version; it only has to agree with whatever
    // version the run under test was stamped with.
    assert.equal(typeof PLANNER_VERSION, "number");
    for (const forbidden of ["prisma.$executeRaw", "ALTER TABLE", "CREATE TABLE", "migrate"]) {
      assert.ok(!SERVICE_SRC.includes(forbidden), forbidden);
    }
    // Cancellation state lives in existing columns.
    assert.match(SERVICE_SRC, /payload: \{ \.\.\.\(parent\.payload \?\? \{\}\), cancellation \}/);
  });

  it("cancelRun is distinct from collapseDuplicateRun and does not inherit work_started", () => {
    const cancel = SERVICE_SRC.split("async cancelRun(")[1].split("\n  }\n")[0];
    assert.ok(!cancel.includes("work_started"), "the duplicate-collapse restriction is not inherited");
    assert.ok(!cancel.includes("collapseDuplicateRun("), "not delegated to the race-resolution path");
    // collapseDuplicateRun keeps its own restriction.
    const collapse = SERVICE_SRC.split("async collapseDuplicateRun(")[1].split("\n  }\n")[0];
    assert.match(collapse, /work_started/, "internal race resolution still refuses started work");
  });
});
