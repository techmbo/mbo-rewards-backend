/**
 * Boostiny group.conditions normalization — the production Bloomingdales shape.
 *
 * Boostiny states a condition as { dimension, operation, value }. The shared normalizer reads
 * type/name/field and operator/op, so without adaptation every Boostiny condition collapsed into
 * OTHER_SOURCE_CONDITION / EQ with sourceConditionType "conditions". These tests pin the adapted
 * behaviour against the exact stored payload for supplier campaign 61, and prove that nothing
 * else about the candidates (identity, value, dates, priority, count, review gate) moved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BOOSTINY_VERIFY_LIVE_GATE,
  adaptBoostinyCondition,
  mapBoostinyPayoutGroupCandidates,
} from "../src/modules/commercial/boostinyPayoutGroup.mapper.js";
import { assessSupplierCommissionReadiness } from "../src/modules/commercial/supplierCommissionReadiness.js";

const MAPPER_SRC = readFileSync(new URL("../src/modules/commercial/boostinyPayoutGroup.mapper.js", import.meta.url), "utf8");
const REASON = "boostiny_condition_semantics_not_verified_live";

/** Exact stored production payload shape for Bloomingdales (supplier campaign 61). */
function bloomingdales() {
  return {
    id: 61,
    name: "Bloomingdales",
    payouts: [
      {
        level: "default",
        model: "cps",
        groups: [
          {
            id: 74018,
            type: "sale-share",
            value: 2.5,
            capping: null,
            priority: 2,
            conditions: [
              { value: ["SAU"], dimension: "country", operation: "contains" },
              { value: "FP", dimension: "business-category", operation: "equals" },
            ],
            product_categories: null,
          },
          {
            id: 74017,
            type: "sale-share",
            value: 5,
            capping: null,
            priority: 1,
            conditions: [{ value: ["KWT", "ARE"], dimension: "country", operation: "contains" }],
            product_categories: null,
          },
        ],
        coupons: null,
        end_date: "2026-12-31T00:00:00.000000Z",
        is_global: false,
        start_date: "2026-06-11T00:00:00.000000Z",
      },
    ],
    targetCountries: [{ code: "ARE" }, { code: "KWT" }, { code: "SAU" }],
  };
}

const PAYOUT_KEY = "fp:26c39f07c5529202"; // identity observed before the condition patch — must not move
const ctx = { networkSource: "boostiny", sourceAccountLabel: "default", supplierCampaignId: "61" };
const candidates = () => mapBoostinyPayoutGroupCandidates(bloomingdales(), ctx);
const byGroup = (id) => candidates().find((c) => c.sourceGroupId === String(id));
const nonGate = (rule) => rule.conditions.filter((c) => c.sourceConditionType !== BOOSTINY_VERIFY_LIVE_GATE.sourceConditionType);
const gateOf = (rule) => rule.conditions.filter((c) => c.sourceConditionType === BOOSTINY_VERIFY_LIVE_GATE.sourceConditionType);

describe("Boostiny condition shape adaptation", () => {
  it("reads dimension as the source dimension and operation as the source operator; keeps the original untouched", () => {
    const original = { value: ["SAU"], dimension: "country", operation: "contains" };
    const frozen = JSON.stringify(original);
    const adapted = adaptBoostinyCondition(original);
    assert.equal(adapted.type, "country");
    assert.equal(adapted.operator, "EQ", "contains over a value list = membership = EQ alternatives");
    assert.deepEqual(adapted.value, ["SAU"]);
    assert.equal(JSON.stringify(original), frozen, "the original object is not mutated");
    assert.equal(adaptBoostinyCondition({ value: "FP", dimension: "business-category", operation: "equals" }).operator, "EQ");
  });

  it("does not touch conditions that are not in the Boostiny dimension/operation shape", () => {
    const generic = { field: "customer_type", operator: "equals", value: "zznewzz" };
    assert.equal(adaptBoostinyCondition(generic), generic);
    assert.equal(adaptBoostinyCondition("zzbarezz"), "zzbarezz");
    assert.equal(adaptBoostinyCondition(null), null);
  });

  it("passes an operation it does not know through verbatim (upper-cased) so the matcher fails closed on it", () => {
    const adapted = adaptBoostinyCondition({ value: ["SAU"], dimension: "country", operation: "not-contains" });
    assert.equal(adapted.operator, "NOT_CONTAINS");
    assert.ok(!["EQ", "IN"].includes(adapted.operator), "never silently turned into a positive match");
  });
});

