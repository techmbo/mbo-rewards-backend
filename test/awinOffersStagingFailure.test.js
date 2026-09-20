/**
 * A page we fetched but did not finish writing down is a unit FAILURE.
 *
 * The durable walk plans its next unit from the campaignPage the previous one returned, and that
 * return value is a claim: this page is done, plan past it. If staging only half-finished and the
 * unit returned anyway, the walk would move on and nothing would ever revisit the gap — the rows
 * that failed to stage would be lost permanently while the run reported success.
 *
 * So the unit throws. failUnit returns it to PENDING with its descriptor untouched, the retry
 * re-runs exactly the same page, and the rows already committed are reached again through the
 * idempotent path rather than duplicated.
 *
 * This is deliberately NOT one of the pagination reasons. page_cap, repeated_page, short_page and
 * empty_page say how much of the CATALOGUE we have. This says we failed to write down a page we
 * already held. Conflating them would tell an operator the supplier cut us short when it did not.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

process.env.AWIN_MIN_INTERVAL_MS = "1";
const { AWIN_OFFERS_PAGE_SIZE } = await import("../src/adapters/awin.adapter.js");

import { EXHAUSTION } from "../src/core/paginationExhaustion.js";
import { nextPagedUnit } from "../src/jobs/syncSourcePlan.js";
import { entityStagingBarrier } from "../src/jobs/entityStagingBarrier.js";
import { prisma } from "../src/database/prisma.js";
import { stageAwinOfferRows, stagedCompletely } from "../src/jobs/awinOffersStaging.js";
import { AWIN_OFFERS_STAGING_FAILED } from "../src/jobs/waveESupplierSync.js";
import { upsertManyRawEntities } from "../src/modules/raw/raw.service.js";

const SYNC_SRC = readFileSync(new URL("../src/jobs/waveESupplierSync.js", import.meta.url), "utf8");
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const promotion = (id) => ({
  promotionId: id,
  advertiser: { id: 998877, name: "zzadvertisernamezz" },
  type: "voucher",
  voucher: { code: "zzvouchercodezz" },
});
const page = (base, n = AWIN_OFFERS_PAGE_SIZE) => Array.from({ length: n }, (_, i) => promotion(base + i));

/* ------------------------------------------------------------------------------------- db */

function stubPrisma() {
  const state = { entities: new Map(), raws: new Map(), byId: new Map(), rawCreates: 0 };
  const ek = (e, n, t) => `${e}|${n}|${t}`;
  const rk = (w) => [w.supplier, w.sourceAccountLabel, w.resourceKey, w.externalId, w.payloadHash].join("\u0000");
  const entity = {
    async findUnique({ where }) {
      const k = where.externalId_networkSource_entityType;
      return state.entities.get(ek(k.externalId, k.networkSource, k.entityType)) ?? null;
    },
    async findFirst({ where }) {
      return where?.externalId ? state.entities.get(ek(where.externalId, where.networkSource, where.entityType)) ?? null : null;
    },
    async findMany({ where }) {
      const w = new Set(where?.externalId?.in ?? []);
      return [...state.entities.values()].filter((r) => w.has(r.externalId)).map((r) => ({ id: r.id, externalId: r.externalId }));
    },
    async create({ data }) {
      const row = { id: `entity-${state.entities.size + 1}`, ...data };
      state.entities.set(ek(data.externalId, data.networkSource, data.entityType), row);
      return row;
    },
    async update({ where, data }) {
      for (const [k, r] of state.entities) if (r.id === where.id) { const n = { ...r, ...data }; state.entities.set(k, n); return n; }
      return { id: where.id, ...data };
    },
    async upsert({ where, create }) {
      const k = where.externalId_networkSource_entityType;
      const e = state.entities.get(ek(k.externalId, k.networkSource, k.entityType));
      if (e) return e;
      const row = { id: `entity-${state.entities.size + 1}`, ...create };
      state.entities.set(ek(k.externalId, k.networkSource, k.entityType), row);
      return row;
    },
  };
  const rawPayload = {
    async findUnique({ where }) {
      return state.raws.get(rk(where.supplier_sourceAccountLabel_resourceKey_externalId_payloadHash)) ?? null;
    },
    async findFirst() { return null; },
    async create({ data }) {
      const key = rk(data);
      if (state.raws.has(key)) { const e = new Error("Unique constraint failed"); e.code = "P2002"; throw e; }
      state.rawCreates += 1;
      const row = { id: `raw-${state.rawCreates}`, ...data };
      state.raws.set(key, row); state.byId.set(row.id, row);
      return row;
    },
    async update({ where, data }) {
      const r = state.byId.get(where.id); if (r) Object.assign(r, data);
      return r ?? { id: where.id, ...data };
    },
    async updateMany() { return { count: 0 }; },
  };
  return { state, delegates: { entity, rawPayload, sourceSchemaStats: { async upsert() { return { id: "s" }; } }, fieldRegistry: { async upsert() { return { id: "f" }; } }, $executeRaw: async () => 1 } };
}

