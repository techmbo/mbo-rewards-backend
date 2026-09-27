process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "silent";

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

const { MboReceiptService, parseMboReceiptInput, MBO_RECEIPT_SOURCE } = await import(
  "../src/modules/finance/mboReceipt.service.js"
);
const { PaymentStateService } = await import("../src/modules/order/paymentState.service.js");
const { ReconciliationService } = await import("../src/modules/finance/reconciliation.service.js");
const { ClientBalanceService } = await import("../src/modules/finance/clientBalance.service.js");
const {
  RECONCILIATION_PAIR,
  RECONCILIATION_STATUS,
  runReconciliationChecks,
  shouldBlockClientPayableRelease,
} = await import("../src/modules/finance/reconciliationLogic.contract.js");
const { fakeLedgerDb } = await import("./helpers/ledgerFakes.js");

/**
 * In-memory order + ledger store driving the REAL MboReceiptService, PaymentStateService,
 * ReconciliationService and ClientBalanceService. Ledger rows hold a live reference to their
 * order, so a client-payment transition is immediately visible to the withdrawal balance.
 */
const NOW = new Date("2026-09-27T12:00:00.000Z");
const ADMIN = "admin-user-1";

function scenario({
  gross = 100,
  clientPayable = 70,
  margin = 30,
  networkCommission = gross,
  networkPayment = gross,
  currency = "USD",
  orderCurrency = currency,
  validationStatus = "VALIDATION_APPROVED",
  supplierPaymentStatus = "PAYMENT_RECEIVED",
  clientPaymentStatus = "CLIENT_PAYMENT_NOT_READY",
  metadata = {},
  // Transaction fault injection: commitConflicts = attempts that run fully and then fail at commit
  // with a serialization conflict (P2034); transitionError = a non-business error thrown by the
  // state machine's transition.
  commitConflicts = 0,
  transitionError = null,
} = {}) {
  const order = {
    id: "ord-1",
    clientId: "c1",
    supplier: "OPTIMISE",
    supplierOrderId: "net-1",
    currency: orderCurrency,
    validationStatus,
    supplierPaymentStatus,
    clientPaymentStatus,
    metadata: {
      networkCommission: String(networkCommission),
      networkInvoiceAmount: String(networkPayment),
      networkPaymentAmount: String(networkPayment),
      unrelatedKey: "keep-me",
      ...metadata,
    },
  };
  const ledger = [
    {
      id: "ft-1",
      orderId: order.id,
      clientId: "c1",
      transactionType: "COMMISSION_EARNED",
      supplierReceivable: String(gross),
      clientPayable: String(clientPayable),
      mboMargin: margin == null ? null : String(margin),
      originalCurrency: currency,
      reportingCurrency: currency,
      reportingClientPayable: String(clientPayable),
      metadata: {},
      calculationMetadata: {},
      order,
    },
  ];
  const calls = { orderUpdates: [], audits: [], exceptions: [], transactions: 0, rollbacks: 0 };

  const pick = (row, select) =>
    select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };

  const db = {
    order: {
      findUnique: async ({ where, include }) => {
        if (where.id !== order.id) return null;
        const copy = { ...order, metadata: { ...order.metadata } };
        if (include?.financialTransactions) {
          copy.financialTransactions = ledger
            .filter((r) => r.orderId === order.id)
            .map((r) => pick(r, include.financialTransactions.select));
        }
        return copy;
      },
      update: async ({ where, data }) => {
        assert.equal(where.id, order.id);
        calls.orderUpdates.push(data);
        Object.assign(order, data);
        return { ...order, metadata: { ...order.metadata } };
      },
    },
    financialTransaction: {
      findMany: async ({ where, select }) =>
        ledger.filter((r) => r.orderId === where.orderId).map((r) => pick(r, select)),
    },
  };

  let conflictsLeft = commitConflicts;
  const runInTransaction = async (fn) => {
    calls.transactions += 1;
    const snapshot = { ...order, metadata: { ...order.metadata } };
    const ledgerLength = ledger.length;
    try {
      const result = await fn(db);
      if (conflictsLeft > 0) {
        conflictsLeft -= 1;
        throw Object.assign(new Error("could not serialize access due to read/write dependencies"), { code: "P2034" });
      }
      return result;
    } catch (error) {
      Object.assign(order, snapshot);
      ledger.length = ledgerLength;
      calls.rollbacks += 1;
      throw error;
    }
  };

  const audit = { record: async (event) => calls.audits.push(event) };
  const exceptions = { report: async (event) => calls.exceptions.push(event) };
  const paymentState = new PaymentStateService({ prisma: db, audit, exceptions });
  const service = new MboReceiptService({
    prisma: db,
    audit,
    // Per-attempt services around the service's deferred audit buffer, as in production.
    paymentStateFor: (attemptAudit) => {
      const state = new PaymentStateService({ prisma: db, audit: attemptAudit, exceptions });
      if (transitionError) {
        state.transitionClientPayment = async () => {
          throw transitionError;
        };
      }
      return state;
    },
    reconciliationFor: () => new ReconciliationService({ prisma: db, exceptions }),
    runInTransaction,
    now: () => NOW,
  });
  // fakeLedgerDb copies its input array; share the live rows so later appends are visible.
  const ledgerDb = fakeLedgerDb({ transactions: [] });
  ledgerDb.state.transactions = ledger;
  const liveBalances = new ClientBalanceService({ prisma: ledgerDb });

  return {
    order,
    ledger,
    calls,
    service,
    paymentState,
    balance: () => liveBalances.computeBalance({ clientId: "c1", currency }),
    record: (body = {}) =>
      service.recordReceipt(order.id, { ...receiptBody({ amount: gross, currency }), ...body }, { actorId: ADMIN }),
  };
}

