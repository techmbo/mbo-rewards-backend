import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapPartnerizeCampaign,
  mapPartnerizeCoupon,
  mapPartnerizeRelationship,
} from "../src/modules/supplier/mappers/partnerize.mapper.js";
import {
  extractBoostinyPayout,
  mapBoostinyCampaign,
} from "../src/modules/supplier/mappers/boostiny.mapper.js";
import { mapOptimiseCampaign } from "../src/modules/supplier/mappers/optimise.mapper.js";
import { mapPerformanceRowToFactInput } from "../src/modules/networkPortal/networkPerformanceFact.ingestion.js";

describe("P1.15 Partnerize field contract", () => {
  it("maps campaigns[].status to relationship, not campaign lifecycle", () => {
    const rel = mapPartnerizeRelationship({ status: "joined" });
    assert.equal(rel.participationStatus, "JOINED");
    assert.equal(rel.isJoined, true);

    const mapped = mapPartnerizeCampaign({
      entityType: "campaign",
      networkSource: "partnerize",
      externalId: "partnerize-campaign-1",
      rawData: {
        campaign_id: "1",
        title: "PZ Sale",
        status: "joined",
        advertiser: { name: "Myntra" },
        tracking_link: "https://pz.example/track/1",
        destination_url: "https://myntra.com/sale",
      },
    });
    assert.equal(mapped.participationStatus, "JOINED");
    assert.equal(mapped.merchantNameRaw, "Myntra");
    assert.equal(mapped.trackingUrl, "https://pz.example/track/1");
    assert.equal(mapped.destinationUrl, "https://myntra.com/sale");
    assert.notEqual(mapped.trackingUrl, mapped.destinationUrl);
    // Must not invent campaign ACTIVE from join status alone
    assert.notEqual(mapped.campaignStatus, "ACTIVE");
  });

  it("never uses destination_url as supplier tracking URL", () => {
    const mapped = mapPartnerizeCampaign({
      entityType: "campaign",
      networkSource: "partnerize",
      externalId: "partnerize-campaign-2",
      rawData: {
        id: "2",
        title: "Landing Only",
        destination_url: "https://brand.example/land",
      },
    });
    assert.equal(mapped.destinationUrl, "https://brand.example/land");
    assert.equal(mapped.trackingUrl, null);
  });

  it("derives brand label from landing URL when advertiser name is absent", () => {
    const mapped = mapPartnerizeCampaign({
      entityType: "campaign",
      networkSource: "partnerize",
      externalId: "partnerize-campaign-ticombo",
      rawData: {
        campaign_id: "301660",
        title: "Ticombo Europe",
        destination_url: "https://www.ticombo.com",
        status: "a",
        vertical_name: "Tickets & Events",
        conversion_type: "sale",
        default_commission_rate: "5.00",
        default_currency: "EUR",
        campaign_logo: "",
      },
    });
    assert.equal(mapped.merchantNameRaw, "ticombo.com");
    assert.equal(mapped.categoryName, "Tickets & Events");
    assert.equal(mapped.campaignType, "CPS");
    assert.equal(mapped.pricingModel, "CPS");
    assert.equal(mapped.defaultCommissionValue, "5");
    assert.equal(mapped.currencyCode, "EUR");
    assert.equal(mapped.participationStatus, "JOINED");
    assert.equal(mapped.campaignLogoUrl, null);
  });

  it("maps publisher list status codes a/p/r to relationship", () => {
    assert.equal(mapPartnerizeRelationship({ status: "a" }).participationStatus, "JOINED");
    assert.equal(mapPartnerizeRelationship({ status: "p" }).participationStatus, "PENDING");
    assert.equal(mapPartnerizeRelationship({ status: "r" }).participationStatus, "NOT_JOINED");
  });

  it("maps Partnerize status a to campaign ACTIVE", () => {
    const mapped = mapPartnerizeCampaign({
      entityType: "campaign",
      networkSource: "partnerize",
      externalId: "partnerize-campaign-a-active",
      rawData: {
        campaign_id: "101116400",
        title: "Ticombo Germany",
        status: "a",
        destination_url: "https://ticombo.com",
      },
    });
    assert.equal(mapped.campaignStatus, "ACTIVE");
    assert.equal(mapped.participationStatus, "JOINED");
  });

  it("maps Partnerize allow_deep_linking and destination into asset-capable fields", () => {
    const mapped = mapPartnerizeCampaign({
      entityType: "campaign",
      networkSource: "partnerize",
      externalId: "partnerize-assets",
      rawData: {
        campaign_id: "42",
        title: "Asset Camp",
        status: "a",
        destination_url: "https://brand.example",
        allow_deep_linking: "y",
        default_commission_rate: 7,
        default_currency: "EUR",
      },
    });
    assert.equal(mapped.deepLinkingEnabled, true);
    assert.equal(mapped.destinationUrl, "https://brand.example");
    assert.equal(mapped.trackingUrl, null);
    assert.equal(mapped.defaultCommissionValue, "7");
    assert.equal(mapped.commissionUnit, "PERCENT");
  });

  it("maps discovery campaign_lifecycle_status without overriding a/p/r relationship", () => {
    const mapped = mapPartnerizeCampaign({
      entityType: "campaign",
      networkSource: "partnerize",
      externalId: "partnerize-campaign-lifecycle",
      rawData: {
        campaign_id: "99",
        title: "Lifecycle",
        status: "a",
        publisher_status: "a",
        campaign_lifecycle_status: "active",
        destination_url: "https://brand.example",
      },
    });
    assert.equal(mapped.participationStatus, "JOINED");
    assert.equal(mapped.campaignStatus, "ACTIVE");
  });

  it("uses discovery campaign_icon and advertiser name when present", () => {
    const mapped = mapPartnerizeCampaign({
      entityType: "campaign",
      networkSource: "partnerize",
      externalId: "partnerize-campaign-3",
      rawData: {
        campaign_id: "3",
        title: "Indeed Affiliates",
        destination_url: "https://www.indeed.com",
        advertiser: { name: "Indeed", advertiser_icon: "https://cdn/indeed.png" },
        campaign_icon: "https://cdn/indeed-camp.png",
      },
    });
    assert.equal(mapped.merchantNameRaw, "Indeed");
    assert.equal(mapped.campaignLogoUrl, "https://cdn/indeed-camp.png");
  });

  it("maps nested voucher_code.* without inventing expiry policy values", () => {
    const mapped = mapPartnerizeCoupon({
      entityType: "coupon",
      networkSource: "partnerize",
      externalId: "partnerize-coupon-n1",
      rawData: {
        campaign_id: "9",
        voucher_code: {
          voucher_code: "SAVE10",
          voucher_code_id: "vc-1",
          active: "y",
          on_expiry: null,
        },
      },
    });
    assert.equal(mapped.couponCode, "SAVE10");
    assert.equal(mapped.supplierCouponId, "vc-1");
    assert.equal(mapped.normalizedPayload.partnerizeVoucher.on_expiry, null);
  });
});

