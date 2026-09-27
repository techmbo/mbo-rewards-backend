/**
 * Partnerize conversion → canonical Order.
 *
 * Partnerize reports the publisher's commission as publisher_commission, the event time as
 * conversion_time and the order value as conversion_value. Promotion's generic fallbacks read none
 * of those names, so every staged Partnerize conversion was skipped as missing_supplier_commission
 * (or, with a commission, missing_conversion_date) and never reached upsertOrder.
 *
 * The end-to-end case runs the real chain: the Partnerize adapter's fetchConversions over a fake
 * HTTP client → the sync's conversion normalisation → the real upsertManyRawEntities over in-memory
 * prisma doubles → ConversionPromotionService.promoteEntity → the real OrderIngestionService.
 */
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "silent";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";

const { createPartnerizeAdapter } = await import("../src/adapters/partnerize.adapter.js");
const { upsertManyRawEntities } = await import("../src/modules/raw/raw.service.js");
const { entityStagingBarrier } = await import("../src/jobs/entityStagingBarrier.js");
const { prisma } = await import("../src/database/prisma.js");
const { mapEntityToConversionIngest, ConversionPromotionService } = await import(
  "../src/modules/reporting/services/conversionPromotion.service.js"
);
const { OrderIngestionService } = await import("../src/modules/order/orderIngestion.service.js");
const { resolveOrderStatusFromNetworkRaw, VERIFIED_NETWORK_STATUS_REGISTRY, MBO_ORDER_STATUS } = await import(
  "../src/modules/order/orderStatusNormalization.contract.js"
);
const { FinancialTransactionService } = await import("../src/modules/finance/financialTransaction.service.js");

/** The certification sample's conversion row: Partnerize's own field names. */
const CERTIFICATION_ROW = Object.freeze({
  conversion_id: "CONV-123456",
  campaign_id: "1011l6400",
  publisher_reference: "order-abc-789",
  publisher_commission: "12.3400",
  conversion_value: "199.9900",
  currency: "EUR",
  conversion_time: "2026-09-12T10:00:00Z",
  conversion_status: "approved",
  adref: "client-9",
  pubref: "assignment-7",
  clickref: "click-42",
});

/**
 * The sync's conversion normalisation (waveESupplierSync.js normalizePartnerizeConversion, which is
 * module-private). Mirrored here and pinned to the source below so the two cannot drift.
 */
function normalizePartnerizeConversion(row) {
  const nested = row?.conversion && typeof row.conversion === "object" ? row.conversion : null;
  const base = nested ? { ...nested, ...row } : row;
  const id = base?.conversion_id ?? base?.conversionId ?? base?.id ?? null;
  return { ...base, id, conversionId: id };
}

function makeAdapter(payload) {
  const requests = [];
  const httpClient = {
    get: async (path, config) => {
      requests.push({ path, params: config?.params });
      return { data: payload };
    },
  };
  const adapter = createPartnerizeAdapter({
    applicationKey: "zzappzz",
    userApiKey: "zzuserzz",
    publisherId: "pub-1",
    httpClient,
  });
  return { adapter, requests };
}

/* ------------------------------------------------------------------ in-memory staging db */

function stubPrisma() {
  const state = { entities: new Map(), raws: new Map() };
  const ekey = (e, n, t) => `${e}|${n}|${t}`;
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
      const key = ekey(k.externalId, k.networkSource, k.entityType);
      const existing = state.entities.get(key);
      if (existing) return existing;
      const row = { id: `entity-${state.entities.size + 1}`, ...create };
      state.entities.set(key, row);
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
      const row = { id: `raw-${state.raws.size + 1}`, ...data };
      state.raws.set(row.id, row);
      return row;
    },
    async update({ where, data }) {
      const row = state.raws.get(where.id);
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
      // Non-coupon staging is one raw INSERT INTO "Entity" … ON CONFLICT (batchEntityUpsert.js). Decode
      // its bound values — 17 per row, in the statement's column order — into the staged rows.
      $executeRaw: async (strings, ...params) => {
        if (!String(strings?.join?.("") ?? "").includes('INSERT INTO "Entity"')) return 1;
        // A Prisma.sql fragment carries its flattened bound values on .values.
        const values = params.flatMap((p) => (p && Array.isArray(p.values) && Array.isArray(p.strings) ? p.values : [p]));
        const COLUMNS = [
          "id", "externalId", "networkSource", "entityType", "entityName", "campaignName",
          "advertiserName", "entityStatus", "entitySubType", "code", "discount", "revenue",
          "commission", "eventDate", "normalizedData", "rawData", "updatedAt",
        ];
        assert.equal(values.length % COLUMNS.length, 0, "unexpected Entity INSERT shape");
        for (let i = 0; i < values.length; i += COLUMNS.length) {
          const row = Object.fromEntries(COLUMNS.map((c, j) => [c, values[i + j]]));
          row.normalizedData = JSON.parse(row.normalizedData);
          row.rawData = JSON.parse(row.rawData);
          state.entities.set(ekey(row.externalId, row.networkSource, row.entityType), row);
        }
        return values.length / COLUMNS.length;
      },
    },
  };
}

