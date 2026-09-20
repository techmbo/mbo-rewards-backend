/**
 * Fix B1 — the coupon batch stages the records it already prepared, instead of rebuilding them.
 *
 * Production phase diagnostics located the Trackier timeout precisely: prepare 9ms, RECEIVED
 * persistence 63.6s, schema observation 19.2s, and then no `entities` line at all before the 300s
 * kill. Step 4 — coupon Entity staging — was consuming the remaining ~217s.
 *
 * Part of that was work step 1 and step 2 had already done. upsertCouponRows received the ORIGINAL
 * raw rows, so per coupon it re-resolved the external id, re-scoped it to the account,
 * re-normalized and re-validated the payload, and then asked the database for a RawPayload row
 * that the batch had written seconds earlier and whose outcome it was still holding.
 *
 * The prepared records now travel with the batch. The database consequence is exact and is what
 * these tests measure: one RawPayload lookup per coupon disappears from step 4.
 *
 * What does NOT change: the RECEIVED row is still written for any row the batch pass failed on,
 * the STAGED/entityId lineage is still written per row, upsertCouponFromSync still sees the same
 * merge inputs, direct and CMS callers still prepare and persist exactly as before, and the batch
 * still takes exactly one staging participant.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entityStagingBarrier } from "../src/jobs/entityStagingBarrier.js";
import { prisma } from "../src/database/prisma.js";
import {
  upsertManyRawEntities,
  upsertRawEntity,
  resolveExternalId,
} from "../src/modules/raw/raw.service.js";

/* ------------------------------------------------------------------------------- the harness */

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
 * Prisma delegates that behave like the real tables for the two things under test: the Entity
 * unique triple, and the RawPayload composite unique key persistRawPayload dedupes on. Every call
 * is counted, because the whole point of this fix is how many of them there are.
 */
function stubPrisma({ seedEntities = [] } = {}) {
  const trips = { rawFindUnique: 0, rawCreate: 0, rawUpdate: 0, entityFindUnique: 0, entityCreate: 0, entityUpdate: 0, entityFindMany: 0 };
  const state = { trips, entities: new Map(), raws: new Map(), rawById: new Map() };

  const ekey = (externalId, networkSource, entityType) => `${externalId}|${networkSource}|${entityType}`;
  for (const seed of seedEntities) {
    state.entities.set(ekey(seed.externalId, seed.networkSource, seed.entityType), seed);
  }

  const rkey = (w) =>
    [w.supplier, w.sourceAccountLabel, w.resourceKey, w.externalId, w.payloadHash].join("\u0000");

  const entity = {
    async findUnique({ where }) {
      trips.entityFindUnique += 1;
      const k = where.externalId_networkSource_entityType;
      return state.entities.get(ekey(k.externalId, k.networkSource, k.entityType)) ?? null;
    },
    async findFirst({ where }) {
      trips.entityFindUnique += 1;
      if (!where?.externalId) return null;
      return state.entities.get(ekey(where.externalId, where.networkSource, where.entityType)) ?? null;
    },
    async findMany({ where }) {
      trips.entityFindMany += 1;
      const wanted = new Set(where?.externalId?.in ?? []);
      return [...state.entities.values()]
        .filter((row) => wanted.has(row.externalId))
        .map((row) => ({ id: row.id, externalId: row.externalId }));
    },
    async create({ data }) {
      trips.entityCreate += 1;
      const row = { id: `entity-${trips.entityCreate}`, ...data };
      state.entities.set(ekey(data.externalId, data.networkSource, data.entityType), row);
      return row;
    },
    async update({ where, data }) {
      trips.entityUpdate += 1;
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
      const existing = state.entities.get(ekey(k.externalId, k.networkSource, k.entityType));
      if (existing) return existing;
      trips.entityCreate += 1;
      const row = { id: `entity-${trips.entityCreate}`, ...create };
      state.entities.set(ekey(k.externalId, k.networkSource, k.entityType), row);
      return row;
    },
  };

  const rawPayload = {
    async findUnique({ where }) {
      trips.rawFindUnique += 1;
      const k = where.supplier_sourceAccountLabel_resourceKey_externalId_payloadHash;
      return state.raws.get(rkey(k)) ?? null;
    },
    async findFirst() {
      trips.rawFindUnique += 1;
      return null;
    },
    async create({ data }) {
      trips.rawCreate += 1;
      const row = { id: `raw-${trips.rawCreate}`, ...data };
      state.raws.set(
        rkey({
          supplier: data.supplier,
          sourceAccountLabel: data.sourceAccountLabel,
          resourceKey: data.resourceKey,
          externalId: data.externalId,
          payloadHash: data.payloadHash,
        }),
        row,
      );
      state.rawById.set(row.id, row);
      return row;
    },
    async update({ where, data }) {
      trips.rawUpdate += 1;
      const row = state.rawById.get(where.id);
      if (row) Object.assign(row, data);
      return row ?? { id: where.id, ...data };
    },
    async updateMany() {
      return { count: 0 };
    },
  };

  const sourceSchemaStats = { async upsert() { return { id: "s" }; } };
  const fieldRegistry = { async upsert() { return { id: "f" }; } };
  const $executeRaw = async () => 1;

  return { state, delegates: { entity, rawPayload, sourceSchemaStats, fieldRegistry, $executeRaw } };
}

