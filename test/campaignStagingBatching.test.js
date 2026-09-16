import test from "node:test";
import assert from "node:assert/strict";

import {
  observeSourceSchema,
  resolvePayloadForObservation,
} from "../src/field-system/sourceSchemaObserver.service.js";
import {
  SUPPLIER_COMMISSION_RULE_CONCURRENCY,
  groupRulesByOutcomeKey,
  upsertCommissionRulesForPreparedCampaigns,
} from "../src/modules/commercial/supplierCommissionRuleSync.service.js";
import { collectEmbeddedCommissionRulesFromCampaigns } from "../src/modules/commercial/supplierCommissionRuleFanOut.js";
import { linkRawPayloadsToEntities } from "../src/modules/raw/rawPayload.service.js";

const NETWORK = "optimise_sea";
const ACCOUNT = "default";

/** Campaign rows shaped like the recorded Optimise fixture. Never real supplier data. */
function buildCampaigns(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: 100000 + i,
    name: `Campaign ${i}`,
    advertiserName: `Advertiser ${i % 40}`,
    vertical: { name: ["Travel", "Retail", "Finance"][i % 3] },
    markets: ["AE", "SA"],
    status: i % 7 === 0 ? "paused" : "live",
    publishers: [{ campaignSubStatus: "approved" }],
    commissionCost: (5 + (i % 10)).toFixed(2),
    commissionType: "percentage",
    currency: "AED",
    baseTrackingUrl: `https://track.example/c/${100000 + i}`,
  }));
}

/** A field registry that records final state, so two write paths can be compared exactly. */
function createRegistry() {
  const stats = new Map();
  const fields = new Map();
  let queries = 0;
  const db = {
    sourceSchemaStats: {
      async upsert({ where, create, update }) {
        queries += 1;
        const key = JSON.stringify(where.network_sourceObject);
        const existing = stats.get(key);
        if (!existing) {
          stats.set(key, { ...create });
          return stats.get(key);
        }
        const next = { ...existing };
        for (const [k, v] of Object.entries(update)) {
          if (v && typeof v === "object" && "increment" in v) next[k] = (next[k] ?? 0) + v.increment;
          else if (v !== undefined) next[k] = v;
        }
        stats.set(key, next);
        return next;
      },
    },
    fieldRegistry: {
      async upsert({ where, create, update }) {
        queries += 1;
        const key = JSON.stringify(where.fieldPath_source_sourceObject);
        const existing = fields.get(key);
        if (!existing) {
          fields.set(key, { ...create });
          return fields.get(key);
        }
        const next = { ...existing };
        for (const [k, v] of Object.entries(update)) {
          if (v && typeof v === "object" && "increment" in v) next[k] = (next[k] ?? 0) + v.increment;
          else if (v !== undefined) next[k] = v;
        }
        fields.set(key, next);
        return next;
      },
    },
  };
  // firstSeenAt/lastSeenAt are wall-clock and differ between runs by construction.
  const stable = (map) =>
    [...map.entries()]
      .map(([k, v]) => {
        const { firstSeenAt, lastSeenAt, ...rest } = v;
        return [k, rest];
      })
      .sort((a, b) => a[0].localeCompare(b[0]));
  return { db, state: () => ({ stats: stable(stats), fields: stable(fields) }), queries: () => queries };
}

const OBSERVATION = {
  network: NETWORK,
  sourceObject: "campaigns",
  entityType: "campaign",
  resourceKey: "campaigns",
  apiVersion: null,
};

test("observing a batch once writes exactly what observing every payload separately wrote", async () => {
  const payloads = buildCampaigns(267);

  const perRow = createRegistry();
  for (const payload of payloads) {
    await observeSourceSchema({ ...OBSERVATION, payloads: [payload], incrementOccurrence: true }, perRow.db);
  }

  const batched = createRegistry();
  await observeSourceSchema({ ...OBSERVATION, payloads, incrementOccurrence: true }, batched.db);

  assert.deepEqual(batched.state(), perRow.state(), "registry state must be identical");
  assert.ok(
    batched.queries() < perRow.queries() / 100,
    `batched observation must be far cheaper (per-row ${perRow.queries()}, batched ${batched.queries()})`,
  );
});

