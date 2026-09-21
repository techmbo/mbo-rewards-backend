import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  AWIN_MATERIALIZATION_NETWORK_SOURCE,
  AWIN_MATERIALIZATION_PAGE_SIZE,
  AWIN_MATERIALIZATION_REFUSAL_CODE,
  awinMaterializationPageHasMore,
  executeAwinParentMaterializationUnit,
  nextAwinParentMaterializationUnit,
  resolveAwinMaterializationPage,
  summariseAwinParentMaterializationUnitOutcome,
} from "../src/jobs/awinParentMaterializationUnit.js";
import { UNIT_KINDS, isUnitExecutable } from "../src/jobs/syncOrchestration.service.js";
import {
  awinParentMaterializationRequired,
  planPostSyncTransition,
  walkState,
} from "../src/jobs/postSyncStages.js";
import { AwinAdvertiserParentService } from "../src/modules/supplier/services/awinAdvertiserParent.service.js";
import {
  AWIN_DURABLE_PROMOTION_REQUIRED,
  AWIN_UNBOUNDED_RUN_BUDGET,
  PromotionJob,
  assertAwinPromotionWithinBudget,
} from "../src/jobs/promotion.job.js";

/**
 * Phase 19 — the Awin parent walk as bounded durable units.
 *
 * The whole estate in one invocation is what produced the 300s timeout in production. These tests
 * pin the three properties that make the bounded shape correct: one page per unit, a keyset cursor
 * that survives a re-stage, and a stage barrier that will not let the campaign walk start early.
 */

const UNIT_SRC = readFileSync(new URL("../src/jobs/awinParentMaterializationUnit.js", import.meta.url), "utf8");
const SVC_SRC = readFileSync(
  new URL("../src/modules/supplier/services/awinAdvertiserParent.service.js", import.meta.url),
  "utf8",
);
const JOB_SRC = readFileSync(new URL("../src/jobs/promotion.job.js", import.meta.url), "utf8");
const codeOnly = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const unit = (over = {}) => ({
  kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION,
  networkSource: "awin",
  cursorId: null,
  pageSize: AWIN_MATERIALIZATION_PAGE_SIZE,
  ...over,
});

function offer(id, advertiserId, name = `Brand ${advertiserId}`) {
  return {
    id,
    networkSource: "awin",
    entityType: "coupon",
    rawData: { promotionId: Number(id.split("-").pop()), advertiser: { id: advertiserId, name } },
  };
}

/** In-memory Entity store honouring exactly the queries the service issues. */
function store(rows) {
  const queries = [];
  return {
    queries,
    rows,
    db: {
      entity: {
        findMany: async (query) => {
          queries.push(query);
          const where = query.where ?? {};
          let matched = rows.filter((row) => {
            if (where.networkSource && row.networkSource !== where.networkSource) return false;
            if (where.entityType && row.entityType !== where.entityType) return false;
            if (where.id?.gt && !(row.id > where.id.gt)) return false;
            if (where.externalId?.in && !where.externalId.in.includes(row.externalId)) return false;
            return true;
          });
          matched.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          return query.take ? matched.slice(0, query.take) : matched;
        },
      },
    },
  };
}

const PAGE = AWIN_MATERIALIZATION_PAGE_SIZE;

/**
 * The runner honours the pageSize the UNIT passes it. The unit's size is fixed — two units for the
 * same cursor must cover the same rows — so a harness that forced a different one would be testing
 * a page the production path can never produce.
 */
function pageRunner(rows) {
  const s = store(rows);
  const staged = [];
  const svc = new AwinAdvertiserParentService({
    db: s.db,
    stageEntities: async (args) => {
      staged.push(args);
      return { preparedRecords: [] };
    },
  });
  return { store: s, staged, run: (input) => svc.materializePage(input) };
}

/** `count` offers, each for its own advertiser unless `advertiserFor` says otherwise. */
function offers(count, advertiserFor = (i) => 1000 + i) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(offer(`e-${String(i).padStart(5, "0")}`, advertiserFor(i)));
  }
  return rows;
}