describe("P1.15 Boostiny payouts[] contract", () => {
  it("extracts payouts[].model/value/currency when present", () => {
    const payout = extractBoostinyPayout({
      payouts: [{ model: "CPS", value: "8.5", currency: "USD", is_global: true }],
    });
    assert.equal(payout.model, "CPS");
    assert.equal(payout.value, "8.5");
    assert.equal(payout.currency, "USD");

    const mapped = mapBoostinyCampaign({
      entityType: "campaign",
      networkSource: "boostiny",
      externalId: "boostiny-campaign-7",
      rawData: {
        id: 7,
        name: "Boostiny Offer",
        payouts: [{ model: "CPS", value: "8.5", currency: "USD" }],
      },
    });
    assert.equal(mapped.pricingModel, "CPS");
    assert.equal(mapped.defaultCommissionValue, "8.5");
    assert.equal(mapped.currencyCode, "USD");
  });

  it("extracts commission from payouts[].groups[].value (live Boostiny API shape)", () => {
    const payout = extractBoostinyPayout({
      payouts: [
        {
          model: "cps",
          groups: [
            { id: 72491, type: "sale-share", value: 4, priority: 1 },
            { id: 72492, type: "sale-share", value: 2, priority: 2 },
          ],
        },
      ],
    });
    assert.equal(payout.value, 4);

    const mapped = mapBoostinyCampaign({
      entityType: "campaign",
      networkSource: "boostiny",
      externalId: "boostiny-campaign-624",
      rawData: {
        id: 624,
        name: "Samsung KSA Coupons",
        payouts: payout.rules,
      },
    });
    assert.equal(mapped.defaultCommissionValue, "4");
    assert.ok(Array.isArray(mapped.commissionGroups));
  });

  it("leaves commission null when payouts absent (no fabrication)", () => {
    const mapped = mapBoostinyCampaign({
      entityType: "campaign",
      networkSource: "boostiny",
      externalId: "boostiny-campaign-8",
      rawData: { id: 8, name: "No Payout" },
    });
    assert.equal(mapped.defaultCommissionValue, null);
    assert.equal(mapped.normalizedPayload.boostinyPayout.model, null);
  });
});

