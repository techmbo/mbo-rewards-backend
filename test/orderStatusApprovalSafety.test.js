import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapConversionStatusToValidation } from "../src/modules/order/orderMerge.js";

describe("Order status approval safety", () => {
  it("allows only explicit internal approval vocabulary", () => {
    assert.equal(mapConversionStatusToValidation("APPROVED"), "VALIDATION_APPROVED");
    assert.equal(mapConversionStatusToValidation("CONFIRMED"), "VALIDATION_APPROVED");
    assert.equal(mapConversionStatusToValidation("REJECTED"), "VALIDATION_REJECTED");
    assert.equal(mapConversionStatusToValidation("PENDING"), "VALIDATION_PENDING");
  });

  it("never confirms an order from payment lifecycle words", () => {
    for (const token of [
      "PAID",
      "INVOICED",
      "PAYABLE",
      "AVAILABLE",
      "WITHDRAWN",
      "PAYMENT_SENT",
      "PAYMENT RECEIVED",
      "SETTLED",
    ]) {
      assert.equal(
        mapConversionStatusToValidation(token),
        "VALIDATION_NEEDS_REVIEW",
        `${token} must not confirm an order`,
      );
    }
  });

  it("fails closed for unknown legacy/internal values", () => {
    assert.equal(mapConversionStatusToValidation("mystery"), "VALIDATION_NEEDS_REVIEW");
    assert.equal(mapConversionStatusToValidation("UNKNOWN"), "VALIDATION_NEEDS_REVIEW");
    assert.equal(mapConversionStatusToValidation(null), null);
  });
});
