/**
 * Network Operation Portal — acceptance tests for audit blockers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveIsAssignable,
  deriveMboReady,
  deriveMappingStatus,
  deriveCampaignChannelType,
  deriveCouponRemainingQuantity,
  buildMappingCertificationChecklist,
  mapCampaignStatus,
  mapRelationshipStatus,
} from "../src/modules/ops/v15FieldContract.js";
import {
  toCouponPoolDto,
  toNetworkPerformanceDto,
  toNetworkOrderDto,
  networkGrainKey,
} from "../src/modules/networkPortal/networkPortal.dto.js";
import { NetworkPortalService } from "../src/modules/networkPortal/networkPortal.service.js";

describe("Network Portal — mapping certification & MBO Ready", () => {
  it("keeps isAssignable weaker than MBO Ready", () => {
    const base = {
      campaignStatus: "ACTIVE",
      relationshipStatus: "JOINED",
      supportsLink: true,
      commissionAvailable: true,
      hasCampaignSource: true,
    };
    assert.equal(deriveIsAssignable({ ...base, mappingStatus: "NEEDS_REVIEW" }), true);
    assert.equal(
      deriveMboReady({
        ...base,
        mappingStatus: "NEEDS_REVIEW",
        brandMappingComplete: true,
        hasUsableAsset: true,
        sourceHidden: false,
      }),
      false,
    );
    assert.equal(
      deriveMboReady({
        ...base,
        mappingStatus: "MAPPED",
        brandMappingComplete: true,
        hasUsableAsset: true,
        sourceHidden: false,
      }),
      true,
    );
  });

  it("does not invent MAPPED without certification", () => {
    assert.equal(
      deriveMappingStatus({ syncConflict: false, merchantId: "m1", rawPayloadId: "r1" }),
      "NEEDS_REVIEW",
    );
    assert.equal(
      deriveMappingStatus({
        syncConflict: false,
        merchantId: "m1",
        rawPayloadId: "r1",
        certificationStatus: "CERTIFIED",
        checklistValid: true,
      }),
      "MAPPED",
    );
    assert.equal(
      deriveMappingStatus({
        syncConflict: false,
        merchantId: "m1",
        rawPayloadId: "r1",
        certificationStatus: "CERTIFIED",
        checklistValid: false,
      }),
      "NEEDS_REVIEW",
    );
  });

  it("rejects certification checklist when brand/raw/commission missing", () => {
    const { valid } = buildMappingCertificationChecklist({
      supplierCampaign: {
        supplierCampaignId: "X",
        campaignName: "Test",
        merchantId: null,
        rawPayloadId: "raw",
        campaignStatus: "ACTIVE",
      },
      hasCampaignSource: true,
      commissionAvailable: true,
    });
    assert.equal(valid, false);
  });

  it("separates channel type from commercial campaign type", () => {
    assert.equal(
      deriveCampaignChannelType({ supportsLink: true, supportsCoupon: false }),
      "AFFILIATE_LINK_ONLY",
    );
    assert.equal(
      deriveCampaignChannelType({ supportsLink: false, supportsCoupon: true }),
      "COUPON_CODE_ONLY",
    );
    assert.notEqual(mapCampaignStatus("ACTIVE"), mapRelationshipStatus("JOINED"));
  });

  it("blocks MBO Ready when source hidden or brand incomplete", () => {
    assert.equal(
      deriveMboReady({
        campaignStatus: "ACTIVE",
        relationshipStatus: "JOINED",
        mappingStatus: "MAPPED",
        brandMappingComplete: false,
        commissionAvailable: true,
        hasUsableAsset: true,
        sourceHidden: false,
      }),
      false,
    );
    assert.equal(
      deriveMboReady({
        campaignStatus: "ACTIVE",
        relationshipStatus: "JOINED",
        mappingStatus: "MAPPED",
        brandMappingComplete: true,
        commissionAvailable: true,
        hasUsableAsset: true,
        sourceHidden: true,
      }),
      false,
    );
  });
});

describe("Network Portal — CouponCodeMaster quantities", () => {
  it("derives remaining = total - assigned and never negative", () => {
    assert.equal(deriveCouponRemainingQuantity(20, 10), 10);
    assert.equal(deriveCouponRemainingQuantity(5, 9), 0);
    assert.equal(deriveCouponRemainingQuantity(null, 3), null);
  });

  it("documents assigned as MBO allocation in DTO note", () => {
    const dto = toCouponPoolDto({
      id: "c1",
      supplier: "TRACKIER",
      sourceAccountLabel: "main",
      couponCode: "STYLE30",
      source: "NETWORK_API",
      scope: "SHARED_LIMITED",
      totalQuantity: 20,
      assignedQuantity: 10,
      status: "ACTIVE",
      newCodeAlert: false,
      detectedAt: new Date(),
      lastUpdatedAt: new Date(),
    });
    assert.equal(dto.remainingQuantity, 10);
    assert.match(dto.note, /MBO allocation/);
  });
});

describe("Network Portal — performance dual clicks", () => {
  it("keeps networkClicks and mboLinkClicks independent", () => {
    const dto = toNetworkPerformanceDto({
      id: "p1",
      supplier: "OPTIMISE",
      sourceAccountLabel: "mena",
      reportDate: new Date("2026-08-15"),
      networkClicks: 1280,
      mboLinkClicks: 1206,
      networkTrackingLink: null,
      mboTrackingLink: null,
    });
    assert.equal(dto.networkClicks, 1280);
    assert.equal(dto.mboLinkClicks, 1206);
    assert.notEqual(dto.networkClicks, dto.mboLinkClicks);
    assert.equal(dto.networkTrackingLink, null);
    assert.match(dto.note, /independent/);
  });

  it("exposes 14E identity, tracking and lifecycle fields without inventing links", () => {
    const dto = toNetworkPerformanceDto({
      id: "p2",
      reportExternalId: "RPT-OPT-0815",
      supplier: "OPTIMISE",
      sourceAccountLabel: "Optimise MENA",
      reportDate: new Date("2026-08-15"),
      campaignSourceId: "src_opt_ubuy_001",
      supplierCampaignId: "OPT-98221",
      brandName: "Ubuy",
      campaignName: "Ubuy UAE Rewards Offer",
      campaignChannelType: "COUPON_AND_LINK",
      couponId: "coupon_SAVE20",
      couponCode: "SAVE20",
      couponSource: "NETWORK_API",
      couponScope: "SHARED_LIMITED",
      networkTrackingLink: "https://network.example/ubuy?campaign=98221",
      mboTrackingLink: null,
      trackingLinkId: "trk_ubuy_001",
      networkClickId: "netclk_8821",
      mboClickId: "mboclk_8821",
      subId1: "mbo_ref_01",
      subId2: "assignment_ref_08",
      subId3: "click_ref_8821",
      impressions: 25100,
      uniqueClicks: 1110,
      conversionRate: 6.56,
      pendingOrders: 17,
      cancelledOrders: 5,
      paidOrders: 12,
      pendingOrderValue: 3100,
      confirmedOrderValue: 13880,
      cancelledOrderValue: 1220,
      grossCommission: 910,
      pendingCommission: 155,
      rejectedCommission: 30,
      payableCommission: 690,
      paidCommission: 144,
      mboReceivable: 690,
      mboActuallyReceived: 144,
      customerType: "NEW",
      devicePlatform: "Web / App",
      aov: 216.67,
      epc: 0.54,
      attributionStatus: "MATCHED",
      reconciliationStatus: "PARTIAL",
      rawPayloadId: "raw_perf_opt_0815",
      sourceEndpoint: "/performance/report",
      reportGranularity: "daily",
      metadata: { rawStatus: "approved", mboStandardStatus: "Confirmed" },
    });
    assert.equal(dto.campaignType, "Coupon + Network Link");
    assert.equal(dto.couponSourceScope, "Network API · Shared Limited Code");
    assert.equal(dto.subIds, "mbo_ref_01 · assignment_ref_08 · click_ref_8821");
    assert.equal(dto.attribution, "Matched");
    assert.equal(dto.reconciliation, "Partial");
    assert.equal(dto.rawStatus, "approved");
    assert.equal(dto.mboStandardStatus, "Confirmed");
    assert.equal(dto.reportGranularity, "Daily Aggregate");
    assert.equal(dto.mboTrackingLink, null);
  });

  it("hydrates brand and network tracking link from supplier campaign only when fact fields are empty", () => {
    const dto = toNetworkPerformanceDto({
      id: "p3",
      supplier: "TRACKIER",
      sourceAccountLabel: "Trackier Main",
      reportDate: new Date("2026-08-15"),
      couponCode: "STYLE30",
      networkTrackingLink: null,
      mboTrackingLink: null,
      supplierCampaign: {
        campaignName: "Myntra Fashion Sale",
        merchantNameRaw: "Myntra",
        trackingUrl: null,
        couponCodeMasters: [
          { id: "c1", couponCode: "STYLE30", source: "NETWORK_API", scope: "SHARED_LIMITED", supplierCouponExtId: "coupon_STYLE30" },
        ],
        campaignSources: [{ id: "src_trk_myntra_001", supportsCoupon: true, supportsLink: false, isPrimary: true }],
      },
    });
    assert.equal(dto.brandName, "Myntra");
    assert.equal(dto.campaignName, "Myntra Fashion Sale");
    assert.equal(dto.networkTrackingLink, null);
    assert.equal(dto.mboTrackingLink, null);
    assert.equal(dto.campaignType, "Coupon Code Only");
    assert.equal(dto.couponId, "coupon_STYLE30");
  });

  it("builds stable grain keys", () => {
    assert.equal(
      networkGrainKey(["OPTIMISE", "mena", "2026-08-15", "c1"]),
      networkGrainKey(["OPTIMISE", "mena", "2026-08-15", "c1"]),
    );
  });
});

describe("Network Portal — orders payable vs received", () => {
  it("keeps payable and received separate and does not invent tracking URLs", () => {
    const dto = toNetworkOrderDto({
      id: "o1",
      supplier: "IMPACT",
      sourceAccountLabel: "default",
      supplierOrderId: "IMP-1",
      orderValue: 180,
      currency: "USD",
      validationStatus: "VALIDATION_APPROVED",
      supplierPaymentStatus: "PAYMENT_PAYABLE",
      metadata: {},
      financialSummary: { supplierReceivable: 7.2 },
      campaignSource: { supplierCampaign: { trackingUrl: null } },
    });
    assert.equal(dto.payableCommission, 7.2);
    assert.equal(dto.receivedCommission, null);
    assert.equal(dto.networkTrackingLink, null);
    assert.equal(dto.mboTrackingLink, null);
  });

  it("shows received when PAYMENT_RECEIVED", () => {
    const dto = toNetworkOrderDto({
      id: "o2",
      supplier: "OPTIMISE",
      sourceAccountLabel: "default",
      supplierOrderId: "OPT-1",
      validationStatus: "VALIDATION_APPROVED",
      supplierPaymentStatus: "PAYMENT_RECEIVED",
      metadata: {},
      financialSummary: { supplierReceivable: 12 },
    });
    assert.equal(dto.payableCommission, 12);
    assert.equal(dto.receivedCommission, 12);
  });
});

describe("Network Portal — credentials platforms", () => {
  it("includes Partnerize and Impact", () => {
    const platforms = NetworkPortalService.supportedCredentialPlatforms();
    assert.ok(platforms.includes("partnerize"));
    assert.ok(platforms.includes("impact"));
    assert.ok(platforms.includes("trackier"));
  });
});
