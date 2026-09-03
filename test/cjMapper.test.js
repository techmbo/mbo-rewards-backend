import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapCjCampaign, mapCjCoupon } from "../src/modules/supplier/mappers/cj.mapper.js";

describe("CJ supplier mappers", () => {
  it("maps Advertiser Lookup identity without promoting headline commission into finance fields", () => {
    const mapped = mapCjCampaign({
      id: "entity-1",
      externalId: "cj-advertiser-3022407",
      networkSource: "cj",
      entityType: "campaign",
      entityName: "eUKhost Ltd",
      advertiserName: "eUKhost Ltd",
      rawData: {
        advertiser_id: "3022407",
        advertiser_name: "eUKhost Ltd",
        program_url: "https://www.eukhost.com",
        relationship_status: "joined",
        account_status: "Active",
        primary_category: { parent: "Internet Services", child: "Web Hosting/Servers" },
        actions: [{ id: "sale", commission: { default: "40.00 GBP" } }],
      },
      normalizedData: {},
      createdAt: new Date("2026-09-03T00:00:00Z"),
      updatedAt: new Date("2026-09-03T00:00:00Z"),
    });

    assert.equal(mapped.supplier, "CJ");
    assert.equal(mapped.supplierCampaignId, "3022407");
    assert.equal(mapped.campaignName, "eUKhost Ltd");
    assert.equal(mapped.merchantNameRaw, "eUKhost Ltd");
    assert.equal(mapped.participationStatus, "JOINED");
    assert.equal(mapped.defaultCommissionValue, null);
    assert.equal(mapped.commissionUnit, "UNKNOWN");
    assert.equal(mapped.normalizedPayload.cjAdvertiserLookup.actions[0].commission.default, "40.00 GBP");
  });

  it("maps CJ Link Search coupon to advertiser parent and keeps link commission display-only", () => {
    const mapped = mapCjCoupon({
      id: "entity-2",
      externalId: "cj-coupon-11470088",
      networkSource: "cj",
      entityType: "coupon",
      rawData: {
        advertiser_id: "3022407",
        advertiser_name: "eUKhost Ltd",
        link_id: "11470088",
        link_name: "Hosting Coupon",
        promotion_type: "coupon",
        coupon_code: "SAVE10",
        click_url: "https://www.anrdoezrs.net/click-example",
        promotion_start_date: "2026-09-01T00:00:00Z",
        promotion_end_date: "2026-09-30T23:59:59Z",
        sale_commission: "40.00 GBP",
      },
      normalizedData: {},
      createdAt: new Date("2026-09-03T00:00:00Z"),
      updatedAt: new Date("2026-09-03T00:00:00Z"),
    });

    assert.equal(mapped.supplierCouponId, "11470088");
    assert.equal(mapped.parentSupplierCampaignId, "3022407");
    assert.equal(mapped.couponType, "CODE");
    assert.equal(mapped.couponCode, "SAVE10");
    assert.equal(mapped.normalizedPayload.cjLinkSearch.saleCommissionDisplay, "40.00 GBP");
    assert.match(mapped.normalizedPayload.cjLinkSearch.note, /not SupplierCommissionRule/i);
  });
});
