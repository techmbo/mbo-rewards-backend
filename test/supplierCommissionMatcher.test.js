import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSupplierCommissionMatchFacts,
  calculateExpectedSupplierCommission,
  evaluateSupplierCommissionRule,
  matchSupplierCommissionRule,
} from "../src/modules/commercial/supplierCommissionMatcher.js";

function rule(overrides = {}) {
  return {
    id: overrides.id ?? "rule-1",
    commissionSequence: overrides.commissionSequence ?? 1,
    basis: overrides.basis ?? "PERCENT_OF_SALE",
    ratePercent: overrides.ratePercent ?? 10,
    fixedAmount: overrides.fixedAmount ?? null,
    currency: overrides.currency ?? "USD",
    priority: overrides.priority ?? null,
    rank: overrides.rank ?? null,
    metadata: overrides.metadata ?? null,
    conditions: overrides.conditions ?? [],
  };
}

describe("Supplier Commission Matcher", () => {
  it("matches a specific country rule over a default", () => {
    const result = matchSupplierCommissionRule({
      rules: [
        rule({ id: "default", commissionSequence: 1, ratePercent: 5 }),
        rule({
          id: "ae",
          commissionSequence: 2,
          ratePercent: 12,
          conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }],
        }),
      ],
      facts: { country: "AE", orderValue: 100, currency: "USD" },
      actualCommission: 12,
      actualCurrency: "USD",
    });

    assert.equal(result.status, "MATCHED");
    assert.equal(result.matchedSupplierCommissionRuleId, "ae");
    assert.equal(result.matchedCommissionSequence, 2);
    assert.equal(result.expectedSupplierCommission, 12);
    assert.equal(result.comparisonStatus, "MATCH");
  });

  it("treats multiple same-dimension country conditions as alternatives", () => {
    const evaluated = evaluateSupplierCommissionRule(
      rule({
        conditions: [
          { conditionType: "COUNTRY", operator: "EQ", value: "AE" },
          { conditionType: "COUNTRY", operator: "EQ", value: "SA" },
          { conditionType: "COUNTRY", operator: "EQ", value: "KW" },
        ],
      }),
      { country: "SA" },
    );

    assert.equal(evaluated.state, "MATCH");
    assert.equal(evaluated.specificity, 1);
  });

  it("requires every different condition dimension to match", () => {
    const evaluated = evaluateSupplierCommissionRule(
      rule({
        conditions: [
          { conditionType: "COUNTRY", operator: "EQ", value: "AE" },
          { conditionType: "CATEGORY", operator: "EQ", value: "Shoes" },
          { conditionType: "CUSTOMER_TYPE", operator: "EQ", value: "NEW" },
        ],
      }),
      { country: "AE", category: "Shoes", customerType: "EXISTING" },
    );

    assert.equal(evaluated.state, "NO_MATCH");
    assert.equal(evaluated.specificity, 3);
  });

  it("fails closed instead of using default when a specific rule lacks transaction facts", () => {
    const result = matchSupplierCommissionRule({
      rules: [
        rule({ id: "default", ratePercent: 5 }),
        rule({
          id: "coupon-specific",
          ratePercent: 15,
          conditions: [{ conditionType: "COUPON", operator: "EQ", value: "VIP15" }],
        }),
      ],
      facts: { orderValue: 100, currency: "USD" },
      actualCommission: 5,
      actualCurrency: "USD",
    });

    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "specific_rule_missing_facts");
    assert.deepEqual(result.candidateRuleIds, ["coupon-specific"]);
  });

  it("chooses the most specific valid rule when no verified source precedence exists", () => {
    const result = matchSupplierCommissionRule({
      rules: [
        rule({
          id: "country",
          ratePercent: 8,
          conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }],
        }),
        rule({
          id: "country-category",
          ratePercent: 14,
          conditions: [
            { conditionType: "COUNTRY", operator: "EQ", value: "AE" },
            { conditionType: "CATEGORY", operator: "EQ", value: "Shoes" },
          ],
        }),
      ],
      facts: { country: "AE", category: "Shoes", orderValue: 200, currency: "USD" },
    });

    assert.equal(result.status, "MATCHED");
    assert.equal(result.matchedSupplierCommissionRuleId, "country-category");
    assert.equal(result.expectedSupplierCommission, 28);
  });

  it("returns REVIEW_REQUIRED when equal-specificity rules are ambiguous", () => {
    const result = matchSupplierCommissionRule({
      rules: [
        rule({
          id: "r1",
          conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }],
        }),
        rule({
          id: "r2",
          conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }],
        }),
      ],
      facts: { country: "AE", orderValue: 100 },
    });

    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "ambiguous_specific_rules");
  });

  it("uses source priority only when verified precedence semantics are present", () => {
    const metadata = {
      sourcePrecedenceVerified: true,
      sourcePrecedenceField: "priority",
      sourcePrecedenceDirection: "LOWER_FIRST",
    };
    const result = matchSupplierCommissionRule({
      rules: [
        rule({
          id: "priority-20",
          priority: 20,
          metadata,
          conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }],
        }),
        rule({
          id: "priority-10",
          priority: 10,
          metadata,
          ratePercent: 16,
          conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }],
        }),
      ],
      facts: { country: "AE", orderValue: 100, currency: "USD" },
    });

    assert.equal(result.status, "MATCHED");
    assert.equal(result.matchedSupplierCommissionRuleId, "priority-10");
    assert.equal(result.expectedSupplierCommission, 16);
  });

  it("calculates fixed-per-item expected supplier commission from quantity", () => {
    const expected = calculateExpectedSupplierCommission(
      rule({
        basis: "FIXED_PER_ITEM",
        ratePercent: null,
        fixedAmount: 2.5,
        currency: "USD",
      }),
      { quantity: 3, currency: "USD" },
    );

    assert.equal(expected.status, "CALCULATED");
    assert.equal(expected.amount, 7.5);
  });

  it("flags expected-vs-actual variance without replacing the network actual", () => {
    const result = matchSupplierCommissionRule({
      rules: [rule({ id: "percent", ratePercent: 10 })],
      facts: { orderValue: 100, currency: "USD" },
      actualCommission: 9.5,
      actualCurrency: "USD",
    });

    assert.equal(result.expectedSupplierCommission, 10);
    assert.equal(result.networkActualCommission, 9.5);
    assert.equal(result.variance, -0.5);
    assert.equal(result.comparisonStatus, "VARIANCE");
  });

  it("builds matcher facts from order/item/click evidence without inventing missing fields", () => {
    const facts = buildSupplierCommissionMatchFacts({
      order: { orderValue: "250", currency: "AED", orderDate: "2026-09-01T10:00:00Z" },
      item: { sku: "SKU-9", category: "Shoes", quantity: "2", itemValue: "100" },
      click: { country: "AE", device: "MOBILE" },
    });

    assert.equal(facts.country, "AE");
    assert.equal(facts.category, "Shoes");
    assert.equal(facts.sku, "SKU-9");
    assert.equal(facts.orderValue, "250");
    assert.equal(facts.commissionableValue, "100");
    assert.equal(facts.customerType, undefined);
  });
});
