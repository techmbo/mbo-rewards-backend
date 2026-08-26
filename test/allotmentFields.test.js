import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAllotmentDisplayFields } from "../src/modules/coupons/allotmentFields.js";

describe("buildAllotmentDisplayFields", () => {
  it("extracts optimise coupon fields from entity raw data", () => {
    const fields = buildAllotmentDisplayFields({
      advertiserName: null,
      campaignName: "Activity & Experience",
      discount: null,
      eventDate: null,
      rawData: {
        companyName: "Klook",
        deepLinkURL: "https://www.klook.com/promo",
        deepLinkTrackingURL: "https://clk.example/?r=https%3A%2F%2Fwww.klook.com%2Fpromo",
        trackingURL: "https://clk.example/track",
        discount: "5%",
        description: "Apply code for 5% off",
        expiryDate: "2026-12-31T00:00:00.000Z",
      },
      normalizedData: {},
    });

    assert.equal(fields.brandName, "Klook");
    assert.equal(fields.websiteUrl, "https://www.klook.com/promo");
    assert.equal(fields.discountPercentage, "5%");
    assert.equal(fields.offerLink, "https://www.klook.com/promo");
    assert.equal(fields.trackingUrl, "https://clk.example/?r=https%3A%2F%2Fwww.klook.com%2Fpromo");
    assert.equal(fields.termsAndConditions, "Apply code for 5% off");
    assert.ok(fields.expiryDate);
  });

  it("enriches trackier coupons from parent campaign entity", () => {
    const fields = buildAllotmentDisplayFields(
      {
        campaignName: "Ibacosmetics.com Ecommerce CPS - India",
        advertiserName: null,
        discount: "35% off on hair care",
        rawData: {
          campaign_id: 12939,
          description: "35% off on hair care",
        },
        normalizedData: { discount: "35% off on hair care" },
      },
      {
        campaignEntity: {
          entityName: "Ibacosmetics.com Ecommerce CPS - India",
          rawData: {
            logo: "https://cdn.example/logo.png",
            preview_url: "https://ibacosmetics.com/",
            tracking_link: "https://track.example/click?campaign_id=12939",
            payouts: [{ payout: 14, currency: "INR", payout_model: "percentage" }],
          },
        },
      },
    );

    assert.equal(fields.brandName, "Ibacosmetics.com");
    assert.equal(fields.websiteUrl, "https://ibacosmetics.com/");
    assert.equal(fields.brandLogo, "https://cdn.example/logo.png");
    assert.equal(fields.trackingUrl, "https://track.example/click?campaign_id=12939");
    assert.equal(fields.commission, "14% INR");
    assert.equal(fields.discountPercentage, null);
    assert.equal(fields.termsAndConditions, "35% off on hair care");
    assert.equal(fields.offerText, "35% off on hair care");
  });

  it("reads boostiny nested campaign logo and ad_set discount", () => {
    const fields = buildAllotmentDisplayFields({
      campaignName: "Bloomingdales",
      rawData: {
        ad_set: "10%",
        coupon: "G23",
        campaign: {
          logo: "https://cdn.example/bloom.png",
          name: "Bloomingdales",
        },
      },
      normalizedData: { campaign_name: "Bloomingdales", code: "G23" },
    });

    assert.equal(fields.brandName, "Bloomingdales");
    assert.equal(fields.brandLogo, "https://cdn.example/bloom.png");
    assert.equal(fields.discountPercentage, "10%");
  });
});
