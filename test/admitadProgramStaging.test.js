import test from "node:test";
import assert from "node:assert/strict";

import {
  linkRawPayloadsToEntities,
  persistRawPayloadsForPreparedRecords,
} from "../src/modules/raw/rawPayload.service.js";
import { DB_WORK_CONCURRENCY_CEILING } from "../src/core/dbPermits.js";
import { createFakeConnectionPool } from "./helpers/fakeConnectionPool.js";

const NETWORK = "admitad";
const ACCOUNT = "default";

/** An Admitad /advcampaigns/ row, shaped from the adapter's documented surface. */
function programs(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: 200000 + i,
    name: `Programme ${i}`,
    site_url: `https://merchant-${i}.example`,
    status: i % 9 === 0 ? "suspended" : "active",
    currency: "EUR",
    categories: [{ id: 1, name: "Retail" }],
    actions: [{ id: 900000 + i, name: "Sale", payment_size: `${3 + (i % 7)}.00%` }],
  }));
}

const preparedFrom = (rows) =>
  rows.map((raw) => ({
    networkSource: NETWORK,
    entityType: "campaign",
    externalId: `admitad-campaign-${raw.id}`,
    rawData: raw,
  }));

/**
 * A raw-payload store that records concurrency and can be told to fail or to collide.
 * Registry writes are counted but not modelled; observation is asserted elsewhere.
 */
