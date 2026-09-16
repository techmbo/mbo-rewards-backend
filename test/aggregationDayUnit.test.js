/**
 * Phase 6a — ONE aggregation DAY is ONE durable executable unit.
 *
 * The unit runs AggregationJob.rebuild({ from: day, to: day }) and nothing else: rebuild deletes
 * the day's DailyReport rows before re-aggregating, while runForDate only upserts and would leave
 * stale dimensions behind. That distinction is verified here against the real service, not assumed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { triggerSyncWorker } from "../src/controllers/sync.controller.js";
import {
  EXECUTABLE_UNIT_KINDS,
  SyncOrchestrationService,
  UNIT_BLOCKED_REASON,
  UNIT_JOB_NAME,
  UNIT_KINDS,
  isUnitExecutable,
  unitLockKey,
} from "../src/jobs/syncOrchestration.service.js";
import { SyncAccountLockService, stageLockKey } from "../src/jobs/syncAccountLock.service.js";
import {
  AGGREGATION_UNIT_REFUSAL_CODE,
  executeAggregationUnit,
  resolveAggregationDay,
  summariseAggregationUnitOutcome,
} from "../src/jobs/aggregationUnit.js";
import { AggregationService } from "../src/modules/reporting/services/aggregation.service.js";

const AGG_SRC = readFileSync(
  new URL("../src/modules/reporting/services/aggregation.service.js", import.meta.url),
  "utf8",
);

// ---------------------------------------------------------------------------
// The audited fact this whole phase rests on.
// ---------------------------------------------------------------------------

describe("the audited rebuild-vs-runForDate distinction", () => {
  it("rebuild deletes the range before re-aggregating; runForDate does not", () => {
    const rebuild = AGG_SRC.split("async rebuild(")[1].split("\n  }")[0];
    const runForDate = AGG_SRC.split("async runForDate(")[1].split("\n  }")[0];
    assert.match(rebuild, /deleteForDateRange/, "rebuild must delete the range");
    assert.ok(
      !runForDate.includes("deleteForDateRange"),
      "runForDate must NOT delete — which is exactly why a day unit may not use it",
    );
    assert.match(runForDate, /aggregateRange/);
  });
});

// ---------------------------------------------------------------------------
// D, E — the day contract.
// ---------------------------------------------------------------------------

describe("an aggregation unit names exactly one calendar day", () => {
  it("accepts a YYYY-MM-DD day", () => {
    assert.equal(resolveAggregationDay({ day: "2026-07-14" }), "2026-07-14");
    assert.equal(resolveAggregationDay({ day: "2024-02-29" }), "2024-02-29", "a real leap day");
  });

  it("refuses a missing day, and says it is missing", () => {
    for (const descriptor of [{}, { day: null }, { day: "" }, { day: undefined }]) {
      assert.throws(
        () => resolveAggregationDay(descriptor),
        (error) => {
          assert.equal(error.code, AGGREGATION_UNIT_REFUSAL_CODE);
          assert.match(error.message, /requires a day/, "an absent day is not a malformed day");
          return true;
        },
        JSON.stringify(descriptor),
      );
    }
  });

  it("each refusal names its own reason", () => {
    const reasonOf = (descriptor) => {
      try {
        resolveAggregationDay(descriptor);
      } catch (error) {
        return error.message;
      }
      return null;
    };
    assert.match(reasonOf({}), /requires a day/);
    assert.match(reasonOf({ day: "2026-7-4" }), /YYYY-MM-DD/);
    assert.match(reasonOf({ day: "2026-02-30" }), /real calendar day/);
    assert.match(reasonOf({ day: "2026-07-14", from: "2026-07-01" }), /must not carry a range/);
  });

  it("refuses a malformed day", () => {
    for (const day of [
      "2026-7-4",
      "20260704",
      "14-07-2026",
      "2026-07-14T00:00:00.000Z",
      "2026-07-14 00:00",
      "yesterday",
      "2026-07-14+01:00",
    ]) {
      assert.throws(() => resolveAggregationDay({ day }), { code: AGGREGATION_UNIT_REFUSAL_CODE }, day);
    }
  });

  it("refuses a day-shaped string that is not a real calendar day", () => {
    for (const day of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-07-32", "2026-02-29"]) {
      assert.throws(() => resolveAggregationDay({ day }), { code: AGGREGATION_UNIT_REFUSAL_CODE }, day);
    }
  });

  it("refuses a non-string day", () => {
    for (const day of [20260714, new Date("2026-07-14"), ["2026-07-14"], { day: "2026-07-14" }]) {
      assert.throws(() => resolveAggregationDay({ day }), { code: AGGREGATION_UNIT_REFUSAL_CODE });
    }
  });

  it("refuses a descriptor that names a range instead of a day", () => {
    for (const extra of [
      { from: "2026-07-01" },
      { to: "2026-07-31" },
      { from: "2026-07-01", to: "2026-07-31" },
      { windowStart: "2026-07-01" },
      { windowEnd: "2026-07-31" },
      { days: 14 },
    ]) {
      assert.throws(
        () => resolveAggregationDay({ day: "2026-07-14", ...extra }),
        { code: AGGREGATION_UNIT_REFUSAL_CODE },
        JSON.stringify(extra),
      );
    }
  });

  it("a far future or very old day is accepted, matching the aggregation contract", () => {
    // The service itself rejects an inverted range, not a future date, and a day unit must not
    // invent a stricter rule than the stage it drives.
    assert.equal(resolveAggregationDay({ day: "2099-12-31" }), "2099-12-31");
    assert.equal(resolveAggregationDay({ day: "2001-01-01" }), "2001-01-01");
  });
});

describe("executing one unit rebuilds exactly that day", () => {
  it("passes from === to === day", async () => {
    const calls = [];
    const out = await executeAggregationUnit(
      { kind: "aggregation", day: "2026-07-14" },
      { runRebuild: async (input) => { calls.push(input); return { daysProcessed: 1, rowsUpserted: 3, rowsDeleted: 2, grain: "g" }; } },
    );
    assert.deepEqual(calls, [{ from: "2026-07-14", to: "2026-07-14" }]);
    assert.equal(calls.length, 1, "exactly one rebuild, no adjacent days");
    assert.equal(out.day, "2026-07-14");
  });

  it("refuses before calling anything when the day is bad", async () => {
    const calls = [];
    await assert.rejects(
      () => executeAggregationUnit({ day: "2026-02-30" }, { runRebuild: async (i) => { calls.push(i); } }),
      { code: AGGREGATION_UNIT_REFUSAL_CODE },
    );
    assert.deepEqual(calls, [], "a refused unit must not touch the database");
  });

  it("refuses without a rebuild function rather than silently doing nothing", async () => {
    await assert.rejects(() => executeAggregationUnit({ day: "2026-07-14" }), {
      code: AGGREGATION_UNIT_REFUSAL_CODE,
    });
  });

  it("the durable outcome carries counts and the day only", () => {
    const summary = summariseAggregationUnitOutcome({
      day: "2026-07-14",
      result: { daysProcessed: 1, rowsUpserted: 12, rowsDeleted: 5, grain: "client+merchant+campaign+country" },
    });
    assert.deepEqual(summary, {
      kind: "aggregation",
      day: "2026-07-14",
      counts: { daysProcessed: 1, rowsUpserted: 12, rowsDeleted: 5 },
      grain: "client+merchant+campaign+country",
    });
    // The grain names dimensions, which is vocabulary, not data. What must never appear is a
    // value: an id, a name, a currency or an amount.
    const serialised = JSON.stringify({ ...summary, grain: null });
    for (const leak of ["clientId", "merchantId", "campaignSourceId", "currency", "Commission", "country"]) {
      assert.ok(!serialised.includes(leak), leak);
    }
    assert.equal(Object.keys(summary.counts).every((k) => typeof summary.counts[k] === "number"), true);
  });
});

// ---------------------------------------------------------------------------
// A, B, C — real service semantics against an in-memory DailyReport.
// ---------------------------------------------------------------------------

/** A DailyReport store plus the click/conversion sources the real service reads. */
function reportingFixture({ clicks = [], conversions = [] } = {}) {
  let rows = [];
  let seq = 0;
  const inRange = (row, from, to) =>
    new Date(row.reportDate) >= new Date(from) && new Date(row.reportDate) <= new Date(to);
  const dayOf = (value) => new Date(value).toISOString().slice(0, 10);

  const dailyReportRepo = {
    async deleteForDateRange({ from, to }) {
      const before = rows.length;
      rows = rows.filter((r) => !inRange(r, from, to));
      return { count: before - rows.length };
    },
    async upsertDimension(input) {
      const key = JSON.stringify([
        input.clientId, input.merchantId, input.canonicalCampaignId,
        input.campaignSourceId, input.country, dayOf(input.reportDate),
      ]);
      const existing = rows.find((r) => r.key === key);
      if (existing) Object.assign(existing, input, { key });
      else { seq += 1; rows.push({ id: `dr-${seq}`, key, ...input }); }
      return { ok: true };
    },
  };
  // Real signatures: clickRepo.findMany({from,to},{skip,take},tx) -> { rows },
  // conversionRepo.findForAggregation({from,to,clientAssignmentId}, tx).
  const clickRepo = {
    async findMany({ from, to }, { skip = 0, take = 1000 } = {}) {
      const all = clicks.filter((c) => inRange({ reportDate: c.clickedAt }, from, to));
      return { rows: all.slice(skip, skip + take) };
    },
  };
  const conversionRepo = {
    async findForAggregation({ from, to }) {
      return conversions.filter((c) => inRange({ reportDate: c.convertedAt }, from, to));
    },
  };
  const financeConsumer = { getMode: () => "LEGACY_FINANCIALS" };

  return {
    service: new AggregationService({ clickRepo, conversionRepo, dailyReportRepo, financeConsumer }),
    days: () => rows.map((r) => dayOf(r.reportDate)).sort(),
    rows: () => rows.map(({ id, key, ...rest }) => ({ ...rest, reportDate: dayOf(rest.reportDate) })),
    seed(row) { seq += 1; rows.push({ id: `dr-${seq}`, key: JSON.stringify(["seed", seq]), ...row }); },
    count: () => rows.length,
  };
}