describe("Phase 19 — one bounded Awin materialization page per unit", () => {
  it("A. a unit processes exactly ONE page and stops", async () => {
    const runner = pageRunner(offers(PAGE * 3));

    const result = await executeAwinParentMaterializationUnit(unit(), { runPage: runner.run });

    assert.equal(result.offersScanned, PAGE, "one page, never the estate");
    assert.equal(result.advertisersFound, PAGE);
    assert.equal(result.parentsStaged, PAGE);
    assert.equal(result.lastCursor, `e-${String(PAGE - 1).padStart(5, "0")}`);
    assert.equal(result.hasMore, true);
    assert.equal(runner.staged.length, 1, "one staging call for one page");
  });

  it("B. nothing on the unit path loops, recurses or detaches a promise", () => {
    const source = codeOnly(UNIT_SRC);
    for (const forbidden of ["for (", "for(", "while (", "while(", "setTimeout", "setInterval", ".then(", "Promise.all"]) {
      assert.ok(!source.includes(forbidden), `${forbidden} in the unit module`);
    }
    const page = codeOnly(SVC_SRC).split("async materializePage(")[1].split("\n  }")[0];
    assert.ok(!page.includes("while ("), "materializePage drains");
    assert.ok(!page.includes("materializePage("), "materializePage recurses");
    assert.equal((page.match(/entity\.findMany\(/g) ?? []).length, 1, "more than one page fetched");
    // The drain still exists for tests and ops, but nothing in src/ may call it.
    assert.ok(!codeOnly(UNIT_SRC).includes(".materialize()"), "the unit reaches the drain");
  });

  it("C. a full page appends exactly one continuation, carrying its last id", async () => {
    const runner = pageRunner(offers(PAGE + 1));
    const result = await executeAwinParentMaterializationUnit(unit(), { runPage: runner.run });

    const next = nextAwinParentMaterializationUnit(result, { kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION });
    assert.deepEqual(next, {
      kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION,
      networkSource: "awin",
      cursorId: `e-${String(PAGE - 1).padStart(5, "0")}`,
      pageSize: AWIN_MATERIALIZATION_PAGE_SIZE,
      options: {},
    });
    // And exactly one: calling it again from the same result yields the same single unit.
    assert.deepEqual(nextAwinParentMaterializationUnit(result, { kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION }), next);
  });

  it("D. a short final page appends no continuation", async () => {
    const runner = pageRunner(offers(2));
    const result = await executeAwinParentMaterializationUnit(unit(), { runPage: runner.run });

    assert.equal(result.hasMore, false);
    assert.equal(result.nextCursor, null);
    assert.equal(nextAwinParentMaterializationUnit(result, { kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION }), null);
  });

  it("an empty walk resolves immediately and stages nothing", async () => {
    const runner = pageRunner([]);
    const result = await executeAwinParentMaterializationUnit(unit(), { runPage: runner.run });
    assert.equal(result.offersScanned, 0);
    assert.equal(result.hasMore, false);
    assert.equal(runner.staged.length, 0);
  });

  it("E. the id-keyset cursor resumes exactly after the previous page", async () => {
    const runner = pageRunner(offers(PAGE * 2 + 1));

    const first = await executeAwinParentMaterializationUnit(unit(), { runPage: runner.run });
    const second = await executeAwinParentMaterializationUnit(unit({ cursorId: first.lastCursor }), {
      runPage: runner.run,
    });
    const third = await executeAwinParentMaterializationUnit(unit({ cursorId: second.lastCursor }), {
      runPage: runner.run,
    });

    assert.deepEqual(
      [first.offersScanned, second.offersScanned, third.offersScanned],
      [PAGE, PAGE, 1],
      "every offer seen exactly once across the walk",
    );
    assert.equal(third.hasMore, false);

    const scanQueries = runner.store.queries.filter((q) => q.where.entityType === "coupon");
    assert.equal(scanQueries[0].where.id, undefined, "the first page starts with no cursor");
    assert.deepEqual(
      scanQueries[1].where.id,
      { gt: `e-${String(PAGE - 1).padStart(5, "0")}` },
      "strictly greater than, never gte",
    );
    assert.deepEqual(scanQueries[1].orderBy, { id: "asc" }, "ordered by id alone");
    assert.equal(scanQueries[1].cursor, undefined, "no Prisma cursor positioning");
    assert.equal(scanQueries[1].skip, undefined, "no skip");
  });

  it("F. a row re-staged between pages cannot move the boundary", async () => {
    const rows = offers(PAGE + 5);
    const runner = pageRunner(rows);

    const first = await executeAwinParentMaterializationUnit(unit(), { runPage: runner.run });
    // Re-stage a row from page one: its updatedAt would move, its PRIMARY KEY cannot.
    rows[0].rawData = { ...rows[0].rawData, restaged: true };
    const second = await executeAwinParentMaterializationUnit(unit({ cursorId: first.lastCursor }), {
      runPage: runner.run,
    });

    const seen = [...runner.staged.flatMap((call) => call.rows.map((r) => r.advertiserId))];
    assert.equal(seen.length, new Set(seen).size, "no advertiser repeated across pages");
    assert.equal(first.offersScanned + second.offersScanned, PAGE + 5, "no offer skipped");
  });

  it("G. an advertiser spanning two pages yields one Entity id, not two", async () => {
    // Every offer belongs to ONE advertiser, and there are more than a page of them, so the
    // advertiser is necessarily seen by both pages.
    const runner = pageRunner(offers(PAGE + 10, () => 777));

    const first = await executeAwinParentMaterializationUnit(unit(), { runPage: runner.run });
    await executeAwinParentMaterializationUnit(unit({ cursorId: first.lastCursor }), { runPage: runner.run });

    const staged = runner.staged.flatMap((call) => call.rows);
    assert.equal(staged.length, 2, "each page stages the advertiser it saw");
    assert.equal(new Set(staged.map((r) => r.advertiserId)).size, 1);
    assert.equal(new Set(staged.map((r) => r.id)).size, 1, "one identity, so one Entity");
  });

  it("H. the programme-backed guard still refuses to overwrite real evidence", async () => {
    const rows = [
      offer("e-00001", 500),
      offer("e-00002", 501),
      {
        id: "c-1",
        networkSource: "awin",
        entityType: "campaign",
        externalId: "awin-campaign-500",
        rawData: { id: 500, name: "Real Programme", status: "joined", currencyCode: "GBP" },
      },
    ];
    const runner = pageRunner(rows);
    const result = await executeAwinParentMaterializationUnit(unit(), { runPage: runner.run });

    assert.equal(result.skippedProgrammeBacked, 1);
    assert.equal(result.parentsStaged, 1);
    assert.deepEqual(runner.staged[0].rows.map((r) => r.advertiserId), ["501"]);
  });

  it("I. the guard query is bounded to the page's advertisers and is never a full scan", async () => {
    const runner = pageRunner([offer("e-00001", 900), offer("e-00002", 901)]);
    await executeAwinParentMaterializationUnit(unit(), { runPage: runner.run });

    const guard = runner.store.queries.find((q) => q.where.entityType === "campaign");
    assert.ok(guard, "the guard ran");
    assert.ok(Array.isArray(guard.where.externalId?.in), "scoped by an explicit id list");
    assert.deepEqual(
      guard.where.externalId.in.sort(),
      ["900", "901", "awin-campaign-900", "awin-campaign-901"],
      "both externalId shapes, and only this page's advertisers",
    );
    assert.equal(guard.select.rawData, true, "record_source lives in rawData and nowhere else");
    // The defect this replaces: an unbounded findMany over every Awin campaign Entity.
    const guardSrc = codeOnly(SVC_SRC).split("async programmeBackedAdvertiserIds(")[1].split("\n  }")[0];
    assert.ok(guardSrc.includes("externalId: { in:"), "the guard must be scoped by an id list");
  });

  it("the unit refuses a descriptor that is not one page of the Awin walk", () => {
    const refusals = [
      {},
      { networkSource: "" },
      { networkSource: "trackier" },
      { networkSource: "awin", entityType: "coupon" },
      { networkSource: "awin", entityIds: ["a"] },
      { networkSource: "awin", day: "2026-01-01" },
      { networkSource: "awin", cursorId: "" },
      { networkSource: "awin", pageSize: 7 },
    ];
    for (const descriptor of refusals) {
      assert.throws(
        () => resolveAwinMaterializationPage(descriptor),
        (error) => error.code === AWIN_MATERIALIZATION_REFUSAL_CODE && error.statusCode === 422,
        JSON.stringify(descriptor),
      );
    }
    assert.deepEqual(resolveAwinMaterializationPage({ networkSource: "AWIN" }), {
      networkSource: AWIN_MATERIALIZATION_NETWORK_SOURCE,
      cursorId: null,
      pageSize: AWIN_MATERIALIZATION_PAGE_SIZE,
    });
  });

  it("hasMore needs BOTH a full page and a cursor", () => {
    assert.equal(awinMaterializationPageHasMore({ offersScanned: AWIN_MATERIALIZATION_PAGE_SIZE }), true);
    assert.equal(awinMaterializationPageHasMore({ offersScanned: AWIN_MATERIALIZATION_PAGE_SIZE - 1 }), false);
    assert.equal(awinMaterializationPageHasMore({ offersScanned: undefined }), false);
    assert.equal(nextAwinParentMaterializationUnit({ hasMore: true, nextCursor: "x", cursorId: "x" }, { kind: "k" }), null);
  });

  it("the stored outcome is counts and a position — never an id or a name", () => {
    const outcome = summariseAwinParentMaterializationUnitOutcome({
      networkSource: "awin",
      offersScanned: 200,
      advertisersFound: 57,
      parentsStaged: 55,
      skippedProgrammeBacked: 2,
      offersWithoutAdvertiser: 0,
      lastCursor: "e-secret-entity-id",
      hasMore: true,
    });
    const serialized = JSON.stringify(outcome);
    assert.ok(!serialized.includes("e-secret-entity-id"), "the cursor must stay in the unit payload");
    assert.deepEqual(outcome.counts, {
      offersScanned: 200,
      advertisersFound: 57,
      parentsStaged: 55,
      skippedProgrammeBacked: 2,
      offersWithoutAdvertiser: 0,
    });
  });

  it("the unit kind is executable by the worker", () => {
    assert.equal(isUnitExecutable({ kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION }), true);
    assert.equal(UNIT_KINDS.AWIN_PARENT_MATERIALIZATION, "awin-parent-materialization");
  });

  it("M. no supplier client is reachable from the unit or the page", () => {
    for (const source of [UNIT_SRC, SVC_SRC]) {
      for (const forbidden of ["adapters/", "fetchCoupons", "fetchPromotions", "axios", "node-fetch"]) {
        assert.ok(!source.includes(forbidden), `${forbidden} reachable from the materialization path`);
      }
    }
  });
});

describe("Phase 19 — the stage barrier", () => {
  const completedNetwork = (platform) => ({
    status: "COMPLETED",
    payload: { kind: UNIT_KINDS.NETWORK, platform },
  });
  const materialization = (status, cursorId = null) => ({
    status,
    payload: { kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION, networkSource: "awin", cursorId },
  });
  const promotion = (status, entityType, networkSource = "awin") => ({
    status,
    payload: { kind: UNIT_KINDS.PROMOTION, networkSource, entityType, cursorId: null },
  });
  const transition = (units) => planPostSyncTransition(units, { runStartedAt: new Date("2026-09-21T00:00:00Z") });

  it("J1. Awin materialization is seeded before any promotion unit", () => {
    const next = transition([completedNetwork("awin")]);
    assert.equal(next.reason, "awin_parent_materialization_seeded");
    assert.equal(next.seeds.length, 1);
    assert.equal(next.seeds[0].kind, UNIT_KINDS.AWIN_PARENT_MATERIALIZATION);
    assert.equal(next.seeds[0].networkSource, "awin");
    assert.equal(next.seeds[0].cursorId, null);
  });

  it("J2. the Awin campaign walk is NOT seeded while materialization is outstanding", () => {
    for (const status of ["PENDING", "RUNNING"]) {
      const next = transition([completedNetwork("awin"), materialization(status)]);
      assert.equal(next.reason, "awin_parent_materialization_outstanding");
      assert.deepEqual(next.seeds, [], `seeded a promotion unit while materialization was ${status}`);
    }
  });

  it("J3. the campaign walk is seeded only once materialization RESOLVES", () => {
    const next = transition([completedNetwork("awin"), materialization("COMPLETED")]);
    assert.equal(next.reason, "promotion_campaign_seeded");
    assert.deepEqual(
      next.seeds.map((s) => [s.kind, s.networkSource, s.entityType]),
      [[UNIT_KINDS.PROMOTION, "awin", "campaign"]],
    );
  });

  it("a failed materialization unit stops the progression as a promotion failure", () => {
    const next = transition([completedNetwork("awin"), materialization("DEAD_LETTER")]);
    assert.equal(next.stage, "failed");
    assert.equal(next.failureStage, "promotion");
    assert.deepEqual(next.seeds, []);
  });

  it("K. the Awin coupon walk is not seeded until the campaign walk resolves", () => {
    const base = [completedNetwork("awin"), materialization("COMPLETED")];
    const running = transition([...base, promotion("RUNNING", "campaign")]);
    assert.ok(
      !running.seeds.some((s) => s.entityType === "coupon"),
      "coupons seeded while the campaign walk was still running",
    );

    const resolved = transition([...base, promotion("COMPLETED", "campaign")]);
    assert.ok(
      resolved.seeds.some((s) => s.kind === UNIT_KINDS.PROMOTION && s.entityType === "coupon"),
      "coupons must be seeded once the campaign walk resolves",
    );
  });

  it("a network that is not Awin is unaffected by the barrier", () => {
    const next = transition([completedNetwork("trackier")]);
    assert.equal(next.reason, "promotion_campaign_seeded");
    assert.deepEqual(
      next.seeds.map((s) => [s.networkSource, s.entityType]),
      [["trackier", "campaign"]],
    );
  });

  it("the barrier applies when Awin is one of several networks", () => {
    const next = transition([completedNetwork("awin"), completedNetwork("trackier")]);
    assert.equal(next.reason, "awin_parent_materialization_seeded");
    assert.ok(!next.seeds.some((s) => s.kind === UNIT_KINDS.PROMOTION));
  });

  it("walkState tracks the materialization walk like any other bounded walk", () => {
    const units = [materialization("COMPLETED"), materialization("PENDING", "e-200")];
    assert.equal(
      walkState(units, { kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION, networkSource: "awin" }),
      "outstanding",
    );
  });
});

describe("Phase 19 — explicit-unit backfill, with no network unit at all", () => {
  it("L. a run carrying only a materialization unit still gets its barrier and its promotion", () => {
    const units = [
      { status: "PENDING", payload: { kind: UNIT_KINDS.AWIN_PARENT_MATERIALIZATION, networkSource: "awin", cursorId: null } },
    ];
    // No network unit: postSyncNetworks is empty, so the barrier has to recognise the run by its
    // own materialization units or the backfill would fall through to "no_completed_network".
    assert.equal(awinParentMaterializationRequired(units), true);

    const outstanding = planPostSyncTransition(units, { runStartedAt: new Date() });
    assert.equal(outstanding.reason, "awin_parent_materialization_outstanding");
    assert.deepEqual(outstanding.seeds, []);

    const done = planPostSyncTransition(
      [{ ...units[0], status: "COMPLETED" }],
      { runStartedAt: new Date() },
    );
    // With no completed network unit there is no network to seed promotion FOR, so the run stops
    // cleanly rather than inventing one. The campaign units are supplied explicitly alongside.
    assert.notEqual(done.reason, "awin_parent_materialization_outstanding");
  });

  it("awinParentMaterializationRequired is false for a run with no Awin anywhere", () => {
    assert.equal(awinParentMaterializationRequired([]), false);
    assert.equal(
      awinParentMaterializationRequired([{ status: "COMPLETED", payload: { kind: UNIT_KINDS.NETWORK, platform: "trackier" } }]),
      false,
    );
  });
});

describe("Phase 19 — PromotionJob.run no longer drains the Awin estate", () => {
  it("N. run() has no Awin materialization trigger left in it", async () => {
    const source = codeOnly(JOB_SRC);
    const run = source.split("async run({")[1].split("\n  }")[0];
    assert.ok(!run.includes("awinParentMaterialization"), "run() still triggers materialization");
    assert.ok(!run.includes("materializeAwinAdvertiserParents"), "run() still reaches the drain");
    assert.ok(!source.includes("materializeAwinAdvertiserParents"), "the job still imports the drain");

    const job = new PromotionJob({
      promotionService: { ensureSuppliersSeeded: async () => {} },
      normalization: { normalizeSupplierCampaign: async () => ({}) },
      rakutenCommissionPromotion: async () => ({}),
      entityRepo: { findManyForPromotion: async () => [] },
      campaignPromotion: { promoteEntity: async () => ({ result: "skipped" }) },
      couponPromotion: { promoteEntity: async () => ({ result: "skipped" }) },
    });
    const summary = await job.run({ networkSource: "awin" });
    assert.equal(summary.awinParentMaterialization, undefined, "no materialization result in the summary");
    assert.equal(summary.processed, 0);
  });
});

describe("Phase 19 — /api/promotion/run refuses an oversized Awin estate", () => {
  function repo(count) {
    const calls = [];
    return {
      calls,
      countForPromotion: async (args) => {
        calls.push(args);
        return count;
      },
    };
  }

  it("O. an oversized Awin estate is refused with a clear code and status", async () => {
    const entityRepo = repo(6429);
    await assert.rejects(
      () => assertAwinPromotionWithinBudget({ entityTypes: ["campaign", "coupon"], networkSource: "awin" }, { entityRepo }),
      (error) => {
        assert.equal(error.code, AWIN_DURABLE_PROMOTION_REQUIRED);
        assert.equal(error.statusCode, 422);
        assert.equal(error.pending, 6429);
        assert.equal(error.budget, AWIN_UNBOUNDED_RUN_BUDGET);
        assert.match(error.message, /Nothing was processed/);
        assert.match(error.message, /durable/i);
        return true;
      },
    );
  });

  it("P. the refusal performs zero writes — it only counts", async () => {
    const entityRepo = repo(6429);
    let writes = 0;
    const guarded = {
      countForPromotion: entityRepo.countForPromotion,
      // Any write the guard might reach would have to come through these.
      findManyForPromotion: async () => { writes += 1; return []; },
      findPageForPromotion: async () => { writes += 1; return []; },
    };
    await assert.rejects(() => assertAwinPromotionWithinBudget({ networkSource: "awin" }, { entityRepo: guarded }));
    assert.equal(writes, 0, "the refusal must not touch the estate");
    assert.equal(entityRepo.calls.length, 1, "exactly one COUNT, and nothing else");
  });

  it("an Awin estate inside the budget is allowed through untouched", async () => {
    const entityRepo = repo(AWIN_UNBOUNDED_RUN_BUDGET);
    const result = await assertAwinPromotionWithinBudget({ networkSource: "awin" }, { entityRepo });
    assert.equal(result.checked, true);
    assert.equal(result.pending, AWIN_UNBOUNDED_RUN_BUDGET);
    assert.deepEqual(entityRepo.calls[0].entityTypes, ["campaign", "coupon"], "defaults to both types");
    assert.equal(entityRepo.calls[0].networkSource, "awin");
  });

  it("an unscoped run is still checked, because it covers Awin", async () => {
    const entityRepo = repo(9999);
    await assert.rejects(() => assertAwinPromotionWithinBudget({}, { entityRepo }));
    assert.equal(entityRepo.calls[0].networkSource, "awin", "counted on Awin's own terms");
  });

  it("Q. Trackier is never counted and never refused", async () => {
    const entityRepo = repo(999999);
    const result = await assertAwinPromotionWithinBudget({ networkSource: "trackier" }, { entityRepo });
    assert.equal(result.checked, false);
    assert.equal(entityRepo.calls.length, 0, "no count query for another network");
  });

  it("a narrow entityIds request passes even while the estate is large", async () => {
    const entityRepo = repo(3);
    const result = await assertAwinPromotionWithinBudget(
      { networkSource: "awin", entityIds: ["a", "b", "c"] },
      { entityRepo },
    );
    assert.equal(result.pending, 3);
    assert.deepEqual(entityRepo.calls[0].entityIds, ["a", "b", "c"], "the id scope reaches the count");
  });
});
