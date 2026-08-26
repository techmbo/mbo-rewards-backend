import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCommissionRuleToGross } from "../src/modules/reporting/attributionMath.js";

function sumNullableInts(values) {
  let any = false;
  let sum = 0;
  for (const v of values) {
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    any = true;
    sum += n;
  }
  return any ? sum : null;
}

describe("Campaign Summary metric lineage helpers", () => {
  it("sums nullable ints without turning all-null into 0", () => {
    assert.equal(sumNullableInts([null, null]), null);
    assert.equal(sumNullableInts([null, 0, null]), 0);
    assert.equal(sumNullableInts([2, null, 4]), 6);
  });

  it("applies 07C client share without inventing when rule missing", () => {
    const ok = applyCommissionRuleToGross(10, {
      grossCommission: 100,
      clientCommission: 70,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.clientCommission, "7.0000");
    assert.equal(ok.mboCommission, "3.0000");

    const missing = applyCommissionRuleToGross(10, null);
    assert.equal(missing.ok, false);
    assert.equal(missing.clientCommission, null);
    assert.equal(missing.mboCommission, null);
  });

  it("does not equate network clicks with mbo link clicks", () => {
    const network = sumNullableInts([10, 20]);
    const mbo = sumNullableInts([null, null]);
    assert.equal(network, 30);
    assert.equal(mbo, null);
    assert.notEqual(network, mbo);
  });
});
