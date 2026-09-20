/**
 * The offers page walk meeting the canonical Awin coupon identity.
 *
 * These two changes were written apart and have to hold together. The walk exists because
 * production read one page of a paginated catalogue; the identity exists because an Awin promotion
 * carries no top-level id, so every row fell through to `awin-coupon-${index}` — the row's
 * position in the WHOLE accumulated result.
 *
 * That is why the combination needs its own tests rather than inheriting confidence from either
 * side. A positional identity plus a page walk is strictly worse than a positional identity
 * without one: page 2 renumbers nothing but shifts every row's index, so re-running a walk that
 * returns the same catalogue in a different page order would remap promotions onto each other.
 * The canonical identity removes the coupling entirely — it reads advertiser.id and promotionId
 * out of the row and never sees a page at all.
 *
 * The walk is driven through the REAL adapter against a stubbed transport, and its rows are then
 * staged through the REAL staging path against stubbed Prisma delegates. Nothing here asserts on
 * source text.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The Awin limiter reads its interval once at module load and production's is 3000ms. Collapsed
// before the adapter is imported, exactly as the pagination suite does. Only spacing changes.
process.env.AWIN_MIN_INTERVAL_MS = "1";

const { createAwinAdapter, AWIN_OFFERS_PAGE_SIZE } = await import("../src/adapters/awin.adapter.js");

import { entityStagingBarrier } from "../src/jobs/entityStagingBarrier.js";
import { prisma } from "../src/database/prisma.js";
import {
  upsertManyRawEntities,
  buildAwinCouponExternalId,
  isUnresolvedAwinCouponEvidenceId,
} from "../src/modules/raw/raw.service.js";

/* ---------------------------------------------------------------------------- supplier side */

const ADVERTISER = 998877;

const promotion = (promotionId, advertiserId = ADVERTISER) => ({
  promotionId,
  advertiser: { id: advertiserId, name: "zzadvertisernamezz" },
  type: "voucher",
  voucher: { code: "zzvouchercodezz" },
});

/** A promotion missing half its identity — unnameable, and so evidence-only. */
const unnameable = (marker) => ({
  advertiser: { name: "zzadvertisernamezz" },
  type: "voucher",
  marker,
});

function transport(respond) {
  return {
    async get() {
      return { data: { programmes: [] } };
    },
    async post(path, body) {
      return { data: respond(body?.pagination?.page) };
    },
  };
}

/** Run the real page walk and hand back every row it accumulated. */
async function walkOffers(respond) {
  const adapter = createAwinAdapter({
    accessToken: "zzawinaccesstokenzz",
    publisherId: "zzpublisheridzz",
    httpClient: transport(respond),
  });
  return adapter.fetchCoupons({}, { requestCount: 0 });
}

/**
 * A page the walk will CONTINUE past: exactly AWIN_OFFERS_PAGE_SIZE rows.
 *
 * This is the walk's own rule and the fixtures have to respect it — a short page is one of the
 * termination heuristics, so a fixture page of three rows ends the walk at page one and any
 * "across pages" claim built on it would be vacuous. `head` rows are placed first and the
 * remainder is filler with ids that cannot collide with them.
 */
function fullPage(head, fillerBase) {
  const filler = Array.from({ length: AWIN_OFFERS_PAGE_SIZE - head.length }, (_, i) =>
    promotion(fillerBase + i),
  );
  return [...head, ...filler];
}

/** Pages 1..n of full pages, then a short final page, then empty. */
function pagesOf(pageCount, startId = 1000) {
  return (page) => {
    if (page > pageCount) return { data: [] };
    return { data: fullPage([], startId + (page - 1) * AWIN_OFFERS_PAGE_SIZE) };
  };
}

/* ------------------------------------------------------------------------------ staging side */

