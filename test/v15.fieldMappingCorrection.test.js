/**
 * v15 field-mapping correction — contract regression tests.
 * Evidence-based: exact workbook keys; null when no source; no invented discount/customerType.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  toAdminCampaignListDto,
  toAdminPerformanceDto,
  CLIENT_FORBIDDEN_FINANCE_KEYS,
} from "../src/modules/ops/adminContract.dto.js";
import {
  parseExactDiscountPercent,
  mapRelationshipStatus,
  mapCampaignStatus,
  mapCampaignType,
  deriveIsAssignable,
  mapClientChannelType,
  formatCommissionSummary,
} from "../src/modules/ops/v15FieldContract.js";
import { toPartnerCampaignDto } from "../src/modules/client/dto/partnerCampaign.dto.js";

describe("v15 helpers — no fake data", () => {
  it("parseExactDiscountPercent accepts only exact percent", () => {
    assert.equal(parseExactDiscountPercent(10), 10);
    assert.equal(parseExactDiscountPercent("12.5%"), 12.5);
    assert.equal(parseExactDiscountPercent("10% off"), 10);
    assert.equal(parseExactDiscountPercent("10% OFF"), 10);
    assert.equal(parseExactDiscountPercent("₹50 off"), null);
    assert.equal(parseExactDiscountPercent("up to 10%"), null);
    assert.equal(parseExactDiscountPercent(null), null);
  });

  it("maps relationship and campaign statuses without merging", () => {
    assert.equal(mapRelationshipStatus("NOT_JOINED"), "NOT_JOINED");
    assert.equal(mapRelationshipStatus("JOINED"), "JOINED");
    assert.equal(mapRelationshipStatus(null), null);
    assert.equal(mapCampaignStatus("RETIRED"), "EXPIRED");
    assert.equal(mapCampaignStatus("ACTIVE"), "ACTIVE");
    assert.equal(mapCampaignStatus(null), null);
    assert.notEqual(mapCampaignStatus("ACTIVE"), mapRelationshipStatus("JOINED"));
  });

  it("maps campaignType commercial model separately from category", () => {
    assert.equal(mapCampaignType("CPS", null), "CPS");
    assert.equal(mapCampaignType(null, "CPA"), "CPA");
    assert.equal(mapCampaignType("Marketplace", null), "UNKNOWN");
    assert.equal(mapCampaignType(null, null), null);
    assert.equal(mapCampaignType("COUPON", null), "UNKNOWN");
  });

  it("formats commission summary as display text", () => {
    assert.equal(formatCommissionSummary({ grossCommission: 5, rules: 1, commissionUnit: "PERCENT" }), "5% · 1 rule");
    assert.equal(
      formatCommissionSummary({ grossCommission: 16, rules: 5, commissionUnit: "PERCENT" }),
      "Up to 16% · 5 rules",
    );
    assert.equal(formatCommissionSummary({ rules: 3, ratePercents: [4, 16, 8] }), "Up to 16% · 3 rules");
    assert.equal(formatCommissionSummary({ rules: 2 }), "Multiple rules");
    assert.equal(formatCommissionSummary({}), null);
  });

  it("derives isAssignable from ACTIVE + JOINED + channel + commission", () => {
    assert.equal(
      deriveIsAssignable({
        campaignStatus: "ACTIVE",
        relationshipStatus: "JOINED",
        supportsLink: true,
        commissionAvailable: true,
      }),
      true,
    );
    assert.equal(
      deriveIsAssignable({
        campaignStatus: "ACTIVE",
        relationshipStatus: "NOT_JOINED",
        supportsLink: true,
        commissionAvailable: true,
      }),
      false,
    );
    assert.equal(
      deriveIsAssignable({
        campaignStatus: "PAUSED",
        relationshipStatus: "JOINED",
        supportsLink: true,
        commissionAvailable: true,
      }),
      false,
    );
  });
});

describe("v15 03G admin campaign contract", () => {
  const REQUIRED_KEYS = [
    "networkSource",
    "brandName",
    "brandWebsiteLink",
    "brandLogoLink",
    "campaignName",
    "primaryCategory",
    "secondaryCategory",
    "country",
    "currency",
    "campaignType",
    "campaignDescription",
    "campaignTermsAndCondition",
    "campaignCommission",
    "campaignTrackingLink",
    "campaignStartDate",
    "campaignEndDate",
    "campaignStatus",
    "campaignPromotionDescription",
    "discountPercent",
    "relationshipStatus",
    "isAssignable",
    "supplierCampaignId",
    "campaignSourceId",
    "linkSupport",
    "couponSupport",
    "deeplinkSupport",
    "commissionRuleCount",
    "lastSyncedAt",
    "mappingStatus",
    "rawPayloadLink",
  ];

  it("emits all 03G keys from correct sources", () => {
    const dto = toAdminCampaignListDto({
      id: "cc1",
      displayName: "Ubuy UAE Rewards",
      status: "PUBLISHED",
      category: "Marketplace",
      countries: ["AE"],
      defaultCurrency: "USD",
      merchantId: "m1",
      merchant: {
        displayName: "Ubuy",
        website: "https://www.ubuy.com",
        logoUrl: "https://cdn.example/ubuy.png",
        category: "Marketplace",
      },
      primarySource: {
        id: "src1",
        relationshipStatus: "JOINED",
        supportsLink: true,
        supportsCoupon: false,
        grossCommission: "8.5",
        supplierCampaign: {
          supplier: "IMPACT",
          supplierCampaignId: "imp-99",
          campaignName: "Ubuy Impact Offer",
          campaignDescription: "Shop and earn",
          campaignLogoUrl: "https://cdn.example/fallback.png",
          merchantNameRaw: "Ubuy Raw",
          merchantId: "m1",
          categoryName: "Shopping",
          campaignType: "CPS",
          pricingModel: "CPS",
          trackingUrl: "https://supplier.example/track",
          destinationUrl: "https://www.ubuy.com",
          deepLinkingEnabled: true,
          campaignStatus: "ACTIVE",
          countryCodes: ["AE", "SA"],
          currencyCode: "USD",
          campaignStartDate: new Date("2026-01-01T00:00:00Z"),
          lastSyncedAt: new Date("2026-08-01T12:00:00Z"),
          rawPayloadId: "raw-1",
          syncConflict: false,
        },
      },
      commissionRuleCount: 2,
      supplierCommissionRules: [{ id: "r1", basis: "PERCENT_OF_SALE", ratePercent: 8.5 }],
    });

    for (const key of REQUIRED_KEYS) {
      assert.ok(key in dto, `missing key ${key}`);
    }

    assert.equal(dto.networkSource, "IMPACT");
    assert.equal(dto.brandName, "Ubuy");
    assert.equal(dto.brandWebsiteLink, "https://www.ubuy.com");
    assert.equal(dto.brandLogoLink, "https://cdn.example/ubuy.png");
    assert.equal(dto.campaignName, "Ubuy UAE Rewards");
    assert.equal(dto.primaryCategory, "Marketplace");
    assert.equal(dto.secondaryCategory, null);
    assert.deepEqual(dto.country, ["AE", "SA"]);
    assert.equal(dto.currency, "USD");
    assert.equal(dto.campaignType, "CPS");
    assert.equal(dto.campaignDescription, "Shop and earn");
    assert.equal(dto.campaignTermsAndCondition, null);
    assert.ok(String(dto.campaignCommission).includes("8.5"));
    assert.equal(dto.campaignTrackingLink, "https://supplier.example/track");
    assert.equal(dto.campaignStartDate, "2026-01-01");
    assert.equal(dto.campaignEndDate, null);
    assert.equal(dto.campaignStatus, "ACTIVE");
    assert.equal(dto.campaignPromotionDescription, null);
    assert.equal(dto.discountPercent, null);
    assert.equal(dto.relationshipStatus, "JOINED");
    assert.equal(dto.isAssignable, true);
    assert.equal(dto.supplierCampaignId, "imp-99");
    assert.equal(dto.campaignSourceId, "src1");
    assert.equal(dto.linkSupport, true);
    assert.equal(dto.couponSupport, false);
    assert.equal(dto.deeplinkSupport, true);
    assert.equal(dto.commissionRuleCount, 2);
    assert.ok(dto.lastSyncedAt);
    assert.equal(dto.mappingStatus, "NEEDS_REVIEW");
    assert.equal(dto.rawPayloadLink, "/ops/raw-payloads/raw-1");

    // Must not merge status vocabularies
    assert.notEqual(dto.campaignStatus, dto.relationshipStatus);
  });

  it("falls back brand name to raw merchant when canonical missing", () => {
    const dto = toAdminCampaignListDto({
      id: "cc2",
      displayName: null,
      merchant: null,
      primarySource: {
        id: "src2",
        relationshipStatus: "NOT_JOINED",
        supplierCampaign: {
          supplier: "OPTIMISE",
          supplierCampaignId: "o-1",
          campaignName: "Raw Campaign",
          merchantNameRaw: "Raw Brand",
          campaignStatus: "ACTIVE",
          trackingUrl: "https://x.example",
        },
      },
      commissionRuleCount: 0,
    });
    assert.equal(dto.brandName, "Raw Brand");
    assert.equal(dto.campaignName, "Raw Campaign");
    assert.equal(dto.relationshipStatus, "NOT_JOINED");
    assert.equal(dto.isAssignable, false);
  });

  it("does not invent UNKNOWN when CampaignSource is missing", () => {
    const dto = toAdminCampaignListDto({
      id: "cc-orphan",
      displayName: "Catalog only",
      status: "PUBLISHED",
      merchant: { displayName: "Brand X", website: "https://x.example" },
      sources: [],
      primarySource: null,
    });
    assert.equal(dto.networkSource, null);
    assert.equal(dto.campaignStatus, null);
    assert.equal(dto.campaignType, null);
    assert.equal(dto.relationshipStatus, null);
    assert.equal(dto.linkSupport, null);
    assert.equal(dto.couponSupport, null);
    assert.equal(dto.deeplinkSupport, null);
    assert.equal(dto.campaignCommission, null);
    assert.equal(dto.isAssignable, false);
    assert.equal(dto.mappingStatus, "NEEDS_REVIEW");
    assert.ok(dto.operationalWarnings.includes("NO_ACTIVE_SOURCE"));
    // Must not use catalog PUBLISHED as supplier campaignStatus
    assert.notEqual(dto.campaignStatus, "PUBLISHED");
  });

  it("resolves relationship from supplier isJoined when source status UNKNOWN", () => {
    const dto = toAdminCampaignListDto({
      id: "cc3",
      displayName: "Joined via supplier",
      primarySource: {
        id: "src3",
        relationshipStatus: "UNKNOWN",
        supportsLink: true,
        grossCommission: 5,
        supplierCampaign: {
          supplier: "BOOSTINY",
          supplierCampaignId: "b-1",
          campaignStatus: "ACTIVE",
          isJoined: true,
          participationStatus: "UNKNOWN",
          trackingUrl: "https://track.example/t",
          commissionUnit: "PERCENT",
          defaultCommissionValue: 5,
        },
      },
      commissionRuleCount: 1,
    });
    assert.equal(dto.relationshipStatus, "JOINED");
    assert.equal(dto.networkSource, "BOOSTINY");
    assert.equal(dto.isAssignable, true);
    assert.ok(String(dto.campaignCommission).includes("5%"));
  });

  it("does not leak supplier-specific field names into the contract", () => {
    const dto = toAdminCampaignListDto({
      id: "cc4",
      displayName: "X",
      primarySource: {
        id: "src4",
        relationshipStatus: "JOINED",
        supportsLink: true,
        supplierCampaign: {
          supplier: "TRACKIER",
          campaignStatus: "ACTIVE",
          campaignType: "CPS",
          trackingUrl: "https://t.example",
        },
      },
      commissionRuleCount: 1,
    });
    assert.equal("advertiserName" in dto, false);
    assert.equal("performance_model" in dto, false);
    assert.equal("payout_type" in dto, false);
    assert.equal("publisher_commission" in dto, false);
    assert.equal(dto.campaignType, "CPS");
    assert.equal(dto.networkSource, "TRACKIER");
  });
});

describe("v15 04C admin performance contract", () => {
  it("emits flat 04C keys and nulls unavailable metrics", () => {
    const dto = toAdminPerformanceDto(
      {
        reportDate: "2026-07-31",
        brandName: "Ubuy",
        clickCount: 100,
        conversionCount: 10,
        approvedConversionCount: 8,
        grossCommission: 50,
        country: "AE",
        currency: "USD",
        customerType: null,
        discountPercent: "not a percent",
      },
      { includeFinancial: true },
    );

    assert.equal(dto.brandName, "Ubuy");
    assert.equal(dto.linkClicks, 100);
    assert.equal(dto.grossOrders, 10);
    assert.equal(dto.netOrders, 8);
    assert.equal(dto.grossCommission, 50);
    assert.equal(dto.netCommission, null);
    assert.equal(dto.grossOrderValue, null);
    assert.equal(dto.customerType, null);
    assert.equal(dto.discountPercent, null);
    assert.equal(dto.date, "2026-07-31");
    assert.equal(dto.month, 7);
    assert.equal(dto.year, 2026);
    assert.equal(dto.financial.grossCommission, 50);
  });

  it("redacts financial commission without permission", () => {
    const dto = toAdminPerformanceDto(
      { clickCount: 1, grossCommission: 99 },
      { includeFinancial: false },
    );
    assert.equal(dto.grossCommission, null);
    assert.equal(dto.financial.state, "REDACTED");
  });
});

describe("v15 06C client campaign contract", () => {
  const REQUIRED = [
    "brandName",
    "brandWebsiteUrl",
    "brandLogoUrl",
    "primaryCategory",
    "secondaryCategory",
    "campaignName",
    "campaignDescription",
    "campaignType",
    "termsAndConditions",
    "couponCode",
    "link",
    "primaryCountry",
    "secondaryCountries",
    "discountPercent",
    "discountType",
    "discountDisplay",
    "campaignValidity",
    "commission",
    "currency",
    "campaignStatus",
  ];

  it("emits 06C keys, MBO link only, strips supplier finance", () => {
    const dto = toPartnerCampaignDto({
      assignmentId: "a1",
      published: true,
      assignmentStatus: "ACTIVE",
      createdAt: new Date(),
      campaign: {
        id: "cc1",
        merchantId: "m1",
        brand: "Ubuy",
        brandWebsiteUrl: "https://www.ubuy.com",
        brandLogoUrl: "https://cdn.example/ubuy.png",
        displayName: "Ubuy UAE",
        description: "Shop on Ubuy",
        category: "Marketplace",
        secondaryCategory: null,
        countries: ["AE", "SA"],
        defaultCurrency: "USD",
        status: "PUBLISHED",
        supplierCampaignStatus: "ACTIVE",
        deepLinkingEnabled: false,
        campaignTypeRaw: "CPS",
        pricingModelRaw: "CPS",
        termsAndConditions: null,
        offer: "10% off",
        validity: { startDate: "2026-08-01", endDate: "2026-08-31" },
      },
      coupon: { type: "CODE", code: "SAVE10", discountPercentage: "10" },
      sourceCapabilities: { supportsLink: true, supportsCoupon: true, supportsDeeplink: false },
      tracking: { mboTrackingUrl: "https://mborewards.com/t/abc", status: "ACTIVE" },
      commercial: { clientSharePercent: 70, commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION", currency: "USD" },
    });

    for (const key of REQUIRED) {
      assert.ok(key in dto, `missing ${key}`);
    }

    assert.equal(dto.brandName, "Ubuy");
    assert.equal(dto.brandWebsiteUrl, "https://www.ubuy.com");
    assert.equal(dto.campaignName, "Ubuy UAE");
    assert.equal(dto.campaignType, "COUPON_LINK");
    assert.equal(dto.channelType, "COUPON_LINK");
    assert.equal(dto.commercialModel, "CPS");
    assert.equal(dto.couponCode, "SAVE10");
    assert.equal(dto.link, "https://mborewards.com/t/abc");
    assert.equal(dto.primaryCountry, "AE");
    assert.deepEqual(dto.secondaryCountries, ["SA"]);
    assert.equal(dto.discountPercent, 10);
    assert.equal(dto.discountType, "PERCENT");
    assert.equal(dto.campaignStatus, "ACTIVE");
    assert.equal(dto.currency, "USD");

    for (const key of CLIENT_FORBIDDEN_FINANCE_KEYS) {
      assert.equal(dto[key], undefined, `forbidden key leaked: ${key}`);
    }
    assert.ok(!JSON.stringify(dto).includes("supplier.example"));
    assert.equal(dto.networkSource, undefined);
    assert.equal(dto.supplierCampaignId, undefined);
    assert.equal(dto.campaignTrackingLink, undefined);
  });

  it("never invents discount percent from text offers", () => {
    assert.equal(mapClientChannelType({ supportsLink: true, couponCode: null }), "LINK");
    const dto = toPartnerCampaignDto({
      assignmentId: "a2",
      assignmentStatus: "ACTIVE",
      campaign: {
        brand: "X",
        displayName: "X",
        countries: ["IN"],
        offer: "₹100 off",
        validity: {},
      },
      coupon: { code: null, discountPercentage: "₹100 off" },
      sourceCapabilities: { supportsLink: true },
      tracking: { mboTrackingUrl: "https://mborewards.com/t/x" },
      commercial: null,
    });
    assert.equal(dto.discountPercent, null);
    assert.equal(dto.discountType, "FIXED_AMOUNT");
  });
});
