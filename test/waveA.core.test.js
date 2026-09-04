import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  extractSupplierConversionId,
  isPromotableConversionEntity,
  mapEntityToConversionIngest,
  ConversionPromotionService,
} from "../src/modules/reporting/services/conversionPromotion.service.js";
import { AttributionService } from "../src/modules/reporting/services/attribution.service.js";
import {
  applyCommissionRuleToGross,
  grossCommissionForConversion,
} from "../src/modules/reporting/attributionMath.js";
import { CampaignEligibilityService, isSourceEligible } from "../src/modules/client/services/campaignEligibility.service.js";

describe("Wave A Entity→Conversion promotion", () => {
  it("extracts supplier conversion id and promotes", async () => {
    const entity = {
      id: "e1",
      entityType: "conversion",
      networkSource: "trackier",
      externalId: "trackier-conversion-99",
      commission: 12.5,
      rawData: {
        id: 99,
        click_id: "click-uuid",
        p2: "assignment-1",
        payout: 12.5,
        status: "approved",
        conversion_date: "2026-08-01",
      },
      normalizedData: { commission: 12.5 },
    };

    assert.equal(isPromotableConversionEntity(entity), true);
    assert.equal(extractSupplierConversionId(entity), "99");

    const mapped = mapEntityToConversionIngest(entity);
    assert.equal(mapped.ok, true);
    assert.equal(mapped.input.supplier, "TRACKIER");
    assert.equal(mapped.input.supplierConversionId, "99");
    assert.equal(mapped.input.clickId, "click-uuid");
    assert.equal(mapped.input._assignmentIdHint, "assignment-1");

    const attribution = {
      ingestConversion: mock.fn(async (input) => ({
        id: "cv1",
        attributionStatus: "ATTRIBUTED",
        ...input,
      })),
    };
    // Promotion persists the Order (finance grain) before the conversion is attributed.
    const orders = { upsertOrder: mock.fn(async (input) => ({ id: "ord-1", ...input })) };
    const service = new ConversionPromotionService({
      attribution,
      orders,
      exceptions: { report: mock.fn(async () => ({})) },
      prisma: {},
    });
    const result = await service.promoteEntity(entity);
    assert.equal(result.result, "promoted");
    assert.equal(result.orderId, "ord-1");
    assert.equal(orders.upsertOrder.mock.calls.length, 1);
    const upserted = orders.upsertOrder.mock.calls[0].arguments[0];
    assert.equal(upserted.supplier, "TRACKIER");
    assert.equal(upserted.supplierConversionId, "99");
    assert.equal(upserted.networkRawStatus, "approved");
    assert.equal(upserted.statusMappingExceptionRequired, true, "unverified raw status is never mapped silently");
    assert.equal(attribution.ingestConversion.mock.calls.length, 1);
    assert.equal(attribution.ingestConversion.mock.calls[0].arguments[0].orderId, "ord-1");
  });

  it("is idempotent via ingestConversion unique key", async () => {
    const entity = {
      id: "e1",
      entityType: "conversion",
      networkSource: "optimise_sea",
      externalId: "default:optimise_sea-conversion-55",
      rawData: {
        id: 55,
        cost: { amount: 8, currency: "USD" },
        status: "pending",
        conversionDate: "2026-08-01T00:00:00.000Z",
      },
      normalizedData: {},
    };
    const attribution = {
      ingestConversion: mock.fn(async () => ({ id: "same", attributionStatus: "ORPHAN" })),
    };
    const orders = { upsertOrder: mock.fn(async (input) => ({ id: "ord-same", ...input })) };
    const service = new ConversionPromotionService({
      attribution,
      orders,
      exceptions: { report: mock.fn(async () => ({})) },
      prisma: {},
    });
    await service.promoteEntity(entity);
    await service.promoteEntity(entity);
    assert.equal(orders.upsertOrder.mock.calls.length, 2, "order upsert is keyed on the same supplier identity");
    assert.equal(attribution.ingestConversion.mock.calls.length, 2);
    assert.equal(
      attribution.ingestConversion.mock.calls[0].arguments[0].supplierConversionId,
      attribution.ingestConversion.mock.calls[1].arguments[0].supplierConversionId,
    );
  });

  it("skips missing conversion id and negative commission", () => {
    assert.equal(
      mapEntityToConversionIngest({
        entityType: "conversion",
        networkSource: "trackier",
        externalId: "x",
        rawData: { payout: 5 },
      }).ok,
      false,
    );
    assert.equal(
      mapEntityToConversionIngest({
        entityType: "conversion",
        networkSource: "trackier",
        externalId: "trackier-conversion-1",
        rawData: { id: 1, payout: -5 },
      }).reason,
      "negative_supplier_commission",
    );
  });

  it("promotes Boostiny order-level performance via order_id + net_revenue", () => {
    const entity = {
      id: "e-boost",
      entityType: "conversion",
      networkSource: "boostiny",
      externalId: "boostiny-conversion-campaign-624-2026-05-13",
      rawData: {
        order_id: "13",
        campaign_id: 624,
        date: "2026-05-13",
        net_revenue: 0.04,
        net_sales_amount: 1,
        campaign_name: "Samsung KSA Coupons",
        code: "AFM106",
      },
      normalizedData: {},
    };
    assert.equal(isPromotableConversionEntity(entity), true);
    assert.equal(extractSupplierConversionId(entity), "13");
    const mapped = mapEntityToConversionIngest(entity);
    assert.equal(mapped.ok, true);
    assert.equal(mapped.input.supplier, "BOOSTINY");
    assert.equal(mapped.input.supplierConversionId, "13");
    assert.equal(mapped.input.supplierCommission, "0.0400");
    assert.equal(mapped.input.metadata.supplierOrderId, "13");
  });

  it("rejects Boostiny campaign/day aggregates without order_id", () => {
    assert.equal(
      isPromotableConversionEntity({
        entityType: "conversion",
        networkSource: "boostiny",
        externalId: "boostiny-conversion-campaign-624-2026-05-13",
        rawData: { campaign_id: 624, date: "2026-05-13", net_revenue: 1.2 },
      }),
      false,
    );
  });
});