async function withDb(fn) {
  const { state, delegates } = stubPrisma();
  const originalBarrierDb = entityStagingBarrier.db;
  const originals = {};
  for (const n of Object.keys(delegates)) originals[n] = prisma[n];
  entityStagingBarrier.db = {
    jobRun: {
      async create({ data }) { return { id: "t", ...data }; },
      async findMany() { return []; }, async findFirst() { return null; },
      async updateMany() { return { count: 1 }; }, async update() { return {}; },
    },
  };
  for (const [n, d] of Object.entries(delegates)) prisma[n] = d;
  try { return { state, returned: await fn({ state }) }; }
  finally {
    entityStagingBarrier.db = originalBarrierDb;
    for (const [n, o] of Object.entries(originals)) prisma[n] = o;
  }
}

/**
 * The unit body, exactly as syncAwinAccount sequences it: fetch, stage, and either return a
 * continuation or throw. Modelled here because syncAwinAccount needs credentials and a database.
 */
async function runUnit({ rows, descriptor, failStagingAfter = null, stagedSoFar = null }) {
  let offersPagination = {
    index: Math.floor(descriptor.campaignPageOffset / descriptor.campaignPageLimit),
    offset: descriptor.campaignPageOffset,
    nextOffset: descriptor.campaignPageOffset + descriptor.campaignPageLimit,
    hasMore: true,
    reason: null,
    carry: [...(descriptor.campaignPageCarry ?? []), "zzdigestzz"],
  };
  let chunk = 0;
  const summary = await stageAwinOfferRows({
    rows,
    stage: async (args) => {
      chunk += 1;
      if (failStagingAfter !== null && chunk > failStagingAfter) throw new Error("zzstagingfailedzz");
      return upsertManyRawEntities(args);
    },
  });
  if (stagedSoFar) stagedSoFar.summary = summary;
  if (!stagedCompletely(summary)) {
    offersPagination = null;
    const failure = new Error(
      `Awin offers page staging did not complete: ${summary.chunksCompleted}/${summary.chunksTotal} chunks, ${summary.rowsStaged}/${summary.rows} rows.`,
    );
    failure.code = AWIN_OFFERS_STAGING_FAILED;
    failure.retryable = true;
    throw failure;
  }
  return { campaignPage: offersPagination };
}

/* ====================================================== 1. the failure fails the unit */

