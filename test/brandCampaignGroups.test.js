import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupCampaignRowsByBrand } from "../src/modules/ops/brandCampaignGroups.js";

describe("network ops brand commission blocks", () => {
  it("puts every commission for one brand into a single row", () => {
    const grouped = groupCampaignRowsByBrand([
      {
        id: "1",
        brand: "Wingontravel",
        sourceAdvertiserName: "Wingontravel",
        networkSource: "optimise_sea",
        campaign: "Flights",
        commissions: [{ kind: "PERCENT", value: 0.85, display: "0.85%" }],
        networkTrackingLink: null,
        lastUpdated: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "2",
        brand: "Wingontravel",
        sourceAdvertiserName: "Wingontravel",
        networkSource: "optimise_sea",
        campaign: "Packages",
        commissions: [{ kind: "PERCENT", value: 4.25, display: "4.25%" }],
        networkTrackingLink: "https://example.com/track",
        lastUpdated: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "3",
        brand: "AliExpress",
        sourceAdvertiserName: "AliExpress",
        networkSource: "optimise_sea",
        campaign: "CPS",
        commissions: [{ kind: "PERCENT", value: 6.75, display: "Up to 6.75%" }],
        lastUpdated: "2026-07-01T00:00:00.000Z",
      },
    ]);

    assert.equal(grouped.length, 2);
    const wingon = grouped.find((row) => row.brand === "Wingontravel");
    assert.equal(wingon.groupedCampaignCount, 2);
    assert.deepEqual(
      wingon.commissions.map((f) => f.display),
      ["0.85%", "4.25%"],
    );
    assert.deepEqual(wingon.campaignNames, ["Flights", "Packages"]);
    assert.equal(wingon.commissionAverageDisplay, "2.55%");
    assert.equal(wingon.networkTrackingLink, "https://example.com/track");
  });

  it("keeps percent and currency as separate commissions inside the brand block", () => {
    const grouped = groupCampaignRowsByBrand([
      {
        id: "4",
        brand: "FairPrice Online",
        sourceAdvertiserName: "FairPrice Online",
        networkSource: "optimise_sea",
        campaign: "CPS - Existing user",
        commissions: [
          { kind: "PERCENT", value: 0.49, display: "0.49%" },
          { kind: "FIXED", value: 4.95, currency: "SGD", display: "SGD 4.95" },
        ],
        lastUpdated: "2026-09-01T00:00:00.000Z",
      },
    ]);
    assert.equal(grouped[0].commissions.length, 2);
    assert.equal(grouped[0].commissionDisplay, "0.49% · SGD 4.95");
  });

  it("keeps one commission line per campaign even when the rate matches", () => {
    const grouped = groupCampaignRowsByBrand([
      {
        id: "a",
        brand: "American Eagle",
        sourceAdvertiserName: "American Eagle",
        networkSource: "optimise_sea",
        campaign: "CPS - TW",
        commissions: [{ kind: "PERCENT", value: 5.6, display: "5.6%" }],
        lastUpdated: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "b",
        brand: "American Eagle",
        sourceAdvertiserName: "American Eagle",
        networkSource: "optimise_sea",
        campaign: "CPS - MY",
        commissions: [{ kind: "PERCENT", value: 5.6, display: "5.6%" }],
        lastUpdated: "2026-08-01T00:00:00.000Z",
      },
    ]);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].commissionOperations.length, 2);
    assert.deepEqual(
      grouped[0].commissions.map((f) => f.display),
      ["5.6%", "5.6%"],
    );
    assert.deepEqual(
      grouped[0].commissionOperations.map((op) => op.campaign),
      ["CPS - TW", "CPS - MY"],
    );
    assert.equal(grouped[0].groupedCampaignCount, 2);
  });
});
