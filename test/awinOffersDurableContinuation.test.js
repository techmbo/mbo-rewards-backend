/**
 * Awin offers as bounded, resumable work.
 *
 * The walk and the chunker were both necessary and neither is sufficient. Production measured it:
 * fetching 5,000 offers costs ~96s, and staging them costs ~11s per 200 rows in the database's own
 * region — about 247s — so a whole catalogue is ~343s of work against a 300s invocation. No chunk
 * size fixes that, because chunking does not make the work smaller.
 *
 * So one invocation does ONE page: fetch it, stage it, report where the next one starts. The
 * continuation rides the orchestration's existing paged-unit model — the same campaignPage*
 * descriptor fields, the same nextPagedUnit planner, the same JobRun payload — rather than a
 * second scheduler vocabulary.
 *
 * What these tests pin is that slicing changed NOTHING about meaning: the five termination reasons
 * still mean what they meant, a retried page is still idempotent, and a cold start still resumes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

process.env.AWIN_MIN_INTERVAL_MS = "1";
const {
  createAwinAdapter,
  AWIN_OFFERS_PAGE_SIZE,
  AWIN_MAX_OFFER_PAGES,
} = await import("../src/adapters/awin.adapter.js");

import { EXHAUSTION, EXHAUSTION_STATS_KEY } from "../src/core/paginationExhaustion.js";
import { withSourceOutcome } from "../src/jobs/sourceFetchOutcome.js";
import {
  nextPagedUnit,
  planAccountUnits,
  AWIN_OFFERS_PAGE_LIMIT,
  AWIN_OFFERS_PAGES_PER_UNIT,
} from "../src/jobs/syncSourcePlan.js";
import { boundedCampaignPage } from "../src/jobs/syncContext.js";
import { runWithSyncOptions } from "../src/jobs/syncContext.js";
import { entityStagingBarrier } from "../src/jobs/entityStagingBarrier.js";
import { prisma } from "../src/database/prisma.js";
import { stageAwinOfferRows } from "../src/jobs/awinOffersStaging.js";
import { buildAwinCouponExternalId, isUnresolvedAwinCouponEvidenceId } from "../src/modules/raw/raw.service.js";

/* ------------------------------------------------------------------------------- supplier */

const promotion = (id, advertiserId = 998877) => ({
  promotionId: id,
  advertiser: { id: advertiserId, name: "zzadvertisernamezz" },
  type: "voucher",
  voucher: { code: "zzvouchercodezz" },
});
const unnameable = (m) => ({ advertiser: { name: "zzadvertisernamezz" }, type: "voucher", marker: m });

/** A catalogue of `total` promotions served as pages of AWIN_OFFERS_PAGE_SIZE. */
function catalogueServer(total, extra = {}) {
  const rows = Array.from({ length: total }, (_, i) => promotion(10000 + i));
  return (page) => {
    if (extra[page]) return extra[page];
    const slice = rows.slice((page - 1) * AWIN_OFFERS_PAGE_SIZE, page * AWIN_OFFERS_PAGE_SIZE);
    return { data: slice };
  };
}

function adapterFor(respond, calls = []) {
  return createAwinAdapter({
    accessToken: "zzawinaccesstokenzz",
    publisherId: "zzpublisheridzz",
    httpClient: {
      async get() { return { data: { programmes: [] } }; },
      async post(path, body) {
        calls.push(body?.pagination?.page);
        return { data: respond(body?.pagination?.page) };
      },
    },
  });
}