function receiptBody({ amount = 100, currency = "USD" } = {}) {
  return {
    receivedAt: "2026-09-20T10:00:00.000Z",
    amount: String(amount),
    currency,
    bankReference: "HSBC-TT-000123",
    reconciliationReference: "RECON-2026-09-20",
  };
}

function pairStatus(result, pair) {
  return result.eligibility.reconciliationChecks.find((c) => c.pair === pair)?.status;
}

describe("reconciliation contract — receipt reconciles to gross, split reconciles client payable", () => {
  const base = {
    networkOrderCount: 1,
    mboOrderCount: 1,
    networkCommission: 100,
    mboGrossNetworkCommission: 100,
    networkInvoiceAmount: 100,
    networkPaymentAmount: 100,
    mboActualReceiptAmount: 100,
  };

  for (const [share, client, margin] of [[100, 100, 0], [70, 70, 30], [0, 0, 100]]) {
    it(`gross receipt 100, client share ${share}%: client ${client} + margin ${margin} passes every blocking pair`, () => {
      const result = runReconciliationChecks({ ...base, clientPayableAmount: client, mboMarginAmount: margin });
      assert.equal(shouldBlockClientPayableRelease(result.checks), false);
      assert.equal(result.allMatched, true);
    });
  }

  it("A. network payment 100 vs receipt 90 blocks", () => {
    const r = runReconciliationChecks({ ...base, mboActualReceiptAmount: 90, mboGrossNetworkCommission: 90, networkCommission: 90, clientPayableAmount: 63, mboMarginAmount: 27 });
    assert.equal(r.checks.find((c) => c.pair === RECONCILIATION_PAIR.NETWORK_PAYMENT_VS_MBO_RECEIPT).status, RECONCILIATION_STATUS.MISMATCH);
    assert.equal(shouldBlockClientPayableRelease(r.checks), true);
  });

  it("B. receipt 100 vs ledger gross 90 blocks", () => {
    const r = runReconciliationChecks({ ...base, mboGrossNetworkCommission: 90, networkCommission: 90, clientPayableAmount: 63, mboMarginAmount: 27 });
    assert.equal(r.checks.find((c) => c.pair === RECONCILIATION_PAIR.MBO_RECEIPT_VS_MBO_GROSS).status, RECONCILIATION_STATUS.MISMATCH);
    assert.equal(shouldBlockClientPayableRelease(r.checks), true);
  });

  it("C. gross 100 vs client 80 + margin 10 blocks", () => {
    const r = runReconciliationChecks({ ...base, clientPayableAmount: 80, mboMarginAmount: 10 });
    const split = r.checks.find((c) => c.pair === RECONCILIATION_PAIR.MBO_GROSS_VS_CLIENT_PAYABLE_PLUS_MARGIN);
    assert.equal(split.status, RECONCILIATION_STATUS.MISMATCH);
    assert.equal(split.difference, 10);
    assert.equal(shouldBlockClientPayableRelease(r.checks), true);
  });

  it("a missing margin is never derived from gross − client: the split cannot reconcile and blocks", () => {
    const r = runReconciliationChecks({ ...base, clientPayableAmount: 70, mboMarginAmount: null });
    const split = r.checks.find((c) => c.pair === RECONCILIATION_PAIR.MBO_GROSS_VS_CLIENT_PAYABLE_PLUS_MARGIN);
    assert.equal(split.status, RECONCILIATION_STATUS.CANNOT_RECONCILE);
    assert.equal(shouldBlockClientPayableRelease(r.checks), true);
  });

  it("receipt is never equated to client payable: receipt 100 with client payable 70 is not a mismatch", () => {
    const r = runReconciliationChecks({ ...base, clientPayableAmount: 70, mboMarginAmount: 30 });
    assert.ok(r.checks.every((c) => c.status === RECONCILIATION_STATUS.MATCHED));
    assert.equal(r.checks.some((c) => c.left === 100 && c.right === 70), false);
  });

  it("a check list that omits a blocking pair fails closed", () => {
    const r = runReconciliationChecks({ ...base, clientPayableAmount: 70, mboMarginAmount: 30 });
    const withoutSplit = r.checks.filter((c) => c.pair !== RECONCILIATION_PAIR.MBO_GROSS_VS_CLIENT_PAYABLE_PLUS_MARGIN);
    assert.equal(shouldBlockClientPayableRelease(withoutSplit), true);
    assert.equal(shouldBlockClientPayableRelease([]), true);
  });

  it("reversals stay netted: earn 100/70/30 plus reversal −100/−70/−30 reconciles to a zero split", async () => {
    const { buildOrderReconciliationInputs } = await import("../src/modules/finance/reconciliation.service.js");
    const inputs = buildOrderReconciliationInputs({
      order: { id: "o", supplierOrderId: "n", metadata: {} },
      financialTransactions: [
        { supplierReceivable: "100", clientPayable: "70", mboMargin: "30", transactionType: "COMMISSION_EARNED" },
        { supplierReceivable: "-100", clientPayable: "-70", mboMargin: "-30", transactionType: "REVERSAL" },
      ],
    });
    assert.equal(inputs.mboGrossNetworkCommission, 0);
    assert.equal(inputs.clientPayableAmount, 0);
    assert.equal(inputs.mboMarginAmount, 0);
  });
});

