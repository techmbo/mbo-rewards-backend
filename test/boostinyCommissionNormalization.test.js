/**
 * Boostiny payouts[].groups[] → SupplierCommissionRule[] / SupplierCommissionCondition[].
 *
 * Fixtures are SYNTHETIC: they match only the live-certified structure, never live values.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const {
  BOOSTINY_PAYOUT_GROUP_RULE_VERSION,
  BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT,
  BOOSTINY_VERIFY_LIVE_GATE,
  boostinyGroupIdentity,
  boostinyPayoutIdentity,
  campaignHasPayoutGroups,
  classifyBoostinyGroupType,
  mapBoostinyPayoutGroupCandidates,
  sourceCampaignIdFromBoostinyOutcomeKey,
} = await import("../src/modules/commercial/boostinyPayoutGroup.mapper.js");
const { BoostinyCommissionPersistenceService } = await import(
  "../src/modules/commercial/boostinyCommissionPersistence.service.js"
);
const { SupplierCommissionRuleService } = await import(
  "../src/modules/commercial/services/supplierCommissionRule.service.js"
);
const { extractCommissionRulesFromCampaignRaw } = await import("../src/modules/commercial/supplierCommissionRuleFanOut.js");
const { mapOptimiseCommissionGroupCandidates } = await import("../src/modules/commercial/optimiseCommissionGroup.mapper.js");
const { mapBoostinyCampaign, extractBoostinyPayout } = await import("../src/modules/supplier/mappers/boostiny.mapper.js");

const MAPPER_SRC = readFileSync("src/modules/commercial/boostinyPayoutGroup.mapper.js", "utf8");
const PERSIST_SRC = readFileSync("src/modules/commercial/boostinyCommissionPersistence.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/sync.job.js", "utf8");

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
function codeOf(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    out += char;
    i += 1;
  }
  return out;
}

const CONTEXT = { networkSource: "boostiny", sourceAccountLabel: "default", fetchedAt: new Date("2026-09-10T10:00:00.000Z") };

/** Synthetic structure only: every value is a marker. */
function group(overrides = {}) {
  return {
    id: 9101,
    priority: 1,
    type: "sale-share",
    value: 4,
    conditions: [],
    capping: null,
    product_categories: [],
    coupons: [],
    ...overrides,
  };
}
function payout(overrides = {}) {
  return {
    model: "cps",
    level: "campaign",
    is_global: true,
    start_date: "2026-01-01",
    end_date: null,
    groups: [group()],
    ...overrides,
  };
}
function campaign(payouts, id = 7001) {
  return { id, name: "zzsyntheticcampaignzz", payouts };
}

function candidatesOf(raw) {
  return mapBoostinyPayoutGroupCandidates(raw, CONTEXT);
}

const QUALIFIED_GROUP = group({
  id: 9102,
  priority: 2,
  value: 6,
  conditions: [{ field: "customer_type", operator: "equals", value: "zznewzz" }, { field: "zzunknownfieldzz", operator: "gte", value: "zzvzz" }],
  capping: { max_payout: 250, period: "zzperiodzz" },
  product_categories: ["zzcatonezz", { id: "zzcattwoidzz", name: "zzcattwozz" }],
  coupons: ["zzcouponazz", { coupon: "zzcouponbzz" }],
});

describe("one rule per payout group — nothing averaged, merged or collapsed", () => {
  it("one payout + one group => one SupplierCommissionRule", () => {
    const rules = candidatesOf(campaign([payout()]));
    assert.equal(rules.length, 1);
    assert.equal(rules[0].supplier, "BOOSTINY");
    assert.equal(rules[0].sourceObject, BOOSTINY_PAYOUT_GROUP_SOURCE_OBJECT);
    assert.equal(rules[0].ruleVersion, BOOSTINY_PAYOUT_GROUP_RULE_VERSION);
  });

  it("one payout + three groups => three rules, each with its own value", () => {
    const rules = candidatesOf(
      campaign([payout({ groups: [group({ id: 1, value: 4 }), group({ id: 2, value: 2, priority: 2 }), group({ id: 3, value: 1, priority: 3 })] })]),
    );
    assert.equal(rules.length, 3);
    assert.deepEqual(rules.map((r) => r.ratePercent), [4, 2, 1]);
    assert.deepEqual(rules.map((r) => r.sourceGroupId), ["1", "2", "3"]);
    assert.equal(new Set(rules.map((r) => r.outcomeKey)).size, 3);
  });

  it("two payouts with groups => all groups remain separate, even with the same group id", () => {
    const rules = candidatesOf(
      campaign([
        payout({ groups: [group({ id: 1, value: 4 }), group({ id: 2, value: 2 })] }),
        payout({ model: "cps", start_date: "2026-06-01", groups: [group({ id: 1, value: 9 })] }),
      ]),
    );
    assert.equal(rules.length, 3);
    assert.equal(new Set(rules.map((r) => r.outcomeKey)).size, 3);
    const sameGroupId = rules.filter((r) => r.sourceGroupId === "1");
    assert.equal(sameGroupId.length, 2);
    assert.notEqual(sameGroupId[0].metadata.payoutIdentityKey, sameGroupId[1].metadata.payoutIdentityKey);
    assert.deepEqual(sameGroupId.map((r) => r.ratePercent), [4, 9]);
  });

  it("never averages: no rule carries a value that no group stated", () => {
    const rules = candidatesOf(campaign([payout({ groups: [group({ id: 1, value: 4 }), group({ id: 2, value: 2 })] })]));
    assert.deepEqual(rules.map((r) => r.ratePercent).sort(), [2, 4]);
    assert.ok(!rules.some((r) => r.ratePercent === 3));
    const code = codeOf(MAPPER_SRC);
    for (const forbidden of ["average", "reduce(", "Math.max", "Math.min", "summarizeCommissionFacts", "pickBoostinyPayoutGroupValue"]) {
      assert.ok(!code.includes(forbidden), forbidden);
    }
  });

  it("Commission 1..N is a display sequence, never identity", () => {
    const rules = candidatesOf(campaign([payout({ groups: [group({ id: 1 }), group({ id: 2 })] })]));
    assert.deepEqual(rules.map((r) => r.commissionSequence), [1, 2]);
    for (const rule of rules) assert.ok(!rule.outcomeKey.includes("slot:2") && !rule.outcomeKey.includes(`seq`));
    const reordered = candidatesOf(campaign([payout({ groups: [group({ id: 2 }), group({ id: 1 })] })]));
    assert.deepEqual(reordered.map((r) => r.commissionSequence), [1, 2]);
    assert.deepEqual(new Set(reordered.map((r) => r.outcomeKey)), new Set(rules.map((r) => r.outcomeKey)), "same identities, different display order");
  });
});