/**
 * Passing a client keeps aggregateRange off prisma.$transaction, so the real service runs against
 * the fixture instead of the database.
 */
const FAKE_CLIENT = {
  clientCampaignAssignment: { findUnique: async () => null },
};

describe("a day unit rebuilds only its own day", () => {
  it("leaves adjacent days untouched", async () => {
    const fixture = reportingFixture();
    fixture.seed({ reportDate: new Date("2026-07-13T00:00:00.000Z"), clientId: "c1" });
    fixture.seed({ reportDate: new Date("2026-07-14T00:00:00.000Z"), clientId: "c1" });
    fixture.seed({ reportDate: new Date("2026-07-15T00:00:00.000Z"), clientId: "c1" });

    await executeAggregationUnit(
      { kind: "aggregation", day: "2026-07-14" },
      { runRebuild: (input) => fixture.service.rebuild(input, FAKE_CLIENT) },
    );

    assert.deepEqual(fixture.days(), ["2026-07-13", "2026-07-15"], "only the named day was rebuilt");
  });

  it("removes a stale dimension that no longer has source rows", async () => {
    const fixture = reportingFixture();
    // A dimension that existed from an earlier aggregation and now has no clicks or conversions.
    fixture.seed({ reportDate: new Date("2026-07-14T00:00:00.000Z"), clientId: "gone", clickCount: 9 });
    assert.equal(fixture.count(), 1);

    const out = await executeAggregationUnit(
      { kind: "aggregation", day: "2026-07-14" },
      { runRebuild: (input) => fixture.service.rebuild(input, FAKE_CLIENT) },
    );

    assert.equal(fixture.count(), 0, "the stale dimension must be deleted, not left behind");
    assert.equal(out.result.rowsDeleted, 1);
    assert.equal(out.result.daysProcessed, 1, "exactly one day processed");
  });

  it("running the same unit twice leaves the same DailyReport state", async () => {
    const fixture = reportingFixture();
    fixture.seed({ reportDate: new Date("2026-07-14T00:00:00.000Z"), clientId: "stale" });

    const unit = { kind: "aggregation", day: "2026-07-14" };
    const run = () => executeAggregationUnit(unit, { runRebuild: (i) => fixture.service.rebuild(i, FAKE_CLIENT) });

    await run();
    const afterFirst = fixture.rows();
    await run();
    assert.deepEqual(fixture.rows(), afterFirst, "a retry must not change the stored day");
  });

  it("a day with no source rows truthfully produces nothing", async () => {
    const fixture = reportingFixture();
    const out = await executeAggregationUnit(
      { kind: "aggregation", day: "2026-07-14" },
      { runRebuild: (i) => fixture.service.rebuild(i, FAKE_CLIENT) },
    );
    assert.equal(out.result.rowsUpserted, 0, "no fabricated buckets");
    assert.equal(fixture.count(), 0);
  });
});

