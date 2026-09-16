/**
 * Optimise campaigns as bounded slices of the supplier's own paging.
 *
 * Phase 5 split work by source object and date window, but the campaign catalog stayed one
 * unbounded unit: fetchOffsetPaginated walks every page, and each page waits 12.5s on the shared
 * Optimise limiter, so the pacing MULTIPLIES across pagination. A 300s invocation affords ~24
 * requests, and production run 0991cd7f sequence 5 died on exactly that.
 *
 * A campaigns unit now names one slice — offset, page size, page budget — and completing it plans
 * the next slice while the supplier says there is more. A retry reruns that slice and nothing else.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { triggerSyncWorker } from "../src/controllers/sync.controller.js";
import {
  UNIT_JOB_NAME,
  UNIT_KINDS,
  PLANNER_VERSION,
  SyncOrchestrationService,
  buildSyncPlan,
} from "../src/jobs/syncOrchestration.service.js";
import {
  OPTIMISE_CAMPAIGN_PAGES_PER_UNIT,
  OPTIMISE_CAMPAIGN_PAGE_LIMIT,
  nextPagedUnit,
  planSourcesFor,
} from "../src/jobs/syncSourcePlan.js";
import { boundedCampaignPage, runWithSyncOptions } from "../src/jobs/syncContext.js";
import { accountLockKey } from "../src/jobs/syncAccountLock.service.js";

const ADAPTER_SRC = readFileSync(new URL("../src/adapters/optimise.adapter.js", import.meta.url), "utf8");
const SERVICE_SRC = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");
const SYNC_JOB_SRC = readFileSync(new URL("../src/jobs/sync.job.js", import.meta.url), "utf8");

const NOW = new Date("2026-09-15T00:00:00.000Z");
const now = () => NOW;
const PAGES = OPTIMISE_CAMPAIGN_PAGES_PER_UNIT;
const LIMIT = OPTIMISE_CAMPAIGN_PAGE_LIMIT;
const SLICE = PAGES * LIMIT;

function createStore() {
  const rows = [];
  let seq = 0;
  const clone = (r) => JSON.parse(JSON.stringify(r));
  const apply = (row, data) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
      else row[k] = v;
    }
  };
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
  const jobRun = {
    async create({ data }) {
      seq += 1;
      const row = { id: `row-${String(seq).padStart(4, "0")}`, status: "PENDING", priority: 100, attempt: 0, maxAttempts: 3, progress: 0, payload: null, result: null, lastError: null, correlationId: null, startedAt: null, completedAt: null, createdAt: new Date(NOW.getTime() + seq), ...data };
      rows.push(row); return clone(row);
    },
    async createMany({ data }) { for (const row of data) await jobRun.create({ data: row }); return { count: data.length }; },
    async update({ where, data }) { const row = rows.find((r) => r.id === where.id); apply(row, data); return clone(row); },
    async updateMany({ where, data }) { let count = 0; for (const row of rows) if (match(row, where)) { apply(row, data); count += 1; } return { count }; },
    async deleteMany({ where }) { let count = 0; for (let i = rows.length - 1; i >= 0; i -= 1) if (match(rows[i], where)) { rows.splice(i, 1); count += 1; } return { count }; },
    async findUnique({ where }) { const row = rows.find((r) => r.id === where.id); return row ? clone(row) : null; },
    async findFirst({ where, orderBy }) { const list = sort(rows.filter((r) => match(r, where)), orderBy); return list.length ? clone(list[0]) : null; },
    async findMany({ where, orderBy }) { return sort(rows.filter((r) => match(r, where ?? {})), orderBy).map(clone); },
  };
  return { rows, prisma: { jobRun, async $transaction(fn) { return fn({ jobRun }); } } };
}

/**
 * A sync stand-in that answers like the real Optimise account sync: it reports the slice it
 * covered and whether the supplier has more, from a fixed catalog size.
 */