async function withStubs(options, fn) {
  const barrierDb = countingBarrierDb();
  const { state, delegates } = stubPrisma(options);
  const originalBarrierDb = entityStagingBarrier.db;
  const originalInfo = console.info;
  const originalFlag = process.env.SYNC_UPSERT_BENCHMARK;
  const originals = {};
  for (const name of Object.keys(delegates)) originals[name] = prisma[name];

  const lines = [];
  entityStagingBarrier.db = barrierDb;
  for (const [name, delegate] of Object.entries(delegates)) prisma[name] = delegate;
  if (options.flag === undefined) delete process.env.SYNC_UPSERT_BENCHMARK;
  else process.env.SYNC_UPSERT_BENCHMARK = options.flag;
  // eslint-disable-next-line no-console
  console.info = (...args) => lines.push(args.map(String).join(" "));
  try {
    const returned = await fn({ state });
    return { state, trips: state.trips, barrier: barrierDb.calls, lines, returned };
  } finally {
    // eslint-disable-next-line no-console
    console.info = originalInfo;
    entityStagingBarrier.db = originalBarrierDb;
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
    if (originalFlag === undefined) delete process.env.SYNC_UPSERT_BENCHMARK;
    else process.env.SYNC_UPSERT_BENCHMARK = originalFlag;
  }
}

const couponRow = (i) => ({ id: `zzc${i}`, record_source: "coupon", code: `ZZCODE${i}`, campaign_id: 77 });

/** The id the prepare pass actually resolves, derived rather than guessed. */
const couponExternalId = (i) => resolveExternalId(couponRow(i), "trackier-coupon", i, "coupon");

const stageCoupons = (count, extra = {}) =>
  upsertManyRawEntities({
    networkSource: "trackier",
    entityType: "coupon",
    rows: Array.from({ length: count }, (_, i) => couponRow(i)),
    externalIdPrefix: "trackier-coupon",
    sourceAccountKey: null,
    ...extra,
  });

/* ============================================ 1. the duplicate RECEIVED lookup is gone */