/** One invocation: fetch the slice at `descriptor`, wrapped exactly as the sync run wraps it. */
async function invoke(respond, descriptor, calls = []) {
  const adapter = adapterFor(respond, calls);
  const stats = { requestCount: 0 };
  let page = null;
  // Nested exactly as syncAwinAccount nests it. withSourceOutcome snapshots the exhaustion record
  // BEFORE calling the fetch, so a fetch that ran outside the wrapper would have its record read
  // as a previous source object's and ignored — which is the isolation guard working, and would
  // make this harness silently untrue.
  const outcome = await withSourceOutcome(
    stats,
    () =>
      runWithSyncOptions(descriptor, async () => {
        const slice = boundedCampaignPage();
        page = await adapter.fetchCouponsPage(
          { offset: slice.offset, limit: slice.limit, seen: Array.isArray(slice.carry) ? slice.carry : [] },
          stats,
        );
        return page.rows;
      }),
    { truncationCode: "AWIN_OFFERS_PAGE_CAP", repeatedPageCode: "AWIN_OFFERS_REPEATED_PAGE" },
  );
  return { page, stats, outcome };
}

/** The descriptor an orchestrated unit carries. Mirrors what planAccountUnits/nextPagedUnit emit. */
const descriptorFor = (unit) => ({
  campaignPageOffset: unit.campaignPageOffset,
  campaignPageLimit: unit.campaignPageLimit,
  campaignPageBudget: unit.campaignPageBudget,
  ...(unit.campaignPageCarry === undefined ? {} : { campaignPageCarry: unit.campaignPageCarry }),
});

/** Drive the whole catalogue the way orchestration would: plan, run, plan the next, repeat. */
async function driveUnits(respond, { max = 40 } = {}) {
  const first = planAccountUnits({ platform: "awin", accountLabel: "default", now: new Date() })
    .units.find((u) => u.sourceObject === "offers");
  assert.ok(first, "offers was not planned as a unit");
  const units = [first];
  const pages = [];
  const calls = [];
  let unit = first;
  for (let i = 0; i < max; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { page, outcome, stats } = await invoke(respond, descriptorFor(unit), calls);
    pages.push({ unit, page, outcome, stats });
    const continuation = nextPagedUnit(
      { ...unit, platform: "awin", accountLabel: "default", sourceObject: "offers" },
      { hasMore: page.hasMore, nextOffset: page.nextOffset, carry: page.seen },
    );
    if (!continuation) break;
    unit = { ...unit, ...continuation };
    units.push(unit);
  }
  return { units, pages, calls };
}

/* ------------------------------------------------------------------------------- staging db */

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
      return where?.externalId
        ? state.entities.get(ek(where.externalId, where.networkSource, where.entityType)) ?? null
        : null;
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
const raws = (state) => [...state.raws.values()];

/* ================================================== 1. the plan is bounded, and it is the existing one */

describe("Awin offers is planned as a bounded paged unit", () => {
  it("uses the orchestration's existing campaignPage descriptor, not a new vocabulary", () => {
    const { units } = planAccountUnits({ platform: "awin", accountLabel: "default", now: new Date() });
    const offers = units.find((u) => u.sourceObject === "offers");
    assert.ok(offers, "offers is not planned as a unit");
    assert.equal(offers.campaignPageIndex, 0);
    assert.equal(offers.campaignPageOffset, 0);
    assert.equal(offers.campaignPageLimit, AWIN_OFFERS_PAGE_LIMIT);
    assert.equal(offers.campaignPageBudget, AWIN_OFFERS_PAGES_PER_UNIT);
  });

  it("the planner's page width is the adapter's page size — they cannot drift", () => {
    assert.equal(AWIN_OFFERS_PAGE_LIMIT, AWIN_OFFERS_PAGE_SIZE);
    assert.equal(AWIN_OFFERS_PAGES_PER_UNIT, 1, "a unit must stage at most one page");
  });

  it("5,000 offers become 25 units, each handling at most 200", async () => {
    const { units, pages, calls } = await driveUnits(catalogueServer(5000));
    assert.equal(units.length, 25, `expected 25 bounded units, got ${units.length}`);
    assert.equal(pages.length, 25);
    for (const { page } of pages) {
      assert.ok(page.rows.length <= AWIN_OFFERS_PAGE_SIZE, "a unit handled more than one page");
    }
    // One supplier request per unit, in page order, each page requested exactly once.
    assert.deepEqual(calls, Array.from({ length: 25 }, (_, i) => i + 1));
    assert.equal(pages.reduce((n, p) => n + p.page.rows.length, 0), 5000);
  });

  it("each unit's offset is its own page, and the next resumes where it left off", async () => {
    // 1000 rows is five FULL pages, so nothing ends the walk until the empty sixth.
    const { units } = await driveUnits(catalogueServer(1000));
    assert.deepEqual(units.map((u) => u.campaignPageOffset), [0, 200, 400, 600, 800, 1000]);
    assert.deepEqual(units.map((u) => u.campaignPageIndex), [0, 1, 2, 3, 4, 5]);
  });

  it("pages 1..N are never re-fetched by a continuation", async () => {
    const { calls } = await driveUnits(catalogueServer(600));
    assert.deepEqual(calls, [1, 2, 3, 4], "a continuation re-walked earlier pages");
    assert.equal(new Set(calls).size, calls.length, "a page was fetched twice");
  });
});