// ---------------------------------------------------------------------------
// F, G, H — locking.
// ---------------------------------------------------------------------------

describe("locking is per day", () => {
  it("an aggregation unit locks aggregation:<day>", () => {
    assert.equal(
      unitLockKey({ kind: UNIT_KINDS.AGGREGATION, day: "2026-07-14" }),
      stageLockKey("aggregation", "2026-07-14"),
    );
    assert.equal(unitLockKey({ kind: UNIT_KINDS.AGGREGATION, day: "2026-07-14" }), "aggregation:2026-07-14");
  });

  it("different days are independently lockable", () => {
    assert.notEqual(
      unitLockKey({ kind: UNIT_KINDS.AGGREGATION, day: "2026-07-14" }),
      unitLockKey({ kind: UNIT_KINDS.AGGREGATION, day: "2026-07-15" }),
    );
  });

  it("two aggregation days are distinct durable identities", async () => {
    const h = app();
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14"), aggregationUnit("2026-07-15")],
    });
    assert.equal(h.units(run.id).length, 2, "the two days must not collapse to one identity");
  });

  it("appending another day adds a unit; appending the same day does not", async () => {
    // appendUnits is what de-duplicates by identity, so this is where a day missing from the
    // identity would silently drop every day after the first.
    const h = app();
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14")],
    });

    const added = await h.orchestration.appendUnits(run.id, [aggregationUnit("2026-07-15")]);
    assert.equal(added.appended, 1, "a different day is new work");
    assert.equal(h.units(run.id).length, 2);

    const repeat = await h.orchestration.appendUnits(run.id, [aggregationUnit("2026-07-15")]);
    assert.equal(repeat.appended, 0, "the same day is not new work");
    assert.equal(repeat.skipped, 1);
    assert.equal(h.units(run.id).length, 2);

    const days = h.units(run.id).map((u) => u.payload.day).sort();
    assert.deepEqual(days, ["2026-07-14", "2026-07-15"]);
  });
});