test("batched observation preserves occurrence counts exactly, not approximately", async () => {
  const payloads = buildCampaigns(267);
  const batched = createRegistry();
  await observeSourceSchema({ ...OBSERVATION, payloads, incrementOccurrence: true }, batched.db);

  const { stats, fields } = batched.state();
  assert.equal(stats.length, 1);
  assert.equal(stats[0][1].totalPayloadsObserved, 267, "every payload must be counted once");
  for (const [path, row] of fields) {
    assert.equal(row.occurrenceCount, 267, `${path} appears in every payload and must count 267`);
  }
});

test("a duplicate payload batch still refreshes the registry without inflating counts", async () => {
  const payloads = buildCampaigns(50);

  const perRow = createRegistry();
  for (const payload of payloads) {
    await observeSourceSchema({ ...OBSERVATION, payloads: [payload], incrementOccurrence: false }, perRow.db);
  }
  const batched = createRegistry();
  await observeSourceSchema({ ...OBSERVATION, payloads, incrementOccurrence: false }, batched.db);

  assert.deepEqual(batched.state(), perRow.state());
  assert.equal(batched.state().stats[0][1].totalPayloadsObserved, 0);
});

test("resolvePayloadForObservation reads the body the persist path actually stored", () => {
  assert.deepEqual(resolvePayloadForObservation({ payload: { a: 1 } }), { a: 1 });
  assert.deepEqual(resolvePayloadForObservation({ payloadText: '{"a":1}' }), { a: 1 });
  assert.equal(resolvePayloadForObservation({}), null);
});

// ---------------------------------------------------------------------------
// Entity linkage
// ---------------------------------------------------------------------------

function createRawPayloadStore(rows) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  let updates = 0;
  return {
    db: {
      rawPayload: {
        async update({ where, data }) {
          updates += 1;
          const row = byId.get(where.id);
          if (!row) throw new Error("missing row");
          Object.assign(row, data);
          return row;
        },
      },
    },
    rows: () => [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    updates: () => updates,
  };
}

test("entity linkage lifts RECEIVED to STAGED and fills the entity id", async () => {
  const store = createRawPayloadStore([
    { id: "rp-1", entityId: null, processingStatus: "RECEIVED" },
    { id: "rp-2", entityId: null, processingStatus: "RECEIVED" },
  ]);
  const updated = await linkRawPayloadsToEntities(
    [
      { id: "rp-1", entityId: "ent-1", processingStatus: "RECEIVED" },
      { id: "rp-2", entityId: "ent-2", processingStatus: "RECEIVED" },
    ],
    { db: store.db },
  );
  assert.equal(updated, 2);
  assert.deepEqual(store.rows(), [
    { id: "rp-1", entityId: "ent-1", processingStatus: "STAGED" },
    { id: "rp-2", entityId: "ent-2", processingStatus: "STAGED" },
  ]);
});

test("entity linkage never rewrites a processing status other than RECEIVED", async () => {
  const store = createRawPayloadStore([{ id: "rp-1", entityId: null, processingStatus: "QUARANTINED" }]);
  await linkRawPayloadsToEntities([{ id: "rp-1", entityId: "ent-1", processingStatus: "QUARANTINED" }], {
    db: store.db,
  });
  assert.equal(store.rows()[0].processingStatus, "QUARANTINED");
  assert.equal(store.rows()[0].entityId, "ent-1");
});

test("entity linkage skips rows with no id or no entity and issues no query for them", async () => {
  const store = createRawPayloadStore([{ id: "rp-1", entityId: null, processingStatus: "RECEIVED" }]);
  const updated = await linkRawPayloadsToEntities(
    [
      { id: null, entityId: "ent-1", processingStatus: "RECEIVED" },
      { id: "rp-9", entityId: null, processingStatus: "RECEIVED" },
    ],
    { db: store.db },
  );
  assert.equal(updated, 0);
  assert.equal(store.updates(), 0);
});