describe("supplier lineage is preserved on every rule", () => {
  it("carries campaign id, payout identity and index, group id and priority", () => {
    const [rule] = candidatesOf(campaign([payout({ groups: [group({ id: 9101, priority: 3 })] })], 7001));
    assert.equal(rule.sourceCampaignId, "7001");
    assert.equal(rule.sourceGroupId, "9101");
    assert.equal(rule.sourceRuleId, "9101");
    assert.equal(rule.priority, 3);
    assert.equal(rule.metadata.groupPriority, 3);
    assert.equal(rule.metadata.payoutIndex, 0);
    assert.equal(rule.metadata.groupIndex, 0);
    assert.equal(rule.sourcePath, "payouts[0].groups[0]");
    assert.equal(rule.metadata.payoutIdentityStrategy, "PAYOUT_SEMANTIC_FINGERPRINT");
    assert.equal(rule.networkSource, "boostiny");
    assert.equal(sourceCampaignIdFromBoostinyOutcomeKey(rule.outcomeKey), "7001");
  });

  it("preserves payout model, level, is_global and window", () => {
    const [rule] = candidatesOf(campaign([payout({ model: "cps", level: "zzlevelzz", is_global: false, start_date: "2026-02-03", end_date: "2026-04-05" })]));
    assert.equal(rule.commissionModel, "cps");
    assert.equal(rule.metadata.payoutModel, "cps");
    assert.equal(rule.metadata.payoutLevel, "zzlevelzz");
    assert.equal(rule.metadata.payoutIsGlobal, false);
    assert.equal(rule.effectiveFrom, "2026-02-03");
    assert.equal(rule.effectiveUntil, "2026-04-05");
    assert.equal(rule.metadata.payoutStartDate, "2026-02-03");
    assert.equal(rule.metadata.payoutEndDate, "2026-04-05");
    assert.equal(rule.rawRuleReference.payout.level, "zzlevelzz");
    assert.equal(rule.rawRuleReference.payout.is_global, false);
    assert.ok(!("groups" in rule.rawRuleReference.payout), "the payout fragment does not re-embed every group");
    assert.equal(rule.rawRuleReference.group.id, 9101);
  });

  it("preserves group type and value as stated, in canonical fields and evidence", () => {
    const [rule] = candidatesOf(campaign([payout({ groups: [group({ type: "sale-share", value: 4 })] })]));
    assert.equal(rule.supplierRuleType, "sale-share");
    assert.equal(rule.metadata.groupType, "sale-share");
    assert.equal(rule.metadata.groupValue, 4);
  });

  it("does not silently discard expired or future payouts", () => {
    const rules = candidatesOf(
      campaign([
        payout({ start_date: "2020-01-01", end_date: "2020-12-31", groups: [group({ id: 1 })] }),
        payout({ start_date: "2031-01-01", end_date: null, groups: [group({ id: 2 })] }),
        payout({ start_date: null, end_date: null, groups: [group({ id: 3 })] }),
      ]),
    );
    assert.equal(rules.length, 3);
    assert.deepEqual(rules.map((r) => [r.effectiveFrom, r.effectiveUntil]), [["2020-01-01", "2020-12-31"], ["2031-01-01", null], [null, null]]);
    // Contrast: the generic campaign-summary fan-out keeps only currently active facts.
    const generic = extractCommissionRulesFromCampaignRaw(campaign([payout({ start_date: "2031-01-01", groups: [group()] })]), { sourceObject: "campaigns" });
    assert.equal(generic.length, 0);
  });

  it("flags an invalid window for review instead of guessing a date", () => {
    const [rule] = candidatesOf(campaign([payout({ start_date: "zznotadatezz" })]));
    assert.equal(rule.effectiveFrom, null);
    assert.ok(rule.metadata.reviewReasons.includes("payout_window_invalid"));
    assert.equal(rule.metadata.payoutStartDate, "zznotadatezz");
  });
});

