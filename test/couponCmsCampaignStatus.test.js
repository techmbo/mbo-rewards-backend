import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildNormalizedFromCouponFields,
  extractCouponFieldsFromNormalized,
  isCampaignStatusAllottable,
  normalizeCampaignStatus,
} from "../src/modules/coupons/couponMerge.js";
import { collectSuppliersForAssignment } from "../src/modules/coupons/couponCommercial.service.js";

describe("Coupon CMS campaign status", () => {
  it("defaults to Active and normalizes Paused", () => {
    assert.equal(normalizeCampaignStatus(undefined), "Active");
    assert.equal(normalizeCampaignStatus("paused"), "Paused");
    assert.equal(normalizeCampaignStatus("Active"), "Active");
    assert.equal(isCampaignStatusAllottable("Active"), true);
    assert.equal(isCampaignStatusAllottable("Paused"), false);
  });

  it("persists campaignStatus through normalize round-trip", () => {
    const normalized = buildNormalizedFromCouponFields({
      brandName: "Ajio",
      campaignName: "Ajio India",
      campaignStatus: "Paused",
      codeType: "code",
      couponCode: "SAVE10",
    });
    assert.equal(normalized.campaign_status, "Paused");
    const fields = extractCouponFieldsFromNormalized(normalized);
    assert.equal(fields.campaignStatus, "Paused");
  });
});

describe("Assignment supplier labels", () => {
  it("deduplicates supplier names from assignment sources", () => {
    const names = collectSuppliersForAssignment({
      campaignSource: {
        supplierCampaign: { supplier: "BOOSTINY", supplierRef: { displayName: "Boostiny" } },
      },
      canonicalCampaign: {
        sources: [
          { supplierCampaign: { supplier: "BOOSTINY", supplierRef: { displayName: "Boostiny" } } },
          { supplierCampaign: { supplier: "OPTIMISE", supplierRef: { displayName: "Optimise" } } },
          { supplierCampaign: { supplier: "RAKUTEN" } },
        ],
      },
    });
    assert.deepEqual(names, ["Boostiny", "Optimise", "Rakuten"]);
  });
});
