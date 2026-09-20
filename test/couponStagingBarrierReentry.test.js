/**
 * Fix A — the coupon staging path stops re-entering the Entity-staging barrier once per row.
 *
 * upsertManyRawEntities takes ONE participant for the whole batch. upsertCouponRows then reached
 * upsertRawEntity once per row, and every one of those rows announced a participant of its own:
 * a JobRun insert, the freeze read that follows it, and a JobRun update to release it. Three extra
 * round trips per coupon, against a participant table that grew by one row per coupon and was
 * re-read by the next coupon's freeze check.
 *
 * Trackier's 116 coupons exhausted a 300s Vercel invocation on that, leaving 116 RawPayload rows
 * at RECEIVED with entityId NULL and zero coupon Entities — while the NetworkSyncRun said SUCCESS,
 * because that run only ever measures the supplier fetch. Campaigns were unaffected: they take the
 * bulk INSERT … ON CONFLICT path, which never calls upsertRawEntity at all.
 *
 * The barrier itself is unchanged, and so is its guarantee: the batch participant still covers
 * every row, and the freeze is still evaluated once before any row runs. What is gone is a
 * re-entry that protected nothing — a row inside an already-registered batch cannot be the stager
 * a freeze needs to see, because the batch is.
 *
 * These tests drive the REAL functions. The barrier's database and the Prisma model delegates are
 * stubbed, so every assertion is about observed calls rather than about source text.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { entityStagingBarrier } from "../src/jobs/entityStagingBarrier.js";
import { prisma } from "../src/database/prisma.js";
import { upsertManyRawEntities, upsertRawEntity } from "../src/modules/raw/raw.service.js";

const RAW_SRC = readFileSync(new URL("../src/modules/raw/raw.service.js", import.meta.url), "utf8");
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* ------------------------------------------------------------------------------- the harness */

/** A JobRun store that counts what the barrier does, and never reports a freeze. */
function countingBarrierDb() {
  const calls = { created: 0, released: 0, freezeReads: 0 };
  return {
    calls,
    jobRun: {
      async create({ data }) {
        calls.created += 1;
        return { id: `ticket-${calls.created}`, ...data };
      },
      async findMany() {
        calls.freezeReads += 1;
        return [];
      },
      async findFirst() {
        calls.freezeReads += 1;
        return null;
      },
      async updateMany() {
        calls.released += 1;
        return { count: 1 };
      },
      async update() {
        return {};
      },
    },
  };
}

/**
 * Stub the Prisma model delegates the staging path touches. Entities live in a Map keyed by the
 * unique triple, so a create followed by a second stage of the same row behaves like the database.
 */
function stubPrisma({ failEntityWrites = false } = {}) {
  const state = { entities: new Map(), rawPayloads: [], entityCreates: 0, bulkStatements: 0 };
  const key = (externalId, networkSource, entityType) => `${externalId}|${networkSource}|${entityType}`;

  const entity = {
    async findUnique({ where }) {
      const k = where.externalId_networkSource_entityType;
      return state.entities.get(key(k.externalId, k.networkSource, k.entityType)) ?? null;
    },
    async findFirst({ where }) {
      if (!where?.externalId) return null;
      return state.entities.get(key(where.externalId, where.networkSource, where.entityType)) ?? null;
    },
    async create({ data }) {
      if (failEntityWrites) throw new Error("zzentitywritefailedzz");
      state.entityCreates += 1;
      const row = { id: `entity-${state.entityCreates}`, ...data };
      state.entities.set(key(data.externalId, data.networkSource, data.entityType), row);
      return row;
    },
    async update({ where, data }) {
      for (const [k, row] of state.entities) {
        if (row.id === where.id) {
          const next = { ...row, ...data };
          state.entities.set(k, next);
          return next;
        }
      }
      return { id: where.id, ...data };
    },
    async upsert({ where, create }) {
      const k = where.externalId_networkSource_entityType;
      const existing = state.entities.get(key(k.externalId, k.networkSource, k.entityType));
      if (existing) return existing;
      state.entityCreates += 1;
      const row = { id: `entity-${state.entityCreates}`, ...create };
      state.entities.set(key(k.externalId, k.networkSource, k.entityType), row);
      return row;
    },
  };

  const rawPayload = {
    async findUnique() {
      return null;
    },
    async findFirst() {
      return null;
    },
    async create({ data }) {
      state.rawPayloads.push({ id: `raw-${state.rawPayloads.length + 1}`, ...data });
      return state.rawPayloads[state.rawPayloads.length - 1];
    },
    async update({ where, data }) {
      const row = state.rawPayloads.find((entry) => entry.id === where.id);
      if (row) Object.assign(row, data);
      return row ?? { id: where.id, ...data };
    },
  };

  // The bulk writer is a tagged template on the client itself, not a model delegate. Stubbed so
  // the non-coupon path can be exercised rather than only asserted in source.
  const $executeRaw = async () => {
    state.bulkStatements += 1;
    return state.bulkStatements;
  };

  return { state, delegates: { entity, rawPayload, $executeRaw } };
}

