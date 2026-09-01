import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildNetworkCampaignFields,
  toListRow,
  toDetailDto,
} from "../src/modules/ops/importedRecords.service.js";
import { deriveMboReady } from "../src/modules/ops/v15FieldContract.js";

function campaignEntity(overrides = {}) {
  const supplierCampaign = {
    id: "sc-row-1",
    supplierCampaignId: "SUP-99",
    campaignName: "Summer Sale",
    campaignStatus: "ACTIVE",
    campaignType: "CPA",
    pricingModel: "PERCENTAGE",
    categoryName: "Travel",
    countryCodes: ["AE", "SA"],
    currencyCode: "AED",
    commissionCurrency: "AED",
    defaultCommissionValue: 10,
    commissionUnit: "PERCENT",
    trackingUrl: "https://network.example/track/abc",
    deepLinkingEnabled: true,
    merchantId: "m1",
    merchantNameRaw: "Brand Co",
    sourceAccountLabel: "acct-1",
    rawPayloadId: "raw-1",
    lastSyncedAt: new Date("2026-08-01T00:00:00Z"),
    archivedAt: null,
    syncConflict: false,
    mapperVersion: "v1",
    mappingCertification: { status: "CERTIFIED" },
    _count: { coupons: 2 },
    campaignSources: [
      {
        id: "cs-1",
        canonicalCampaignId: "cc-1",
        isActive: true,
        relationshipStatus: "JOINED",
        supportsLink: true,
        supportsCoupon: true,
        grossCommission: 10,
        trackingLinks: [
          {
            id: "tl-1",
            mboTrackingUrl: "https://mbo.example/r/xyz",
            supplierTrackingUrl: "https://network.example/track/abc",
            subId: "sub-a",
          },
        ],
        _count: { productFeeds: 1 },
      },
    ],
    merchant: {
      id: "m1",
      displayName: "Brand Co",
      logoUrl: null,
      website: "https://brand.example",
    },
    merchantReview: null,
    ...overrides.supplierCampaign,
  };

  return {
    id: "ent-1",
    entityType: "campaign",
    networkSource: "optimise",
    externalId: "ext-1",
    campaignName: "Summer Sale",
    entityName: "Summer Sale",
    advertiserName: "Brand Co",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-08-02T00:00:00Z"),
    rawData: { name: "Summer Sale" },
    supplierCampaigns: [supplierCampaign],
    supplierCoupons: [],
    mapperErrors: [],
    rawPayloads: [
      {
        id: "raw-1",
        resourceKey: "optimise:campaigns",
        fetchedAt: new Date("2026-07-01T00:00:00Z"),
        processingStatus: "PROCESSED",
      },
    ],
    ...overrides,
    supplierCampaigns: overrides.supplierCampaigns ?? [supplierCampaign],
  };
}

