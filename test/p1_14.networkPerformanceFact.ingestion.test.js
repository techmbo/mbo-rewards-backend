/**
 * P1.14 — NetworkPerformanceFact ingestion mapping tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapPerformanceRowToFactInput,
} from "../src/modules/networkPortal/networkPerformanceFact.ingestion.js";

describe("P1.14 NetworkPerformanceFact ingestion mapping", () => {
  it("maps Boostiny-like row without inventing MBO clicks from network clicks", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-15",
        clicks: 100,
        orders: 10,
        net_orders: 8,
        sales_amount_usd: 500,
        net_revenue: 40,
        advertiser_name: "Brand X",
        campaign_name: "Camp Y",
        currency: "USD",
      },
      { networkSource: "boostiny", sourceAccountLabel: "main" },
    );
    assert.equal(input.supplier, "BOOSTINY");
    assert.equal(input.networkClicks, 100);
    assert.equal(input.mboLinkClicks, null);
    assert.equal(input.grossOrders, 10);
    assert.equal(input.confirmedOrders, 8);
    assert.equal(input.mboActuallyReceived, null);
    assert.ok(input.reportDate instanceof Date);
  });

  it("maps Boostiny performance code + code_id as couponCode", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-05-13",
        code: "AFM106",
        code_id: 545825,
        campaign_id: 624,
        campaign_name: "Samsung KSA Coupons",
        net_orders: 1,
        net_revenue: 0.04,
        country: "SAU",
      },
      { networkSource: "boostiny" },
    );
    assert.equal(input.couponCode, "AFM106");
    assert.equal(input.couponId, "545825");
    assert.equal(input.campaignChannelType, "COUPON_CODE_ONLY");
  });

  it("does not treat bare ISO-2 code as coupon without code_id", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-05-13",
        code: "SA",
        campaign_name: "X",
        clicks: 1,
      },
      { networkSource: "boostiny" },
    );
    assert.equal(input.couponCode, null);
  });

  it("maps Trackier report row clicks to networkClicks only", () => {
    const input = mapPerformanceRowToFactInput(
      {
        created: "2026-08-01T12:00:00Z",
        clicks: 50,
        approvedConversions: 3,
        payout: 12.5,
        saleAmount: 200,
        campaign_name: "Offer",
      },
      { networkSource: "trackier" },
    );
    assert.equal(input.supplier, "TRACKIER");
    assert.equal(input.networkClicks, 50);
    assert.equal(input.mboLinkClicks, null);
    assert.equal(input.confirmedOrders, 3);
    assert.equal(input.confirmedCommission, 12.5);
  });

  it("skips rows without a report date", () => {
    assert.equal(
      mapPerformanceRowToFactInput({ clicks: 1 }, { networkSource: "optimise_sea" }),
      null,
    );
  });

  it("never copies network tracking URL into mboTrackingLink", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-15",
        trackingUrl: "https://network.example/track",
        clicks: 1,
      },
      { networkSource: "optimise_mena" },
    );
    assert.equal(input.networkTrackingLink, "https://network.example/track");
    assert.equal(input.mboTrackingLink, null);
  });

  it("maps 14E tracking, coupon and status fields without mixing cancelled and rejected", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-15",
        coupon_code: "SAVE20",
        coupon_id: "coupon_SAVE20",
        trackingUrl: "https://network.example/ubuy",
        clickref: "netclk_8821",
        sub_id_1: "mbo_ref_01",
        cancelledOrders: 5,
        rejectedConversions: 6,
        status: "approved",
        impressions: 25100,
      },
      { networkSource: "optimise_mena" },
    );
    assert.equal(input.couponCode, "SAVE20");
    assert.equal(input.couponId, "coupon_SAVE20");
    assert.equal(input.networkClickId, "netclk_8821");
    assert.equal(input.subId1, "mbo_ref_01");
    assert.equal(input.cancelledOrders, 5);
    assert.equal(input.rejectedOrders, 6);
    assert.equal(input.campaignChannelType, "COUPON_AND_LINK");
    assert.equal(input.metadata.rawStatus, "approved");
    assert.equal(input.metadata.mboStandardStatus, "Confirmed");
    assert.equal(input.impressions, 25100);
  });

  it("maps Optimise reporting targetCurrencyCode and nested commission fields", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-12",
        clicks: 1,
        campaignName: "HSBC Credit Cards- CPA",
        totalConversions: 0,
        originalOrderValue: 0,
        validatedCommission: 0,
        validatedConversions: 0,
        targetCurrencyCode: "USD",
        countryCode: "SG",
      },
      { networkSource: "optimise_sea" },
    );
    assert.equal(input.supplier, "OPTIMISE");
    assert.equal(input.networkClicks, 1);
    assert.equal(input.grossOrders, 0);
    assert.equal(input.currency, "USD");
    assert.equal(input.country, "SG");
  });

  it("maps Optimise conversion nested commission.amount without inventing MBO clicks", () => {
    const input = mapPerformanceRowToFactInput(
      {
        conversionDate: "2026-04-03",
        campaignId: 51515,
        campaignName: "Coupon Campaign",
        advertiserName: "Noon EGYPT",
        voucher: "mp393",
        status: "approved",
        commission: { amount: 1.54, currency: "USD" },
        conversionValue: { amount: 39.7 },
      },
      { networkSource: "optimise_mena" },
    );
    assert.equal(input.supplierCampaignId, "51515");
    assert.equal(input.brandName, "Noon EGYPT");
    assert.equal(input.couponCode, "mp393");
    assert.equal(input.confirmedCommission, 1.54);
    assert.equal(input.currency, "USD");
    assert.equal(input.grossOrderValue, 39.7);
    assert.equal(input.mboLinkClicks, null);
  });

  it("maps Partnerize conversion-derived performance fields", () => {
    const input = mapPerformanceRowToFactInput(
      {
        conversion_time: "2026-05-01T10:00:00Z",
        campaign_id: "cam_99",
        campaign_title: "Partnerize Camp",
        advertiser_name: "Brand PZ",
        publisher_commission: 4.2,
        conversion_value: { value: 80, currency: "GBP", publisher_commission: 4.2 },
        currency: "GBP",
        country: "GB",
        voucher_code: "SAVE10",
        clickref: "pz_click_1",
        customer_type: "new",
        conversion_status: "approved",
        orders: 1,
        totalConversions: 1,
        validatedConversions: 1,
      },
      { networkSource: "partnerize" },
    );
    assert.equal(input.supplier, "PARTNERIZE");
    assert.equal(input.supplierCampaignId, "cam_99");
    assert.equal(input.brandName, "Brand PZ");
    assert.equal(input.campaignName, "Partnerize Camp");
    assert.equal(input.grossCommission, 4.2);
    assert.equal(input.grossOrderValue, 80);
    assert.equal(input.currency, "GBP");
    assert.equal(input.country, "GB");
    assert.equal(input.couponCode, "SAVE10");
    assert.equal(input.networkClickId, "pz_click_1");
    assert.equal(input.customerType, "NEW");
    assert.equal(input.mboLinkClicks, null);
  });

  it("maps Impact Action-derived performance fields", () => {
    const input = mapPerformanceRowToFactInput(
      {
        EventDate: "2026-06-15T12:00:00Z",
        CampaignId: "1001",
        CampaignName: "Impact Program",
        AdvertiserName: "Impact Brand",
        Payout: 12,
        Amount: 200,
        Currency: "USD",
        CustomerCountry: "US",
        PromoCode: "IMPACT20",
        State: "Approved",
        orders: 1,
        totalConversions: 1,
        validatedConversions: 1,
      },
      { networkSource: "impact" },
    );
    assert.equal(input.supplier, "IMPACT");
    assert.equal(input.supplierCampaignId, "1001");
    assert.equal(input.brandName, "Impact Brand");
    assert.equal(input.confirmedCommission, 12);
    assert.equal(input.grossOrderValue, 200);
    assert.equal(input.currency, "USD");
    assert.equal(input.country, "US");
    assert.equal(input.couponCode, "IMPACT20");
    assert.equal(input.mboLinkClicks, null);
  });

  it("maps Awin transaction nested commissionAmount/saleAmount", () => {
    const input = mapPerformanceRowToFactInput(
      {
        transactionDate: "2026-07-01",
        advertiserId: 7788,
        advertiserName: "Awin Advertiser",
        commissionAmount: { amount: 3.5, currency: "EUR" },
        saleAmount: { amount: 70, currency: "EUR" },
        commissionStatus: "approved",
        voucherCode: "AWIN5",
        clickRef: "aw_ref_1",
        customerCountry: "DE",
        orders: 1,
        totalConversions: 1,
        validatedConversions: 1,
      },
      { networkSource: "awin" },
    );
    assert.equal(input.supplier, "AWIN");
    assert.equal(input.supplierCampaignId, "7788");
    assert.equal(input.brandName, "Awin Advertiser");
    assert.equal(input.grossCommission, 3.5);
    assert.equal(input.grossOrderValue, 70);
    assert.equal(input.currency, "EUR");
    assert.equal(input.country, "DE");
    assert.equal(input.couponCode, "AWIN5");
    assert.equal(input.networkClickId, "aw_ref_1");
    assert.equal(input.mboLinkClicks, null);
  });

  it("maps Boostiny brand_name and never invents ISO from country names", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-01",
        clicks: 9,
        orders: 2,
        sales_amount_usd: 50,
        net_revenue: 5,
        brand_name: "Boostiny Brand",
        campaign_name: "Boostiny Camp",
        country: "United Arab Emirates",
        currency: "USD",
      },
      { networkSource: "boostiny" },
    );
    assert.equal(input.supplier, "BOOSTINY");
    assert.equal(input.brandName, "Boostiny Brand");
    assert.equal(input.networkClicks, 9);
    assert.equal(input.country, null);
    assert.equal(input.mboLinkClicks, null);
  });

  it("skips planned networks not yet in SupplierKey enum", () => {
    assert.equal(
      mapPerformanceRowToFactInput(
        { date: "2026-08-01", clicks: 2, currency: "USD" },
        { networkSource: "admitad" },
      ),
      null,
    );
    assert.equal(
      mapPerformanceRowToFactInput(
        { date: "2026-08-01", clicks: 2, currency: "USD" },
        { networkSource: "cj" },
      ),
      null,
    );
  });
});