function harness({ totalCampaigns = 0, failOffsets = new Set(), chunkPlan = null } = {}) {
  // `failOffsets` is the live Set the stand-in consults, so a test can clear an entry mid-run.
  const { rows, prisma } = createStore();
  const calls = [];
  const orchestration = new SyncOrchestrationService({
    prisma, now,
    listAccounts: async () => ["default"],
    loadAccountState: async () => ({ lastSuccessfulSync: null }),
    planCommissionGroupChunks: chunkPlan ?? (async () => ({ chunks: [], campaignIds: [] })),
  });
  const locals = {
    syncOrchestration: orchestration,
    syncPlatformAccount: async (platform, accountLabel, options) => {
      calls.push({ platform, accountLabel, options });
      if (options.sourceObject !== "campaigns" || options.campaignPageOffset === undefined) {
        return { sea: { [accountLabel ?? "default"]: { campaigns: 0 } } };
      }
      if (failOffsets.has(options.campaignPageOffset)) throw new Error("zzpagefailedzz");
      const offset = options.campaignPageOffset;
      const size = options.campaignPageLimit * options.campaignPageBudget;
      const rowsFetched = Math.max(0, Math.min(size, totalCampaigns - offset));
      const hasMore = offset + size < totalCampaigns;
      return {
        sea: {
          [accountLabel ?? "default"]: {
            campaigns: rowsFetched,
            campaignPage: {
              offset,
              pagesFetched: Math.max(1, Math.ceil(rowsFetched / options.campaignPageLimit)),
              rowsFetched,
              nextOffset: hasMore ? offset + size : null,
              hasMore,
            },
          },
        },
      };
    },
  };
  const worker = async () => {
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await triggerSyncWorker({ app: { locals } }, res, (error) => { throw error; });
    return res;
  };
  const unitsOf = (runId) => rows.filter((r) => r.jobName === UNIT_JOB_NAME && r.correlationId === runId);
  const campaignUnits = (runId) => unitsOf(runId).filter((u) => u.payload.sourceObject === "campaigns");
  // Exposed so a test can clear an injected failure and prove the RETRY succeeds.
  return { rows, prisma, orchestration, calls, worker, unitsOf, campaignUnits, failOffsets };
}

async function runWithCampaigns(h) {
  return h.orchestration.createRun({
    kind: "full", trigger: "api", options: { promoteAfter: false },
    units: [{
      kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "campaigns",
      campaignPageIndex: 0, campaignPageOffset: 0, campaignPageLimit: LIMIT, campaignPageBudget: PAGES,
      options: {},
    }],
  });
}

describe("the catalog is walked in bounded slices", () => {
  it("the plan starts at offset 0 with a named page budget", async () => {
    const { units } = await buildSyncPlan({
      kind: "full", promoteAfter: true, now: NOW,
      listAccounts: async (p) => (p === "optimise_sea" ? ["default"] : []),
      loadAccountState: async () => ({ lastSuccessfulSync: null }),
    });
    const campaigns = units.filter((u) => u.platform === "optimise_sea" && u.sourceObject === "campaigns");
    assert.equal(campaigns.length, 1, "only the first slice is knowable at plan time");
    assert.deepEqual(
      { i: campaigns[0].campaignPageIndex, o: campaigns[0].campaignPageOffset, l: campaigns[0].campaignPageLimit, b: campaigns[0].campaignPageBudget },
      { i: 0, o: 0, l: LIMIT, b: PAGES },
    );
    // Other networks' campaigns are untouched by this change.
    assert.ok(units.every((u) => u.platform === "optimise_sea" || u.campaignPageOffset === undefined));
  });

  it("the page budget is a named constant sized from the 12.5s limiter", () => {
    assert.equal(OPTIMISE_CAMPAIGN_PAGES_PER_UNIT, 8);
    assert.equal(OPTIMISE_CAMPAIGN_PAGE_LIMIT, 100);
    // 8 pages x 12.5s is ~87.5s of pacing — well inside a 300s invocation, unlike 24+ pages.
    assert.ok(OPTIMISE_CAMPAIGN_PAGES_PER_UNIT * 12.5 < 120);
    assert.ok(planSourcesFor("optimise_sea").find((s) => s.sourceObject === "campaigns").paged);
    assert.ok(!planSourcesFor("boostiny").find((s) => s.sourceObject === "campaigns").paged);
  });

  it("a catalog spanning several slices is walked one slice per invocation", async () => {
    const h = harness({ totalCampaigns: SLICE * 2 + 5 });
    const run = await runWithCampaigns(h);

    const first = await h.worker();
    assert.equal(first.body.worked, true);
    assert.deepEqual(first.body.unit.campaignPage, { index: 0, offset: 0, limit: LIMIT, pages: PAGES });
    assert.equal(h.campaignUnits(run.id).length, 2, "the next slice is planned, not walked now");
    assert.equal(h.calls.length, 1, "exactly one unit per invocation");

    const second = await h.worker();
    assert.equal(second.body.unit.campaignPage.offset, SLICE);
    assert.equal(second.body.unit.campaignPage.index, 1);
    assert.equal(h.campaignUnits(run.id).length, 3);

    const third = await h.worker();
    assert.equal(third.body.unit.campaignPage.offset, SLICE * 2);
    assert.equal(h.campaignUnits(run.id).length, 3, "the last slice plans no successor");

    const done = await h.worker();
    assert.equal(done.body.worked, false);
    assert.equal(done.body.status, "idle");
    // Offsets are contiguous, ascending and requested exactly once each.
    const offsets = h.calls.map((c) => c.options.campaignPageOffset);
    assert.deepEqual(offsets, [0, SLICE, SLICE * 2]);
    assert.equal(new Set(offsets).size, offsets.length);
  });

  it("a catalog that fits one slice plans no successor", async () => {
    const h = harness({ totalCampaigns: SLICE - 1 });
    const run = await runWithCampaigns(h);
    await h.worker();
    assert.equal(h.campaignUnits(run.id).length, 1);
    assert.equal(h.calls.length, 1);
  });

  it("zero campaigns is one slice and nothing more", async () => {
    const h = harness({ totalCampaigns: 0 });
    const run = await runWithCampaigns(h);
    const res = await h.worker();
    assert.equal(res.body.worked, true);
    assert.equal(h.campaignUnits(run.id).length, 1, "an empty catalog never chains");
    assert.equal((await h.worker()).body.status, "idle");
  });

  it("the continuation rule is total: it stops exactly when the supplier says so", () => {
    const descriptor = { platform: "optimise_sea", sourceObject: "campaigns", campaignPageIndex: 0, campaignPageOffset: 0, campaignPageLimit: LIMIT, campaignPageBudget: PAGES };
    assert.equal(nextPagedUnit(descriptor, { hasMore: false, nextOffset: null }), null);
    assert.equal(nextPagedUnit(descriptor, null), null);
    // A supplier answer that would not advance is refused rather than looping on one offset.
    assert.equal(nextPagedUnit(descriptor, { hasMore: true, nextOffset: 0 }), null);
    assert.equal(nextPagedUnit(descriptor, { hasMore: true, nextOffset: "nonsense" }), null);
    assert.deepEqual(nextPagedUnit(descriptor, { hasMore: true, nextOffset: SLICE }), {
      campaignPageIndex: 1, campaignPageOffset: SLICE, campaignPageLimit: LIMIT, campaignPageBudget: PAGES,
    });
    // Only a paged source chains.
    assert.equal(nextPagedUnit({ ...descriptor, sourceObject: "conversions" }, { hasMore: true, nextOffset: SLICE }), null);
    assert.equal(nextPagedUnit({ ...descriptor, platform: "boostiny" }, { hasMore: true, nextOffset: SLICE }), null);
  });
});