describe("admin MBO receipt → client payable (real PaymentStateService)", () => {
  for (const [share, client, margin] of [[100, 100, 0], [70, 70, 30], [0, 0, 100]]) {
    it(`records the receipt and reaches CLIENT_PAYMENT_PAYABLE for a ${share}% client share`, async () => {
      const s = scenario({ clientPayable: client, margin });
      const out = await s.record();
      assert.equal(out.replayed, false);
      assert.equal(out.eligibility.eligible, true, out.eligibility.reason);
      assert.equal(out.clientPaymentStatus, "CLIENT_PAYMENT_PAYABLE");
      assert.equal(s.order.clientPaymentStatus, "CLIENT_PAYMENT_PAYABLE");
      assert.equal(s.order.metadata.mboReceivedDateTime, "2026-09-20T10:00:00.000Z");
      assert.equal(s.order.metadata.mboReceivedAmount, "100.0000");
      assert.equal(s.order.metadata.mboReceivedCurrency, "USD");
      assert.equal(s.order.metadata.mboReceiptSource, MBO_RECEIPT_SOURCE);
      assert.equal(s.order.metadata.bankReference, "HSBC-TT-000123");
      assert.equal(s.order.metadata.reconciliationReference, "RECON-2026-09-20");
      assert.equal(s.order.metadata.mboReceiptRecordedBy, ADMIN);
      assert.equal(s.order.metadata.unrelatedKey, "keep-me", "unrelated metadata preserved");
      assert.equal(s.calls.transactions, 1);
    });
  }

  it("5. receipt 100 vs ledger gross 90 blocks: receipt stays recorded, order stays NOT_READY, exception reported", async () => {
    const s = scenario({ gross: 90, clientPayable: 63, margin: 27, networkCommission: 90, networkPayment: 100 });
    const out = await s.service.recordReceipt(s.order.id, receiptBody({ amount: 100 }), { actorId: ADMIN });
    assert.equal(out.eligibility.eligible, false);
    assert.match(out.eligibility.reason, /Reconciliation mismatch/);
    assert.equal(pairStatus(out, RECONCILIATION_PAIR.MBO_RECEIPT_VS_MBO_GROSS), RECONCILIATION_STATUS.MISMATCH);
    assert.equal(out.clientPaymentStatus, "CLIENT_PAYMENT_NOT_READY");
    assert.equal(s.order.clientPaymentStatus, "CLIENT_PAYMENT_NOT_READY");
    assert.equal(s.order.metadata.mboReceivedAmount, "100.0000", "the real bank fact is kept");
    assert.ok(s.calls.exceptions.some((e) => e.reconciliationPair === RECONCILIATION_PAIR.MBO_RECEIPT_VS_MBO_GROSS));
    assert.equal(s.calls.rollbacks, 0);
  });

  it("6. network payment 100 vs receipt 90 blocks", async () => {
    const s = scenario({ gross: 90, clientPayable: 63, margin: 27, networkCommission: 90, networkPayment: 100 });
    const out = await s.service.recordReceipt(s.order.id, receiptBody({ amount: 90 }), { actorId: ADMIN });
    assert.equal(out.eligibility.eligible, false);
    assert.equal(pairStatus(out, RECONCILIATION_PAIR.NETWORK_PAYMENT_VS_MBO_RECEIPT), RECONCILIATION_STATUS.MISMATCH);
    assert.equal(pairStatus(out, RECONCILIATION_PAIR.MBO_RECEIPT_VS_MBO_GROSS), RECONCILIATION_STATUS.MATCHED);
    assert.equal(s.order.clientPaymentStatus, "CLIENT_PAYMENT_NOT_READY");
  });

  it("7. gross 100 ≠ client 80 + margin 10 blocks", async () => {
    const s = scenario({ clientPayable: 80, margin: 10 });
    const out = await s.record();
    assert.equal(out.eligibility.eligible, false);
    assert.equal(pairStatus(out, RECONCILIATION_PAIR.MBO_GROSS_VS_CLIENT_PAYABLE_PLUS_MARGIN), RECONCILIATION_STATUS.MISMATCH);
    assert.equal(s.order.clientPaymentStatus, "CLIENT_PAYMENT_NOT_READY");
    assert.ok(s.calls.exceptions.some((e) => e.reconciliationPair === RECONCILIATION_PAIR.MBO_GROSS_VS_CLIENT_PAYABLE_PLUS_MARGIN));
  });

  it("8. missing receipt blocks PAYABLE in the state machine", async () => {
    const s = scenario();
    await assert.rejects(
      s.paymentState.transitionClientPayment(s.order.id, "CLIENT_PAYMENT_PAYABLE"),
      /MBO actual receipt required/,
    );
    assert.equal(s.order.clientPaymentStatus, "CLIENT_PAYMENT_NOT_READY");
  });

  it("missing bank provenance blocks: a bare date is not receipt evidence and cannot be overwritten by the action", async () => {
    const s = scenario({ metadata: { mboReceivedDateTime: "2026-09-19T09:00:00Z", mboReceivedAmount: "100" } });
    await assert.rejects(
      s.paymentState.transitionClientPayment(s.order.id, "CLIENT_PAYMENT_PAYABLE"),
      /MBO actual receipt required/,
    );
    await assert.rejects(s.record(), (e) => e.statusCode === 409 && /without bank provenance/.test(e.message));
    assert.equal(s.order.metadata.mboReceiptSource, undefined);
  });

  it("9. malformed receipts are refused with 400 before any transaction", async () => {
    const s = scenario();
    const bad = [
      { amount: "0" },
      { amount: "-5" },
      { amount: "abc" },
      { amount: "10.12345" },
      { currency: "US" },
      { currency: "" },
      { bankReference: "   " },
      { bankReference: "PAID" },
      { receivedAt: "not-a-date" },
      { receivedAt: "2027-01-01T00:00:00Z" },
      { mboReceiptSource: "NETWORK" },
      { actorId: "someone-else" },
    ];
    for (const patch of bad) {
      await assert.rejects(s.record(patch), (e) => e.statusCode === 400, JSON.stringify(patch));
    }
    assert.equal(s.calls.transactions, 0);
    assert.equal(s.calls.orderUpdates.length, 0);
    assert.throws(() => parseMboReceiptInput({ ...receiptBody(), extra: 1 }, { now: NOW }), /Unsupported receipt field/);
  });

  it("10. wrong currency is refused with 409 and nothing is written", async () => {
    const s = scenario({ currency: "USD" });
    await assert.rejects(s.record({ currency: "INR" }), (e) => e.statusCode === 409 && /does not match/.test(e.message));
    assert.equal(s.calls.orderUpdates.length, 0);
    assert.equal(s.order.metadata.mboReceivedDateTime, undefined);
  });

  it("order preconditions: not approved, supplier not PAYMENT_RECEIVED, unknown order, client mismatch", async () => {
    await assert.rejects(scenario({ validationStatus: "VALIDATION_PENDING" }).record(), (e) => e.statusCode === 409);
    await assert.rejects(scenario({ supplierPaymentStatus: "PAYMENT_PAYABLE" }).record(), (e) => e.statusCode === 409 && /PAYMENT_RECEIVED/.test(e.message));
    const s = scenario();
    await assert.rejects(s.service.recordReceipt("nope", receiptBody(), { actorId: ADMIN }), (e) => e.statusCode === 404);
    await assert.rejects(s.record({ clientId: "other-client" }), (e) => e.statusCode === 404);
    await assert.rejects(s.service.recordReceipt(s.order.id, receiptBody(), {}), (e) => e.statusCode === 401);
  });

  it("11. replaying the identical receipt is idempotent: no second write, audit or transition", async () => {
    const s = scenario();
    const first = await s.record();
    const second = await s.record();
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.clientPaymentStatus, "CLIENT_PAYMENT_PAYABLE");
    assert.equal(second.eligibility.alreadyPayable, true);
    const receiptWrites = s.calls.orderUpdates.filter((u) => u.metadata);
    const transitions = s.calls.orderUpdates.filter((u) => u.clientPaymentStatus);
    assert.equal(receiptWrites.length, 1);
    assert.equal(transitions.length, 1);
    assert.equal(s.calls.audits.filter((a) => a.action === "order.mbo_receipt.recorded").length, 1);
    assert.equal(s.calls.audits.filter((a) => a.action === "order.client_payment.changed").length, 1);
  });

  it("a replay after a blocked attempt re-tries eligibility once the ledger is corrected, without rewriting the receipt", async () => {
    const s = scenario({ clientPayable: 80, margin: 10 });
    const blocked = await s.record();
    assert.equal(blocked.eligibility.eligible, false);
    // Finance corrects the split with a signed ADJUSTMENT row: margin +10.
    s.ledger.push({ ...s.ledger[0], id: "ft-adj", transactionType: "ADJUSTMENT", supplierReceivable: "0", clientPayable: "0", reportingClientPayable: "0", mboMargin: "10" });
    const retried = await s.record();
    assert.equal(retried.replayed, true);
    assert.equal(retried.eligibility.eligible, true);
    assert.equal(s.order.clientPaymentStatus, "CLIENT_PAYMENT_PAYABLE");
    assert.equal(s.calls.orderUpdates.filter((u) => u.metadata).length, 1, "receipt written once");
  });

  it("a serialization conflict at commit retries cleanly: one receipt, one transition, audit written once", async () => {
    const s = scenario({ commitConflicts: 1 });
    const out = await s.record();
    assert.equal(s.calls.transactions, 2, "one retry");
    assert.equal(s.calls.rollbacks, 1);
    assert.equal(out.replayed, false, "the committed attempt is the one that wrote the receipt");
    assert.equal(out.clientPaymentStatus, "CLIENT_PAYMENT_PAYABLE");
    assert.equal(s.order.clientPaymentStatus, "CLIENT_PAYMENT_PAYABLE");
    assert.equal(s.order.metadata.mboReceivedAmount, "100.0000");
    // The rolled-back attempt's transition audit was buffered and discarded, not written.
    assert.equal(s.calls.audits.filter((a) => a.action === "order.client_payment.changed").length, 1);
    assert.equal(s.calls.audits.filter((a) => a.action === "order.mbo_receipt.recorded").length, 1);
  });

  it("serialization conflicts beyond the retry budget surface the error and leave nothing behind", async () => {
    const s = scenario({ commitConflicts: 10 });
    await assert.rejects(s.record(), (e) => e.code === "P2034");
    assert.equal(s.calls.transactions, 4, "initial attempt + 3 retries");
    assert.equal(s.order.clientPaymentStatus, "CLIENT_PAYMENT_NOT_READY");
    assert.equal(s.order.metadata.mboReceivedDateTime, undefined, "no receipt metadata survives");
    assert.equal(s.order.metadata.unrelatedKey, "keep-me");
    assert.deepEqual(s.calls.audits, []);
  });

  it("an unexpected (non-409) transition error rolls back the receipt metadata and writes no audit", async () => {
    const s = scenario({ transitionError: Object.assign(new Error("connection terminated"), { code: "P1017" }) });
    await assert.rejects(s.record(), /connection terminated/);
    assert.equal(s.calls.rollbacks, 1);
    assert.equal(s.order.clientPaymentStatus, "CLIENT_PAYMENT_NOT_READY");
    for (const key of ["mboReceivedDateTime", "mboReceivedAmount", "mboReceivedCurrency", "mboReceiptSource", "bankReference", "mboReceiptRecordedBy"]) {
      assert.equal(s.order.metadata[key], undefined, `${key} rolled back`);
    }
    assert.deepEqual(s.calls.audits, []);
  });

  it("a blocked (409) eligibility keeps the full receipt, commits once and does not roll back", async () => {
    const s = scenario({ clientPayable: 80, margin: 10 });
    const out = await s.record();
    assert.equal(out.eligibility.eligible, false);
    assert.equal(s.calls.transactions, 1);
    assert.equal(s.calls.rollbacks, 0);
    assert.equal(s.order.clientPaymentStatus, "CLIENT_PAYMENT_NOT_READY");
    const receiptWrites = s.calls.orderUpdates.filter((u) => u.metadata);
    assert.equal(receiptWrites.length, 1, "single metadata write");
    for (const key of ["mboReceivedDateTime", "mboReceivedAmount", "mboReceivedCurrency", "mboReceiptSource", "bankReference", "mboReceiptRecordedBy", "mboReceiptRecordedAt"]) {
      assert.ok(receiptWrites[0].metadata[key] != null, `${key} written in the one update`);
    }
    assert.equal(s.calls.audits.filter((a) => a.action === "order.client_payment.changed").length, 0);
    assert.equal(s.calls.audits.filter((a) => a.action === "order.mbo_receipt.recorded").length, 1);
  });

  it("12. a conflicting second receipt is refused with 409 and the first stays intact", async () => {
    const s = scenario();
    await s.record();
    for (const patch of [{ amount: "99" }, { bankReference: "OTHER-REF" }, { receivedAt: "2026-09-21T10:00:00Z" }]) {
      await assert.rejects(s.record(patch), (e) => e.statusCode === 409 && /not overwritten/.test(e.message));
    }
    assert.equal(s.order.metadata.mboReceivedAmount, "100.0000");
    assert.equal(s.order.metadata.bankReference, "HSBC-TT-000123");
  });

  it("14. the admin actor, order, amount, currency and bank reference are audited; the response carries no bank account data", async () => {
    const s = scenario();
    const out = await s.record({ note: "Matched to statement line 42" });
    const event = s.calls.audits.find((a) => a.action === "order.mbo_receipt.recorded");
    assert.equal(event.actorId, ADMIN);
    assert.equal(event.aggregateType, "Order");
    assert.equal(event.aggregateId, "ord-1");
    assert.equal(event.after.amount, "100.0000");
    assert.equal(event.after.currency, "USD");
    assert.equal(event.after.bankReference, "HSBC-TT-000123");
    assert.equal(event.after.source, MBO_RECEIPT_SOURCE);
    assert.equal(event.reason, "Matched to statement line 42");
    assert.equal(out.auditRecorded, true);
    assert.deepEqual(Object.keys(out.receipt).sort(), ["amount", "bankReference", "currency", "receivedAt", "reconciliationReference", "source"]);
    const text = JSON.stringify(out);
    for (const forbidden of ["accountNumber", "accountHolder", "ifsc", "accountNumberEnc"]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });

  it("15–17. ledger money contributes 0 while NOT_READY, counts once PAYABLE, and a late reversal removes it", async () => {
    const s = scenario({ clientPayable: 70, margin: 30 });
    assert.equal((await s.balance()).earnedNet, 0, "NOT_READY rows contribute nothing");
    await s.record();
    const payable = await s.balance();
    assert.equal(payable.earnedNet, 70);
    assert.equal(payable.available, 70);
    s.ledger.push({ ...s.ledger[0], id: "ft-rev", transactionType: "REVERSAL", supplierReceivable: "-100", clientPayable: "-70", reportingClientPayable: "-70", mboMargin: "-30" });
    const reversed = await s.balance();
    assert.equal(reversed.earnedNet, 0);
    assert.equal(reversed.available, 0);
  });
});