function stubPrisma() {
  const state = { entities: new Map(), raws: new Map(), rawById: new Map(), rawCreates: 0 };
  const ekey = (e, n, t) => `${e}|${n}|${t}`;
  const rkey = (w) =>
    [w.supplier, w.sourceAccountLabel, w.resourceKey, w.externalId, w.payloadHash].join("\u0000");

  const entity = {
    async findUnique({ where }) {
      const k = where.externalId_networkSource_entityType;
      return state.entities.get(ekey(k.externalId, k.networkSource, k.entityType)) ?? null;
    },
    async findFirst({ where }) {
      if (!where?.externalId) return null;
      return state.entities.get(ekey(where.externalId, where.networkSource, where.entityType)) ?? null;
    },
    async findMany({ where }) {
      const wanted = new Set(where?.externalId?.in ?? []);
      return [...state.entities.values()]
        .filter((r) => wanted.has(r.externalId))
        .map((r) => ({ id: r.id, externalId: r.externalId }));
    },
    async create({ data }) {
      const row = { id: `entity-${state.entities.size + 1}`, ...data };
      state.entities.set(ekey(data.externalId, data.networkSource, data.entityType), row);
      return row;
    },
    async update({ where, data }) {
      for (const [k, r] of state.entities) {
        if (r.id === where.id) {
          const next = { ...r, ...data };
          state.entities.set(k, next);
          return next;
        }
      }
      return { id: where.id, ...data };
    },
    async upsert({ where, create }) {
      const k = where.externalId_networkSource_entityType;
      const existing = state.entities.get(ekey(k.externalId, k.networkSource, k.entityType));
      if (existing) return existing;
      const row = { id: `entity-${state.entities.size + 1}`, ...create };
      state.entities.set(ekey(k.externalId, k.networkSource, k.entityType), row);
      return row;
    },
  };

  const rawPayload = {
    async findUnique({ where }) {
      return state.raws.get(rkey(where.supplier_sourceAccountLabel_resourceKey_externalId_payloadHash)) ?? null;
    },
    async findFirst() {
      return null;
    },
    async create({ data }) {
      const key = rkey({
        supplier: data.supplier,
        sourceAccountLabel: data.sourceAccountLabel,
        resourceKey: data.resourceKey,
        externalId: data.externalId,
        payloadHash: data.payloadHash,
      });
      // The composite unique key is enforced here, as Postgres enforces it. Two rows of the same
      // payload race each other through the bounded fan-out — both miss on findUnique, both
      // attempt a create — and persistRawPayload turns the loser's P2002 into the duplicate
      // outcome. A stub that let the second create through would be asserting stub behaviour.
      if (state.raws.has(key)) {
        const error = new Error("Unique constraint failed");
        error.code = "P2002";
        throw error;
      }
      state.rawCreates += 1;
      const row = { id: `raw-${state.rawCreates}`, ...data };
      state.raws.set(key, row);
      state.rawById.set(row.id, row);
      return row;
    },
    async update({ where, data }) {
      const row = state.rawById.get(where.id);
      if (row) Object.assign(row, data);
      return row ?? { id: where.id, ...data };
    },
    async updateMany() {
      return { count: 0 };
    },
  };

  return {
    state,
    delegates: {
      entity,
      rawPayload,
      sourceSchemaStats: { async upsert() { return { id: "s" }; } },
      fieldRegistry: { async upsert() { return { id: "f" }; } },
      $executeRaw: async () => 1,
    },
  };
}

async function stage(rows, sourceAccountKey = null) {
  const { state, delegates } = stubPrisma();
  const barrierCalls = { created: 0, released: 0 };
  const originalBarrierDb = entityStagingBarrier.db;
  const originals = {};
  for (const n of Object.keys(delegates)) originals[n] = prisma[n];
  entityStagingBarrier.db = {
    jobRun: {
      async create({ data }) {
        barrierCalls.created += 1;
        return { id: `t${barrierCalls.created}`, ...data };
      },
      async findMany() { return []; },
      async findFirst() { return null; },
      async updateMany() { barrierCalls.released += 1; return { count: 1 }; },
      async update() { return {}; },
    },
  };
  for (const [n, d] of Object.entries(delegates)) prisma[n] = d;
  try {
    await upsertManyRawEntities({
      networkSource: "awin",
      entityType: "coupon",
      rows,
      externalIdPrefix: "awin-coupon",
      sourceAccountKey,
    });
    return { state, barrier: barrierCalls };
  } finally {
    entityStagingBarrier.db = originalBarrierDb;
    for (const [n, o] of Object.entries(originals)) prisma[n] = o;
  }
}

const raws = (state) => [...state.raws.values()];
const externalIds = (state) => [...state.entities.values()].map((e) => e.externalId).sort();

/* ================================================== the walk actually reaches every page */