async function withDb(fn) {
  const { state, delegates } = stubPrisma();
  const originalBarrierDb = entityStagingBarrier.db;
  const originals = {};
  for (const n of Object.keys(delegates)) originals[n] = prisma[n];
  entityStagingBarrier.db = {
    jobRun: {
      async create({ data }) { return { id: "t1", ...data }; },
      async findMany() { return []; },
      async findFirst() { return null; },
      async updateMany() { return { count: 1 }; },
      async update() { return {}; },
    },
  };
  for (const [n, d] of Object.entries(delegates)) prisma[n] = d;
  try {
    return await fn({ state });
  } finally {
    entityStagingBarrier.db = originalBarrierDb;
    for (const [n, o] of Object.entries(originals)) prisma[n] = o;
  }
}

/** Fetch → normalise → stage one Partnerize response; returns the staged conversion entities. */
async function fetchAndStage(payload) {
  const { adapter } = makeAdapter(payload);
  const fetched = await adapter.fetchConversions({ start_date: "2026-09-01", end_date: "2026-09-14" });
  const rows = fetched.map(normalizePartnerizeConversion);
  return withDb(async ({ state }) => {
    await upsertManyRawEntities({
      networkSource: "partnerize",
      entityType: "conversion",
      rows,
      externalIdPrefix: "partnerize-conversion",
      sourceAccountKey: null,
    });
    return { fetched, entities: [...state.entities.values()] };
  });
}

/** Promotion with a recording upsertOrder that forwards to the REAL OrderIngestionService. */
function promotionHarness() {
  const upsertInputs = [];
  const createdOrders = [];
  const orderDb = {
    order: {
      findUnique: mock.fn(async () => null),
      findFirst: mock.fn(async () => null),
      create: mock.fn(async ({ data }) => {
        createdOrders.push(data);
        return { ...data, id: `order-${createdOrders.length}`, items: [], conversions: [] };
      }),
      // Like Prisma, an update returns the whole row, not just the patch.
      update: mock.fn(async ({ where, data }) => {
        const index = Number(String(where.id).replace("order-", "")) - 1;
        const current = createdOrders[index] ?? {};
        Object.assign(current, data);
        return { ...current, id: where.id, items: [], conversions: [] };
      }),
    },
  };
  const orderExceptions = [];
  const realOrders = new OrderIngestionService({
    prisma: orderDb,
    exceptions: { report: async (event) => { orderExceptions.push(event); return {}; } },
    audit: { record: mock.fn(async () => {}) },
    validation: { transition: mock.fn(async () => ({})) },
  });
  const ingested = [];
  const financeCalls = [];
  const service = new ConversionPromotionService({
    orders: {
      upsertOrder: async (input, client) => {
        upsertInputs.push(input);
        return realOrders.upsertOrder(input, client);
      },
    },
    attribution: {
      ingestConversion: async (input) => {
        ingested.push(input);
        return { id: "conv-1", attributionStatus: "UNATTRIBUTED" };
      },
    },
    exceptions: { report: mock.fn(async () => ({})) },
    // No catalog tables and no raw payload rows: both lookups are best-effort and return nothing.
    prisma: {},
    finance: {
      syncApprovedBasisForOrder: async (args) => {
        financeCalls.push(args);
        return { orderId: args.orderId, results: [] };
      },
    },
  });
  return { service, upsertInputs, createdOrders, ingested, orderExceptions, financeCalls };
}

function stagedEntity(rowOverrides = {}, { dropKeys = [] } = {}) {
  const raw = { ...CERTIFICATION_ROW, ...rowOverrides };
  for (const k of dropKeys) delete raw[k];
  const normalized = normalizePartnerizeConversion(raw);
  return {
    id: "entity-x",
    entityType: "conversion",
    networkSource: "partnerize",
    externalId: `partnerize-conversion-${normalized.conversion_id}`,
    rawData: normalized,
    normalizedData: {},
  };
}

/* ======================================================================= the chain */

