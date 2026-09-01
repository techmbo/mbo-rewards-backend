/**
 * Campaign management contract — honest nulls, filters keys, commission display, no supplier leakage.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  toAdminCampaignListDto,
  toAdminCampaignDetailDto,
} from "../src/modules/ops/adminContract.dto.js";
import {
  deriveIsAssignable,
  formatCommissionSummary,
  mapCampaignType,
  resolveRelationshipStatus,
} from "../src/modules/ops/v15FieldContract.js";

const CANONICAL_KEYS = [
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

describe("campaign management — exact canonical keys", () => {
  it("emits all required API keys", () => {
    const dto = toAdminCampaignListDto({
      id: "1",
      displayName: "C",
      primarySource: {
        id: "s1",
        relationshipStatus: "JOINED",
        supportsLink: true,
        grossCommission: 10,
        supplierCampaign: {
          supplier: "OPTIMISE",
          supplierCampaignId: "ext-1",
          campaignStatus: "ACTIVE",
          campaignType: "CPS",
          trackingUrl: "https://t.example",
        },
      },
      commissionRuleCount: 2,
    });
    for (const key of CANONICAL_KEYS) {
      assert.ok(key in dto, `missing ${key}`);
    }
  });
});

describe("campaign management — field sources", () => {
  it("maps network/brand/name/type/status/relationship/channels/commission", () => {
    const dto = toAdminCampaignListDto({
      id: "1",
      displayName: "Canonical Name",
      category: "Travel",
      countries: ["IN"],
      defaultCurrency: "INR",
      merchant: {
        displayName: "Klook",
        website: "https://www.klook.com",
        logoUrl: "https://cdn.example/k.png",
      },
      primarySource: {
        id: "src",
        relationshipStatus: "JOINED",
        supportsLink: true,
        supportsCoupon: false,
        channelSupport: ["DEEPLINK"],
        grossCommission: 12,
        supplierCampaign: {
          supplier: "TRACKIER",
          supplierCampaignId: "tr-9",
          campaignName: "Supplier Name",
          campaignType: "CPS",
          pricingModel: "CPS",
          campaignStatus: "ACTIVE",
          countryCodes: ["IN", "SG"],
          currencyCode: "INR",
          trackingUrl: "https://go.example/t",
          deepLinkingEnabled: true,
          commissionUnit: "PERCENT",
          defaultCommissionValue: 12,
          lastSyncedAt: new Date("2026-08-01"),
          rawPayloadId: "raw-1",
          merchantId: "m1",
        },
      },
      commissionRuleCount: 5,
      supplierCommissionRules: [
        { id: "r1", ratePercent: 4, basis: "PERCENT_OF_SALE" },
        { id: "r2", ratePercent: 16, basis: "PERCENT_OF_SALE" },
      ],
    });

    assert.equal(dto.networkSource, "TRACKIER");
    assert.equal(dto.brandName, "Klook");
    assert.equal(dto.campaignName, "Canonical Name");
    assert.equal(dto.campaignType, "CPS");
    assert.equal(dto.campaignStatus, "ACTIVE");
    assert.equal(dto.relationshipStatus, "JOINED");
    assert.equal(dto.isAssignable, true);
    assert.equal(dto.linkSupport, true);
    assert.equal(dto.couponSupport, false);
    assert.equal(dto.deeplinkSupport, true);
    assert.equal(dto.commissionRuleCount, 5);
    assert.deepEqual(dto.country, ["IN", "SG"]);
    assert.equal(dto.currency, "INR");
    assert.ok(String(dto.campaignCommission).includes("Up to 16%"));
    assert.equal(dto.mappingStatus, "NEEDS_REVIEW");
    assert.equal(dto.campaignSourceId, "src");
    assert.equal(dto.supplierCampaignId, "tr-9");
  });

  it("keeps currency null when only country is known", () => {
    const dto = toAdminCampaignListDto({
      id: "1",
      displayName: "C",
      countries: ["AE"],
      defaultCurrency: null,
      primarySource: {
        id: "s",
        relationshipStatus: "JOINED",
        supplierCampaign: {
          supplier: "OPTIMISE",
          campaignStatus: "ACTIVE",
          countryCodes: ["AE"],
          currencyCode: null,
        },
      },
    });
    assert.deepEqual(dto.country, ["AE"]);
    assert.equal(dto.currency, null);
  });
});

describe("campaign management — assignability", () => {
  it("requires active + joined + channel + commission + source", () => {
    assert.equal(
      deriveIsAssignable({
        campaignStatus: "ACTIVE",
        relationshipStatus: "JOINED",
        supportsLink: true,
        commissionAvailable: true,
        hasCampaignSource: true,
      }),
      true,
    );
    assert.equal(
      deriveIsAssignable({
        campaignStatus: "ACTIVE",
        relationshipStatus: "JOINED",
        supportsLink: true,
        commissionAvailable: true,
        hasCampaignSource: false,
      }),
      false,
    );
    assert.equal(
      deriveIsAssignable({
        campaignStatus: "ACTIVE",
        relationshipStatus: "JOINED",
        supportsLink: true,
        commissionAvailable: true,
        hasCampaignSource: true,
        mappingStatus: "ERROR",
      }),
      false,
    );
  });

  it("resolveRelationshipStatus prefers supplier isJoined over UNKNOWN source", () => {
    assert.equal(
      resolveRelationshipStatus(
        { relationshipStatus: "UNKNOWN" },
        { isJoined: true, participationStatus: "UNKNOWN" },
      ),
      "JOINED",
    );
    assert.equal(resolveRelationshipStatus(null, null), null);
  });
});

describe("campaign management — detail DTO", () => {
  it("includes supplierCommissionRules and sources without inventing network", () => {
    const dto = toAdminCampaignDetailDto({
      id: "1",
      displayName: "Detail",
      sources: [
        {
          id: "s1",
          isPrimary: true,
          isActive: true,
          relationshipStatus: "JOINED",
          supportsLink: true,
          grossCommission: 8,
          supplierCampaign: {
            supplier: "BOOSTINY",
            supplierCampaignId: "bo-1",
            campaignStatus: "ACTIVE",
            campaignType: "CPA",
            trackingUrl: "https://b.example",
          },
        },
      ],
      primarySource: null,
      supplierCommissionRules: [
        { id: "r1", basis: "PERCENT_OF_SALE", ratePercent: 8, currency: "USD" },
      ],
      commissionRuleCount: 1,
      assignments: [],
    });
    assert.equal(dto.networkSource, "BOOSTINY");
    assert.equal(dto.sources[0].networkSource, "BOOSTINY");
    assert.equal(dto.supplierCommissionRules.length, 1);
    assert.equal(dto.supplierCommissionRules[0].ratePercent, 8);
  });
});

describe("campaign management — type vocabulary", () => {
  it("never treats channel words as campaignType commercial model", () => {
    assert.equal(mapCampaignType("LINK", null), "UNKNOWN");
    assert.equal(mapCampaignType("DEALS", "COUPON"), "UNKNOWN");
    assert.equal(mapCampaignType("CPS", "LINK"), "CPS");
  });

  it("formatCommissionSummary stays null when no data", () => {
    assert.equal(formatCommissionSummary({}), null);
  });
});