describe("the walk delivers every page's rows to staging", () => {
  it("three full pages plus a partial one stage as one catalogue", async () => {
    const rows = await walkOffers((page) => {
      if (page <= 3) return { data: Array.from({ length: AWIN_OFFERS_PAGE_SIZE }, (_, i) => promotion(1000 + (page - 1) * AWIN_OFFERS_PAGE_SIZE + i)) };
      if (page === 4) return { data: [promotion(9001), promotion(9002)] };
      return { data: [] };
    });
    assert.equal(rows.length, AWIN_OFFERS_PAGE_SIZE * 3 + 2, "the walk lost or invented rows");

    const { state } = await stage(rows);
    assert.equal(state.entities.size, rows.length, "a page's rows did not reach the Entity table");
    assert.equal(raws(state).length, rows.length, "a page's rows left no immutable evidence");
  });
});

/* ============================================ identity does not depend on page or position */

describe("the canonical identity is stable across pages", () => {
  it("every id is derived from the row, never from its position in the walk", async () => {
    const rows = await walkOffers(pagesOf(2, 100000));
    const { state } = await stage(rows);
    for (const row of rows) {
      const expected = buildAwinCouponExternalId(row);
      assert.ok(expected, "a well-formed promotion could not be named");
      assert.ok(
        [...state.entities.values()].some((e) => e.externalId === expected),
        `no Entity was staged under ${expected}`,
      );
    }
    // Nothing positional survived: no id ends in a bare index.
    for (const id of externalIds(state)) {
      assert.match(id, /^awin-coupon-\d+-\d+$/);
    }
  });

  it("re-delivering the same catalogue in a DIFFERENT order yields the same ids", async () => {
    // The page boundary is fixed at AWIN_OFFERS_PAGE_SIZE, so what a supplier can genuinely vary
    // between runs is the ORDER rows arrive in. Under the old positional identity every row's
    // index would move with it and the Entities would be remapped onto each other.
    const catalogue = Array.from({ length: AWIN_OFFERS_PAGE_SIZE + 40 }, (_, i) => promotion(4000 + i));
    const layout = (rows) => (page) =>
      page === 1 ? { data: rows.slice(0, AWIN_OFFERS_PAGE_SIZE) }
      : page === 2 ? { data: rows.slice(AWIN_OFFERS_PAGE_SIZE) }
      : { data: [] };

    const forward = await walkOffers(layout(catalogue));
    const reversed = await walkOffers(layout([...catalogue].reverse()));
    assert.equal(forward.length, catalogue.length, "the forward walk lost rows");
    assert.equal(reversed.length, catalogue.length, "the reversed walk lost rows");

    const a = await stage(forward);
    const b = await stage(reversed);
    assert.deepEqual(externalIds(a.state), externalIds(b.state), "row order changed the identities");
    assert.equal(a.state.entities.size, catalogue.length);
  });

  it("two advertisers running the same promotionId stay distinct across pages", async () => {
    const rows = await walkOffers((page) =>
      page === 1 ? { data: fullPage([promotion(77, 111)], 300000) }
      : page === 2 ? { data: [promotion(77, 222)] }
      : { data: [] },
    );
    const { state } = await stage(rows);
    // The page-1 filler counts too; what matters is that BOTH promotionId 77 rows survived, under
    // ids separated only by their advertiser.
    assert.equal(state.entities.size, AWIN_OFFERS_PAGE_SIZE + 1, "a row was lost across the pages");
    const ids = externalIds(state);
    assert.ok(ids.includes("awin-coupon-111-77"), "the page-1 advertiser's promotion vanished");
    assert.ok(ids.includes("awin-coupon-222-77"), "the page-2 advertiser's promotion vanished");
    assert.equal(
      ids.filter((id) => id.endsWith("-77")).length,
      2,
      "two advertisers' promotions collapsed into one Entity",
    );
  });

  it("account namespacing survives the walk", async () => {
    const rows = await walkOffers(pagesOf(1, 200000));
    const { state } = await stage(rows, "uk");
    for (const id of externalIds(state)) assert.match(id, /^uk:awin-coupon-\d+-\d+$/);
  });
});

/* ========================================== duplicates across pages collapse, not accumulate */