describe("Partnerize fetched row → staged entity → promotion → upsertOrder", () => {
  it("the sync's normaliser is the one mirrored here", () => {
    const src = readFileSync("src/jobs/waveESupplierSync.js", "utf8");
    const body = src.split("function normalizePartnerizeConversion(row) {")[1]?.split("\n}\n")[0];
    assert.ok(body, "normalizePartnerizeConversion not found in the sync");
    for (const line of [
      "const nested = row?.conversion && typeof row.conversion === \"object\" ? row.conversion : null;",
      "const base = nested ? { ...nested, ...row } : row;",
      "const id = base?.conversion_id ?? base?.conversionId ?? base?.id ?? null;",
      "return { ...base, id, conversionId: id };",
    ]) {
      assert.ok(body.includes(line), `sync normaliser changed: ${line}`);
    }
    assert.match(src, /conversions = resultRows\(run\)\.map\(normalizePartnerizeConversion\);/);
  });

  it("a certification-shaped conversion is staged, promoted, and becomes a canonical Order", async () => {
    const { fetched, entities } = await fetchAndStage({ conversions: [{ conversion: { ...CERTIFICATION_ROW } }] });
    assert.equal(fetched.length, 1, "adapter returned the row");
    assert.equal(entities.length, 1, "one conversion entity staged");
    const entity = entities[0];
    assert.equal(entity.entityType, "conversion");
    assert.equal(entity.networkSource, "partnerize");
    assert.equal(entity.rawData.publisher_commission, "12.3400");
    assert.equal(entity.rawData.conversion_time, "2026-09-12T10:00:00Z");

    const h = promotionHarness();
    const outcome = await h.service.promoteEntity(entity);
    assert.equal(outcome.result, "promoted", JSON.stringify(outcome));

    assert.equal(h.upsertInputs.length, 1, "upsertOrder called once");
    const input = h.upsertInputs[0];
    assert.equal(input.supplier, "PARTNERIZE");
    assert.equal(input.supplierConversionId, "CONV-123456");
    assert.equal(input.sourceAccountLabel, "default");
    assert.equal(input.orderValue, 199.99);
    assert.equal(input.currency, "EUR");
    assert.ok(input.orderDate instanceof Date);
    assert.equal(input.orderDate.toISOString(), "2026-09-12T10:00:00.000Z");
    assert.equal(input.metadata.networkConversionId, "CONV-123456");
    assert.equal(input.metadata.dedupeKey, "PARTNERIZE|default|CONV-123456");

    // The real OrderIngestionService accepts it and creates exactly one order.
    assert.equal(h.createdOrders.length, 1, "OrderIngestionService created the order");
    assert.equal(h.createdOrders[0].supplier, "PARTNERIZE");
    assert.equal(outcome.orderId, "order-1");

    // The conversion carries the publisher commission, not a derived number.
    assert.equal(h.ingested.length, 1);
    assert.equal(h.ingested[0].supplierCommission, "12.3400");
    assert.equal(h.ingested[0].orderId, "order-1");
  });
});

/* ============================================================ mapping edge cases */

describe("Partnerize promotion mapping", () => {
  it("conversion_value as a plain value is the order value", () => {
    for (const [value, expected] of [["199.9900", 199.99], [250, 250], ["0", 0]]) {
      const mapped = mapEntityToConversionIngest(stagedEntity({ conversion_value: value }));
      assert.equal(mapped.ok, true, JSON.stringify(mapped));
      assert.equal(mapped.input._order.orderValue, expected);
    }
  });

  it("conversion_value as an object uses its .value", () => {
    const mapped = mapEntityToConversionIngest(
      stagedEntity({ conversion_value: { value: "321.50", publisher: "12.34", currency: "EUR" } }),
    );
    assert.equal(mapped.ok, true, JSON.stringify(mapped));
    assert.equal(mapped.input._order.orderValue, 321.5);
  });

  it("a missing publisher_commission still skips safely", () => {
    const mapped = mapEntityToConversionIngest(stagedEntity({}, { dropKeys: ["publisher_commission"] }));
    assert.deepEqual(mapped, { ok: false, reason: "missing_supplier_commission" });
  });

  it("a non-numeric publisher_commission is not a commission and skips safely", () => {
    const mapped = mapEntityToConversionIngest(stagedEntity({ publisher_commission: "n/a" }));
    assert.deepEqual(mapped, { ok: false, reason: "missing_supplier_commission" });
  });

  it("a malformed conversion_time skips safely and never borrows another date field", () => {
    for (const bad of ["not-a-date", "2026-13-45T99:99:99Z"]) {
      const mapped = mapEntityToConversionIngest(stagedEntity({ conversion_time: bad, conversion_date: "2026-09-12" }));
      assert.deepEqual(mapped, { ok: false, reason: "missing_conversion_date" }, bad);
    }
  });

  it("a missing conversion_time skips safely", () => {
    const mapped = mapEntityToConversionIngest(stagedEntity({}, { dropKeys: ["conversion_time"] }));
    assert.deepEqual(mapped, { ok: false, reason: "missing_conversion_date" });
  });

  it("a skipped row never reaches upsertOrder", async () => {
    const h = promotionHarness();
    const outcome = await h.service.promoteEntity(stagedEntity({}, { dropKeys: ["publisher_commission"] }));
    assert.equal(outcome.result, "skipped");
    assert.equal(outcome.reason, "missing_supplier_commission");
    assert.equal(h.upsertInputs.length, 0);
    assert.equal(h.createdOrders.length, 0);
  });

  it("publisher_commission takes precedence over a generic commission field on Partnerize rows", () => {
    const mapped = mapEntityToConversionIngest(stagedEntity({ commission: "99.00" }));
    assert.equal(mapped.ok, true);
    assert.equal(mapped.input.supplierCommission, "12.3400");
  });

  it("the Partnerize field names change nothing for another supplier", () => {
    const other = {
      id: "entity-y",
      entityType: "conversion",
      networkSource: "impact",
      externalId: "impact-conversion-CONV-123456",
      rawData: { ...CERTIFICATION_ROW, id: "CONV-123456", conversionId: "CONV-123456" },
      normalizedData: {},
    };
    // Before and after this change: Impact does not read publisher_commission.
    assert.deepEqual(mapEntityToConversionIngest(other), { ok: false, reason: "missing_supplier_commission" });
    // And with a generic commission it still does not read conversion_time.
    other.rawData = { ...other.rawData, commission: "5.00" };
    assert.deepEqual(mapEntityToConversionIngest(other), { ok: false, reason: "missing_conversion_date" });
  });
});

