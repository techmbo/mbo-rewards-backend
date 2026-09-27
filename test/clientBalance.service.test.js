import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BALANCE_ELIGIBILITY_GATE,
  ClientBalanceService,
  PAYABLE_ORDER_STATUSES,
  resolveSettlementCurrency,
} from "../src/modules/finance/clientBalance.service.js";
import { CLIENT_FINANCE_GATED_STATUSES } from "../src/modules/order/paymentState.service.js";

import { NOT_READY_ORDER, PAYABLE_ORDER, fakeLedgerDb, ft, wd } from "./helpers/ledgerFakes.js";

async function balance(db, currency = "USD", opts = {}) {
  return new ClientBalanceService({ prisma: db, ...opts }).computeBalance({ clientId: "c1", currency });
}

describe("ClientBalanceService — ledger is authoritative", () => {
  it("1. earn +100 → available 100", async () => {
    const b = await balance(fakeLedgerDb({ transactions: [ft({ clientPayable: 100 })] }));
    assert.equal(b.earnedNet, 100);
    assert.equal(b.reserved, 0);
    assert.equal(b.paid, 0);
    assert.equal(b.availableRaw, 100);
    assert.equal(b.available, 100);
    assert.equal(b.currency, "USD");
    assert.equal(b.source, "financial_transaction");
  });

  it("2. earn +100, reversal −100 → available 0", async () => {
    const b = await balance(
      fakeLedgerDb({ transactions: [ft({ clientPayable: 100 }), ft({ clientPayable: -100, type: "REVERSAL" })] }),
    );
    assert.equal(b.earnedNet, 0);
    assert.equal(b.available, 0);
    assert.equal(b.availableRaw, 0);
  });

  it("3. earn +100, adjustment −25 → available 75", async () => {
    const b = await balance(
      fakeLedgerDb({ transactions: [ft({ clientPayable: 100 }), ft({ clientPayable: -25, type: "ADJUSTMENT" })] }),
    );
    assert.equal(b.earnedNet, 75);
    assert.equal(b.available, 75);
  });

  it("4. earn +1000, REQUESTED 300 → available 700 (reserved 300)", async () => {
    const b = await balance(
      fakeLedgerDb({ transactions: [ft({ clientPayable: 1000 })], withdrawals: [wd({ amount: 300, status: "REQUESTED" })] }),
    );
    assert.equal(b.reserved, 300);
    assert.equal(b.requested, 300);
    assert.equal(b.available, 700);
  });

  it("5. earn +1000, PROCESSING 300 → available 700 (reserved 300)", async () => {
    const b = await balance(
      fakeLedgerDb({ transactions: [ft({ clientPayable: 1000 })], withdrawals: [wd({ amount: 300, status: "PROCESSING" })] }),
    );
    assert.equal(b.reserved, 300);
    assert.equal(b.processing, 300);
    assert.equal(b.available, 700);
  });

  it("6. earn +1000, PAID 300 → available 700 (paid 300, reserved 0)", async () => {
    const b = await balance(
      fakeLedgerDb({ transactions: [ft({ clientPayable: 1000 })], withdrawals: [wd({ amount: 300, status: "PAID" })] }),
    );
    assert.equal(b.paid, 300);
    assert.equal(b.reserved, 0);
    assert.equal(b.available, 700);
  });

  it("7. REJECTED withdrawal does not reserve balance", async () => {
    const b = await balance(
      fakeLedgerDb({ transactions: [ft({ clientPayable: 1000 })], withdrawals: [wd({ amount: 300, status: "REJECTED" })] }),
    );
    assert.equal(b.reserved, 0);
    assert.equal(b.paid, 0);
    assert.equal(b.available, 1000);
  });

  it("8. CANCELLED withdrawal does not reserve balance", async () => {
    const b = await balance(
      fakeLedgerDb({ transactions: [ft({ clientPayable: 1000 })], withdrawals: [wd({ amount: 300, status: "CANCELLED" })] }),
    );
    assert.equal(b.reserved, 0);
    assert.equal(b.paid, 0);
    assert.equal(b.available, 1000);
  });

  it("9. more than 100 historical PAID withdrawals are all counted", async () => {
    const withdrawals = [];
    for (let i = 0; i < 150; i += 1) withdrawals.push(wd({ amount: 10, status: "PAID" }));
    const b = await balance(fakeLedgerDb({ transactions: [ft({ clientPayable: 2000 })], withdrawals }));
    assert.equal(b.paid, 1500, "all 150 PAID rows (1,500) consumed, not only the latest 100");
    assert.equal(b.available, 500);
  });

  it("10. mixed currencies are never added: USD earnings do not raise INR available and vice versa", async () => {
    const db = fakeLedgerDb({
      transactions: [
        ft({ clientPayable: 100, currency: "USD" }),
        ft({ clientPayable: 5000, currency: "INR" }),
      ],
      withdrawals: [wd({ amount: 40, currency: "USD", status: "PAID" }), wd({ amount: 1000, currency: "INR", status: "REQUESTED" })],
    });
    const usd = await balance(db, "USD");
    const inr = await balance(db, "INR");
    assert.equal(usd.earnedNet, 100);
    assert.equal(usd.paid, 40);
    assert.equal(usd.reserved, 0);
    assert.equal(usd.available, 60);
    assert.equal(inr.earnedNet, 5000);
    assert.equal(inr.reserved, 1000);
    assert.equal(inr.paid, 0);
    assert.equal(inr.available, 4000);
    const eur = await balance(db, "EUR");
    assert.equal(eur.earnedNet, 0);
    assert.equal(eur.available, 0);
  });

  it("uses the reporting leg when the row is expressed in the requested currency, else the original leg", async () => {
    // Original USD 10, reported as INR 830 (FX). Requested INR → 830; requested USD → 10.
    const db = fakeLedgerDb({
      transactions: [ft({ clientPayable: 10, currency: "USD", reportingCurrency: "INR", reportingClientPayable: 830 })],
    });
    assert.equal((await balance(db, "INR")).earnedNet, 830);
    assert.equal((await balance(db, "USD")).earnedNet, 10);
    // Reporting currency set but reporting amount missing → falls back to the original leg only.
    const db2 = fakeLedgerDb({
      transactions: [ft({ clientPayable: 10, currency: "USD", reportingCurrency: "USD", reportingClientPayable: null })],
    });
    assert.equal((await balance(db2, "USD")).earnedNet, 10);
  });

  it("negative ledger positions are exposed as availableRaw and floored at 0 for available", async () => {
    const b = await balance(
      fakeLedgerDb({ transactions: [ft({ clientPayable: 100 }), ft({ clientPayable: -100, type: "REVERSAL" })], withdrawals: [wd({ amount: 100, status: "PAID" })] }),
    );
    assert.equal(b.availableRaw, -100);
    assert.equal(b.available, 0);
  });

  it("scopes to the client: another client's ledger and withdrawals never leak in", async () => {
    const b = await balance(
      fakeLedgerDb({
        transactions: [ft({ clientPayable: 100 }), ft({ clientId: "c2", clientPayable: 900 })],
        withdrawals: [wd({ clientId: "c2", amount: 900, status: "PAID" })],
      }),
    );
    assert.equal(b.earnedNet, 100);
    assert.equal(b.paid, 0);
    assert.equal(b.available, 100);
  });
});