// ---------------------------------------------------------------------------
// Worker harness — the same durable store shape the Phase 3 worker tests use.
// ---------------------------------------------------------------------------

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
const loadAccountState = async () => ({ lastSuccessfulSync: null });

const aggregationUnit = (day, extra = {}) => ({ kind: UNIT_KINDS.AGGREGATION, day, options: {}, ...extra });

function app({ rebuildImpl } = {}) {
  const { rows, prisma } = createStore();
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts: async () => ["default"], loadAccountState });
  const locks = new SyncAccountLockService({ prisma, now });
  const rebuilds = [];
  const networkCalls = [];
  const aggregationRebuild = async (input) => {
    rebuilds.push(input);
    if (rebuildImpl) return rebuildImpl(input);
    return { daysProcessed: 1, rowsUpserted: 4, rowsDeleted: 2, grain: "client+merchant+campaign+country" };
  };
  const syncPlatformAccount = async (platform, accountLabel, options) => {
    networkCalls.push({ platform, accountLabel, options });
    return { [accountLabel ?? "default"]: { campaigns: 1 } };
  };
  const locals = { syncOrchestration: orchestration, syncAccountLocks: locks, syncPlatformAccount, aggregationRebuild };
  const makeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  };
  return {
    rows, prisma, orchestration, locks, rebuilds, networkCalls,
    async worker() {
      const res = makeRes();
      await triggerSyncWorker({ app: { locals } }, res, (error) => { throw error; });
      return res;
    },
    units(runId) { return rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId); },
  };
}

// ---------------------------------------------------------------------------
// I, J, K, L — worker behaviour.
// ---------------------------------------------------------------------------