describe("value semantics follow the established convention, and nothing is guessed", () => {
  it("sale-share is a percent of sale", () => {
    const [rule] = candidatesOf(campaign([payout({ groups: [group({ type: "sale-share", value: 4 })] })]));
    assert.equal(rule.ratePercent, 4);
    assert.equal(rule.fixedAmount, null);
    assert.equal(rule.basis, "PERCENT_OF_SALE");
    assert.equal(rule.commissionType, "PERCENTAGE");
    assert.equal(rule.mappingStatus, "VERIFIED");
    assert.deepEqual(rule.metadata.reviewReasons, []);
    assert.equal(classifyBoostinyGroupType({ type: "sale-share" }, { model: "cps" }).decidedBy, "group.type");
  });

  it("a fixed-amount group is a fixed amount, never a percent — even under a cps payout", () => {
    const [rule] = candidatesOf(campaign([payout({ model: "cps", groups: [group({ type: "fixed-amount", value: 15 })] })]));
    assert.equal(rule.fixedAmount, 15);
    assert.equal(rule.ratePercent, null);
    assert.equal(rule.commissionType, "FIXED");
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.ok(rule.metadata.reviewReasons.includes("fixed_payout_currency_missing"));
    assert.ok(rule.metadata.reviewReasons.includes("payout_model_group_type_conflict"));
    // Contrast: the generic fan-out reads the same group as 15%.
    const generic = extractCommissionRulesFromCampaignRaw(campaign([payout({ model: "cps", groups: [group({ type: "fixed-amount", value: 15 })] })]), { sourceObject: "campaigns" });
    assert.equal(generic[0].ratePercent, 15);
  });

  it("a fixed amount under a cpa payout is coherent: CPA basis, review only for the missing currency", () => {
    const [rule] = candidatesOf(campaign([payout({ model: "cpa", groups: [group({ type: "fixed-amount", value: 15 })] })]));
    assert.equal(rule.fixedAmount, 15);
    assert.equal(rule.basis, "CPA");
    assert.deepEqual(rule.metadata.reviewReasons, ["fixed_payout_currency_missing"]);
  });

  it("a percent group under a cpa payout is a conflict, preserved for review", () => {
    const [rule] = candidatesOf(campaign([payout({ model: "cpa", groups: [group({ type: "sale-share", value: 9 })] })]));
    assert.equal(rule.ratePercent, 9);
    assert.equal(rule.basis, "PERCENT_OF_SALE");
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.deepEqual(rule.metadata.reviewReasons, ["payout_model_group_type_conflict"]);
  });

  it("an unfamiliar type is preserved, not guessed: no rate, no amount, review", () => {
    const [rule] = candidatesOf(campaign([payout({ groups: [group({ type: "zzunfamiliartypezz", value: 7 })] })]));
    assert.equal(rule.supplierRuleType, "zzunfamiliartypezz");
    assert.equal(rule.ratePercent, null);
    assert.equal(rule.fixedAmount, null);
    assert.equal(rule.basis, "UNKNOWN");
    assert.equal(rule.commissionType, "OTHER");
    assert.equal(rule.metadata.valueKind, "UNKNOWN");
    assert.equal(rule.metadata.groupValue, 7, "the stated value stays as evidence");
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.ok(rule.metadata.reviewReasons.includes("group_type_semantics_unknown"));
    assert.equal(classifyBoostinyGroupType({ type: "zzunfamiliartypezz" }, { model: "cps" }).kind, "UNKNOWN");
  });

  it("falls back to the payout model only when the group states no type", () => {
    assert.deepEqual(classifyBoostinyGroupType({}, { model: "cps" }), { kind: "PERCENT", decidedBy: "payout.model" });
    assert.deepEqual(classifyBoostinyGroupType({}, { model: "cpa" }), { kind: "FIXED", decidedBy: "payout.model" });
    assert.deepEqual(classifyBoostinyGroupType({}, {}), { kind: "UNKNOWN", decidedBy: null });
    const [rule] = candidatesOf(campaign([payout({ groups: [group({ type: undefined })] })]));
    assert.equal(rule.ratePercent, 4);
    assert.equal(rule.metadata.valueKindDecidedBy, "payout.model");
  });

  it("explicit zero is a real outcome; a missing value is not manufactured", () => {
    const [zero] = candidatesOf(campaign([payout({ groups: [group({ value: 0 })] })]));
    assert.equal(zero.ratePercent, 0);
    assert.equal(zero.mappingStatus, "VERIFIED");
    const [missing] = candidatesOf(campaign([payout({ groups: [group({ value: null })] })]));
    assert.equal(missing.ratePercent, null);
    assert.ok(missing.metadata.reviewReasons.includes("group_value_missing"));
  });

  it("invents no currency: none in the structure means null, and campaign currency is never inherited", () => {
    const [rule] = candidatesOf(campaign([payout({ groups: [group({ type: "fixed-amount", value: 15 })] })]));
    assert.equal(rule.currency, null);
    assert.equal(rule.metadata.currencySource, null);
    const code = codeOf(MAPPER_SRC);
    for (const inherit of ["commissionCurrency", "currencyCode(raw", "raw.currency", "campaignCurrency", "supplierCampaign.", "supplierCampaign?."]) {
      assert.ok(!code.includes(inherit), inherit);
    }
    // A currency the payout itself states is the one existing contract (payouts[].currency).
    const [stated] = candidatesOf(campaign([payout({ currency: "usd", groups: [group({ type: "fixed-amount", value: 15 })] })]));
    assert.equal(stated.currency, "USD");
    assert.equal(stated.metadata.currencySource, "payout");
    assert.ok(!stated.metadata.reviewReasons.includes("fixed_payout_currency_missing"));
  });
});

