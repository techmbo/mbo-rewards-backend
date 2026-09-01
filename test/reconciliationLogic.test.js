/**
 * Pointer 18 — Reconciliation logic contract tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RECONCILIATION_PAIR,
  runReconciliationChecks,
  shouldBlockClientPayableRelease,
  resolveNetworkReconRowStatus,
} from "../src/modules/finance/reconciliationLogic.contract.js";
import { runOrderReconciliationChecks } from "../src/modules/finance/reconciliation.service.js";

describe("Pointer 18 — reconciliationLogic.contract", () => {
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
    assert.equal(result.checks.length, 5);
    assert.equal(shouldBlockClientPayableRelease(result.checks), false);
  });

  it("flags material commission mismatch", () => {
    const result = runReconciliationChecks({
      networkCommission: 100,
      mboGrossNetworkCommission: 90,
    });
    const commissionCheck = result.checks.find(
      (c) => c.pair === RECONCILIATION_PAIR.NETWORK_COMMISSION_VS_MBO_GROSS,
    );
    assert.equal(commissionCheck.ok, false);
    assert.equal(commissionCheck.material, true);
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
    assert.ok(result.checks.every((c) => c.skipped));
  });

  it("maps row status from reconciliation result", () => {
    assert.equal(
      resolveNetworkReconRowStatus({ allMatched: true, hasMaterialMismatch: false, openMismatches: [] }),
      "MATCHED",
    );
    assert.equal(
      resolveNetworkReconRowStatus({ allMatched: false, hasMaterialMismatch: true, openMismatches: [{}] }),
      "MISMATCH",
    );
    assert.equal(
      resolveNetworkReconRowStatus({ allMatched: false, hasMaterialMismatch: false, openMismatches: [{}] }),
      "PARTIAL",
    );
  });

  it("builds order-level reconciliation inputs from FT and bank receipt metadata", () => {
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
    const receiptCheck = result.checks.find(
      (c) => c.pair === RECONCILIATION_PAIR.MBO_RECEIPT_VS_CLIENT_PAYABLE,
    );
    assert.equal(receiptCheck.ok, false);
    assert.equal(receiptCheck.material, true);
  });
});