test("one failing link does not abandon the rest of the batch", async () => {
  const store = createRawPayloadStore([
    { id: "rp-1", entityId: null, processingStatus: "RECEIVED" },
    { id: "rp-3", entityId: null, processingStatus: "RECEIVED" },
  ]);
  const updated = await linkRawPayloadsToEntities(
    [
      { id: "rp-1", entityId: "ent-1", processingStatus: "RECEIVED" },
      { id: "rp-missing", entityId: "ent-2", processingStatus: "RECEIVED" },
      { id: "rp-3", entityId: "ent-3", processingStatus: "RECEIVED" },
    ],
    { db: store.db },
  );
  assert.equal(updated, 2);
  assert.equal(store.rows()[0].entityId, "ent-1");
  assert.equal(store.rows()[1].entityId, "ent-3");
});

// ---------------------------------------------------------------------------
// Commission summary fan-out: same outcomes, same ordering, still idempotent.
// ---------------------------------------------------------------------------

/**
 * Records every upsert in completion order and, for each outcomeKey, whether two of its rules
 * were ever in flight at the same time. Keeps enough state to answer "is the second run a no-op".
 */
function createRuleServiceProbe({ delayMs = 0 } = {}) {
  const calls = [];
  const inFlightByOutcome = new Map();
  const overlaps = [];
  let maxParallel = 0;
  let parallel = 0;
  const persisted = new Map();

  return {
    probe: {
      calls,
      overlaps,
      maxParallel: () => maxParallel,
      persisted,
    },
    service: {
      async upsertNormalizedFact(input) {
        const key = String(input.outcomeKey);
        if (inFlightByOutcome.get(key)) overlaps.push(key);
        inFlightByOutcome.set(key, true);
        parallel += 1;
        maxParallel = Math.max(maxParallel, parallel);
        try {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          calls.push({
            outcomeKey: key,
            supplier: input.supplier,
            sourceAccountLabel: input.sourceAccountLabel,
            ratePercent: input.ratePercent,
            fixedAmount: input.fixedAmount,
            currency: input.currency,
            basis: input.basis,
            supplierRuleType: input.supplierRuleType,
            sourceObject: input.sourceObject,
            sourcePath: input.sourcePath,
            mappingStatus: input.mappingStatus,
            ruleVersion: input.ruleVersion,
            commissionSequence: input.commissionSequence,
            sourceCampaignId: input.metadata?.sourceCampaignId ?? null,
          });
          const prior = persisted.get(key);
          const economics = JSON.stringify([input.ratePercent, input.fixedAmount, input.currency, input.basis]);
          persisted.set(key, economics);
          return { id: key, reused: prior === economics };
        } finally {
          parallel -= 1;
          inFlightByOutcome.set(key, false);
        }
      },
    },
  };
}

function campaignRecords(count) {
  return buildCampaigns(count).map((raw) => ({ originalPayload: raw }));
}

const NO_DB = {
  supplierCampaign: { findMany: async () => [] },
};

test("groupRulesByOutcomeKey keeps every rule and preserves fan-out order within a key", () => {
  const rules = [
    { outcomeKey: "a", n: 1 },
    { outcomeKey: "b", n: 2 },
    { outcomeKey: "a", n: 3 },
    { outcomeKey: "c", n: 4 },
    { outcomeKey: "a", n: 5 },
  ];
  const groups = groupRulesByOutcomeKey(rules);
  assert.equal(groups.flat().length, rules.length, "no rule may be dropped");
  assert.deepEqual(
    groups.find((g) => g[0].outcomeKey === "a").map((r) => r.n),
    [1, 3, 5],
    "a key's rules stay in fan-out order",
  );
});

