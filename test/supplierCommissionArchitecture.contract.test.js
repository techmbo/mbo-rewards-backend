import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractCommissionRulesFromCampaignRaw } from "../src/modules/commercial/supplierCommissionRuleFanOut.js";
import { averageCommissionFacts } from "../src/modules/ops/campaignCommissions.js";

describe("MBO supplier commission architecture correction contract", () => {
  it("requires one source rule with percent OR fixed to fan out into two outcomes", () => {
    const rules = extractCommissionRulesFromCampaignRaw({
      id: "campaign-1",
      commission: {
        id: "rule-abc",
        type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value",
        value: "8.20% Or $17.50",
      },
    });

    assert.equal(rules.length, 2);
    assert.equal(new Set(rules.map((r) => r.outcomeKey)).size, 2);
    assert.deepEqual(rules.map((r) => r.sourceRuleId), ["rule-abc", "rule-abc"]);
  });

  it("keeps logical outcome identity stable when the supplier rate changes", () => {
    const before = extractCommissionRulesFromCampaignRaw({
      id: "campaign-history",
      commission: { id: "rule-history", type: "percentage", value: "10%" },
    });
    const after = extractCommissionRulesFromCampaignRaw({
      id: "campaign-history",
      commission: { id: "rule-history", type: "percentage", value: "12%" },
    });

    assert.equal(before.length, 1);
    assert.equal(after.length, 1);
    assert.equal(before[0].outcomeKey, after[0].outcomeKey);
    assert.equal(before[0].ratePercent, 10);
    assert.equal(after[0].ratePercent, 12);
  });

  it("propagates supplier campaign identity on every emitted commission outcome", () => {
    const rules = extractCommissionRulesFromCampaignRaw({
      CampaignId: "supplier-campaign-77",
      commission: {
        id: "rule-77",
        type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value",
        value: "8.20% Or $17.50",
      },
    });

    assert.equal(rules.length, 2);
    assert.deepEqual(rules.map((r) => r.sourceCampaignId), ["supplier-campaign-77", "supplier-campaign-77"]);
  });

  it("requires mixed percentage + fixed Avg Commission to be MIXED", () => {
    assert.equal(
      averageCommissionFacts([
        { kind: "PERCENT", value: 10, display: "10%", basis: "PERCENT_OF_SALE" },
        { kind: "FIXED", value: 20, currency: "USD", display: "USD 20", basis: "CPA" },
      ]),
      "MIXED",
    );
  });

  it("requires multiple source countries to remain represented", () => {
    const rules = extractCommissionRulesFromCampaignRaw({
      id: "campaign-2",
      commissions: [
        {
          id: "country-rule",
          type: "percentage",
          value: 12,
          countries: ["AE", "SA", "KW"],
        },
      ],
    });

    assert.equal(rules.length, 1);
    const countryConditions = (rules[0].conditions || []).filter((c) => c.conditionType === "COUNTRY");
    assert.deepEqual(countryConditions.map((c) => c.value), ["AE", "SA", "KW"]);
  });

  it("requires category + country + customer type to stay on one rule", () => {
    const rules = extractCommissionRulesFromCampaignRaw({
      id: "campaign-3",
      commissions: [
        {
          id: "multi-condition",
          type: "percentage",
          value: 15,
          category: "Shoes",
          country: "AE",
          customer_type: "NEW",
        },
      ],
    });

    assert.equal(rules.length, 1);
    const pairs = (rules[0].conditions || []).map((c) => [c.conditionType, c.value]);
    assert.deepEqual(pairs, [
      ["CATEGORY", "Shoes"],
      ["COUNTRY", "AE"],
      ["CUSTOMER_TYPE", "NEW"],
    ]);
  });
});
