/**
 * Pointer 18 / PR4 — reconciliation source-integrity tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RECONCILIATION_PAIR,
  RECONCILIATION_REASON_CODE,
  RECONCILIATION_STATUS,
  runReconciliationChecks,
  shouldBlockClientPayableRelease,
  resolveNetworkReconRowStatus,
} from "../src/modules/finance/reconciliationLogic.contract.js";
import {
  buildOrderReconciliationInputs,
  runOrderReconciliationChecks,
} from "../src/modules/finance/reconciliation.service.js";

describe("Pointer 18 / PR4 — reconciliationLogic.contract", () => {
  it("matches when all five pairwise checks align", () => {
    const result = runReconciliationChecks({
      networkOrderCount: 10,
      mboOrderCount: 10,
      networkCommission: 100,
      mboGrossNetworkCommission: 100,
      networkInvoiceAmount: 100,
      networkPaymentAmount: 100,
      mboActualReceiptAmount: 100,
      clientPayableAmount: 100,
    });
    assert.equal(result.allMatched, true);
    assert.equal(result.hasMaterialMismatch, false);
    assert.equal(result.hasSourceDataMissing, false);
    assert.equal(result.checks.length, 5);
    assert.equal(shouldBlockClientPayableRelease(result.checks), false);
  });

  it("flags material numeric commission mismatch", () => {
    const result = runReconciliationChecks({
      networkCommission: 100,
      mboGrossNetworkCommission: 90,
    });
    const commissionCheck = result.checks.find(
      (c) => c.pair === RECONCILIATION_PAIR.NETWORK_COMMISSION_VS_MBO_GROSS,
    );
    assert.equal(commissionCheck.status, RECONCILIATION_STATUS.MISMATCH);
    assert.equal(commissionCheck.sourceDataMissing, false);
    assert.equal(commissionCheck.ok, false);
    assert.equal(commissionCheck.material, true);
    assert.equal(shouldBlockClientPayableRelease(result.checks), true);
  });

  it("represents a one-sided source gap as CANNOT_RECONCILE / SOURCE_DATA_MISSING", () => {
    const result = runReconciliationChecks({
      networkCommission: null,
      mboGrossNetworkCommission: 90,
    });
    const check = result.checks.find(
      (c) => c.pair === RECONCILIATION_PAIR.NETWORK_COMMISSION_VS_MBO_GROSS,
    );

    assert.equal(check.status, RECONCILIATION_STATUS.CANNOT_RECONCILE);
    assert.equal(check.reasonCode, RECONCILIATION_REASON_CODE.SOURCE_DATA_MISSING);
    assert.equal(check.sourceDataMissing, true);
    assert.equal(check.difference, null);
    assert.equal(check.mismatchReason, "Network commission missing");
    assert.equal(result.summaryStatus, RECONCILIATION_STATUS.CANNOT_RECONCILE);
    assert.equal(result.hasSourceDataMissing, true);
    assert.equal(shouldBlockClientPayableRelease(result.checks), true);
  });

  it("blocks client payable on MBO receipt vs client payable mismatch", () => {
    const result = runReconciliationChecks({
      mboActualReceiptAmount: 100,
      clientPayableAmount: 120,
    });
    const check = result.checks.find(
      (c) => c.pair === RECONCILIATION_PAIR.MBO_RECEIPT_VS_CLIENT_PAYABLE,
    );
    assert.equal(check.ok, false);
    assert.equal(shouldBlockClientPayableRelease(result.checks), true);
  });

  it("treats count deltas as material", () => {
    const result = runReconciliationChecks({
      networkOrderCount: 5,
      mboOrderCount: 3,
    });
    const check = result.checks.find(
      (c) => c.pair === RECONCILIATION_PAIR.NETWORK_ORDERS_VS_MBO_ORDERS,
    );
    assert.equal(check.ok, false);
    assert.equal(check.material, true);
    assert.equal(check.difference, 2);
  });

  it("skips checks when both sides are null", () => {
    const result = runReconciliationChecks({});
    assert.equal(result.allMatched, true);
    assert.equal(result.hasSourceDataMissing, false);
    assert.ok(result.checks.every((c) => c.skipped));
  });

  it("maps row status from reconciliation result", () => {
    assert.equal(
      resolveNetworkReconRowStatus({
        allMatched: true,
        hasMaterialMismatch: false,
        hasSourceDataMissing: false,
        openMismatches: [],
      }),
      "MATCHED",
    );
    assert.equal(
      resolveNetworkReconRowStatus({
        allMatched: false,
        hasMaterialMismatch: true,
        hasSourceDataMissing: true,
        openMismatches: [{}],
      }),
      "CANNOT_RECONCILE",
    );
    assert.equal(
      resolveNetworkReconRowStatus({
        allMatched: false,
        hasMaterialMismatch: true,
        hasSourceDataMissing: false,
        openMismatches: [{}],
      }),
      "MISMATCH",
    );
    assert.equal(
      resolveNetworkReconRowStatus({
        allMatched: false,
        hasMaterialMismatch: false,
        hasSourceDataMissing: false,
        openMismatches: [{}],
      }),
      "PARTIAL",
    );
  });

  it("does not derive network source amounts from MBO gross or payment status/evidence", () => {
    const inputs = buildOrderReconciliationInputs({
      order: {
        id: "ord-source-gap",
        supplierOrderId: "net-101",
        supplierPaymentStatus: "PAYMENT_INVOICED",
        metadata: {
          networkPaymentEvidence: "PAID",
          networkPaymentStatus: "PAID",
        },
      },
      financialTransactions: [
        { supplierReceivable: "50", clientPayable: "40", transactionType: "EARN" },
      ],
    });

    assert.equal(inputs.networkCommission, null);
    assert.equal(inputs.networkInvoiceAmount, null);
    assert.equal(inputs.networkPaymentAmount, null);
    assert.equal(inputs.mboGrossNetworkCommission, 50);
    assert.equal(inputs.clientPayableAmount, 40);
  });

  it("does not invent a receipt amount when receipt evidence has no source amount", () => {
    const inputs = buildOrderReconciliationInputs({
      order: {
        id: "ord-receipt-no-amount",
        supplierOrderId: "net-102",
        metadata: {
          mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
          mboReceiptSource: "BANK_RECONCILIATION",
        },
      },
      financialTransactions: [
        { supplierReceivable: "50", clientPayable: "40", transactionType: "EARN" },
      ],
    });

    assert.equal(inputs.mboActualReceiptAmount, null);
    assert.equal(inputs.mboGrossNetworkCommission, 50);
  });

  it("uses explicit source amounts when they are present", () => {
    const inputs = buildOrderReconciliationInputs({
      order: {
        id: "ord-explicit",
        supplierOrderId: "net-103",
        metadata: {
          networkCommission: "50",
          networkInvoiceAmount: "50",
          networkPaymentAmount: "50",
          mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
          mboReceiptSource: "BANK_RECONCILIATION",
          mboReceivedAmount: "50",
        },
      },
      financialTransactions: [
        { supplierReceivable: "50", clientPayable: "40", transactionType: "EARN" },
      ],
    });

    assert.equal(inputs.networkCommission, 50);
    assert.equal(inputs.networkInvoiceAmount, 50);
    assert.equal(inputs.networkPaymentAmount, 50);
    assert.equal(inputs.mboActualReceiptAmount, 50);
  });

  it("order-level reconciliation exposes source-data gaps instead of fabricated matches", () => {
    const result = runOrderReconciliationChecks({
      order: {
        id: "ord-1",
        supplierOrderId: "net-99",
        validationStatus: "VALIDATION_APPROVED",
        supplierPaymentStatus: "PAYMENT_RECEIVED",
        metadata: {
          networkPaymentEvidence: "PAID",
          mboReceivedDateTime: "2026-08-15T10:00:00.000Z",
          mboReceiptSource: "BANK_RECONCILIATION",
          mboReceivedAmount: "50",
        },
      },
      financialTransactions: [
        { supplierReceivable: "50", clientPayable: "40", transactionType: "EARN" },
      ],
    });

    const paymentCheck = result.checks.find(
      (c) => c.pair === RECONCILIATION_PAIR.NETWORK_PAYMENT_VS_MBO_RECEIPT,
    );
    const receiptCheck = result.checks.find(
      (c) => c.pair === RECONCILIATION_PAIR.MBO_RECEIPT_VS_CLIENT_PAYABLE,
    );

    assert.equal(paymentCheck.status, RECONCILIATION_STATUS.CANNOT_RECONCILE);
    assert.equal(paymentCheck.reasonCode, RECONCILIATION_REASON_CODE.SOURCE_DATA_MISSING);
    assert.equal(paymentCheck.left, null);
    assert.equal(paymentCheck.right, 50);
    assert.equal(receiptCheck.status, RECONCILIATION_STATUS.MISMATCH);
    assert.equal(receiptCheck.difference, 10);
  });
});