/* ================================================== verified conversion-status mapping */

/** Fetch → normalise → stage → promote one Partnerize row with the given conversion_status. */
async function promoteWithStatus(rowOverrides = {}, { dropKeys = [] } = {}) {
  const row = { ...CERTIFICATION_ROW, ...rowOverrides };
  for (const k of dropKeys) delete row[k];
  const { entities } = await fetchAndStage({ conversions: [{ conversion: row }] });
  assert.equal(entities.length, 1, "one conversion entity staged");
  const h = promotionHarness();
  const outcome = await h.service.promoteEntity(entities[0]);
  assert.equal(outcome.result, "promoted", JSON.stringify(outcome));
  assert.equal(h.createdOrders.length, 1, "one order created");
  return { h, outcome, input: h.upsertInputs[0], order: h.createdOrders[0], conversion: h.ingested[0] };
}

const unknownStatusExceptions = (h) => h.orderExceptions.filter((e) => e.type === "MAPPING_UNKNOWN_ENUM");

/**
 * The real finance recogniser over an in-memory db holding exactly the promoted order and its
 * conversion. No supplier payment, bank receipt or reconciliation fact is invented: the call only
 * shows which gate the order stops at.
 */
async function recogniseAgainst(order) {
  const reported = [];
  const storedOrder = { ...order, id: "order-1", items: [] };
  const db = {
    financialTransaction: { findUnique: async () => null },
    conversion: {
      findUnique: async () => ({ id: "conv-1", orderId: "order-1", order: storedOrder, clientAssignment: null }),
    },
    order: { findUnique: async () => storedOrder },
  };
  const finance = new FinancialTransactionService({
    prisma: db,
    audit: { record: async () => {} },
    exceptions: { report: async (event) => { reported.push(event); return {}; } },
  });
  const result = await finance.recognizeConversion({ orderId: "order-1", conversionId: "conv-1" }, db);
  return { result, reported };
}

