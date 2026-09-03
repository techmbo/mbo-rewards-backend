import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapRakutenOfferCommissionCandidates } from "../src/modules/commercial/rakutenOfferCommission.mapper.js";

describe("Rakuten offer commission mapper", () => {
  it("maps an unconditional single-tier sale commission as a verified percentage outcome", () => {
    const [rule] = mapRakutenOfferCommissionCandidates({
      advertiser: { id: 42 },
      goid: 1001,
      name: "Baseline Offer",
      status: "active",
      start_datetime: "2026-09-01T00:00:00Z",
      offer_rules: [
        {
          oid: 9001,
          is_base_commission: true,
          is_dynamic: false,
          commissions: [
            {
              commission_type: "sale",
              description: "3% Base Commission",
              dynamic_rules: null,
              tiers: [{ commission: 3, threshold: 0, upper_threshold: null }],
            },
          ],
        },
      ],
    });

    assert.equal(rule.supplier, "RAKUTEN");
    assert.equal(rule.supplierCampaignId, "42");
    assert.equal(rule.sourceGroupId, "1001");
    assert.equal(rule.sourceRuleId, "9001");
    assert.equal(rule.ratePercent, 3);
    assert.equal(rule.fixedAmount, null);
    assert.equal(rule.basis, "PERCENT_OF_SALE");
    assert.equal(rule.mappingStatus, "VERIFIED");
    assert.equal(rule.metadata.financeReady, true);
    assert.deepEqual(rule.conditions, []);
  });

  it("keeps tiered sale boundaries as source evidence until transaction-fact semantics are wired", () => {
    const rules = mapRakutenOfferCommissionCandidates({
      advertiser: { id: 42 },
      goid: 1001,
      offer_rules: [
        {
          oid: 9001,
          commissions: [
            {
              commission_type: "sale",
              tiers: [
                { commission: 3, threshold: 0, upper_threshold: 2 },
                { commission: 6, threshold: 2, upper_threshold: 3 },
                { commission: 7, threshold: 3, upper_threshold: null },
              ],
            },
          ],
        },
      ],
    });

    assert.equal(rules.length, 3);
    assert.equal(new Set(rules.map((rule) => rule.outcomeKey)).size, 3);
    for (const rule of rules) {
      assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
      assert.equal(rule.metadata.financeReady, false);
      assert.equal(rule.conditions.some((condition) => condition.conditionType === "COMMISSION_TIER"), true);
      assert.equal(rule.metadata.reviewReasons.includes("tier_boundary_fact_mapping_required"), true);
    }
  });

  it("preserves dynamic source fields without pretending they are canonical transaction facts", () => {
    const [rule] = mapRakutenOfferCommissionCandidates({
      advertiser: { id: 42 },
      goid: 1002,
      offer_rules: [
        {
          oid: 9002,
          is_dynamic: true,
          commissions: [
            {
              commission_type: "sale",
              tiers: [{ commission: 5, threshold: 0, upper_threshold: null }],
              dynamic_rules: [
                {
                  transaction_field_id: 3,
                  transaction_field_name: "Customer Status",
                  operation: "EQUAL",
                  operand: "NEW",
                },
              ],
            },
          ],
        },
      ],
    });

    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(rule.conditions.length, 1);
    assert.equal(rule.conditions[0].conditionType, "OTHER_SOURCE_CONDITION");
    assert.equal(rule.conditions[0].metadata.transactionFieldName, "Customer Status");
    assert.equal(rule.conditions[0].metadata.matcherReady, false);
    assert.equal(rule.metadata.reviewReasons.includes("dynamic_transaction_field_mapping_required"), true);
  });

  it("does not mark fixed commission finance-ready when the offer response has no verified currency", () => {
    const [rule] = mapRakutenOfferCommissionCandidates({
      advertiser: { id: 42 },
      goid: 1003,
      offer_rules: [
        {
          oid: 9003,
          commissions: [
            {
              commission_type: "flat",
              tiers: [{ commission: 2, threshold: 0, upper_threshold: null }],
            },
          ],
        },
      ],
    });

    assert.equal(rule.fixedAmount, 2);
    assert.equal(rule.currency, null);
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(rule.metadata.reviewReasons.includes("fixed_payout_currency_missing"), true);
  });

  it("can carry a separately verified currency without parsing it from a description string", () => {
    const [rule] = mapRakutenOfferCommissionCandidates(
      {
        advertiser: { id: 42 },
        goid: 1004,
        offer_rules: [
          {
            oid: 9004,
            commissions: [
              {
                commission_type: "flat",
                description: "$2.00 Base Commission",
                tiers: [{ commission: 2, threshold: 0, upper_threshold: null }],
              },
            ],
          },
        ],
      },
      { currency: "USD" },
    );

    assert.equal(rule.currency, "USD");
    assert.equal(rule.fixedAmount, 2);
    assert.equal(rule.metadata.reviewReasons.includes("fixed_payout_currency_missing"), false);
    // Flat per action-or-item grain is still not finance-ready until that source grain is verified.
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
  });
});
