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

const matchedBlockingChecks = [
  {
    pair: "NETWORK_COMMISSION_VS_MBO_GROSS",
    status: "MATCHED",
    ok: true,
    skipped: false,
    material: false,
  },
  {
    pair: "NETWORK_PAYMENT_VS_MBO_RECEIPT",
    status: "MATCHED",
    ok: true,
    skipped: false,
    material: false,
  },
  {
    pair: "MBO_RECEIPT_VS_CLIENT_PAYABLE",
    status: "MATCHED",
    ok: true,
    skipped: false,
    material: false,
  },
];

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
    assert.equal(receipt.amount, "120.50");
    assert.equal(formatMboReceivedDateTime(receipt), "2026-08-15 14:22");
  });

  it("does not substitute internal supplier receivable for missing bank receipt amount", () => {
    const receipt = extractMboActualReceipt({
      financialTransactions: [
        {
          id: "ft-1",
          supplierReceivable: "125.00",
          originalCurrency: "USD",
          metadata: {
            mboReceivedDateTime: "2026-08-15T14:22:00.000Z",
            mboReceiptSource: "BANK_RECONCILIATION",
            bankReference: "BNK-124",
          },
          calculationMetadata: {},
        },
      ],
    });

    assert.ok(receipt);
    assert.equal(receipt.amount, null);
  });

  it("rejects invalid bank receipt timestamps instead of preserving arbitrary strings", () => {
    assert.equal(
      extractMboActualReceipt({
        order: {
          metadata: {
            mboReceivedDateTime: "not-a-date",
            mboReceiptSource: "BANK_RECONCILIATION",
            mboReceivedAmount: "10",
          },
        },
      }),
      null,
    );
  });

  it("requires MBO actual receipt and completed reconciliation before client payable eligibility", () => {
    const order = { validationStatus: "VALIDATION_APPROVED", metadata: {} };
    assert.equal(resolveClientPayableEligibility({ order }).eligible, false);
    assert.match(resolveClientPayableEligibility({ order }).reason, /MBO actual receipt/);

    const withReceipt = {
      validationStatus: "VALIDATION_APPROVED",
      metadata: {
        mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
        mboReceiptSource: "BANK_RECONCILIATION",
        mboReceivedAmount: "100",
      },
    };
    const withoutRecon = resolveClientPayableEligibility({ order: withReceipt });
    assert.equal(withoutRecon.eligible, false);
    assert.match(withoutRecon.reason, /Reconciliation required/);

    const withRecon = resolveClientPayableEligibility({
      order: withReceipt,
      reconciliationChecks: matchedBlockingChecks,
    });
    assert.equal(withRecon.eligible, true);
    assert.equal(hasMboActualReceipt({ order: withReceipt }), true);
  });

  it("models finance events as a distinct chain and does not treat PAYMENT_PAYABLE as network payment", () => {
    const order = {
      validationStatus: "VALIDATION_APPROVED",
      supplierPaymentStatus: "PAYMENT_RECEIVED",
      clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
      metadata: {
        networkPaymentEvidence: "PAID",
        mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
        mboReceiptSource: "BANK_RECONCILIATION",
        mboReceivedAmount: "100",
      },
    };
    const stages = resolveFinanceEventStage({
      order,
      reconciliationChecks: matchedBlockingChecks,
    });
    assert.ok(stages.includes(FINANCE_EVENT.CONFIRMED_ORDER));
    assert.ok(stages.includes(FINANCE_EVENT.NETWORK_PAYMENT));
    assert.ok(stages.includes(FINANCE_EVENT.MBO_ACTUAL_RECEIPT));
    assert.ok(stages.includes(FINANCE_EVENT.CLIENT_PAYABLE_ELIGIBILITY));
    assert.equal(stages.includes(FINANCE_EVENT.CLIENT_PAYMENT), false);

    const payableOnlyStages = resolveFinanceEventStage({
      order: {
        validationStatus: "VALIDATION_APPROVED",
        supplierPaymentStatus: "PAYMENT_PAYABLE",
        clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
        metadata: {},
      },
    });
    assert.equal(payableOnlyStages.includes(FINANCE_EVENT.NETWORK_PAYMENT), false);
  });

  it("blocks client payable when reconciliation mismatch is material", () => {
    const order = {
      validationStatus: "VALIDATION_APPROVED",
      metadata: {
        mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
        mboReceiptSource: "BANK_RECONCILIATION",
        mboReceivedAmount: "100",
      },
    };
    const checks = [
      {
        pair: "MBO_RECEIPT_VS_CLIENT_PAYABLE",
        status: "MISMATCH",
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

  it("blocks when a required reconciliation pair is skipped rather than treating missing evidence as safe", () => {
    const order = {
      validationStatus: "VALIDATION_APPROVED",
      metadata: {
        mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
        mboReceiptSource: "BANK_RECONCILIATION",
        mboReceivedAmount: "100",
      },
    };
    const result = resolveClientPayableEligibility({
      order,
      reconciliationChecks: [
        {
          pair: "NETWORK_PAYMENT_VS_MBO_RECEIPT",
          status: "SKIPPED",
          ok: true,
          skipped: true,
          material: false,
        },
      ],
    });
    assert.equal(result.eligible, false);
  });
});
