import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOrderReconciliationInputs } from "../src/modules/finance/reconciliation.service.js";

describe("Finance safety — reconciliation evidence integrity", () => {
  it("keeps missing financial transaction amounts null instead of fabricating zero", () => {
    const inputs = buildOrderReconciliationInputs({
      order: { id: "ord-no-ft", supplierOrderId: "net-1", metadata: {} },
      financialTransactions: [],
    });

    assert.equal(inputs.mboGrossNetworkCommission, null);
    assert.equal(inputs.clientPayableAmount, null);
  });

  it("does not use the internal MBO order id as network-order evidence", () => {
    const inputs = buildOrderReconciliationInputs({
      order: { id: "ord-local-only", supplierOrderId: null, metadata: {} },
      financialTransactions: [],
    });

    assert.equal(inputs.networkOrderCount, null);
    assert.equal(inputs.mboOrderCount, 1);
  });

  it("preserves an explicitly evidenced zero financial amount", () => {
    const inputs = buildOrderReconciliationInputs({
      order: { id: "ord-zero", supplierOrderId: "net-zero", metadata: {} },
      financialTransactions: [
        {
          supplierReceivable: "0",
          clientPayable: "0",
          transactionType: "EARN",
        },
      ],
    });

    assert.equal(inputs.mboGrossNetworkCommission, 0);
    assert.equal(inputs.clientPayableAmount, 0);
  });

  it("fails closed to null when a financial amount is invalid instead of coercing it to zero", () => {
    const inputs = buildOrderReconciliationInputs({
      order: { id: "ord-invalid", supplierOrderId: "net-invalid", metadata: {} },
      financialTransactions: [
        {
          supplierReceivable: "not-a-number",
          clientPayable: "50",
          transactionType: "EARN",
        },
      ],
    });

    assert.equal(inputs.mboGrossNetworkCommission, null);
    assert.equal(inputs.clientPayableAmount, 50);
  });

  it("nets signed reversal rows exactly once", () => {
    const inputs = buildOrderReconciliationInputs({
      order: { id: "ord-reversed", supplierOrderId: "net-reversed", metadata: {} },
      financialTransactions: [
        {
          supplierReceivable: "100",
          clientPayable: "70",
          transactionType: "COMMISSION_EARNED",
        },
        {
          supplierReceivable: "-100",
          clientPayable: "-70",
          transactionType: "REVERSAL",
        },
      ],
    });

    assert.equal(inputs.mboGrossNetworkCommission, 0);
    assert.equal(inputs.clientPayableAmount, 0);
  });
});