describe("Partnerize conversion_status → verified mapping → Order validation", () => {
  it("the registry holds exactly the three verified Partnerize conversion statuses", () => {
    const partnerize = VERIFIED_NETWORK_STATUS_REGISTRY.filter((r) => r.supplier === "PARTNERIZE");
    assert.deepEqual(
      partnerize.map((r) => [r.sourceObject, r.sourceReport, r.rawStatus, r.mboOrderStatus]),
      [
        ["conversions", null, "pending", "PENDING"],
        ["conversions", null, "approved", "CONFIRMED"],
        ["conversions", null, "rejected", "REJECTED"],
      ],
    );
    for (const r of partnerize) {
      assert.equal(r.supplierPaymentStatus, null, "an order status entry must not imply a payment state");
      assert.match(r.evidence, /Integration_Master_CANONICAL_FINAL/);
    }
    for (const absent of ["declined", "mixed", "Approved", "APPROVED"]) {
      assert.ok(!partnerize.some((r) => r.rawStatus === absent), `${absent} must not be mapped`);
    }
  });

  it("approved: fetch → stage → promote → Order CONFIRMED / VALIDATION_APPROVED, raw status kept, no exception", async () => {
    const { h, input, order, conversion } = await promoteWithStatus({ conversion_status: "approved" });
    assert.equal(input.networkRawStatus, "approved");
    assert.equal(input.mboOrderStatus, MBO_ORDER_STATUS.CONFIRMED);
    assert.equal(input.statusMappingExceptionRequired, false);
    assert.equal(input.statusSourceObject, "conversions");
    assert.equal(order.validationStatus, "VALIDATION_APPROVED");
    assert.equal(order.metadata.networkRawStatus, "approved");
    assert.equal(order.metadata.network_raw_status, "approved");
    assert.equal(order.metadata.mboOrderStatus, "CONFIRMED");
    assert.equal(order.metadata.statusMappingExceptionRequired, false);
    assert.equal(conversion.status, "APPROVED");
    assert.equal(conversion.metadata.statusMappingStatus, "MAPPED");
    assert.equal(conversion.metadata.statusMappingSourceObject, "CONVERSIONS");
    assert.deepEqual(unknownStatusExceptions(h), [], "a verified status raised an unknown-status exception");
  });

  it("pending: → PENDING / VALIDATION_PENDING, conversion PENDING", async () => {
    const { h, input, order, conversion } = await promoteWithStatus({ conversion_status: "pending" });
    assert.equal(input.networkRawStatus, "pending");
    assert.equal(input.mboOrderStatus, MBO_ORDER_STATUS.PENDING);
    assert.equal(order.validationStatus, "VALIDATION_PENDING");
    assert.equal(order.metadata.mboOrderStatus, "PENDING");
    assert.equal(conversion.status, "PENDING");
    assert.deepEqual(unknownStatusExceptions(h), []);
  });

  it("rejected: → REJECTED / VALIDATION_REJECTED, conversion REJECTED", async () => {
    const { h, input, order, conversion } = await promoteWithStatus({ conversion_status: "rejected" });
    assert.equal(input.networkRawStatus, "rejected");
    assert.equal(input.mboOrderStatus, MBO_ORDER_STATUS.REJECTED);
    assert.equal(order.validationStatus, "VALIDATION_REJECTED");
    assert.equal(conversion.status, "REJECTED");
    assert.deepEqual(unknownStatusExceptions(h), []);
  });

  it("an unknown value is preserved, sent to review with a mapping exception, and never confirmed", async () => {
    for (const raw of ["declined", "mixed", "Approved", "on_hold"]) {
      const { h, input, order, conversion } = await promoteWithStatus({ conversion_status: raw });
      assert.equal(input.networkRawStatus, raw, `${raw} not preserved verbatim`);
      assert.equal(input.mboOrderStatus, null, raw);
      assert.equal(input.statusMappingExceptionRequired, true, raw);
      assert.equal(order.validationStatus, "VALIDATION_NEEDS_REVIEW", raw);
      assert.equal(order.metadata.networkRawStatus, raw);
      assert.equal(conversion.status, "UNKNOWN", raw);
      assert.equal(conversion.metadata.statusMappingReason, "source_status_mapping_not_verified", raw);
      const ex = unknownStatusExceptions(h);
      assert.equal(ex.length, 1, raw);
      assert.equal(ex[0].metadata.networkRawStatus, raw);
    }
  });

  it("conversion_status takes precedence over generic status fields", async () => {
    const { input, order } = await promoteWithStatus({ conversion_status: "pending", status: "approved", State: "approved" });
    assert.equal(input.networkRawStatus, "pending");
    assert.equal(input.mboOrderStatus, MBO_ORDER_STATUS.PENDING);
    assert.equal(order.validationStatus, "VALIDATION_PENDING");
  });

  it("a Partnerize status from a generic field carries no conversions scope and stays under review", async () => {
    const { h, input, order } = await promoteWithStatus({ status: "approved" }, { dropKeys: ["conversion_status"] });
    assert.equal(input.networkRawStatus, "approved");
    assert.equal(input.statusSourceObject, null);
    assert.equal(input.mboOrderStatus, null);
    assert.equal(order.validationStatus, "VALIDATION_NEEDS_REVIEW");
    assert.equal(unknownStatusExceptions(h).length, 1);
  });

  it("the entries are scoped to the conversions object: other Partnerize objects and contextless calls never map", () => {
    for (const scope of [
      { supplier: "PARTNERIZE" },
      { supplier: "PARTNERIZE", sourceObject: "campaigns" },
      { supplier: "PARTNERIZE", sourceObject: "payment_information" },
      { supplier: "PARTNERIZE", sourceObject: "payments" },
      {},
    ]) {
      const r = resolveOrderStatusFromNetworkRaw("approved", scope);
      assert.equal(r.mapped, false, JSON.stringify(scope));
      assert.equal(r.mboOrderStatus, null, JSON.stringify(scope));
      assert.equal(r.mappingExceptionRequired, true, JSON.stringify(scope));
    }
    const ok = resolveOrderStatusFromNetworkRaw("approved", { supplier: "PARTNERIZE", sourceObject: "conversions" });
    assert.equal(ok.mboOrderStatus, "CONFIRMED");
  });

  it("another supplier's raw \"approved\" is unchanged: no verified entry, so it stays under review", () => {
    for (const supplier of ["IMPACT", "AWIN", "OPTIMISE", "TRACKIER", "BOOSTINY"]) {
      const r = resolveOrderStatusFromNetworkRaw("approved", { supplier, sourceObject: "conversions" });
      assert.equal(r.mapped, false, supplier);
      assert.equal(r.mboOrderStatus, null, supplier);
    }
    const impact = mapEntityToConversionIngest({
      id: "entity-i",
      entityType: "conversion",
      networkSource: "impact",
      externalId: "impact-conversion-A1",
      rawData: { id: "A1", conversionId: "A1", commission: "5.00", conversion_date: "2026-09-12", status: "approved", conversion_status: "approved" },
      normalizedData: {},
    });
    assert.equal(impact.ok, true);
    assert.equal(impact.input._order.mboOrderStatus, null);
    assert.equal(impact.input._order.statusSourceObject, null);
    assert.equal(impact.input.status, "UNKNOWN");
  });
});

/* ========================================================================= finance */

describe("finance readiness of a promoted Partnerize order (no payment/receipt/reconciliation invented)", () => {
  it("approved passes the VALIDATION_APPROVED gate and stops only at the next real prerequisite", async () => {
    const { order } = await promoteWithStatus({ conversion_status: "approved" });
    assert.equal(order.validationStatus, "VALIDATION_APPROVED");
    const { result, reported } = await recogniseAgainst(order);
    assert.notEqual(result.reason, "validation_not_approved");
    // The fixture carries no client attribution, and none is fabricated here.
    assert.equal(result.reason, "missing_client");
    assert.ok(!reported.some((e) => /requires VALIDATION_APPROVED/.test(e.reason ?? "")));
  });

  for (const raw of ["pending", "rejected", "declined"]) {
    it(`${raw} is refused by finance recognition at the validation gate`, async () => {
      const { order } = await promoteWithStatus({ conversion_status: raw });
      const { result, reported } = await recogniseAgainst(order);
      assert.equal(result.created, false);
      assert.equal(result.reason, "validation_not_approved");
      assert.ok(reported.some((e) => /requires VALIDATION_APPROVED/.test(e.reason ?? "")));
    });
  }
});