describe("the coupon batch no longer re-reads the RawPayload it just wrote", () => {
  it("performs exactly one RawPayload lookup per row in the batch pass, and one in staging", async () => {
    const N = 8;
    const { trips, state } = await withStubs({}, () => stageCoupons(N));

    // Step 2 writes each row: 1 findUnique (miss) + 1 create.
    // Step 4 now does NOT look the same row up again; only the STAGED persist does.
    // So: N (batch miss) + N (STAGED persist lookup) = 2N, not 3N.
    assert.equal(trips.rawCreate, N, "each coupon must still get exactly one immutable raw row");
    assert.equal(
      trips.rawFindUnique,
      2 * N,
      `expected 2 lookups per row (batch write + STAGED link), saw ${trips.rawFindUnique / N} per row`,
    );
    assert.equal(state.entities.size, N, "every coupon must still be staged");
  });

  it("the saving scales with the batch: exactly one lookup removed per coupon", async () => {
    const perRow = [];
    for (const size of [1, 4, 12]) {
      // eslint-disable-next-line no-await-in-loop
      const { trips } = await withStubs({}, () => stageCoupons(size));
      perRow.push(trips.rawFindUnique / size);
    }
    assert.deepEqual(perRow, [2, 2, 2], "the per-row lookup count must not grow with batch size");
  });

  it("a row whose batch RECEIVED write failed still gets its RECEIVED persist in staging", async () => {
    // rawPayload.create fails for one row, so that row has no record in the batch outcomes.
    const { state, delegates } = stubPrisma();
    const barrierDb = countingBarrierDb();
    const originalBarrierDb = entityStagingBarrier.db;
    const originals = {};
    for (const name of Object.keys(delegates)) originals[name] = prisma[name];
    let failNext = true;
    const guarded = {
      ...delegates.rawPayload,
      async create(args) {
        if (failNext && args.data.externalId.endsWith("zzc0")) {
          failNext = false;
          throw new Error("zzrawcreatefailedzz");
        }
        return delegates.rawPayload.create(args);
      },
    };
    entityStagingBarrier.db = barrierDb;
    for (const [name, delegate] of Object.entries(delegates)) prisma[name] = delegate;
    prisma.rawPayload = guarded;
    try {
      await stageCoupons(3);
      // Row 0 lost its batch write, so staging must have re-attempted RECEIVED for it: that is
      // one extra lookup beyond the 2-per-row the other rows take.
      assert.equal(
        state.trips.rawFindUnique,
        2 * 3 + 1,
        "the row whose RECEIVED write failed did not get a second attempt",
      );
      assert.equal(state.entities.size, 3, "every coupon must still be staged");
    } finally {
      entityStagingBarrier.db = originalBarrierDb;
      for (const [name, original] of Object.entries(originals)) prisma[name] = original;
    }
  });
});

/* ====================================== 2. the prepared record is genuinely reused, not rebuilt */

describe("staging uses the record the batch prepared", () => {
  const SENTINEL = "zzpreparedoncezz";

  it("a supplied prepared record reaches the Entity write untouched", async () => {
    const { state } = await withStubs({}, () =>
      upsertRawEntity({
        networkSource: "trackier",
        entityType: "coupon",
        rawData: couponRow(1),
        externalId: couponExternalId(1),
        preparedRecord: {
          externalId: couponExternalId(1),
          networkSource: "trackier",
          entityType: "coupon",
          rawData: couponRow(1),
          normalizedData: { marker: SENTINEL, code: "ZZCODE1" },
        },
      }),
    );
    const entity = [...state.entities.values()][0];
    assert.equal(
      entity.normalizedData.marker,
      SENTINEL,
      "the record was rebuilt instead of reused — prepare ran twice",
    );
  });

  it("a prepared record for a DIFFERENT identity is ignored and the row is prepared here", async () => {
    for (const mismatch of [
      { externalId: "trackier-coupon-SOMEONE-ELSE" },
      { networkSource: "admitad" },
      { entityType: "campaign" },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { state } = await withStubs({}, () =>
        upsertRawEntity({
          networkSource: "trackier",
          entityType: "coupon",
          rawData: couponRow(2),
          externalId: couponExternalId(2),
          preparedRecord: {
            externalId: couponExternalId(2),
            networkSource: "trackier",
            entityType: "coupon",
            rawData: couponRow(2),
            normalizedData: { marker: SENTINEL },
            ...mismatch,
          },
        }),
      );
      const entity = [...state.entities.values()][0];
      assert.ok(entity, "nothing was staged");
      assert.notEqual(
        entity.normalizedData?.marker,
        SENTINEL,
        `a prepared record with ${JSON.stringify(mismatch)} was reused under the wrong identity`,
      );
    }
  });

  it("the batch stages under exactly the account-scoped ids the prepare pass resolved", async () => {
    const withKey = await withStubs({}, () =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "coupon",
        rows: [couponRow(1), couponRow(2)],
        externalIdPrefix: "trackier-coupon",
        sourceAccountKey: "acct7",
      }),
    );
    const ids = [...withKey.state.entities.values()].map((e) => e.externalId).sort();
    for (const id of ids) {
      assert.ok(id.includes("acct7"), `external id lost its account scope: ${id}`);
    }
    assert.equal(new Set(ids).size, 2, "account-scoped ids collided");
  });
});