describe("imported records Network Campaign projection", () => {
  it("maps identity, brand, category, country, currency, types", () => {
    const fields = buildNetworkCampaignFields({
      entity: campaignEntity(),
      supplierCampaign: campaignEntity().supplierCampaigns[0],
      campaignSource: campaignEntity().supplierCampaigns[0].campaignSources[0],
      merchant: campaignEntity().supplierCampaigns[0].merchant,
      statuses: { mappingStatus: "MAPPED" },
      openMapperError: null,
    });

    assert.equal(fields.networkAccount, "acct-1");
    assert.equal(fields.campaignSourceId, "cs-1");
    assert.equal(fields.supplierCampaignExtId, "SUP-99");
    assert.equal(fields.networkCampaignId, "SUP-99");
    assert.equal(fields.rawPayloadId, "raw-1");
    assert.equal(fields.category, "Travel");
    assert.deepEqual(fields.country, ["AE", "SA"]);
    assert.equal(fields.currency, "AED");
    assert.equal(fields.campaignType, "CPA");
    assert.equal(fields.commercialType, "PERCENTAGE");
    assert.ok(fields.channelType);
  });

  it("keeps relationship status separate from campaign status", () => {
    const fields = buildNetworkCampaignFields({
      entity: campaignEntity(),
      supplierCampaign: campaignEntity().supplierCampaigns[0],
      campaignSource: campaignEntity().supplierCampaigns[0].campaignSources[0],
      merchant: campaignEntity().supplierCampaigns[0].merchant,
      statuses: { mappingStatus: "MAPPED" },
    });
    assert.equal(fields.relationshipStatus, "JOINED");
    assert.equal(fields.campaignStatus, "ACTIVE");
    assert.notEqual(fields.relationshipStatus, fields.campaignStatus);
  });

  it("never copies network tracking URL into MBO tracking URL", () => {
    const sc = campaignEntity().supplierCampaigns[0];
    sc.campaignSources[0].trackingLinks = [];
    const fields = buildNetworkCampaignFields({
      entity: campaignEntity({ supplierCampaigns: [sc] }),
      supplierCampaign: sc,
      campaignSource: sc.campaignSources[0],
      merchant: sc.merchant,
      statuses: { mappingStatus: "MAPPED" },
    });
    assert.equal(fields.networkTrackingLink, "https://network.example/track/abc");
    assert.equal(fields.mboTrackingLink, null);
    assert.notEqual(fields.networkTrackingLink, fields.mboTrackingLink);
  });

  it("leaves click IDs null on campaign grain (no invention)", () => {
    const fields = buildNetworkCampaignFields({
      entity: campaignEntity(),
      supplierCampaign: campaignEntity().supplierCampaigns[0],
      campaignSource: campaignEntity().supplierCampaigns[0].campaignSources[0],
      merchant: campaignEntity().supplierCampaigns[0].merchant,
      statuses: { mappingStatus: "MAPPED" },
    });
    assert.equal(fields.networkClickId, null);
    assert.equal(fields.mboClickId, null);
  });

  it("exposes assets without inventing missing capabilities", () => {
    const sc = campaignEntity().supplierCampaigns[0];
    sc.trackingUrl = null;
    sc.deepLinkingEnabled = false;
    sc._count = { coupons: 0 };
    sc.campaignSources[0].supportsLink = false;
    sc.campaignSources[0].supportsCoupon = false;
    sc.campaignSources[0]._count = { productFeeds: 0 };
    const fields = buildNetworkCampaignFields({
      entity: campaignEntity({ supplierCampaigns: [sc] }),
      supplierCampaign: sc,
      campaignSource: sc.campaignSources[0],
      merchant: sc.merchant,
      statuses: { mappingStatus: "MAPPED" },
    });
    assert.equal(fields.assets.link, false);
    assert.equal(fields.assets.coupon, false);
    assert.equal(fields.assets.deeplink, false);
    assert.equal(fields.assets.feed, false);
  });

  it("nulls commission when supplier has no commission data", () => {
    const sc = campaignEntity().supplierCampaigns[0];
    sc.defaultCommissionValue = null;
    sc.commissionUnit = null;
    sc.campaignSources[0].grossCommission = null;
    const fields = buildNetworkCampaignFields({
      entity: campaignEntity({ supplierCampaigns: [sc] }),
      supplierCampaign: sc,
      campaignSource: sc.campaignSources[0],
      merchant: sc.merchant,
      statuses: { mappingStatus: "MAPPED" },
    });
    assert.equal(fields.commission, null);
  });

  it("derives MBO Ready via deriveMboReady (not hardcoded true)", () => {
    const row = toListRow(campaignEntity());
    assert.equal(typeof row.mboReady, "boolean");
    // Incomplete brand mapping → not ready
    const sc = campaignEntity().supplierCampaigns[0];
    sc.merchantId = null;
    const notReady = buildNetworkCampaignFields({
      entity: campaignEntity({ supplierCampaigns: [sc] }),
      supplierCampaign: sc,
      campaignSource: sc.campaignSources[0],
      merchant: null,
      statuses: { mappingStatus: "NEEDS_REVIEW" },
    });
    assert.equal(notReady.mboReady, false);
    assert.equal(
      deriveMboReady({
        campaignStatus: "ACTIVE",
        relationshipStatus: "JOINED",
        brandMappingComplete: false,
        mappingStatus: "MAPPED",
        commissionAvailable: true,
        hasUsableAsset: true,
        sourceHidden: false,
        hasCampaignSource: true,
      }),
      false,
    );
  });

  it("toListRow and toDetailDto expose required contract fields", () => {
    const row = toListRow(campaignEntity());
    assert.equal(row.networkAccount, "acct-1");
    assert.equal(row.campaignSourceId, "cs-1");
    assert.equal(row.supplierCampaignExtId, "SUP-99");
    assert.equal(row.category, "Travel");
    assert.equal(row.relationshipStatus, "JOINED");
    assert.equal(row.campaignStatus, "ACTIVE");
    assert.ok(row.assets);
    assert.equal(row.networkTrackingLink, "https://network.example/track/abc");
    assert.equal(row.mboTrackingLink, "https://mbo.example/r/xyz");

    const detail = toDetailDto(campaignEntity());
    assert.equal(detail.identity.rawPayloadId, "raw-1");
    assert.equal(detail.tracking.networkTrackingLink, "https://network.example/track/abc");
    assert.equal(detail.tracking.mboTrackingLink, "https://mbo.example/r/xyz");
    assert.notEqual(detail.tracking.networkTrackingLink, detail.tracking.mboTrackingLink);
    assert.equal(detail.campaignDetail.relationshipStatus, "JOINED");
    assert.equal(detail.campaignDetail.campaignStatus, "ACTIVE");
    assert.equal(detail.ingestion.mboReady, row.mboReady);
    assert.ok(!JSON.stringify(detail).includes("demo"));
  });

  it("non-campaign performance entities return null network campaign fields", () => {
    const entity = campaignEntity({ entityType: "performance", supplierCampaigns: [] });
    const fields = buildNetworkCampaignFields({
      entity,
      supplierCampaign: null,
      campaignSource: null,
      merchant: null,
      statuses: { mappingStatus: "NOT_AVAILABLE" },
    });
    assert.equal(fields.mboReady, null);
    assert.equal(fields.campaignSourceId, null);
    assert.equal(fields.networkTrackingLink, null);
  });

  it("hydrates country and commission from Optimise markets and commissionCost when stored fields are empty", () => {
    const sc = campaignEntity().supplierCampaigns[0];
    sc.countryCodes = [];
    sc.defaultCommissionValue = null;
    sc.commissionUnit = "UNKNOWN";
    sc.campaignStatus = "UNKNOWN";
    sc.participationStatus = "UNKNOWN";
    const entity = campaignEntity({
      supplierCampaigns: [sc],
      rawData: {
        name: "Summer Sale",
        status: "live",
        markets: [{ iso: "AE" }, { iso: "SA" }],
        commissionCost: "10%",
        vertical: { name: "Travel" },
      },
    });
    const fields = buildNetworkCampaignFields({
      entity,
      supplierCampaign: sc,
      campaignSource: sc.campaignSources[0],
      merchant: sc.merchant,
      statuses: { mappingStatus: "MAPPED" },
    });
    assert.deepEqual(fields.country, ["AE", "SA"]);
    assert.equal(fields.commission, 10);
    assert.equal(fields.campaignStatus, "ACTIVE");
    assert.equal(fields.relationshipStatus, "JOINED");
  });

  it("hydrates Boostiny targetCountries into the country column", () => {
    const sc = campaignEntity().supplierCampaigns[0];
    sc.countryCodes = [];
    const entity = campaignEntity({
      networkSource: "boostiny",
      supplierCampaigns: [sc],
      rawData: {
        name: "Summer Sale",
        targetCountries: [{ name: "United Arab Emirates", iso: "AE" }],
      },
    });
    const fields = buildNetworkCampaignFields({
      entity,
      supplierCampaign: sc,
      campaignSource: sc.campaignSources[0],
      merchant: sc.merchant,
      statuses: { mappingStatus: "MAPPED" },
    });
    assert.ok(fields.country?.includes("AE"));
  });

  it("coupon rows inherit parent campaign brand, category, country, and mark coupon assets", () => {
    const parent = campaignEntity().supplierCampaigns[0];
    const entity = campaignEntity({
      entityType: "coupon",
      supplierCampaigns: [],
      advertiserName: null,
      campaignName: "Dotandkey.com Ecommerce CPS - India",
      rawData: {
        campaign_name: "Dotandkey.com Ecommerce CPS - India",
        code: "SAVE10",
        advertiser_name: "Dot & Key",
      },
      supplierCoupons: [
        {
          couponCode: "SAVE10",
          couponLink: null,
          couponType: "CODE",
          supplierCampaign: parent,
        },
      ],
    });
    const row = toListRow(entity);
    assert.equal(row.brand, "Brand Co");
    assert.equal(row.category, "Travel");
    assert.deepEqual(row.country, ["AE", "SA"]);
    assert.equal(row.assets.coupon, true);
    assert.equal(row.mboReady, null);
  });

  it("partnerize entity without supplier campaign still surfaces brand from title and landing url", () => {
    const entity = campaignEntity({
      networkSource: "partnerize",
      advertiserName: null,
      campaignName: "DAZN DACH Partners (RETIRED)",
      entityName: "DAZN DACH Partners (RETIRED)",
      supplierCampaigns: [],
      rawData: {
        title: "DAZN DACH Partners (RETIRED)",
        destination_url: "https://www.dazn.com/welcome",
        vertical_name: "Entertainment",
        status: "r",
      },
    });
    const row = toListRow(entity);
    assert.equal(row.brand, "DAZN DACH");
    assert.equal(row.brandWebsiteLink, "https://www.dazn.com/welcome");
    assert.equal(row.campaign, "DAZN DACH Partners (RETIRED)");
  });

  it("pipe-delimited partnerize title yields brand name without promotion", () => {
    const entity = campaignEntity({
      networkSource: "partnerize",
      advertiserName: null,
      campaignName: "MindManager | Mind Mapping Software",
      entityName: "MindManager | Mind Mapping Software",
      supplierCampaigns: [],
      rawData: {
        title: "MindManager | Mind Mapping Software",
        destination_url: "https://www.mindmanager.com",
        vertical_name: "Computers & Electronics",
      },
    });
    const row = toListRow(entity);
    assert.equal(row.brand, "MindManager");
  });

  it("region-suffixed partnerize title yields brand name", () => {
    const entity = campaignEntity({
      networkSource: "partnerize",
      advertiserName: null,
      campaignName: "Ticombo Germany",
      entityName: "Ticombo Germany",
      supplierCampaigns: [],
      rawData: {
        title: "Ticombo Germany",
        destination_url: "https://www.ticombo.com",
      },
    });
    const row = toListRow(entity);
    assert.equal(row.brand, "Ticombo");
  });

  it("optimise raw vertical.secondary surfaces as secondaryCategory", () => {
    const entity = campaignEntity({
      networkSource: "optimise_mena",
      supplierCampaigns: [],
      rawData: {
        name: "Brand CPS",
        vertical: { primary: "Retail - Technology & Entertainment", secondary: "Electronics" },
      },
    });
    const row = toListRow(entity);
    assert.equal(row.secondaryCategory, "Electronics");
  });

  it("partnerize Computers & Electronics vertical yields secondary segment", () => {
    const entity = campaignEntity({
      networkSource: "partnerize",
      supplierCampaigns: [],
      rawData: {
        title: "MindManager | Mind Mapping Software",
        vertical_name: "Computers & Electronics",
      },
    });
    const row = toListRow(entity);
    assert.equal(row.category, "Computers & Electronics");
    assert.equal(row.secondaryCategory, "Electronics");
  });

  it("boostiny payouts supply tracking link and campaign dates without promotion", () => {
    const entity = campaignEntity({
      networkSource: "boostiny",
      supplierCampaigns: [],
      rawData: {
        name: "Samsung KSA Coupons",
        payouts: [
          {
            model: "cps",
            start_date: "2026-02-01T00:00:00.000000Z",
            end_date: "2027-01-31T00:00:00.000000Z",
            links: "https://track.boostiny.example/click/624",
          },
        ],
      },
    });
    const row = toListRow(entity);
    assert.equal(row.networkTrackingLink, "https://track.boostiny.example/click/624");
    assert.ok(String(row.startDate).startsWith("2026-02-01"));
    assert.ok(String(row.endDate).startsWith("2027-01-31"));
  });

  it("optimise raw supplies tracking link and applied date when supplier campaign is empty", () => {
    const entity = campaignEntity({
      networkSource: "optimise_mena",
      supplierCampaigns: [],
      rawData: {
        name: "Summer Sale",
        appliedDate: "2026-08-21T11:42:27.663Z",
        baseTrackingUrl: "https://clk.omgt6.com/?PID=56751&AID=2359784",
        vertical: { primary: "Travel", secondary: "Hotels" },
      },
    });
    const row = toListRow(entity);
    assert.equal(row.networkTrackingLink, "https://clk.omgt6.com/?PID=56751&AID=2359784");
    assert.ok(String(row.startDate).startsWith("2026-08-21"));
    assert.equal(row.secondaryCategory, "Hotels");
  });

  it("coupon rows without a parent still surface brand and type from the coupon payload", () => {
    const entity = campaignEntity({
      entityType: "coupon",
      supplierCampaigns: [],
      advertiserName: null,
      entitySubType: "Coupon",
      rawData: {
        campaign_name: "Ajio.com Ecommerce CPS - India",
        advertiser_name: "Ajio",
        code: "AJIO20",
        category: "Fashion",
        geo: "IN",
      },
      supplierCoupons: [],
    });
    const row = toListRow(entity);
    assert.equal(row.brand, "Ajio");
    assert.equal(row.category, "Fashion");
    assert.ok(row.country?.includes("IN"));
    assert.equal(row.assets.coupon, true);
  });
});
