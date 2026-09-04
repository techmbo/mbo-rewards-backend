/**
 * Generic SupplierCommissionRule safety: a numeric rate is never automatically
 * finance-ready, unverified rules never silently become expected supplier commission,
 * anonymous identity never depends on array position, condition order never versions.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SUPPLIER_COMMISSION_READINESS_VERSION,
  anonymousRuleIdentity,
  assessSupplierCommissionReadiness,
  canonicalConditionSignature,
} from "../src/modules/commercial/supplierCommissionReadiness.js";
import {
  calculateExpectedSupplierCommission,
  evaluateSupplierCommissionRule,
  matchSupplierCommissionRule,
} from "../src/modules/commercial/supplierCommissionMatcher.js";
import { extractCommissionRulesFromCampaignRaw } from "../src/modules/commercial/supplierCommissionRuleFanOut.js";
import {
  SUPPLIER_COMMISSION_RULE_FIELDS,
  enrichSupplierCommissionRuleRecord,
} from "../src/modules/commercial/supplierCommissionRule.contract.js";
import { SupplierCommissionRuleService } from "../src/modules/commercial/services/supplierCommissionRule.service.js";
import { upsertCommissionRulesForPreparedCampaigns } from "../src/modules/commercial/supplierCommissionRuleSync.service.js";

function rule(overrides = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
  return {
    id: overrides.id ?? "rule-1",
    commissionSequence: 1,
    basis: has("basis") ? overrides.basis : "PERCENT_OF_SALE",
    ratePercent: has("ratePercent") ? overrides.ratePercent : 10,
    fixedAmount: has("fixedAmount") ? overrides.fixedAmount : null,
    currency: has("currency") ? overrides.currency : "USD",
    priority: null,
    rank: null,
    metadata: has("metadata") ? overrides.metadata : null,
    mappingStatus: has("mappingStatus") ? overrides.mappingStatus : null,
    conditions: has("conditions") ? overrides.conditions : [],
    outcomeKey: overrides.outcomeKey ?? null,
  };
}

function createRuleDb() {
  const rows = [];
  let sequence = 0;
  const materialize = (nested) => (nested?.create ? nested.create.map((row, i) => ({ id: `cond-${i + 1}`, ...row })) : []);
  const model = {
    async findMany({ where }) {
      return rows
        .filter((r) => r.supplier === where.supplier && r.sourceAccountLabel === where.sourceAccountLabel && r.outcomeKey === where.outcomeKey)
        .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))
        .map((r) => ({ ...r, conditions: [...(r.conditions || [])] }));
    },
    async create({ data }) {
      sequence += 1;
      const row = { id: `rule-${sequence}`, createdAt: new Date(), ...data, conditions: materialize(data.conditions) };
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }) {
      const i = rows.findIndex((r) => r.id === where.id);
      const next = { ...rows[i], ...data };
      if (data.conditions) next.conditions = materialize(data.conditions);
      rows[i] = next;
      return { ...next };
    },
  };
  return { rows, db: { supplierCommissionRule: model, supplierCampaign: { findMany: async () => [] }, async $transaction(cb) { return cb({ supplierCommissionRule: model }); } } };
}

const fanOut = (entries, id = "camp-1") => extractCommissionRulesFromCampaignRaw({ id, commissionGroups: entries });

describe("generic supplier commission readiness — assessment", () => {
  it("1. clean explicit percent is finance-ready and the matcher can MATCH", () => {
    const [r] = fanOut([{ id: "R1", name: "Standard", commission: "10%" }]);
    assert.equal(r.mappingStatus, "MAPPED");
    assert.equal(r.metadata.financeReady, true);
    assert.deepEqual(r.metadata.reviewReasons, []);
    assert.equal(r.metadata.semanticStatus, "VERIFIED");
    assert.equal(r.metadata.readinessVersion, SUPPLIER_COMMISSION_READINESS_VERSION);
    const result = matchSupplierCommissionRule({ rules: [{ ...r, id: "db-1" }], facts: { orderValue: 100, currency: "USD" } });
    assert.equal(result.status, "MATCHED");
    assert.equal(result.expectedSupplierCommission, 10);
    assert.equal(result.matchedRuleFinanceReady, true);
  });

  it("2. explicit zero is finance-ready and calculates 0 (zero is not missing)", () => {
    const [r] = fanOut([{ id: "R0", name: "Excluded", commission: "0%" }]);
    assert.equal(r.ratePercent, 0);
    assert.equal(r.metadata.financeReady, true);
    assert.equal(r.mappingStatus, "MAPPED");
    const result = matchSupplierCommissionRule({ rules: [{ ...r, id: "db-0" }], facts: { orderValue: 100, currency: "USD" }, actualCommission: 0, actualCurrency: "USD" });
    assert.equal(result.status, "MATCHED");
    assert.equal(result.expectedSupplierCommission, 0);
    assert.equal(result.comparisonStatus, "MATCH");
    const fixedZero = assessSupplierCommissionReadiness(rule({ ratePercent: null, fixedAmount: 0, basis: "FIXED_PER_ORDER", currency: "USD" }));
    assert.equal(fixedZero.financeReady, true);
  });

  it("3. 'Up to 10%' is REVIEW_REQUIRED and the matcher never calculates 10% as truth", () => {
    const [r] = fanOut([{ id: "R-UP", name: "Ceiling", commission: "Up to 10%" }]);
    assert.equal(r.ratePercent, 10);
    assert.equal(r.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(r.metadata.financeReady, false);
    assert.ok(r.metadata.reviewReasons.includes("up_to_ceiling_not_exact_rate"));
    assert.equal(r.metadata.semanticStatus, "VERIFY_LIVE");
    const result = matchSupplierCommissionRule({ rules: [{ ...r, id: "db-up" }], facts: { orderValue: 100, currency: "USD" }, actualCommission: 7, actualCurrency: "USD" });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "unverified_supplier_rule_applicable");
    assert.equal(result.expectedSupplierCommission, null);
    assert.equal(result.networkActualCommission, 7, "network actual is preserved, not overwritten");
    assert.equal(result.actualCurrency, "USD");
    assert.deepEqual(result.readinessBlockedRuleIds, ["db-up"]);
  });

  it("4. bare numeric with no trustworthy unit/model is REVIEW_REQUIRED (no guessing)", () => {
    for (const value of [10, "10"]) {
      const [r] = fanOut([{ id: "R-BARE", name: "Bare", value }]);
      assert.equal(r.ratePercent, 10, "interpreted for display only");
      assert.equal(r.mappingStatus, "REVIEW_REQUIRED");
      assert.equal(r.metadata.financeReady, false);
      assert.ok(r.metadata.reviewReasons.includes("commission_unit_not_explicit"));
    }
    const [modelled] = fanOut([{ id: "R-CPS", name: "Modelled", value: 10, model: "cps" }]);
    assert.equal(modelled.metadata.financeReady, true, "verified CPS model makes the unit trustworthy");
  });

  it("5. fixed payout without currency is REVIEW_REQUIRED", () => {
    const a = assessSupplierCommissionReadiness(rule({ ratePercent: null, fixedAmount: 20, basis: "FIXED_PER_ORDER", currency: null }));
    assert.equal(a.financeReady, false);
    assert.equal(a.mappingStatus, "REVIEW_REQUIRED");
    assert.ok(a.reviewReasons.includes("fixed_payout_currency_missing"));
    const unknownBasis = assessSupplierCommissionReadiness(rule({ ratePercent: null, fixedAmount: 20, basis: "UNKNOWN", currency: "USD" }));
    assert.ok(unknownBasis.reviewReasons.includes("payout_basis_unknown"));
    const noOutcome = assessSupplierCommissionReadiness(rule({ ratePercent: null, fixedAmount: null }));
    assert.equal(noOutcome.mappingStatus, "UNMAPPED");
    assert.equal(noOutcome.semanticStatus, "UNMAPPED");
  });

  it("6. numeric payout with unverified tier/threshold/unknown condition semantics is REVIEW_REQUIRED", () => {
    for (const conditionType of ["COMMISSION_TIER", "PERFORMANCE_THRESHOLD", "OTHER_SOURCE_CONDITION", "CUSTOM_FIELD"]) {
      const a = assessSupplierCommissionReadiness(rule({ conditions: [{ conditionType, operator: "EQ", value: "x", sourceConditionType: "mystery" }] }));
      assert.equal(a.financeReady, false, conditionType);
      assert.ok(a.reviewReasons.includes(`unverified_condition_semantics:${conditionType}`));
    }
    const verifiedByMapper = assessSupplierCommissionReadiness(
      rule({ conditions: [{ conditionType: "COMMISSION_TIER", operator: "EQ", value: "1", metadata: { matcherReady: true } }] }),
    );
    assert.equal(verifiedByMapper.financeReady, true, "network-specific mapper may verify a semantic explicitly");
    const known = assessSupplierCommissionReadiness(rule({ conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }] }));
    assert.equal(known.financeReady, true);
  });

  it("enrichSupplierCommissionRuleRecord no longer maps a bare number by presence alone", () => {
    const clean = enrichSupplierCommissionRuleRecord({ ratePercent: 12, sourceRuleId: "rule-1" }, { networkSource: "optimise_sea" });
    assert.equal(clean.mappingStatus, "MAPPED");
    assert.equal(clean.metadata.financeReady, true);
    const upTo = enrichSupplierCommissionRuleRecord({ ratePercent: 12, sourceRuleId: "rule-2" }, { factDisplay: "Up to 12%" });
    assert.equal(upTo.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(upTo.metadata.financeReady, false);
    const noValue = enrichSupplierCommissionRuleRecord({ sourceRuleId: "rule-3" });
    assert.equal(noValue.mappingStatus, "UNMAPPED");
    assert.notEqual(noValue.mappingStatus, "NEEDS_REVIEW");
    const explicit = enrichSupplierCommissionRuleRecord({ ratePercent: 5, mappingStatus: "REVIEW_REQUIRED", metadata: { financeReady: false, reviewReasons: ["x"] } });
    assert.equal(explicit.mappingStatus, "REVIEW_REQUIRED", "explicit network-specific status preserved");
    assert.equal(explicit.metadata.financeReady, false);
  });
});

describe("generic supplier commission readiness — matcher fail-closed", () => {
  it("7. CRITICAL: unready specific rule blocks the broader finance-ready default", () => {
    const result = matchSupplierCommissionRule({
      rules: [
        rule({ id: "default-5", ratePercent: 5 }),
        rule({
          id: "new-up-to-15",
          ratePercent: 15,
          mappingStatus: "REVIEW_REQUIRED",
          metadata: { financeReady: false, reviewReasons: ["up_to_ceiling_not_exact_rate"] },
          conditions: [{ conditionType: "CUSTOMER_TYPE", operator: "EQ", value: "NEW" }],
        }),
      ],
      facts: { customerType: "NEW", orderValue: 200, currency: "USD" },
      actualCommission: 20,
      actualCurrency: "USD",
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "unverified_supplier_rule_applicable");
    assert.notEqual(result.matchedSupplierCommissionRuleId, "default-5");
    assert.equal(result.expectedSupplierCommission, null);
    assert.deepEqual(result.candidateRuleIds, ["new-up-to-15"]);
    assert.ok(result.reviewReasons.includes("up_to_ceiling_not_exact_rate"));
    assert.equal(result.networkActualCommission, 20);
    // the same order for an EXISTING customer is unaffected: the specific rule does not apply
    const existing = matchSupplierCommissionRule({
      rules: [
        rule({ id: "default-5", ratePercent: 5 }),
        rule({ id: "new-up-to-15", ratePercent: 15, metadata: { financeReady: false }, conditions: [{ conditionType: "CUSTOMER_TYPE", operator: "EQ", value: "NEW" }] }),
      ],
      facts: { customerType: "EXISTING", orderValue: 200, currency: "USD" },
    });
    assert.equal(existing.status, "MATCHED");
    assert.equal(existing.matchedSupplierCommissionRuleId, "default-5");
    assert.equal(existing.expectedSupplierCommission, 10);
  });

  it("7b. unready specific rule with missing facts (UNKNOWN) also blocks", () => {
    const result = matchSupplierCommissionRule({
      rules: [
        rule({ id: "default-5", ratePercent: 5 }),
        rule({ id: "coupon-unready", ratePercent: 15, metadata: { financeReady: false }, conditions: [{ conditionType: "COUPON", operator: "EQ", value: "VIP" }] }),
      ],
      facts: { orderValue: 100, currency: "USD" },
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "unverified_supplier_rule_applicable");
    assert.ok(result.reviewReasons.includes("missing_fact:COUPON"));
  });

  it("7c. an unready default alone yields REVIEW_REQUIRED, not NO_MATCH and not a payout", () => {
    const result = matchSupplierCommissionRule({
      rules: [rule({ id: "only-default", ratePercent: 5, metadata: { financeReady: false, reviewReasons: ["commission_unit_not_explicit"] } })],
      facts: { orderValue: 100, currency: "USD" },
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.expectedSupplierCommission, null);
  });

  it("8. irrelevant unready rule (NO_MATCH) does not block a valid applicable rule", () => {
    const result = matchSupplierCommissionRule({
      rules: [
        rule({ id: "ae-unready", ratePercent: 20, metadata: { financeReady: false }, conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }] }),
        rule({ id: "us-ready", ratePercent: 8, conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "US" }] }),
      ],
      facts: { country: "US", orderValue: 100, currency: "USD" },
    });
    assert.equal(result.status, "MATCHED");
    assert.equal(result.matchedSupplierCommissionRuleId, "us-ready");
    assert.equal(result.expectedSupplierCommission, 8);
  });

  it("9. network-specific readiness is preserved (Optimise and Rakuten shapes)", () => {
    const optimiseReady = rule({ id: "opt-ready", ratePercent: 12, mappingStatus: "VERIFIED", metadata: { financeReady: true, reviewReasons: [], semanticStatus: "VERIFIED" } });
    const optimiseBlocked = rule({
      id: "opt-blocked",
      ratePercent: 12,
      mappingStatus: "REVIEW_REQUIRED",
      metadata: { financeReady: false, reviewReasons: ["band_selection_semantics_not_verified_live"], semanticStatus: "VERIFY_LIVE" },
      conditions: [{ conditionType: "OTHER_SOURCE_CONDITION", operator: "EQ", value: "VERIFY_LIVE", sourceConditionType: "MBO_VERIFY_LIVE_GATE" }],
    });
    const rakutenReady = rule({ id: "rk-ready", ratePercent: 3, basis: "PERCENT_OF_SALE", mappingStatus: "VERIFIED", metadata: { financeReady: true, promotionGate: "VERIFIED_FINANCE_READY_ONLY" } });
    const rakutenBlocked = rule({ id: "rk-blocked", ratePercent: null, fixedAmount: 2, basis: "FIXED_PER_ACTION_OR_ITEM", currency: "USD", mappingStatus: "REVIEW_REQUIRED", metadata: { financeReady: false, reviewReasons: ["tier_boundary_fact_mapping_required"] } });

    assert.equal(assessSupplierCommissionReadiness(optimiseReady).decisionSource, "NETWORK_SPECIFIC");
    assert.equal(assessSupplierCommissionReadiness(optimiseReady).financeReady, true);
    assert.equal(assessSupplierCommissionReadiness(optimiseBlocked).financeReady, false);
    assert.deepEqual(assessSupplierCommissionReadiness(optimiseBlocked).reviewReasons, ["band_selection_semantics_not_verified_live"]);
    assert.equal(assessSupplierCommissionReadiness(rakutenBlocked).financeReady, false);

    const facts = { orderValue: 100, currency: "USD" };
    assert.equal(matchSupplierCommissionRule({ rules: [optimiseReady], facts }).expectedSupplierCommission, 12);
    assert.equal(matchSupplierCommissionRule({ rules: [rakutenReady], facts }).expectedSupplierCommission, 3);
    for (const blocked of [optimiseBlocked, rakutenBlocked]) {
      const r = matchSupplierCommissionRule({ rules: [blocked], facts });
      assert.equal(r.status, "REVIEW_REQUIRED");
      assert.equal(r.expectedSupplierCommission, null);
    }
    // explicit true is still subject to normal calculation safety
    const readyButUnsafe = rule({ id: "opt-cpm", ratePercent: null, fixedAmount: 1, basis: "CPM", currency: "USD", metadata: { financeReady: true } });
    const unsafe = matchSupplierCommissionRule({ rules: [readyButUnsafe], facts });
    assert.equal(unsafe.status, "REVIEW_REQUIRED");
    assert.equal(unsafe.reason, "supplier_commission_calculation_not_safe");
    assert.equal(calculateExpectedSupplierCommission(readyButUnsafe, facts).reason, "missing_impressions");
  });
});

describe("generic supplier commission readiness — identity", () => {
  const runA = [
    { name: "New customers", commission: "10%", customer_type: "NEW" },
    { name: "Existing customers", commission: "5%", customer_type: "EXISTING" },
  ];
  const runB = [runA[1], runA[0]];

  it("10. anonymous reorder keeps the same outcomeKeys; no ANON_SOURCE_ENTRY_n identity", async () => {
    const a = fanOut(runA);
    const b = fanOut(runB);
    const byName = (rules) => Object.fromEntries(rules.map((r) => [r.sourceRuleName, r.outcomeKey]));
    assert.deepEqual(byName(a), byName(b));
    assert.ok(a.every((r) => !/ANON_SOURCE_ENTRY_/.test(r.outcomeKey)));
    assert.ok(a.every((r) => r.sourceRuleId === null && r.sourceGroupId === null), "no manufactured supplier ids");
    assert.ok(a.every((r) => r.metadata.identityStrategy === "ANONYMOUS_SEMANTIC_FINGERPRINT"));
    assert.deepEqual(a.map((r) => r.metadata.sourceEntryIndex), [1, 2], "array position kept as evidence only");
    assert.deepEqual(b.map((r) => r.metadata.sourceEntryIndex), [1, 2]);

    const { rows, db } = createRuleDb();
    const service = new SupplierCommissionRuleService({ prisma: db });
    const persist = async (rules, at) => {
      for (const r of rules) await service.upsertNormalizedFact({ ...r, supplier: "IMPACT", sourceAccountLabel: "default", sourceEvidenceAt: at });
    };
    await persist(a, new Date("2026-09-01T00:00:00.000Z"));
    await persist(b, new Date("2026-09-02T00:00:00.000Z"));
    assert.equal(rows.length, 2, "no new versions solely because of reorder");
    assert.ok(rows.every((r) => r.effectiveUntil == null));
  });

  it("11. semantically identifiable anonymous rule 10% → 12% versions the same logical outcome", async () => {
    const [before] = fanOut([{ name: "New customers", commission: "10%", customer_type: "NEW" }]);
    const [after] = fanOut([{ name: "New customers", commission: "12%", customer_type: "NEW" }]);
    assert.equal(before.outcomeKey, after.outcomeKey);
    const { rows, db } = createRuleDb();
    const service = new SupplierCommissionRuleService({ prisma: db });
    await service.upsertNormalizedFact({ ...before, supplier: "IMPACT", sourceAccountLabel: "default", sourceEvidenceAt: new Date("2026-09-01T00:00:00.000Z") });
    const changedAt = new Date("2026-09-05T00:00:00.000Z");
    await service.upsertNormalizedFact({ ...after, supplier: "IMPACT", sourceAccountLabel: "default", sourceEvidenceAt: changedAt });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ratePercent, 10);
    assert.equal(new Date(rows[0].effectiveUntil).toISOString(), changedAt.toISOString());
    assert.equal(rows[1].ratePercent, 12);
    assert.equal(rows[1].effectiveUntil, null);
  });

  it("12. insufficient anonymous identity is REVIEW_REQUIRED, not finance-ready, evidence retained, no array position", () => {
    const rules = fanOut([{ commission: "10%" }, { commission: "7%" }]);
    assert.equal(rules.length, 2);
    for (const r of rules) {
      assert.equal(r.mappingStatus, "REVIEW_REQUIRED");
      assert.equal(r.metadata.financeReady, false);
      assert.ok(r.metadata.reviewReasons.includes("anonymous_rule_identity_insufficient"));
      assert.equal(r.metadata.identityStrategy, "ANONYMOUS_INSUFFICIENT");
      assert.ok(r.outcomeKey.includes("::ANON_UNIDENTIFIED:"));
      assert.ok(!/ANON_SOURCE_ENTRY_|ENTRY_\d|index/i.test(r.outcomeKey));
      assert.ok(r.rawRuleReference);
    }
    // two completely indistinguishable anonymous entries collapse (fail closed)
    const collapsed = fanOut([{ commission: "10%" }, { commission: "10%" }]);
    assert.equal(collapsed.length, 1);
    const identity = anonymousRuleIdentity({ entry: { commission: "10%" }, kind: "PERCENT", basis: "PERCENT_OF_SALE" });
    assert.equal(identity.sufficient, false);
    const result = matchSupplierCommissionRule({ rules: [{ ...rules[0], id: "anon" }], facts: { orderValue: 100, currency: "USD" } });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.expectedSupplierCommission, null);
  });

  it("13. condition reorder keeps the same outcomeKey and does not create a new version", async () => {
    const forward = { id: "R-AE", commission: "12%", conditions: [{ type: "country", value: "AE" }, { type: "customer_type", value: "NEW" }] };
    const reversed = { ...forward, conditions: [forward.conditions[1], forward.conditions[0]] };
    const [a] = fanOut([forward]);
    const [b] = fanOut([reversed]);
    assert.equal(a.outcomeKey, b.outcomeKey);
    assert.deepEqual(a.conditions.map((c) => c.conditionType), ["COUNTRY", "CUSTOMER_TYPE"], "persisted order untouched");
    assert.deepEqual(b.conditions.map((c) => c.conditionType), ["CUSTOMER_TYPE", "COUNTRY"]);
    assert.equal(
      canonicalConditionSignature([{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }, { conditionType: "CUSTOMER_TYPE", operator: "EQ", value: "NEW" }]),
      canonicalConditionSignature([{ conditionType: "CUSTOMER_TYPE", operator: "EQ", value: "NEW" }, { conditionType: "COUNTRY", operator: "EQ", value: "AE" }]),
    );
    const { rows, db } = createRuleDb();
    const service = new SupplierCommissionRuleService({ prisma: db });
    await service.upsertNormalizedFact({ ...a, supplier: "IMPACT", sourceAccountLabel: "default", sourceEvidenceAt: new Date("2026-09-01T00:00:00.000Z") });
    await service.upsertNormalizedFact({ ...b, supplier: "IMPACT", sourceAccountLabel: "default", sourceEvidenceAt: new Date("2026-09-02T00:00:00.000Z") });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].effectiveUntil, null);
  });

  it("14. same-dimension country alternatives stay OR after identity canonicalisation", () => {
    const [a] = fanOut([{ id: "R-GCC", commission: "9%", countries: ["SA", "AE"] }]);
    const [b] = fanOut([{ id: "R-GCC", commission: "9%", countries: ["AE", "SA"] }]);
    assert.equal(a.outcomeKey, b.outcomeKey);
    assert.equal(a.conditions.filter((c) => c.conditionType === "COUNTRY").length, 2);
    const r = { ...a, id: "gcc" };
    assert.equal(evaluateSupplierCommissionRule(r, { country: "AE" }).state, "MATCH");
    assert.equal(evaluateSupplierCommissionRule(r, { country: "SA" }).state, "MATCH");
    assert.equal(evaluateSupplierCommissionRule(r, { country: "US" }).state, "NO_MATCH");
    const matched = matchSupplierCommissionRule({ rules: [r], facts: { country: "AE", orderValue: 100, currency: "USD" } });
    assert.equal(matched.status, "MATCHED");
    assert.equal(matched.expectedSupplierCommission, 9);
  });
});

describe("generic supplier commission readiness — persistence", () => {
  it("15. generic campaign sync persists readiness evidence and the matcher observes it", async () => {
    const writes = [];
    const deps = {
      prisma: { supplierCampaign: { findMany: async () => [] } },
      ruleService: { upsertNormalizedFact: async (input) => { writes.push(input); return { id: `w${writes.length}` }; } },
    };
    await upsertCommissionRulesForPreparedCampaigns(
      {
        networkSource: "optimise_sea",
        sourceAccountKey: "default",
        preparedRecords: [
          {
            originalPayload: {
              id: "123",
              commissionGroups: [
                { id: "CLEAN", name: "Standard", commission: "10%" },
                { id: "UPTO", name: "Ceiling", commission: "Up to 15%", customer_type: "NEW" },
              ],
            },
          },
        ],
      },
      deps,
    );
    assert.equal(writes.length, 2);
    const clean = writes.find((w) => w.sourceRuleId === "CLEAN");
    const upTo = writes.find((w) => w.sourceRuleId === "UPTO");
    assert.equal(clean.mappingStatus, "MAPPED");
    assert.equal(clean.metadata.financeReady, true);
    assert.deepEqual(clean.metadata.reviewReasons, []);
    assert.equal(clean.metadata.semanticStatus, "VERIFIED");
    assert.equal(clean.metadata.readinessVersion, SUPPLIER_COMMISSION_READINESS_VERSION);
    assert.equal(upTo.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(upTo.metadata.financeReady, false);
    assert.ok(upTo.metadata.reviewReasons.includes("up_to_ceiling_not_exact_rate"));
    assert.equal(upTo.metadata.semanticStatus, "VERIFY_LIVE");
    // existing metadata preserved
    for (const w of writes) {
      assert.equal(w.metadata.sourceCampaignId, "123");
      assert.equal(w.metadata.sourceEffectiveFromProvided, false);
      assert.ok("brandName" in w.metadata && "campaignName" in w.metadata);
    }
    // the matcher observes the persisted decision: NEW customer → REVIEW_REQUIRED, other → 10%
    const persisted = writes.map((w, i) => ({ ...w, id: `db-${i}` }));
    const newCustomer = matchSupplierCommissionRule({ rules: persisted, facts: { customerType: "NEW", orderValue: 100, currency: "USD" } });
    assert.equal(newCustomer.status, "REVIEW_REQUIRED");
    assert.equal(newCustomer.expectedSupplierCommission, null);
    const other = matchSupplierCommissionRule({ rules: persisted, facts: { customerType: "EXISTING", orderValue: 100, currency: "USD" } });
    assert.equal(other.status, "MATCHED");
    assert.equal(other.expectedSupplierCommission, 10);
  });

  it("contract field list covers the canonical architecture without commission_N columns", () => {
    for (const field of ["sourceCampaignId", "sourceGroupId", "sourceGroupName", "sourceRuleId", "sourceRuleName", "outcomeKey", "outcomeSlot", "commissionSequence", "commissionModel", "commissionType", "supplierRuleType", "basis", "ratePercent", "fixedAmount", "currency", "conditions", "effectiveFrom", "effectiveUntil", "networkSource", "sourceObject", "sourcePath", "mappingStatus", "fieldMappingOutcome", "ruleVersion"]) {
      assert.ok(SUPPLIER_COMMISSION_RULE_FIELDS.includes(field), field);
    }
    assert.ok(!SUPPLIER_COMMISSION_RULE_FIELDS.some((f) => /^commission_\d+$/.test(f)));
    assert.equal(new Set(SUPPLIER_COMMISSION_RULE_FIELDS).size, SUPPLIER_COMMISSION_RULE_FIELDS.length);
  });
});
