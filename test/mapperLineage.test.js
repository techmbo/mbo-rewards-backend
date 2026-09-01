import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCampaignBaseFromEntity, extractCountryCodesFromRaw, extractCommissionValueFromRaw } from "../src/modules/supplier/mappers/shared.js";

describe("mapper lineage fields", () => {
  it("maps firstSeenAt, adminOverrides, and lastSyncedData lineage", () => {
    const entity = {
      id: "entity-1",
      externalId: "boostiny-campaign-42",
      networkSource: "boostiny",
      entityType: "campaign",
      entityName: "Sale",
      campaignName: "Sale",
      advertiserName: "Brand",
      entityStatus: "Active",
      entitySubType: null,
      commission: null,
      eventDate: null,
      createdAt: new Date("2025-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      isManual: true,
      manualData: { campaignName: "Manual Name" },
      lastSyncedData: { campaignName: "Synced Name" },
      normalizedData: { name: "Sale" },
      rawData: { id: 42, name: "Sale", status: "active" },
      hasSyncConflict: true,
      fieldPolicies: { campaignName: "manual" },
    };

    const mapped = buildCampaignBaseFromEntity(entity);

    assert.equal(mapped.firstSeenAt.toISOString(), entity.createdAt.toISOString());
    assert.deepEqual(mapped.adminOverrides, { campaignName: "Manual Name" });
    assert.equal(mapped.normalizedPayload._mboLineage.lastSyncedData.campaignName, "Synced Name");
    assert.equal(mapped.normalizedPayload._mboLineage.isManual, true);
    assert.equal(mapped.mapperVersion, "1.1.1");
  });

  it("extracts Optimise markets and Boostiny targetCountries", () => {
    assert.deepEqual(
      extractCountryCodesFromRaw({ markets: [{ iso: "AE" }, { countryCode: "sa" }] }),
      ["AE", "SA"],
    );
    assert.deepEqual(
      extractCountryCodesFromRaw({
        targetCountries: [{ name: "United Arab Emirates", iso: "AE" }],
      }),
      ["AE"],
    );
    assert.deepEqual(extractCountryCodesFromRaw({ geo: "IN,AE" }), ["IN", "AE"]);
    assert.deepEqual(extractCountryCodesFromRaw({}), []);
  });

  it("extracts commission from percent strings and nested payout objects", () => {
    assert.equal(extractCommissionValueFromRaw({ commissionCost: "12.50%" }), "12.50");
    assert.equal(extractCommissionValueFromRaw({ payout: { amount: 8 } }), "8");
    assert.equal(extractCommissionValueFromRaw({ payouts: [{ value: "5.5" }] }), "5.5");
    assert.equal(extractCommissionValueFromRaw({}), null);
  });
});