describe("qualifiers stay with the one rule they qualify — never flattened, never decided", () => {
  it("conditions, product_categories, coupons and capping become child conditions of ONE rule", () => {
    const rules = candidatesOf(campaign([payout({ groups: [QUALIFIED_GROUP] })]));
    assert.equal(rules.length, 1, "qualifiers do not fan out into several rules");
    const [rule] = rules;
    const byType = (type) => rule.conditions.filter((c) => c.conditionType === type);
    assert.deepEqual(byType("CUSTOMER_TYPE").map((c) => [c.operator, c.value]), [["equals", "zznewzz"]]);
    assert.deepEqual(byType("CATEGORY").map((c) => c.value).sort(), ["zzcatonezz", "zzcattwoidzz"]);
    assert.deepEqual(byType("COUPON").map((c) => c.value).sort(), ["zzcouponazz", "zzcouponbzz"]);
    const capping = rule.conditions.find((c) => c.sourceConditionType === "capping");
    assert.equal(capping.conditionType, "OTHER_SOURCE_CONDITION");
    assert.equal(capping.operator, "SOURCE_CAP");
    assert.deepEqual(capping.sourceConditionValue, { max_payout: 250, period: "zzperiodzz" });
    assert.equal(capping.metadata.matcherReady, false);
    const unknownField = rule.conditions.find((c) => c.sourceConditionType === "zzunknownfieldzz");
    assert.equal(unknownField.conditionType, "OTHER_SOURCE_CONDITION", "an unknown dimension is kept, not discarded");
    assert.equal(unknownField.operator, "gte");
  });

  it("keeps the raw qualifier structures as evidence too", () => {
    const [rule] = candidatesOf(campaign([payout({ groups: [QUALIFIED_GROUP] })]));
    assert.deepEqual(rule.metadata.conditions, QUALIFIED_GROUP.conditions);
    assert.deepEqual(rule.metadata.capping, QUALIFIED_GROUP.capping);
    assert.deepEqual(rule.metadata.productCategories, QUALIFIED_GROUP.product_categories);
    assert.deepEqual(rule.metadata.coupons, QUALIFIED_GROUP.coupons);
    assert.deepEqual(rule.rawRuleReference.group, QUALIFIED_GROUP);
  });

  it("a qualified rule fails closed: REVIEW_REQUIRED with the MBO gate, so no matcher can pick it silently", () => {
    const [rule] = candidatesOf(campaign([payout({ groups: [QUALIFIED_GROUP] })]));
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(rule.fieldMappingOutcome, "REVIEW_REQUIRED");
    assert.equal(rule.metadata.financeReady, false);
    const gate = rule.conditions.find((c) => c.sourceConditionType === BOOSTINY_VERIFY_LIVE_GATE.sourceConditionType);
    assert.ok(gate);
    assert.deepEqual(gate.sourceConditionValue.reviewReasons, rule.metadata.reviewReasons);
    assert.ok(!rule.outcomeKey.includes("VERIFY_LIVE"), "the gate is not part of identity");
  });

  it("an unqualified rule carries no gate and no conditions", () => {
    const [rule] = candidatesOf(campaign([payout()]));
    assert.deepEqual(rule.conditions, []);
    assert.equal(rule.mappingStatus, "VERIFIED");
  });

  it("empty qualifiers are not conditions", () => {
    const [rule] = candidatesOf(campaign([payout({ groups: [group({ conditions: [], capping: {}, product_categories: [], coupons: null })] })]));
    assert.deepEqual(rule.conditions, []);
    assert.deepEqual(rule.metadata.reviewReasons, []);
  });

  it("preserves priority and decides nothing: no winner, no client commission, no settlement", () => {
    const rules = candidatesOf(campaign([payout({ groups: [group({ id: 1, priority: 2, value: 4 }), group({ id: 2, priority: 1, value: 2 })] })]));
    assert.deepEqual(rules.map((r) => r.priority), [2, 1]);
    assert.equal(rules.length, 2, "the lower-priority group is not dropped as a loser");
    for (const src of [codeOf(MAPPER_SRC), codeOf(PERSIST_SRC)]) {
      for (const forbidden of [
        "clientCommission",
        "ClientCommercial",
        "commercialRuleEngine",
        "payableCommission",
        "matchSupplierCommissionRule",
        "selectPayable",
        "winner",
        "settlement",
        "Settlement",
        "PartnerPayment",
        "Payment",
        "Invoice",
      ]) {
        assert.ok(!src.includes(forbidden), forbidden);
      }
    }
    for (const rule of rules) {
      for (const key of ["clientCommission", "payable", "winner", "settled", "expectedClientCommission"]) {
        assert.ok(!Object.hasOwn(rule, key), key);
        assert.ok(!Object.hasOwn(rule.metadata, key), key);
      }
    }
  });
});

