import test from "node:test";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { resolveExternalId } from "../src/modules/raw/raw.service.js";
import {
  batchUpsertEntities,
  dedupeEntityRecords,
  entityConflictKey,
} from "../src/modules/raw/batchEntityUpsert.js";

const NETWORK = "optimise_sea";
const REPORT = `${NETWORK}-report`;
const INVOICE_REPORT = `${NETWORK}-invoice-report`;

const id = (row, prefix = REPORT, index = 0) => resolveExternalId(row, prefix, index, "performance");

/**
 * Optimise reporting is one aggregate per requested dimension set:
 *   reporting         campaignId, campaignName, advertiserName, date
 *   invoiceReporting  campaignId, campaignName, advertiserName, invoiceDate, date
 */
const reportingRow = (over = {}) => ({
  report_type: "conversion_date",
  campaignId: 5001,
  campaignName: "Summer Sale",
  advertiserName: "Acme",
  date: "2026-07-14",
  ...over,
});

const invoiceRow = (over = {}) => ({
  report_type: "invoice_date",
  campaignId: 5001,
  campaignName: "Summer Sale",
  advertiserName: "Acme",
  date: "2026-07-14",
  invoiceDate: "2026-07-31",
  ...over,
});

// ---------------------------------------------------------------------------
// Distinct supplier facts must not collapse.
// ---------------------------------------------------------------------------

test("two campaigns sharing a name on one date are different facts", () => {
  assert.notEqual(
    id(reportingRow({ campaignId: 5001, advertiserName: "Acme" })),
    id(reportingRow({ campaignId: 7788, advertiserName: "Globex" })),
  );
});

test("a different campaign id alone is enough to separate two reporting rows", () => {
  assert.notEqual(id(reportingRow({ campaignId: 5001 })), id(reportingRow({ campaignId: 5002 })));
});

test("campaign names that differ only past the readable limit are different facts", () => {
  const shared = "A".repeat(80);
  assert.notEqual(
    id(reportingRow({ campaignName: `${shared}-ALPHA` })),
    id(reportingRow({ campaignName: `${shared}-BETA` })),
  );
});

test("invoice rows sharing a conversion date but not an invoice date are different facts", () => {
  assert.notEqual(
    id(invoiceRow({ invoiceDate: "2026-07-31" }), INVOICE_REPORT),
    id(invoiceRow({ invoiceDate: "2026-08-31" }), INVOICE_REPORT),
  );
});

test("a different advertiser on the same campaign name and date is a different fact", () => {
  assert.notEqual(
    id(reportingRow({ campaignId: null, advertiserName: "Acme" })),
    id(reportingRow({ campaignId: null, advertiserName: "Globex" })),
  );
});

test("the conversion-date and invoice-date reports never share an identity", () => {
  assert.notEqual(id(reportingRow()), id(invoiceRow(), INVOICE_REPORT));
});

// ---------------------------------------------------------------------------
// The same fact must still collapse, and must do so across runs.
// ---------------------------------------------------------------------------

test("the same supplier fact resolves to the same identity every time", () => {
  assert.equal(id(reportingRow()), id(reportingRow()));
  assert.equal(id(invoiceRow(), INVOICE_REPORT), id(invoiceRow(), INVOICE_REPORT));
});

test("identity does not depend on the row's position in the batch", () => {
  assert.equal(id(reportingRow(), REPORT, 0), id(reportingRow(), REPORT, 97));
});

test("identity does not depend on the order of keys in the payload", () => {
  const a = { report_type: "conversion_date", campaignId: 5001, campaignName: "S", advertiserName: "Acme", date: "2026-07-14" };
  const b = { date: "2026-07-14", advertiserName: "Acme", campaignName: "S", campaignId: 5001, report_type: "conversion_date" };
  assert.equal(id(a), id(b));
});

test("a row with nothing beyond the readable part keeps its original identity", () => {
  // No campaignId, no advertiser, no second date, short name: the id must be unchanged, so
  // already-staged rows of other networks are not re-keyed.
  const row = { report_type: "conversion_date", campaignName: "Short Name", date: "2026-07-14" };
  assert.equal(id(row), `${REPORT}-conversion_date-Short Name-2026-07-14`);
});

test("an invoice-only row states its invoice date in the readable part, not twice", () => {
  const row = { report_type: "invoice_date", campaignName: "Short Name", invoiceDate: "2026-07-31" };
  assert.equal(id(row, INVOICE_REPORT), `${INVOICE_REPORT}-invoice_date-Short Name-2026-07-31`);
});

// ---------------------------------------------------------------------------
// Other identity rules must not move.
// ---------------------------------------------------------------------------

