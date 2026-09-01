import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectCampaignNamesForAssignment,
  collectSuppliersForAssignment,
} from "../src/modules/coupons/couponCommercial.service.js";

describe("collectCampaignNamesForAssignment", () => {
  it("collects catalog and supplier campaign names", () => {
    const names = collectCampaignNamesForAssignment({
      canonicalCampaign: {
        displayName: "Activity & Experience",
        sources: [{ supplierCampaign: { campaignName: "Activity & Experience" } }],
      },
      campaignSource: { supplierCampaign: { campaignName: "CPS" } },
      couponAssignments: [
        {
          supplierCoupon: {
            supplierCampaign: { campaignName: "Ajio.com Ecommerce CPS - India" },
            entity: { rawData: { campaign_name: "Ajio Boostiny" } },
          },
        },
      ],
    });

    assert.ok(names.includes("activity & experience"));
    assert.ok(names.includes("cps"));
    assert.ok(names.includes("ajio.com ecommerce cps - india"));
    assert.ok(names.includes("ajio boostiny"));
  });
});

describe("collectSuppliersForAssignment", () => {
  it("includes coupon-linked suppliers", () => {
    const names = collectSuppliersForAssignment({
      campaignSource: { supplierCampaign: { supplier: "boostiny", supplierRef: null } },
      couponAssignments: [
        { supplierCoupon: { supplierCampaign: { supplier: "trackier", supplierRef: { displayName: "vCommission" } } } },
      ],
    });
    assert.deepEqual(names, ["Boostiny", "vCommission"]);
  });
});
