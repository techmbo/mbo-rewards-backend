import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyClientShareRatio,
  clientShareRatio,
} from "../src/modules/commercial/commissionMath.js";
import { applyCommissionRuleToGross } from "../src/modules/reporting/attributionMath.js";
import { calculateClientCommercialPayout } from "../src/modules/commercial/clientCommercialCalculation.js";
import { ClientCommercialRuntimeService } from "../src/modules/commercial/services/clientCommercialRuntime.service.js";

/**
 * Client share is a whole-number percent expressed as a ClientCommissionRule ratio pair
 * (gross=100, client=70 → 70%). Two engines consume that pair:
 *   - attribution: applyCommissionRuleToGross → Conversion.clientCommission / mboCommission
 *   - commercial/finance: calculateClientCommercialPayout → FinancialTransaction.clientPayable / mboMargin
 * Both must derive the client amount through the one canonical expression in commissionMath.js.
 * Before unification the commercial engine computed amount × ((client ÷ gross) × 100) ÷ 100, whose
 * floating-point error rounds the other way at exact 4dp half boundaries (0.49995 → 0.4999 vs 0.5000).
 */

const lineage = {
  agreementRef: "IO-2026-001",
  agreementApprovedAt: "2026-08-01T00:00:00.000Z",
  agreementApprovedBy: "commercial-admin",
};

function ratioRule(clientShare, gross = 100) {
  return {
    ...lineage,
    commissionType: "PERCENT",
    grossCommission: gross,
    clientCommission: clientShare,
    currency: "USD",
  };
}

function attributionClient(amount, rule) {
  const split = applyCommissionRuleToGross(amount, rule);
  assert.equal(split.ok, true, `attribution split failed: ${split.reason}`);
  return split;
}

function commercialClient(amount, rule) {
  const result = calculateClientCommercialPayout({
    rule,
    context: { networkActualCommission: amount, networkActualCurrency: "USD" },
  });
  assert.equal(result.status, "CALCULATED", `commercial engine did not calculate: ${result.reason}`);
  return result;
}

describe("commission ratio — canonical helper", () => {
  it("expresses the pair as client ÷ gross and applies it as amount × ratio", () => {
    assert.equal(clientShareRatio(100, 70), 0.7);
    assert.equal(clientShareRatio("100.0000", "70.0000"), 0.7);
    assert.equal(applyClientShareRatio(100, 100, 70), 100 * (70 / 100));
    assert.equal(applyClientShareRatio("1.5", "100", "33.33"), 1.5 * (33.33 / 100));
  });
});

describe("commission ratio — 70% / 0% / 100% through both engines", () => {
  it("70%: 100 supplier commission → 70 client, 30 MBO", () => {
    const rule = ratioRule(70);
    const a = attributionClient(100, rule);
    const c = commercialClient(100, rule);
    assert.equal(a.clientCommission, "70.0000");
    assert.equal(a.mboCommission, "30.0000");
    assert.equal(c.clientPayable, 70);
    assert.equal(c.mboMargin, 30);
  });

  it("0%: 100 → 0 client, 100 MBO", () => {
    const rule = ratioRule(0);
    const a = attributionClient(100, rule);
    const c = commercialClient(100, rule);
    assert.equal(a.clientCommission, "0.0000");
    assert.equal(a.mboCommission, "100.0000");
    assert.equal(c.clientPayable, 0);
    assert.equal(c.mboMargin, 100);
    assert.equal(c.payable, false, "calculation never releases money by itself");
  });

  it("100%: 100 → 100 client, 0 MBO, and neither engine rejects an equal pair", () => {
    const rule = ratioRule(100);
    const a = attributionClient(100, rule);
    const c = commercialClient(100, rule);
    assert.equal(a.clientCommission, "100.0000");
    assert.equal(a.mboCommission, "0.0000");
    assert.equal(c.clientPayable, 100);
    assert.equal(c.mboMargin, 0);
    assert.equal(c.status, "CALCULATED", "zero margin is not a negative margin");
  });
});

describe("commission ratio — half-boundary parity between attribution and commercial engines", () => {
  const boundaryCases = [
    // [share, amount, expected 4dp] — exact products end in 5 at the fifth decimal.
    { share: 33.33, amount: 1.5, exact: "0.49995" },
    { share: 33.33, amount: 5.5, exact: "1.83315" },
    { share: 66.67, amount: 1.5, exact: "1.00005" },
    { share: 66.67, amount: 4.5, exact: "3.00015" },
  ];

  for (const { share, amount, exact } of boundaryCases) {
    it(`${share}% of ${amount} (exact ${exact}) rounds identically in both engines`, () => {
      const rule = ratioRule(share);
      const a = attributionClient(amount, rule);
      const c = commercialClient(amount, rule);
      assert.equal(Number(a.clientCommission), c.clientPayable);
      assert.equal(Number(a.mboCommission), c.mboMargin);
      // Both legs still reconcile to the supplier amount at 4dp.
      assert.ok(Math.abs(Number(a.clientCommission) + Number(a.mboCommission) - amount) < 0.00015);
      assert.ok(Math.abs(c.clientPayable + c.mboMargin - amount) < 0.00015);
    });
  }

  for (const share of [33.33, 66.67]) {
    it(`${share}%: every amount from 0.01 to 200.00 gives the same 4dp client amount in both engines`, () => {
      const rule = ratioRule(share);
      let checked = 0;
      for (let cents = 1; cents <= 20000; cents += 1) {
        const amount = cents / 100;
        const a = Number(applyCommissionRuleToGross(amount, rule).clientCommission);
        const c = calculateClientCommercialPayout({
          rule,
          context: { networkActualCommission: amount, networkActualCurrency: "USD" },
        }).clientPayable;
        assert.equal(a, c, `engines disagree at amount ${amount} for ${share}%`);
        checked += 1;
      }
      assert.equal(checked, 20000);
    });
  }

  it("the provisional (expected supplier commission) path uses the same expression", () => {
    const rule = ratioRule(33.33);
    const result = calculateClientCommercialPayout({
      rule,
      context: { expectedSupplierCommission: 1.5, provisionalAllowed: true },
    });
    assert.equal(result.status, "PROVISIONAL");
    assert.equal(result.clientPayable, Number(applyCommissionRuleToGross(1.5, rule).clientCommission));
    assert.equal(result.payable, false);
  });

  it("the finance runtime (rule graph → matcher → calculation) agrees with attribution at a boundary", async () => {
    const rule = {
      id: "r-3333",
      assignmentId: "a1",
      status: "EFFECTIVE",
      effectiveFrom: "2026-01-01T00:00:00Z",
      conditions: [{ conditionType: "DEFAULT" }],
      ...ratioRule(33.33),
    };
    const service = new ClientCommercialRuntimeService({
      commissionRepo: { findEffectiveRulesForAssignment: async () => [rule] },
    });
    const runtime = await service.evaluate({
      assignmentId: "a1",
      attributionResolved: true,
      attributionStatus: "ATTRIBUTED",
      networkActualCommission: 1.5,
      networkActualCurrency: "USD",
    });
    assert.equal(runtime.status, "CALCULATED");
    assert.equal(runtime.clientPayable, Number(applyCommissionRuleToGross(1.5, rule).clientCommission));
    assert.equal(runtime.mboMargin, Number(applyCommissionRuleToGross(1.5, rule).mboCommission));
  });
});