test("concurrent fan-out persists exactly the rules the serial fan-out persisted", async () => {
  const records = campaignRecords(267);

  const serial = createRuleServiceProbe();
  await upsertCommissionRulesForPreparedCampaigns(
    { networkSource: NETWORK, preparedRecords: records, sourceAccountKey: ACCOUNT },
    { prisma: NO_DB, ruleService: serial.service, concurrency: 1 },
  );

  const concurrent = createRuleServiceProbe();
  const result = await upsertCommissionRulesForPreparedCampaigns(
    { networkSource: NETWORK, preparedRecords: records, sourceAccountKey: ACCOUNT },
    { prisma: NO_DB, ruleService: concurrent.service },
  );

  const sortByKey = (calls) => [...calls].sort((a, b) => a.outcomeKey.localeCompare(b.outcomeKey));
  assert.equal(concurrent.probe.calls.length, serial.probe.calls.length);
  assert.deepEqual(
    sortByKey(concurrent.probe.calls),
    sortByKey(serial.probe.calls),
    "every persisted rule field must be identical",
  );
  assert.equal(result.upserted, serial.probe.calls.length);
});

test("two rules sharing an outcomeKey are never in flight together", async () => {
  // Repeating a campaign with identical economics makes the fan-out emit repeated outcomeKeys,
  // which is exactly the case where ordering decides which version ends up open.
  const base = buildCampaigns(30);
  const records = [...base, ...base, ...base].map((raw) => ({ originalPayload: raw }));

  const { probe, service } = createRuleServiceProbe({ delayMs: 2 });
  await upsertCommissionRulesForPreparedCampaigns(
    { networkSource: NETWORK, preparedRecords: records, sourceAccountKey: ACCOUNT },
    { prisma: NO_DB, ruleService: service },
  );

  const repeated = new Map();
  for (const call of probe.calls) repeated.set(call.outcomeKey, (repeated.get(call.outcomeKey) ?? 0) + 1);
  const maxRepeat = Math.max(...repeated.values());
  assert.ok(maxRepeat > 1, `the fixture must actually repeat outcomeKeys (saw max ${maxRepeat})`);
  assert.deepEqual(probe.overlaps, [], "no outcomeKey may be persisted concurrently with itself");
  assert.ok(probe.maxParallel() > 1, "independent outcomes must still overlap");
});

test("rules of one outcomeKey are persisted in fan-out order", () => {
  const rules = [
    { outcomeKey: "same", sourceRuleId: "r1" },
    { outcomeKey: "other", sourceRuleId: "r4" },
    { outcomeKey: "same", sourceRuleId: "r2" },
    { outcomeKey: "same", sourceRuleId: "r3" },
  ];
  const sameGroup = groupRulesByOutcomeKey(rules).find((g) => g[0].outcomeKey === "same");
  assert.equal(sameGroup.length, 3, "all versions of one outcome stay in one serial group");
  assert.deepEqual(sameGroup.map((r) => r.sourceRuleId), ["r1", "r2", "r3"]);
});

test("concurrency is bounded, so the connection pool cannot be swamped", async () => {
  const records = campaignRecords(200);
  const { probe, service } = createRuleServiceProbe({ delayMs: 1 });
  await upsertCommissionRulesForPreparedCampaigns(
    { networkSource: NETWORK, preparedRecords: records, sourceAccountKey: ACCOUNT },
    { prisma: NO_DB, ruleService: service },
  );
  assert.ok(probe.maxParallel() > 1, "independent outcomes must actually overlap");
  assert.ok(
    probe.maxParallel() <= SUPPLIER_COMMISSION_RULE_CONCURRENCY,
    `parallelism ${probe.maxParallel()} must stay within the bound`,
  );
});

test("re-running the fan-out over the same campaigns re-persists the same economics", async () => {
  const records = campaignRecords(60);
  const { probe, service } = createRuleServiceProbe();

  await upsertCommissionRulesForPreparedCampaigns(
    { networkSource: NETWORK, preparedRecords: records, sourceAccountKey: ACCOUNT },
    { prisma: NO_DB, ruleService: service },
  );
  const firstPass = [...probe.persisted.entries()].sort();

  await upsertCommissionRulesForPreparedCampaigns(
    { networkSource: NETWORK, preparedRecords: records, sourceAccountKey: ACCOUNT },
    { prisma: NO_DB, ruleService: service },
  );
  const secondPass = [...probe.persisted.entries()].sort();

  assert.deepEqual(secondPass, firstPass, "a repeat sync must not change any rule's economics");
  const second = probe.calls.slice(probe.calls.length / 2);
  assert.ok(second.length > 0);
});

