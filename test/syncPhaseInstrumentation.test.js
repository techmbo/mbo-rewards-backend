/**
 * Phase-boundary diagnostics for stageManyRawEntities.
 *
 * The existing `[sync-benchmark]` line is emitted only after the WHOLE batch completes. When a
 * Trackier coupon batch exhausted a 300s invocation, that line never appeared — which told us the
 * function had not finished, and nothing else. It could not distinguish "prepare was slow" from
 * "RECEIVED persistence never returned" from "Entity staging never returned".
 *
 * These `[sync-phase]` lines close each phase as it completes, so a truncated invocation still
 * reports how far it got. They are diagnostics, nothing else: gated on the same
 * SYNC_UPSERT_BENCHMARK flag, carrying counts and durations only, and changing no result.
 *
 * The tests drive the REAL staging path with stubbed Prisma delegates and a stubbed barrier store,
 * so every assertion is about lines actually emitted and values actually returned.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entityStagingBarrier } from "../src/jobs/entityStagingBarrier.js";
import { prisma } from "../src/database/prisma.js";
import { upsertManyRawEntities } from "../src/modules/raw/raw.service.js";
import { persistRawPayloadsForPreparedRecords } from "../src/modules/raw/rawPayload.service.js";

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

function stubPrisma() {
  const state = { entities: new Map(), rawPayloads: [], entityCreates: 0, bulkStatements: 0, observations: 0 };
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
    async findMany() {
      return [...state.entities.values()].map((row) => ({ id: row.id, externalId: row.externalId }));
    },
    async create({ data }) {
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
    async updateMany() {
      return { count: 0 };
    },
  };

  // Schema observation is a REAL phase here, not a no-op: these are the two delegates it writes to.
  const sourceSchemaStats = {
    async upsert() {
      state.observations += 1;
      return { id: "stats-1" };
    },
  };
  const fieldRegistry = {
    async upsert() {
      state.observations += 1;
      return { id: "field-1" };
    },
  };

  const $executeRaw = async () => {
    state.bulkStatements += 1;
    return state.bulkStatements;
  };

  return { state, delegates: { entity, rawPayload, sourceSchemaStats, fieldRegistry, $executeRaw } };
}

/** Run `fn` with the stubs installed and console.info captured. Always restores everything. */
async function runCaptured({ flag }, fn) {
  const barrierDb = countingBarrierDb();
  const { state, delegates } = stubPrisma();
  const originalBarrierDb = entityStagingBarrier.db;
  const originalInfo = console.info;
  const originalFlag = process.env.SYNC_UPSERT_BENCHMARK;
  const originals = {};
  for (const name of Object.keys(delegates)) originals[name] = prisma[name];

  const lines = [];
  entityStagingBarrier.db = barrierDb;
  for (const [name, delegate] of Object.entries(delegates)) prisma[name] = delegate;
  if (flag === undefined) delete process.env.SYNC_UPSERT_BENCHMARK;
  else process.env.SYNC_UPSERT_BENCHMARK = flag;
  // eslint-disable-next-line no-console
  console.info = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const returned = await fn();
    return { lines, state, barrier: barrierDb.calls, returned };
  } finally {
    // eslint-disable-next-line no-console
    console.info = originalInfo;
    entityStagingBarrier.db = originalBarrierDb;
    for (const [name, original] of Object.entries(originals)) prisma[name] = original;
    if (originalFlag === undefined) delete process.env.SYNC_UPSERT_BENCHMARK;
    else process.env.SYNC_UPSERT_BENCHMARK = originalFlag;
  }
}

const phaseLines = (lines) => lines.filter((line) => line.startsWith("[sync-phase]"));
const phaseNames = (lines) => phaseLines(lines).map((line) => line.split(" ")[2]);

/** Distinctive markers: if any of these reach a log line, row content is leaking. */
const COUPON_CODE = "ZZSECRETCODEZZ";
const COUPON_ID = "zzrowid";
const ADVERTISER = "ZZADVERTISERNAMEZZ";
const URL_VALUE = "https://zz.example.invalid/zzpath";

const couponRow = (i) => ({
  id: `${COUPON_ID}${i}`,
  record_source: "coupon",
  code: `${COUPON_CODE}${i}`,
  advertiser_name: ADVERTISER,
  tracking_url: URL_VALUE,
  campaign_id: 77,
});

const campaignRow = (i) => ({
  id: `${COUPON_ID}c${i}`,
  name: ADVERTISER,
  tracking_url: URL_VALUE,
});

const stageCoupons = (count) =>
  upsertManyRawEntities({
    networkSource: "trackier",
    entityType: "coupon",
    rows: Array.from({ length: count }, (_, i) => couponRow(i)),
    externalIdPrefix: "trackier-coupon",
    sourceAccountKey: null,
  });

/* ================================================================== 1. the flag gates the logs */