const { PERMISSIONS, USER_ROLES, roleHasPermission } = await import("../src/auth/permissions.js");

describe("admin MBO receipt route — authentication and ADMIN-only authorization (13)", async () => {
  const { default: router } = await import("../src/routes/index.js");
  const { requireAdminRole } = await import("../src/middleware/auth.js");
  const controller = await import("../src/controllers/adminClientSettlements.controller.js");
  const layer = router.stack.find(
    (l) => l.route?.path === "/ops/admin/client-settlements/orders/:orderId/mbo-receipt" && l.route.methods.post,
  );

  function run(middleware, user) {
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, set() {} };
    let nextCalled = false;
    middleware({ user, params: { orderId: "ord-1" }, body: {} }, res, () => { nextCalled = true; });
    return { res, nextCalled };
  }

  it("is registered as POST only, with authenticate, requireAdminRole, a permission gate and audit before the handler", () => {
    assert.ok(layer, "route registered");
    assert.deepEqual(Object.keys(layer.route.methods), ["post"]);
    const names = layer.route.stack.map((s) => s.name || s.handle?.name);
    assert.deepEqual(names.slice(0, 2), ["authenticate", "requireAdminRole"]);
    assert.equal(names.at(-1), "adminRecordMboReceiptHandler");
    assert.ok(names.indexOf("authenticate") < names.indexOf("adminRecordMboReceiptHandler"));
    assert.equal(layer.route.stack.length, 5);
  });

  it("a CLIENT portal user and every non-ADMIN staff role are refused; ADMIN passes", () => {
    const guard = layer.route.stack[1].handle;
    assert.equal(guard, requireAdminRole);
    for (const role of ["CLIENT", "OPERATIONS", "ANALYST", "TECH", "SUPPORT"]) {
      const { res, nextCalled } = run(guard, { id: "u", role });
      assert.equal(res.statusCode, 403, role);
      assert.equal(nextCalled, false, role);
    }
    assert.equal(run(guard, undefined).res.statusCode, 401);
    assert.equal(run(guard, { id: ADMIN, role: "ADMIN" }).nextCalled, true);
  });

  it("the permission gate is FINANCE_OPS_MANAGE: finance_ops:read alone (OPERATIONS) is refused", () => {
    const permission = layer.route.stack[2].handle;
    assert.ok(roleHasPermission("OPERATIONS", PERMISSIONS.FINANCE_OPS_READ), "OPERATIONS reads finance");
    assert.equal(roleHasPermission("OPERATIONS", PERMISSIONS.FINANCE_OPS_MANAGE), false);
    assert.equal(run(permission, { id: ADMIN, role: "ADMIN" }).nextCalled, true);
    for (const role of ["OPERATIONS", "ANALYST", "TECH", "SUPPORT", "CLIENT"]) {
      const { res, nextCalled } = run(permission, { id: "u", role });
      assert.equal(res.statusCode, 403, role);
      assert.equal(nextCalled, false, role);
    }
  });

  it("FINANCE_OPS_MANAGE is finance_ops:manage and is held by ADMIN alone", () => {
    assert.equal(PERMISSIONS.FINANCE_OPS_MANAGE, "finance_ops:manage");
    assert.deepEqual(USER_ROLES.filter((role) => roleHasPermission(role, PERMISSIONS.FINANCE_OPS_MANAGE)), ["ADMIN"]);
  });

  it("the handler takes the actor from the authenticated user, never from the body", async () => {
    const seen = [];
    controller.setMboReceiptServiceForTests({
      recordReceipt: async (orderId, body, actor) => {
        seen.push({ orderId, body, actor });
        return { replayed: false, orderId };
      },
    });
    try {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await controller.adminRecordMboReceiptHandler(
        { params: { orderId: "ord-1" }, body: { amount: "100" }, user: { id: ADMIN, role: "ADMIN" } },
        res,
        (e) => { throw e; },
      );
      assert.equal(res.statusCode, 201);
      assert.deepEqual(seen[0].actor, { actorId: ADMIN });
    } finally {
      controller.setMboReceiptServiceForTests(null);
    }
  });
});

