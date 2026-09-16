/**
 * Phase 6d — the durable post-sync dependency gate.
 *
 * The parent advances itself through promotion, conversion promotion and aggregation in that
 * order, one bounded unit per worker invocation throughout. Every decision is a pure read of
 * JobRun rows: no entity scan, no supplier call, no module memory, and no wall clock except the
 * run's own immutable start, which pins the aggregation window so a late materialisation cannot
 * silently rebuild a different fortnight.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { triggerSyncWorker } from "../src/controllers/sync.controller.js";
import {
  ORCHESTRATION_JOB_NAME,
  PLANNER_VERSION,
  UNIT_JOB_NAME,
  UNIT_KINDS,
  SyncOrchestrationService,
} from "../src/jobs/syncOrchestration.service.js";
import { SyncAccountLockService } from "../src/jobs/syncAccountLock.service.js";
import {
  FAILURE_STAGES,
  POST_SYNC_STAGES,
  aggregationDaysFor,
  aggregationWindowFor,
  failureStageOf,
  networkPhaseState,
  planPostSyncTransition,
  postSyncMayAppendUnits,
  postSyncNetworks,
  walkState,
} from "../src/jobs/postSyncStages.js";
import { PROMOTION_PAGE_SIZE } from "../src/jobs/promotionUnit.js";
import { CONVERSION_PROMOTION_PAGE_SIZE } from "../src/jobs/conversionPromotionUnit.js";
import { resolvePostSyncAggregationWindow } from "../src/modules/reporting/services/aggregationDimensionMeasurement.service.js";

const GATE_SRC = readFileSync(new URL("../src/jobs/postSyncStages.js", import.meta.url), "utf8");

const loadAccountState = async () => ({ lastSuccessfulSync: null });

/* ------------------------------------------------------------------ durable JobRun fake ----- */

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
    async createMany({ data }) { for (const d of data) await jobRun.create({ data: d }); return { count: data.length }; },
    async update({ where, data }) { const row = rows.find((r) => r.id === where.id); apply(row, data); return clone(row); },
    async updateMany({ where, data }) { let count = 0; for (const row of rows) if (match(row, where)) { apply(row, data); count += 1; } return { count }; },
    // The durable duplicate collapse two racing appends rely on. Real Prisma has it, so the fake
    // must: without it the race below would never exercise the code that resolves the race.
    async deleteMany({ where }) {
      const doomed = rows.filter((r) => match(r, where ?? {}));
      for (const row of doomed) rows.splice(rows.indexOf(row), 1);
      return { count: doomed.length };
    },
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { const list = sort(rows.filter((r) => match(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
  };
  return { rows, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

/** The pinned run day of the historical production run. */
const RUN_STARTED_AT = new Date("2026-09-16T04:12:00.000Z");
let clock = new Date(RUN_STARTED_AT);
const now = () => clock;
const resetClock = () => { clock = new Date(RUN_STARTED_AT); };
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };

/* --------------------------------------------------------------------- row-shape helpers --- */

const networkRow = (platform, status = "COMPLETED", extra = {}) => ({
  status,
  payload: { kind: UNIT_KINDS.NETWORK, platform, accountLabel: "default", ...extra },
});
const promotionRow = (networkSource, entityType, status = "COMPLETED", extra = {}) => ({
  status,
  payload: { kind: UNIT_KINDS.PROMOTION, networkSource, entityType, cursorId: null, pageSize: PROMOTION_PAGE_SIZE, ...extra },
});
const conversionRow = (networkSource, status = "COMPLETED", extra = {}) => ({
  status,
  payload: { kind: UNIT_KINDS.CONVERSION_PROMOTION, networkSource, cursorId: null, pageSize: CONVERSION_PROMOTION_PAGE_SIZE, ...extra },
});
const aggregationRow = (day, status = "COMPLETED") => ({ status, payload: { kind: UNIT_KINDS.AGGREGATION, day } });
const placeholderRow = (kind, extra = {}) => ({
  status: "PENDING",
  payload: { kind, options: {}, executable: false, blockedReason: "bounded_units_not_implemented", ...extra },
});

const plan = (units, options = {}) =>
  planPostSyncTransition(units, { postSyncRequested: true, runStartedAt: RUN_STARTED_AT, ...options });

const TWO_NETWORKS = [networkRow("boostiny"), networkRow("rakuten")];

/* --------------------------------------------------------------- an end-to-end harness ----- */

function app({ pageResults = {} } = {}) {
  const { rows, prisma } = createStore();
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts: async () => ["default"], loadAccountState });
  const locks = new SyncAccountLockService({ prisma, now });
  const calls = { promotion: [], conversion: [], aggregation: [] };
  const locals = {
    syncOrchestration: orchestration,
    syncAccountLocks: locks,
    syncPlatformAccount: async (platform, accountLabel) => ({ [accountLabel ?? "default"]: { campaigns: 1 } }),
    promotionPage: async (input) => {
      calls.promotion.push(input);
      return pageResults.promotion?.(input, calls.promotion.length)
        ?? { processed: 0, promoted: 0, skipped: 0, failed: 0, lastCursor: null, hasMore: false };
    },
    conversionPromotionPage: async (input) => {
      calls.conversion.push(input);
      return pageResults.conversion?.(input, calls.conversion.length)
        ?? { processed: 0, promoted: 0, skipped: 0, failed: 0, lastCursor: null, hasMore: false };
    },
    aggregationRebuild: async (input) => {
      calls.aggregation.push(input);
      return pageResults.aggregation?.(input) ?? { days: 1, rebuilt: true };
    },
  };
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
    units(runId) { return rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId); },
    unitsOf(runId, kind) { return this.units(runId).filter((u) => u.payload?.kind === kind); },
    parent(runId) { return rows.find((r) => r.id === runId); },
  };
}

