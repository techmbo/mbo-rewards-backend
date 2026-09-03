import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PaymentStateService } from "../src/modules/order/paymentState.service.js";

function makeOrder(overrides = {}) {
  return {
    id: "ord-finance-1",
    supplier: "OPTIMISE",
    supplierOrderId: "net-order-1",
    clientId: "client-1",
    validationStatus: "VALIDATION_APPROVED",
    supplierPaymentStatus: "PAYMENT_RECEIVED",
    clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
    currency: "USD",
    metadata: {
      networkCommission: "100",
      networkInvoiceAmount: "100",
      networkPaymentAmount: "100",
      mboReceivedDateTime: "2026-09-01T10:00:00.000Z",
      mboReceiptSource: "BANK_RECONCILIATION",
      mboReceivedAmount: "100",
      mboReceivedCurrency: "USD",
      bankReference: "BANK-1",
    },
    ...overrides,
  };
}

function makeHarness({ order = makeOrder(), transactions = null, requireSupplierReceived = true } = {}) {
  const rows = transactions ?? [
    {
      id: "ft-1",
      supplierReceivable: "100",
      clientPayable: "100",
      transactionType: "EARN",
      originalCurrency: "USD",
      metadata: {},
      calculationMetadata: {},
    },
  ];

  const calls = { updates: [], transactionSelect: null };
  const db = {
    order: {
      async findUnique() {
        return order;
      },
      async update(args) {
        calls.updates.push(args);
        return { ...order, ...args.data };
      },
    },
    financialTransaction: {
      async findMany(args) {
        calls.transactionSelect = args.select;
        return rows;
      },
    },
  };

  const service = new PaymentStateService({
    prisma: db,
    audit: { async record() {} },
    exceptions: { async report() {} },
    requireSupplierReceivedForClientPayable: requireSupplierReceived,
  });

  return { service, calls };
}

async function expectRejected(promise, messagePattern) {
  await assert.rejects(promise, (error) => {
    assert.match(String(error?.message || error), messagePattern);
    return true;
  });
}

describe("Finance safety — client payable transition", () => {
  it("rejects PAYABLE before order confirmation", async () => {
    const { service, calls } = makeHarness({
      order: makeOrder({ validationStatus: "VALIDATION_PENDING" }),
    });

    await expectRejected(
      service.transitionClientPayment("ord-finance-1", "CLIENT_PAYMENT_PAYABLE"),
      /before order confirmation/i,
    );
    assert.equal(calls.updates.length, 0);
  });

  it("requires supplier PAYMENT_RECEIVED when the finance safeguard is enabled", async () => {
    const { service, calls } = makeHarness({
      order: makeOrder({ supplierPaymentStatus: "PAYMENT_PAYABLE" }),
    });

    await expectRejected(
      service.transitionClientPayment("ord-finance-1", "CLIENT_PAYMENT_PAYABLE"),
      /supplier payment must be PAYMENT_RECEIVED/i,
    );
    assert.equal(calls.updates.length, 0);
  });

  it("still requires independent MBO bank receipt after supplier PAYMENT_RECEIVED", async () => {
    const order = makeOrder({
      metadata: {
        networkCommission: "100",
        networkInvoiceAmount: "100",
        networkPaymentAmount: "100",
      },
    });
    const { service, calls } = makeHarness({ order });

    await expectRejected(
      service.transitionClientPayment("ord-finance-1", "CLIENT_PAYMENT_PAYABLE"),
      /MBO actual receipt required/i,
    );
    assert.equal(calls.updates.length, 0);
  });

  it("releases PAYABLE only after complete reconciled finance evidence and queries both financial sides", async () => {
    const { service, calls } = makeHarness();

    const updated = await service.transitionClientPayment(
      "ord-finance-1",
      "CLIENT_PAYMENT_PAYABLE",
    );

    assert.equal(updated.clientPaymentStatus, "CLIENT_PAYMENT_PAYABLE");
    assert.equal(calls.updates.length, 1);
    assert.equal(calls.transactionSelect.supplierReceivable, true);
    assert.equal(calls.transactionSelect.clientPayable, true);
    assert.equal(calls.transactionSelect.transactionType, true);
  });

  it("re-checks finance evidence before later client payment states", async () => {
    const order = makeOrder({
      clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE",
      metadata: {
        networkCommission: "100",
        networkInvoiceAmount: "100",
        networkPaymentAmount: "100",
      },
    });
    const { service, calls } = makeHarness({ order });

    await expectRejected(
      service.transitionClientPayment("ord-finance-1", "CLIENT_PAYMENT_PAID"),
      /MBO actual receipt required/i,
    );
    assert.equal(calls.updates.length, 0);
  });

  it("blocks later payment states when current reconciliation no longer matches", async () => {
    const order = makeOrder({ clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE" });
    const { service, calls } = makeHarness({
      order,
      transactions: [
        {
          id: "ft-1",
          supplierReceivable: "100",
          clientPayable: "80",
          transactionType: "EARN",
          originalCurrency: "USD",
          metadata: {},
          calculationMetadata: {},
        },
      ],
    });

    await expectRejected(
      service.transitionClientPayment("ord-finance-1", "CLIENT_PAYMENT_PROCESSING"),
      /Reconciliation mismatch/i,
    );
    assert.equal(calls.updates.length, 0);
  });

  it("can disable only the supplier-ledger prerequisite without bypassing reconciliation and MBO receipt", async () => {
    const { service } = makeHarness({
      order: makeOrder({ supplierPaymentStatus: "PAYMENT_PAYABLE" }),
      requireSupplierReceived: false,
    });

    const updated = await service.transitionClientPayment(
      "ord-finance-1",
      "CLIENT_PAYMENT_PAYABLE",
    );
    assert.equal(updated.clientPaymentStatus, "CLIENT_PAYMENT_PAYABLE");
  });
});
