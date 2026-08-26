/**
 * P1.14.1 — Partnerize/Impact performance aggregation + MBO click separation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregatePerformanceRowsByGrain,
  mapPerformanceRowToFactInput,
} from "../src/modules/networkPortal/networkPerformanceFact.ingestion.js";
import { createPartnerizeAdapter } from "../src/adapters/partnerize.adapter.js";
import { createImpactAdapter } from "../src/adapters/impact.adapter.js";
import { mapPartnerizeCoupon } from "../src/modules/supplier/mappers/partnerize.mapper.js";
import { SUPPLIER_ENTITY_TYPES } from "../src/modules/supplier/constants.js";

describe("P1.14.1 Partnerize → NetworkPerformanceFact", () => {
  it("maps Partnerize conversion-derived row without inventing MBO clicks", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-10",
        campaign_id: "camp-9",
        campaign_name: "Partnerize Camp",
        advertiser_name: "Brand P",
        orders: 2,
        validatedConversions: 1,
        pendingConversions: 1,
        commission: 4.5,
        originalOrderValue: 90,
        currency: "GBP",
        clicks: null,
        voucher_code: "SAVE10",
        click_id: "clickref-abc",
      },
      { networkSource: "partnerize", sourceAccountLabel: "pub1" },
    );
    assert.equal(input.supplier, "PARTNERIZE");
    assert.equal(input.supplierCampaignId, "camp-9");
    assert.equal(input.networkClicks, null);
    assert.equal(input.mboLinkClicks, null);
    assert.equal(input.grossOrders, 2);
    assert.equal(input.confirmedOrders, 1);
    assert.equal(input.pendingOrders, 1);
    assert.equal(input.grossCommission, 4.5);
    assert.equal(input.couponCode, "SAVE10");
    assert.equal(input.networkClickId, "clickref-abc");
    assert.equal(input.mboActuallyReceived, null);
  });

  it("aggregates same-day Partnerize conversions into one grain", () => {
    const rows = aggregatePerformanceRowsByGrain([
      {
        conversion_time: "2026-08-10T08:00:00Z",
        campaign_id: "c1",
        currency: "USD",
        publisher_commission: 1,
        order_value: 10,
        conversion_status: "approved",
      },
      {
        conversion_time: "2026-08-10T18:00:00Z",
        campaign_id: "c1",
        currency: "USD",
        publisher_commission: 2,
        order_value: 20,
        conversion_status: "pending",
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orders, 2);
    assert.equal(rows[0].commission, 3);
    assert.equal(rows[0].originalOrderValue, 30);
  });

  it("Partnerize adapter declares COUPONS + REPORTING and maps vouchers", () => {
    const adapter = createPartnerizeAdapter({
      applicationKey: "app",
      userApiKey: "user",
      publisherId: "pub",
    });
    const caps = adapter.getCapabilities().capabilities;
    assert.ok(caps.includes("COUPONS"));
    assert.ok(caps.includes("REPORTING"));
    assert.equal(typeof adapter.fetchCoupons, "function");
    assert.equal(typeof adapter.fetchPerformance, "function");
  });

  it("maps Partnerize voucher entity into coupon fields without inventing quantities", () => {
    const mapped = mapPartnerizeCoupon({
      entityType: SUPPLIER_ENTITY_TYPES.COUPON,
      networkSource: "partnerize",
      externalId: "partnerize-coupon-v1",
      rawData: {
        voucher_code: "PZ-CODE",
        campaign_id: "111",
        start_date_time: "2026-01-01T00:00:00Z",
        end_date_time: "2026-12-31T23:59:59Z",
        active: "y",
        description: "Partnerize voucher",
      },
    });
    assert.equal(mapped.couponCode, "PZ-CODE");
    assert.equal(mapped.parentSupplierCampaignId, "111");
    assert.equal(mapped.couponType, "CODE");
    assert.equal(mapped.couponStatus, "ACTIVE");
    assert.ok(mapped.couponStartDate instanceof Date);
    assert.ok(mapped.couponEndDate instanceof Date);
  });
});

describe("P1.14.1 Impact → NetworkPerformanceFact", () => {
  it("maps Impact Action-derived row; never copies clicks to mboLinkClicks", () => {
    const input = mapPerformanceRowToFactInput(
      {
        EventDate: "2026-08-11T12:00:00Z",
        CampaignId: "9001",
        CampaignName: "Impact Camp",
        AdvertiserName: "Brand I",
        Clicks: 40,
        Amount: 120,
        Payout: 8,
        Currency: "USD",
        PromoCode: null,
        ClickId: "imp-click-1",
        orders: 1,
        validatedConversions: 1,
      },
      { networkSource: "impact" },
    );
    assert.equal(input.supplier, "IMPACT");
    assert.equal(input.supplierCampaignId, "9001");
    assert.equal(input.networkClicks, 40);
    assert.equal(input.mboLinkClicks, null);
    assert.notEqual(input.mboLinkClicks, input.networkClicks);
    assert.equal(input.grossOrderValue, 120);
    assert.equal(input.grossCommission, 8);
    assert.equal(input.networkClickId, "imp-click-1");
  });

  it("Impact coupons capability is NOT_APPLICABLE (deal promotions, not voucher codes)", () => {
    const adapter = createImpactAdapter({
      accountSid: "sid",
      authToken: "token",
    });
    const caps = adapter.getCapabilities();
    assert.ok(!caps.capabilities.includes("COUPONS"));
    assert.ok(caps.notes.some((n) => /NOT_APPLICABLE/i.test(n)));
    assert.equal(typeof adapter.fetchCoupons, "function");
  });

  it("Impact fetchCoupons returns empty and marks N/A in stats", async () => {
    const adapter = createImpactAdapter({
      accountSid: "sid",
      authToken: "token",
    });
    const stats = {};
    const rows = await adapter.fetchCoupons({}, stats);
    assert.deepEqual(rows, []);
    assert.match(String(stats.couponCapability), /NOT_APPLICABLE/);
  });
});

describe("P1.14.1 network vs MBO click separation", () => {
  it("refuses to treat networkClicks as mboLinkClicks in mapper", () => {
    const input = mapPerformanceRowToFactInput(
      { date: "2026-08-12", clicks: 999, mboLinkClicks: undefined },
      { networkSource: "boostiny" },
    );
    assert.equal(input.networkClicks, 999);
    assert.equal(input.mboLinkClicks, null);
  });

  it("preserves explicit mboLinkClicks only when provided separately", () => {
    const input = mapPerformanceRowToFactInput(
      { date: "2026-08-12", clicks: 999, mboLinkClicks: 3 },
      { networkSource: "optimise_sea" },
    );
    assert.equal(input.networkClicks, 999);
    assert.equal(input.mboLinkClicks, 3);
  });
});
