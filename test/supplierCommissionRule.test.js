import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCampaignCommissionSummary,
  enrichSupplierCommissionRuleRecord,
  isOrderCommissionFact,
  toSupplierCommissionRuleDto,
} from "../src/modules/commercial/supplierCommissionRule.contract.js";
import {
  collectEmbeddedCommissionRulesFromCampaigns,
  extractCommissionRulesFromCampaignRaw,
} from "../src/modules/commercial/supplierCommissionRuleFanOut.js";
import { buildNetworkCampaignFields } from "../src/modules/ops/importedRecords.service.js";

describe("supplier commission rules (pointer 12)", () => {
  it("builds campaign commission summary with rule count", () => {
    const summary = buildCampaignCommissionSummary({
      grossCommission: 15,
      commissionUnit: "PERCENT",
      commissions: [
        { kind: "PERCENT", value: 10 },
        { kind: "PERCENT", value: 15 },
      ],
      ruleCount: 6,
    });
    assert.equal(summary, "Up to 15% · 6 rules");
  });

  it("fans out multiple anonymous commission groups into separate MBO outcomes without inventing source rule IDs", () => {
    const raw = {
      id: "camp-1",
      commissionGroup: {
        0: { commission: "8.20% Or $17.50" },
        1: { commission: "2.50% Or $1.20" },
      },
    };
    const rules = extractCommissionRulesFromCampaignRaw(raw);
    assert.equal(rules.length, 4);
    assert.equal(new Set(rules.map((r) => r.outcomeKey)).size, 4);
    assert.ok(rules.every((r) => r.sourceRuleId == null));
    assert.deepEqual(rules.map((r) => r.commissionSequence), [1, 2, 3, 4]);
  });

  it("fans out an explicit 0% payout group as its own SupplierCommissionRule outcome", () => {
    const raw = {
      id: "camp-zero",
      payouts: [
        { id: "g-default", model: "cps", value: 10 },
        { id: "g-excluded", model: "cps", value: 0, category: "Excluded Category X" },
      ],
    };
    const rules = extractCommissionRulesFromCampaignRaw(raw);
    assert.equal(rules.length, 2);
    const zero = rules.find((r) => r.ratePercent === 0);
    assert.ok(zero, "zero payout outcome must survive fan-out");
    assert.equal(zero.supplierRuleType, "PERCENT");
    assert.equal(zero.fixedAmount, null);
    assert.ok(rules.some((r) => r.ratePercent === 10));
    assert.equal(new Set(rules.map((r) => r.outcomeKey)).size, 2);
  });

  it("does not fan out a blank payout value as a zero rule", () => {
    const rules = extractCommissionRulesFromCampaignRaw({
      id: "camp-blank",
      payouts: [{ id: "g-blank", model: "cps", value: "" }, { id: "g-null", model: "cps", value: null }],
    });
    assert.equal(rules.length, 0);
  });

  it("collectEmbeddedCommissionRulesFromCampaigns merges campaigns without concatenating", () => {
    const all = collectEmbeddedCommissionRulesFromCampaigns([
      {
        rawData: {
          id: "c1",
          payouts: [{ model: "cps", value: 5 }],
        },
      },
      {
        rawData: {
          id: "c2",
          payouts: [{ model: "cps", value: 8 }],
        },
      },
    ]);
    assert.equal(all.length, 2);
  });

  it("enriches supplier commission rule records with mapping metadata", () => {
    const enriched = enrichSupplierCommissionRuleRecord(
      { ratePercent: 12, sourceRuleId: "rule-1" },
      { networkSource: "optimise_sea", sourcePath: "commissionGroups.0" },
    );
    assert.equal(enriched.networkSource, "optimise_sea");
    assert.equal(enriched.mappingStatus, "MAPPED");
    assert.equal(enriched.fieldMappingOutcome, "MAPPED");
  });

  it("toSupplierCommissionRuleDto exposes rule fields separately from order facts", () => {
    const dto = toSupplierCommissionRuleDto({
      id: "scr-1",
      supplier: "OPTIMISE",
      sourceRuleId: "opt-rule-99",
      supplierRuleType: "PERCENT",
      basis: "PERCENT_OF_SALE",
      ratePercent: 12.5,
      currency: "USD",
      customerType: "New Customer",
      country: "SG",
      categoryProductGoal: "All Products",
      sourceObject: "campaigns",
      sourcePath: "commissionGroups.0",
      mappingStatus: "MAPPED",
      fieldMappingOutcome: "MAPPED",
      ruleVersion: "SCR-1",
      supplierCampaign: {
        campaignName: "Brand Sale",
        merchantNameRaw: "Brand",
      },
    });
    assert.equal(dto.commissionValue, "12.5%");
    assert.equal(dto.sourceRuleId, "opt-rule-99");
    assert.match(dto.note, /not actual commission earned on orders/i);
    assert.equal(isOrderCommissionFact(dto), false);
  });

  it("buildNetworkCampaignFields uses summary display on campaign rows", () => {
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
    assert.equal(fields.commissions.length, 2);
  });
});