/** A run whose network phase is finished, as the production run's is. */
async function runWithCompletedNetwork(h, { platforms = ["boostiny", "rakuten"], status = "COMPLETED" } = {}) {
  const run = await h.orchestration.createRun({
    kind: "full",
    trigger: "api",
    options: { promoteAfter: true },
    units: platforms.map((platform) => ({ kind: UNIT_KINDS.NETWORK, platform, accountLabel: "default", options: { fastSync: false, promoteAfter: false } })),
  });
  for (const unit of h.units(run.id)) {
    await h.prisma.jobRun.update({ where: { id: unit.id }, data: { status, completedAt: now() } });
  }
  return run;
}

/* ============================================================= the network gate ============= */

describe("Phase 6d — the network gate", () => {
  it("1/2/3. promotion is not seeded while any network unit is pending, running or retrying", () => {
    for (const [status, reason] of [["PENDING", "network_unit_pending"], ["RUNNING", "network_unit_running"]]) {
      const units = [networkRow("boostiny"), networkRow("rakuten", status)];
      const result = plan(units);
      assert.equal(result.stage, POST_SYNC_STAGES.AWAITING, status);
      assert.deepEqual(result.seeds, []);
      assert.equal(result.reason, reason);
    }
    // A retryable failure is a unit back in PENDING carrying its error. It is NOT terminal, so it
    // blocks — which a completed/failed counter pair could never tell from work not yet started.
    const retrying = [networkRow("boostiny"), { ...networkRow("rakuten", "PENDING"), attempt: 1, lastError: "zzupstreamzz" }];
    const result = plan(retrying);
    assert.equal(result.stage, POST_SYNC_STAGES.AWAITING);
    assert.equal(result.reason, "network_unit_pending");
    assert.deepEqual(result.seeds, []);
  });

  it("4. an unresolved deferred source blocks promotion even when every unit is complete", () => {
    const units = [...TWO_NETWORKS];
    const pending = plan(units, { deferredSources: [{ platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", status: "pending" }] });
    assert.equal(pending.stage, POST_SYNC_STAGES.AWAITING);
    assert.equal(pending.reason, "deferred_source_unresolved");
    assert.deepEqual(pending.seeds, []);

    const resolved = plan(units, { deferredSources: [{ platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", status: "materialised", units: 0 }] });
    assert.equal(resolved.stage, POST_SYNC_STAGES.PROMOTING);
    assert.equal(resolved.seeds.length, 2);
  });

  it("5. a dead-lettered or failed network unit stops the progression entirely", () => {
    for (const status of ["DEAD_LETTER", "FAILED", "CANCELLED"]) {
      const units = [networkRow("boostiny"), networkRow("rakuten", status)];
      const result = plan(units);
      assert.equal(result.stage, POST_SYNC_STAGES.FAILED, status);
      assert.deepEqual(result.seeds, []);
      assert.equal(result.failureStage, FAILURE_STAGES.NETWORK);
    }
    assert.equal(networkPhaseState([networkRow("a", "DEAD_LETTER")]).reason, "network_unit_failed");
  });

  it("6/7. one campaign first page per completed network, and a repeated gate call adds nothing", async () => {
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h);

    const first = await h.orchestration.advancePostSync(run.id);
    assert.equal(first.stage, POST_SYNC_STAGES.PROMOTING);
    assert.equal(first.appended, 2, "one campaign walk per network");
    const seeded = h.unitsOf(run.id, UNIT_KINDS.PROMOTION);
    assert.deepEqual(seeded.map((u) => `${u.payload.networkSource}/${u.payload.entityType}`), ["boostiny/campaign", "rakuten/campaign"]);
    for (const unit of seeded) {
      assert.equal(unit.payload.cursorId, null);
      assert.equal(unit.payload.pageSize, PROMOTION_PAGE_SIZE);
      assert.equal(unit.status, "PENDING");
    }

    for (let call = 0; call < 3; call += 1) {
      // eslint-disable-next-line no-await-in-loop
      const again = await h.orchestration.advancePostSync(run.id);
      assert.equal(again.appended, 0, "a repeated gate call seeds nothing");
    }
    assert.equal(h.unitsOf(run.id, UNIT_KINDS.PROMOTION).length, 2);
  });
});

/* ======================================================= promotion dependencies ============= */

describe("Phase 6d — promotion intra-network dependencies", () => {
  it("8. only campaign first pages exist initially — no coupon, no offer", () => {
    const result = plan(TWO_NETWORKS);
    assert.deepEqual(result.seeds.map((s) => s.entityType), ["campaign", "campaign"]);
    assert.ok(!result.seeds.some((s) => s.entityType === "coupon"), "coupon seeded too early");
    assert.ok(!result.seeds.some((s) => s.entityType === "offer"), "offer seeded too early");
  });

  it("9/10/13. coupon and offer stay blocked while the campaign walk is outstanding", () => {
    for (const status of ["PENDING", "RUNNING"]) {
      const units = [...TWO_NETWORKS, promotionRow("boostiny", "campaign", status), promotionRow("rakuten", "campaign", status)];
      const result = plan(units);
      assert.deepEqual(result.seeds, [], status);
      assert.equal(result.reason, "promotion_outstanding");
    }
    // A campaign continuation is an outstanding unit of the same walk: its network stays blocked
    // while another network whose walk finished is free to open its dependants.
    const mixed = [
      ...TWO_NETWORKS,
      promotionRow("boostiny", "campaign"),
      promotionRow("boostiny", "campaign", "PENDING", { cursorId: "e-0049" }),
      promotionRow("rakuten", "campaign"),
    ];
    const result = plan(mixed);
    assert.deepEqual(
      result.seeds.map((s) => `${s.networkSource}/${s.entityType}`),
      ["rakuten/coupon", "rakuten/offer"],
      "only the network whose campaign walk resolved opens its dependants",
    );
  });

  it("11/12. a short walk and an empty walk both count as resolved", () => {
    // One completed page with nothing promoted is still a walk that ran. Requiring a promoted row
    // would stall any network that legitimately has no campaigns.
    const units = [networkRow("boostiny"), promotionRow("boostiny", "campaign")];
    assert.equal(walkState(units, { kind: UNIT_KINDS.PROMOTION, networkSource: "boostiny", entityType: "campaign" }), "resolved");
    const result = plan(units);
    assert.deepEqual(result.seeds.map((s) => s.entityType), ["coupon"]);
  });

  it("14/15/16. coupon is appended exactly once, offer only for Rakuten, never for anyone else", () => {
    const units = [...TWO_NETWORKS, promotionRow("boostiny", "campaign"), promotionRow("rakuten", "campaign")];
    const first = plan(units);
    assert.deepEqual(
      first.seeds.map((s) => `${s.networkSource}/${s.entityType}`),
      ["boostiny/coupon", "rakuten/coupon", "rakuten/offer"],
    );
    assert.ok(!first.seeds.some((s) => s.networkSource === "boostiny" && s.entityType === "offer"), "a non-Rakuten network got an offer walk");

    // Once they exist, the gate stops offering them however many times it is asked.
    const after = [...units, ...first.seeds.map((s) => promotionRow(s.networkSource, s.entityType, "PENDING"))];
    assert.deepEqual(plan(after).seeds, []);
  });

  it("17. a campaign failure blocks that network's later types and the whole progression", () => {
    const units = [...TWO_NETWORKS, promotionRow("boostiny", "campaign", "DEAD_LETTER"), promotionRow("rakuten", "campaign")];
    const result = plan(units);
    assert.equal(result.stage, POST_SYNC_STAGES.FAILED);
    assert.deepEqual(result.seeds, [], "no coupon or offer is opened on top of a failed campaign walk");
    assert.equal(result.failureStage, FAILURE_STAGES.PROMOTION);
  });
});

/* ================================================ promotion to conversion promotion ========= */

describe("Phase 6d — promotion to conversion promotion", () => {
  const resolvedPromotion = [
    ...TWO_NETWORKS,
    promotionRow("boostiny", "campaign"), promotionRow("boostiny", "coupon"),
    promotionRow("rakuten", "campaign"), promotionRow("rakuten", "coupon"), promotionRow("rakuten", "offer"),
  ];

  it("18/19. conversion is not seeded while any promotion page is pending or retrying", () => {
    for (const trailing of [
      promotionRow("rakuten", "offer", "PENDING"),
      promotionRow("rakuten", "offer", "RUNNING"),
      { ...promotionRow("rakuten", "offer", "PENDING"), attempt: 2, lastError: "zzfailedzz" },
    ]) {
      const units = [...resolvedPromotion.slice(0, -1), trailing];
      const result = plan(units);
      assert.equal(result.stage, POST_SYNC_STAGES.PROMOTING);
      assert.deepEqual(result.seeds, []);
    }
    // A coupon walk that was never seeded is also "not finished", even though every row completed.
    const missingCoupon = [...TWO_NETWORKS, promotionRow("boostiny", "campaign"), promotionRow("rakuten", "campaign")];
    assert.ok(!plan(missingCoupon).seeds.some((s) => s.kind === UNIT_KINDS.CONVERSION_PROMOTION));
  });

  it("20. a promotion dead-letter stops progression to conversion", () => {
    const units = [...resolvedPromotion, promotionRow("boostiny", "coupon", "DEAD_LETTER", { cursorId: "e-0049" })];
    const result = plan(units);
    assert.equal(result.stage, POST_SYNC_STAGES.FAILED);
    assert.deepEqual(result.seeds, []);
    assert.equal(result.failureStage, FAILURE_STAGES.PROMOTION);
  });

  it("21/22. one conversion first page per network once promotion is fully resolved, then nothing", () => {
    const result = plan(resolvedPromotion);
    assert.equal(result.stage, POST_SYNC_STAGES.CONVERSION_PROMOTING);
    assert.deepEqual(result.seeds.map((s) => s.networkSource), ["boostiny", "rakuten"]);
    for (const seed of result.seeds) {
      assert.equal(seed.kind, UNIT_KINDS.CONVERSION_PROMOTION);
      assert.equal(seed.cursorId, null);
      assert.equal(seed.pageSize, CONVERSION_PROMOTION_PAGE_SIZE);
      assert.equal(seed.entityType, undefined, "a conversion unit has no entity type");
    }
    const after = [...resolvedPromotion, conversionRow("boostiny", "PENDING"), conversionRow("rakuten", "PENDING")];
    assert.deepEqual(plan(after).seeds, [], "a repeated gate call dedupes");
  });
});

/* ============================================= conversion promotion to aggregation ========== */

describe("Phase 6d — conversion promotion to aggregation", () => {
  const resolvedPromotion = [
    ...TWO_NETWORKS,
    promotionRow("boostiny", "campaign"), promotionRow("boostiny", "coupon"),
    promotionRow("rakuten", "campaign"), promotionRow("rakuten", "coupon"), promotionRow("rakuten", "offer"),
  ];

  it("23/24. aggregation waits for every conversion page, including a continuation", () => {
    for (const trailing of [conversionRow("rakuten", "PENDING"), conversionRow("rakuten", "RUNNING"), conversionRow("rakuten", "PENDING", { cursorId: "e-0099" })]) {
      const units = [...resolvedPromotion, conversionRow("boostiny"), trailing];
      const result = plan(units);
      assert.equal(result.stage, POST_SYNC_STAGES.CONVERSION_PROMOTING);
      assert.deepEqual(result.seeds, []);
      assert.equal(result.reason, "conversion_promotion_outstanding");
    }
  });

  it("25. a conversion dead-letter stops progression to aggregation", () => {
    const units = [...resolvedPromotion, conversionRow("boostiny"), conversionRow("rakuten", "DEAD_LETTER")];
    const result = plan(units);
    assert.equal(result.stage, POST_SYNC_STAGES.FAILED);
    assert.deepEqual(result.seeds, []);
    assert.equal(result.failureStage, FAILURE_STAGES.CONVERSION_PROMOTION);
  });

  it("26/27/30. aggregation is seeded only after every conversion walk resolves, one unit per day", () => {
    const units = [...resolvedPromotion, conversionRow("boostiny"), conversionRow("rakuten")];
    const result = plan(units);
    assert.equal(result.stage, POST_SYNC_STAGES.AGGREGATING);
    assert.equal(result.seeds.length, 15, "fourteen days back, inclusive, is fifteen days");
    assert.ok(result.seeds.every((s) => s.kind === UNIT_KINDS.AGGREGATION));
    const days = result.seeds.map((s) => s.day);
    assert.equal(new Set(days).size, 15, "every day is distinct");
    assert.deepEqual(days, [...days].sort(), "ascending");
  });
});

/* =================================================== the pinned aggregation window ========== */

describe("Phase 6d — the aggregation window is pinned to the run, not the clock", () => {
  it("28. the production run's context resolves to 2026-09-02 through 2026-09-16", () => {
    const window = aggregationWindowFor(RUN_STARTED_AT);
    assert.deepEqual(window, { from: "2026-09-02", to: "2026-09-16", days: 15 });
    const days = aggregationDaysFor(RUN_STARTED_AT);
    assert.equal(days.length, 15);
    assert.equal(days[0], "2026-09-02");
    assert.equal(days[14], "2026-09-16");
  });

  it("29. materialising on a later wall-clock day does NOT shift the window", async () => {
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h);
    const startedAt = h.parent(run.id).startedAt;
    assert.ok(startedAt, "the run carries its own immutable start");

    // Drive every stage to done, then jump the clock a week before aggregation is materialised.
    const units = [
      ...TWO_NETWORKS,
      promotionRow("boostiny", "campaign"), promotionRow("boostiny", "coupon"),
      promotionRow("rakuten", "campaign"), promotionRow("rakuten", "coupon"), promotionRow("rakuten", "offer"),
      conversionRow("boostiny"), conversionRow("rakuten"),
    ];
    advance(9 * 24 * 60 * 60 * 1000);
    const late = planPostSyncTransition(units, { postSyncRequested: true, runStartedAt: startedAt });
    assert.deepEqual(late.window, { from: "2026-09-02", to: "2026-09-16", days: 15 }, "the window follows the RUN, not the worker");
    assert.equal(late.seeds[0].day, "2026-09-02");
    assert.equal(late.seeds[14].day, "2026-09-16");

    // And a window computed from "now" would have been different, which is the whole point.
    const fromClock = aggregationWindowFor(now());
    assert.notDeepEqual(fromClock, late.window);
    resetClock();
  });

  it("the window matches the legacy post-sync rule exactly, for any anchor", () => {
    for (const iso of ["2026-09-16T04:12:00.000Z", "2026-01-01T00:00:00.000Z", "2026-03-01T23:59:59.000Z", "2024-02-29T12:00:00.000Z"]) {
      assert.deepEqual(aggregationWindowFor(new Date(iso)), resolvePostSyncAggregationWindow(new Date(iso)), iso);
    }
    // A month and a year boundary are walked correctly, not by string arithmetic.
    assert.deepEqual(aggregationDaysFor(new Date("2026-01-05T00:00:00.000Z")).slice(0, 2), ["2025-12-22", "2025-12-23"]);
    assert.throws(() => aggregationWindowFor("not-a-date"), /immutable start timestamp/);
    assert.throws(() => aggregationWindowFor(null), /immutable start timestamp/);
  });

  it("29b. the GATE ITSELF pins the window: seeding nine days late still rebuilds the run's fortnight", async () => {
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h, { platforms: ["boostiny"] });

    // Drive promotion and conversion to resolved through the real gate, then let the worker sit
    // idle for nine days before the aggregation stage is ever materialised. This is the case that
    // matters: a durable run is not finished the day it starts, and recomputing the window at
    // materialisation time would silently rebuild the wrong fortnight.
    for (let stage = 0; stage < 3; stage += 1) {
      // eslint-disable-next-line no-await-in-loop
      await h.orchestration.advancePostSync(run.id);
      // eslint-disable-next-line no-await-in-loop
      for (const unit of h.units(run.id).filter((u) => u.status === "PENDING")) {
        // eslint-disable-next-line no-await-in-loop
        await h.prisma.jobRun.update({ where: { id: unit.id }, data: { status: "COMPLETED", completedAt: now() } });
      }
    }
    advance(9 * 24 * 60 * 60 * 1000);
    const clockWindow = aggregationWindowFor(now());
    assert.notDeepEqual(clockWindow, { from: "2026-09-02", to: "2026-09-16", days: 15 }, "the clock really has moved");

    const seeded = await h.orchestration.advancePostSync(run.id);
    assert.equal(seeded.stage, POST_SYNC_STAGES.AGGREGATING);
    assert.equal(seeded.appended, 15);
    assert.deepEqual(seeded.window, { from: "2026-09-02", to: "2026-09-16", days: 15 }, "the RUN's fortnight, not the worker's");

    const days = h.unitsOf(run.id, UNIT_KINDS.AGGREGATION).map((u) => u.payload.day).sort();
    assert.deepEqual(days, aggregationDaysFor(RUN_STARTED_AT));
    assert.equal(days[0], "2026-09-02");
    assert.equal(days[14], "2026-09-16");
    assert.ok(!days.includes(clockWindow.to), "not one day of the worker's own fortnight leaked in");
    assert.equal(h.parent(run.id).payload.postSync.aggregation.pinnedTo, "startedAt");
    resetClock();
  });

  it("31. a replay never produces a duplicate day", async () => {
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h, { platforms: ["boostiny"] });
    // Fast-forward the run's rows to "conversion resolved" by seeding and completing each stage.
    for (const seeds of [
      [{ kind: UNIT_KINDS.PROMOTION, networkSource: "boostiny", entityType: "campaign", cursorId: null, pageSize: PROMOTION_PAGE_SIZE, options: {} }],
      [{ kind: UNIT_KINDS.PROMOTION, networkSource: "boostiny", entityType: "coupon", cursorId: null, pageSize: PROMOTION_PAGE_SIZE, options: {} }],
      [{ kind: UNIT_KINDS.CONVERSION_PROMOTION, networkSource: "boostiny", cursorId: null, pageSize: CONVERSION_PROMOTION_PAGE_SIZE, options: {} }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await h.orchestration.appendUnits(run.id, seeds);
      // eslint-disable-next-line no-await-in-loop
      for (const unit of h.units(run.id).filter((u) => u.status === "PENDING")) {
        // eslint-disable-next-line no-await-in-loop
        await h.prisma.jobRun.update({ where: { id: unit.id }, data: { status: "COMPLETED", completedAt: now() } });
      }
    }
    const seeded = await h.orchestration.advancePostSync(run.id);
    assert.equal(seeded.appended, 15);
    const replay = await h.orchestration.advancePostSync(run.id);
    assert.equal(replay.appended, 0, "a replay adds no day");
    const days = h.unitsOf(run.id, UNIT_KINDS.AGGREGATION).map((u) => u.payload.day);
    assert.equal(days.length, 15);
    assert.equal(new Set(days).size, 15);
    // The window is pinned durably on the parent, with the field it was pinned to.
    assert.deepEqual(h.parent(run.id).payload.postSync.aggregation, { from: "2026-09-02", to: "2026-09-16", days: 15, pinnedTo: "startedAt" });
  });
});

/* ============================================================ parent state and progress ===== */

describe("Phase 6d — parent state, progress and finalisation", () => {
  it("32/33/34/35/36. the derived stage walks awaiting → promoting → conversion → aggregating → completed", () => {
    const stageOf = (units) => plan(units).stage;
    const promotionDone = [
      ...TWO_NETWORKS,
      promotionRow("boostiny", "campaign"), promotionRow("boostiny", "coupon"),
      promotionRow("rakuten", "campaign"), promotionRow("rakuten", "coupon"), promotionRow("rakuten", "offer"),
    ];
    assert.equal(stageOf([networkRow("boostiny", "PENDING")]), POST_SYNC_STAGES.AWAITING);
    assert.equal(stageOf([...TWO_NETWORKS, promotionRow("boostiny", "campaign", "PENDING")]), POST_SYNC_STAGES.PROMOTING);
    assert.equal(stageOf([...promotionDone, conversionRow("boostiny", "PENDING")]), POST_SYNC_STAGES.CONVERSION_PROMOTING);
    const conversionDone = [...promotionDone, conversionRow("boostiny"), conversionRow("rakuten")];
    assert.equal(stageOf([...conversionDone, aggregationRow("2026-09-02", "PENDING")]), POST_SYNC_STAGES.AGGREGATING);
    const allDays = aggregationDaysFor(RUN_STARTED_AT).map((day) => aggregationRow(day));
    assert.equal(stageOf([...conversionDone, ...allDays]), POST_SYNC_STAGES.COMPLETED);
  });

  it("37/38/39/40/41. the parent stays open, and claims no total until aggregation exists", async () => {
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h, { platforms: ["boostiny"] });

    const awaiting = await h.orchestration.describeRun(run.id);
    assert.equal(awaiting.status, "awaiting_post_sync");
    assert.equal(awaiting.postSyncStage, POST_SYNC_STAGES.AWAITING);
    assert.equal(awaiting.finishedAt, null);
    assert.equal(awaiting.postSyncPending, true);
    assert.equal(awaiting.totalUnitsMayIncrease, true);
    assert.equal(awaiting.totalWorkKnown, false);
    assert.equal(awaiting.percentComplete, null, "no 100% claim while future work is unknown");
    assert.equal(awaiting.networkPercentComplete, 100, "the network phase IS fully known and done");
    assert.equal(awaiting.postSyncPercentComplete, null);
    assert.equal(awaiting.unitsPercentComplete, 100, "the units that exist are all done — which is why one number alone would mislead");

    await h.orchestration.advancePostSync(run.id);
    const promoting = await h.orchestration.describeRun(run.id);
    assert.equal(promoting.postSyncStage, POST_SYNC_STAGES.PROMOTING);
    assert.equal(promoting.totalUnitsMayIncrease, true);
    assert.equal(promoting.percentComplete, null);
    assert.equal(promoting.finishedAt, null);
    assert.equal(h.parent(run.id).payload.postSyncStages, "materialised");

    // Drive to aggregation seeding.
    for (const step of ["campaign", "coupon", "conversion"]) {
      // eslint-disable-next-line no-await-in-loop
      for (const unit of h.units(run.id).filter((u) => u.status === "PENDING")) {
        // eslint-disable-next-line no-await-in-loop
        await h.prisma.jobRun.update({ where: { id: unit.id }, data: { status: "COMPLETED", completedAt: now() } });
      }
      // eslint-disable-next-line no-await-in-loop
      await h.orchestration.advancePostSync(run.id);
      assert.ok(step);
    }
    const aggregating = await h.orchestration.describeRun(run.id);
    assert.equal(aggregating.postSyncStage, POST_SYNC_STAGES.AGGREGATING);
    assert.equal(aggregating.totalUnitsMayIncrease, false, "aggregation days append nothing, so the total is finally known");
    assert.equal(aggregating.totalWorkKnown, true);
    assert.equal(typeof aggregating.percentComplete, "number");
    assert.ok(aggregating.percentComplete < 100, "and it is not 100 while days remain");
    assert.equal(aggregating.finishedAt, null);
    assert.equal(aggregating.postSyncPending, true);

    // Complete every day: only now may the parent finalise.
    for (const unit of h.units(run.id).filter((u) => u.status === "PENDING")) {
      // eslint-disable-next-line no-await-in-loop
      await h.prisma.jobRun.update({ where: { id: unit.id }, data: { status: "COMPLETED", completedAt: now() } });
    }
    await h.orchestration.refreshRun(run.id);
    const done = await h.orchestration.describeRun(run.id);
    assert.equal(done.status, "success");
    assert.equal(done.postSyncStage, POST_SYNC_STAGES.COMPLETED);
    assert.equal(done.postSyncPending, false);
    assert.equal(done.percentComplete, 100);
    assert.equal(done.postSyncPercentComplete, 100);
    assert.ok(done.finishedAt, "finishedAt is set exactly once, at the end");
    assert.equal(done.failureStage, null);
  });
});

/* ============================================================================ failures ====== */

describe("Phase 6d — post-sync failure is distinct from network failure", () => {
  it("42/43/44/45/46. each stage's dead-letter stops progression and is named, never as 'network'", async () => {
    for (const [seedRows, expected] of [
      [[promotionRow("boostiny", "campaign", "DEAD_LETTER")], FAILURE_STAGES.PROMOTION],
      [[promotionRow("boostiny", "campaign"), promotionRow("boostiny", "coupon"), conversionRow("boostiny", "DEAD_LETTER")], FAILURE_STAGES.CONVERSION_PROMOTION],
      [[promotionRow("boostiny", "campaign"), promotionRow("boostiny", "coupon"), conversionRow("boostiny"), aggregationRow("2026-09-02", "DEAD_LETTER")], FAILURE_STAGES.AGGREGATION],
    ]) {
      const units = [networkRow("boostiny"), ...seedRows];
      const result = plan(units);
      assert.equal(result.stage, POST_SYNC_STAGES.FAILED, expected);
      assert.equal(result.failureStage, expected);
      assert.deepEqual(result.seeds, [], "no later-stage unit appears after a failure");
      assert.equal(failureStageOf(units), expected);
      // The 134-unit network phase is intact and must never be blamed.
      assert.notEqual(failureStageOf(units), FAILURE_STAGES.NETWORK);
    }

    // End to end: an aggregation day that dead-letters finalises the parent FAILED, and the stage
    // is recorded durably next to it.
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h, { platforms: ["boostiny"] });
    await h.orchestration.appendUnits(run.id, [{ kind: UNIT_KINDS.AGGREGATION, day: "2026-09-02", options: {} }]);
    const day = h.unitsOf(run.id, UNIT_KINDS.AGGREGATION)[0];
    await h.prisma.jobRun.update({ where: { id: day.id }, data: { status: "DEAD_LETTER", lastError: "zzaggregation blew upzz" } });
    await h.orchestration.refreshRun(run.id);
    const described = await h.orchestration.describeRun(run.id);
    assert.equal(described.status, "failed");
    assert.equal(described.failureStage, FAILURE_STAGES.AGGREGATION, "the stage, not the run's network history");
    assert.equal(h.parent(run.id).payload.failureStage, FAILURE_STAGES.AGGREGATION);
    assert.equal((await h.orchestration.advancePostSync(run.id)).appended, 0, "a finalised run seeds nothing");
  });
});

/* =========================================================== races and idempotency ========== */

describe("Phase 6d — races, replay and idempotency", () => {
  it("47. two gate calls racing on the same rows produce one set of seeds", async () => {
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h);
    const [a, b] = await Promise.all([h.orchestration.advancePostSync(run.id), h.orchestration.advancePostSync(run.id)]);
    const appended = (a.appended ?? 0) + (b.appended ?? 0);
    assert.equal(appended >= 2, true, "at least one racer seeded the stage");
    const seeded = h.unitsOf(run.id, UNIT_KINDS.PROMOTION);
    assert.equal(seeded.length, 2, "and the duplicates were collapsed to one per walk");
    assert.deepEqual(seeded.map((u) => `${u.payload.networkSource}/${u.payload.entityType}`).sort(), ["boostiny/campaign", "rakuten/campaign"]);
  });

  it("48. a worker that died after appending but before refreshing leaves the run correct", async () => {
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h, { platforms: ["boostiny"] });
    // Simulate the crash: units appended, parent projection never refreshed.
    await h.orchestration.appendUnits(run.id, [{ kind: UNIT_KINDS.PROMOTION, networkSource: "boostiny", entityType: "campaign", cursorId: null, pageSize: PROMOTION_PAGE_SIZE, options: {} }]);
    await h.prisma.jobRun.update({ where: { id: run.id }, data: { result: { totalUnits: 1, completedUnits: 1, status: "awaiting_post_sync" } } });

    // The next worker reads ROWS, not the stale projection, and neither duplicates nor skips.
    const again = await h.orchestration.advancePostSync(run.id);
    assert.equal(again.appended, 0, "the seeded walk is recognised from its row");
    const described = await h.orchestration.describeRun(run.id);
    assert.equal(described.postSyncStage, POST_SYNC_STAGES.PROMOTING);
    assert.equal(described.totalUnits, 2);
  });

  it("49. a duplicated completion callback cannot open two next stages", async () => {
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h, { platforms: ["boostiny"] });
    await h.orchestration.advancePostSync(run.id);
    for (const unit of h.units(run.id).filter((u) => u.status === "PENDING")) {
      // eslint-disable-next-line no-await-in-loop
      await h.prisma.jobRun.update({ where: { id: unit.id }, data: { status: "COMPLETED", completedAt: now() } });
    }
    const results = await Promise.all([1, 2, 3].map(() => h.orchestration.advancePostSync(run.id)));
    const coupons = h.unitsOf(run.id, UNIT_KINDS.PROMOTION).filter((u) => u.payload.entityType === "coupon");
    assert.equal(coupons.length, 1, "three replayed completions, one coupon walk");
    assert.equal(results.filter((r) => (r.appended ?? 0) > 0).length >= 1, true);
  });

  it("50. the gate holds no module memory: it is a pure function of the rows it is given", () => {
    // Same rows, twice, in two different orders: same decision.
    const units = [...TWO_NETWORKS, promotionRow("boostiny", "campaign"), promotionRow("rakuten", "campaign")];
    const forward = plan(units);
    const reversed = plan([...units].reverse());
    assert.deepEqual(
      forward.seeds.map((s) => `${s.networkSource}/${s.entityType}`).sort(),
      reversed.seeds.map((s) => `${s.networkSource}/${s.entityType}`).sort(),
    );
    // And nothing in the module reaches for a clock, a database, or a supplier.
    const code = GATE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of ["Date.now(", "prisma", "this.db", "fetch(", "axios", "process.env"]) {
      assert.ok(!code.includes(forbidden), forbidden);
    }
    // `new Date()` with no argument is the wall clock; every Date here is built from an anchor.
    assert.ok(!/new Date\(\s*\)/.test(code), "the gate reads the wall clock");
  });
});