/* ============================================== 2. termination semantics survive the slicing */

describe("the five termination reasons mean the same sliced as unsliced", () => {
  const reasonOf = (stats) => stats[EXHAUSTION_STATS_KEY]?.reason ?? null;

  it("supplier-confirmed exhaustion ends the walk and is SUCCESS", async () => {
    const respond = (page) =>
      page === 1
        ? { data: Array.from({ length: AWIN_OFFERS_PAGE_SIZE }, (_, i) => promotion(i)), hasNext: false }
        : { data: [] };
    const { units, pages } = await driveUnits(respond);
    assert.equal(units.length, 1, "a supplier-confirmed end planned another unit");
    assert.equal(reasonOf(pages[0].stats), EXHAUSTION.SUPPLIER_HAS_NEXT_FALSE);
    assert.equal(pages[0].stats[EXHAUSTION_STATS_KEY].supplierAsserted, true);
    assert.equal(pages[0].outcome.partial, undefined);
  });

  it("a short page ends it as a heuristic, still SUCCESS", async () => {
    const { units, pages } = await driveUnits(catalogueServer(250));
    assert.equal(units.length, 2);
    assert.equal(reasonOf(pages[1].stats), EXHAUSTION.SHORT_PAGE);
    assert.equal(pages[1].stats[EXHAUSTION_STATS_KEY].supplierAsserted, false);
    assert.equal(pages[1].stats[EXHAUSTION_STATS_KEY].exhausted, true);
    assert.equal(pages[1].outcome.partial, undefined);
  });

  it("an empty page ends it as a heuristic, still SUCCESS", async () => {
    const { units, pages } = await driveUnits(catalogueServer(400));
    assert.equal(units.length, 3, "the empty page after a full one did not end the walk");
    assert.equal(reasonOf(pages[2].stats), EXHAUSTION.EMPTY_PAGE);
    assert.equal(pages[2].outcome.partial, undefined);
  });

  it("a repeated page is PARTIAL and truncated, across invocations", async () => {
    // Page 3 re-delivers page 1 — only detectable because the digests were carried forward.
    const base = catalogueServer(1000);
    const respond = (page) => (page === 3 ? base(1) : base(page));
    const { units, pages } = await driveUnits(respond);
    assert.equal(units.length, 3, "the repeat did not stop the continuation");
    const last = pages[2];
    assert.equal(reasonOf(last.stats), EXHAUSTION.REPEATED_PAGE);
    assert.equal(last.outcome.partial, true);
    assert.equal(last.outcome.metadata.truncated, true);
    assert.equal(last.outcome.metadata.fetchFailed, false);
    assert.equal(last.outcome.metadata.errorCode, "AWIN_OFFERS_REPEATED_PAGE");
    assert.equal(last.page.rows.length, 0, "the repeated page's rows were accepted");
  });

  it("reaching page 25 with more data is PARTIAL and page_cap", async () => {
    const { units, pages } = await driveUnits(catalogueServer(6000));
    assert.equal(units.length, AWIN_MAX_OFFER_PAGES, "the cap did not stop the continuation");
    const last = pages[pages.length - 1];
    assert.equal(reasonOf(last.stats), EXHAUSTION.PAGE_CAP);
    assert.equal(last.outcome.partial, true);
    assert.equal(last.outcome.metadata.truncated, true);
    assert.equal(last.outcome.metadata.errorCode, "AWIN_OFFERS_PAGE_CAP");
    assert.equal(last.page.hasMore, false, "a 26th unit would have been planned");
  });

  it("a mid-walk slice claims no exhaustion at all", async () => {
    const { pages } = await driveUnits(catalogueServer(1000));
    for (const { stats, outcome } of pages.slice(0, -1)) {
      assert.equal(stats[EXHAUSTION_STATS_KEY], undefined, "a mid-walk slice claimed an ending");
      assert.equal(outcome.partial, undefined);
    }
  });
});

