import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveMboCommission, periodsOverlap } from "../src/modules/commercial/commissionMath.js";

describe("commissionMath", () => {
  it("derives mbo commission from gross and client values", () => {
    assert.equal(deriveMboCommission("10.0000", "6.5000"), "3.5000");
  });

  it("detects overlapping effective periods", () => {
    assert.equal(
      periodsOverlap("2026-01-01", "2026-06-30", "2026-06-01", "2026-12-31"),
      true,
    );
    assert.equal(
      periodsOverlap("2026-01-01", "2026-03-31", "2026-04-01", "2026-12-31"),
      false,
    );
  });
});