test("campaign, conversion, coupon, deal and invoice identities are untouched", () => {
  assert.equal(
    resolveExternalId({ invoiceId: "INV-1", record_source: "invoice" }, "p", 0, "payment"),
    "p-INV-1",
  );
  assert.equal(
    resolveExternalId({ report_type: "summary", period_from: "2026-07-01", period_to: "2026-07-31" }, "p", 0, "performance"),
    "p-summary-2026-07-01-2026-07-31",
  );
  assert.equal(
    resolveExternalId({ order_id: "O-9", campaign_id: 4 }, "p", 0, "performance"),
    "p-order-4-O-9",
  );
  assert.equal(
    resolveExternalId({ campaign_id: 4, date: "2026-07-14" }, "p", 0, "performance"),
    "p-campaign-4-2026-07-14",
  );
  assert.equal(resolveExternalId({ record_source: "coupon", id: 7 }, "p", 0, "coupon"), "p-coupon-7");
  assert.equal(resolveExternalId({ record_source: "deal", id: 7 }, "p", 0, "coupon"), "p-deal-7");
  assert.equal(
    resolveExternalId({ record_source: "commission_group", campaignId: 3, id: 9 }, "p", 0, "commission_group"),
    "p-3-9",
  );
});

// ---------------------------------------------------------------------------
// The batch statement. Postgres raises 21000 when ONE statement proposes the
// same constrained values twice.
// ---------------------------------------------------------------------------

/** Values a single VALUES tuple carries: a generated uuid, the record columns, and the timestamp. */
const TUPLE_VALUE_COUNT = 17;
const TUPLE_EXTERNAL_ID = 1;
const TUPLE_NETWORK_SOURCE = 2;
const TUPLE_ENTITY_TYPE = 3;

/**
 * Rejects a statement carrying duplicate conflict keys, exactly as Postgres does.
 *
 * It reads the flattened values of the real Prisma.sql the code builds, so it checks what would
 * actually be sent rather than a parallel model of it.
 */
function createConflictAwareClient() {
  const statements = [];
  const written = new Map();
  return {
    statements,
    written,
    db: {
      async $executeRaw(strings, ...interpolations) {
        const flat = interpolations.flatMap((value) =>
          Array.isArray(value?.values) ? value.values : [value],
        );
        assert.equal(
          flat.length % TUPLE_VALUE_COUNT,
          0,
          `tuple shape changed: ${flat.length} values do not divide into rows of ${TUPLE_VALUE_COUNT}`,
        );
        const seen = new Set();
        const rows = [];
        for (let at = 0; at < flat.length; at += TUPLE_VALUE_COUNT) {
          const key = [
            flat[at + TUPLE_EXTERNAL_ID],
            flat[at + TUPLE_NETWORK_SOURCE],
            flat[at + TUPLE_ENTITY_TYPE],
          ].join("\u0000");
          if (seen.has(key)) {
            const error = new Error(
              "Raw query failed. Code: `21000`. Message: `ERROR: ON CONFLICT DO UPDATE command cannot affect row a second time`",
            );
            error.code = "21000";
            throw error;
          }
          seen.add(key);
          rows.push(key);
          written.set(key, flat.slice(at, at + TUPLE_VALUE_COUNT));
        }
        statements.push(rows.length);
        return rows.length;
      },
    },
  };
}

/** The revenue column of a written tuple, for last-write-wins assertions. */
const TUPLE_REVENUE = 11;
const writtenRevenue = (client, rec) => client.written.get(entityConflictKey(rec))?.[TUPLE_REVENUE];

const record = (over = {}) => ({
  externalId: "e-1",
  networkSource: NETWORK,
  entityType: "performance",
  entityName: null,
  campaignName: null,
  advertiserName: null,
  entityStatus: null,
  entitySubType: null,
  code: null,
  discount: null,
  revenue: null,
  commission: null,
  eventDate: null,
  normalizedData: {},
  rawData: {},
  ...over,
});

test("the conflict key is exactly the database's unique constraint", () => {
  const base = record();
  assert.equal(entityConflictKey(base), entityConflictKey(record()));
  assert.notEqual(entityConflictKey(base), entityConflictKey(record({ externalId: "e-2" })));
  assert.notEqual(entityConflictKey(base), entityConflictKey(record({ networkSource: "optimise_uk" })));
  assert.notEqual(entityConflictKey(base), entityConflictKey(record({ entityType: "campaign" })));
});

test("duplicate keys in one batch no longer reach a single statement twice", async () => {
  const client = createConflictAwareClient();
  const records = [record({ revenue: 1 }), record({ revenue: 2 })];
  const result = await batchUpsertEntities(records, { db: client.db });
  assert.equal(result.duplicatesCollapsed, 1);
  assert.equal(result.count, 1);
  assert.equal(writtenRevenue(client, records[0]), 2, "last write wins");
});

test("the unpatched shape really does fail: one statement, two identical keys", async () => {
  // This is the sequence-49 failure. Chunking is bypassed so the pair reaches one statement,
  // which is exactly what happened before de-duplication moved ahead of chunking.
  const client = createConflictAwareClient();
  const rows = [record({ revenue: 1 }), record({ revenue: 2 })];
  const tuples = rows.map((r) =>
    Prisma.sql`(${randomUUID()}::uuid, ${r.externalId}, ${r.networkSource}, ${r.entityType}, ${r.entityName}, ${r.campaignName}, ${r.advertiserName}, ${r.entityStatus}, ${r.entitySubType}, ${r.code}, ${r.discount}, ${r.revenue}, ${r.commission}, ${r.eventDate}, ${JSON.stringify(r.normalizedData)}::jsonb, ${JSON.stringify(r.rawData)}::jsonb, ${new Date()})`,
  );
  await assert.rejects(
    () => client.db.$executeRaw`INSERT INTO "Entity" VALUES ${Prisma.join(tuples)} ON CONFLICT DO UPDATE`,
    /21000/,
  );
});