/**
 * The same route through the real Express app (real authenticate, requireAdminRole,
 * requirePermission and auditAction). Only the user lookup, the access-log sink and the receipt
 * service are replaced, so a refusal proves the service was never reached.
 */
describe("admin MBO receipt route — real app: ADMIN only, finance_ops:read is not enough", () => {
  const RECEIPT_PATH = "/ops/admin/client-settlements/orders/ord-1/mbo-receipt";
  const BODY = { receivedAt: "2026-09-26T10:00:00.000Z", amount: "100", currency: "USD", bankReference: "BANK-REF-1" };
  const USERS = Object.fromEntries(
    USER_ROLES.map((role) => [
      role,
      { id: `user-${role.toLowerCase()}`, email: `${role.toLowerCase()}@mbo.test`, name: role, role, clientId: role === "CLIENT" ? "c1" : null, isActive: true },
    ]),
  );
  const calls = [];
  const accessLogs = [];
  const tokens = {};
  let server = null;
  let prisma = null;
  let controller = null;
  let originals = null;

  before(async () => {
    ({ prisma } = await import("../src/database/prisma.js"));
    const { signAccessToken } = await import("../src/modules/auth/auth.service.js");
    const { createApp } = await import("../src/app.js");
    controller = await import("../src/controllers/adminClientSettlements.controller.js");
    originals = { user: prisma.user, accessLog: prisma.accessLog };
    prisma.user = { async findUnique({ where }) { return Object.values(USERS).find((u) => u.id === where.id) ?? null; } };
    prisma.accessLog = { async create({ data }) { accessLogs.push(data); return { id: `log-${accessLogs.length}`, ...data }; } };
    controller.setMboReceiptServiceForTests({
      recordReceipt: async (orderId, body, actor) => {
        calls.push({ orderId, body, actor });
        return { orderId, replayed: false, clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE", eligibility: { eligible: true } };
      },
    });
    for (const role of USER_ROLES) tokens[role] = signAccessToken(USERS[role]);
    const httpServer = http.createServer(createApp());
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    server = {
      baseUrl: `http://127.0.0.1:${httpServer.address().port}/api`,
      close: () => new Promise((resolve) => httpServer.close(resolve)),
    };
  });

  after(async () => {
    controller?.setMboReceiptServiceForTests(null);
    if (originals) Object.assign(prisma, originals);
    if (server) await server.close();
  });

  beforeEach(() => {
    calls.length = 0;
    accessLogs.length = 0;
  });

  async function post(bearer) {
    const headers = { Accept: "application/json", "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const response = await fetch(`${server.baseUrl}${RECEIPT_PATH}`, { method: "POST", headers, body: JSON.stringify(BODY) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  }

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("ADMIN succeeds: 201, service reached with the ADMIN actor, audit row written", async () => {
    const { status } = await post(tokens.ADMIN);
    assert.equal(status, 201);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].actor, { actorId: USERS.ADMIN.id });
    assert.equal(calls[0].orderId, "ord-1");
    await settle();
    await settle();
    const audit = accessLogs.find((row) => row.action === "finance.mbo_receipt.record");
    assert.ok(audit, "audit row");
    assert.equal(audit.userId, USERS.ADMIN.id);
    assert.equal(audit.resource, "order:ord-1");
  });

  it("OPERATIONS gets 403 even though it holds finance_ops:read; the service is never reached", async () => {
    assert.ok(roleHasPermission("OPERATIONS", PERMISSIONS.FINANCE_OPS_READ));
    const { status } = await post(tokens.OPERATIONS);
    assert.equal(status, 403);
    await settle();
    assert.deepEqual(calls, []);
    assert.deepEqual(accessLogs, []);
  });

  for (const role of ["ANALYST", "TECH", "SUPPORT", "CLIENT"]) {
    it(`${role} gets 403 and the service is never reached`, async () => {
      const { status } = await post(tokens[role]);
      assert.equal(status, 403);
      await settle();
      assert.deepEqual(calls, []);
      assert.deepEqual(accessLogs, []);
    });
  }

  it("anonymous gets 401 and the service is never reached", async () => {
    const { status } = await post(null);
    assert.equal(status, 401);
    assert.deepEqual(calls, []);
  });
});