/* ============================================================== placeholder handling ======== */

describe("Phase 6d — old placeholders are markers, not work", () => {
  const withPlaceholders = [
    networkRow("boostiny"),
    placeholderRow(UNIT_KINDS.PROMOTION),
    placeholderRow(UNIT_KINDS.CONVERSION_PROMOTION),
    placeholderRow(UNIT_KINDS.AGGREGATION),
  ];

  it("51/52/53. a placeholder never executes, never counts as a resolved walk, and never blocks a seed", () => {
    // Not a resolved walk: it names no network and no page.
    assert.equal(walkState(withPlaceholders, { kind: UNIT_KINDS.PROMOTION, networkSource: "boostiny", entityType: "campaign" }), "absent");
    assert.deepEqual(postSyncNetworks(withPlaceholders), ["boostiny"]);
    // And it does not stop the campaign walk being opened.
    const result = plan(withPlaceholders);
    assert.equal(result.stage, POST_SYNC_STAGES.PROMOTING);
    assert.deepEqual(result.seeds.map((s) => `${s.networkSource}/${s.entityType}`), ["boostiny/campaign"]);
    // A placeholder is also never counted as a failure, whatever its status.
    assert.equal(failureStageOf(withPlaceholders), null);
  });

  it("54. seeding supersedes the placeholder, which stays visible but stops holding the run open", async () => {
    resetClock();
    const h = app();
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: true },
      units: [
        { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: { fastSync: false, promoteAfter: false } },
        { kind: UNIT_KINDS.PROMOTION, options: {}, executable: false, blockedReason: "bounded_units_not_implemented" },
      ],
    });
    for (const unit of h.unitsOf(run.id, UNIT_KINDS.NETWORK)) {
      await h.prisma.jobRun.update({ where: { id: unit.id }, data: { status: "COMPLETED", completedAt: now() } });
    }
    await h.orchestration.advancePostSync(run.id);

    const promotion = h.unitsOf(run.id, UNIT_KINDS.PROMOTION);
    const placeholder = promotion.find((u) => u.payload.executable === false);
    const bounded = promotion.filter((u) => u.payload.executable !== false);
    assert.equal(bounded.length, 1, "the bounded unit has an identity of its own");
    assert.equal(bounded[0].payload.entityType, "campaign");
    assert.ok(placeholder, "the placeholder row is kept as a historical planning marker");
    assert.equal(placeholder.status, "PENDING", "never cancelled — cancelling would read as a failure");
    assert.equal(placeholder.payload.supersededBy, "bounded_units");
    assert.ok(placeholder.payload.supersededAt);

    const described = await h.orchestration.describeRun(run.id);
    assert.equal(described.supersededUnits, 1);
    assert.equal(described.blockedUnits, 0, "a superseded marker is not outstanding work");
    assert.equal(described.failedUnits, 0);
  });
});