describe("phase logs are emitted only when SYNC_UPSERT_BENCHMARK=true", () => {
  it("emits nothing at all when the flag is unset", async () => {
    const { lines } = await runCaptured({ flag: undefined }, () => stageCoupons(3));
    assert.deepEqual(phaseLines(lines), [], "phase lines leaked with the flag unset");
    assert.deepEqual(
      lines.filter((line) => line.startsWith("[sync-benchmark]")),
      [],
      "the pre-existing benchmark line must stay gated too",
    );
  });

  it("emits nothing when the flag is set to a value other than true", async () => {
    for (const flag of ["false", "0", "1", "yes", "", "TRUE_ISH"]) {
      // eslint-disable-next-line no-await-in-loop
      const { lines } = await runCaptured({ flag }, () => stageCoupons(2));
      assert.deepEqual(phaseLines(lines), [], `phase lines emitted for flag "${flag}"`);
    }
  });

  it("emits the phases when the flag is true, in any case", async () => {
    for (const flag of ["true", "TRUE", "True"]) {
      // eslint-disable-next-line no-await-in-loop
      const { lines } = await runCaptured({ flag }, () => stageCoupons(2));
      assert.ok(phaseLines(lines).length > 0, `no phase lines for flag "${flag}"`);
    }
  });
});

/* ========================================================= 2. every phase closes, in real order */

describe("each phase reports as it completes", () => {
  it("a coupon batch reports prepared, received, observed and entities in order", async () => {
    const { lines } = await runCaptured({ flag: "true" }, () => stageCoupons(4));
    assert.deepEqual(phaseNames(lines), ["prepared", "received", "observed", "entities"]);
  });

  it("a non-coupon batch reports the same four phases", async () => {
    const { lines } = await runCaptured({ flag: "true" }, () =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "campaign",
        rows: [campaignRow(1), campaignRow(2)],
        externalIdPrefix: "trackier-campaign",
        sourceAccountKey: null,
        commissionRuleFanOutDisabled: true,
      }),
    );
    assert.deepEqual(phaseNames(lines), ["prepared", "received", "observed", "entities"]);
  });

  it("the phase lines precede the end-of-batch benchmark line", async () => {
    const { lines } = await runCaptured({ flag: "true" }, () => stageCoupons(3));
    const benchmarkIndex = lines.findIndex((line) => line.startsWith("[sync-benchmark]"));
    assert.ok(benchmarkIndex >= 0, "the pre-existing benchmark line disappeared");
    const lastPhaseIndex = lines.map((l) => l.startsWith("[sync-phase]")).lastIndexOf(true);
    assert.ok(
      lastPhaseIndex < benchmarkIndex,
      "a phase line must close before the batch summary, or it cannot survive a truncated invocation",
    );
  });

  it("an empty batch emits no phase lines at all", async () => {
    const { lines } = await runCaptured({ flag: "true" }, () =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "coupon",
        rows: [],
        externalIdPrefix: "trackier-coupon",
        sourceAccountKey: null,
      }),
    );
    assert.deepEqual(phaseLines(lines), []);
  });
});

/* ================================================== 3. counts and durations only — nothing else */

describe("phase lines carry counts and durations only", () => {
  const SHAPE =
    /^\[sync-phase\] [a-z0-9_]+:[a-z]+ (prepared rows=\d+ prepared=\d+ ms=\d+|received outcomes=\d+ ms=\d+|observed ms=\d+|entities rows=\d+ ms=\d+)$/;

  it("every line matches the exact permitted shape", async () => {
    const { lines } = await runCaptured({ flag: "true" }, () => stageCoupons(5));
    for (const line of phaseLines(lines)) {
      assert.match(line, SHAPE, `unexpected content in phase line: ${line}`);
    }
  });

  it("no row content, identifier, code, name or URL reaches a phase line", async () => {
    const { lines } = await runCaptured({ flag: "true" }, () => stageCoupons(5));
    const joined = phaseLines(lines).join("\n");
    for (const forbidden of [COUPON_CODE, COUPON_ID, ADVERTISER, URL_VALUE, "trackier-coupon-", "://", "record_source"]) {
      assert.ok(!joined.includes(forbidden), `phase lines leaked "${forbidden}"`);
    }
  });

  it("no externalId, payload body or account key reaches a phase line", async () => {
    const { lines, state } = await runCaptured({ flag: "true" }, () =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "coupon",
        rows: [couponRow(1)],
        externalIdPrefix: "trackier-coupon",
        sourceAccountKey: "zzaccountkeyzz",
      }),
    );
    const joined = phaseLines(lines).join("\n");
    assert.ok(!joined.includes("zzaccountkeyzz"), "the source account key leaked");
    for (const entity of state.entities.values()) {
      assert.ok(!joined.includes(entity.externalId), `the externalId ${entity.externalId} leaked`);
    }
    // Nothing quoted, braced or bracketed: a serialized payload cannot hide in these lines.
    for (const line of phaseLines(lines)) {
      assert.ok(!/["'{}]/.test(line), `phase line looks like it carries structured data: ${line}`);
    }
  });

  it("the only numbers on a line are counts and millisecond durations", async () => {
    const { lines } = await runCaptured({ flag: "true" }, () => stageCoupons(3));
    for (const line of phaseLines(lines)) {
      const fields = line.split(" ").slice(3);
      for (const field of fields) {
        const [name, value] = field.split("=");
        assert.ok(["rows", "prepared", "outcomes", "ms"].includes(name), `unexpected field "${name}"`);
        assert.match(value, /^\d+$/, `field ${name} is not a plain number`);
      }
    }
  });

  it("the reported counts are the real batch counts", async () => {
    const { lines } = await runCaptured({ flag: "true" }, () => stageCoupons(7));
    const prepared = phaseLines(lines).find((l) => l.includes(" prepared "));
    assert.match(prepared, /rows=7 prepared=7 /);
    const received = phaseLines(lines).find((l) => l.includes(" received "));
    assert.match(received, /outcomes=7 /);
    const entities = phaseLines(lines).find((l) => l.includes(" entities "));
    assert.match(entities, /rows=7 /);
  });
});