test("behaviour does not depend on where the chunk boundary falls", async () => {
  // Positions 98/99 land in one statement; 99/100 straddle the 100-row boundary. Both must behave
  // the same now, which is the defect that made this failure look intermittent.
  for (const [a, b] of [
    [98, 99],
    [99, 100],
    [0, 199],
    [100, 101],
  ]) {
    const records = Array.from({ length: 220 }, (_, i) => record({ externalId: `e-${i}` }));
    records[a] = record({ externalId: "dup", revenue: 1 });
    records[b] = record({ externalId: "dup", revenue: 2 });

    const client = createConflictAwareClient();
    const result = await batchUpsertEntities(records, { db: client.db });
    assert.equal(result.duplicatesCollapsed, 1, `pair ${a}/${b} must collapse`);
    assert.equal(result.count, 219, `pair ${a}/${b} must write every distinct row`);
    assert.equal(
      writtenRevenue(client, record({ externalId: "dup" })),
      2,
      `pair ${a}/${b} must keep the later record`,
    );
  }
});

test("de-duplication keeps the last record but the first position", () => {
  const records = [
    record({ externalId: "a", revenue: 1 }),
    record({ externalId: "dup", revenue: 10 }),
    record({ externalId: "b", revenue: 2 }),
    record({ externalId: "dup", revenue: 20 }),
    record({ externalId: "c", revenue: 3 }),
  ];
  const { records: deduped, duplicatesCollapsed } = dedupeEntityRecords(records);
  assert.equal(duplicatesCollapsed, 1);
  assert.deepEqual(deduped.map((r) => r.externalId), ["a", "dup", "b", "c"]);
  assert.equal(deduped[1].revenue, 20, "the later record survives");
});

test("rows differing only by network or entity type are not collapsed", async () => {
  const client = createConflictAwareClient();
  const records = [
    record({ externalId: "same" }),
    record({ externalId: "same", networkSource: "optimise_uk" }),
    record({ externalId: "same", entityType: "campaign" }),
  ];
  const result = await batchUpsertEntities(records, { db: client.db });
  assert.equal(result.duplicatesCollapsed, 0);
  assert.equal(result.count, 3);
});

test("a batch with no duplicates is passed through unchanged", async () => {
  const client = createConflictAwareClient();
  const records = Array.from({ length: 250 }, (_, i) => record({ externalId: `e-${i}` }));
  const result = await batchUpsertEntities(records, { db: client.db });
  assert.equal(result.duplicatesCollapsed, 0);
  assert.equal(result.count, 250);
  assert.deepEqual(client.statements, [100, 100, 50], "chunking itself is unchanged");
});

test("replaying the same batch is idempotent", async () => {
  const client = createConflictAwareClient();
  const records = [record({ externalId: "a", revenue: 1 }), record({ externalId: "b", revenue: 2 })];
  const first = await batchUpsertEntities(records, { db: client.db });
  const snapshot = new Map([...client.written].map(([k, v]) => [k, v[TUPLE_REVENUE]]));
  const second = await batchUpsertEntities(records, { db: client.db });
  assert.equal(second.count, first.count);
  assert.equal(second.duplicatesCollapsed, 0);
  assert.deepEqual(
    new Map([...client.written].map(([k, v]) => [k, v[TUPLE_REVENUE]])),
    snapshot,
    "a replay must not change what is stored",
  );
});

test("an empty batch issues no statement", async () => {
  const client = createConflictAwareClient();
  const result = await batchUpsertEntities([], { db: client.db });
  assert.deepEqual(result, { count: 0, batchMs: 0, duplicatesCollapsed: 0 });
  assert.deepEqual(client.statements, []);
});

// ---------------------------------------------------------------------------
// A production-shaped sequence-49 batch.
// ---------------------------------------------------------------------------

test("a reporting window whose campaigns share names stages every distinct fact", () => {
  const rows = [];
  for (let day = 10; day <= 16; day += 1) {
    for (const [campaignId, advertiserName] of [[5001, "Acme"], [7788, "Globex"], [9002, "Initech"]]) {
      rows.push(reportingRow({ campaignId, advertiserName, date: `2026-07-${day}` }));
    }
  }
  const ids = rows.map((row, i) => id(row, REPORT, i));
  assert.equal(new Set(ids).size, rows.length, "21 distinct facts must produce 21 identities");
});

test("the same window replayed produces the same identities in the same order", () => {
  const build = () =>
    [10, 11, 12].flatMap((day) =>
      [[5001, "Acme"], [7788, "Globex"]].map(([campaignId, advertiserName]) =>
        reportingRow({ campaignId, advertiserName, date: `2026-07-${day}` }),
      ),
    );
  assert.deepEqual(
    build().map((row, i) => id(row, REPORT, i)),
    build().map((row, i) => id(row, REPORT, i)),
  );
});