test("detailed-rule precedence still removes those campaigns before any rule is built", async () => {
  const records = campaignRecords(10);
  const skipped = ["100000", "100001", "100002"];
  const { probe, service } = createRuleServiceProbe();
  const result = await upsertCommissionRulesForPreparedCampaigns(
    {
      networkSource: NETWORK,
      preparedRecords: records,
      sourceAccountKey: ACCOUNT,
      skipCampaignIds: skipped,
    },
    { prisma: NO_DB, ruleService: service },
  );
  assert.equal(result.skippedDetailedCampaigns, skipped.length);
  for (const call of probe.calls) {
    assert.ok(
      !skipped.includes(String(call.sourceCampaignId)),
      `${call.sourceCampaignId} holds detailed rules and must not get a summary rule`,
    );
  }
});

test("account isolation survives concurrency: every rule carries one account label", async () => {
  // The label is parsed off an account-scoped key, so use the scoped form a caller builds.
  // (A bare key with no separator resolves to "default" — long-standing behaviour of
  // parseSourceAccountLabel, unchanged here.)
  const records = campaignRecords(40);
  const scopedKey = "second-account:optimise_sea";

  const concurrent = createRuleServiceProbe({ delayMs: 1 });
  await upsertCommissionRulesForPreparedCampaigns(
    { networkSource: NETWORK, preparedRecords: records, sourceAccountKey: scopedKey },
    { prisma: NO_DB, ruleService: concurrent.service },
  );

  const serial = createRuleServiceProbe();
  await upsertCommissionRulesForPreparedCampaigns(
    { networkSource: NETWORK, preparedRecords: records, sourceAccountKey: scopedKey },
    { prisma: NO_DB, ruleService: serial.service, concurrency: 1 },
  );

  assert.ok(concurrent.probe.calls.length > 0);
  for (const call of concurrent.probe.calls) {
    assert.equal(call.sourceAccountLabel, "second-account", "no rule may drift to another account");
    assert.equal(call.supplier, "OPTIMISE");
  }
  assert.deepEqual(
    new Set(concurrent.probe.calls.map((c) => c.sourceAccountLabel)),
    new Set(serial.probe.calls.map((c) => c.sourceAccountLabel)),
    "concurrency must not change which account a rule is written under",
  );
});

// ---------------------------------------------------------------------------
// Production-shaped benchmark. Counts queries only: a fake client says nothing
// about real latency, but it measures the algorithmic work exactly.
// ---------------------------------------------------------------------------

test("267 campaigns: batched observation replaces per-row observation almost entirely", async () => {
  const payloads = buildCampaigns(267);
  const paths = new Set();
  for (const field of (await import("../src/field-system/fieldExtractor.js")).observeSourceFields(payloads[0])) {
    paths.add(field.fieldPath);
  }

  const perRow = createRegistry();
  for (const payload of payloads) {
    await observeSourceSchema({ ...OBSERVATION, payloads: [payload], incrementOccurrence: true }, perRow.db);
  }
  const batched = createRegistry();
  await observeSourceSchema({ ...OBSERVATION, payloads, incrementOccurrence: true }, batched.db);

  // Per row the observer wrote 1 stats upsert + one upsert per distinct field path.
  assert.equal(perRow.queries(), 267 * (1 + paths.size));
  assert.equal(batched.queries(), 1 + paths.size);
  assert.deepEqual(batched.state(), perRow.state());
});

test("267 campaigns: the fan-out issues one campaign lookup, not one per rule", async () => {
  let campaignLookups = 0;
  const db = {
    supplierCampaign: {
      findMany: async () => {
        campaignLookups += 1;
        return [];
      },
    },
  };
  const { probe, service } = createRuleServiceProbe();
  await upsertCommissionRulesForPreparedCampaigns(
    { networkSource: NETWORK, preparedRecords: campaignRecords(267), sourceAccountKey: ACCOUNT },
    { prisma: db, ruleService: service },
  );
  assert.equal(campaignLookups, 1, "campaign resolution must stay batched ahead of the loop");
  assert.equal(probe.calls.length, 267);
});