describe("a retry reruns one slice", () => {
  it("a failed slice is retried at its own offset, and the walk resumes from there", async () => {
    const h = harness({ totalCampaigns: SLICE * 2 + 1, failOffsets: new Set([SLICE]) });
    const run = await runWithCampaigns(h);
    await h.worker();                       // offset 0 succeeds, plans offset SLICE
    const failed = await h.worker();        // offset SLICE throws
    assert.equal(failed.body.worked, true);
    assert.equal(failed.body.status, "unit_retry");
    assert.equal(failed.body.unit.campaignPage.offset, SLICE);

    const row = h.campaignUnits(run.id).find((u) => u.payload.campaignPageOffset === SLICE);
    assert.equal(row.status, "PENDING", "retryable");
    assert.equal(row.payload.campaignPageOffset, SLICE, "the slice is stored, so a retry cannot drift");
    assert.equal(h.campaignUnits(run.id).length, 2, "a failure plans no successor");

    h.failOffsets.delete(SLICE);
    const retried = await h.worker();
    assert.equal(retried.body.status, "unit_completed", "the retry really succeeds");
    assert.equal(retried.body.unit.campaignPage.offset, SLICE, "the retry reruns only that slice");
    assert.deepEqual(h.calls.map((c) => c.options.campaignPageOffset), [0, SLICE, SLICE]);
    assert.equal(h.calls.filter((c) => c.options.campaignPageOffset === 0).length, 1, "offset 0 is never re-walked");
    // Only now does the walk resume past the slice that failed.
    assert.equal(h.campaignUnits(run.id).length, 3);
    const last = await h.worker();
    assert.equal(last.body.unit.campaignPage.offset, SLICE * 2);
    assert.equal(h.campaignUnits(run.id).length, 3, "and the catalog ends there");
  });

  it("a repeated completion of the same slice does not double-plan its successor", async () => {
    const h = harness({ totalCampaigns: SLICE * 2 + 1 });
    const run = await runWithCampaigns(h);
    const unit = h.campaignUnits(run.id)[0];
    const outcome = { sea: { default: { campaigns: SLICE, campaignPage: { offset: 0, nextOffset: SLICE, hasMore: true } } } };
    const opts = { completingUnitId: unit.id };

    await h.orchestration.materialiseFollowOnUnits(run.id, unit.payload, outcome, opts);
    const again = await h.orchestration.materialiseFollowOnUnits(run.id, unit.payload, outcome, opts);
    assert.equal(again.appended, 0);
    assert.equal(h.campaignUnits(run.id).length, 2);

    // And two workers racing on the same completion still produce one successor.
    const racy = await Promise.all([
      h.orchestration.materialiseFollowOnUnits(run.id, unit.payload, outcome, opts),
      h.orchestration.materialiseFollowOnUnits(run.id, unit.payload, outcome, opts),
    ]);
    assert.equal(racy.reduce((sum, r) => sum + r.appended, 0), 0);
    assert.equal(h.campaignUnits(run.id).length, 2, "one unit per offset, whatever the race");
    const offsets = h.campaignUnits(run.id).map((u) => u.payload.campaignPageOffset);
    assert.equal(new Set(offsets).size, offsets.length);
  });

  it("every slice of the account takes the same account lock", async () => {
    const h = harness({ totalCampaigns: SLICE * 2 + 1 });
    const run = await runWithCampaigns(h);
    await h.worker();
    const slices = h.campaignUnits(run.id);
    assert.equal(slices.length, 2);
    const expected = accountLockKey({ platform: "optimise_sea", accountLabel: "default" });
    assert.deepEqual([...new Set(slices.map((u) => u.payload.lockKey))], [expected]);
    assert.ok(slices.every((u) => !String(u.payload.lockKey).includes("offset")));
  });
});

