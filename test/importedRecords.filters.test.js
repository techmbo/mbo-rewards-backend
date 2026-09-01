import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  campaignStatusToDb,
  relationshipStatusToDb,
  countryFilterValue,
  campaignTypeWhere,
  campaignStatusFacetOptions,
  relationshipFacetOptions,
  campaignTypeFacetOptions,
  networkFacetOptions,
  resolveDisplayedCampaignStatus,
} from "../src/modules/ops/importedRecords.filters.js";

describe("imported record filter mapping", () => {
  it("maps list campaignStatus onto Prisma enums without Inactive→Retired", () => {
    assert.deepEqual(campaignStatusToDb("ACTIVE"), ["ACTIVE"]);
    assert.deepEqual(campaignStatusToDb("Expired"), ["RETIRED"]);
    assert.deepEqual(campaignStatusToDb("PAUSED"), ["PAUSED"]);
    assert.deepEqual(campaignStatusToDb("PENDING"), ["PENDING"]);
    assert.deepEqual(campaignStatusToDb("INACTIVE"), []);
    assert.deepEqual(campaignStatusToDb("bogus"), []);
  });

  it("maps relationship list values onto stored participation enums", () => {
    assert.deepEqual(relationshipStatusToDb("JOINED"), ["JOINED"]);
    assert.deepEqual(relationshipStatusToDb("APPROVED"), ["JOINED"]);
    assert.deepEqual(relationshipStatusToDb("NOT_JOINED"), ["NOT_JOINED"]);
    assert.deepEqual(relationshipStatusToDb("REJECTED"), ["NOT_JOINED"]);
  });

  it("keeps full country facet values instead of slicing UAE to UA", () => {
    assert.equal(countryFilterValue("AE"), "AE");
    assert.equal(countryFilterValue("UAE"), "UAE");
  });

  it("matches campaign type against mapped commercial model and pricingModel", () => {
    const where = campaignTypeWhere("CPS");
    assert.equal(where.supplierCampaigns.some.OR.some((clause) => clause.pricingModel === "CPS"), true);
    assert.equal(
      where.supplierCampaigns.some.OR.some((clause) => clause.campaignType?.contains === "CPS"),
      true,
    );
  });

  it("exposes facet options using the same mapped field values as the list", () => {
    const statuses = campaignStatusFacetOptions(["ACTIVE", "RETIRED", "PAUSED", "ACTIVE", "UNKNOWN"]);
    assert.deepEqual(
      statuses.map((o) => o.value),
      ["ACTIVE", "PAUSED", "EXPIRED"],
    );
    assert.equal(statuses.some((o) => o.value === "UNKNOWN"), false);

    assert.equal(
      resolveDisplayedCampaignStatus({
        stored: "UNKNOWN",
        raw: { status: "notapplied" },
        networkSource: "optimise_sea",
      }),
      "NOTAPPLIED",
    );
    assert.equal(
      resolveDisplayedCampaignStatus({
        stored: "ACTIVE",
        raw: { status: "live" },
        networkSource: "optimise_sea",
      }),
      "ACTIVE",
    );
    assert.equal(
      resolveDisplayedCampaignStatus({
        stored: "UNKNOWN",
        raw: {},
        networkSource: "boostiny",
      }),
      null,
    );
    assert.equal(statuses.find((o) => o.value === "EXPIRED").label, "Expired");

    const rels = relationshipFacetOptions(["JOINED", "PENDING", "NOT_JOINED"]);
    assert.deepEqual(
      rels.map((o) => o.value),
      ["JOINED", "PENDING", "NOT_JOINED"],
    );

    const types = campaignTypeFacetOptions(["CPS - Taiwan", "CPA"], ["CPS"]);
    assert.ok(types.some((o) => o.value === "CPS"));
    assert.ok(types.some((o) => o.value === "CPA"));

    const networks = networkFacetOptions(["optimise_sea", "optimise_mena", "awin"]);
    assert.deepEqual(
      networks.map((o) => o.value),
      ["awin", "optimise"],
    );
  });
});