// ---------------------------------------------------------------------------
// End to end through persistRawPayloadsForPreparedRecords itself.
// ---------------------------------------------------------------------------

function createRawStagingClient() {
  const registry = createRegistry();
  const stored = new Map();
  const ops = [];
  let seq = 0;
  const keyOf = (d) =>
    JSON.stringify([d.supplier, d.sourceAccountLabel, d.resourceKey, String(d.externalId), d.payloadHash]);
  return {
    registry,
    ops,
    stored,
    db: {
      ...registry.db,
      rawPayload: {
        async findUnique({ where }) {
          ops.push("rawPayload.findUnique");
          const w = Object.values(where)[0];
          return (
            stored.get(
              JSON.stringify([w.supplier, w.sourceAccountLabel, w.resourceKey, String(w.externalId), w.payloadHash]),
            ) ?? null
          );
        },
        async create({ data }) {
          ops.push("rawPayload.create");
          seq += 1;
          const rec = { id: `rp-${seq}`, ...data, entityId: data.entityId ?? null };
          stored.set(keyOf(data), rec);
          return rec;
        },
        async update({ where, data }) {
          ops.push("rawPayload.update");
          return { id: where.id, ...data };
        },
      },
    },
  };
}

const { persistRawPayloadsForPreparedRecords } = await import("../src/modules/raw/rawPayload.service.js");

function preparedFrom(rows) {
  return rows.map((raw) => ({
    networkSource: NETWORK,
    entityType: "campaign",
    externalId: `${NETWORK}-campaign-${raw.id}::${ACCOUNT}`,
    rawData: raw,
  }));
}

test("staging a batch observes the batch's schema exactly once per observation group", async () => {
  const client = createRawStagingClient();
  const rows = buildCampaigns(120);

  const outcomes = await persistRawPayloadsForPreparedRecords(preparedFrom(rows), {
    metadata: { sourceAccountKey: ACCOUNT },
    db: client.db,
  });

  assert.equal(outcomes.length, 120);
  assert.equal(outcomes.filter((o) => o.created).length, 120);

  const { stats, fields } = client.registry.state();
  assert.equal(stats.length, 1, "one stats row for the whole batch");
  assert.equal(stats[0][1].totalPayloadsObserved, 120, "every payload in the batch is counted");
  assert.ok(fields.length > 0, "the field registry must actually be written");
  for (const [path, row] of fields) {
    assert.equal(row.occurrenceCount, 120, `${path} must count once per payload`);
  }
  assert.equal(
    client.registry.queries(),
    1 + fields.length,
    "observation must cost one stats write plus one write per field path, for the whole batch",
  );
});

test("a re-staged batch is observed as duplicates and does not inflate occurrence counts", async () => {
  const client = createRawStagingClient();
  const rows = buildCampaigns(40);

  await persistRawPayloadsForPreparedRecords(preparedFrom(rows), {
    metadata: { sourceAccountKey: ACCOUNT },
    db: client.db,
  });
  const afterFirst = client.registry.state();

  const second = await persistRawPayloadsForPreparedRecords(preparedFrom(rows), {
    metadata: { sourceAccountKey: ACCOUNT },
    db: client.db,
  });

  assert.equal(second.filter((o) => o.created).length, 0, "identical payloads must not be re-created");
  const afterSecond = client.registry.state();
  assert.equal(afterSecond.stats[0][1].totalPayloadsObserved, afterFirst.stats[0][1].totalPayloadsObserved);
  for (const [path, row] of afterSecond.fields) {
    const before = afterFirst.fields.find(([p]) => p === path)[1];
    assert.equal(row.occurrenceCount, before.occurrenceCount, `${path} must not double-count`);
  }
});

test("turning batch observation off writes no registry rows at all", async () => {
  const client = createRawStagingClient();
  await persistRawPayloadsForPreparedRecords(preparedFrom(buildCampaigns(10)), {
    metadata: { sourceAccountKey: ACCOUNT },
    db: client.db,
    observeSchema: false,
  });
  assert.equal(client.registry.queries(), 0);
});