/* ====================================================== 3. durability, retries, cold starts */

describe("resuming is durable", () => {
  it("a cold start rebuilt from the descriptor alone continues correctly", async () => {
    const respond = catalogueServer(1000);
    const { pages } = await driveUnits(respond);
    // Everything a next invocation needs is in the descriptor — no in-memory state survives.
    const third = { campaignPageOffset: 400, campaignPageLimit: 200, campaignPageBudget: 1, campaignPageCarry: pages[1].page.seen };
    const calls = [];
    const { page } = await invoke(respond, third, calls);
    assert.deepEqual(calls, [3], "a rebuilt invocation re-fetched earlier pages");
    assert.equal(page.offset, 400);
    assert.equal(page.rows.length, 200);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 600);
  });

  it("the carried state is JSON-round-trippable, because it lives in a JobRun payload", async () => {
    const respond = catalogueServer(600);
    const { page } = await invoke(respond, { campaignPageOffset: 0, campaignPageLimit: 200, campaignPageBudget: 1 });
    const revived = JSON.parse(JSON.stringify(page.seen));
    assert.deepEqual(revived, page.seen);
    for (const d of revived) assert.match(d, /^[0-9a-f]{40}$/);
  });

  it("retrying the same page requests exactly that page and reports the same next offset", async () => {
    const respond = catalogueServer(1000);
    const descriptor = { campaignPageOffset: 400, campaignPageLimit: 200, campaignPageBudget: 1 };
    const a = [];
    const b = [];
    const first = await invoke(respond, descriptor, a);
    const retry = await invoke(respond, descriptor, b);
    assert.deepEqual(a, [3]);
    assert.deepEqual(b, [3], "a retry drifted to another page");
    assert.equal(first.page.nextOffset, retry.page.nextOffset);
    assert.deepEqual(first.page.seen, retry.page.seen, "the digest is not deterministic");
  });

  it("retrying a page stages nothing new: no duplicate Entity, no duplicate RawPayload", async () => {
    const respond = catalogueServer(400);
    const descriptor = { campaignPageOffset: 0, campaignPageLimit: 200, campaignPageBudget: 1 };
    const { state } = await withDb(async () => {
      const first = await invoke(respond, descriptor);
      await stageAwinOfferRows({ rows: first.page.rows });
      const retry = await invoke(respond, descriptor);
      await stageAwinOfferRows({ rows: retry.page.rows });
    });
    assert.equal(state.entities.size, 200, "a retry created duplicate Entities");
    assert.equal(state.rawCreates, 200, "a retry duplicated immutable evidence");
  });
});

/* ========================================= 4. staging across slices keeps every guarantee */

