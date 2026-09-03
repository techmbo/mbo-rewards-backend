import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSupplierCommissionMatchFacts,
  calculateExpectedSupplierCommission,
  evaluateSupplierCommissionCondition,
  evaluateSupplierCommissionRule,
  matchSupplierCommissionRule,
} from "../src/modules/commercial/supplierCommissionMatcher.js";

function rule(overrides = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
  return {
    id: overrides.id ?? "rule-1",
    commissionSequence: overrides.commissionSequence ?? 1,
    basis: overrides.basis ?? "PERCENT_OF_SALE",
    ratePercent: has("ratePercent") ? overrides.ratePercent : 10,
    fixedAmount: has("fixedAmount") ? overrides.fixedAmount : null,
    currency: has("currency") ? overrides.currency : "USD",
    priority: has("priority") ? overrides.priority : null,
    rank: has("rank") ? overrides.rank : null,
    metadata: has("metadata") ? overrides.metadata : null,
    conditions: has("conditions") ? overrides.conditions : [],
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

  it("matches DATE ranges chronologically", () => {
    const afterStart = evaluateSupplierCommissionCondition(
      { conditionType: "DATE", operator: "GTE", value: "2026-09-01T00:00:00Z" },
      { date: "2026-09-02T12:00:00Z" },
    );
    const inWindow = evaluateSupplierCommissionCondition(
      {
        conditionType: "DATE",
        operator: "BETWEEN",
        value: "unused",
        sourceConditionValue: ["2026-09-01T00:00:00Z", "2026-09-30T23:59:59Z"],
      },
      { date: "2026-09-15T10:00:00Z" },
    );

    assert.equal(afterStart.state, "MATCH");
    assert.equal(inWindow.state, "MATCH");
  });

  it("returns UNKNOWN for invalid DATE comparison instead of numeric guessing", () => {
    const evaluated = evaluateSupplierCommissionCondition(
      { conditionType: "DATE", operator: "GTE", value: "not-a-date" },
      { date: "2026-09-02T12:00:00Z" },
    );
    assert.equal(evaluated.state, "UNKNOWN");
    assert.equal(evaluated.reason, "invalid_date_comparison:DATE");
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

  it("uses order value for percentage when no competing item financial value exists", () => {
    const expected = calculateExpectedSupplierCommission(
      rule({ ratePercent: 10 }),
      { orderValue: 200, currency: "USD" },
    );
    assert.equal(expected.status, "CALCULATED");
    assert.equal(expected.amount, 20);
    assert.equal(expected.calculationGrain, "ORDER");
  });

  it("requires verified calculation grain when order and item values compete", () => {
    const result = matchSupplierCommissionRule({
      rules: [rule({ id: "percent", ratePercent: 10 })],
      facts: { orderValue: 200, itemValue: 80, currency: "USD" },
      actualCommission: 8,
      actualCurrency: "USD",
    });

    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.expectedCalculationStatus, "SOURCE_DATA_MISSING");
    assert.equal(result.expectedCalculationReason, "ambiguous_commission_grain");
  });

  it("uses item value when supplier calculation grain is explicitly verified", () => {
    const expected = calculateExpectedSupplierCommission(
      rule({
        ratePercent: 10,
        metadata: { calculationGrain: "ITEM" },
      }),
      { orderValue: 200, itemValue: 80, currency: "USD" },
    );

    assert.equal(expected.status, "CALCULATED");
    assert.equal(expected.amount, 8);
    assert.equal(expected.calculationGrain, "ITEM");
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

  it("builds matcher facts without automatically promoting item value to commissionable value", () => {
    const facts = buildSupplierCommissionMatchFacts({
      order: { orderValue: "250", currency: "AED", orderDate: "2026-09-01T10:00:00Z" },
      item: { sku: "SKU-9", category: "Shoes", quantity: "2", itemValue: "100" },
      click: { country: "AE", device: "MOBILE" },
    });

    assert.equal(facts.country, "AE");
    assert.equal(facts.category, "Shoes");
    assert.equal(facts.sku, "SKU-9");
    assert.equal(facts.orderValue, "250");
    assert.equal(facts.itemValue, "100");
    assert.equal(facts.commissionableValue, undefined);
    assert.equal(facts.customerType, undefined);
  });

  describe("explicit zero supplier commission is a valid matching outcome", () => {
    it("selects the specific 0% category rule over the broader positive default", () => {
      const result = matchSupplierCommissionRule({
        rules: [
          rule({ id: "rule-a-default", commissionSequence: 1, ratePercent: 10 }),
          rule({
            id: "rule-b-category-x",
            commissionSequence: 2,
            ratePercent: 0,
            conditions: [{ conditionType: "CATEGORY", operator: "EQ", value: "X" }],
          }),
        ],
        facts: { category: "X", orderValue: 250, currency: "USD" },
        actualCommission: 0,
        actualCurrency: "USD",
      });

      assert.equal(result.status, "MATCHED");
      assert.equal(result.matchedSupplierCommissionRuleId, "rule-b-category-x");
      assert.equal(result.matchedCommissionSequence, 2);
      assert.equal(result.expectedSupplierCommission, 0);
      assert.notEqual(result.expectedSupplierCommission, 25);
      assert.equal(result.networkActualCommission, 0);
      assert.equal(result.comparisonStatus, "MATCH");
    });

    it("keeps the default rule for orders outside the zero category", () => {
      const result = matchSupplierCommissionRule({
        rules: [
          rule({ id: "rule-a-default", commissionSequence: 1, ratePercent: 10 }),
          rule({
            id: "rule-b-category-x",
            commissionSequence: 2,
            ratePercent: 0,
            conditions: [{ conditionType: "CATEGORY", operator: "EQ", value: "X" }],
          }),
        ],
        facts: { category: "Y", orderValue: 250, currency: "USD" },
      });

      assert.equal(result.status, "MATCHED");
      assert.equal(result.matchedSupplierCommissionRuleId, "rule-a-default");
      assert.equal(result.expectedSupplierCommission, 25);
    });

    it("calculates an explicit zero percentage rule as 0 instead of missing data", () => {
      const expected = calculateExpectedSupplierCommission(rule({ ratePercent: 0 }), {
        orderValue: 100,
        currency: "USD",
      });
      assert.equal(expected.status, "CALCULATED");
      assert.equal(expected.amount, 0);
      assert.equal(expected.ratePercent, 0);
    });

    it("calculates an explicit fixed zero rule as 0 instead of missing data", () => {
      const expected = calculateExpectedSupplierCommission(
        rule({ ratePercent: null, fixedAmount: 0, basis: "FIXED_PER_ORDER", currency: "USD" }),
        { orderValue: 100, currency: "USD" },
      );
      assert.equal(expected.status, "CALCULATED");
      assert.equal(expected.amount, 0);
      assert.equal(expected.currency, "USD");
    });

    it("still treats a blank rate as missing rule data", () => {
      const expected = calculateExpectedSupplierCommission(
        rule({ ratePercent: "", fixedAmount: "   ", basis: "FIXED_PER_ORDER" }),
        { orderValue: 100, currency: "USD" },
      );
      assert.equal(expected.status, "SOURCE_DATA_MISSING");
      assert.equal(expected.reason, "missing_rule_amount");
    });

    it("reports variance when the network pays for an excluded 0% category", () => {
      const result = matchSupplierCommissionRule({
        rules: [
          rule({
            id: "rule-b-category-x",
            ratePercent: 0,
            conditions: [{ conditionType: "CATEGORY", operator: "EQ", value: "X" }],
          }),
        ],
        facts: { category: "X", orderValue: 100, currency: "USD" },
        actualCommission: 4,
        actualCurrency: "USD",
      });
      assert.equal(result.expectedSupplierCommission, 0);
      assert.equal(result.networkActualCommission, 4);
      assert.equal(result.variance, 4);
      assert.equal(result.comparisonStatus, "VARIANCE");
    });
  });
});
