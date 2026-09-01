/**
 * Optimise conversion ingestion + attribution — verified field mapping and fail-closed rules.
 * Does not invent conversions when the live Optimise API window is empty.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  extractSupplierConversionId,
  extractAttributionHints,
  isPromotableConversionEntity,
  mapEntityToConversionIngest,
  ConversionPromotionService,
} from "../src/modules/reporting/services/conversionPromotion.service.js";
import { extractOptimiseConversionFields } from "../src/modules/supplier/mappers/optimise.mapper.js";
import { AttributionService } from "../src/modules/reporting/services/attribution.service.js";
import { toConversionDto } from "../src/modules/reporting/dto/reporting.dto.js";

function optimiseEntity(rawOverrides = {}, entityOverrides = {}) {
  return {
    id: "ent-opt-1",
    entityType: "conversion",
    networkSource: "optimise_sea",
    externalId: "default:optimise_sea-conversion-9001",
    commission: null,
    revenue: null,
    eventDate: null,
    rawData: {
      conversionId: 9001,
      campaignId: 411,
      orderId: "ORD-9001",
      status: "approved",
      conversionDate: "2026-07-15T10:00:00.000Z",
      validatedCommission: 18.5,
      pendingCommission: 18.5,
      originalOrderValue: 250,
      currency: "USD",
      UID: "client-hello1",
      UID2: "assign-staycation",
      voucher: "SAVE10",
      ...rawOverrides,
    },
    normalizedData: {},
    ...entityOverrides,
  };
}

describe("Optimise conversion field extraction", () => {
  it("maps documented Optimise conversion fields without inventing values", () => {
    const fields = extractOptimiseConversionFields(optimiseEntity().rawData);
    assert.equal(fields.supplierConversionId, "9001");
    assert.equal(fields.supplierOrderId, "ORD-9001");
    assert.equal(fields.supplierCampaignId, "411");
    assert.equal(fields.supplierCommission, 18.5);
    assert.equal(fields.approvedCommission, 18.5);
    assert.equal(fields.orderValue, 250);
    assert.equal(fields.currency, "USD");
    assert.equal(fields.assignmentIdHint, "assign-staycation");
    assert.equal(fields.clientIdHint, "client-hello1");
    assert.equal(fields.couponCode, "SAVE10");
  });

  it("optional fields stay null when absent", () => {
    const fields = extractOptimiseConversionFields({
      conversionId: 1,
      pendingCommission: 3,
      conversionDate: "2026-01-01",
    });
    assert.equal(fields.supplierOrderId, null);
    assert.equal(fields.orderValue, null);
    assert.equal(fields.couponCode, null);
    assert.equal(fields.assignmentIdHint, null);
    assert.equal(fields.approvedCommission, null);
  });

  it("does not treat campaign headline commission as conversion commission", () => {
    const mapped = mapEntityToConversionIngest(
      optimiseEntity({
        validatedCommission: undefined,
        pendingCommission: undefined,
        commissionValue: undefined,
        cost: undefined,
        commission: undefined,
        defaultCommissionValue: 99,
      }),
    );
    assert.equal(mapped.ok, false);
    assert.equal(mapped.reason, "missing_supplier_commission");
  });
});

describe("Optimise Entity → Conversion ingest", () => {
  it("preserves supplier conversion id and source lineage metadata", () => {
    const mapped = mapEntityToConversionIngest(optimiseEntity());
    assert.equal(mapped.ok, true);
    assert.equal(mapped.input.supplier, "OPTIMISE");
    assert.equal(mapped.input.supplierConversionId, "9001");
    assert.equal(mapped.input.sourceAccountLabel, "default");
    assert.equal(mapped.input.metadata.entityId, "ent-opt-1");
    assert.equal(mapped.input.metadata.networkSource, "optimise_sea");
    assert.equal(mapped.input.metadata.externalId, "default:optimise_sea-conversion-9001");
    assert.equal(mapped.input.metadata.supplierCampaignId, "411");
    assert.equal(mapped.input.currency, "USD");
    assert.equal(mapped.input.status, "APPROVED");
    assert.equal(Number(mapped.input.supplierCommission), 18.5);
    assert.equal(Number(mapped.input.approvedCommission), 18.5);
    assert.equal(mapped.input.metadata.orderValue, 250);
    assert.equal(mapped.input._order.supplierOrderId, "ORD-9001");
  });

  it("derives month-safe date from conversionDate (no invent-now)", () => {
    const mapped = mapEntityToConversionIngest(optimiseEntity());
    assert.equal(mapped.input.conversionDate.toISOString().startsWith("2026-07-15"), true);
    assert.equal(
      mapEntityToConversionIngest(
        optimiseEntity({ conversionDate: undefined, date: undefined }),
      ).reason,
      "missing_conversion_date",
    );
  });

  it("maps pending / rejected statuses correctly", () => {
    assert.equal(mapEntityToConversionIngest(optimiseEntity({ status: "pending" })).input.status, "PENDING");
    assert.equal(mapEntityToConversionIngest(optimiseEntity({ status: "rejected" })).input.status, "REJECTED");
  });

  it("skips conversionsByPayment dual-promotion", () => {
    const entity = optimiseEntity({ report_type: "conversions_by_payment" });
    assert.equal(isPromotableConversionEntity(entity), false);
  });

  it("uses conversionValue.amount when originalOrderValue absent", () => {
    const mapped = mapEntityToConversionIngest(
      optimiseEntity({
        originalOrderValue: undefined,
        conversionValue: { amount: 99.5, currency: "USD" },
      }),
    );
    assert.equal(mapped.input.metadata.orderValue, 99.5);
  });
});

describe("Optimise attribution hierarchy", () => {
  it("attributes via UID2 → assignment → tracking link (not campaign name)", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv1",
        clickId: null,
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date("2026-07-15"),
        supplierCommission: "18.5000",
        status: "APPROVED",
        metadata: {
          attributionHints: { assignmentId: "assign-staycation", clientId: "client-hello1" },
        },
      })),
      update: mock.fn(async (_id, data) => ({ id: "cv1", ...data })),
    };
    const trackingRepo = {
      findById: mock.fn(async () => null),
      findPrimaryForAssignment: mock.fn(async () => ({
        id: "tl-1",
        assignmentId: "assign-staycation",
        campaignSourceId: "cs-1",
      })),
    };
    const assignmentRepo = {
      findById: mock.fn(async (id) =>
        id === "assign-staycation" ? { id: "assign-staycation", clientId: "client-hello1" } : null,
      ),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: { findById: async () => null, findBySubId: async () => null },
      trackingRepo,
      assignmentRepo,
      commissionRepo: { findEffectiveForAssignment: async () => null },
      exceptions: { report: async () => ({}) },
    });
    const result = await service.attributeConversion("cv1");
    assert.equal(result.attributionStatus, "ATTRIBUTED");
    assert.equal(result.clientAssignmentId, "assign-staycation");
    assert.equal(result.trackingLinkId, "tl-1");
  });

  it("does not guess attribution without click/subId/assignment evidence", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv-orphan",
        clickId: null,
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "5.0000",
        status: "PENDING",
        metadata: {
          attributionHints: {},
          supplierCampaignId: "411",
        },
      })),
      update: mock.fn(async (_id, data) => ({ id: "cv-orphan", ...data })),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: { findById: async () => null, findBySubId: async () => null },
      trackingRepo: { findById: async () => null, findPrimaryForAssignment: async () => null },
      assignmentRepo: { findById: async () => null },
      commissionRepo: { findEffectiveForAssignment: async () => null },
      exceptions: { report: async () => ({}) },
    });
    const result = await service.attributeConversion("cv-orphan");
    assert.equal(result.attributionStatus, "ORPHAN");
  });

  it("rejects wrong-client attribution leakage", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv-x",
        clickId: "click-1",
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "5.0000",
        status: "PENDING",
        metadata: { attributionHints: { clientId: "client-A", assignmentId: "assign-B" } },
      })),
      update: mock.fn(async (_id, data) => ({ id: "cv-x", ...data })),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: {
        findById: async () => ({
          id: "click-1",
          trackingLinkId: "tl-B",
          clientAssignmentId: "assign-B",
          campaignSourceId: "cs-B",
        }),
        findBySubId: async () => null,
      },
      trackingRepo: {
        findById: async () => ({ id: "tl-B", assignmentId: "assign-B", campaignSourceId: "cs-B" }),
        findPrimaryForAssignment: async () => null,
      },
      assignmentRepo: {
        findById: async () => ({ id: "assign-B", clientId: "client-B" }),
      },
      commissionRepo: { findEffectiveForAssignment: async () => null },
      exceptions: { report: async () => ({}) },
    });
    const result = await service.attributeConversion("cv-x");
    assert.equal(result.attributionStatus, "ORPHAN");
    assert.equal(result.metadata?.attributionRejection?.reason, "wrong_client");
  });
});

describe("Optimise conversion promotion idempotency + resilience", () => {
  it("re-promote uses same supplier conversion key and does not invent clicks", async () => {
    const entity = optimiseEntity();
    assert.equal(extractSupplierConversionId(entity), "9001");
    const hints = extractAttributionHints(entity.rawData);
    assert.equal(hints.assignmentId, "assign-staycation");
    assert.equal(hints.clientId, "client-hello1");
    assert.equal(hints.clickId, null);

    const orders = {
      upsertOrder: mock.fn(async (input) => ({
        id: "ord-1",
        supplierOrderId: input.supplierOrderId,
      })),
    };
    const attribution = {
      ingestConversion: mock.fn(async (input) => ({
        id: "cv-1",
        attributionStatus: "ATTRIBUTED",
        supplierConversionId: input.supplierConversionId,
      })),
    };
    const service = new ConversionPromotionService({ attribution, orders });
    const first = await service.promoteEntity(entity);
    const second = await service.promoteEntity(entity);
    assert.equal(first.result, "promoted");
    assert.equal(second.result, "promoted");
    assert.equal(attribution.ingestConversion.mock.calls.length, 2);
    assert.equal(
      attribution.ingestConversion.mock.calls[0].arguments[0].supplierConversionId,
      "9001",
    );
    assert.equal(orders.upsertOrder.mock.calls[0].arguments[0].supplierOrderId, "ORD-9001");
  });

  it("invalid payload skips without crashing batch runner", async () => {
    const bad = {
      id: "bad-1",
      entityType: "conversion",
      networkSource: "optimise_sea",
      externalId: "default:optimise_sea-conversion-missing",
      rawData: { status: "pending", report_type: "summary" },
      normalizedData: {},
    };
    const good = optimiseEntity({}, { id: "good-1" });
    const service = new ConversionPromotionService({
      attribution: {
        ingestConversion: mock.fn(async () => ({
          id: "cv",
          attributionStatus: "ORPHAN",
        })),
      },
      orders: { upsertOrder: mock.fn(async () => ({ id: "ord" })) },
      prisma: {
        entity: {
          findMany: mock.fn(async () => [bad, good]),
        },
      },
    });
    const summary = await service.run({ batchSize: 10 });
    assert.equal(summary.processed, 2);
    assert.equal(summary.skipped >= 1, true);
    assert.equal(summary.promoted >= 1, true);
    assert.equal(summary.failed, 0);
  });
});

describe("Conversion DTO — no raw payload leakage", () => {
  it("exposes operational fields and omits raw metadata blob", () => {
    const dto = toConversionDto({
      id: "cv1",
      supplier: "OPTIMISE",
      supplierConversionId: "9001",
      orderId: "ord-1",
      supplierCommission: "18.5000",
      status: "APPROVED",
      attributionStatus: "ORPHAN",
      conversionDate: new Date("2026-07-15"),
      metadata: {
        networkSource: "optimise_sea",
        orderValue: 250,
        couponCode: "SAVE10",
        rawDump: { secret: true },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    assert.equal(dto.networkSource, "optimise_sea");
    assert.equal(dto.orderValue, "250");
    assert.equal(dto.metadata, undefined);
    assert.equal(dto.issueReason, "unattributed");
  });
});