/* ============================================= finance recognition after promotion */

/**
 * One stateful in-memory store behind the REAL OrderIngestionService and the REAL
 * FinancialTransactionService, so replays hit the same rows and the recognition key
 * (earn:{conversionId}) is unique exactly as in Postgres. Attribution is an in-memory double of
 * AttributionService.ingestConversion's contract: one Conversion per (supplier, account,
 * supplierConversionId), linked to the order, with the assignment set only once the world says it
 * resolves. The client-commercial runtime is the same fixed 70/30 double the finance runtime tests
 * use. No supplier payment, bank receipt or reconciliation fact exists anywhere in this store.
 */
function financeWorld({ assignmentResolvable = true } = {}) {
  const world = {
    assignmentResolvable,
    orders: new Map(),
    conversions: new Map(),
    earns: new Map(),
    financeCalls: [],
    financeExceptions: [],
    runtimeCalls: 0,
  };
  const assignment = { id: "assignment-7", clientId: "client-9", canonicalCampaignId: null, client: { id: "client-9", currency: "EUR", country: "DE" } };
  const withConversions = (order) => ({
    ...order,
    items: [],
    conversions: [...world.conversions.values()]
      .filter((c) => c.orderId === order.id)
      .map((c) => ({ ...c, clientAssignment: c.clientAssignmentId ? assignment : null })),
  });
  const orderKey = (k) => `${k.supplier}|${k.sourceAccountLabel}|${k.supplierOrderId}`;
  const db = {
    order: {
      findUnique: async ({ where }) => {
        let order = null;
        if (where.id) order = world.orders.get(where.id) ?? null;
        else if (where.supplier_sourceAccountLabel_supplierOrderId) {
          const key = orderKey(where.supplier_sourceAccountLabel_supplierOrderId);
          order = [...world.orders.values()].find((o) => orderKey(o) === key) ?? null;
        }
        return order ? withConversions(order) : null;
      },
      create: async ({ data }) => {
        const id = `order-${world.orders.size + 1}`;
        world.orders.set(id, { ...data, id });
        return withConversions(world.orders.get(id));
      },
      update: async ({ where, data }) => {
        const next = { ...world.orders.get(where.id), ...data };
        world.orders.set(where.id, next);
        return withConversions(next);
      },
    },
    conversion: {
      findUnique: async ({ where }) => {
        const c = world.conversions.get(where.id);
        if (!c) return null;
        return {
          ...c,
          order: c.orderId ? withConversions(world.orders.get(c.orderId)) : null,
          clientAssignment: c.clientAssignmentId ? assignment : null,
        };
      },
    },
    client: { findUnique: async () => assignment.client },
    financialTransaction: {
      findUnique: async ({ where }) => world.earns.get(where.recognitionKey) ?? null,
      findMany: async ({ where }) => [...world.earns.values()].filter((r) => r.conversionId === where.conversionId),
      create: async ({ data }) => {
        if (world.earns.has(data.recognitionKey)) {
          throw Object.assign(new Error("Unique constraint failed on recognitionKey"), { code: "P2002" });
        }
        const row = { id: `ft-${world.earns.size + 1}`, createdAt: new Date(), ...data };
        world.earns.set(data.recognitionKey, row);
        return row;
      },
    },
  };

  const orders = new OrderIngestionService({
    prisma: db,
    exceptions: { report: async () => ({}) },
    audit: { record: async () => {} },
    validation: { transition: mock.fn(async () => { throw new Error("no validation transition expected"); }) },
  });

  const attribution = {
    ingestConversion: async (input) => {
      const key = `${input.supplier}|${input.sourceAccountLabel ?? "default"}|${input.supplierConversionId}`;
      const existing = [...world.conversions.values()].find((c) => c.key === key);
      const row = {
        ...(existing ?? { id: `conv-${world.conversions.size + 1}`, key }),
        orderId: input.orderId ?? existing?.orderId ?? null,
        supplier: input.supplier,
        supplierConversionId: input.supplierConversionId,
        supplierCommission: input.supplierCommission,
        approvedCommission: input.approvedCommission ?? null,
        currency: input.currency,
        status: input.status,
        conversionDate: input.conversionDate,
        metadata: input.metadata,
        clientAssignmentId: world.assignmentResolvable ? assignment.id : existing?.clientAssignmentId ?? null,
        attributionStatus: world.assignmentResolvable ? "ATTRIBUTED" : "ORPHAN",
      };
      world.conversions.set(row.id, row);
      return row;
    },
  };

  const realFinance = new FinancialTransactionService({
    prisma: db,
    audit: { record: async () => null },
    exceptions: { report: async (row) => { world.financeExceptions.push(row); return row; } },
    // Non-India clients report in USD (resolveReportingCurrency); a fixed EUR→USD rate stands in
    // for the FX table so the reporting leg is deterministic.
    fx: {
      convert: async ({ amount, fromCurrency, toCurrency, effectiveDate }) => ({
        ok: true,
        fxRate: "1.1",
        fxSource: "test_fixed_rate",
        fxDate: effectiveDate,
        fromCurrency,
        toCurrency,
        reportingAmount: Number((Number(amount) * 1.1).toFixed(4)),
      }),
    },
    clientCommercialRuntime: {
      evaluate: async ({ networkActualCommission }) => {
        world.runtimeCalls += 1;
        const gross = Number(networkActualCommission);
        return {
          status: "CALCULATED",
          reason: "non_negative_margin",
          matchedClientCommissionRuleId: "rule-1",
          matchedRuleSnapshot: { id: "rule-1", assignmentId: "assignment-7", commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION" },
          ruleKind: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
          ruleSelectionStatus: "MATCHED",
          clientPayable: Number((gross * 0.7).toFixed(4)),
          mboMargin: Number((gross * 0.3).toFixed(4)),
          payoutBasis: "NETWORK_ACTUAL_COMMISSION",
          provisional: false,
          payable: false,
          tierSelection: null,
          lineage: { status: "COMPLETE", agreementRef: "IO-1" },
          marginProtection: { status: "ALLOWED" },
          facts: { country: "DE" },
        };
      },
    },
  });
  const finance = {
    syncApprovedBasisForOrder: async (args, client) => {
      world.financeCalls.push(args);
      return realFinance.syncApprovedBasisForOrder(args, client);
    },
  };

  const service = new ConversionPromotionService({
    orders,
    attribution,
    finance,
    exceptions: { report: async () => ({}) },
    prisma: {},
  });
  const earnRows = () => [...world.earns.values()].filter((r) => r.transactionType === "COMMISSION_EARNED");
  return { world, db, service, earnRows };
}

async function stagedPartnerizeEntity(rowOverrides = {}) {
  const { entities } = await fetchAndStage({ conversions: [{ conversion: { ...CERTIFICATION_ROW, ...rowOverrides } }] });
  assert.equal(entities.length, 1);
  return entities[0];
}

describe("finance recognition after promotion (existing syncApprovedBasisForOrder path)", () => {
  it("approved: Order VALIDATION_APPROVED, Conversion linked, sync invoked exactly once, one earn row", async () => {
    const w = financeWorld();
    const entity = await stagedPartnerizeEntity({ conversion_status: "approved" });
    const outcome = await w.service.promoteEntity(entity);
    assert.equal(outcome.result, "promoted", JSON.stringify(outcome));

    const [order] = [...w.world.orders.values()];
    assert.equal(order.validationStatus, "VALIDATION_APPROVED");
    const [conversion] = [...w.world.conversions.values()];
    assert.equal(conversion.orderId, order.id, "conversion linked to the order before finance ran");

    assert.deepEqual(w.world.financeCalls, [{ orderId: order.id, reason: "conversion_promotion" }]);
    assert.equal(outcome.finance.status, "synced", JSON.stringify(outcome.finance));
    assert.equal(outcome.finance.results[0].action, "recognize");
    assert.equal(outcome.finance.results[0].created, true);

    const earns = w.earnRows();
    assert.equal(earns.length, 1, "exactly one COMMISSION_EARNED row");
    assert.equal(earns[0].recognitionKey, `earn:${conversion.id}`);
    assert.equal(earns[0].orderId, order.id);
    assert.equal(earns[0].clientId, "client-9");
    assert.equal(Number(earns[0].supplierReceivable), 12.34);
    assert.equal(Number(earns[0].clientPayable), 8.638);
    assert.equal(Number(earns[0].mboMargin), 3.702);
    // Commission recognition only: no supplier payment or client payability is invented.
    assert.equal(order.supplierPaymentStatus, "PAYMENT_PENDING");
    assert.equal(w.world.orders.get(order.id).clientPaymentStatus, "CLIENT_PAYMENT_NOT_READY");
  });

  it("replaying the same entity creates no second Order, Conversion or earn row", async () => {
    const w = financeWorld();
    const entity = await stagedPartnerizeEntity({ conversion_status: "approved" });
    const first = await w.service.promoteEntity(entity);
    const second = await w.service.promoteEntity(entity);
    const third = await w.service.promoteEntity(entity);
    assert.equal(first.orderId, second.orderId);
    assert.equal(first.orderId, third.orderId);
    assert.equal(w.world.orders.size, 1, "duplicate Order");
    assert.equal(w.world.conversions.size, 1, "duplicate Conversion");
    assert.equal(w.earnRows().length, 1, "duplicate COMMISSION_EARNED");
    assert.equal(w.world.earns.size, 1, "a correction row appeared for an unchanged basis");
    assert.equal(w.world.financeCalls.length, 3, "each replay re-checks finance");
    assert.equal(second.finance.status, "synced");
    assert.equal(second.finance.results[0].action, "noop");
    assert.equal(third.finance.results[0].action, "noop");
  });

  it("approved but no client: order and conversion stay promoted, finance unresolved missing_client, no earn", async () => {
    const w = financeWorld({ assignmentResolvable: false });
    const entity = await stagedPartnerizeEntity({ conversion_status: "approved" });
    const outcome = await w.service.promoteEntity(entity);
    assert.equal(outcome.result, "promoted");
    assert.equal(w.world.orders.size, 1);
    assert.equal(w.world.conversions.size, 1);
    assert.equal([...w.world.orders.values()][0].validationStatus, "VALIDATION_APPROVED");
    assert.equal(outcome.finance.status, "unresolved");
    assert.equal(outcome.finance.results[0].reason, "missing_client");
    assert.equal(w.earnRows().length, 0);
    assert.ok(w.world.financeExceptions.some((e) => e.type === "COMMISSION_MISSING"), "finance raised its own ExceptionCase");
  });

  it("late re-promotion after attribution resolves creates the previously missing earn, once", async () => {
    const w = financeWorld({ assignmentResolvable: false });
    const entity = await stagedPartnerizeEntity({ conversion_status: "approved" });
    const blocked = await w.service.promoteEntity(entity);
    assert.equal(blocked.finance.status, "unresolved");
    assert.equal(w.earnRows().length, 0);

    w.world.assignmentResolvable = true; // the assignment/click evidence now resolves
    const late = await w.service.promoteEntity(entity);
    assert.equal(late.finance.status, "synced");
    assert.equal(late.finance.results[0].action, "recognize");
    assert.equal(w.earnRows().length, 1);

    const again = await w.service.promoteEntity(entity);
    assert.equal(again.finance.results[0].action, "noop");
    assert.equal(w.earnRows().length, 1);
    assert.equal(w.world.orders.size, 1);
    assert.equal(w.world.conversions.size, 1);
  });

  for (const raw of ["pending", "rejected", "declined"]) {
    it(`${raw}: finance sync is not called and no earn row exists`, async () => {
      const w = financeWorld();
      const outcome = await w.service.promoteEntity(await stagedPartnerizeEntity({ conversion_status: raw }));
      assert.equal(outcome.result, "promoted");
      assert.equal(w.world.financeCalls.length, 0);
      assert.equal(outcome.finance.status, "not_applicable");
      assert.equal(w.earnRows().length, 0);
    });
  }

  it("an unexpected finance error is logged and returned on the outcome; the promotion stands", async () => {
    const h = promotionHarness();
    h.service.finance = {
      syncApprovedBasisForOrder: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    };
    const outcome = await h.service.promoteEntity(stagedEntity({ conversion_status: "approved" }));
    assert.equal(outcome.result, "promoted");
    assert.equal(outcome.finance.status, "error");
    assert.match(outcome.finance.error, /connection terminated/);
    assert.equal(h.createdOrders.length, 1);
  });

  it("runPage counts finance errors separately from promotion failures", async () => {
    const h = promotionHarness();
    h.service.finance = { syncApprovedBasisForOrder: async () => { throw new Error("boom"); } };
    h.service.prisma = { entity: { findMany: async () => [stagedEntity({ conversion_status: "approved" })] } };
    const page = await h.service.runPage({ networkSource: "partnerize", batchSize: 10 });
    assert.equal(page.promoted, 1);
    assert.equal(page.failed, 0);
    assert.equal(page.financeErrors, 1);
  });
});

describe("the finance trigger is generic on order.validationStatus, not a Partnerize branch", () => {
  function genericHarness(existingValidation) {
    const financeCalls = [];
    const service = new ConversionPromotionService({
      orders: {
        upsertOrder: async () => ({ id: "order-x", validationStatus: existingValidation, items: [], conversions: [] }),
      },
      attribution: { ingestConversion: async () => ({ id: "conv-x", attributionStatus: "ATTRIBUTED" }) },
      finance: { syncApprovedBasisForOrder: async (args) => { financeCalls.push(args); return { orderId: args.orderId, results: [] }; } },
      exceptions: { report: async () => ({}) },
      prisma: {},
    });
    return { service, financeCalls };
  }
  const impactEntity = (status) => ({
    id: "entity-i",
    entityType: "conversion",
    networkSource: "impact",
    externalId: "impact-conversion-A1",
    rawData: { id: "A1", conversionId: "A1", commission: "5.00", conversion_date: "2026-09-12", status },
    normalizedData: {},
  });

  it("another supplier whose order is already VALIDATION_APPROVED (e.g. approved by ops) is synced on re-promotion", async () => {
    const { service, financeCalls } = genericHarness("VALIDATION_APPROVED");
    const outcome = await service.promoteEntity(impactEntity("approved"));
    assert.equal(outcome.result, "promoted");
    assert.deepEqual(financeCalls, [{ orderId: "order-x", reason: "conversion_promotion" }]);
  });

  it("an unverified-status supplier's new order is never approved by promotion, so finance is not called", async () => {
    const w = financeWorld();
    // Real OrderIngestionService: Impact raw "approved" has no verified entry → NEEDS_REVIEW.
    const outcome = await w.service.promoteEntity(impactEntity("approved"));
    assert.equal(outcome.result, "promoted");
    assert.equal([...w.world.orders.values()][0].validationStatus, "VALIDATION_NEEDS_REVIEW");
    assert.equal(w.world.financeCalls.length, 0);
    assert.equal(w.earnRows().length, 0);
  });

  for (const validation of ["VALIDATION_PENDING", "VALIDATION_REJECTED", "VALIDATION_NEEDS_REVIEW"]) {
    it(`${validation}: finance is not called for any supplier`, async () => {
      const { service, financeCalls } = genericHarness(validation);
      const outcome = await service.promoteEntity(impactEntity("approved"));
      assert.equal(outcome.finance.status, "not_applicable");
      assert.equal(financeCalls.length, 0);
    });
  }
});
