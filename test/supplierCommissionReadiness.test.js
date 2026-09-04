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
  reconcileSourceEconomics,
  sourceEconomicsFacts,
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
    // Generic fixture rules carry the raw supplier fragment so the GENERIC path is exercised
    // with trustworthy evidence; legacy tests override rawRuleReference with null.
    rawRuleReference: has("rawRuleReference")
      ? overrides.rawRuleReference
      : (has("ratePercent") ? overrides.ratePercent : 10) != null
        ? { commission: `${has("ratePercent") ? overrides.ratePercent : 10}%` }
        : { amount: overrides.fixedAmount ?? null, currency: has("currency") ? overrides.currency : "USD", model: has("basis") ? overrides.basis : "CPA" },
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
    const identityOnly = enrichSupplierCommissionRuleRecord({ ratePercent: 12, sourceRuleId: "rule-1" }, { networkSource: "optimise_sea" });
    assert.equal(identityOnly.mappingStatus, "REVIEW_REQUIRED", "sourceRuleId proves identity, not semantics");
    assert.equal(identityOnly.metadata.financeReady, false);
    assert.ok(identityOnly.metadata.reviewReasons.includes("legacy_readiness_evidence_missing"));
    const clean = enrichSupplierCommissionRuleRecord({ ratePercent: 12, sourceRuleId: "rule-1", rawRuleReference: { commission: "12%" } }, { networkSource: "optimise_sea" });
    assert.equal(clean.mappingStatus, "MAPPED");
    assert.equal(clean.metadata.financeReady, true);
    const modelled = enrichSupplierCommissionRuleRecord({ ratePercent: 12, sourceRuleId: "rule-1", commissionModel: "cps" });
    assert.equal(modelled.metadata.financeReady, true, "supplier-provided payout model is trustworthy evidence");
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