describe("ClientBalanceService — payable-order eligibility gate", () => {
  it("uses the existing PaymentStateService gated statuses, not an invented list", () => {
    assert.deepEqual(new Set(PAYABLE_ORDER_STATUSES), CLIENT_FINANCE_GATED_STATUSES);
    for (const s of ["CLIENT_PAYMENT_PAYABLE", "CLIENT_PAYMENT_INVOICED", "CLIENT_PAYMENT_PROCESSING", "CLIENT_PAYMENT_PAID"]) {
      assert.ok(PAYABLE_ORDER_STATUSES.includes(s), s);
    }
    assert.ok(!PAYABLE_ORDER_STATUSES.includes("CLIENT_PAYMENT_NOT_READY"));
    assert.ok(!PAYABLE_ORDER_STATUSES.includes("CLIENT_PAYMENT_ON_HOLD"));
    assert.match(BALANCE_ELIGIBILITY_GATE, /clientPaymentStatus IN \(CLIENT_PAYMENT_PAYABLE/);
  });

  it("ledger rows whose order has not passed the gate do not contribute", async () => {
    const db = fakeLedgerDb({
      transactions: [
        ft({ clientPayable: 100, order: PAYABLE_ORDER }),
        ft({ clientPayable: 250, order: NOT_READY_ORDER }),
        ft({ clientPayable: 30, order: { clientPaymentStatus: "CLIENT_PAYMENT_ON_HOLD" } }),
        ft({ clientPayable: 5, order: null }),
      ],
    });
    const b = await balance(db);
    assert.equal(b.earnedNet, 100);
    assert.equal(b.eligibilityGate, BALANCE_ELIGIBILITY_GATE);
  });

  it("an earn and its later reversal share the order, so gating never strands one side", async () => {
    const order = { clientPaymentStatus: "CLIENT_PAYMENT_PAID" };
    const db = fakeLedgerDb({
      transactions: [ft({ clientPayable: 100, order }), ft({ clientPayable: -100, type: "REVERSAL", order })],
    });
    assert.equal((await balance(db)).earnedNet, 0);
  });

  it("requirePayableOrder: false yields the ungated ledger net and says so", async () => {
    const db = fakeLedgerDb({
      transactions: [ft({ clientPayable: 100, order: PAYABLE_ORDER }), ft({ clientPayable: 250, order: NOT_READY_ORDER })],
    });
    const b = await balance(db, "USD", { requirePayableOrder: false });
    assert.equal(b.earnedNet, 350);
    assert.equal(b.eligibilityGate, "none");
  });
});

describe("resolveSettlementCurrency", () => {
  it("returns an explicit 3-letter code or null — never a default", () => {
    assert.equal(resolveSettlementCurrency({ currency: "inr" }), "INR");
    assert.equal(resolveSettlementCurrency({ currency: " USD " }), "USD");
    assert.equal(resolveSettlementCurrency({ currency: null }), null);
    assert.equal(resolveSettlementCurrency({ currency: "" }), null);
    assert.equal(resolveSettlementCurrency({ currency: "US" }), null);
    assert.equal(resolveSettlementCurrency({}), null);
    assert.equal(resolveSettlementCurrency(null), null);
  });
});