describe("identity comes from supplier evidence, and never from display or value", () => {
  it("is network + campaign + payout identity + group id + qualifiers", () => {
    const [rule] = candidatesOf(campaign([payout()], 7001));
    const parts = rule.outcomeKey.split("::");
    assert.equal(parts[0], "boostiny");
    assert.equal(parts[1], "campaigns");
    assert.equal(parts[2], "7001");
    assert.match(parts[3], /^payout:fp:[0-9a-f]{16}$/);
    assert.equal(parts[4], "group:9101");
    assert.equal(parts[5], "slot:1");
    assert.equal(parts[6], "", "an unqualified rule has an empty condition signature");
    assert.equal(parts.length, 7, "exactly these segments and nothing else");
  });

  it("excludes the value: a changed value keeps the same identity", () => {
    const [before] = candidatesOf(campaign([payout({ groups: [group({ value: 4 })] })]));
    const [after] = candidatesOf(campaign([payout({ groups: [group({ value: 5 })] })]));
    assert.equal(before.outcomeKey, after.outcomeKey);
    assert.ok(!before.outcomeKey.includes("4"), "no value in the key");
  });

  it("excludes display sequence, formatted labels and array positions", () => {
    const rules = candidatesOf(campaign([payout({ groups: [group({ id: 1 }), group({ id: 2 })] }), payout({ start_date: "2026-06-01", groups: [group({ id: 3 })] })]));
    for (const rule of rules) {
      assert.ok(!/Commission \d/.test(rule.outcomeKey));
      assert.ok(!rule.outcomeKey.includes("payouts["), "no array index");
      assert.ok(!rule.outcomeKey.includes("%"));
    }
  });

  it("uses a supplier payout id when one exists, and a semantic fingerprint otherwise", () => {
    assert.deepEqual(boostinyPayoutIdentity({ id: "zzpidzz" }), { strategy: "SUPPLIER_ID", key: "id:zzpidzz", inputs: { id: "zzpidzz" } });
    const a = boostinyPayoutIdentity({ model: "cps", level: "campaign", is_global: true, start_date: "2026-01-01", end_date: null });
    const b = boostinyPayoutIdentity({ model: "cps", level: "campaign", is_global: true, start_date: "2026-01-01", end_date: null, groups: [group()] });
    const c = boostinyPayoutIdentity({ model: "cpa", level: "campaign", is_global: true, start_date: "2026-01-01", end_date: null });
    assert.equal(a.key, b.key, "groups (economics) do not change the payout identity");
    assert.notEqual(a.key, c.key);
  });

  it("a group without an id is fingerprinted from stable semantics and flagged, never keyed by position", () => {
    const identity = boostinyGroupIdentity({ type: "sale-share", priority: 1, value: 4 });
    assert.equal(identity.strategy, "ANONYMOUS_SEMANTIC_FINGERPRINT");
    assert.equal(identity.key, boostinyGroupIdentity({ type: "sale-share", priority: 1, value: 99 }).key, "value excluded");
    const [rule] = candidatesOf(campaign([payout({ groups: [group({ id: undefined })] })]));
    assert.equal(rule.sourceGroupId, null);
    assert.ok(rule.metadata.reviewReasons.includes("supplier_group_id_missing"));
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
  });

  it("a duplicate of the same identity in one row collapses instead of fabricating lineage", () => {
    const rules = candidatesOf(campaign([payout({ groups: [group({ id: 1 }), group({ id: 1 })] })]));
    assert.equal(rules.length, 1);
  });
});