describe("P1.15 Optimise commission lineage", () => {
  it("maps Optimise markets, vertical, and live status onto campaign fields", () => {
    const mapped = mapOptimiseCampaign({
      entityType: "campaign",
      networkSource: "optimise",
      externalId: "optimise-campaign-502",
      rawData: {
        productId: 502,
        name: "Shein Global - Links",
        advertiserName: "Shein",
        status: "live",
        vertical: { name: "Fashion" },
        markets: [{ iso: "AE" }, { iso: "SA" }],
        commissionCost: "8%",
        campaignTypeName: "CPS",
        baseTrackingUrl: "https://opt.example/t/1",
      },
    });
    assert.equal(mapped.merchantNameRaw, "Shein");
    assert.equal(mapped.categoryName, "Fashion");
    assert.deepEqual(mapped.countryCodes, ["AE", "SA"]);
    assert.equal(mapped.campaignStatus, "ACTIVE");
    assert.equal(mapped.participationStatus, "JOINED");
    assert.equal(mapped.defaultCommissionValue, "8");
    assert.equal(mapped.trackingUrl, "https://opt.example/t/1");
  });

  it("prefers commissionCost for commission_value and preserves metrics", () => {
    const mapped = mapOptimiseCampaign({
      entityType: "campaign",
      networkSource: "optimise",
      externalId: "optimise-campaign-501",
      rawData: {
        productId: 501,
        name: "Hotel Promo",
        advertiserName: "Hotels",
        status: "live",
        commissionCost: "12.50%",
        rejectedCommission: 3.2,
        commissionGroup: [{ id: "g1", name: "Default" }],
      },
    });
    assert.equal(mapped.defaultCommissionValue, "12.50");
    assert.equal(mapped.normalizedPayload.optimiseCommissionMetrics.rejectedCommission, 3.2);
    assert.ok(Array.isArray(mapped.commissionGroups));
  });

  it("maps Optimise reporting commission aliases into NetworkPerformanceFact", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-01",
        campaignName: "Camp",
        clicks: 10,
        validatedCommission: 5,
        pendingCommission: 2,
        rejectedCommission: 1,
        totalCommission: 8,
      },
      { networkSource: "optimise" },
    );
    assert.equal(input.networkClicks, 10);
    assert.equal(input.mboLinkClicks, null);
    assert.equal(input.confirmedCommission, 5);
    assert.equal(input.pendingCommission, 2);
    assert.equal(input.rejectedCommission, 1);
    // grossCommission is the total network commission across statuses (validated + pending +
    // rejected); payable/confirmed amounts always derive from confirmedCommission.
    assert.equal(input.grossCommission, 8);
  });
});