test("staging never observes the schema once per row", async () => {
  const client = createRawStagingClient();
  const rows = buildCampaigns(50);
  await persistRawPayloadsForPreparedRecords(preparedFrom(rows), {
    metadata: { sourceAccountKey: ACCOUNT },
    db: client.db,
  });
  assert.ok(
    client.registry.queries() < rows.length,
    `observation cost ${client.registry.queries()} must not scale with the ${rows.length} rows`,
  );
  assert.equal(client.ops.filter((o) => o === "rawPayload.findUnique").length, rows.length);
  assert.equal(client.ops.filter((o) => o === "rawPayload.create").length, rows.length);
});

test("a payload already pointing at an entity is never repointed", async () => {
  const store = createRawPayloadStore([
    { id: "rp-1", entityId: "ent-original", processingStatus: "STAGED" },
    { id: "rp-2", entityId: null, processingStatus: "RECEIVED" },
  ]);
  const updated = await linkRawPayloadsToEntities(
    [
      { id: "rp-1", entityId: "ent-new", currentEntityId: "ent-original", processingStatus: "STAGED" },
      { id: "rp-2", entityId: "ent-2", currentEntityId: null, processingStatus: "RECEIVED" },
    ],
    { db: store.db },
  );
  assert.equal(updated, 1, "only the unlinked payload may be written");
  assert.equal(store.updates(), 1, "an already-linked payload must not even be queried");
  assert.equal(store.rows()[0].entityId, "ent-original", "immutable lineage must not be repointed");
  assert.equal(store.rows()[1].entityId, "ent-2");
});

test("a mixed batch counts only its newly created payloads", async () => {
  const client = createRawStagingClient();
  const firstHalf = buildCampaigns(20);
  await persistRawPayloadsForPreparedRecords(preparedFrom(firstHalf), {
    metadata: { sourceAccountKey: ACCOUNT },
    db: client.db,
  });
  const afterFirst = client.registry.state();
  assert.equal(afterFirst.stats[0][1].totalPayloadsObserved, 20);

  // 20 already-stored payloads plus 20 brand new ones, staged in ONE call.
  const mixed = [...firstHalf, ...buildCampaigns(40).slice(20)];
  const outcomes = await persistRawPayloadsForPreparedRecords(preparedFrom(mixed), {
    metadata: { sourceAccountKey: ACCOUNT },
    db: client.db,
  });
  assert.equal(outcomes.filter((o) => o.created).length, 20, "half the batch is new");
  assert.equal(outcomes.filter((o) => !o.created).length, 20, "half the batch is a duplicate");

  const afterMixed = client.registry.state();
  assert.equal(
    afterMixed.stats[0][1].totalPayloadsObserved,
    40,
    "only the 20 created payloads may be added to the observed total",
  );
  for (const [path, row] of afterMixed.fields) {
    const before = afterFirst.fields.find(([p]) => p === path);
    if (!before) continue;
    assert.equal(
      row.occurrenceCount,
      before[1].occurrenceCount + 20,
      `${path} must count the created payloads only`,
    );
  }
});

test("raw staging hands the linkage guard the payload's real entity id", async () => {
  // upsertManyRawEntities builds the links from its own outcomes and uses the prisma singleton,
  // so the guard is pinned where it is written: a literal here would silently re-enable repointing.
  const { readFile } = await import("node:fs/promises");
  const { functionBody } = await import("./helpers/jsGuardScan.js");
  const source = await readFile(new URL("../src/modules/raw/raw.service.js", import.meta.url), "utf8");
  const staging = functionBody(source, "upsertManyRawEntities");
  assert.ok(
    staging.includes("currentEntityId: rawRecord.entityId"),
    "the link must carry the stored entity id so an already-linked payload is skipped",
  );
  assert.ok(
    staging.includes("await linkRawPayloadsToEntities(links)"),
    "entity linkage must go through the batched helper",
  );
});