/** Fake canonical store with the schema's outcome-identity uniqueness enforced. */
function createRuleDb({ supplierCampaign = null } = {}) {
  const rows = [];
  let sequence = 0;
  const materialize = (nested) => (Array.isArray(nested?.create) ? nested.create.map((row, i) => ({ id: `cond-${i + 1}`, ...row })) : []);
  const uniqueKey = (row) => `${row.supplier}|${row.sourceAccountLabel}|${row.outcomeKey}|${new Date(row.effectiveFrom).getTime()}`;
  const model = {
    async findMany({ where }) {
      return rows
        .filter(
          (row) =>
            (where.supplier == null || row.supplier === where.supplier) &&
            (where.sourceAccountLabel == null || row.sourceAccountLabel === where.sourceAccountLabel) &&
            (where.outcomeKey == null || (typeof where.outcomeKey === "string" ? row.outcomeKey === where.outcomeKey : true)),
        )
        .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))
        .map((row) => ({ ...row, conditions: [...(row.conditions || [])] }));
    },
    async create({ data }) {
      const key = uniqueKey(data);
      if (rows.some((row) => uniqueKey(row) === key)) {
        const error = new Error("Unique constraint failed on the fields: (`supplier`,`sourceAccountLabel`,`outcomeKey`,`effectiveFrom`)");
        error.code = "P2002";
        throw error;
      }
      sequence += 1;
      const row = { id: `rule-${sequence}`, createdAt: new Date(), ...data, conditions: materialize(data.conditions) };
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }) {
      const index = rows.findIndex((row) => row.id === where.id);
      assert.notEqual(index, -1);
      const next = { ...rows[index], ...data };
      if (data.conditions) next.conditions = materialize(data.conditions);
      rows[index] = next;
      return { ...next };
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const row of rows) {
        if (
          row.supplier === where.supplier &&
          row.sourceAccountLabel === where.sourceAccountLabel &&
          row.sourceObject === where.sourceObject &&
          row.sourcePath === where.sourcePath &&
          row.effectiveUntil == null &&
          String(row.outcomeKey).startsWith(where.outcomeKey.startsWith) &&
          new Date(row.effectiveFrom) < where.effectiveFrom.lt
        ) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
  };
  const db = {
    supplierCommissionRule: model,
    supplierCampaign: {
      async findFirst({ where }) {
        if (!supplierCampaign) return null;
        return { ...supplierCampaign, supplierCampaignId: String(where.supplierCampaignId), campaignSources: [{ id: "cs-1" }] };
      },
    },
    async $transaction(callback) {
      return callback({ supplierCommissionRule: model });
    },
  };
  return { rows, db };
}

function serviceFor(db, now = () => new Date("2026-09-10T12:00:00.000Z")) {
  return new BoostinyCommissionPersistenceService({ prisma: db, ruleService: new SupplierCommissionRuleService({ prisma: db }), now });
}

const openRows = (rows) => rows.filter((row) => row.effectiveUntil == null);