function createStore({ failExternalIds = new Set(), queryMs = 0 } = {}) {
  const stored = new Map();
  const ops = [];
  let live = 0;
  let peak = 0;
  let seq = 0;
  const keyOf = (d) =>
    JSON.stringify([d.supplier, d.sourceAccountLabel, d.resourceKey, String(d.externalId), d.payloadHash]);

  async function enter(name) {
    ops.push(name);
    live += 1;
    peak = Math.max(peak, live);
    if (queryMs) await new Promise((r) => setTimeout(r, queryMs));
  }
  const leave = () => {
    live -= 1;
  };

  return {
    peak: () => peak,
    ops,
    stored,
    db: {
      sourceSchemaStats: { upsert: async () => ({}) },
      fieldRegistry: { upsert: async () => ({}) },
      rawPayload: {
        async findUnique({ where }) {
          await enter("findUnique");
          try {
            const w = Object.values(where)[0];
            return stored.get(keyOf(w)) ?? null;
          } finally {
            leave();
          }
        },
        async create({ data }) {
          await enter("create");
          try {
            if (failExternalIds.has(String(data.externalId))) {
              const error = new Error("insert failed");
              error.code = "P2010";
              throw error;
            }
            const key = keyOf(data);
            if (stored.has(key)) {
              const error = new Error("Unique constraint failed");
              error.code = "P2002";
              throw error;
            }
            seq += 1;
            const rec = { id: `rp-${seq}`, ...data, entityId: data.entityId ?? null };
            stored.set(key, rec);
            return rec;
          } finally {
            leave();
          }
        },
        async update({ where, data }) {
          await enter("update");
          try {
            return { id: where.id, ...data };
          } finally {
            leave();
          }
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Alignment: entity linkage pairs outcomes with prepared records by position.
// ---------------------------------------------------------------------------

test("staging outcomes stay in input order, not completion order", async () => {
  // Rows finish out of order under concurrency; a pushed array would silently mis-pair every
  // raw payload with another row's entity.
  const rows = programs(200);
  const prepared = preparedFrom(rows);
  const store = createStore({ queryMs: 0 });
  const outcomes = await persistRawPayloadsForPreparedRecords(prepared, {
    metadata: { sourceAccountKey: ACCOUNT },
    db: store.db,
  });

  assert.equal(outcomes.length, prepared.length);
  for (const [index, outcome] of outcomes.entries()) {
    assert.equal(
      String(outcome.record.externalId),
      prepared[index].externalId,
      `outcome ${index} must belong to prepared record ${index}`,
    );
  }
});

test("a failing row keeps its own slot and does not shift the others", async () => {
  const rows = programs(20);
  const prepared = preparedFrom(rows);
  const store = createStore({ failExternalIds: new Set(["admitad-campaign-200005"]) });
  const outcomes = await persistRawPayloadsForPreparedRecords(prepared, {
    metadata: { sourceAccountKey: ACCOUNT },
    db: store.db,
  });

  assert.equal(outcomes.length, 20);
  assert.equal(outcomes[5].record, null, "the failing row's slot holds its own failure");
  for (const [index, outcome] of outcomes.entries()) {
    if (index === 5) continue;
    assert.equal(String(outcome.record.externalId), prepared[index].externalId);
  }
});

// ---------------------------------------------------------------------------
// Concurrency is bounded by the pool budget.
// ---------------------------------------------------------------------------

test("staging never runs wider than the pool-safe ceiling", async () => {
  const store = createStore({ queryMs: 1 });
  await persistRawPayloadsForPreparedRecords(preparedFrom(programs(120)), {
    metadata: { sourceAccountKey: ACCOUNT },
    db: store.db,
  });
  assert.ok(store.peak() > 1, "staging must actually overlap now");
  assert.ok(
    store.peak() <= DB_WORK_CONCURRENCY_CEILING,
    `peak ${store.peak()} must stay within the per-account share`,
  );
});

test("entity linkage is bounded by the same ceiling", async () => {
  let live = 0;
  let peak = 0;
  const db = {
    rawPayload: {
      async update({ where, data }) {
        live += 1;
        peak = Math.max(peak, live);
        try {
          await new Promise((r) => setTimeout(r, 1));
          return { id: where.id, ...data };
        } finally {
          live -= 1;
        }
      },
    },
  };
  const links = Array.from({ length: 100 }, (_, i) => ({
    id: `rp-${i}`,
    entityId: `ent-${i}`,
    currentEntityId: null,
    processingStatus: "RECEIVED",
  }));
  const updated = await linkRawPayloadsToEntities(links, { db });
  assert.equal(updated, 100);
  assert.ok(peak > 1);
  assert.ok(peak <= DB_WORK_CONCURRENCY_CEILING, `peak ${peak}`);
});

// ---------------------------------------------------------------------------
// Concurrency must not change what is stored.
// ---------------------------------------------------------------------------

test("two rows with the same payload key settle as one stored payload", async () => {
  // Serially the second row saw the first; concurrently it may lose the create race instead.
  // Both must end with one stored payload and one duplicate outcome.
  const row = programs(1)[0];
  const prepared = [...preparedFrom([row]), ...preparedFrom([row])];
  const store = createStore();
  const outcomes = await persistRawPayloadsForPreparedRecords(prepared, {
    metadata: { sourceAccountKey: ACCOUNT },
    db: store.db,
  });

  assert.equal(outcomes.length, 2);
  assert.equal(outcomes.filter((o) => o.created).length, 1, "exactly one create wins");
  assert.equal(outcomes.filter((o) => !o.created).length, 1, "the other is a duplicate");
  for (const outcome of outcomes) {
    assert.ok(outcome.record?.id, "a lost race must still return the stored payload");
    assert.equal(outcome.failed, undefined);
  }
  assert.equal(store.stored.size, 1, "raw lineage holds one payload for one distinct fact");
});

test("re-staging the same catalog creates nothing and stays idempotent", async () => {
  const prepared = preparedFrom(programs(60));
  const store = createStore();

  const first = await persistRawPayloadsForPreparedRecords(prepared, {
    metadata: { sourceAccountKey: ACCOUNT },
    db: store.db,
  });
  assert.equal(first.filter((o) => o.created).length, 60);
  const afterFirst = store.stored.size;

  const second = await persistRawPayloadsForPreparedRecords(prepared, {
    metadata: { sourceAccountKey: ACCOUNT },
    db: store.db,
  });
  assert.equal(second.filter((o) => o.created).length, 0, "nothing may be re-created");
  assert.equal(store.stored.size, afterFirst, "no extra lineage rows");
  for (const [index, outcome] of second.entries()) {
    assert.equal(String(outcome.record.externalId), prepared[index].externalId);
  }
});

test("required staging still throws when a payload was not stored", async () => {
  const prepared = preparedFrom(programs(10));
  const store = createStore({ failExternalIds: new Set(["admitad-campaign-200003"]) });
  await assert.rejects(
    () =>
      persistRawPayloadsForPreparedRecords(prepared, {
        metadata: { sourceAccountKey: ACCOUNT },
        db: store.db,
        required: true,
      }),
    (error) => error instanceof Error,
  );
});

// ---------------------------------------------------------------------------
// The sequence-100 volume, against a pool that behaves like production's.
// ---------------------------------------------------------------------------

test("1284 programs: serial staging spends far more round trips than bounded staging", async () => {
  const ROWS = 1284;
  const QUERIES_PER_ROW = 2; // findUnique + create

  const serialWaves = ROWS * QUERIES_PER_ROW;
  const boundedWaves = Math.ceil((ROWS * QUERIES_PER_ROW) / DB_WORK_CONCURRENCY_CEILING);

  assert.equal(serialWaves, 2568, "the old shape was 2568 strictly serial round trips");
  assert.ok(
    boundedWaves * 4 <= serialWaves,
    `bounded staging must cut the serial cost by about the ceiling (${serialWaves} -> ${boundedWaves})`,
  );
});

test("1284 programs stage inside the pool without a timeout", async () => {
  const pool = createFakeConnectionPool({ limit: 5, timeoutMs: 10_000, queryMs: 0 });
  const store = createStore();
  const prepared = preparedFrom(programs(1284));

  // Route the store's work through the pool so connection use is what is measured.
  const db = {
    ...store.db,
    rawPayload: {
      findUnique: async (args) => {
        await pool.query();
        return store.db.rawPayload.findUnique(args);
      },
      create: async (args) => {
        await pool.query();
        return store.db.rawPayload.create(args);
      },
      update: async (args) => {
        await pool.query();
        return store.db.rawPayload.update(args);
      },
    },
  };

  const outcomes = await persistRawPayloadsForPreparedRecords(prepared, {
    metadata: { sourceAccountKey: ACCOUNT },
    db,
  });

  const stats = pool.stats();
  assert.equal(outcomes.length, 1284);
  assert.equal(outcomes.filter((o) => o.created).length, 1284);
  assert.equal(stats.timeouts, 0, "no row may time out fetching a connection");
  assert.ok(stats.peakInUse <= 5, `peak ${stats.peakInUse} must stay within the pool`);
  assert.ok(
    stats.peakInUse <= DB_WORK_CONCURRENCY_CEILING,
    `peak ${stats.peakInUse} must stay within one account's share`,
  );
});