/* ================================================= 3. STAGED lineage still written, with entityId */

describe("raw lineage still reaches STAGED carrying the entity id", () => {
  it("every raw row ends STAGED and points at its coupon Entity", async () => {
    const N = 5;
    const { state } = await withStubs({}, () => stageCoupons(N));
    const raws = [...state.raws.values()];
    assert.equal(raws.length, N, "one immutable raw row per coupon");
    const entityIds = new Set([...state.entities.values()].map((e) => e.id));
    for (const raw of raws) {
      assert.equal(raw.processingStatus, "STAGED", "a raw row was left at RECEIVED");
      assert.ok(raw.entityId, "a raw row was left without an entityId");
      assert.ok(entityIds.has(raw.entityId), "a raw row points at an entity that was not staged");
    }
  });

  it("a pre-existing RECEIVED row is relinked in place rather than duplicated", async () => {
    // Stage once, then reset the rows to the state production is in: RECEIVED, entityId null.
    const { state } = await withStubs({}, async ({ state: live }) => {
      await stageCoupons(4);
      for (const raw of live.raws.values()) {
        raw.processingStatus = "RECEIVED";
        raw.entityId = null;
      }
      live.entities.clear();
      await stageCoupons(4);
    });
    assert.equal(state.raws.size, 4, "the recovery run created duplicate raw rows");
    assert.equal(state.trips.rawCreate, 4, "the recovery run wrote new raw rows instead of relinking");
    for (const raw of state.raws.values()) {
      assert.equal(raw.processingStatus, "STAGED");
      assert.ok(raw.entityId);
    }
  });
});

/* =========================================== 4. direct / CMS callers are completely unchanged */

describe("direct and CMS callers behave exactly as before", () => {
  it("a direct upsertRawEntity still prepares, still persists RECEIVED, and still takes the barrier", async () => {
    const { trips, barrier, state } = await withStubs({}, () =>
      upsertRawEntity({
        networkSource: "trackier",
        entityType: "coupon",
        rawData: couponRow(9),
        externalId: couponExternalId(9),
      }),
    );
    assert.equal(barrier.created, 1, "a direct caller must register its own staging participant");
    assert.equal(barrier.released, 1);
    // RECEIVED lookup + create, then the CMS read/write, then the STAGED lookup + update.
    assert.equal(trips.rawCreate, 1);
    assert.equal(trips.rawFindUnique, 2, "the direct path lost or gained a raw lookup");
    assert.equal(trips.rawUpdate, 1, "the direct path no longer links its raw row");
    assert.equal(state.entities.size, 1);
  });

  it("a direct non-coupon upsertRawEntity is unchanged", async () => {
    const { trips, barrier, state } = await withStubs({}, () =>
      upsertRawEntity({
        networkSource: "trackier",
        entityType: "campaign",
        rawData: { id: "zzcamp1", name: "zzname" },
        externalId: "trackier-campaign-zzcamp1",
      }),
    );
    assert.equal(barrier.created, 1);
    assert.equal(trips.rawCreate, 1);
    assert.equal(trips.rawFindUnique, 2);
    assert.equal(state.entities.size, 1);
  });

  it("coupons lifted out of campaign payloads still take the raw-row path", async () => {
    // These rows are NOT in the campaign batch's prepared records, so they must still be prepared
    // and RECEIVED-persisted by upsertCouponRows itself.
    const { state } = await withStubs({}, () =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "campaign",
        rows: [{ id: "zzcamp9", name: "zzname", coupons: [{ id: "zzemb1", code: "ZZEMB1" }] }],
        externalIdPrefix: "trackier-campaign",
        sourceAccountKey: null,
        commissionRuleFanOutDisabled: true,
      }),
    );
    const coupons = [...state.entities.values()].filter((e) => e.entityType === "coupon");
    assert.ok(coupons.length >= 1, "the embedded coupon fan-out stopped staging coupons");
  });
});