describe("generic supplier commission readiness — legacy persisted rows", () => {
  const legacy = (overrides = {}) => ({
    id: "legacy-1",
    sourceRuleId: "R1",
    commissionSequence: 1,
    supplierRuleType: "PERCENT",
    commissionType: "PERCENTAGE",
    basis: "PERCENT_OF_SALE",
    ratePercent: 10,
    fixedAmount: null,
    currency: null,
    mappingStatus: "MAPPED",
    metadata: null,
    rawRuleReference: null,
    conditions: [],
    outcomeKey: "123::campaigns::commission::R1::PERCENT::PERCENT_OF_SALE::::slot:1::",
    ...overrides,
  });

  it("1. persisted legacy bare percent row with no readiness evidence fails closed", () => {
    const a = assessSupplierCommissionReadiness(legacy({ mappingStatus: null }));
    assert.equal(a.financeReady, false);
    assert.equal(a.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(a.semanticStatus, "VERIFY_LIVE");
    assert.ok(a.reviewReasons.includes("legacy_readiness_evidence_missing"));
    assert.equal(a.decisionSource, "GENERIC");
    assert.deepEqual(a.evidenceSources, []);
  });

  it("2. CRITICAL: matcher never calculates from a legacy bare numeric row; network actual preserved", () => {
    const result = matchSupplierCommissionRule({
      rules: [legacy()],
      facts: { orderValue: 100, currency: "USD" },
      actualCommission: 9.5,
      actualCurrency: "USD",
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "unverified_supplier_rule_applicable");
    assert.equal(result.expectedSupplierCommission, null);
    assert.equal(result.matchedSupplierCommissionRuleId, null);
    assert.ok(result.reviewReasons.includes("legacy_readiness_evidence_missing"));
    assert.equal(result.networkActualCommission, 9.5);
    assert.equal(result.actualCurrency, "USD");
    // a legacy specific row also blocks a verified default instead of falling through
    const blocked = matchSupplierCommissionRule({
      rules: [
        rule({ id: "default-5", ratePercent: 5, metadata: { financeReady: true } }),
        legacy({ id: "legacy-new", conditions: [{ conditionType: "CUSTOMER_TYPE", operator: "EQ", value: "NEW" }] }),
      ],
      facts: { customerType: "NEW", orderValue: 100, currency: "USD" },
    });
    assert.equal(blocked.status, "REVIEW_REQUIRED");
    assert.equal(blocked.expectedSupplierCommission, null);
  });

  it("3. legacy MAPPED status alone does not prove readiness", () => {
    const a = assessSupplierCommissionReadiness(legacy({ mappingStatus: "MAPPED" }));
    assert.equal(a.financeReady, false);
    assert.ok(a.reviewReasons.includes("legacy_readiness_evidence_missing"));
  });

  it("4. sourceRuleId / sourceGroupId / outcomeKey / basis are lineage or derived, not semantics", () => {
    const a = assessSupplierCommissionReadiness(legacy({ sourceRuleId: "R1", sourceGroupId: "G1", supplierRuleType: "PERCENT", commissionType: "PERCENTAGE" }));
    assert.equal(a.financeReady, false);
    assert.ok(a.reviewReasons.includes("legacy_readiness_evidence_missing"));
  });

  it("5. legacy row with explicit raw percent evidence becomes finance-ready", () => {
    const a = assessSupplierCommissionReadiness(legacy({ rawRuleReference: { commission: "10%" } }));
    assert.equal(a.financeReady, true);
    assert.equal(a.mappingStatus, "MAPPED");
    assert.deepEqual(a.evidenceSources, ["raw_rule_reference"]);
    const m = matchSupplierCommissionRule({ rules: [legacy({ rawRuleReference: { commission: "10%" } })], facts: { orderValue: 100, currency: "USD" } });
    assert.equal(m.status, "MATCHED");
    assert.equal(m.expectedSupplierCommission, 10);
  });

  it("6. legacy row whose raw fragment is a bare number stays REVIEW_REQUIRED", () => {
    const a = assessSupplierCommissionReadiness(legacy({ rawRuleReference: { commission: 10 } }));
    assert.equal(a.financeReady, false);
    assert.ok(a.reviewReasons.includes("commission_unit_not_explicit"));
    assert.ok(!a.reviewReasons.includes("legacy_readiness_evidence_missing"));
    // a normalized "10%" display never substitutes for source unit evidence
    const displayOnly = assessSupplierCommissionReadiness(legacy({ rawRuleReference: { commission: 10 }, metadata: { factDisplay: "10%" } }));
    assert.equal(displayOnly.financeReady, false);
  });

  it("7. legacy fixed row is ready only with explicit raw currency/model evidence", () => {
    const base = legacy({ ratePercent: null, fixedAmount: 20, currency: "USD", basis: "CPA", supplierRuleType: "FIXED", commissionType: "FIXED" });
    const bare = assessSupplierCommissionReadiness(base);
    assert.equal(bare.financeReady, false);
    assert.equal(bare.mappingStatus, "REVIEW_REQUIRED");
    assert.ok(bare.reviewReasons.includes("legacy_readiness_evidence_missing"));
    const explicit = assessSupplierCommissionReadiness({ ...base, rawRuleReference: { commission: "USD 20", model: "CPA" } });
    assert.equal(explicit.financeReady, true);
    const modelOnly = assessSupplierCommissionReadiness({ ...base, commissionModel: "cpa" });
    assert.equal(modelOnly.financeReady, true, "supplier-provided model column is source evidence");
    const numberOnly = assessSupplierCommissionReadiness({ ...base, rawRuleReference: { amount: 20 } });
    assert.equal(numberOnly.financeReady, false);
    assert.ok(numberOnly.reviewReasons.includes("commission_unit_not_explicit"));
  });

  it("8. new fan-out rows are unaffected", () => {
    const rows = fanOut([
      { id: "A", commission: "10%" },
      { id: "B", commission: "0%" },
      { id: "C", commission: "Up to 10%" },
      { id: "D", value: 10 },
      { id: "E", value: 10, model: "cps" },
      { id: "F", commission: "USD 20", currency: "USD" },
      { id: "G", value: 20, model: "cpa" },
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.sourceRuleId, r]));
    assert.equal(byId.A.metadata.financeReady, true);
    assert.equal(byId.B.metadata.financeReady, true);
    assert.equal(byId.B.ratePercent, 0);
    assert.equal(byId.C.metadata.financeReady, false);
    assert.equal(byId.D.metadata.financeReady, false);
    assert.ok(byId.D.metadata.reviewReasons.includes("commission_unit_not_explicit"));
    assert.equal(byId.E.metadata.financeReady, true);
    assert.equal(byId.F.metadata.financeReady, true);
    assert.equal(byId.G.metadata.financeReady, false, "fixed without currency");
    assert.ok(byId.G.metadata.reviewReasons.includes("fixed_payout_currency_missing"));
    assert.ok(rows.every((r) => r.metadata.readinessEvidenceSources.includes("source_text")));
    // persisted shape of a new row (metadata carried) is still assessed by its explicit decision
    assert.equal(assessSupplierCommissionReadiness({ ...byId.A, rawRuleReference: null }).financeReady, true);
    assert.equal(assessSupplierCommissionReadiness({ ...byId.A, rawRuleReference: null }).decisionSource, "NETWORK_SPECIFIC");
  });

  it("9. network-specific explicit decisions remain authoritative", () => {
    const facts = { orderValue: 100, currency: "USD" };
    for (const network of ["optimise_sea", "rakuten", "cj"]) {
      const ready = legacy({ id: `${network}-ready`, networkSource: network, mappingStatus: "VERIFIED", metadata: { financeReady: true } });
      const blocked = legacy({ id: `${network}-blocked`, networkSource: network, mappingStatus: "REVIEW_REQUIRED", metadata: { financeReady: false, reviewReasons: ["network_specific_reason"] } });
      assert.equal(assessSupplierCommissionReadiness(ready).financeReady, true, network);
      assert.equal(matchSupplierCommissionRule({ rules: [ready], facts }).expectedSupplierCommission, 10, network);
      const b = matchSupplierCommissionRule({ rules: [blocked], facts });
      assert.equal(b.status, "REVIEW_REQUIRED", network);
      assert.equal(b.expectedSupplierCommission, null);
      assert.ok(b.reviewReasons.includes("network_specific_reason"));
    }
  });

  it("10. re-sync enriches a legacy open row with readiness metadata without a false rate version", async () => {
    const { rows, db } = createRuleDb();
    const [candidate] = fanOut([{ id: "R1", name: "Standard", commission: "10%" }], "123");
    // legacy persisted row: same economics and logical identity, no readiness metadata
    rows.push({
      id: "legacy-open",
      supplier: "IMPACT",
      sourceAccountLabel: "default",
      outcomeKey: candidate.outcomeKey,
      supplierRuleType: "PERCENT",
      basis: "PERCENT_OF_SALE",
      ratePercent: 10,
      fixedAmount: null,
      currency: null,
      commissionModel: null,
      commissionType: "PERCENTAGE",
      actionType: null,
      mappingStatus: "MAPPED",
      metadata: null,
      rawRuleReference: null,
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
      effectiveUntil: null,
      conditions: [],
    });
    assert.equal(assessSupplierCommissionReadiness(rows[0]).financeReady, false, "legacy row blocked before re-sync");

    const service = new SupplierCommissionRuleService({ prisma: db });
    const updated = await service.upsertNormalizedFact({
      ...candidate,
      supplier: "IMPACT",
      sourceAccountLabel: "default",
      sourceEvidenceAt: new Date("2026-09-10T00:00:00.000Z"),
    });

    assert.equal(updated.id, "legacy-open", "same economic version reused");
    assert.equal(rows.length, 1, "no false rate-history version");
    assert.equal(rows[0].effectiveUntil, null);
    assert.equal(rows[0].ratePercent, 10);
    assert.equal(rows[0].metadata.financeReady, true);
    assert.equal(rows[0].metadata.semanticStatus, "VERIFIED");
    assert.deepEqual(rows[0].rawRuleReference, { id: "R1", name: "Standard", commission: "10%" });
    assert.equal(assessSupplierCommissionReadiness(rows[0]).financeReady, true, "matcher observes the enriched decision");
    const m = matchSupplierCommissionRule({ rules: [rows[0]], facts: { orderValue: 100, currency: "USD" } });
    assert.equal(m.status, "MATCHED");
    assert.equal(m.expectedSupplierCommission, 10);
  });
});

describe("generic supplier commission readiness — source economics must agree with the row", () => {
  const legacy = (overrides = {}) => ({
    id: "legacy-econ",
    sourceRuleId: "R1",
    commissionSequence: 1,
    basis: "PERCENT_OF_SALE",
    ratePercent: 10,
    fixedAmount: null,
    currency: null,
    mappingStatus: "MAPPED",
    metadata: null,
    rawRuleReference: { commission: "10%" },
    conditions: [],
    outcomeKey: "123::campaigns::commission::R1::PERCENT::PERCENT_OF_SALE::::slot:1::",
    ...overrides,
  });
  const fixedLegacy = (overrides = {}) =>
    legacy({ basis: "CPA", ratePercent: null, fixedAmount: 20, currency: "USD", rawRuleReference: { commission: "USD 20", model: "CPA" }, ...overrides });

  it("1. legacy percentage exact agreement is ready", () => {
    const a = assessSupplierCommissionReadiness(legacy());
    assert.equal(a.financeReady, true);
    assert.equal(a.sourceEconomics.reconciled, true);
    assert.equal(a.sourceEconomics.compared.sourceValue, 10);
  });

  it("2. legacy percentage mismatch fails closed", () => {
    const a = assessSupplierCommissionReadiness(legacy({ ratePercent: 20 }));
    assert.equal(a.financeReady, false);
    assert.equal(a.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(a.semanticStatus, "VERIFY_LIVE");
    assert.ok(a.reviewReasons.includes("source_economics_mismatch"));
    assert.deepEqual(a.sourceEconomics, { reconciled: false, compared: { kind: "PERCENT", sourceValue: 10, sourceCurrency: null, ruleValue: 20, ruleCurrency: null } });
  });

  it("3. explicit zero agreement is ready", () => {
    const a = assessSupplierCommissionReadiness(legacy({ ratePercent: 0, rawRuleReference: { commission: "0%" } }));
    assert.equal(a.financeReady, true);
    const mismatch = assessSupplierCommissionReadiness(legacy({ ratePercent: 0, rawRuleReference: { commission: "10%" } }));
    assert.equal(mismatch.financeReady, false);
    assert.ok(mismatch.reviewReasons.includes("source_economics_mismatch"));
  });

  it("4. fixed exact agreement (amount + currency + model) is ready", () => {
    const a = assessSupplierCommissionReadiness(fixedLegacy());
    assert.equal(a.financeReady, true);
    assert.equal(a.sourceEconomics.compared.sourceCurrency, "USD");
  });

  it("5. fixed amount mismatch fails closed", () => {
    const a = assessSupplierCommissionReadiness(fixedLegacy({ fixedAmount: 30 }));
    assert.equal(a.financeReady, false);
    assert.ok(a.reviewReasons.includes("source_economics_mismatch"));
  });

  it("6. fixed currency mismatch fails closed", () => {
    const a = assessSupplierCommissionReadiness(fixedLegacy({ currency: "AED" }));
    assert.equal(a.financeReady, false);
    assert.ok(a.reviewReasons.includes("source_economics_currency_mismatch"));
  });

  it("7. kind mismatch: source 10% vs fixed row fails closed", () => {
    const a = assessSupplierCommissionReadiness(legacy({ basis: "CPA", ratePercent: null, fixedAmount: 10, currency: "USD", rawRuleReference: { commission: "10%" } }));
    assert.equal(a.financeReady, false);
    assert.ok(a.reviewReasons.includes("source_economics_kind_mismatch"));
  });

  it("8. reverse kind mismatch: source USD 10 vs percent row fails closed", () => {
    const a = assessSupplierCommissionReadiness(legacy({ ratePercent: 10, rawRuleReference: { commission: "USD 10" } }));
    assert.equal(a.financeReady, false);
    assert.ok(a.reviewReasons.includes("source_economics_kind_mismatch"));
  });

  it("9. percent OR fixed: each sibling outcome reconciles to its own kind", () => {
    const raw = { commission: { type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value", value: "8% Or USD 20" } };
    const percent = assessSupplierCommissionReadiness(legacy({ ratePercent: 8, rawRuleReference: raw }));
    const fixed = assessSupplierCommissionReadiness(legacy({ basis: "FIXED_AMOUNT", ratePercent: null, fixedAmount: 20, currency: "USD", rawRuleReference: raw }));
    assert.equal(percent.financeReady, true);
    assert.equal(fixed.financeReady, true);
    const wrongPercent = assessSupplierCommissionReadiness(legacy({ ratePercent: 9, rawRuleReference: raw }));
    assert.ok(wrongPercent.reviewReasons.includes("source_economics_mismatch"));
    // the fan-out siblings from the same source both stay ready
    const rows = fanOut([{ id: "OR", ...raw }]);
    assert.deepEqual(rows.map((r) => [r.ratePercent, r.fixedAmount, r.metadata.financeReady]), [[8, null, true], [null, 20, true]]);
  });

  it("10. several distinct same-kind source facts are ambiguous", () => {
    const a = assessSupplierCommissionReadiness(legacy({ ratePercent: 10, rawRuleReference: { commission: "10% Or 12%" } }));
    assert.equal(a.financeReady, false);
    assert.ok(a.reviewReasons.includes("source_economics_ambiguous"));
    const facts = sourceEconomicsFacts({ rawRuleReference: { commission: "10% Or 12%" } });
    assert.deepEqual(facts.map((f) => f.value), [10, 12]);
    assert.deepEqual(reconcileSourceEconomics({ ratePercent: 10 }, facts).reasons, ["source_economics_ambiguous"]);
    // identical duplicates are not ambiguous
    assert.equal(reconcileSourceEconomics({ ratePercent: 10 }, [...facts.slice(0, 1), ...facts.slice(0, 1)]).reconciled, true);
  });

  it("11. trusted supplier model contradicting the payout shape fails closed", () => {
    const a = assessSupplierCommissionReadiness(legacy({ commissionModel: "cpa", rawRuleReference: null }));
    assert.equal(a.financeReady, false);
    assert.ok(a.reviewReasons.includes("source_model_shape_mismatch"));
    const consistent = assessSupplierCommissionReadiness(legacy({ commissionModel: "cps", rawRuleReference: null }));
    assert.equal(consistent.financeReady, true);
    const fixedConsistent = assessSupplierCommissionReadiness(fixedLegacy({ commissionModel: "cpa", rawRuleReference: null }));
    assert.equal(fixedConsistent.financeReady, true);
    const rawModelConflict = assessSupplierCommissionReadiness(legacy({ rawRuleReference: { commission: 10, model: "cpa" } }));
    assert.ok(rawModelConflict.reviewReasons.includes("source_economics_kind_mismatch"), "parser interprets a cpa model as fixed");
    const unknownModel = assessSupplierCommissionReadiness(legacy({ commissionModel: "mystery-model" }));
    assert.equal(unknownModel.financeReady, true, "unknown models establish nothing and are not invented");
  });

  it("12. CRITICAL: matcher never calculates from a row whose source says 10% but row says 20%", () => {
    const result = matchSupplierCommissionRule({
      rules: [legacy({ ratePercent: 20 })],
      facts: { orderValue: 100, currency: "USD" },
      actualCommission: 11,
      actualCurrency: "USD",
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.expectedSupplierCommission, null);
    assert.ok(result.reviewReasons.includes("source_economics_mismatch"));
    assert.equal(result.networkActualCommission, 11);
    assert.equal(result.actualCurrency, "USD");
    // a conflicting specific row still blocks a verified default
    const blocked = matchSupplierCommissionRule({
      rules: [rule({ id: "default-5", ratePercent: 5, metadata: { financeReady: true } }), legacy({ id: "conflict-new", ratePercent: 20, conditions: [{ conditionType: "CUSTOMER_TYPE", operator: "EQ", value: "NEW" }] })],
      facts: { customerType: "NEW", orderValue: 100, currency: "USD" },
    });
    assert.equal(blocked.status, "REVIEW_REQUIRED");
    assert.equal(blocked.expectedSupplierCommission, null);
  });

  it("13. re-sync repair: changed economics version; identical economics only enrich", async () => {
    const [candidate] = fanOut([{ id: "R1", name: "Standard", commission: "10%" }], "123");
    const legacyRow = (overrides = {}) => ({
      id: "legacy-open",
      supplier: "IMPACT",
      sourceAccountLabel: "default",
      outcomeKey: candidate.outcomeKey,
      supplierRuleType: "PERCENT",
      basis: "PERCENT_OF_SALE",
      ratePercent: 20,
      fixedAmount: null,
      currency: null,
      commissionModel: null,
      commissionType: "PERCENTAGE",
      actionType: null,
      mappingStatus: "MAPPED",
      metadata: null,
      rawRuleReference: { commission: "10%" },
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
      effectiveUntil: null,
      conditions: [],
      ...overrides,
    });

    // (a) conflicting legacy row (row 20%, source 10%): blocked; re-sync with correct 10% economics versions it
    {
      const { rows, db } = createRuleDb();
      rows.push(legacyRow());
      assert.equal(assessSupplierCommissionReadiness(rows[0]).financeReady, false);
      const service = new SupplierCommissionRuleService({ prisma: db });
      const changedAt = new Date("2026-09-10T00:00:00.000Z");
      const successor = await service.upsertNormalizedFact({ ...candidate, supplier: "IMPACT", sourceAccountLabel: "default", sourceEvidenceAt: changedAt });
      assert.notEqual(successor.id, "legacy-open", "economics genuinely changed → successor version");
      assert.equal(rows.length, 2);
      assert.equal(rows[0].ratePercent, 20);
      assert.equal(new Date(rows[0].effectiveUntil).toISOString(), changedAt.toISOString(), "predecessor closed, history preserved");
      assert.equal(rows[1].ratePercent, 10);
      assert.equal(rows[1].effectiveUntil, null);
      assert.equal(rows[1].metadata.financeReady, true);
      assert.equal(matchSupplierCommissionRule({ rules: [rows[1]], facts: { orderValue: 100, currency: "USD" } }).expectedSupplierCommission, 10);
    }

    // (b) identical economics, only readiness metadata missing: same version reused, no new history
    {
      const { rows, db } = createRuleDb();
      rows.push(legacyRow({ ratePercent: 10 }));
      const service = new SupplierCommissionRuleService({ prisma: db });
      const reused = await service.upsertNormalizedFact({ ...candidate, supplier: "IMPACT", sourceAccountLabel: "default", sourceEvidenceAt: new Date("2026-09-10T00:00:00.000Z") });
      assert.equal(reused.id, "legacy-open");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].effectiveUntil, null);
      assert.equal(rows[0].metadata.financeReady, true);
      assert.equal(rows[0].metadata.readinessVersion, SUPPLIER_COMMISSION_READINESS_VERSION);
    }
  });

  it("14. new generic fan-out unchanged (facts reconcile with themselves)", () => {
    const rows = fanOut([
      { id: "A", commission: "10%" },
      { id: "B", commission: "0%" },
      { id: "C", commission: "Up to 10%" },
      { id: "D", value: 10 },
      { id: "E", value: 10, model: "cps" },
      { id: "F", commission: "USD 20", currency: "USD" },
      { id: "G", value: 20, model: "cpa" },
      { id: "H", commission: { type: "Percentage Or Fixed Cost", value: "8.20% Or $17.50" } },
    ]);
    const byId = (id) => rows.filter((r) => r.sourceRuleId === id);
    assert.equal(byId("A")[0].metadata.financeReady, true);
    assert.equal(byId("B")[0].metadata.financeReady, true);
    assert.equal(byId("C")[0].metadata.financeReady, false);
    assert.equal(byId("D")[0].metadata.financeReady, false);
    assert.equal(byId("E")[0].metadata.financeReady, true);
    assert.equal(byId("F")[0].metadata.financeReady, true);
    assert.equal(byId("G")[0].metadata.financeReady, false);
    assert.deepEqual(byId("H").map((r) => [r.ratePercent, r.fixedAmount, r.currency, r.metadata.financeReady]), [[8.2, null, null, true], [null, 17.5, "USD", true]]);
    assert.ok(rows.every((r) => !r.metadata.reviewReasons.some((reason) => reason.startsWith("source_economics"))), "no false mismatches on fresh normalization");
  });

  it("15. Optimise / Rakuten / CJ explicit readiness is not re-interpreted through raw reconciliation", () => {
    const facts = { orderValue: 100, currency: "USD" };
    for (const network of ["optimise_sea", "rakuten", "cj"]) {
      // explicit true with a raw fragment that would generically look mismatched: mapper authority preserved
      const ready = legacy({ id: `${network}-ready`, networkSource: network, ratePercent: 12, mappingStatus: "VERIFIED", metadata: { financeReady: true }, rawRuleReference: { group: { commission: "10%" }, band: null } });
      const a = assessSupplierCommissionReadiness(ready);
      assert.equal(a.financeReady, true, network);
      assert.equal(a.decisionSource, "NETWORK_SPECIFIC");
      assert.equal(matchSupplierCommissionRule({ rules: [ready], facts }).expectedSupplierCommission, 12);
      const blocked = legacy({ id: `${network}-blocked`, networkSource: network, metadata: { financeReady: false, reviewReasons: ["network_specific_reason"] } });
      const b = matchSupplierCommissionRule({ rules: [blocked], facts });
      assert.equal(b.status, "REVIEW_REQUIRED");
      assert.equal(b.expectedSupplierCommission, null);
    }
  });
});