describe("Bloomingdales group 74018 — country contains [SAU] + business-category equals FP", () => {
  it("normalizes to COUNTRY SAU + OTHER_SOURCE_CONDITION FP + VERIFY_LIVE, all not matcher-ready", () => {
    const rule = byGroup(74018);
    const rows = nonGate(rule);
    assert.equal(rows.length, 2);
    const [country, business] = rows;
    assert.equal(country.conditionType, "COUNTRY");
    assert.equal(country.operator, "EQ");
    assert.equal(country.value, "SAU");
    assert.equal(country.sourceConditionType, "country");
    assert.deepEqual(country.sourceConditionValue, { value: ["SAU"], dimension: "country", operation: "contains" });
    assert.deepEqual(country.metadata.sourceCondition, { value: ["SAU"], dimension: "country", operation: "contains" });
    assert.equal(country.metadata.sourceDimension, "country");
    assert.equal(country.metadata.sourceOperation, "contains");
    assert.equal(country.metadata.matcherReady, false);
    assert.equal(country.metadata.reason, REASON);
    assert.ok(!("semanticsVerified" in country.metadata));

    assert.equal(business.conditionType, "OTHER_SOURCE_CONDITION", "business-category has no canonical dimension: stays conservative");
    assert.equal(business.operator, "EQ");
    assert.equal(business.value, "FP");
    assert.equal(business.sourceConditionType, "business-category");
    assert.deepEqual(business.sourceConditionValue, { value: "FP", dimension: "business-category", operation: "equals" });
    assert.equal(business.metadata.sourceDimension, "business-category");
    assert.equal(business.metadata.sourceOperation, "equals");
    assert.equal(business.metadata.matcherReady, false);
    assert.equal(business.metadata.reason, REASON);

    const [gate, ...extraGates] = gateOf(rule);
    assert.deepEqual(extraGates, []);
    assert.equal(gate.value, "VERIFY_LIVE");
    assert.deepEqual(gate.metadata.reviewReasons, [REASON]);
    assert.equal(rule.conditions.length, 3);
  });

  it("keeps identity, economics, window and priority exactly as before the condition patch", () => {
    const rule = byGroup(74018);
    assert.equal(rule.outcomeKey, `boostiny::campaigns::61::payout:${PAYOUT_KEY}::group:74018`);
    assert.equal(rule.metadata.payoutIdentityStrategy, "PAYOUT_SEMANTIC_FINGERPRINT");
    assert.equal(rule.metadata.groupIdentityStrategy, "SUPPLIER_ID");
    assert.equal(rule.commissionType, "PERCENTAGE");
    assert.equal(rule.metadata.valueKind, "PERCENT");
    assert.equal(rule.ratePercent, 2.5);
    assert.equal(rule.fixedAmount, null);
    assert.equal(rule.currency, null);
    assert.equal(rule.basis, "PERCENT_OF_SALE");
    assert.equal(rule.priority, 2);
    assert.equal(rule.effectiveFrom, "2026-06-11T00:00:00.000000Z");
    assert.equal(rule.effectiveUntil, "2026-12-31T00:00:00.000000Z");
    assert.equal(rule.sourcePath, "payouts[0].groups[0]");
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.deepEqual(rule.metadata.reviewReasons, [REASON]);
    assert.equal(rule.metadata.financeReady, false);
    const readiness = assessSupplierCommissionReadiness(rule);
    assert.equal(readiness.financeReady, false);
    assert.equal(readiness.mappingStatus, "REVIEW_REQUIRED");
    assert.deepEqual(readiness.reviewReasons, [REASON]);
  });
});

