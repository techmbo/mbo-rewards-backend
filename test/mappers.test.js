import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapEntityToSupplierCampaign } from "../src/modules/supplier/mappers/index.js";
import { mapBoostinyCampaign } from "../src/modules/supplier/mappers/boostiny.mapper.js";
import { normalizeCampaignStatus } from "../src/modules/supplier/mappers/status.js";

describe("supplier mappers", () => {
  it("normalizes campaign status values", () => {
    assert.equal(normalizeCampaignStatus("Live"), "ACTIVE");
    assert.equal(normalizeCampaignStatus("paused"), "PAUSED");
    assert.equal(normalizeCampaignStatus("weird"), "UNKNOWN");
  });

  it("maps boostiny campaign entity to canonical shape", () => {
    const entity = {
      id: "11111111-1111-1111-1111-111111111111",
      externalId: "boostiny-campaign-99",
      networkSource: "boostiny",
      entityType: "campaign",
      entityName: "Summer Sale",
      campaignName: "Summer Sale",
      advertiserName: "Acme Corp",
      entityStatus: "Active",
      entitySubType: null,
      commission: null,
      eventDate: null,
      normalizedData: { name: "Summer Sale", advertiser: "Acme Corp" },
      rawData: {
        id: 99,
        name: "Summer Sale",
        advertiser_name: "Acme Corp",
        status: "active",
        tracking_link: "https://track.example/99",
      },
      hasSyncConflict: false,
      fieldPolicies: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    const mapped = mapBoostinyCampaign(entity);
    assert.equal(mapped.supplier, "BOOSTINY");
    assert.equal(mapped.supplierCampaignId, "99");
    assert.equal(mapped.campaignName, "Summer Sale");
    assert.equal(mapped.merchantNameRaw, "Acme Corp");
    assert.equal(mapped.campaignStatus, "ACTIVE");
    assert.equal(mapped.trackingUrl, "https://track.example/99");
    assert.equal(mapped.mapperVersion, "1.1.1");
  });

  it("maps optimise_sea campaign via registry", () => {
    const entity = {
      id: "22222222-2222-2222-2222-222222222222",
      externalId: "optimise_sea-campaign-501",
      networkSource: "optimise_sea",
      entityType: "campaign",
      entityName: "Hotel Promo",
      campaignName: "Hotel Promo",
      advertiserName: "Hotels R Us",
      entityStatus: "Approved",
      entitySubType: "CPA",
      commission: 12.5,
      eventDate: "2026-02-01T00:00:00.000Z",
      normalizedData: {},
      rawData: {
        productId: 501,
        campaignName: "Hotel Promo",
        advertiserName: "Hotels R Us",
        status: "approved",
        currency: "USD",
      },
      hasSyncConflict: false,
      fieldPolicies: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    };

    const mapped = mapEntityToSupplierCampaign(entity);
    assert.equal(mapped.supplier, "OPTIMISE");
    assert.equal(mapped.supplierRegion, "SEA");
    assert.equal(mapped.supplierCampaignId, "501");
    assert.equal(mapped.defaultCommissionValue, "12.5");
    assert.equal(mapped.currencyCode, "USD");
  });
});