/* ============================================================= 4. behaviour is entirely unchanged */

describe("instrumentation changes no behaviour", () => {
  it("counters, entities and raw rows are identical with the flag on and off", async () => {
    const off = await runCaptured({ flag: undefined }, () => stageCoupons(6));
    const on = await runCaptured({ flag: "true" }, () => stageCoupons(6));
    assert.deepEqual(on.returned, off.returned, "the returned counters differ with the flag on");
    assert.equal(on.state.entityCreates, off.state.entityCreates);
    assert.equal(on.state.rawPayloads.length, off.state.rawPayloads.length);
    assert.equal(on.state.observations, off.state.observations, "schema observation differed");
    assert.ok(on.state.entityCreates > 0, "the run under test staged nothing");
  });

  it("Fix A is intact: one barrier entry per batch, with or without the flag", async () => {
    for (const flag of [undefined, "true"]) {
      // eslint-disable-next-line no-await-in-loop
      const { barrier, state } = await runCaptured({ flag }, () => stageCoupons(10));
      assert.equal(barrier.created, 1, `the barrier was entered ${barrier.created} times`);
      assert.equal(barrier.released, 1);
      assert.equal(state.entityCreates, 10);
    }
  });

  it("schema observation still runs and still writes the registry", async () => {
    const { state } = await runCaptured({ flag: "true" }, () => stageCoupons(4));
    assert.ok(state.observations > 0, "the observed phase reported but observation did not run");
  });
});

/* ================================================ 5. the hook itself cannot break the raw path */

describe("the onPhase hook is inert by construction", () => {
  it("a throwing hook neither propagates nor changes the outcomes", async () => {
    const prepared = [
      {
        networkSource: "trackier",
        entityType: "coupon",
        externalId: "trackier-coupon-zz1",
        rawData: { id: `${COUPON_ID}1`, code: `${COUPON_CODE}1` },
      },
    ];
    const withoutHook = await runCaptured({ flag: undefined }, () =>
      persistRawPayloadsForPreparedRecords(prepared, {}),
    );
    const withThrowingHook = await runCaptured({ flag: undefined }, () =>
      persistRawPayloadsForPreparedRecords(prepared, {
        onPhase: () => {
          throw new Error("zzhookexplodedzz");
        },
      }),
    );
    assert.equal(withThrowingHook.returned.length, withoutHook.returned.length);
    assert.equal(withThrowingHook.returned[0]?.created, withoutHook.returned[0]?.created);
    assert.equal(withThrowingHook.state.observations, withoutHook.state.observations);
  });

  it("the hook reports received and observed, and observed only when observation runs", async () => {
    const prepared = [
      {
        networkSource: "trackier",
        entityType: "coupon",
        externalId: "trackier-coupon-zz2",
        rawData: { id: `${COUPON_ID}2`, code: `${COUPON_CODE}2` },
      },
    ];
    const seen = [];
    await runCaptured({ flag: undefined }, () =>
      persistRawPayloadsForPreparedRecords(prepared, { onPhase: (p) => seen.push(p) }),
    );
    assert.deepEqual(
      seen.map((p) => p.phase),
      ["received", "observed"],
    );
    assert.equal(seen[0].count, 1);
    assert.ok(Number.isFinite(seen[0].ms) && seen[0].ms >= 0);
    assert.equal(seen[1].count, null, "the observed phase has no row count to report");

    const skipped = [];
    await runCaptured({ flag: undefined }, () =>
      persistRawPayloadsForPreparedRecords(prepared, {
        observeSchema: false,
        onPhase: (p) => skipped.push(p),
      }),
    );
    assert.deepEqual(
      skipped.map((p) => p.phase),
      ["received"],
      "an observed phase was reported although observation was skipped",
    );
  });

  it("no hook at all is still the default for every existing caller", async () => {
    const prepared = [
      {
        networkSource: "trackier",
        entityType: "coupon",
        externalId: "trackier-coupon-zz3",
        rawData: { id: `${COUPON_ID}3` },
      },
    ];
    const { lines, returned } = await runCaptured({ flag: "true" }, () =>
      persistRawPayloadsForPreparedRecords(prepared, {}),
    );
    assert.deepEqual(phaseLines(lines), [], "phase lines appeared without a hook being supplied");
    assert.equal(returned.length, 1);
  });
});