/** Swap the barrier's db and the Prisma delegates for one call, and always put them back. */
async function withStubs(options, fn) {
  const barrierDb = countingBarrierDb();
  const { state, delegates } = stubPrisma(options);
  const originalBarrierDb = entityStagingBarrier.db;
  const originals = {};
  for (const name of Object.keys(delegates)) originals[name] = prisma[name];
  entityStagingBarrier.db = barrierDb;
  for (const [name, delegate] of Object.entries(delegates)) prisma[name] = delegate;
  try {
    const returned = await fn({ barrier: barrierDb.calls, state });
    return { barrier: barrierDb.calls, state, returned };
  } finally {
    entityStagingBarrier.db = originalBarrierDb;
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
  }
}

const couponRow = (id) => ({ id: `zzc${id}zz`, record_source: "coupon", code: `ZZCODE${id}ZZ`, campaign_id: 77 });

/* ============================================================ the defect this fix removes */

describe("Fix A — one barrier entry per coupon BATCH, not per row", () => {
  it("ten coupon rows enter the barrier exactly once", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => couponRow(i));
    const { barrier, state } = await withStubs({}, () =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "coupon",
        rows,
        externalIdPrefix: "trackier-coupon",
        sourceAccountKey: null,
      }),
    );
    // Before this fix: 1 for the batch plus one per row.
    assert.equal(barrier.created, 1, "the barrier was entered once per row");
    assert.equal(barrier.released, 1, "the participant count and the release count must match");
    assert.equal(state.entityCreates, 10, "every coupon must still be staged");
  });

  it("the batch entry scales with batches, not with rows", async () => {
    for (const size of [1, 5, 25]) {
      const rows = Array.from({ length: size }, (_, i) => couponRow(i));
      // eslint-disable-next-line no-await-in-loop
      const { barrier, state } = await withStubs({}, () =>
        upsertManyRawEntities({
          networkSource: "trackier",
          entityType: "coupon",
          rows,
          externalIdPrefix: "trackier-coupon",
          sourceAccountKey: null,
        }),
      );
      assert.equal(barrier.created, 1, `${size} rows entered the barrier ${barrier.created} times`);
      assert.equal(state.entityCreates, size);
    }
  });

  it("the coupon Entity is created, and STAGED lineage follows it carrying entityId", async () => {
    const { state } = await withStubs({}, () =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "coupon",
        rows: [couponRow(1)],
        externalIdPrefix: "trackier-coupon",
        sourceAccountKey: null,
      }),
    );
    const entity = [...state.entities.values()][0];
    assert.ok(entity, "no coupon Entity was created");
    assert.equal(entity.entityType, "coupon");
    assert.equal(entity.networkSource, "trackier");

    // The transition the timed-out run never reached: RECEIVED first, then STAGED with the id.
    const staged = state.rawPayloads.filter((row) => row.processingStatus === "STAGED");
    assert.ok(staged.length >= 1, "no STAGED lineage was written");
    assert.equal(staged.at(-1).entityId, entity.id, "STAGED lineage did not carry the Entity id");
    const received = state.rawPayloads.filter((row) => row.processingStatus === "RECEIVED");
    assert.ok(received.length >= 1, "RECEIVED lineage is no longer written");
  });
});

/* ====================================================== the default, and the failure path */

describe("Fix A — direct callers are unchanged", () => {
  it("upsertRawEntity without the flag still registers a participant and releases it", async () => {
    const { barrier, state } = await withStubs({}, () =>
      upsertRawEntity({
        networkSource: "manual",
        entityType: "coupon",
        rawData: couponRow(9),
        externalId: "manual-coupon-9",
      }),
    );
    assert.equal(barrier.created, 1, "a direct caller stopped registering");
    assert.equal(barrier.released, 1);
    assert.ok(barrier.freezeReads > 0, "the freeze is no longer evaluated for a direct caller");
    assert.equal(state.entityCreates, 1);
  });

  it("upsertRawEntity WITH the flag registers nothing and still stages the row", async () => {
    const { barrier, state } = await withStubs({}, () =>
      upsertRawEntity({
        networkSource: "trackier",
        entityType: "coupon",
        rawData: couponRow(8),
        externalId: "trackier-coupon-coupon-8",
        alreadyStaged: true,
      }),
    );
    assert.equal(barrier.created, 0, "the flagged path still took a participant");
    assert.equal(barrier.released, 0);
    assert.equal(barrier.freezeReads, 0, "the flagged path re-evaluated the freeze");
    assert.equal(state.entityCreates, 1, "the row was not staged");
  });

  it("the flag never reaches the staging body as data", () => {
    // Destructured off before stageRawEntity is called, so it cannot leak into a rawData spread
    // or an unexpected column.
    const code = codeOnly(RAW_SRC);
    assert.match(code, /const \{ alreadyStaged = false, \.\.\.staging \} = options \?\? \{\};/);
    assert.match(code, /if \(alreadyStaged\) return stageRawEntity\(staging\);/);
    assert.match(code, /\(\) => stageRawEntity\(staging\),/);
    const body = code.split("async function stageRawEntity({")[1].split("}) {")[0];
    assert.ok(!body.includes("alreadyStaged"), "the flag became a staging parameter");
  });

  it("a throw inside the batch still releases the outer participant", async () => {
    const { barrier } = await withStubs({ failEntityWrites: true }, async () => {
      await assert.rejects(
        () =>
          upsertManyRawEntities({
            networkSource: "trackier",
            entityType: "coupon",
            rows: [couponRow(1), couponRow(2)],
            externalIdPrefix: "trackier-coupon",
            sourceAccountKey: null,
          }),
        /zzentitywritefailedzz/,
      );
      return null;
    });
    assert.equal(barrier.created, 1);
    assert.equal(barrier.released, 1, "the participant leaked when the batch threw");
  });

  it("a throw in a direct call releases its participant too", async () => {
    const { barrier } = await withStubs({ failEntityWrites: true }, async () => {
      await assert.rejects(
        () =>
          upsertRawEntity({
            networkSource: "manual",
            entityType: "coupon",
            rawData: couponRow(3),
            externalId: "manual-coupon-3",
          }),
        /zzentitywritefailedzz/,
      );
      return null;
    });
    assert.equal(barrier.created, 1);
    assert.equal(barrier.released, 1);
  });
});