describe("Bloomingdales group 74017 — country contains [KWT, ARE]", () => {
  it("normalizes to COUNTRY KWT + COUNTRY ARE (same-dimension alternatives) + VERIFY_LIVE", () => {
    const rule = byGroup(74017);
    const rows = nonGate(rule);
    assert.deepEqual(
      rows.map((c) => [c.conditionType, c.operator, c.value, c.sourceConditionType]),
      [["COUNTRY", "EQ", "KWT", "country"], ["COUNTRY", "EQ", "ARE", "country"]],
    );
    for (const row of rows) {
      assert.deepEqual(row.sourceConditionValue, { value: ["KWT", "ARE"], dimension: "country", operation: "contains" });
      assert.equal(row.metadata.sourceOperation, "contains");
      assert.equal(row.metadata.matcherReady, false);
      assert.equal(row.metadata.reason, REASON);
    }
    assert.equal(gateOf(rule).length, 1);
    assert.equal(rule.conditions.length, 3);
  });

  it("keeps identity, economics, window and priority exactly as before the condition patch", () => {
    const rule = byGroup(74017);
    assert.equal(rule.outcomeKey, `boostiny::campaigns::61::payout:${PAYOUT_KEY}::group:74017`);
    assert.equal(rule.ratePercent, 5);
    assert.equal(rule.fixedAmount, null);
    assert.equal(rule.priority, 1);
    assert.equal(rule.effectiveFrom, "2026-06-11T00:00:00.000000Z");
    assert.equal(rule.effectiveUntil, "2026-12-31T00:00:00.000000Z");
    assert.equal(rule.sourcePath, "payouts[0].groups[1]");
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.deepEqual(rule.metadata.reviewReasons, [REASON]);
    assert.equal(assessSupplierCommissionReadiness(rule).financeReady, false);
  });
});

describe("Bloomingdales — whole campaign invariants", () => {
  it("still yields exactly two candidates sharing one payout identity, both REVIEW_REQUIRED, none finance-ready", () => {
    const all = candidates();
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((c) => c.sourceGroupId), ["74018", "74017"]);
    assert.equal(new Set(all.map((c) => c.metadata.payoutIdentityKey)).size, 1);
    assert.equal(all[0].metadata.payoutIdentityKey, PAYOUT_KEY);
    assert.ok(all.every((c) => c.mappingStatus === "REVIEW_REQUIRED"));
    assert.ok(all.every((c) => assessSupplierCommissionReadiness(c).financeReady === false));
    assert.ok(all.every((c) => c.conditions.every((cond) => cond.metadata?.matcherReady !== true && cond.metadata?.semanticsVerified !== true)));
  });

  it("assigns no meaning to FP and reads campaign-level target countries into no rule", () => {
    const serialised = JSON.stringify(candidates());
    assert.ok(!/full[\s_-]?price/i.test(serialised), "FP is preserved verbatim, never expanded");
    assert.ok(!serialised.includes("targetCountries"), "campaign-level target countries are not rule conditions");
    assert.ok(!/full[\s_-]?price/i.test(MAPPER_SRC));
  });

  it("condition rows without source qualifiers are unchanged: an empty conditions list is VERIFIED", () => {
    const raw = bloomingdales();
    raw.payouts[0].groups = [{ id: 74019, type: "sale-share", value: 3, capping: null, priority: 3, conditions: [], product_categories: null }];
    const [rule] = mapBoostinyPayoutGroupCandidates(raw, ctx);
    assert.deepEqual(rule.conditions, []);
    assert.equal(rule.mappingStatus, "VERIFIED");
  });
});

describe("source guards — the gate is untouched and the adapter sits in front of the shared normalizer", () => {
  it("adapts before conditionsFromSourceEntry, then re-attaches the original object and the unverified flag", () => {
    const fn = MAPPER_SRC.split("export function boostinyGroupConditions")[1].split("\n}")[0];
    assert.ok(fn.indexOf("adaptBoostinyCondition(") < fn.indexOf("conditionsFromSourceEntry("), "adapt first");
    assert.match(fn, /sourceConditionValue: original,/);
    assert.match(fn, /sourceCondition: original,/);
    assert.match(fn, /matcherReady: false, reason: "boostiny_condition_semantics_not_verified_live"/);
  });

  it("the review reason for group conditions is still raised whenever conditions are present", () => {
    assert.match(MAPPER_SRC, /if \(!isEmpty\(group\.conditions\)\) reviewReasons\.push\("boostiny_condition_semantics_not_verified_live"\);/);
    assert.match(MAPPER_SRC, /const mappingStatus = reviewReasons\.length \? "REVIEW_REQUIRED" : "VERIFIED";/);
  });
});