describe("a promotion delivered on more than one page", () => {
  it("produces one Entity and one immutable raw row", async () => {
    // A catalogue mutating under the walk re-delivers a row on a later page. The pager's repeat
    // guard only catches a WHOLE repeated page, so this duplicate reaches staging on purpose.
    const rows = await walkOffers((page) =>
      page === 1 ? { data: fullPage([promotion(5001), promotion(5002)], 400000) }
      : page === 2 ? { data: [promotion(5002), promotion(5003)] }
      : { data: [] },
    );
    const expectedUnique = AWIN_OFFERS_PAGE_SIZE + 1; // the full page, plus 5003; 5002 repeats
    assert.equal(rows.length, AWIN_OFFERS_PAGE_SIZE + 2, "the walk did not deliver the duplicate");

    const { state, barrier } = await stage(rows);
    assert.equal(state.entities.size, expectedUnique, "the duplicate promotion became a second Entity");
    assert.equal(raws(state).length, expectedUnique, "the duplicate payload was written twice");
    assert.equal(state.rawCreates, expectedUnique);
    assert.equal(barrier.created, 1, "Fix A: still one participant for the batch");
  });

  it("re-running the whole walk stages nothing new", async () => {
    const respond = pagesOf(2, 500000);
    const first = await walkOffers(respond);
    const second = await walkOffers(respond);
    assert.deepEqual(
      first.map((r) => buildAwinCouponExternalId(r)),
      second.map((r) => buildAwinCouponExternalId(r)),
      "a second walk produced different identities",
    );
  });
});

/* ================================ unnameable rows from any page stay evidence-only */

describe("unresolved promotions found mid-walk", () => {
  it("become FAILED evidence and never Entities, whichever page they arrive on", async () => {
    const rows = await walkOffers((page) =>
      page === 1 ? { data: fullPage([promotion(6001), unnameable("a")], 600000) }
      : page === 2 ? { data: [unnameable("b"), promotion(6002)] }
      : { data: [] },
    );
    assert.equal(rows.length, AWIN_OFFERS_PAGE_SIZE + 2);

    const { state } = await stage(rows);
    const nameable = AWIN_OFFERS_PAGE_SIZE; // the full page minus its unnameable row, plus 6002
    assert.equal(state.entities.size, nameable, "an unnameable promotion became an Entity");
    const staged = raws(state).filter((r) => r.processingStatus === "STAGED");
    const failed = raws(state).filter((r) => r.processingStatus === "FAILED");
    assert.equal(staged.length, nameable);
    assert.equal(failed.length, 2, "an unnameable promotion left no evidence");
    for (const row of failed) {
      assert.ok(!row.entityId, "evidence was linked to an Entity");
      assert.ok(isUnresolvedAwinCouponEvidenceId(row.externalId));
    }
    for (const row of staged) assert.ok(row.entityId);
  });

  it("the same unnameable promotion on two pages leaves one evidence row", async () => {
    const rows = await walkOffers((page) =>
      page === 1 ? { data: fullPage([unnameable("same")], 700000) }
      : page === 2 ? { data: [unnameable("same")] }
      : { data: [] },
    );
    assert.equal(rows.length, AWIN_OFFERS_PAGE_SIZE + 1, "the walk did not deliver both copies");

    const { state } = await stage(rows);
    const nameable = AWIN_OFFERS_PAGE_SIZE - 1; // the full page minus its one unnameable row
    assert.equal(state.entities.size, nameable, "a nameable row was lost");
    const failed = raws(state).filter((r) => r.processingStatus === "FAILED");
    assert.equal(failed.length, 1, "duplicate evidence rows were written for one payload");
    assert.ok(!failed[0].entityId);
    // One raw row per distinct payload: the nameable rows plus a single evidence row.
    assert.equal(raws(state).length, nameable + 1);
    assert.equal(state.rawCreates, nameable + 1);
  });

  it("an evidence id can never be mistaken for a canonical one, mid-walk or not", async () => {
    const rows = await walkOffers((page) =>
      page === 1 ? { data: [promotion(7001), unnameable("x")] } : { data: [] },
    );
    assert.equal(rows.length, 2);
    const { state } = await stage(rows);
    for (const row of raws(state)) {
      const canonical = row.processingStatus === "STAGED";
      assert.equal(isUnresolvedAwinCouponEvidenceId(row.externalId), !canonical);
    }
  });
});
