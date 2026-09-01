import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  listCampaignCommissionFacts,
  parseCommissionText,
  averageCommissionFacts,
} from "../src/modules/ops/campaignCommissions.js";
import { buildNetworkCampaignFields } from "../src/modules/ops/importedRecords.service.js";

describe("network ops campaign commissions", () => {
  it("splits Optimise percent-or-currency strings into both commissions", () => {
    assert.deepEqual(
      parseCommissionText("8.20% Or $17.50").map((f) => f.display),
      ["8.2%", "USD 17.5"],
    );
    assert.deepEqual(
      parseCommissionText("Up to 5.40% Or Rp80000.00").map((f) => f.display),
      ["Up to 5.4%", "IDR 80000"],
    );
    assert.deepEqual(
      parseCommissionText("2.50% Or $1.20").map((f) => f.display),
      ["2.5%", "USD 1.2"],
    );
    assert.deepEqual(
      parseCommissionText("0.49% Or S$4.95").map((f) => f.display),
      ["0.49%", "SGD 4.95"],
    );
  });

  it("reads Optimise { type, value } as every percent and currency amount", () => {
    const { facts, display } = listCampaignCommissionFacts({
      raw: {
        commission: {
          type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value",
          value: "8.20% Or $17.50",
        },
      },
    });
    assert.equal(display, "8.2% · USD 17.5");
    assert.equal(facts.length, 2);
    assert.equal(facts[0].kind, "PERCENT");
    assert.equal(facts[1].kind, "FIXED");
    assert.equal(JSON.stringify(facts).includes("[object Object]"), false);
  });

  it("expands every Boostiny payout group on one campaign", () => {
    const { facts, display } = listCampaignCommissionFacts({
      groups: [
        {
          model: "cps",
          groups: [
            { id: 74018, type: "sale-share", value: 2.5, priority: 2 },
            { id: 74017, type: "sale-share", value: 5, priority: 1 },
          ],
        },
      ],
    });
    assert.ok(display.includes("2.5%"));
    assert.ok(display.includes("5%"));
    assert.equal(facts.length, 2);
  });

  it("expands every Optimise commissionGroup on one campaign", () => {
    const { facts, display } = listCampaignCommissionFacts({
      raw: {
        commissionGroup: {
          0: { commission: "8.20% Or $17.50" },
          1: { commission: "2.50% Or $1.20" },
        },
      },
    });
    assert.ok(display.includes("8.2%"));
    assert.ok(display.includes("USD 17.5"));
    assert.ok(display.includes("2.5%"));
    assert.ok(display.includes("USD 1.2"));
    assert.equal(facts.length, 4);
  });

  it("reads a group whose commission field is a nested { type, value } object", () => {
    const { facts, display } = listCampaignCommissionFacts({
      groups: [
        {
          commission: {
            type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value",
            value: "Up to 5.40% Or Rp80000.00",
          },
        },
      ],
    });
    assert.equal(display, "Up to 5.4% · IDR 80000");
    assert.equal(facts.length, 2);
  });

  it("unions stored groups with raw payouts instead of stopping at the first bag", () => {
    const { facts } = listCampaignCommissionFacts({
      groups: [{ performance_value: "6.75", performance_model: "percentage" }],
      raw: {
        payouts: [{ model: "cpa", value: 10, currency: "AED" }],
      },
    });
    assert.equal(facts.some((f) => f.kind === "PERCENT" && f.value === 6.75), true);
    assert.equal(facts.some((f) => f.kind === "FIXED" && f.value === 10), true);
  });

  it("projects both commissions onto an imported Optimise campaign row", () => {
    const fields = buildNetworkCampaignFields({
      entity: {
        entityType: "campaign",
        networkSource: "optimise_sea",
        rawData: {
          commission: {
            type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value",
            value: "8.20% Or $17.50",
          },
        },
        rawPayloads: [],
        mapperErrors: [],
      },
      supplierCampaign: {
        campaignName: "Zalora",
        commissionUnit: "PERCENT",
        defaultCommissionValue: 8.2,
        campaignSources: [{ id: "cs-1", relationshipStatus: "JOINED", supportsLink: true }],
      },
      campaignSource: { id: "cs-1", relationshipStatus: "JOINED", supportsLink: true },
      merchant: null,
      statuses: { mappingStatus: "MAPPED" },
    });
    assert.equal(fields.commissionFactsDisplay, "8.2% · USD 17.5");
    assert.equal(fields.commissionDisplay, "Up to 8.2% · 2 rules");
    assert.equal(fields.commissionAverageDisplay, "8.2% · USD 17.5");
    assert.equal(fields.commissions.length, 2);
    assert.equal(typeof fields.commissionDisplay, "string");
  });

  it("averages percent commissions without mixing in currency amounts", () => {
    assert.equal(
      averageCommissionFacts([
        { kind: "PERCENT", value: 0.85, display: "0.85%" },
        { kind: "PERCENT", value: 4.25, display: "4.25%" },
      ]),
      "2.55%",
    );
    assert.equal(
      averageCommissionFacts([
        { kind: "PERCENT", value: 0.49, display: "0.49%" },
        { kind: "FIXED", value: 4.95, currency: "SGD", display: "SGD 4.95" },
      ]),
      "0.49% · SGD 4.95",
    );
    assert.equal(
      averageCommissionFacts([
        { kind: "PERCENT", value: 5.6, display: "5.6%" },
        { kind: "PERCENT", value: 5.6, display: "5.6%" },
      ]),
      "5.6%",
    );
  });
});