describe("the worker executes exactly one aggregation day", () => {
  it("completes one unit and rebuilds only that day", async () => {
    const h = app();
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14"), aggregationUnit("2026-07-15")],
    });

    const res = await h.worker();

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, "unit_completed");
    assert.equal(res.body.unit.kind, "aggregation");
    assert.equal(res.body.unit.day, "2026-07-14");
    assert.deepEqual(h.rebuilds, [{ from: "2026-07-14", to: "2026-07-14" }], "one day, one rebuild");

    const units = h.units(run.id);
    assert.equal(units.filter((u) => u.status === "COMPLETED").length, 1);
    assert.equal(units.filter((u) => u.status === "PENDING").length, 1, "the next day is left for the next invocation");
  });

  it("never walks to an adjacent day", async () => {
    const h = app();
    await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14"), aggregationUnit("2026-07-15"), aggregationUnit("2026-07-16")],
    });
    await h.worker();
    assert.equal(h.rebuilds.length, 1);
    assert.equal(h.rebuilds[0].from, h.rebuilds[0].to);
  });

  it("makes no supplier or network call", async () => {
    const h = app();
    await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14")],
    });
    await h.worker();
    assert.deepEqual(h.networkCalls, [], "aggregation reads the database only");
  });

  it("records the day and counts durably", async () => {
    const h = app();
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14")],
    });
    await h.worker();
    const unit = h.units(run.id)[0];
    assert.equal(unit.status, "COMPLETED");
    assert.equal(unit.result.outcome.kind, "aggregation");
    assert.equal(unit.result.outcome.day, "2026-07-14");
    assert.equal(unit.result.outcome.counts.rowsDeleted, 2);
  });

  it("refuses a unit planned as non-executable", async () => {
    const h = app();
    await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14", { executable: false, blockedReason: UNIT_BLOCKED_REASON })],
    });
    const res = await h.worker();
    assert.equal(res.body.worked, false, "a blocked unit is never executed");
    assert.deepEqual(h.rebuilds, []);
  });

  it("every post-sync stage is now bounded, and an aggregation unit is still only its own day", () => {
    // Phase 6a bounded AGGREGATION to one day, 6b bounded CONVERSION_PROMOTION to one cursor page,
    // 6c bounded PROMOTION to one cursor page of one entity type. Being executable is NOT being
    // ordered: the stages still depend on each other and the parent gate owns that.
    for (const kind of Object.values(UNIT_KINDS)) {
      assert.ok(EXECUTABLE_UNIT_KINDS.includes(kind), kind);
    }
    assert.equal(EXECUTABLE_UNIT_KINDS.length, Object.keys(UNIT_KINDS).length);
    // Widening the list never widens what an AGGREGATION unit itself may do: a day unit still
    // rebuilds exactly its own day, which the rest of this file pins.
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.AGGREGATION, executable: false }), false);
  });
});

// ---------------------------------------------------------------------------
// G — a second worker cannot take the same day.
// ---------------------------------------------------------------------------

describe("two workers never rebuild the same day at once", () => {
  it("the second worker does not get the day a first worker holds", async () => {
    const h = app();
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14")],
    });
    const unit = h.units(run.id)[0];

    const first = await h.orchestration.claimUnit(unit.id, { workerId: "worker:a" });
    assert.equal(first.claimed, true);

    const second = await h.orchestration.claimUnit(unit.id, { workerId: "worker:b" });
    assert.equal(second.claimed, false, "the same unit cannot be claimed twice");

    const res = await h.worker();
    assert.equal(res.body.worked, false, "and no other unit is invented to keep it busy");
    assert.deepEqual(h.rebuilds, []);
  });

  it("a different day stays independently workable", async () => {
    const h = app();
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14"), aggregationUnit("2026-07-15")],
    });
    const [first, second] = h.units(run.id);
    assert.equal(first.payload.lockKey, "aggregation:2026-07-14");
    assert.equal(second.payload.lockKey, "aggregation:2026-07-15");
    assert.notEqual(first.payload.lockKey, second.payload.lockKey);
  });
});

// ---------------------------------------------------------------------------
// M, N — failure, retry and attempts.
// ---------------------------------------------------------------------------

describe("a failed day stays retryable under the existing semantics", () => {
  it("a failed rebuild leaves the unit retryable and increments the attempt", async () => {
    const h = app({ rebuildImpl: async () => { throw new Error("aggregation exploded"); } });
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14")],
    });

    const res = await h.worker();
    assert.equal(res.body.status, "unit_retry");
    const unit = h.units(run.id)[0];
    assert.equal(unit.status, "PENDING", "still workable");
    assert.equal(unit.attempt, 1);
    assert.equal(unit.maxAttempts, 3, "maxAttempts is untouched");
  });

  it("a malformed day fails the unit rather than rebuilding anything", async () => {
    const h = app();
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-02-30")],
    });
    const res = await h.worker();
    assert.equal(res.body.status, "unit_retry");
    assert.deepEqual(h.rebuilds, [], "a refused unit never reaches the database");
    assert.equal(h.units(run.id)[0].attempt, 1);
  });

  it("attempts exhaust into DEAD_LETTER exactly as a network unit does", async () => {
    const h = app({ rebuildImpl: async () => { throw new Error("aggregation exploded"); } });
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [aggregationUnit("2026-07-14")],
    });
    let last;
    for (let i = 0; i < 3; i += 1) last = await h.worker();
    assert.equal(last.body.status, "unit_failed");
    const unit = h.units(run.id)[0];
    assert.equal(unit.status, "DEAD_LETTER");
    assert.equal(unit.attempt, 3);
    assert.equal(unit.maxAttempts, 3);
  });
});

