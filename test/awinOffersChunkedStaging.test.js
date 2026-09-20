/**
 * Staging 5,000 Awin promotions without staging them all at once.
 *
 * The page walk now returns a whole catalogue: production fetched 25 full pages, reported PARTIAL
 * at the cap truthfully, and then died staging the 5,000 rows in one upsertManyRawEntities call.
 *
 * Chunking does not make that work smaller. What these tests pin is what it does buy — progress
 * that survives a kill, a cost that can be measured per 200 rows, and a failure that is reported
 * rather than inferred — and, just as importantly, everything it must NOT disturb: identity across
 * chunk boundaries, idempotency, FAILED evidence, the fetch's own PARTIAL verdict, and Trackier.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entityStagingBarrier } from "../src/jobs/entityStagingBarrier.js";
import { prisma } from "../src/database/prisma.js";
import {
  AWIN_OFFERS_STAGE_CHUNK_SIZE,
  chunkRows,
  stageAwinOfferRows,
  stagedCompletely,
} from "../src/jobs/awinOffersStaging.js";
import {
  upsertManyRawEntities,
  buildAwinCouponExternalId,
  isUnresolvedAwinCouponEvidenceId,
} from "../src/modules/raw/raw.service.js";

/* ------------------------------------------------------------------------------------- rows */

const promotion = (promotionId, advertiserId = 998877) => ({
  promotionId,
  advertiser: { id: advertiserId, name: "zzadvertisernamezz" },
  type: "voucher",
  voucher: { code: "zzvouchercodezz" },
});
const unnameable = (marker) => ({ advertiser: { name: "zzadvertisernamezz" }, type: "voucher", marker });

/** What a full 25-page walk hands staging. */
const catalogue = (n = 5000) => Array.from({ length: n }, (_, i) => promotion(10000 + i));

/* ---------------------------------------------------------------------------------- the db */