describe("persistence — idempotent, versioned, one rule per group", () => {
  it("persists one rule per group with lineage and conditions, linked to the supplier campaign", async () => {
    const { rows, db } = createRuleDb({ supplierCampaign: { id: "sc-1", campaignName: "zzcampaignzz", merchantNameRaw: "zzbrandzz" } });
    const summary = await serviceFor(db).persistCampaigns({ campaigns: [campaign([payout({ groups: [group({ id: 1 }), QUALIFIED_GROUP] })])] });
    assert.equal(summary.campaignsWithPayoutGroups, 1);
    assert.equal(summary.rulesPersisted, 2);
    assert.equal(summary.financeReady, 1);
    assert.equal(summary.reviewRequired, 1);
    assert.equal(summary.campaignsUnlinked, 0);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.supplier === "BOOSTINY" && row.supplierCampaignId === "sc-1" && row.campaignSourceId === "cs-1"));
    const qualified = rows.find((row) => row.sourceGroupId === "9102");
    assert.ok(qualified.conditions.some((c) => c.conditionType === "CATEGORY"));
    assert.ok(qualified.conditions.some((c) => c.sourceConditionType === "capping"));
    assert.equal(qualified.metadata.effectiveFromSource, "SUPPLIER_START_DATE");
    assert.equal(new Date(qualified.effectiveFrom).toISOString().slice(0, 10), "2026-01-01");
  });

  it("identical repeated sync is idempotent: same rows, same ids, no new versions", async () => {
    const { rows, db } = createRuleDb();
    const service = serviceFor(db);
    const raw = campaign([payout({ groups: [group({ id: 1 }), group({ id: 2, value: 2 })] }), payout({ start_date: "2026-06-01", groups: [group({ id: 3, value: 1 })] })]);
    await service.persistCampaigns({ campaigns: [raw] });
    const snapshot = rows.map((row) => `${row.id}|${row.outcomeKey}|${row.ratePercent}|${row.effectiveUntil}`);
    await service.persistCampaigns({ campaigns: [raw] });
    await service.persistCampaigns({ campaigns: [raw] });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => `${row.id}|${row.outcomeKey}|${row.ratePercent}|${row.effectiveUntil}`), snapshot);
    assert.equal(openRows(rows).length, 3);
  });

  it("changing one group's value versions only that rule; the others are untouched", async () => {
    const { rows, db } = createRuleDb();
    const service = serviceFor(db, () => new Date("2026-09-10T12:00:00.000Z"));
    const before = campaign([payout({ groups: [group({ id: 1, value: 4 }), group({ id: 2, value: 2 })] })]);
    await service.persistCampaigns({ campaigns: [before] });
    const untouchedId = rows.find((row) => row.sourceGroupId === "2").id;

    const after = campaign([payout({ groups: [group({ id: 1, value: 5 }), group({ id: 2, value: 2 })] })]);
    const later = serviceFor(db, () => new Date("2026-09-11T12:00:00.000Z"));
    const summary = await later.persistCampaigns({ campaigns: [after], fetchedAt: new Date("2026-09-11T12:00:00.000Z") });
    assert.deepEqual(summary.persistErrors, []);

    assert.equal(rows.length, 3, "one new version for group 1, nothing else");
    const group1 = rows.filter((row) => row.sourceGroupId === "1").sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom));
    assert.equal(group1.length, 2);
    assert.equal(group1[0].ratePercent, 4);
    assert.ok(group1[0].effectiveUntil, "the prior version is closed, not overwritten");
    assert.equal(group1[1].ratePercent, 5);
    assert.equal(group1[1].effectiveUntil, null);
    assert.equal(group1[0].outcomeKey, group1[1].outcomeKey, "same identity, new version");
    assert.equal(group1[1].metadata.effectiveFromSource, "OBSERVED_CHANGE", "the supplier start_date did not move, so the change is versioned from observation");
    assert.equal(group1[1].metadata.payoutStartDate, "2026-01-01", "the supplier's own window is preserved");
    const group2 = rows.filter((row) => row.sourceGroupId === "2");
    assert.equal(group2.length, 1);
    assert.equal(group2[0].id, untouchedId);
    assert.equal(group2[0].effectiveUntil, null);
  });

  it("a moved supplier start_date versions from the supplier date", async () => {
    const { rows, db } = createRuleDb();
    await serviceFor(db).persistCampaigns({ campaigns: [campaign([payout({ start_date: "2026-01-01", groups: [group({ value: 4 })] })])] });
    await serviceFor(db, () => new Date("2026-09-11T12:00:00.000Z")).persistCampaigns({ campaigns: [campaign([payout({ start_date: "2026-07-01", groups: [group({ value: 5 })] })])] });
    // A different start_date is a different payout identity (window is payout semantics); both stay.
    assert.equal(openRows(rows).length, 2);
    assert.ok(rows.every((row) => row.metadata.effectiveFromSource === "SUPPLIER_START_DATE"));
  });

  it("closes the campaign-summary fan-out rules it supersedes, and nothing else", async () => {
    const { rows, db } = createRuleDb();
    const closedAt = new Date("2026-09-10T12:00:00.000Z");
    rows.push(
      { id: "summary-1", supplier: "BOOSTINY", sourceAccountLabel: "default", sourceObject: "campaigns", sourcePath: "commission", outcomeKey: "7001::campaigns::commission::9101::PERCENT::PERCENT_OF_SALE::::slot:1::", effectiveFrom: new Date("2026-01-05"), effectiveUntil: null, conditions: [] },
      { id: "summary-other", supplier: "BOOSTINY", sourceAccountLabel: "default", sourceObject: "campaigns", sourcePath: "commission", outcomeKey: "7002::campaigns::commission::1::PERCENT::PERCENT_OF_SALE::::slot:1::", effectiveFrom: new Date("2026-01-05"), effectiveUntil: null, conditions: [] },
      { id: "optimise-1", supplier: "OPTIMISE", sourceAccountLabel: "default", sourceObject: "campaigns", sourcePath: "commission", outcomeKey: "7001::campaigns::commission::x::PERCENT::PERCENT_OF_SALE::::slot:1::", effectiveFrom: new Date("2026-01-05"), effectiveUntil: null, conditions: [] },
    );
    const summary = await serviceFor(db, () => closedAt).persistCampaigns({ campaigns: [campaign([payout()], 7001)] });
    assert.equal(summary.supersededSummaryRules, 1);
    assert.equal(rows.find((row) => row.id === "summary-1").effectiveUntil, closedAt);
    assert.equal(rows.find((row) => row.id === "summary-other").effectiveUntil, null);
    assert.equal(rows.find((row) => row.id === "optimise-1").effectiveUntil, null);
    assert.equal(rows.find((row) => row.sourcePath === "payouts[0].groups[0]").effectiveUntil, null);
  });

  it("leaves campaigns without payout groups to the existing behaviour, and isolates one campaign's failure", async () => {
    const { rows, db } = createRuleDb();
    const summary = await serviceFor(db).persistCampaigns({
      campaigns: [
        { id: 1, name: "zzflatzz", payouts: [{ model: "cps", value: "8.5", currency: "USD" }] },
        { id: 2, name: "zznonezz" },
        campaign([payout()], 3),
        { id: 4, payouts: [{ model: "cps", groups: [group({ id: "zzbadzz", value: 4 })] }] },
      ],
    });
    assert.equal(summary.campaignsSeen, 4);
    assert.equal(summary.campaignsWithoutPayoutGroups, 2);
    assert.equal(summary.campaignsWithPayoutGroups, 2);
    assert.equal(summary.rulesPersisted, 2);
    assert.equal(rows.length, 2);
  });

  it("skips the campaign-summary fan-out ONLY for campaigns that carry payout groups", () => {
    const ids = serviceFor(createRuleDb().db).campaignIdsWithPayoutGroups([
      { id: 1, payouts: [{ model: "cps", value: "8.5", currency: "USD" }] },
      { id: 2 },
      campaign([payout()], 3),
      { id: 4, payouts: [{ model: "cps", groups: [] }] },
      { payouts: [payout()] },
    ]);
    assert.deepEqual([...ids], ["3"]);
  });

  it("reports an unlinked campaign and still persists its rules", async () => {
    const { rows, db } = createRuleDb({ supplierCampaign: null });
    const summary = await serviceFor(db).persistCampaigns({ campaigns: [campaign([payout()])] });
    assert.equal(summary.campaignsUnlinked, 1);
    assert.equal(rows[0].supplierCampaignId, null);
    assert.equal(rows[0].campaignSourceId, null);
  });

  it("performs no delete and no destructive overwrite of economics", () => {
    const code = codeOf(PERSIST_SRC);
    for (const forbidden of ["delete(", "deleteMany", "ratePercent:", "fixedAmount:"]) assert.ok(!code.includes(forbidden), forbidden);
    assert.match(code, /upsertNormalizedFact\(/);
  });
});