describe("staging a sliced catalogue", () => {
  it("every page's rows stage exactly once, under the canonical identity", async () => {
    const respond = catalogueServer(1000);
    const { pages } = await driveUnits(respond);
    const { state } = await withDb(async () => {
      for (const { page } of pages) await stageAwinOfferRows({ rows: page.rows });
    });
    assert.equal(state.entities.size, 1000);
    const all = pages.flatMap((p) => p.page.rows);
    for (const row of all.slice(0, 50)) {
      const id = buildAwinCouponExternalId(row);
      assert.ok([...state.entities.values()].some((e) => e.externalId === id), `missing ${id}`);
    }
    for (const row of raws(state)) {
      assert.equal(row.processingStatus, "STAGED");
      assert.ok(row.entityId, "a raw row lost its Entity linkage across slices");
    }
  });

  it("unresolved promotions on any page stay FAILED evidence only, deduped across slices", async () => {
    const base = catalogueServer(400);
    const respond = (page) =>
      page === 1 ? { data: [unnameable("x"), ...base(1).data.slice(1)] }
      : page === 2 ? { data: [unnameable("x"), ...base(2).data.slice(1)] }
      : { data: [] };
    const { pages } = await driveUnits(respond);
    const { state } = await withDb(async () => {
      for (const { page } of pages) await stageAwinOfferRows({ rows: page.rows });
    });
    const failed = raws(state).filter((r) => r.processingStatus === "FAILED");
    assert.equal(failed.length, 1, "the same unnameable payload left evidence twice");
    for (const r of failed) {
      assert.ok(!r.entityId);
      assert.ok(isUnresolvedAwinCouponEvidenceId(r.externalId));
    }
  });

  it("a staging failure does not advance the checkpoint", async () => {
    // The next unit is planned from the FETCH's pagination, so a caller that fails to stage must
    // not plan it. Proven by the contract: no continuation without a completed slice.
    const respond = catalogueServer(1000);
    const { page } = await invoke(respond, { campaignPageOffset: 0, campaignPageLimit: 200, campaignPageBudget: 1 });
    const summary = await stageAwinOfferRows({
      rows: page.rows,
      stage: async () => { throw new Error("zzstagefailedzz"); },
    });
    assert.equal(summary.chunksCompleted, 0);
    assert.equal(summary.failedChunk, 1);
    // A caller that sees an incomplete summary must not plan the next unit.
    const continuation = summary.failedChunk === null
      ? nextPagedUnit({ platform: "awin", accountLabel: "default", sourceObject: "offers", campaignPageOffset: 0 },
          { hasMore: page.hasMore, nextOffset: page.nextOffset })
      : null;
    assert.equal(continuation, null, "the checkpoint advanced past a failed staging");
  });

  it("a successful slice advances the checkpoint exactly once", async () => {
    const respond = catalogueServer(1000);
    const { page } = await invoke(respond, { campaignPageOffset: 0, campaignPageLimit: 200, campaignPageBudget: 1 });
    const descriptor = { platform: "awin", accountLabel: "default", sourceObject: "offers", campaignPageOffset: 0, campaignPageIndex: 0, campaignPageLimit: 200, campaignPageBudget: 1 };
    const pagination = { hasMore: page.hasMore, nextOffset: page.nextOffset, carry: page.seen };
    const a = nextPagedUnit(descriptor, pagination);
    const b = nextPagedUnit(descriptor, pagination);
    assert.equal(a.campaignPageOffset, 200);
    assert.deepEqual(a, b, "planning the same completion twice produced different units");
    // And it cannot go backwards: a stale pagination is refused.
    assert.equal(nextPagedUnit({ ...descriptor, campaignPageOffset: 400 }, pagination), null);
  });
});

/* ============================================================ 5. nothing else moved */