/* ============================================================= the blast radius of the fix */

describe("Fix A — nothing else changed", () => {
  it("the barrier is still the chokepoint both entrypoints register with", () => {
    const code = codeOnly(RAW_SRC);
    for (const entry of ["upsertRawEntity", "upsertManyRawEntities"]) {
      const body = code.split(`export async function ${entry}(options)`)[1].split("\n}\n")[0];
      assert.ok(body.includes("entityStagingBarrier.withStaging("), `${entry} no longer registers`);
    }
    assert.ok(!code.includes("export async function stageRawEntity"), "the unguarded body is exported");
    assert.ok(!code.includes("export async function stageManyRawEntities"), "the unguarded body is exported");
  });

  it("both upsertCouponRows call sites are inside the batch participant, and say so", () => {
    const code = codeOnly(RAW_SRC);
    assert.equal((code.match(/alreadyStaged: true,/g) ?? []).length, 2, "one per call site");
    const batch = code.split("export async function upsertManyRawEntities(options)")[1].split("\n}\n")[0];
    assert.match(batch, /entityStagingBarrier\.withStaging\(/, "the batch no longer holds the participant");
  });

  it("the coupon merge path is untouched — no bulk SQL, no identity change", () => {
    const code = codeOnly(RAW_SRC);
    const coupons = code.split("async function upsertCouponRows({")[1].split("\n}\n")[0];
    assert.match(coupons, /await upsertRawEntity\(\{/, "the per-row merge was replaced");
    for (const forbidden of ["$executeRaw", "ON CONFLICT", "batchUpsertEntities"]) {
      assert.ok(!coupons.includes(forbidden), `${forbidden} entered the coupon path`);
    }
    // Identity is resolved and account-namespaced exactly as before. Asserted through the shape
    // this change is responsible for, not through whichever identity rule happens to be in the
    // file: this commit adds one flag and must not be pinned to another commit's symbols.
    assert.match(coupons, /withAccountScopedExternalId\(/, "account namespacing left the coupon path");
    assert.match(coupons, /externalId:/, "the coupon path stopped resolving an externalId");
    // Comments are stripped, so this counts code only: the parameter, and the forward to
    // upsertRawEntity. The flag is the entire footprint of this change inside the coupon path.
    assert.equal((coupons.match(/alreadyStaged/g) ?? []).length, 2);
    assert.match(coupons, /alreadyStaged = false,/);
    assert.match(coupons, /alreadyStaged,\n\s*\}\);/);
  });

  it("non-coupon staging still goes through the bulk path, untouched", async () => {
    const { barrier, state } = await withStubs({}, () =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "campaign",
        rows: [{ id: "zzcamp1zz" }, { id: "zzcamp2zz" }],
        externalIdPrefix: "trackier-campaign",
        sourceAccountKey: null,
      }),
    );
    assert.equal(barrier.created, 1, "the campaign batch changed its barrier usage");
    assert.equal(barrier.released, 1);
    // One bulk statement for the chunk, and no per-row Entity write: the campaign path never
    // touched upsertRawEntity before this fix and must not start now.
    assert.equal(state.bulkStatements, 1, "the campaign path stopped using the bulk writer");
    assert.equal(state.entityCreates, 0, "a campaign row went through the per-row coupon writer");
  });

  it("no planner, orchestration or schema change rides along", () => {
    for (const forbidden of ["plannerVersion", "PLANNER_VERSION", "ALTER TABLE", "archivedAt", "JobRun("]) {
      assert.ok(!RAW_SRC.includes(forbidden), `${forbidden} in raw.service.js`);
    }
  });
});