describe("incomplete staging fails the durable unit", () => {
  const descriptor = { campaignPageOffset: 400, campaignPageLimit: 200, campaignPageBudget: 1, campaignPageCarry: ["aa"] };

  it("throws a retryable, stably-coded error instead of returning", async () => {
    await withDb(async () => {
      await assert.rejects(
        () => runUnit({ rows: page(1000, 400), descriptor, failStagingAfter: 1 }),
        (error) => {
          assert.equal(error.code, AWIN_OFFERS_STAGING_FAILED);
          assert.equal(error.retryable, true);
          assert.match(error.message, /staging did not complete/i);
          // Counts only — no payload, no coupon code, no external id.
          assert.ok(!/zzvouchercodezz|awin-coupon-/.test(error.message));
          return true;
        },
      );
    });
  });

  it("returns NO campaignPage continuation, so no next unit can be planned", async () => {
    await withDb(async () => {
      let returned = "not-set";
      try {
        returned = await runUnit({ rows: page(1000, 400), descriptor, failStagingAfter: 1 });
      } catch (error) {
        returned = error;
      }
      assert.ok(returned instanceof Error, "the unit returned instead of throwing");
      assert.equal(returned.campaignPage, undefined);
      // And the planner refuses to continue from nothing.
      assert.equal(
        nextPagedUnit(
          { platform: "awin", accountLabel: "default", sourceObject: "offers", ...descriptor },
          null,
        ),
        null,
        "a continuation was planned from a failed page",
      );
    });
  });

  it("the descriptor is untouched, so the retry re-runs the same page", () => {
    // failUnit returns the unit to PENDING and writes only status/lastError; it never edits the
    // payload, so offset, limit and carry are exactly what this attempt was claimed with.
    const src = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");
    const failUnit = src.split("async failUnit(unitId, error)")[1].split("\n  }")[0];
    assert.match(failUnit, /status: "PENDING", lastError: message/);
    assert.ok(!failUnit.includes("campaignPage"), "failUnit touches the page descriptor");
    assert.ok(!failUnit.includes("payload:"), "failUnit rewrites the unit payload");
    // And a failed unit never reaches the follow-on planner. The worker materialises the
    // continuation and completes the unit only AFTER the unit's work has resolved, so a throw
    // skips both — there is no path from a thrown unit to an appended successor.
    const worker = readFileSync(new URL("../src/controllers/sync.controller.js", import.meta.url), "utf8");
    const followOnAt = worker.indexOf("orchestration.materialiseFollowOnUnits(run.id, descriptor, result");
    const completeAt = worker.indexOf("orchestration.completeUnit(");
    assert.ok(followOnAt > 0 && completeAt > followOnAt, "the worker no longer plans before completing");
    // Both consume `result`, which a throwing unit never produces.
    assert.match(worker.slice(followOnAt, completeAt + 200), /result/);
    assert.ok(!failUnit.includes("materialiseFollowOnUnits"), "a failed unit plans its successor");
  });

  it("the source throws rather than warning, and says so with the distinct code", () => {
    const code = codeOnly(SYNC_SRC);
    assert.match(code, /if \(!stagedCompletely\(offersStaging\)\) \{/);
    assert.match(code, /failure\.code = AWIN_OFFERS_STAGING_FAILED;/);
    assert.match(code, /failure\.retryable = true;/);
    assert.match(code, /throw failure;/);
    assert.match(code, /offersPagination = null;/);
  });
});

/* ============================================= 2. committed rows survive; retry is idempotent */

describe("rows written before the failure", () => {
  const descriptor = { campaignPageOffset: 0, campaignPageLimit: 200, campaignPageBudget: 1 };

  it("are preserved, not rolled back", async () => {
    const rows = page(2000, 400); // 2 chunks
    const { state } = await withDb(async () => {
      await assert.rejects(() => runUnit({ rows, descriptor, failStagingAfter: 1 }));
    });
    assert.equal(state.entities.size, 200, "the committed chunk was rolled back");
    assert.equal(state.rawCreates, 200);
  });

  it("a retry of the same page stages the rest and creates no duplicates", async () => {
    const rows = page(2000, 400);
    const { state } = await withDb(async () => {
      await assert.rejects(() => runUnit({ rows, descriptor, failStagingAfter: 1 }));
      // Same descriptor, same rows — the retry re-runs exactly this page.
      const ok = await runUnit({ rows, descriptor });
      assert.ok(ok.campaignPage, "the retry did not complete the page");
    });
    assert.equal(state.entities.size, 400, "the retry lost or duplicated rows");
    assert.equal(state.rawCreates, 400, "the retry duplicated immutable evidence");
  });

  it("retrying repeatedly converges rather than accumulating", async () => {
    const rows = page(3000, 400);
    const { state } = await withDb(async () => {
      await assert.rejects(() => runUnit({ rows, descriptor, failStagingAfter: 1 }));
      await assert.rejects(() => runUnit({ rows, descriptor, failStagingAfter: 1 }));
      await runUnit({ rows, descriptor });
      await runUnit({ rows, descriptor });
    });
    assert.equal(state.entities.size, 400);
    assert.equal(state.rawCreates, 400);
  });
});

/* ===================================================== 3. success advances exactly once */

describe("a retry that succeeds advances exactly once", () => {
  it("returns one continuation, at the next offset, planned once", async () => {
    const descriptor = { campaignPageOffset: 400, campaignPageLimit: 200, campaignPageBudget: 1, campaignPageCarry: ["aa"] };
    const rows = page(4000, 200);
    const { returned } = await withDb(() => runUnit({ rows, descriptor }));
    assert.equal(returned.campaignPage.offset, 400);
    assert.equal(returned.campaignPage.nextOffset, 600);

    const unitDescriptor = { platform: "awin", accountLabel: "default", sourceObject: "offers", campaignPageIndex: 2, ...descriptor };
    const a = nextPagedUnit(unitDescriptor, returned.campaignPage);
    const b = nextPagedUnit(unitDescriptor, returned.campaignPage);
    assert.equal(a.campaignPageOffset, 600);
    assert.deepEqual(a, b, "planning the same completion twice produced different units");
    // The carry from before this page is extended, not replaced.
    assert.deepEqual(a.campaignPageCarry, ["aa", "zzdigestzz"]);
  });
});

/* ============================== 4. it is not a pagination verdict, and nothing else moved */

describe("a staging failure is distinct from every catalogue verdict", () => {
  it("its code is none of the pagination reasons", () => {
    assert.equal(AWIN_OFFERS_STAGING_FAILED, "AWIN_OFFERS_STAGING_FAILED");
    for (const reason of Object.values(EXHAUSTION)) {
      assert.notEqual(AWIN_OFFERS_STAGING_FAILED.toLowerCase(), reason);
    }
    assert.ok(!AWIN_OFFERS_STAGING_FAILED.includes("PAGE_CAP"));
    assert.ok(!AWIN_OFFERS_STAGING_FAILED.includes("REPEATED"));
  });

  it("it does not set partialSuccess — a failed unit is not a partly-successful one", () => {
    const code = codeOnly(SYNC_SRC);
    const block = code.split("if (!stagedCompletely(offersStaging))")[1].split("\n  }")[0];
    assert.ok(!block.includes("partialSuccess"), "a staging failure reported partial success");
    assert.ok(!block.includes("warnings.push"), "a staging failure was downgraded to a warning");
  });

  it("the supplier fetch's own run is not rewritten by a staging failure", () => {
    const code = codeOnly(SYNC_SRC);
    const block = code.split("if (!stagedCompletely(offersStaging))")[1].split("\n  }")[0];
    for (const forbidden of ["finalizeRun", "withSourceOutcome", "recordExhaustion", "sourceObjectRuns"]) {
      assert.ok(!block.includes(forbidden), `a staging failure touched ${forbidden}`);
    }
  });

  it("the manual unscoped warning path is untouched", () => {
    const code = codeOnly(SYNC_SRC);
    assert.match(code, /warnings\.push\(\s*"Awin offers were not synced/);
    assert.equal((code.match(/warnings\.push\(/g) ?? []).length, 1);
    assert.match(code, /partialSuccess: warnings\.length > 0,/);
  });

  it("Trackier stages in one batch and cannot reach this failure path", async () => {
    const { state } = await withDb(() =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "coupon",
        rows: Array.from({ length: 50 }, (_, i) => ({ id: `zzt${i}`, record_source: "coupon", code: `ZZC${i}`, campaign_id: 7 })),
        externalIdPrefix: "trackier-coupon",
        sourceAccountKey: null,
      }),
    );
    assert.equal(state.entities.size, 50);
    const code = codeOnly(SYNC_SRC);
    // The throw sits inside the Awin offers block, which only runs for a bounded offers slice.
    const guardAt = code.indexOf('includeSourceObject(requested, "offers") && offersPage');
    const throwAt = code.indexOf("throw failure;");
    assert.ok(guardAt > 0 && throwAt > guardAt, "the staging failure escaped the offers block");
  });
});
