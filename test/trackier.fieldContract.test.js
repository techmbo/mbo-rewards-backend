import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapTrackierCampaignRow,
  mapTrackierCouponRow,
  mapTrackierDealRow,
  mapTrackierReportRow,
} from "../src/adapters/trackier.adapter.js";
import { mapTrackierCampaign, mapTrackierCoupon } from "../src/modules/supplier/mappers/trackier.mapper.js";
import { normalizeEntity } from "../src/modules/raw/normalizers.js";
import {
  pickTrackierCampaignName,
  pickTrackierMerchantName,
  pickTrackierTrackingUrl,
  pickTrackierLandingUrl,
  buildTrackierCampaignFieldLineage,
} from "../src/modules/supplier/mappers/trackierFieldContract.js";

describe("Trackier/vCommission field contract", () => {
  it("resolves campaign name aliases without inventing", () => {
    assert.equal(pickTrackierCampaignName({ campaign_name: "A", offer_name: "B" }), "A");
    assert.equal(pickTrackierCampaignName({ offer_name: "B" }), "B");
    assert.equal(pickTrackierCampaignName({ title: "T", name: "N" }), "T");
    assert.equal(pickTrackierCampaignName({}), null);
  });

  it("does not invent status when absent", () => {
    const mapped = mapTrackierCampaignRow({ id: "1", title: "X" });
    assert.equal(mapped.status, undefined);
    assert.notEqual(mapped.status, "approved");
  });

  it("preserves supplier status and keeps application_status separate", () => {
    const mapped = mapTrackierCampaignRow({
      id: "10132",
      title: "Klook.com Travel CPS - Worldwide",
      status: "approved",
      application_status: "pending",
      preview_url: "https://www.klook.com/",
      tracking_link: "https://track.vcommission.com/click?campaign_id=10132",
      advertiser_name: "",
    });
    assert.equal(mapped.status, "approved");
    assert.equal(mapped.application_status, "pending");
    assert.equal(mapped.preview_url, "https://www.klook.com/");
    assert.equal(mapped.tracking_link, "https://track.vcommission.com/click?campaign_id=10132");
  });

  it("maps promotion layer: status≠relationship; tracking≠MBO; landing from preview_url", () => {
    const entity = {
      id: "e1",
      networkSource: "trackier",
      externalId: "trackier-campaign-10132",
      entityStatus: null,
      campaignName: null,
      advertiserName: null,
      rawData: {
        id: "10132",
        title: "Klook.com Travel CPS - Worldwide",
        status: "approved",
        application_status: "approved",
        preview_url: "https://www.klook.com/",
        tracking_link: "https://track.vcommission.com/click?campaign_id=10132",
        category_name: "travel",
        model: "cps",
        payout: "5",
        payout_type: "percent",
        currency: "USD",
        countries: ["ALL"],
        conversion_flow: "CPS",
        deep_link: "https://www.klook.com/deeplink",
        logo: "https://cdn.example/logo.png",
      },
      normalizedData: {},
    };

    const mapped = mapTrackierCampaign(entity);
    assert.equal(mapped.campaignStatus, "ACTIVE");
    assert.equal(mapped.participationStatus, "JOINED");
    assert.notEqual(mapped.campaignStatus, mapped.participationStatus);
    assert.equal(mapped.trackingUrl, "https://track.vcommission.com/click?campaign_id=10132");
    assert.equal(mapped.destinationUrl, "https://www.klook.com/");
    assert.notEqual(mapped.trackingUrl, mapped.destinationUrl);
    assert.equal(mapped.deepLinkingEnabled, true);
    assert.equal(mapped.categoryName, "travel");
    assert.equal(mapped.campaignType, "CPS");
    assert.equal(mapped.pricingModel, "CPS");
    assert.equal(mapped.defaultCommissionValue, "5");
    assert.equal(mapped.commissionUnit, "PERCENT");
    assert.equal(mapped.currencyCode, "USD");
    assert.deepEqual(mapped.countryCodes, ["ALL"]);
    assert.ok(mapped.normalizedPayload._trackierFieldLineage);
    assert.equal(
      mapped.normalizedPayload._trackierFieldLineage.supplier_tracking_url.sourceField,
      "tracking_link",
    );
    assert.equal(mapped.normalizedPayload.supplier_tracking_url, mapped.trackingUrl);
    assert.equal(mapped.merchantNameRaw, "klook.com");
  });

  it("skips empty advertiser_name and prefers merchant_name", () => {
    assert.equal(pickTrackierMerchantName({ advertiser_name: "", merchant_name: "Myntra" }), "Myntra");
  });

  it("normalizeEntity skips empty advertiser and does not use category as type", () => {
    const n = normalizeEntity(
      {
        id: "1",
        title: "Sale",
        advertiser_name: "",
        category_name: "fashion",
        conversion_flow: "CPS",
        status: "approved",
      },
      "trackier",
      "campaign",
    );
    assert.equal(n.advertiser, null);
    assert.equal(n.type, "CPS");
    assert.equal(n.campaign_name, "Sale");
  });

  it("coupon row maps coupon_status and nested coupons[].code", () => {
    const row = mapTrackierCouponRow({
      id: "c1",
      campaign_id: "101",
      coupon_status: "active",
      coupons: [{ code: "SAVE10" }],
    });
    assert.equal(row.code, "SAVE10");
    assert.equal(row.status, "active");

    const mapped = mapTrackierCoupon({
      id: "e",
      networkSource: "trackier",
      externalId: "trackier-coupon-c1",
      rawData: row,
      normalizedData: {},
    });
    assert.equal(mapped.couponCode, "SAVE10");
  });

  it("deal row does not invent coupon code from title", () => {
    const deal = mapTrackierDealRow({
      id: "d1",
      title: "Summer Deal",
      description: "Desc",
    });
    assert.equal(deal.code, null);
    assert.equal(deal.title, "Summer Deal");
    assert.equal(deal.description, "Desc");
  });

  it("report row keeps clicks/conversions/payout as reporting fields", () => {
    const r = mapTrackierReportRow({
      clicks: 10,
      conversions: 2,
      payout: 3.5,
      campaign_name: "X",
    });
    assert.equal(r.clicks, 10);
    assert.equal(r.conversions, 2);
    assert.equal(r.payout, 3.5);
  });

  it("tracking and landing pickers never swap", () => {
    const raw = {
      preview_url: "https://brand.example/",
      tracking_link: "https://track.example/click",
    };
    assert.equal(pickTrackierLandingUrl(raw), "https://brand.example/");
    assert.equal(pickTrackierTrackingUrl(raw), "https://track.example/click");
  });

  it("field lineage lists source fields for canonical names", () => {
    const lineage = buildTrackierCampaignFieldLineage({
      id: "9",
      campaign_name: "Offer",
      status: "approved",
      application_status: "pending",
      tracking_url: "https://track.example/x",
    });
    assert.equal(lineage.supplier_campaign_id.sourceField, "id");
    assert.equal(lineage.supplier_campaign_name.sourceField, "campaign_name");
    assert.equal(lineage.campaign_status.sourceField, "status");
    assert.equal(lineage.relationship_status.sourceField, "application_status");
    assert.equal(lineage.supplier_tracking_url.sourceField, "tracking_url");
  });
});