describe("sync wiring", () => {
  it("skips the campaign-summary fan-out for payout-group campaigns and persists them after staging", () => {
    const code = codeOf(SYNC_SRC);
    const block = code.split("async function syncBoostinyAccount")[1].split("async function syncBoostiny()")[0];
    assert.match(block, /new BoostinyCommissionPersistenceService\(\)/);
    assert.match(block, /campaignIdsWithPayoutGroups\(payload\.campaigns\)/);
    assert.match(block, /commissionRuleSkipCampaignIds: \[\.\.\.payoutGroupCampaignIds\]/);
    assert.ok(block.indexOf("upsertManyRawEntities({\n      networkSource: \"boostiny\",\n      entityType: \"campaign\"") < block.indexOf("persistCampaigns({"), "rules are persisted after campaigns are staged");
    assert.match(block, /commissionRules = \{ error: error\?\.message \|\| String\(error\) \}/, "a persistence failure never fails the sync");
    assert.match(block, /commissionRules,\n/);
  });

  it("changes no other supplier's sync", () => {
    const code = codeOf(SYNC_SRC);
    assert.equal((code.match(/BoostinyCommissionPersistenceService/g) ?? []).length, 2, "import + one construction");
    const optimise = code.split("async function syncOptimiseRegion")[1];
    assert.ok(!optimise.includes("Boostiny"));
  });
});

describe("existing commission mappings are unchanged", () => {
  it("the Boostiny campaign mapper still summarises the way it did", () => {
    const raw = { id: 624, name: "zzcampaignzz", payouts: [{ model: "cps", groups: [{ id: 72491, type: "sale-share", value: 4, priority: 1 }, { id: 72492, type: "sale-share", value: 2, priority: 2 }] }] };
    assert.equal(extractBoostinyPayout(raw).value, 4);
    const mapped = mapBoostinyCampaign({ entityType: "campaign", networkSource: "boostiny", externalId: "boostiny-campaign-624", rawData: raw });
    assert.equal(mapped.defaultCommissionValue, "4");
    assert.ok(Array.isArray(mapped.commissionGroups));
  });

  it("the Optimise mapper and the generic fan-out are untouched by the new module", () => {
    const optimise = mapOptimiseCommissionGroupCandidates([{ id: "G1", name: "Standard", commission: "10%" }], { sourceCampaignId: "123", networkSource: "optimise_sea" });
    assert.equal(optimise.length, 1);
    assert.equal(optimise[0].ratePercent, 10);
    const generic = extractCommissionRulesFromCampaignRaw({ id: 1, commissions: [{ id: "c1", type: "percentage", value: "5%" }] }, { sourceObject: "campaigns" });
    assert.equal(generic.length, 1);
    assert.equal(generic[0].ratePercent, 5);
  });

  it("uses no live values: every fixture value is a synthetic marker or a round number", () => {
    const rules = candidatesOf(campaign([payout({ groups: [QUALIFIED_GROUP] })]));
    const serialised = JSON.stringify(rules);
    for (const live of ["Samsung", "KSA", "72491", "Zalora"]) assert.ok(!serialised.includes(live), live);
  });

  it("detects the detailed structure only when a payout has groups", () => {
    assert.equal(campaignHasPayoutGroups({ payouts: [{ model: "cps", value: 8 }] }), false);
    assert.equal(campaignHasPayoutGroups({ payouts: [{ model: "cps", groups: [] }] }), false);
    assert.equal(campaignHasPayoutGroups(campaign([payout()])), true);
    assert.equal(campaignHasPayoutGroups({}), false);
  });
});