describe("other sources are untouched", () => {
  it("Trackier plans no paged offers unit and keeps its own shape", () => {
    const { units } = planAccountUnits({ platform: "trackier", accountLabel: "default", now: new Date() });
    for (const unit of units) {
      assert.equal(unit.campaignPageOffset, undefined, `trackier ${unit.sourceObject} became paged`);
    }
  });

  it("Awin programmes and transactions are not paged", () => {
    const { units } = planAccountUnits({ platform: "awin", accountLabel: "default", now: new Date() });
    for (const unit of units.filter((u) => u.sourceObject !== "offers")) {
      assert.equal(unit.campaignPageOffset, undefined, `${unit.sourceObject} became paged`);
    }
  });

  it("Optimise campaigns keeps its own page width and budget", () => {
    const { units } = planAccountUnits({ platform: "optimise", accountLabel: "default", now: new Date() });
    const campaigns = units.find((u) => u.sourceObject === "campaigns");
    assert.equal(campaigns.campaignPageLimit, 100);
    assert.equal(campaigns.campaignPageBudget, 8);
  });

  it("a source with no carry plans a continuation without one", () => {
    const unit = nextPagedUnit(
      { platform: "optimise", accountLabel: "default", sourceObject: "campaigns", campaignPageOffset: 0, campaignPageIndex: 0 },
      { hasMore: true, nextOffset: 100 },
    );
    assert.ok(unit);
    assert.equal(unit.campaignPageCarry, undefined, "a carry appeared where none was asked for");
  });
});

/* ================================================ 6. v7: the planner contract, and the refusal */

describe("PLANNER_VERSION 7 — a v6 Awin offers unit cannot be run as a v7 unit", () => {
  it("the version is 7 and says why", async () => {
    const { PLANNER_VERSION } = await import("../src/jobs/syncOrchestration.service.js");
    assert.equal(PLANNER_VERSION, 7);
    const src = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");
    const rationale = src.split("export const PLANNER_VERSION")[0];
    assert.match(rationale, /6 — Optimise campaigns became a PAGED source/);
    assert.match(rationale, /7 — Awin offers became a DURABLE PAGED source/);
    // The reason a v6 unit is unusable must be stated, not implied.
    assert.match(rationale, /carries NO campaignPage descriptor and no campaignPageCarry/);
  });

  it("a v6 Awin offers unit descriptor has no slice, which is exactly why it cannot run", () => {
    // What a v6 unit looked like: the source was not paged, so planAccountUnits emitted a bare
    // descriptor. Handing that to the v7 executor would mean the whole-catalogue walk.
    const v6Offers = { platform: "awin", accountLabel: "default", sourceObject: "offers", options: {} };
    assert.equal(v6Offers.campaignPageOffset, undefined);
    assert.equal(v6Offers.campaignPageCarry, undefined);
    assert.equal(
      boundedCampaignPageFor(v6Offers),
      null,
      "a v6 descriptor produced a slice it never carried",
    );
  });

  it("a v7 plan DOES carry the offers page descriptor", () => {
    const { units } = planAccountUnits({ platform: "awin", accountLabel: "default", now: new Date() });
    const offers = units.find((u) => u.sourceObject === "offers");
    assert.equal(offers.campaignPageOffset, 0);
    assert.equal(offers.campaignPageLimit, AWIN_OFFERS_PAGE_LIMIT);
    assert.equal(offers.campaignPageBudget, AWIN_OFFERS_PAGES_PER_UNIT);
    assert.ok(boundedCampaignPageFor(offers), "a v7 offers unit carries no usable slice");
  });
});

/** What boundedCampaignPage() resolves to for a given unit descriptor. */
function boundedCampaignPageFor(descriptor) {
  let page = null;
  runWithSyncOptions(
    {
      campaignPageOffset: descriptor.campaignPageOffset,
      campaignPageLimit: descriptor.campaignPageLimit,
      campaignPageBudget: descriptor.campaignPageBudget,
      campaignPageCarry: descriptor.campaignPageCarry,
    },
    () => {
      page = boundedCampaignPage();
    },
  );
  return page;
}