describe("commission groups wait for the whole catalog", () => {
  const chunkPlan = async () => ({ chunks: [{ index: 0, campaignIds: ["c1"] }], campaignIds: ["c1"] });
  const commissionUnits = (h, runId) =>
    h.unitsOf(runId).filter((u) => u.payload.sourceObject === "commission_groups");

  it("no commission chunk is planned while another campaign slice is outstanding", async () => {
    const h = harness({ totalCampaigns: SLICE * 2 + 1, chunkPlan });
    const run = await runWithCampaigns(h);

    await h.worker();
    assert.equal(commissionUnits(h, run.id).length, 0, "slice 1 of 3 — the catalog is not staged yet");
    await h.worker();
    assert.equal(commissionUnits(h, run.id).length, 0, "slice 2 of 3");
    await h.worker();
    assert.equal(commissionUnits(h, run.id).length, 1, "only once the last slice settles");
  });

  it("an outstanding sibling slice defers commission groups even on the final slice", async () => {
    const h = harness({ totalCampaigns: SLICE, chunkPlan });
    const run = await runWithCampaigns(h);
    // A second campaigns slice is still PENDING (another worker's work).
    await h.orchestration.appendUnits(run.id, [{
      kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "campaigns",
      campaignPageIndex: 9, campaignPageOffset: SLICE * 9, campaignPageLimit: LIMIT, campaignPageBudget: PAGES, options: {},
    }]);
    const first = h.campaignUnits(run.id)[0];
    const result = await h.orchestration.materialiseFollowOnUnits(
      run.id, first.payload, { sea: { default: { campaigns: 1, campaignPage: { offset: 0, hasMore: false, nextOffset: null } } } },
      { completingUnitId: first.id },
    );
    assert.equal(result.appended, 0);
    assert.equal(result.waitingOnUnits, 1, "it names what it is waiting for");
    assert.equal(commissionUnits(h, run.id).length, 0);
  });

  it("zero campaigns still resolves the deferred commission groups", async () => {
    const h = harness({ totalCampaigns: 0, chunkPlan: async () => ({ chunks: [], campaignIds: [] }) });
    const run = await h.orchestration.createRun({
      kind: "full", trigger: "api", options: { promoteAfter: false },
      units: [{
        kind: UNIT_KINDS.NETWORK, platform: "optimise_sea", accountLabel: "default", sourceObject: "campaigns",
        campaignPageIndex: 0, campaignPageOffset: 0, campaignPageLimit: LIMIT, campaignPageBudget: PAGES, options: {},
      }],
    });
    const parent = h.rows.find((r) => r.id === run.id);
    parent.payload = { ...parent.payload, deferredSources: [{ platform: "optimise_sea", accountLabel: "default", sourceObject: "commission_groups", after: "campaigns" }] };

    await h.worker();
    const status = await h.orchestration.describeRun(run.id);
    assert.deepEqual(status.deferredSources.map((d) => ({ status: d.status, units: d.units })), [
      { status: "materialised", units: 0 },
    ]);
    assert.equal(status.deferredPending, false);
    assert.equal(status.status, "success", "the run settles normally");
  });
});