function stubPrisma() {
  const state = { entities: new Map(), raws: new Map(), rawById: new Map(), rawCreates: 0, trips: 0 };
  const ekey = (e, n, t) => `${e}|${n}|${t}`;
  const rkey = (w) =>
    [w.supplier, w.sourceAccountLabel, w.resourceKey, w.externalId, w.payloadHash].join("\u0000");

  const entity = {
    async findUnique({ where }) {
      state.trips += 1;
      const k = where.externalId_networkSource_entityType;
      return state.entities.get(ekey(k.externalId, k.networkSource, k.entityType)) ?? null;
    },
    async findFirst({ where }) {
      state.trips += 1;
      if (!where?.externalId) return null;
      return state.entities.get(ekey(where.externalId, where.networkSource, where.entityType)) ?? null;
    },
    async findMany({ where }) {
      state.trips += 1;
      const wanted = new Set(where?.externalId?.in ?? []);
      return [...state.entities.values()]
        .filter((r) => wanted.has(r.externalId))
        .map((r) => ({ id: r.id, externalId: r.externalId }));
    },
    async create({ data }) {
      state.trips += 1;
      const row = { id: `entity-${state.entities.size + 1}`, ...data };
      state.entities.set(ekey(data.externalId, data.networkSource, data.entityType), row);
      return row;
    },
    async update({ where, data }) {
      state.trips += 1;
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
      state.trips += 1;
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
      state.trips += 1;
      return state.raws.get(rkey(where.supplier_sourceAccountLabel_resourceKey_externalId_payloadHash)) ?? null;
    },
    async findFirst() {
      state.trips += 1;
      return null;
    },
    async create({ data }) {
      state.trips += 1;
      const key = rkey({
        supplier: data.supplier,
        sourceAccountLabel: data.sourceAccountLabel,
        resourceKey: data.resourceKey,
        externalId: data.externalId,
        payloadHash: data.payloadHash,
      });
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
      state.trips += 1;
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

/** Install the stubs and a counting barrier for one call. */
async function withDb(fn) {
  const { state, delegates } = stubPrisma();
  const barrier = { created: 0, released: 0 };
  const originalBarrierDb = entityStagingBarrier.db;
  const originals = {};
  for (const n of Object.keys(delegates)) originals[n] = prisma[n];
  entityStagingBarrier.db = {
    jobRun: {
      async create({ data }) {
        barrier.created += 1;
        return { id: `t${barrier.created}`, ...data };
      },
      async findMany() { return []; },
      async findFirst() { return null; },
      async updateMany() { barrier.released += 1; return { count: 1 }; },
      async update() { return {}; },
    },
  };
  for (const [n, d] of Object.entries(delegates)) prisma[n] = d;
  try {
    const returned = await fn({ state });
    return { state, barrier, returned };
  } finally {
    entityStagingBarrier.db = originalBarrierDb;
    for (const [n, o] of Object.entries(originals)) prisma[n] = o;
  }
}

const raws = (state) => [...state.raws.values()];

/* ================================================================ 1. the split itself */

describe("5,000 rows become bounded chunks", () => {
  it("splits into 25 chunks of 200, losing and inventing nothing", () => {
    const rows = catalogue(5000);
    const chunks = chunkRows(rows);
    assert.equal(AWIN_OFFERS_STAGE_CHUNK_SIZE, 200);
    assert.equal(chunks.length, 25);
    assert.deepEqual(new Set(chunks.map((c) => c.length)), new Set([200]));
    assert.equal(chunks.flat().length, rows.length);
    assert.deepEqual(chunks.flat(), rows, "order or content changed");
  });

  it("a ragged tail keeps its own smaller chunk", () => {
    assert.deepEqual(chunkRows(catalogue(450)).map((c) => c.length), [200, 200, 50]);
    assert.deepEqual(chunkRows(catalogue(1)).map((c) => c.length), [1]);
    assert.deepEqual(chunkRows([]).length, 0);
  });

  it("each chunk carries identical staging parameters", async () => {
    const seen = [];
    await stageAwinOfferRows({
      rows: catalogue(600),
      sourceAccountKey: "uk",
      evidence: { syncRunId: "zzrunzz", sourceObject: "offers" },
      stage: async (args) => { seen.push(args); },
    });
    assert.equal(seen.length, 3);
    for (const args of seen) {
      assert.equal(args.networkSource, "awin");
      assert.equal(args.entityType, "coupon");
      assert.equal(args.externalIdPrefix, "awin-coupon");
      assert.equal(args.sourceAccountKey, "uk");
      assert.deepEqual(args.evidence, { syncRunId: "zzrunzz", sourceObject: "offers" });
    }
  });
});

/* ============================================ 2. every row staged exactly once, end to end */

describe("staging the whole catalogue through the real path", () => {
  it("stages every row exactly once across chunk boundaries", async () => {
    const rows = catalogue(1000); // 5 chunks
    const { state, returned } = await withDb(() => stageAwinOfferRows({ rows }));
    assert.equal(returned.chunksTotal, 5);
    assert.equal(returned.chunksCompleted, 5);
    assert.equal(returned.rowsStaged, 1000);
    assert.ok(stagedCompletely(returned));
    assert.equal(state.entities.size, 1000, "a row was lost or staged twice");
    assert.equal(raws(state).length, 1000);
    assert.equal(state.rawCreates, 1000);
  });

  it("identities are the canonical ones, unmoved by where a chunk boundary fell", async () => {
    const rows = catalogue(400); // boundary between row 199 and 200
    const { state } = await withDb(() => stageAwinOfferRows({ rows }));
    for (const row of rows) {
      const expected = buildAwinCouponExternalId(row);
      assert.ok(
        [...state.entities.values()].some((e) => e.externalId === expected),
        `chunking moved the identity of promotion at the boundary: ${expected}`,
      );
    }
    // The rows either side of the boundary are exactly the ones the catalogue named.
    assert.ok([...state.entities.values()].some((e) => e.externalId === buildAwinCouponExternalId(rows[199])));
    assert.ok([...state.entities.values()].some((e) => e.externalId === buildAwinCouponExternalId(rows[200])));
  });

  it("account namespacing survives every chunk", async () => {
    const { state } = await withDb(() => stageAwinOfferRows({ rows: catalogue(300), sourceAccountKey: "uk" }));
    for (const e of state.entities.values()) assert.match(e.externalId, /^uk:awin-coupon-\d+-\d+$/);
  });

  it("every raw row reaches STAGED with an entity link", async () => {
    const { state } = await withDb(() => stageAwinOfferRows({ rows: catalogue(400) }));
    const ids = new Set([...state.entities.values()].map((e) => e.id));
    for (const row of raws(state)) {
      assert.equal(row.processingStatus, "STAGED");
      assert.ok(ids.has(row.entityId), "a raw row lost its Entity linkage across a chunk");
    }
  });
});

/* =========================================== 3. duplicates and re-runs stay idempotent */

describe("idempotency across chunks and re-runs", () => {
  it("the same promotion in two different chunks yields one Entity and one raw row", async () => {
    const rows = [...catalogue(250), promotion(10000), promotion(10249)]; // both already in chunk 1/2
    const { state, returned } = await withDb(() => stageAwinOfferRows({ rows }));
    assert.equal(returned.rowsStaged, rows.length);
    assert.equal(state.entities.size, 250, "a cross-chunk duplicate became a second Entity");
    assert.equal(state.rawCreates, 250, "a cross-chunk duplicate was written twice");
  });

  it("re-staging the whole catalogue creates nothing new", async () => {
    const rows = catalogue(400);
    const { state } = await withDb(async () => {
      await stageAwinOfferRows({ rows });
      await stageAwinOfferRows({ rows });
    });
    assert.equal(state.entities.size, 400);
    assert.equal(state.rawCreates, 400, "a re-run duplicated immutable evidence");
  });

  it("a re-run costs fewer round trips than the first, which is what makes resuming viable", async () => {
    const rows = catalogue(200);
    let first = 0;
    const { state } = await withDb(async ({ state: live }) => {
      await stageAwinOfferRows({ rows });
      first = live.trips;
      live.trips = 0;
      await stageAwinOfferRows({ rows });
    });
    assert.ok(first > 0);
    assert.ok(state.trips < first, `a re-run cost ${state.trips} trips against a first run's ${first}`);
  });
});

/* ================================================= 4. unresolved rows stay evidence-only */

describe("unresolved promotions in any chunk", () => {
  it("become FAILED evidence only, and never Entities", async () => {
    const rows = [...catalogue(199), unnameable("a"), ...catalogue(100).map((r) => promotion(r.promotionId + 50000)), unnameable("b")];
    const { state } = await withDb(() => stageAwinOfferRows({ rows }));
    const failed = raws(state).filter((r) => r.processingStatus === "FAILED");
    const staged = raws(state).filter((r) => r.processingStatus === "STAGED");
    assert.equal(failed.length, 2, "an unnameable row was dropped or duplicated");
    assert.equal(staged.length, 299);
    assert.equal(state.entities.size, 299, "an unnameable row became an Entity");
    for (const row of failed) {
      assert.ok(!row.entityId);
      assert.ok(isUnresolvedAwinCouponEvidenceId(row.externalId));
    }
  });

  it("the same unnameable payload in two chunks leaves one evidence row", async () => {
    const rows = [unnameable("same"), ...catalogue(199), unnameable("same")];
    const { state } = await withDb(() => stageAwinOfferRows({ rows }));
    assert.equal(raws(state).filter((r) => r.processingStatus === "FAILED").length, 1);
    assert.equal(state.entities.size, 199);
  });
});

/* =============================== 5. the fetch's verdict is not rewritten by staging */

describe("the supplier fetch keeps its own verdict", () => {
  it("no chunk is allowed to finalize the NetworkSyncRun", async () => {
    const seen = [];
    await stageAwinOfferRows({
      rows: catalogue(600),
      evidence: { syncRunId: "zzrunzz" },
      stage: async (args) => { seen.push(args); },
    });
    assert.equal(seen.length, 3);
    for (const args of seen) {
      assert.equal(args.finalizeSyncRun, false, "a chunk would recompute the fetch's status");
    }
  });

  it("the evidence syncRunId still reaches raw lineage — it is suppressed, not dropped", async () => {
    const seen = [];
    await stageAwinOfferRows({
      rows: catalogue(200),
      evidence: { syncRunId: "zzrunzz", sourceObject: "offers" },
      stage: async (args) => { seen.push(args); },
    });
    assert.equal(seen[0].evidence.syncRunId, "zzrunzz");
  });
});

/* ========================================= 6. a failed chunk is reported, never inferred away */

describe("a chunk that fails", () => {
  it("stops the walk and reports how far it actually got", async () => {
    let calls = 0;
    const summary = await stageAwinOfferRows({
      rows: catalogue(1000), // 5 chunks
      stage: async () => {
        calls += 1;
        if (calls === 3) throw new Error("zzchunkfailedzz");
      },
    });
    assert.equal(calls, 3, "the runner continued past a failed chunk");
    assert.equal(summary.chunksTotal, 5);
    assert.equal(summary.chunksCompleted, 2);
    assert.equal(summary.rowsStaged, 400);
    assert.equal(summary.failedChunk, 3);
    assert.match(summary.error, /zzchunkfailedzz/);
    assert.equal(stagedCompletely(summary), false, "a partial staging read as complete");
  });

  it("completing every chunk is the only thing that reads as success", async () => {
    const ok = await stageAwinOfferRows({ rows: catalogue(400), stage: async () => {} });
    assert.ok(stagedCompletely(ok));
    assert.equal(ok.failedChunk, null);
    // And the shapes that must NOT read as success.
    assert.equal(stagedCompletely({ ...ok, failedChunk: 2 }), false);
    assert.equal(stagedCompletely({ ...ok, chunksCompleted: ok.chunksTotal - 1 }), false);
    assert.equal(stagedCompletely({ ...ok, rowsStaged: ok.rows - 1 }), false);
    assert.equal(stagedCompletely(null), false);
  });

  it("chunks before the failure are durably staged, which is the point of chunking", async () => {
    const rows = catalogue(600);
    const { state, returned } = await withDb(() =>
      stageAwinOfferRows({
        rows,
        stage: async (args) => {
          if (args.rows[0].promotionId === rows[400].promotionId) throw new Error("zzchunkfailedzz");
          return upsertManyRawEntities(args);
        },
      }),
    );
    assert.equal(returned.failedChunk, 3);
    assert.equal(state.entities.size, 400, "work done before the failure was lost");
  });
});

/* ================================================================ 7. cost instrumentation */

describe("per-chunk cost is measurable", () => {
  it("every chunk reports its own row count and duration, and a running total", async () => {
    const seen = [];
    const summary = await stageAwinOfferRows({
      rows: catalogue(1000),
      stage: async () => {},
      onChunk: (c) => seen.push(c),
    });
    assert.equal(seen.length, 5);
    assert.deepEqual(seen.map((c) => c.chunk), [1, 2, 3, 4, 5]);
    for (const c of seen) {
      assert.equal(c.chunks, 5);
      assert.equal(c.rows, 200);
      assert.ok(Number.isFinite(c.ms) && c.ms >= 0);
      assert.ok(Number.isFinite(c.totalMs) && c.totalMs >= 0);
    }
    // Monotonic: the running total can only grow.
    for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i].totalMs >= seen[i - 1].totalMs);
    assert.equal(summary.totalMs, seen[seen.length - 1].totalMs);
  });

  it("the benchmark line is gated and carries counts and durations only", async () => {
    const lines = [];
    const originalInfo = console.info;
    const originalFlag = process.env.SYNC_UPSERT_BENCHMARK;
    // eslint-disable-next-line no-console
    console.info = (...a) => lines.push(a.map(String).join(" "));
    try {
      delete process.env.SYNC_UPSERT_BENCHMARK;
      await stageAwinOfferRows({ rows: catalogue(400), stage: async () => {} });
      assert.deepEqual(lines.filter((l) => l.startsWith("[sync-chunk]")), [], "leaked with the flag off");

      process.env.SYNC_UPSERT_BENCHMARK = "true";
      await stageAwinOfferRows({ rows: catalogue(400), stage: async () => {} });
      const chunkLines = lines.filter((l) => l.startsWith("[sync-chunk]"));
      assert.equal(chunkLines.length, 2);
      for (const line of chunkLines) {
        assert.match(line, /^\[sync-chunk\] awin:coupon chunk=\d+\/\d+ rows=\d+ ms=\d+ totalMs=\d+$/);
        assert.ok(!/["'{}]/.test(line), "structured data in a diagnostic line");
      }
    } finally {
      // eslint-disable-next-line no-console
      console.info = originalInfo;
      if (originalFlag === undefined) delete process.env.SYNC_UPSERT_BENCHMARK;
      else process.env.SYNC_UPSERT_BENCHMARK = originalFlag;
    }
  });

  it("round trips scale with rows, not with the number of chunks", async () => {
    // If chunking added per-row cost this ratio would drift. It is the basis for extrapolating
    // a real per-200-row measurement up to 5,000 rows.
    const a = await withDb(() => stageAwinOfferRows({ rows: catalogue(200) }));
    const b = await withDb(() => stageAwinOfferRows({ rows: catalogue(400) }));
    const ratio = b.state.trips / a.state.trips;
    assert.ok(ratio > 1.8 && ratio < 2.2, `round trips per row drifted with chunking: ratio ${ratio}`);
  });
});

/* ============================================================ 8. Fix A, and Trackier untouched */

describe("nothing else changed shape", () => {
  it("each chunk takes exactly one staging participant — Fix A per batch, not per row", async () => {
    const { barrier } = await withDb(() => stageAwinOfferRows({ rows: catalogue(600) }));
    assert.equal(barrier.created, 3, "the barrier is no longer one participant per batch");
    assert.equal(barrier.released, 3);
  });

  it("Trackier does not go through Awin chunking and still stages in one batch", async () => {
    const { state, barrier } = await withDb(() =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "coupon",
        rows: Array.from({ length: 223 }, (_, i) => ({
          id: `zzt${i}`,
          record_source: "coupon",
          code: `ZZC${i}`,
          campaign_id: 7,
        })),
        externalIdPrefix: "trackier-coupon",
        sourceAccountKey: null,
      }),
    );
    assert.equal(barrier.created, 1, "Trackier's batch was split or re-entered");
    assert.equal(state.entities.size, 223);
    for (const row of raws(state)) assert.equal(row.processingStatus, "STAGED");
  });

  it("the Awin chunker is not reachable from the Trackier path", () => {
    // It names Awin in its own parameters: it cannot stage another network by construction.
    const seen = [];
    return stageAwinOfferRows({ rows: catalogue(1), stage: async (a) => seen.push(a) }).then(() => {
      assert.equal(seen[0].networkSource, "awin");
      assert.equal(seen[0].externalIdPrefix, "awin-coupon");
    });
  });
});