/* ================================================== 5. merge / manual-edit semantics unchanged */

describe("upsertCouponFromSync merge semantics are untouched", () => {
  const seeded = (externalId, extra) => ({
    id: "entity-seed",
    externalId,
    networkSource: "trackier",
    entityType: "coupon",
    normalizedData: { code: "ZZOLD" },
    rawData: {},
    ...extra,
  });

  it("a manual entity owned by the operator is never overwritten by the batch", async () => {
    const externalId = couponExternalId(0);
    const { state } = await withStubs(
      { seedEntities: [seeded(externalId, { isManual: true, networkSource: "manual" })] },
      () => stageCoupons(1),
    );
    const entity = [...state.entities.values()][0];
    assert.equal(entity.id, "entity-seed", "the manual entity was replaced");
    assert.equal(entity.normalizedData.code, "ZZOLD", "the manual entity was overwritten by sync");
    assert.equal(state.trips.entityUpdate, 0, "the manual entity was written to");
  });

  it("an entity carrying manual edits takes the merge path, not the plain update", async () => {
    const externalId = couponExternalId(0);
    const { state } = await withStubs(
      { seedEntities: [seeded(externalId, { manualData: { code: "ZZMANUAL" } })] },
      () => stageCoupons(1),
    );
    const entity = [...state.entities.values()][0];
    assert.equal(state.trips.entityUpdate, 1, "the merge path did not write once");
    assert.ok("manualData" in entity, "the merge path dropped manualData");
    assert.ok("fieldPolicies" in entity, "the merge path dropped fieldPolicies");
    assert.ok("hasSyncConflict" in entity, "the merge path dropped the conflict flag");
  });

  it("an entity with no manual edits takes the plain update path", async () => {
    const externalId = couponExternalId(0);
    const { state } = await withStubs({ seedEntities: [seeded(externalId)] }, () => stageCoupons(1));
    const entity = [...state.entities.values()][0];
    assert.equal(state.trips.entityUpdate, 1);
    assert.equal(entity.hasSyncConflict, false, "the plain update path changed");
    assert.ok(!("manualData" in entity), "the plain update path started writing manualData");
  });
});

/* ======================================================= 6. Fix A and the diagnostics still hold */

describe("Fix A and the phase diagnostics are preserved", () => {
  it("a coupon batch still takes exactly one staging participant", async () => {
    for (const size of [1, 10, 25]) {
      // eslint-disable-next-line no-await-in-loop
      const { barrier, state } = await withStubs({}, () => stageCoupons(size));
      assert.equal(barrier.created, 1, `${size} rows took ${barrier.created} participants`);
      assert.equal(barrier.released, 1);
      assert.equal(state.entities.size, size);
    }
  });

  it("the four phase lines are still emitted, still counts-only, still in order", async () => {
    const { lines } = await withStubs({ flag: "true" }, () => stageCoupons(6));
    const phases = lines.filter((l) => l.startsWith("[sync-phase]"));
    assert.deepEqual(phases.map((l) => l.split(" ")[2]), ["prepared", "received", "observed", "entities"]);
    for (const line of phases) {
      assert.match(
        line,
        /^\[sync-phase\] [a-z0-9_]+:[a-z]+ (prepared rows=\d+ prepared=\d+ ms=\d+|received outcomes=\d+ ms=\d+|observed ms=\d+|entities rows=\d+ ms=\d+)$/,
        `phase line changed shape: ${line}`,
      );
    }
    assert.match(phases.find((l) => l.includes(" entities ")), /rows=6 /);
  });

  it("returned counters are unchanged by the reuse", async () => {
    const { returned, state } = await withStubs({}, () => stageCoupons(6));
    assert.equal(returned.counters.recordsFetched, 6);
    assert.equal(returned.counters.recordsCreated, 6);
    assert.equal(returned.preparedRecords.length, 6);
    assert.equal(state.entities.size, 6);
  });
});