// ---------------------------------------------------------------------------
// Transaction shape. aggregateRange wraps ONE day in prisma.$transaction with no
// options, so Prisma's defaults apply: maxWait 2s, timeout 5s. This measures the
// sequential in-transaction query count for a realistic day and states the
// per-query budget that implies. It changes no timeout.
// ---------------------------------------------------------------------------

/** Counts every query the real service issues inside one day's transaction. */
function instrumentedFixture({ clicks = 0, assignedFraction = 1, buckets = 0 } = {}) {
  const day = "2026-07-14";
  const clickRows = Array.from({ length: clicks }, (_, i) => ({
    id: `click-${i}`,
    clickedAt: new Date(`${day}T09:00:00.000Z`),
    clientAssignmentId: i < Math.floor(clicks * assignedFraction) ? `assign-${i % Math.max(1, buckets || 1)}` : null,
    campaignSourceId: `src-${i % Math.max(1, buckets || 1)}`,
    country: "AE",
  }));

  const queries = [];
  const record = (name) => queries.push(name);

  const clickRepo = {
    async findMany(_range, { skip = 0, take = 5000 } = {}) {
      record("click.findMany");
      return { rows: clickRows.slice(skip, skip + take) };
    },
  };
  const conversionRepo = {
    async findForAggregation() {
      record("conversion.findForAggregation");
      return [];
    },
  };
  const dailyReportRepo = {
    async deleteForDateRange() { record("dailyReport.deleteMany"); return { count: 0 }; },
    async upsertDimension() { record("dailyReport.upsertDimension"); return { ok: true }; },
  };
  const assignmentRow = (id) => {
    const index = Number(String(id).split("-")[1]) || 0;
    return {
      id,
      clientId: `client-${index}`,
      canonicalCampaignId: `canon-${index}`,
      canonicalCampaign: { merchantId: `merchant-${index}`, id: `canon-${index}` },
    };
  };
  const tx = {
    clientCampaignAssignment: {
      // Kept so a regression back to per-click lookups is counted rather than crashing.
      async findUnique({ where }) {
        record("clientCampaignAssignment.findUnique");
        return assignmentRow(where.id);
      },
      async findMany({ where }) {
        record("clientCampaignAssignment.findMany");
        return (where?.id?.in ?? []).map(assignmentRow);
      },
    },
  };

  return {
    day,
    queries,
    service: new AggregationService({
      clickRepo,
      conversionRepo,
      dailyReportRepo,
      financeConsumer: { getMode: () => "LEGACY_FINANCIALS" },
    }),
    tx,
    inTransaction: () => queries.filter((q) => q !== "dailyReport.deleteMany").length,
  };
}

