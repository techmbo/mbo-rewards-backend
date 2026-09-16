/**
 * Phase 5 — a unit is platform + accountLabel + sourceObject [+ window].
 *
 * The account-wide unit could not fit a serverless invocation (production run c9e3e699 died at
 * FUNCTION_INVOCATION_TIMEOUT on optimise_sea/default). These tests pin what replaced it: the
 * audited source objects of each network, chronological windows that cover the intended span with
 * no overlap and no gap, one account lock shared by all of an account's units, a worker that
 * forwards the bounded scope verbatim and still executes exactly one unit — and the two things
 * that must never happen quietly: an unbounded source pretending to be bounded, and a bounded
 * unit widening back to the 180-day pull.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { triggerSyncWorker } from "../src/controllers/sync.controller.js";
import {
  UNIT_JOB_NAME,
  UNIT_KINDS,
  SyncOrchestrationService,
  buildSyncPlan,
  isUnitExecutable,
} from "../src/jobs/syncOrchestration.service.js";
import { accountLockKey } from "../src/jobs/syncAccountLock.service.js";
import {
  UNBOUNDED_FANOUT_REASON,
  buildDateWindows,
  planAccountUnits,
  planSourcesFor,
  resolvePlanSpan,
} from "../src/jobs/syncSourcePlan.js";
import { explicitSyncWindow, runWithSyncOptions, sourceObjectCompanions } from "../src/jobs/syncContext.js";
import { includeSourceObject } from "../src/jobs/sourceObjectRuns.js";
import {
  getBoostinyReportRange,
  getOptimiseDateRange,
  getTrackierDateRange,
} from "../src/jobs/sync.job.js";
import { buildAdmitadIncrementalActionParams } from "../src/jobs/admitadSupplierSync.js";
import { buildRakutenEventWindow, buildRakutenPaymentHistoryWindow } from "../src/jobs/rakutenSupplierSync.js";
import { clampAwinWindowStart } from "../src/jobs/waveESupplierSync.js";

const SYNC_JOB_SRC = readFileSync(new URL("../src/jobs/sync.job.js", import.meta.url), "utf8");
const WAVE_E_SRC = readFileSync(new URL("../src/jobs/waveESupplierSync.js", import.meta.url), "utf8");
const CONTROLLER_SRC = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");

const NOW = new Date("2026-09-15T00:00:00.000Z");
const now = () => NOW;
const ACCOUNTS = {
  boostiny: ["default"],
  optimise_sea: ["second", "default"], // deliberately unsorted: the plan must sort them
  optimise_mena: [],
  optimise_uk: [],
  trackier: ["default"],
};
const listAccounts = async (platform) => ACCOUNTS[platform] ?? ["default"];
const loadAccountState = async () => ({ lastSuccessfulSync: null });
const planFor = (opts = {}) =>
  buildSyncPlan({ kind: "full", promoteAfter: true, listAccounts, loadAccountState, now: NOW, ...opts });

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
      const row = { id: `row-${String(seq).padStart(4, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(NOW.getTime() + seq), ...data };
      rows.push(row); return clone(row);
    },
    async update({ where, data }) { const row = rows.find((r) => r.id === where.id); apply(row, data); return clone(row); },
    async updateMany({ where, data }) { let count = 0; for (const row of rows) if (match(row, where)) { apply(row, data); count += 1; } return { count }; },
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { const list = sort(rows.filter((r) => match(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
    async createMany({ data }) { createManyCalls.push(data.length); for (const row of data) await jobRun.create({ data: row }); return { count: data.length }; },
  };
  const createManyCalls = [];
  return { rows, createManyCalls, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

function harness({ units = null, syncImpl = null } = {}) {
  const { rows, prisma, createManyCalls } = createStore();
  const orchestration = new SyncOrchestrationService({ prisma, now, listAccounts, loadAccountState });
  const calls = [];
  const locals = {
    syncOrchestration: orchestration,
    syncPlatformAccount: async (platform, accountLabel, options) => {
      calls.push({ platform, accountLabel, options });
      if (syncImpl) return syncImpl({ platform, accountLabel, options });
      return { [accountLabel ?? "default"]: { campaigns: 1 } };
    },
  };
  const worker = async () => {
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await triggerSyncWorker({ app: { locals } }, res, (error) => { throw error; });
    return res;
  };
  return { rows, prisma, createManyCalls, orchestration, calls, worker, units, unitsOf: (runId) => rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId) };
}

const unitsOfAccount = (plan, platform, accountLabel) =>
  plan.filter((u) => u.platform === platform && u.accountLabel === accountLabel);

describe("an account is many bounded units, not one", () => {
  it("plans one unit per audited source object, and several per windowed source", async () => {
    const { units } = await planFor();
    const boostiny = unitsOfAccount(units, "boostiny", "default");
    assert.ok(boostiny.length > 1, "an account is no longer a single unit");
    assert.ok(boostiny.every((u) => u.sourceObject), "every bounded unit names its source object");

    // Exactly the source objects the audit recorded for the network, in that order.
    const planned = [...new Set(boostiny.map((u) => u.sourceObject))];
    assert.deepEqual(planned, ["campaigns", "coupons", "api_reports", "link_reports"]);

    // Catalog objects carry no window; time-based ones are chopped into several.
    assert.equal(boostiny.filter((u) => u.sourceObject === "campaigns").length, 1);
    assert.equal(boostiny.filter((u) => u.sourceObject === "campaigns")[0].windowStart, undefined);
    assert.ok(boostiny.filter((u) => u.sourceObject === "api_reports").length > 1, "180 days is not one request");
  });

  it("every planned source object is one the sync layer actually filters on", async () => {
    const { units, exclusions } = await planFor();
    for (const unit of units) {
      const audited = planSourcesFor(unit.platform).map((s) => s.sourceObject);
      assert.ok(audited.includes(unit.sourceObject), `${unit.platform}:${unit.sourceObject} is not in the audit`);
      // The filter the sync layer applies must accept the unit's own source object.
      assert.equal(includeSourceObject(unit.sourceObject, unit.sourceObject), true);
    }
    for (const excluded of exclusions) {
      assert.ok(planSourcesFor(excluded.platform).some((s) => s.sourceObject === excluded.sourceObject));
    }
  });

  it("a derived source object rides with its parent instead of becoming its own unit", async () => {
    const { units } = await planFor();
    // Impact reports are computed from the actions fetched in the SAME call, so a separate unit
    // would fetch nothing. They travel as a declared companion.
    assert.ok(!units.some((u) => u.platform === "impact" && u.sourceObject === "reports"));
    const actions = units.find((u) => u.platform === "impact" && u.sourceObject === "actions");
    assert.deepEqual(actions.sourceObjectCompanions, ["reports"]);
    const analytics = units.find((u) => u.platform === "partnerize" && u.sourceObject === "conversions");
    assert.deepEqual(analytics.sourceObjectCompanions, ["analytics"]);

    // The companion passes the sync layer's filter only when it was declared.
    await runWithSyncOptions({ sourceObject: "actions", sourceObjectCompanions: ["reports"] }, async () => {
      assert.equal(includeSourceObject("actions", "reports"), true);
      assert.deepEqual(sourceObjectCompanions(), ["reports"]);
    });
    // A manual ?sourceObject=actions request declares nothing, so its behaviour is unchanged.
    await runWithSyncOptions({ sourceObject: "actions" }, async () => {
      assert.equal(includeSourceObject("actions", "reports"), false);
      assert.equal(includeSourceObject("actions", "actions"), true);
    });
  });
});

describe("ordering is deterministic", () => {
  it("platform, then account, then source object, then chronological window", async () => {
    const { units } = await planFor();
    const platforms = [...new Set(units.map((u) => u.platform))];
    assert.deepEqual(platforms, [
      "boostiny", "optimise_sea", "trackier",
      "impact", "partnerize", "awin", "admitad", "rakuten", "cj",
    ]);

    // Accounts are sorted by label, not by connection order, so a reconnection cannot reshuffle
    // the plan. ACCOUNTS lists optimise_sea as ["second", "default"] on purpose.
    const seaAccounts = [...new Set(unitsOfAccount(units, "optimise_sea", "default").length ? units.filter((u) => u.platform === "optimise_sea").map((u) => u.accountLabel) : [])];
    assert.deepEqual(seaAccounts, ["default", "second"]);

    // Within an account: source objects in audit order, windows in ascending date order.
    const sea = unitsOfAccount(units, "optimise_sea", "default");
    const order = [...new Set(sea.map((u) => u.sourceObject))];
    assert.deepEqual(order, ["campaigns", "voucher_codes", "conversions", "reporting", "payment_overview", "invoices"]);
    const conversions = sea.filter((u) => u.sourceObject === "conversions");
    assert.deepEqual(
      conversions.map((u) => u.windowStart),
      [...conversions.map((u) => u.windowStart)].sort(),
      "windows ascend",
    );
    assert.deepEqual(units.map((u) => u.sequence), units.map((_, i) => i + 1));
  });

  it("the same inputs plan byte-identical units, twice", async () => {
    const a = await planFor();
    const b = await planFor();
    assert.deepEqual(a.units, b.units);
    assert.deepEqual(a.exclusions, b.exclusions);
  });
});

describe("date windows cover the span exactly", () => {
  it("contiguous, ascending, no overlap and no gap, ending on the last day", () => {
    const windows = buildDateWindows({ from: "2026-01-01", to: "2026-02-05", windowDays: 14 });
    assert.deepEqual(windows, [
      { windowStart: "2026-01-01", windowEnd: "2026-01-14" },
      { windowStart: "2026-01-15", windowEnd: "2026-01-28" },
      { windowStart: "2026-01-29", windowEnd: "2026-02-05" },
    ]);
    for (let i = 1; i < windows.length; i += 1) {
      const previousEnd = new Date(`${windows[i - 1].windowEnd}T00:00:00.000Z`);
      previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
      assert.equal(windows[i].windowStart, previousEnd.toISOString().slice(0, 10), "no gap, no overlap");
    }
    assert.deepEqual(buildDateWindows({ from: "2026-01-05", to: "2026-01-05", windowDays: 30 }), [
      { windowStart: "2026-01-05", windowEnd: "2026-01-05" },
    ]);
    assert.deepEqual(buildDateWindows({ from: "2026-01-06", to: "2026-01-05", windowDays: 7 }), [], "an inverted span plans nothing");
  });

  it("a windowed source object's units tile its whole span and nothing more", async () => {
    const { units } = await planFor();
    for (const [platform, sourceObject] of [["boostiny", "api_reports"], ["trackier", "conversions"], ["admitad", "actions"]]) {
      const windowed = units.filter((u) => u.platform === platform && u.sourceObject === sourceObject);
      const span = resolvePlanSpan({
        platform,
        lastSuccessfulSync: null,
        now: NOW,
        source: planSourcesFor(platform).find((s) => s.sourceObject === sourceObject),
      });
      assert.equal(windowed[0].windowStart, span.from, `${platform}:${sourceObject} starts at the span`);
      assert.equal(windowed.at(-1).windowEnd, span.to, `${platform}:${sourceObject} ends at the span`);
      for (let i = 1; i < windowed.length; i += 1) {
        assert.ok(windowed[i].windowStart > windowed[i - 1].windowEnd, "no overlap");
        const previousEnd = new Date(`${windowed[i - 1].windowEnd}T00:00:00.000Z`);
        previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
        assert.equal(windowed[i].windowStart, previousEnd.toISOString().slice(0, 10), "no gap");
      }
    }
  });

  it("an account already synced plans its outstanding span only, not the initial lookback", () => {
    const cold = planAccountUnits({ platform: "boostiny", accountLabel: "default", lastSuccessfulSync: null, now: NOW });
    const warm = planAccountUnits({
      platform: "boostiny",
      accountLabel: "default",
      lastSuccessfulSync: new Date("2026-09-13T00:00:00.000Z"),
      now: NOW,
    });
    const coldReports = cold.units.filter((u) => u.sourceObject === "api_reports");
    const warmReports = warm.units.filter((u) => u.sourceObject === "api_reports");
    assert.ok(coldReports.length > warmReports.length, "a first sync is many windows");
    assert.equal(warmReports.length, 1, "a recent sync is one small window");
    // lastSuccessfulSync minus the standard overlap, never later than it.
    assert.equal(warmReports[0].windowStart, "2026-09-11");
    assert.equal(warmReports[0].windowEnd, "2026-09-15");
  });
});

describe("account exclusion survives the split", () => {
  it("every unit of one account shares one account lock, and different accounts do not", async () => {
    const { units } = await planFor();
    const sea = unitsOfAccount(units, "optimise_sea", "default");
    const expected = accountLockKey({ platform: "optimise_sea", accountLabel: "default" });
    assert.ok(sea.length > 1);
    assert.deepEqual([...new Set(sea.map((u) => u.lockKey))], [expected], "one key for the whole account");
    assert.equal(expected, "network:optimise_sea:default");
    assert.ok(sea.every((u) => !u.lockKey.includes(u.sourceObject)), "the key is never source-object scoped");

    const others = units.filter((u) => !(u.platform === "optimise_sea" && u.accountLabel === "default"));
    assert.ok(others.every((u) => u.lockKey !== expected), "other accounts and networks are independent");
    assert.equal(
      new Set(units.map((u) => u.lockKey)).size,
      new Set(units.map((u) => `${u.platform}/${u.accountLabel}`)).size,
      "exactly one lock key per account",
    );
  });

  it("a claimed unit blocks its sibling source object on the same account, not other accounts", async () => {
    const h = harness();
    const run = await h.orchestration.createRun({
      kind: "full",
      trigger: "api",
      options: { promoteAfter: false },
      units: [
        { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", sourceObject: "campaigns", options: {} },
        { kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", sourceObject: "api_reports", windowStart: "2026-09-01", windowEnd: "2026-09-14", options: {} },
        { kind: UNIT_KINDS.NETWORK, platform: "trackier", accountLabel: "default", sourceObject: "campaigns", options: {} },
      ],
    });
    const [campaigns, reports, trackier] = h.unitsOf(run.id);
    assert.equal((await h.orchestration.claimUnit(campaigns.id, { workerId: "a" })).claimed, true);
    const sibling = await h.orchestration.claimUnit(reports.id, { workerId: "b" });
    assert.equal(sibling.claimed, false, "the same account is not synced twice at once");
    assert.equal(sibling.reason, "lock_held");
    assert.equal((await h.orchestration.claimUnit(trackier.id, { workerId: "c" })).claimed, true, "a different network is free");
  });
});

describe("duplicate enqueue", () => {
  it("resumes the compatible run and creates no second unit set", async () => {
    const h = harness();
    const options = { fastSync: false, promoteAfter: true };
    const first = await h.orchestration.getOrCreateRun({ kind: "full", trigger: "api", options });
    const second = await h.orchestration.getOrCreateRun({ kind: "full", trigger: "api", options });
    assert.equal(second.id, first.id);
    assert.equal(second.created, false);
    const planned = (await planFor()).units.length;
    assert.equal(h.unitsOf(first.id).length, planned);
    assert.equal(h.rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.status === "PENDING").length, planned, "no duplicate units");
  });
});

describe("enqueue stays bounded", () => {
  it("writes the whole plan in one statement inside one transaction", async () => {
    const h = harness();
    const run = await h.orchestration.getOrCreateRun({ kind: "full", trigger: "api", options: {} });
    const units = h.unitsOf(run.id);
    assert.ok(units.length > 100, "a cold plan really is hundreds of units");
    // One createMany for the units, not one round trip each: the enqueue transaction holds a
    // fixed number of statements however big the plan gets.
    assert.deepEqual(h.createManyCalls, [units.length]);
    assert.ok(units.every((u) => u.status === "PENDING" && u.correlationId === run.id));
    assert.deepEqual(
      units.map((u) => u.priority).sort((a, b) => a - b),
      units.map((_, i) => i + 1),
      "sequences are contiguous across the batch",
    );
  });
});

describe("the worker forwards the bounded scope and still does exactly one unit", () => {
  it("passes sourceObject, window and companions verbatim, with promotion off", async () => {
    const h = harness();
    const run = await h.orchestration.createRun({
      kind: "full",
      trigger: "api",
      options: { promoteAfter: true },
      units: [
        { kind: UNIT_KINDS.NETWORK, platform: "impact", accountLabel: "default", sourceObject: "actions", windowStart: "2026-08-17", windowEnd: "2026-09-15", sourceObjectCompanions: ["reports"], options: { fastSync: true } },
        { kind: UNIT_KINDS.NETWORK, platform: "impact", accountLabel: "default", sourceObject: "catalogs", options: {} },
      ],
    });
    const res = await h.worker();
    assert.equal(res.body.worked, true);
    assert.equal(h.calls.length, 1, "exactly one unit per invocation");
    assert.deepEqual(h.calls[0], {
      platform: "impact",
      accountLabel: "default",
      options: {
        fastSync: true,
        promoteAfter: false,
        sourceObject: "actions",
        windowStart: "2026-08-17",
        windowEnd: "2026-09-15",
        sourceObjectCompanions: ["reports"],
      },
    });
    assert.deepEqual(res.body.unit.window, { start: "2026-08-17", end: "2026-09-15" });
    assert.equal(res.body.unit.sourceObject, "actions");

    // The next invocation does the NEXT unit, one at a time.
    const second = await h.worker();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].options.sourceObject, "catalogs");
    assert.equal(h.calls[1].options.windowStart, undefined, "a catalog object carries no window");
    assert.equal(second.body.unit.window, null);
    assert.equal(h.unitsOf(run.id).filter((u) => u.status === "COMPLETED").length, 2);
  });

  it("a pre-Phase-5 account-wide unit is still readable and executable", async () => {
    const h = harness();
    // Exactly the descriptor shape an existing run (c9e3e699) already carries: no sourceObject,
    // no window. It must keep running the whole account, as it always did.
    const run = await h.orchestration.createRun({
      kind: "full",
      trigger: "api",
      options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", options: { fastSync: false } }],
    });
    const stored = h.unitsOf(run.id)[0];
    assert.equal(stored.payload.sourceObject, undefined);
    assert.equal(isUnitExecutable(stored), true, "an old descriptor is not refused");

    const res = await h.worker();
    assert.equal(res.body.worked, true);
    assert.deepEqual(h.calls[0].options, { fastSync: false, promoteAfter: false, sourceObject: undefined });
    assert.equal("windowStart" in h.calls[0].options, false, "no window is invented for an old unit");

    const summary = (await h.orchestration.inspectRun(run.id)).units[0];
    assert.equal(summary.sourceObject, null);
    assert.equal(summary.window, null);
  });

  it("durable status shows the source object and the window boundaries", async () => {
    const h = harness();
    const run = await h.orchestration.createRun({
      kind: "full",
      trigger: "api",
      options: { promoteAfter: false },
      units: [{ kind: UNIT_KINDS.NETWORK, platform: "boostiny", accountLabel: "default", sourceObject: "api_reports", windowStart: "2026-09-02", windowEnd: "2026-09-15", options: {} }],
    });
    const summary = (await h.orchestration.inspectRun(run.id)).units[0];
    assert.equal(summary.sourceObject, "api_reports");
    assert.deepEqual(summary.window, { start: "2026-09-02", end: "2026-09-15" });
    assert.equal(summary.lockKey, "network:boostiny:default");
  });
});

describe("nothing is silently widened", () => {
  it("commission groups are deferred for later materialisation, never excluded", async () => {
    const { units, exclusions, deferred } = await planFor();
    // Not planned at enqueue time — the campaign slice is not knowable yet…
    assert.ok(!units.some((u) => u.sourceObject === "commission_groups"));
    // …and NOT dropped: nothing about this run is excluded at all any more.
    assert.deepEqual(exclusions, []);
    const optimise = deferred.filter((d) => d.platform === "optimise_sea" && d.accountLabel === "default");
    assert.deepEqual(optimise, [
      { platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", after: "campaigns" },
    ]);
    // One deferral per Optimise ACCOUNT, and none for any other network.
    assert.equal(deferred.length, 2, "one per connected Optimise account: sea/default and sea/second");
    assert.ok(deferred.every((d) => d.platform.startsWith("optimise")));
    // No account is left with an unbounded account-wide unit in its place.
    assert.ok(!units.some((u) => u.platform.startsWith("optimise") && !u.sourceObject));
  });

  it("the run records the work it has not planned yet, and status reports it", async () => {
    const h = harness();
    const run = await h.orchestration.getOrCreateRun({ kind: "full", trigger: "api", options: {} });
    const parent = h.rows.find((r) => r.id === run.id);
    assert.equal(parent.payload.excludedSources, undefined, "nothing is excluded");
    assert.ok(parent.payload.deferredSources.length > 0);
    assert.ok(parent.payload.deferredSources.every((d) => d.sourceObject === "commission_groups" && d.after === "campaigns"));
    const status = await h.orchestration.describeRun(run.id);
    assert.deepEqual(status.excludedSources, []);
    assert.deepEqual(status.deferredSources, parent.payload.deferredSources);
    // Deferred work is not a blocked unit: it must not hold the run open for ever.
    assert.equal(status.blockedUnits, 0);
    assert.equal(parent.payload.postSyncStages, "deferred", "post-sync deferral is a separate thing");
  });

  it("a half-supplied window is refused rather than widened to the default lookback", async () => {
    await runWithSyncOptions({ windowStart: "2026-09-01" }, async () => {
      assert.throws(() => explicitSyncWindow(), /both windowStart and windowEnd/);
    });
    await runWithSyncOptions({ windowEnd: "2026-09-01" }, async () => {
      assert.throws(() => explicitSyncWindow(), /both windowStart and windowEnd/);
    });
    await runWithSyncOptions({ windowStart: "2026-09-10", windowEnd: "2026-09-01" }, async () => {
      assert.throws(() => explicitSyncWindow(), /ends before it starts/);
    });
    await runWithSyncOptions({ windowStart: "zznotadatezz", windowEnd: "2026-09-01" }, async () => {
      assert.throws(() => explicitSyncWindow(), /unparseable/);
    });
    // No window at all is the ordinary case: manual routes, the scheduler and the canary.
    await runWithSyncOptions({ fastSync: true }, async () => {
      assert.equal(explicitSyncWindow(), null);
    });
    await runWithSyncOptions({ windowStart: "2026-09-01", windowEnd: "2026-09-14" }, async () => {
      assert.deepEqual(explicitSyncWindow(), { start: "2026-09-01", end: "2026-09-14" });
    });
  });

  it("Boostiny, Optimise and Trackier take the bounded window over env AND over the incremental fallback", async () => {
    const WINDOW = { windowStart: "2026-09-08", windowEnd: "2026-09-14" };
    const longAgo = new Date("2020-01-01T00:00:00.000Z");
    const env = {
      BOOSTINY_REPORT_FROM: "2019-01-01", BOOSTINY_REPORT_TO: "2019-12-31",
      OPTIMISE_CONVERSIONS_FROM: "2019-01-01", OPTIMISE_CONVERSIONS_TO: "2019-12-31",
      TRACKIER_SYNC_FROM: "2019-01-01", TRACKIER_SYNC_TO: "2019-12-31",
    };
    const saved = {};
    for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
    try {
      await runWithSyncOptions(WINDOW, async () => {
        assert.deepEqual(getBoostinyReportRange(longAgo), { from: "2026-09-08", to: "2026-09-14" });
        const optimise = getOptimiseDateRange(longAgo);
        assert.equal(optimise.fromDate, "2026-09-08");
        assert.equal(optimise.toDate, "2026-09-14");
        assert.ok(optimise.dateField, "the date field is untouched by windowing");
        assert.deepEqual(getTrackierDateRange(longAgo), { start: "2026-09-08", end: "2026-09-14" });
      });
      // Without a window the existing env override still wins, exactly as before.
      assert.deepEqual(getBoostinyReportRange(longAgo), { from: "2019-01-01", to: "2019-12-31" });
      assert.deepEqual(getTrackierDateRange(longAgo), { start: "2019-01-01", end: "2019-12-31" });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("Impact, Partnerize and Awin build their request params from the bounded window", () => {
    for (const [name, params] of [
      ["impactWindow", "StartDate: impactWindow.start, EndDate: impactWindow.end"],
      ["partnerizeWindow", "start_date: partnerizeWindow.start, end_date: partnerizeWindow.end"],
      ["awinWindow", "startDate: clampAwinWindowStart(awinWindow), endDate: awinWindow.end"],
    ]) {
      assert.ok(WAVE_E_SRC.includes(`const ${name} = explicitSyncWindow();`), name);
      assert.ok(WAVE_E_SRC.includes(params), params);
    }
    assert.ok(SYNC_JOB_SRC.includes("if (bounded) return { from: bounded.start, to: bounded.end };"));
    assert.ok(SYNC_JOB_SRC.includes("if (bounded) return { start: bounded.start, end: bounded.end };"));
  });

  it("a supplied window is honoured by each network, and never widened past a supplier cap", () => {
    // Admitad: forwarded as the explicit status_updated range the builder already supports, and
    // applied last so an env override cannot widen a bounded unit.
    const admitad = buildAdmitadIncrementalActionParams({
      lastSuccessfulSync: new Date("2020-01-01T00:00:00Z"),
      explicit: { status_updated_start: "2026-09-08", status_updated_end: "2026-09-15" },
    });
    // The builder formats the range in the adapter's own parameter format; only the DAYS are
    // asserted here, because the format is the adapter's contract and not this phase's business.
    assert.match(admitad.status_updated_start, /08\.09\.2026/);
    assert.match(admitad.status_updated_end, /15\.09\.2026/);

    // Rakuten events: honoured, then clamped to the 30 days the supplier keeps.
    const events = buildRakutenEventWindow({ window: { start: "2026-09-01", end: "2026-09-15" } });
    assert.match(events.process_date_start, /^2026-09-01/);
    assert.match(events.process_date_end, /^2026-09-15/);
    const tooWide = buildRakutenEventWindow({ window: { start: "2025-01-01", end: "2026-09-15" } });
    assert.match(tooWide.process_date_start, /^2026-08-16/, "clamped to the supplier's 30-day limit");

    // Rakuten payment history: the window replaces the fixed 180-day pull.
    assert.deepEqual(buildRakutenPaymentHistoryWindow({ window: { start: "2026-08-17", end: "2026-09-15" } }), {
      bdate: "20260817",
      edate: "20260915",
    });

    // Awin: the supplier refuses a range wider than 31 days.
    assert.equal(clampAwinWindowStart({ start: "2026-08-17", end: "2026-09-15" }), "2026-08-17");
    assert.equal(clampAwinWindowStart({ start: "2025-01-01", end: "2026-09-15" }), "2026-08-16");
  });

  it("planned window sizes never exceed the supplier caps the audit recorded", () => {
    for (const platform of ["boostiny", "optimise_sea", "trackier", "impact", "partnerize", "awin", "admitad", "rakuten", "cj"]) {
      for (const source of planSourcesFor(platform)) {
        if (!source.windowed) {
          assert.equal(source.windowDays, null, `${platform}:${source.sourceObject}`);
          continue;
        }
        assert.ok(source.windowDays > 0, `${platform}:${source.sourceObject}`);
        assert.ok(
          source.windowDays <= (source.maxWindowDays ?? source.windowDays),
          `${platform}:${source.sourceObject} exceeds its supplier cap`,
        );
      }
    }
    // CJ's live path has no date-filtered source object at all — stated, not assumed.
    assert.ok(planSourcesFor("cj").every((s) => !s.windowed));
  });

  it("the audited window sizes are pinned, so a wider pull is a deliberate decision", () => {
    const sizes = {};
    for (const platform of ["boostiny", "optimise_sea", "trackier", "impact", "partnerize", "awin", "admitad", "rakuten", "cj"]) {
      for (const source of planSourcesFor(platform)) {
        if (source.windowed) sizes[`${platform}:${source.sourceObject}`] = source.windowDays;
      }
    }
    assert.deepEqual(sizes, {
      // 6s/request limiter.
      "boostiny:api_reports": 14,
      "boostiny:link_reports": 14,
      // 12.5s/request — the slowest supplier, so the shortest windows; finance objects are small.
      "optimise_sea:conversions": 7,
      "optimise_sea:reporting": 7,
      "optimise_sea:payment_overview": 30,
      "optimise_sea:invoices": 30,
      // 200–300ms.
      "trackier:conversions": 30,
      "trackier:tracking": 30,
      "impact:actions": 30,
      "partnerize:conversions": 30,
      "partnerize:payment_information": 30,
      // 3s/request, supplier cap 31 days.
      "awin:transactions": 30,
      "admitad:actions": 30,
      // Rakuten keeps ~30 days of events; payment history fans out per payment.
      "rakuten:events": 14,
      "rakuten:advanced_reports": 30,
    });
  });

  it("the worker never runs promotion for a bounded unit", () => {
    const worker = CONTROLLER_SRC.split("export async function triggerSyncWorker(")[1].split("\n}\n")[0];
    assert.match(worker, /promoteAfter: false/);
    assert.ok(!worker.includes("promoteAfter: true"));
    assert.ok(!/setTimeout|setInterval|void \(async/.test(worker), "no background promise, no loop");
  });
});
