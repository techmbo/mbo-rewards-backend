/**
 * Pointer 17 — Finance separation contract tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FINANCE_EVENT,
  extractMboActualReceipt,
  formatMboReceivedDateTime,
  hasMboActualReceipt,
  isNetworkPaymentEvidenceOnly,
  resolveClientPayableEligibility,
  resolveFinanceEventStage,
  shouldNotInferMboReceiptFromNetworkPayment,
} from "../src/modules/finance/financeSeparation.contract.js";

describe("Pointer 17 — financeSeparation.contract", () => {
  it("classifies network payment tokens as evidence only", () => {
    assert.equal(isNetworkPaymentEvidenceOnly("PAID"), true);
    assert.equal(isNetworkPaymentEvidenceOnly("AVAILABLE"), true);
    assert.equal(isNetworkPaymentEvidenceOnly("Payment Sent"), true);
    assert.equal(isNetworkPaymentEvidenceOnly("approved"), false);
  });

  it("never infers MBO receipt from network payment status", () => {
    assert.equal(
      shouldNotInferMboReceiptFromNetworkPayment({ networkPaymentStatus: "PAID" }),
      true,
    );
    assert.equal(
      shouldNotInferMboReceiptFromNetworkPayment({ supplierPaymentStatus: "PAYMENT_RECEIVED" }),
      true,
    );
  });

  it("extracts MBO actual receipt only from bank/reconciliation metadata", () => {
    assert.equal(
      extractMboActualReceipt({
        order: {
          supplierPaymentStatus: "PAYMENT_RECEIVED",
          supplierPaymentChangedAt: "2026-08-01T00:00:00.000Z",
          metadata: {},
        },
      }),
      null,
    );

    const receipt = extractMboActualReceipt({
      order: {
        currency: "USD",
        metadata: {
          mboReceivedDateTime: "2026-08-15T14:22:00.000Z",
          mboReceiptSource: "BANK_RECONCILIATION",
          bankReference: "BNK-123",
          mboReceivedAmount: "120.50",
        },
      },
    });
    assert.ok(receipt);
    assert.equal(receipt.source, "BANK_RECONCILIATION");
    assert.equal(receipt.bankReference, "BNK-123");
    assert.equal(formatMboReceivedDateTime(receipt), "2026-08-15 14:22");
  });

  it("requires MBO actual receipt before client payable eligibility", () => {
    const order = { validationStatus: "VALIDATION_APPROVED", metadata: {} };
    assert.equal(resolveClientPayableEligibility({ order }).eligible, false);
    assert.match(resolveClientPayableEligibility({ order }).reason, /MBO actual receipt/);

    const withReceipt = {
      validationStatus: "VALIDATION_APPROVED",
      metadata: {
        mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
        mboReceiptSource: "BANK_RECONCILIATION",
      },
    };
    assert.equal(resolveClientPayableEligibility({ order: withReceipt }).eligible, true);
    assert.equal(hasMboActualReceipt({ order: withReceipt }), true);
  });

  it("models finance events as a distinct chain", () => {
    const stages = resolveFinanceEventStage({
      order: {
        validationStatus: "VALIDATION_APPROVED",
        supplierPaymentStatus: "PAYMENT_RECEIVED",
        clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
        metadata: {
          networkPaymentEvidence: "PAID",
          mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
          mboReceiptSource: "BANK_RECONCILIATION",
        },
      },
    });
    assert.ok(stages.includes(FINANCE_EVENT.CONFIRMED_ORDER));
    assert.ok(stages.includes(FINANCE_EVENT.NETWORK_PAYMENT));
    assert.ok(stages.includes(FINANCE_EVENT.MBO_ACTUAL_RECEIPT));
    assert.ok(stages.includes(FINANCE_EVENT.CLIENT_PAYABLE_ELIGIBILITY));
    assert.equal(stages.includes(FINANCE_EVENT.CLIENT_PAYMENT), false);
  });

  it("blocks client payable when reconciliation mismatch is material", () => {
    const order = {
      validationStatus: "VALIDATION_APPROVED",
      metadata: {
        mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
        mboReceiptSource: "BANK_RECONCILIATION",
      },
    };
    const checks = [
      {
        pair: "MBO_RECEIPT_VS_CLIENT_PAYABLE",
        ok: false,
        skipped: false,
        material: true,
        mismatchReason: "Amount delta +20.0000",
      },
    ];
    const result = resolveClientPayableEligibility({ order, reconciliationChecks: checks });
    assert.equal(result.eligible, false);
    assert.match(result.reason, /Reconciliation mismatch/);
  });
});