describe("per-day transaction shape", () => {
  it("the day rebuild is one interactive transaction with Prisma's default timeout", () => {
    // No options object: maxWait 2000ms, timeout 5000ms.
    assert.match(AGG_SRC, /return prisma\.\$transaction\(run\);/);
    assert.ok(
      !/\$transaction\(run,\s*\{/.test(AGG_SRC),
      "no timeout override today — this test exists to report the budget, not to raise it",
    );
  });

  it("the delete runs OUTSIDE the day's transaction", async () => {
    const fixture = instrumentedFixture({ clicks: 0 });
    await fixture.service.rebuild({ from: fixture.day, to: fixture.day }, fixture.tx);
    assert.equal(fixture.queries[0], "dailyReport.deleteMany", "delete first, then aggregate");
  });

  it("assignment lookups no longer scale with click count", async () => {
    const small = instrumentedFixture({ clicks: 100, assignedFraction: 1, buckets: 25 });
    await small.service.rebuild({ from: small.day, to: small.day }, small.tx);
    const big = instrumentedFixture({ clicks: 5000, assignedFraction: 1, buckets: 25 });
    await big.service.rebuild({ from: big.day, to: big.day }, big.tx);

    const lookupsOf = (f) => f.queries.filter((q) => q.startsWith("clientCampaignAssignment.")).length;
    assert.equal(lookupsOf(small), 1, "one bulk read for 100 clicks over 25 assignments");
    assert.equal(lookupsOf(big), 1, "still one bulk read at 5000 clicks");
    assert.equal(
      lookupsOf(small),
      lookupsOf(big),
      "assignment reads must depend on distinct assignments, not on traffic",
    );
  });

  it("no findUnique is issued inside the transaction path", async () => {
    const fixture = instrumentedFixture({ clicks: 500, assignedFraction: 1, buckets: 25 });
    await fixture.service.rebuild({ from: fixture.day, to: fixture.day }, fixture.tx);
    assert.equal(
      fixture.queries.filter((q) => q === "clientCampaignAssignment.findUnique").length,
      0,
      "the per-click lookup is gone",
    );
    assert.ok(
      !AGG_SRC.includes("clientCampaignAssignment.findUnique"),
      "and gone from the service source",
    );
  });

  it("a busy day now fits the default 5s transaction", async () => {
    const fixture = instrumentedFixture({ clicks: 5000, assignedFraction: 1, buckets: 200 });
    await fixture.service.rebuild({ from: fixture.day, to: fixture.day }, fixture.tx);
    const inTx = fixture.inTransaction();
    assert.ok(inTx < 250, `a 5000-click day now issues ${inTx} in-transaction queries`);
    assert.ok(inTx * 10 < 5000, `at 10ms/query that is ${(inTx * 10) / 1000}s, inside the 5s default`);
  });

  it("an unassigned click costs no lookup at all", async () => {
    const fixture = instrumentedFixture({ clicks: 500, assignedFraction: 0, buckets: 10 });
    await fixture.service.rebuild({ from: fixture.day, to: fixture.day }, fixture.tx);
    assert.equal(
      fixture.queries.filter((q) => q.startsWith("clientCampaignAssignment.")).length,
      0,
      "no assignment ids means no assignment read",
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 6a-bis — output parity with the per-click lookup it replaced.
//
// The oracle below is the PRE-optimization algorithm, written out independently:
// a findUnique per click, the same guards, the same dimension key. Every fixture
// is aggregated both ways and the DailyReport writes must match exactly.
// ---------------------------------------------------------------------------

const DAY_BIS = "2026-07-14";

/** A world of clicks and assignments to aggregate. */
function world({ assignments = {}, clicks = [] } = {}) {
  const lookups = [];
  return {
    assignments,
    clicks,
    lookups,
    tx: {
      clientCampaignAssignment: {
        async findUnique({ where }) {
          lookups.push(`findUnique:${where.id}`);
          return assignments[where.id] ?? null;
        },
        async findMany({ where }) {
          lookups.push(`findMany:${(where?.id?.in ?? []).length}`);
          return (where?.id?.in ?? []).map((id) => assignments[id]).filter(Boolean);
        },
      },
    },
  };
}

/** What the service actually writes, normalised for comparison. */
async function aggregateWithService(w, { clientId } = {}) {
  const written = [];
  const service = new AggregationService({
    clickRepo: { async findMany(_r, { skip = 0, take = 5000 } = {}) { return { rows: w.clicks.slice(skip, skip + take) }; } },
    conversionRepo: { async findForAggregation() { return []; } },
    dailyReportRepo: {
      async deleteForDateRange() { return { count: 0 }; },
      async upsertDimension(input) { written.push(input); return { ok: true }; },
    },
    financeConsumer: { getMode: () => "LEGACY_FINANCIALS" },
  });
  await service.rebuild({ from: DAY_BIS, to: DAY_BIS, clientId }, w.tx);
  return written
    .map((r) => ({
      clientId: r.clientId, merchantId: r.merchantId, canonicalCampaignId: r.canonicalCampaignId,
      campaignSourceId: r.campaignSourceId, country: r.country,
      reportDate: new Date(r.reportDate).toISOString().slice(0, 10),
      clickCount: r.clickCount,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** The pre-optimization algorithm, independently reimplemented as the oracle. */
async function aggregateLegacy(w, { clientId } = {}) {
  const buckets = new Map();
  for (const click of w.clicks) {
    if (!click.clientAssignmentId) continue;
    // eslint-disable-next-line no-await-in-loop
    const assignment = await w.tx.clientCampaignAssignment.findUnique({
      where: { id: click.clientAssignmentId },
    });
    if (!assignment?.canonicalCampaign?.merchantId) continue;
    if (clientId && assignment.clientId !== clientId) continue;
    const day = new Date(click.clickedAt).toISOString().slice(0, 10);
    const key = [
      assignment.clientId, assignment.canonicalCampaign.merchantId, assignment.canonicalCampaignId,
      click.campaignSourceId, click.country, day,
    ].join("|");
    if (!buckets.has(key)) {
      buckets.set(key, {
        clientId: assignment.clientId,
        merchantId: assignment.canonicalCampaign.merchantId,
        canonicalCampaignId: assignment.canonicalCampaignId,
        campaignSourceId: click.campaignSourceId ?? null,
        country: click.country ?? null,
        reportDate: day,
        clickCount: 0,
      });
    }
    buckets.get(key).clickCount += 1;
  }
  return [...buckets.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const assignment = (id, n) => ({
  id,
  clientId: `client-${n}`,
  canonicalCampaignId: `canon-${n}`,
  canonicalCampaign: { id: `canon-${n}`, merchantId: `merchant-${n}` },
});
const click = (assignmentId, over = {}) => ({
  id: `click-${Math.random()}`,
  clickedAt: new Date(`${DAY_BIS}T09:00:00.000Z`),
  clientAssignmentId: assignmentId,
  campaignSourceId: "src-1",
  country: "AE",
  ...over,
});

describe("batched assignment lookup preserves exact output", () => {
  const scenarios = {
    "many clicks sharing one assignment": world({
      assignments: { a1: assignment("a1", 1) },
      clicks: [click("a1"), click("a1"), click("a1"), click("a1")],
    }),
    "several distinct assignments": world({
      assignments: { a1: assignment("a1", 1), a2: assignment("a2", 2), a3: assignment("a3", 3) },
      clicks: [click("a1"), click("a2"), click("a3"), click("a2")],
    }),
    "a missing assignment row": world({
      assignments: { a1: assignment("a1", 1) },
      clicks: [click("a1"), click("gone"), click("a1")],
    }),
    "an assignment with no merchant": world({
      assignments: { a1: assignment("a1", 1), a2: { id: "a2", clientId: "c2", canonicalCampaign: {} } },
      clicks: [click("a1"), click("a2")],
    }),
    "clicks with no assignment at all": world({
      assignments: { a1: assignment("a1", 1) },
      clicks: [click(null), click("a1"), click(undefined), click("")],
    }),
    "clicks spread over sources and countries": world({
      assignments: { a1: assignment("a1", 1) },
      clicks: [
        click("a1", { campaignSourceId: "src-1", country: "AE" }),
        click("a1", { campaignSourceId: "src-2", country: "AE" }),
        click("a1", { campaignSourceId: "src-1", country: "SA" }),
        click("a1", { campaignSourceId: "src-1", country: null }),
      ],
    }),
    "no clicks at all": world({ assignments: {}, clicks: [] }),
  };

  for (const [name, w] of Object.entries(scenarios)) {
    it(`matches the per-click oracle: ${name}`, async () => {
      const expected = await aggregateLegacy(w);
      const actual = await aggregateWithService(w);
      assert.deepEqual(actual, expected, name);
    });
  }

  it("client scoping is applied identically", async () => {
    const w = world({
      assignments: { a1: assignment("a1", 1), a2: assignment("a2", 2) },
      clicks: [click("a1"), click("a2"), click("a1")],
    });
    const expected = await aggregateLegacy(w, { clientId: "client-1" });
    const actual = await aggregateWithService(w, { clientId: "client-1" });
    assert.deepEqual(actual, expected);
    assert.ok(actual.every((row) => row.clientId === "client-1"), "no other client leaks in");
    assert.equal(actual.length, 1);
  });

  it("duplicate clicks still count once each, not once per assignment", async () => {
    const w = world({
      assignments: { a1: assignment("a1", 1) },
      clicks: [click("a1"), click("a1"), click("a1")],
    });
    const actual = await aggregateWithService(w);
    assert.equal(actual.length, 1, "one dimension");
    assert.equal(actual[0].clickCount, 3, "three clicks");
  });

  it("clicks sharing an assignment cause exactly one bulk entry to be loaded", async () => {
    const w = world({
      assignments: { a1: assignment("a1", 1) },
      clicks: [click("a1"), click("a1"), click("a1"), click("a1"), click("a1")],
    });
    await aggregateWithService(w);
    assert.deepEqual(w.lookups, ["findMany:1"], "five clicks, one assignment, one id requested");
  });

  it("distinct assignments are requested once each, in one read", async () => {
    const w = world({
      assignments: { a1: assignment("a1", 1), a2: assignment("a2", 2), a3: assignment("a3", 3) },
      clicks: [click("a1"), click("a2"), click("a1"), click("a3"), click("a2")],
    });
    await aggregateWithService(w);
    assert.deepEqual(w.lookups, ["findMany:3"], "five clicks, three distinct ids, one read");
  });

  it("an id that resolves to no row is skipped exactly as a null findUnique was", async () => {
    const w = world({
      assignments: { a1: assignment("a1", 1) },
      clicks: [click("missing-1"), click("missing-2")],
    });
    const actual = await aggregateWithService(w);
    assert.deepEqual(actual, [], "no dimension is invented for an absent assignment");
    assert.deepEqual(w.lookups, ["findMany:2"]);
  });
});