/* ================================================================== end to end worker ======= */

describe("Phase 6d — the worker drives the whole post-sync phase, one unit at a time", () => {
  it("advances network → promotion → conversion → aggregation with one unit per invocation", async () => {
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h, { platforms: ["boostiny"] });

    // 1 — the first poll finds no workable unit, opens promotion, and works its first page.
    const first = await h.worker();
    assert.equal(first.body.worked, true);
    assert.equal(first.body.unit.kind, UNIT_KINDS.PROMOTION);
    assert.equal(first.body.unit.promotionPage.entityType, "campaign");
    assert.equal(h.calls.promotion.length, 1, "exactly one page ran");
    assert.equal(h.calls.conversion.length, 0);
    assert.equal(h.calls.aggregation.length, 0);
    assert.equal(first.body.syncStatus.postSyncStage, POST_SYNC_STAGES.PROMOTING);

    // 2 — completing the campaign walk opens the coupon walk, and only it.
    const second = await h.worker();
    assert.equal(second.body.unit.promotionPage.entityType, "coupon");
    assert.equal(h.calls.promotion.length, 2);
    assert.equal(h.calls.conversion.length, 0, "conversion has not started");

    // 3 — with promotion resolved, conversion opens.
    const third = await h.worker();
    assert.equal(third.body.unit.kind, UNIT_KINDS.CONVERSION_PROMOTION);
    assert.equal(h.calls.conversion.length, 1);
    assert.equal(h.calls.aggregation.length, 0, "aggregation has not started");

    // 4 — with conversion resolved, the fifteen days open and are worked one per invocation.
    const fourth = await h.worker();
    assert.equal(fourth.body.unit.kind, UNIT_KINDS.AGGREGATION);
    assert.equal(h.unitsOf(run.id, UNIT_KINDS.AGGREGATION).length, 15);
    assert.equal(h.calls.aggregation.length, 1, "one day per invocation");
    assert.deepEqual(h.calls.aggregation[0], { from: "2026-09-02", to: "2026-09-02" });

    let guard = 0;
    while ((await h.worker()).body.worked && guard < 40) guard += 1;
    assert.equal(h.calls.aggregation.length, 15, "fifteen days, one invocation each");
    assert.deepEqual(h.calls.aggregation.map((c) => c.from).sort(), aggregationDaysFor(RUN_STARTED_AT));

    const done = await h.orchestration.describeRun(run.id);
    assert.equal(done.status, "success");
    assert.equal(done.postSyncStage, POST_SYNC_STAGES.COMPLETED);
    assert.ok(done.finishedAt);
    assert.equal(done.failureStage, null);
    assert.equal(done.totalUnitsMayIncrease, false);
    assert.equal(done.percentComplete, 100);
  });

  it("a non-current planner version is never advanced, so plannerVersion 6 stays the only shape", async () => {
    resetClock();
    const h = app();
    const run = await runWithCompletedNetwork(h, { platforms: ["boostiny"] });
    assert.equal(h.parent(run.id).payload.plannerVersion, PLANNER_VERSION);
    assert.equal(PLANNER_VERSION, 6, "Phase 6d does not change the planner version");

    await h.prisma.jobRun.update({ where: { id: run.id }, data: { payload: { ...h.parent(run.id).payload, plannerVersion: 5 } } });
    const refused = await h.orchestration.advancePostSync(run.id);
    assert.equal(refused.appended, 0);
    assert.equal(refused.reason, "planner_version_mismatch");
    assert.equal(h.unitsOf(run.id, UNIT_KINDS.PROMOTION).length, 0);
  });

  it("a run that never asked for post-sync is left exactly as it was", async () => {
    resetClock();
    const h = app();
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", options: { fastSync: false, promoteAfter: false } }],
    });
    for (const unit of h.units(run.id)) {
      await h.prisma.jobRun.update({ where: { id: unit.id }, data: { status: "COMPLETED", completedAt: now() } });
    }
    const result = await h.orchestration.advancePostSync(run.id);
    assert.equal(result.reason, "post_sync_not_requested");
    assert.equal(result.appended, 0);
    await h.orchestration.refreshRun(run.id);
    const described = await h.orchestration.describeRun(run.id);
    assert.equal(described.status, "success", "it finalises on its network units alone, as before");
    assert.equal(described.totalUnitsMayIncrease, false);
    assert.equal(postSyncMayAppendUnits(h.units(run.id), { postSyncRequested: false }), false);
  });
});
