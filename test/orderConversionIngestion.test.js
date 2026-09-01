/**
 * Pointer 14 — Order / Conversion ingestion dedupe tests.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  assertPromotableConversionIdentity,
  buildConversionDedupeKey,
  buildOrderItemDedupeKey,
  extractNetworkConversionId,
  isWeakConversionExternalId,
  mapRawOrderItems,
  resolveConversionEntityExternalId,
  resolveOrderItemLineKey,
} from "../src/modules/order/orderConversionIngestion.contract.js";
import { OrderIngestionService } from "../src/modules/order/orderIngestion.service.js";
import {
  mapEntityToConversionIngest,
  ConversionPromotionService,
} from "../src/modules/reporting/services/conversionPromotion.service.js";

describe("Pointer 14 — Order / Conversion dedupe contract", () => {
  it("builds default conversion dedupe key from network + account + conversion id", () => {
    assert.equal(
      buildConversionDedupeKey({
        supplier: "OPTIMISE",
        sourceAccountLabel: "sea-main",
        supplierConversionId: "CV-55191",
      }),
      "OPTIMISE|sea-main|CV-55191",
    );
  });

  it("builds item dedupe key with line_item_id", () => {
    assert.equal(
      buildOrderItemDedupeKey({
        supplier: "IMPACT",
        sourceAccountLabel: "default",
        supplierConversionId: "ACT-19002",
        lineItemId: "SKU-9",
      }),
      "IMPACT|default|ACT-19002|SKU-9",
    );
  });

  it("resolveOrderItemLineKey prefers network line_item_id over sku hash", () => {
    assert.equal(
      resolveOrderItemLineKey({ line_item_id: "L-42", sku: "SHOE-1" }),
      "line:L-42",
    );
    assert.equal(resolveOrderItemLineKey({ sku: "SHOE-1" }, 0), "idx:0");
  });

  it("extractNetworkConversionId reads network-native ids", () => {
    assert.equal(extractNetworkConversionId({ conversion_id: "111111l3919676" }), "111111l3919676");
    assert.equal(extractNetworkConversionId({ order_id: "ORD-81771" }), "ORD-81771");
    assert.equal(extractNetworkConversionId({ id: 99, conversion_date: "2026-08-01" }), "99");
  });

  it("rejects campaign+date aggregate rows without conversion id", () => {
    const entity = {
      entityType: "conversion",
      externalId: "boostiny-conversion-campaign-624-2026-05-13",
      rawData: { campaign_id: 624, date: "2026-05-13", clicks: 3 },
    };
    const result = assertPromotableConversionIdentity(entity);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "missing_network_conversion_id");
  });

  it("flags weak external ids (brand/campaign + date)", () => {
    assert.equal(
      isWeakConversionExternalId("optimise_sea-conversion-Nike Online-2026-08-15", {
        campaignName: "Nike Online",
        date: "2026-08-15",
      }),
      true,
    );
    assert.equal(
      isWeakConversionExternalId("optimise_sea-conversion-55191", { conversion_id: "55191" }),
      false,
    );
  });

  it("resolveConversionEntityExternalId requires network conversion id", () => {
    assert.equal(
      resolveConversionEntityExternalId({ conversion_id: "X1" }, "trackier-conversion"),
      "trackier-conversion-X1",
    );
    assert.equal(resolveConversionEntityExternalId({ campaignName: "X", date: "2026-01-01" }), null);
  });

  it("mapRawOrderItems assigns stable line keys from line_item_id", () => {
    const items = mapRawOrderItems({
      items: [{ line_item_id: "LI-1", amount: 10 }, { sku: "A" }],
    });
    assert.equal(items[0].lineKey, "line:LI-1");
    assert.equal(items[1].lineKey, "idx:1");
  });

  it("repeated promotion uses same supplierConversionId (idempotent key)", async () => {
    const entity = {
      id: "e1",
      entityType: "conversion",
      networkSource: "trackier",
      externalId: "trackier-conversion-99",
      rawData: {
        id: 99,
        payout: 12.5,
        status: "approved",
        conversion_date: "2026-08-01",
      },
      normalizedData: {},
    };
    const mapped = mapEntityToConversionIngest(entity);
    assert.equal(mapped.ok, true);
    assert.equal(mapped.input.metadata.dedupeKey, "TRACKIER|default|99");

    const attribution = {
      ingestConversion: mock.fn(async (input) => ({
        id: "cv1",
        attributionStatus: "ATTRIBUTED",
        ...input,
      })),
    };
    const orders = {
      upsertOrder: mock.fn(async () => ({ id: "ord-1" })),
    };
    const service = new ConversionPromotionService({ attribution, orders });
    await service.promoteEntity(entity);
    await service.promoteEntity(entity);
    assert.equal(attribution.ingestConversion.mock.calls.length, 2);
    assert.equal(
      attribution.ingestConversion.mock.calls[0].arguments[0].supplierConversionId,
      attribution.ingestConversion.mock.calls[1].arguments[0].supplierConversionId,
      "99",
    );
  });

  it("OrderIngestionService upsert uses conversion dedupe metadata", async () => {
    const created = [];
    const db = {
      order: {
        findUnique: mock.fn(async () => null),
        create: mock.fn(async ({ data }) => {
          created.push(data);
          return { ...data, id: "o1", items: [], conversions: [], validationStatus: data.validationStatus };
        }),
        update: mock.fn(async ({ data, where }) => ({
          id: where.id,
          ...data,
          items: [],
          conversions: [],
          validationStatus: data.validationStatus ?? "VALIDATION_PENDING",
        })),
      },
    };
    const exceptions = { report: mock.fn(async () => ({})) };
    const audit = { record: mock.fn(async () => {}) };
    const validation = { transition: mock.fn(async () => ({})) };
    const service = new OrderIngestionService({ prisma: db, exceptions, audit, validation });
    await service.upsertOrder({
      supplier: "PARTNERIZE",
      sourceAccountLabel: "pub1",
      supplierOrderId: "ORDER872137",
      supplierConversionId: "111111l3919676",
      orderValue: 600,
      currency: "AED",
      orderDate: new Date("2026-08-14"),
      legacyConversionStatus: "APPROVED",
    });
    assert.equal(created[0].metadata.dedupeKey, "PARTNERIZE|pub1|111111l3919676");
  });
});
