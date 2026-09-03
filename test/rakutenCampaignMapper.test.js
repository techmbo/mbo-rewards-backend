import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasJsMapper, mapEntityToSupplierCampaign } from "../src/modules/supplier/mappers/index.js";

describe("Rakuten campaign mapper", () => {
  it("uses the source advertiser id instead of the staging external-id prefix", () => {
    const mapped = mapEntityToSupplierCampaign({
      id: "entity-1",
      networkSource: "rakuten",
      entityType: "campaign",
      externalId: "rakuten-advertiser-42",
      campaignName: "Example Advertiser",
      entityName: "Example Advertiser",
      entityStatus: "active",
      rawData: {
        id: 42,
        campaign_id: 42,
        name: "Example Advertiser",
        status: "active",
      },
      normalizedData: {
        id: "42",
        name: "Example Advertiser",
      },
    });

    assert.equal(mapped.supplier, "RAKUTEN");
    assert.equal(mapped.supplierCampaignId, "42");
    assert.notEqual(mapped.supplierCampaignId, "rakuten-advertiser-42");
    assert.equal(mapped.campaignName, "Example Advertiser");
    assert.equal(mapped.merchantNameRaw, "Example Advertiser");
  });

  it("registers Rakuten as a real campaign and conversion mapper surface", () => {
    assert.equal(hasJsMapper("RAKUTEN", "campaign"), true);
    assert.equal(hasJsMapper("RAKUTEN", "conversion"), true);
  });
});
