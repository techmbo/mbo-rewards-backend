/**
 * Boostiny `business_category_label` — preserved on the promoted conversion as EVIDENCE ONLY.
 *
 * The raw order-level api_reports row carries `business_category_label`. Promotion copies it, for
 * Boostiny only, into conversion metadata as `businessCategoryLabel`, verbatim: no normalization,
 * no interpretation, null stays null, absent becomes null. The matcher does not read it, nothing
 * populates customFields["business-category"], and the Bloomingdales condition
 * `business-category equals FP` stays unverified and evaluates UNKNOWN exactly as before.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapEntityToConversionIngest } from "../src/modules/reporting/services/conversionPromotion.service.js";
import {
  buildSupplierCommissionMatchFacts,
  evaluateSupplierCommissionCondition,
} from "../src/modules/commercial/supplierCommissionMatcher.js";
import { mapBoostinyPayoutGroupCandidates } from "../src/modules/commercial/boostinyPayoutGroup.mapper.js";

const MATCHER_SRC = readFileSync(new URL("../src/modules/commercial/supplierCommissionMatcher.js", import.meta.url), "utf8");
const PROMOTION_SRC = readFileSync(new URL("../src/modules/reporting/services/conversionPromotion.service.js", import.meta.url), "utf8");

/** A Boostiny order-level row in the stored production shape (values synthetic). */
function boostinyEntity(rawExtra = {}, { networkSource = "boostiny", externalId = "boostiny-conversion-order-61-zzorderzz" } = {}) {
  return {
    id: "entity-zz",
    entityType: "conversion",
    networkSource,
    externalId,
    rawData: {
      order_id: "zzorderzz",
      campaign_id: 61,
      date: "2026-09-01",
      net_revenue: 1,
      net_sales_amount: 10,
      campaign_name: "zzcampaignzz",
      country: "SAU",
      ...rawExtra,
    },
    normalizedData: {},
  };
}

describe("promotion copies business_category_label verbatim, Boostiny only", () => {
  it('raw business_category_label: "FP" → metadata.businessCategoryLabel: "FP"', () => {
    const mapped = mapEntityToConversionIngest(boostinyEntity({ business_category_label: "FP" }));
    assert.equal(mapped.ok, true);
    assert.equal(mapped.input.metadata.businessCategoryLabel, "FP");
    assert.equal(mapped.input.metadata.country, "SAU", "country evidence unchanged");
  });

  it("null → null", () => {
    const mapped = mapEntityToConversionIngest(boostinyEntity({ business_category_label: null }));
    assert.equal(mapped.ok, true);
    assert.ok(Object.hasOwn(mapped.input.metadata, "businessCategoryLabel"), "key present so null is an observed null");
    assert.equal(mapped.input.metadata.businessCategoryLabel, null);
  });

  it("absent → null", () => {
    const mapped = mapEntityToConversionIngest(boostinyEntity());
    assert.equal(mapped.ok, true);
    assert.equal(mapped.input.metadata.businessCategoryLabel, null);
  });

  it("is verbatim: whitespace, case and unknown tokens are preserved, never normalized or mapped", () => {
    for (const value of [" fp ", "fp", "Full Price", "zzunknownzz", "0", 7]) {
      const mapped = mapEntityToConversionIngest(boostinyEntity({ business_category_label: value }));
      assert.equal(mapped.input.metadata.businessCategoryLabel, value, JSON.stringify(value));
    }
  });

  it("is not read from any other key and is Boostiny-only", () => {
    const aliasOnly = mapEntityToConversionIngest(boostinyEntity({ businessCategory: "FP", business_category: "FP", business_category_label_x: "FP" }));
    assert.equal(aliasOnly.input.metadata.businessCategoryLabel, null, "only the exact supplier key is read");
    const trackier = mapEntityToConversionIngest(
      boostinyEntity({ business_category_label: "FP", click_id: "zzclickzz", id: "zzconvzz" }, { networkSource: "trackier", externalId: "trackier-conversion-zzconvzz" }),
    );
    assert.equal(trackier.ok, true);
    assert.ok(!Object.hasOwn(trackier.input.metadata, "businessCategoryLabel"), "another network's metadata gains no key");
  });

  it("no meaning is attached in code: no expansion of FP anywhere in the promotion path", () => {
    assert.ok(!/full[\s_-]?price/i.test(PROMOTION_SRC));
    assert.match(PROMOTION_SRC, /businessCategoryLabel: raw\.business_category_label \?\? null/);
  });
});

describe("matcher behaviour is unchanged", () => {
  const conversion = { currency: "USD", metadata: { country: "SAU", businessCategoryLabel: "FP" } };

  it("the fact builder ignores businessCategoryLabel and leaves customFields empty", () => {
    const facts = buildSupplierCommissionMatchFacts({ conversion });
    assert.deepEqual(facts.customFields, {});
    assert.equal(facts.country, "SAU");
    assert.ok(!("businessCategoryLabel" in facts) && !("businessCategory" in facts));
    assert.ok(!MATCHER_SRC.includes("businessCategoryLabel") && !MATCHER_SRC.includes("business-category"), "matcher never references it");
  });

  it("the Bloomingdales FP condition still evaluates UNKNOWN (missing fact), never MATCH or NO_MATCH", () => {
    const raw = {
      id: 61, payouts: [{ level: "default", model: "cps", start_date: "2026-06-11T00:00:00.000000Z", end_date: "2026-12-31T00:00:00.000000Z", groups: [
        { id: 74018, type: "sale-share", value: 2.5, priority: 2, conditions: [
          { value: ["SAU"], dimension: "country", operation: "contains" },
          { value: "FP", dimension: "business-category", operation: "equals" },
        ] },
      ] }],
    };
    const [rule] = mapBoostinyPayoutGroupCandidates(raw, { networkSource: "boostiny", sourceAccountLabel: "default", supplierCampaignId: "61" });
    const fp = rule.conditions.find((c) => c.sourceConditionType === "business-category");
    assert.equal(fp.metadata.matcherReady, false, "still unverified");
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    const facts = buildSupplierCommissionMatchFacts({ conversion });
    assert.deepEqual(evaluateSupplierCommissionCondition(fp, facts), { state: "UNKNOWN", reason: "missing_fact:OTHER_SOURCE_CONDITION" });
    const country = rule.conditions.find((c) => c.conditionType === "COUNTRY");
    assert.deepEqual(evaluateSupplierCommissionCondition(country, facts), { state: "MATCH" });
  });
});