describe("what a slice exposes", () => {
  it("status shows the slice window and no supplier payload", async () => {
    const h = harness({ totalCampaigns: SLICE * 2 });
    const run = await runWithCampaigns(h);
    await h.worker();
    const summaries = (await h.orchestration.inspectRun(run.id)).units;
    assert.deepEqual(summaries.map((u) => u.campaignPage), [
      { index: 0, offset: 0, limit: LIMIT, pages: PAGES },
      { index: 1, offset: SLICE, limit: LIMIT, pages: PAGES },
    ]);
    const serialised = JSON.stringify(summaries);
    for (const leak of ["apiKey", "contactId", "agencyId", "rawData", "publishers", "campaignId"]) {
      assert.ok(!serialised.includes(leak), leak);
    }
  });

  it("the worker forwards the slice verbatim and nothing else", async () => {
    const h = harness({ totalCampaigns: SLICE * 2 });
    await runWithCampaigns(h);
    await h.worker();
    assert.deepEqual(h.calls[0].options, {
      fastSync: false,
      promoteAfter: false,
      sourceObject: "campaigns",
      campaignPageOffset: 0,
      campaignPageLimit: LIMIT,
      campaignPageBudget: PAGES,
    });
  });

  it("the sync layer reads the slice, and refuses an unusable one", async () => {
    await runWithSyncOptions({ campaignPageOffset: 400, campaignPageLimit: 100, campaignPageBudget: 8 }, async () => {
      assert.deepEqual(boundedCampaignPage(), { offset: 400, limit: 100, maxPages: 8 });
    });
    // No slice at all is the ordinary case: a manual sync walks the catalog as it always did.
    await runWithSyncOptions({ sourceObject: "campaigns" }, async () => {
      assert.equal(boundedCampaignPage(), null);
    });
    await runWithSyncOptions({ campaignPageOffset: -1 }, async () => {
      assert.throws(() => boundedCampaignPage(), /unusable offset/);
    });
  });
});

describe("source guards", () => {
  it("the bounded fetch uses the supplier's own offset paging and stops on a short page", () => {
    const fn = ADAPTER_SRC.split("async function fetchOffsetPage(")[1].split("\n}\n")[0];
    assert.match(fn, /params: \{ \.\.\.baseParams, offset: cursor, limit: size \}/, "the supplier's own paging");
    assert.match(fn, /if \(pageRows\.length < size\)/, "a short page is the last page, as the unbounded walk reads it");
    assert.match(fn, /while \(pagesFetched < budget\)/, "the walk is bounded by the page budget");
    assert.match(fn, /requestWithOptimiseLimits/, "still through the shared limiter; pacing is unchanged");
    // No synthetic partitioning of any kind.
    for (const forbidden of ["commission", "revenue", "amount", "currency"]) {
      assert.ok(!fn.includes(forbidden), forbidden);
    }
    // The unbounded walker is untouched, so every other Optimise resource behaves as before.
    assert.match(ADAPTER_SRC, /async function fetchOffsetPaginated\(/);
  });

  it("a bounded slice always fetches, whatever the campaign cache says", () => {
    assert.match(
      SYNC_JOB_SRC,
      /const refreshCampaigns = campaignPage \? true : shouldRefreshCampaigns\(/,
      "a cache gate must not silently drop a slice the run still needs",
    );
    assert.match(SYNC_JOB_SRC, /adapter\.fetchCampaignsPage\(campaignPage\)/);
    assert.match(SYNC_JOB_SRC, /: \(\) => adapter\.fetchCampaigns\(\)/, "unbounded callers keep the whole-catalog walk");
  });

  it("continuation is one appended unit, never a loop or a background promise", () => {
    const fn = SERVICE_SRC.split("  async materialiseFollowOnUnits(")[1].split("\n  }")[0];
    assert.match(fn, /const continuation = nextPagedUnit\(/);
    assert.match(fn, /return \{ \.\.\.appended, continued: true \};/, "one slice planned, then it returns");
    for (const forbidden of ["while (", "for (", "setTimeout", "setInterval", "void ("]) {
      assert.ok(!fn.includes(forbidden), forbidden);
    }
  });

  it("the planner version was bumped, because the unit shape changed", () => {
    assert.equal(PLANNER_VERSION, 6);
    assert.match(SERVICE_SRC, /\* 6 — Optimise campaigns became a PAGED source\./);
  });
});