describe("Wave A attribution matching", () => {
  it("attributes via MBO click id", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv1",
        clickId: "click-1",
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "10.0000",
        status: "APPROVED",
        metadata: {},
      })),
      update: mock.fn(async (_id, data) => data),
    };
    const clickRepo = {
      findById: mock.fn(async () => ({
        id: "click-1",
        trackingLinkId: "tl1",
        clientAssignmentId: "a1",
        campaignSourceId: "cs1",
        subId: "tok",
      })),
      findBySubId: mock.fn(async () => null),
    };
    const trackingRepo = {
      findById: mock.fn(async () => ({ id: "tl1", assignmentId: "a1", campaignSourceId: "cs1" })),
      findPrimaryForAssignment: mock.fn(async () => null),
    };
    const commissionRepo = {
      findEffectiveForAssignment: mock.fn(async () => ({
        id: "rule1",
        grossCommission: "100",
        clientCommission: "70",
      })),
    };

    const service = new AttributionService({
      conversionRepo,
      clickRepo,
      trackingRepo,
      commissionRepo,
      assignmentRepo: { findById: mock.fn(async () => null) },
    });
    const result = await service.attributeConversion("cv1");
    assert.equal(result.attributionStatus, "ATTRIBUTED");
    assert.equal(result.clientAssignmentId, "a1");
    assert.equal(result.clientCommission, "7.0000");
  });

  it("attributes via assignment id hint without guessing by client id", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv1",
        clickId: null,
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "10.0000",
        status: "PENDING",
        metadata: { attributionHints: { assignmentId: "a9", clientId: "c9" } },
      })),
      update: mock.fn(async (_id, data) => data),
    };
    const trackingRepo = {
      findById: mock.fn(async () => null),
      findPrimaryForAssignment: mock.fn(async () => ({
        id: "tl9",
        assignmentId: "a9",
        campaignSourceId: "cs9",
      })),
    };
    const assignmentRepo = {
      findById: mock.fn(async (id) => (id === "a9" ? { id: "a9" } : null)),
    };
    const commissionRepo = {
      findEffectiveForAssignment: mock.fn(async () => null),
    };

    const service = new AttributionService({
      conversionRepo,
      clickRepo: { findById: mock.fn(async () => null), findBySubId: mock.fn(async () => null) },
      trackingRepo,
      assignmentRepo,
      commissionRepo,
    });
    const result = await service.attributeConversion("cv1");
    assert.equal(result.attributionStatus, "ATTRIBUTED");
    assert.equal(result.clientAssignmentId, "a9");
    assert.equal(result.clientCommission, null);
    assert.equal(result.metadata.commissionUnresolvedReason, "missing_effective_commission_rule");
  });

  it("marks unmatched conversion as orphan", async () => {
    const conversionRepo = {
      findById: mock.fn(async () => ({
        id: "cv1",
        clickId: null,
        subId: null,
        trackingLinkId: null,
        conversionDate: new Date(),
        supplierCommission: "5.0000",
        status: "PENDING",
        metadata: {},
      })),
      update: mock.fn(async (_id, data) => data),
    };
    const service = new AttributionService({
      conversionRepo,
      clickRepo: { findById: mock.fn(async () => null), findBySubId: mock.fn(async () => null) },
      trackingRepo: {
        findById: mock.fn(async () => null),
        findPrimaryForAssignment: mock.fn(async () => null),
      },
      assignmentRepo: { findById: mock.fn(async () => null) },
      commissionRepo: { findEffectiveForAssignment: mock.fn(async () => null) },
    });
    const result = await service.attributeConversion("cv1");
    assert.equal(result.attributionStatus, "ORPHAN");
  });
});

