import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapCjProgramTermsCommissionCandidates } from "../src/modules/commercial/cjProgramTerms.mapper.js";

describe("CJ Program Terms commission mapper", () => {
  it("maps unconditional PERCENT sale commission with verified higher-rank precedence", () => {
    const rules = mapCjProgramTermsCommissionCandidates({
      advertiserId: "12345",
      status: "ACTIVE",
      startTime: "2026-09-01T00:00:00Z",
      endTime: null,
      programTerms: {
        id: "pt-1",
        name: "Standard Terms",
        isDefault: true,
        actionTerms: [{
          id: "at-1",
          actionTracker: { id: "tracker-1", name: "Sale", type: "sim_sale" },
          commissions: [{
            rank: 10,
            rate: { type: "PERCENT", value: 7.5, currency: null },
            itemList: null,
            situation: null,
            promotionalProperties: [],
            isViewThrough: false,
          }],
        }],
      },
    });

    assert.equal(rules.length, 1);
    const rule = rules[0];
    assert.equal(rule.supplier, "CJ");
    assert.equal(rule.supplierCampaignId, "12345");
    assert.equal(rule.ratePercent, 7.5);
    assert.equal(rule.basis, "PERCENT_OF_SALE");
    assert.equal(rule.mappingStatus, "VERIFIED");
    assert.equal(rule.metadata.financeReady, true);
    assert.equal(rule.rank, 10);
    assert.equal(rule.metadata.sourcePrecedenceVerified, true);
    assert.equal(rule.metadata.sourcePrecedenceField, "RANK");
    assert.equal(rule.metadata.sourcePrecedenceDirection, "HIGHER_FIRST");
    assert.equal(rule.metadata.calculationGrain, "ORDER");
  });

  it("maps FIXED_PER_ORDER with explicit currency as finance-ready", () => {
    const [rule] = mapCjProgramTermsCommissionCandidates({
      advertiserId: "99",
      status: "ACTIVE",
      programTerms: {
        id: "pt-2",
        actionTerms: [{
          id: "at-2",
          actionTracker: { type: "lead" },
          commissions: [{
            rank: 1,
            rate: { type: "FIXED_PER_ORDER", value: 5, currency: "USD" },
          }],
        }],
      },
    });

    assert.equal(rule.fixedAmount, 5);
    assert.equal(rule.currency, "USD");
    assert.equal(rule.basis, "FIXED_PER_ORDER");
    assert.equal(rule.mappingStatus, "VERIFIED");
    assert.equal(rule.metadata.calculationGrain, "ORDER");
  });

  it("keeps item-list commissions review-required until transaction item-list facts are wired", () => {
    const [rule] = mapCjProgramTermsCommissionCandidates({
      advertiserId: "88",
      status: "ACTIVE",
      programTerms: {
        id: "pt-3",
        actionTerms: [{
          id: "at-3",
          actionTracker: { type: "item_sale" },
          commissions: [{
            rank: 20,
            rate: { type: "PERCENT", value: 12 },
            itemList: { id: "list-7", name: "Premium SKUs" },
          }],
        }],
      },
    });

    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(rule.metadata.financeReady, false);
    assert.equal(rule.conditions.length, 1);
    assert.equal(rule.conditions[0].sourceConditionType, "CJ_ITEM_LIST_ID");
    assert.equal(rule.conditions[0].metadata.matcherReady, false);
    assert.equal(rule.metadata.reviewReasons.includes("source_condition_fact_mapping_required"), true);
  });

  it("maps FIXED as fixed per item only for item-grained action trackers", () => {
    const [rule] = mapCjProgramTermsCommissionCandidates({
      advertiserId: "77",
      status: "ACTIVE",
      programTerms: {
        id: "pt-4",
        actionTerms: [{
          id: "at-4",
          actionTracker: { type: "item_sale" },
          commissions: [{
            rank: 2,
            rate: { type: "FIXED", value: 3.25, currency: "EUR" },
          }],
        }],
      },
    });

    assert.equal(rule.commissionType, "FIXED_PER_ITEM");
    assert.equal(rule.basis, "FIXED_PER_ITEM");
    assert.equal(rule.fixedAmount, 3.25);
    assert.equal(rule.currency, "EUR");
    assert.equal(rule.mappingStatus, "VERIFIED");
    assert.equal(rule.metadata.calculationGrain, "ITEM");
  });

  it("fails closed for unsupported action/rate combinations", () => {
    const [rule] = mapCjProgramTermsCommissionCandidates({
      advertiserId: "66",
      status: "ACTIVE",
      programTerms: {
        id: "pt-5",
        actionTerms: [{
          id: "at-5",
          actionTracker: { type: "custom_action" },
          commissions: [{
            rank: 1,
            rate: { type: "PERCENT", value: 4 },
          }],
        }],
      },
    });

    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(rule.basis, "UNKNOWN");
    assert.equal(rule.metadata.reviewReasons.includes("unsupported_cj_action_rate_combination"), true);
  });

  it("preserves performance incentives as review-required threshold outcomes", () => {
    const rules = mapCjProgramTermsCommissionCandidates({
      advertiserId: "55",
      status: "ACTIVE",
      programTerms: {
        id: "pt-6",
        actionTerms: [{
          id: "at-6",
          actionTracker: { type: "sim_sale" },
          commissions: [],
          performanceIncentives: [{
            threshold: { type: "TOTAL_SALES_AMOUNT", value: 10000 },
            reward: { type: "INCREASE_COMMISSION_TO", commissionType: "PERCENT", value: 10 },
            currency: "USD",
          }],
        }],
      },
    });

    assert.equal(rules.length, 1);
    const rule = rules[0];
    assert.equal(rule.supplierRuleType, "PERFORMANCE_INCENTIVE");
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(rule.conditions[0].conditionType, "PERFORMANCE_THRESHOLD");
    assert.equal(rule.metadata.financeReady, false);
  });
});