describe("Wave A commission safety", () => {
  it("uses actual supplier/approved commission, not display gross", () => {
    assert.equal(
      String(
        grossCommissionForConversion({
          status: "APPROVED",
          supplierCommission: "10",
          approvedCommission: "8",
        }),
      ),
      "8",
    );
  });

  it("does not fallback when rule missing (apply returns ok:false)", () => {
    const split = applyCommissionRuleToGross("100", null);
    assert.equal(split.ok, false);
    assert.equal(split.clientCommission, null);
  });

  it("rejects client exceeding supplier and negative gross", () => {
    assert.equal(
      applyCommissionRuleToGross("-1", { grossCommission: "100", clientCommission: "70" }).reason,
      "negative_gross",
    );
    assert.equal(
      applyCommissionRuleToGross("10", { grossCommission: "10", clientCommission: "20" }).reason,
      "rule_client_exceeds_rule_gross",
    );
  });

  it("rejected conversion gross is zero", () => {
    assert.equal(
      grossCommissionForConversion({
        status: "REJECTED",
        supplierCommission: "50",
        approvedCommission: "50",
      }),
      0,
    );
  });
});

describe("Wave A eligibility", () => {
  const eligibility = new CampaignEligibilityService();
  const catalog = {
    id: "cc1",
    status: "PUBLISHED",
    visibility: "ASSIGNABLE",
    deletedAt: null,
    countries: ["IN"],
    defaultCurrency: "INR",
  };
  const client = { id: "c1", status: "ACTIVE", deletedAt: null, country: "IN", currency: "INR" };

  it("blocks archived and hidden catalogs", () => {
    assert.equal(
      eligibility.evaluate({
        mode: "assign",
        catalogCampaign: { ...catalog, status: "ARCHIVED" },
        client,
        sources: [],
      }).ok,
      false,
    );
    assert.equal(
      eligibility.evaluate({
        mode: "assign",
        catalogCampaign: { ...catalog, visibility: "HIDDEN" },
        client,
        sources: [],
      }).ok,
      false,
    );
  });

  it("blocks assign when no CampaignSource is linked", () => {
    const result = eligibility.evaluate({
      mode: "assign",
      catalogCampaign: catalog,
      client,
      sources: [],
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("no_campaign_source_linked"));
    assert.equal(result.eligibilityStatus, "UNAVAILABLE");
  });

  it("blocks ineligible JOINED-required sources", () => {
    const source = {
      id: "s1",
      isActive: true,
      status: "LINKED",
      relationshipStatus: "NOT_JOINED",
      supportsLink: true,
      supportsCoupon: false,
      grossCommission: "5",
      supplierCampaign: {
        trackingUrl: "https://x",
        campaignStatus: "ACTIVE",
        merchantId: "m1",
        defaultCommissionValue: "5",
      },
    };
    assert.equal(isSourceEligible(source).ok, false);
    const result = eligibility.evaluate({
      mode: "assign",
      catalogCampaign: catalog,
      client,
      sources: [source],
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("no_eligible_campaign_source"));
  });

  it("blocks publish without commission rule when unlinked", () => {
    const result = eligibility.evaluate({
      mode: "publish",
      catalogCampaign: catalog,
      client,
      sources: [],
      hasCouponAssignment: false,
      hasResolvableTrackingDestination: false,
      hasEffectiveCommissionRule: false,
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("missing_effective_commission_rule"));
    assert.ok(result.reasons.includes("no_campaign_source_linked"));
  });

  it("allows valid joined source for assign", () => {
    const source = {
      id: "s1",
      isActive: true,
      status: "PREFERRED",
      relationshipStatus: "JOINED",
      supportsLink: true,
      supportsCoupon: false,
      grossCommission: "2",
      supplierCampaign: {
        trackingUrl: "https://supplier.example/go",
        campaignStatus: "ACTIVE",
        merchantId: "m1",
        defaultCommissionValue: "2",
      },
    };
    const result = eligibility.evaluate({
      mode: "assign",
      catalogCampaign: catalog,
      client,
      sources: [source],
    });
    assert.equal(result.ok, true);
    assert.equal(result.eligibleSourceId, "s1");
    assert.equal(result.eligibilityStatus, "ELIGIBLE");
  });

  it("blocks missing merchant and unknown relationship", () => {
    const source = {
      id: "s1",
      isActive: true,
      status: "LINKED",
      relationshipStatus: "UNKNOWN",
      supportsLink: true,
      grossCommission: "2",
      supplierCampaign: {
        trackingUrl: "https://x",
        campaignStatus: "ACTIVE",
        merchantId: null,
        defaultCommissionValue: "2",
      },
    };
    const result = isSourceEligible(source);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("missing_merchant"));
    assert.ok(result.reasons.includes("relationship_unknown"));
  });

  it("treats country mismatch as a review gap on assign and publish", () => {
    const sources = [
      {
        id: "s1",
        isActive: true,
        status: "PREFERRED",
        relationshipStatus: "JOINED",
        supportsLink: true,
        grossCommission: "2",
        supplierCampaign: {
          trackingUrl: "https://x",
          campaignStatus: "ACTIVE",
          merchantId: "m1",
          defaultCommissionValue: "2",
        },
      },
    ];
    const assignResult = eligibility.evaluate({
      mode: "assign",
      catalogCampaign: catalog,
      client: { ...client, country: "US" },
      sources,
      preferredSource: sources[0],
    });
    assert.equal(assignResult.ok, true);
    assert.ok(assignResult.remainingGaps.includes("country_mismatch"));

    const publishResult = eligibility.evaluate({
      mode: "publish",
      catalogCampaign: catalog,
      client: { ...client, country: "US", status: "PROSPECT" },
      sources,
      preferredSource: sources[0],
      hasEffectiveCommissionRule: true,
      hasResolvableTrackingDestination: true,
    });
    assert.equal(publishResult.ok, true);
    assert.ok(publishResult.remainingGaps.includes("country_mismatch"));
  });
});
