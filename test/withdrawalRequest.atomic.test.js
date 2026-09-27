import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const { PortalDashboardService } = await import("../src/modules/client/services/portalDashboard.service.js");
const { ClientBalanceService, MIN_WITHDRAWAL_AMOUNT } = await import("../src/modules/finance/clientBalance.service.js");
const { fakeLedgerDb, ft, wd } = await import("./helpers/ledgerFakes.js");

/**
 * requestWithdrawal under a transaction double that behaves like PostgreSQL SERIALIZABLE for this
 * access pattern: every transaction reads the withdrawal aggregate and then inserts into it. A
 * transaction that started before another one committed an insert cannot itself commit — it is
 * rolled back with Prisma's P2034. Writes are buffered per transaction and applied only on commit,
 * so a conflicted transaction leaves no row behind.
 */
const CLIENT_ID = "c1";

function harness({ currency = "USD", transactions = [], withdrawals = [], bank = true, serializable = true } = {}) {
  const ledger = fakeLedgerDb({ transactions, withdrawals });
  const state = ledger.state;
  let version = 0; // bumps on every committed withdrawal insert
  let seq = 0;
  const events = [];

  function txClient(buffer) {
    return {
      financialTransaction: ledger.financialTransaction,
      clientWithdrawal: {
        // Reads see committed state only (buffered rows of this tx are not yet visible to reads
        // either, which is irrelevant here: the service reads before it writes).
        groupBy: (args) => ledger.clientWithdrawal.groupBy(args),
        create: async ({ data }) => {
          if (state.withdrawals.some((w) => w.reference === data.reference) || buffer.some((w) => w.reference === data.reference)) {
            const err = new Error("Unique constraint failed on the fields: (`reference`)");
            err.code = "P2002";
            err.meta = { target: ["reference"] };
            throw err;
          }
          seq += 1;
          const row = {
            id: `wd-${seq}`,
            ...data,
            amount: new Prisma.Decimal(String(data.amount)),
            createdAt: new Date("2026-09-27T10:00:00Z"),
          };
          buffer.push(row);
          return row;
        },
      },
    };
  }

  const runInTransaction = async (fn, options) => {
    events.push({ type: "begin", isolation: options?.isolationLevel ?? null });
    const startVersion = version;
    const buffer = [];
    const out = await fn(txClient(buffer));
    // Commit: serialization check against inserts committed since this tx started.
    if (serializable && buffer.length && version !== startVersion) {
      events.push({ type: "conflict" });
      const err = new Error("Transaction failed due to a write conflict or a deadlock. Please retry your transaction");
      err.code = "P2034";
      throw err;
    }
    for (const row of buffer) state.withdrawals.push(row);
    if (buffer.length) version += 1;
    events.push({ type: "commit", inserted: buffer.length });
    return out;
  };

  const service = new PortalDashboardService({
    prisma: {
      clientBankAccount: { findUnique: async () => (bank ? { id: "bank-1", clientId: CLIENT_ID } : null) },
      clientWithdrawal: {
        findMany: async () => state.withdrawals.slice(-100),
        groupBy: ledger.clientWithdrawal.groupBy,
      },
      financialTransaction: ledger.financialTransaction,
      clientCampaignAssignment: { findMany: async () => [] },
    },
    partnerCampaigns: { assertPartnerClient: async () => ({ id: CLIENT_ID, name: "Client One", currency }) },
    financeConsumer: {
      getMode: () => "LEGACY",
      compareClientEarnings: async () => ({ finance: { net: 0 }, comparison: { status: "MATCH" } }),
      resolveDisplayCommission: ({ legacyApproved, legacyPending }) => ({
        approvedCommission: legacyApproved,
        pendingCommission: legacyPending,
        source: "conversion_snapshot",
        authoritative: true,
      }),
    },
    audit: { record: async () => ({}) },
    balances: new ClientBalanceService({ prisma: ledger }),
    runInTransaction,
  });

  return { service, state, events, request: (amount) => service.requestWithdrawal(CLIENT_ID, { amount, requestedBy: "user-1" }) };
}

function reservedTotal(state, currency = "USD") {
  return state.withdrawals
    .filter((w) => w.currency === currency && ["REQUESTED", "PROCESSING"].includes(w.status))
    .reduce((s, w) => s + Number(w.amount), 0);
}

describe("requestWithdrawal — currency and amount validation", () => {
  it("11. missing client settlement currency fails closed with 409 and writes nothing", async () => {
    const h = harness({ currency: null, transactions: [ft({ clientPayable: 5000 })] });
    await assert.rejects(h.request(1000), (err) => err.statusCode === 409 && /settlement currency is not configured/i.test(err.message));
    assert.equal(h.state.withdrawals.length, 0);
    assert.equal(h.events.length, 0, "no transaction was opened");
  });

  it("11b. getPaymentsSummary with no settlement currency reports available 0 and CURRENCY_NOT_CONFIGURED", async () => {
    const h = harness({ currency: null, transactions: [ft({ clientPayable: 5000 })] });
    const summary = await h.service.getPaymentsSummary(CLIENT_ID);
    assert.equal(summary.currency, null);
    assert.equal(summary.kpis.available, 0);
    assert.equal(summary.kpis.availableRaw, null);
    assert.equal(summary.balance.status, "CURRENCY_NOT_CONFIGURED");
  });

  it("12. the exact available balance can be requested", async () => {
    const h = harness({ transactions: [ft({ clientPayable: 1500 })] });
    const out = await h.request(1500);
    assert.equal(out.amount, 1500);
    assert.equal(out.status, "Requested");
    assert.equal(h.state.withdrawals.length, 1);
    assert.equal(h.state.withdrawals[0].currency, "USD");
    assert.equal(h.state.withdrawals[0].status, "REQUESTED");
    assert.equal(h.state.withdrawals[0].requestedBy, "user-1");
    // Nothing is left after the exact amount.
    const after = await h.service.getPaymentsSummary(CLIENT_ID);
    assert.equal(after.kpis.available, 0);
    assert.equal(after.kpis.inProgress, 1500);
  });

  it("13. an amount above available is rejected and nothing is inserted", async () => {
    const h = harness({ transactions: [ft({ clientPayable: 1500 })] });
    await assert.rejects(h.request(1500.01), /exceeds available balance/);
    assert.equal(h.state.withdrawals.length, 0);
  });

  it("13b. available is the ledger net, not the conversion snapshot: a reversal removes the money", async () => {
    const h = harness({ transactions: [ft({ clientPayable: 1500 }), ft({ clientPayable: -1500, type: "REVERSAL" })] });
    const summary = await h.service.getPaymentsSummary(CLIENT_ID);
    assert.equal(summary.kpis.available, 0);
    assert.equal(summary.availableSource, "financial_transaction");
    await assert.rejects(h.request(1000), /exceeds available balance/);
  });

  it("14. zero and negative amounts are rejected before any transaction", async () => {
    const h = harness({ transactions: [ft({ clientPayable: 5000 })] });
    for (const bad of [0, -1, -1000, "abc", null, undefined]) {
      await assert.rejects(h.request(bad), (err) => err.statusCode === 400, String(bad));
    }
    assert.equal(h.state.withdrawals.length, 0);
    assert.equal(h.events.length, 0);
  });

  it("15. the minimum withdrawal rule is unchanged: 1,000 is the enforced floor (see report on the 100.00 settings label)", async () => {
    assert.equal(MIN_WITHDRAWAL_AMOUNT, 1000);
    const h = harness({ transactions: [ft({ clientPayable: 5000 })] });
    await assert.rejects(h.request(999.99), /Minimum withdrawal is 1,000/);
    await h.request(1000);
    assert.equal(h.state.withdrawals.length, 1);
  });

  it("USD earnings cannot fund an INR client; INR earnings cannot fund a USD client", async () => {
    const usdMoneyInrClient = harness({ currency: "INR", transactions: [ft({ clientPayable: 5000, currency: "USD" })] });
    await assert.rejects(usdMoneyInrClient.request(1000), /exceeds available balance/);
    assert.equal((await usdMoneyInrClient.service.getPaymentsSummary(CLIENT_ID)).kpis.available, 0);

    const inrMoneyUsdClient = harness({ currency: "USD", transactions: [ft({ clientPayable: 5000, currency: "INR" })] });
    await assert.rejects(inrMoneyUsdClient.request(1000), /exceeds available balance/);
    assert.equal((await inrMoneyUsdClient.service.getPaymentsSummary(CLIENT_ID)).kpis.available, 0);
  });

  it("requires a bank account before touching the balance", async () => {
    const h = harness({ bank: false, transactions: [ft({ clientPayable: 5000 })] });
    await assert.rejects(h.request(1000), /Add bank details/);
    assert.equal(h.events.length, 0);
  });
});

describe("requestWithdrawal — concurrency", () => {
  it("16. available 1,500, two simultaneous requests for 1,500: exactly one succeeds, reserved ≤ 1,500", async () => {
    const h = harness({ transactions: [ft({ clientPayable: 1500 })] });

    const results = await Promise.allSettled([h.request(1500), h.request(1500)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    assert.equal(ok.length, 1, "exactly one request succeeds");
    assert.equal(failed.length, 1);
    assert.match(failed[0].reason.message, /exceeds available balance/);
    assert.equal(h.state.withdrawals.length, 1);
    assert.equal(reservedTotal(h.state), 1500);
    assert.ok(reservedTotal(h.state) <= 1500);
    assert.ok(h.events.some((e) => e.type === "conflict"), "the loser hit a serialization conflict");
    assert.ok(h.events.every((e) => e.type !== "begin" || e.isolation === Prisma.TransactionIsolationLevel.Serializable), "every attempt ran SERIALIZABLE");
  });

  it("17. a serialization retry cannot duplicate a withdrawal", async () => {
    const h = harness({ transactions: [ft({ clientPayable: 5000 })] });
    // Both fit individually; the loser retries after P2034 and must insert exactly once.
    const results = await Promise.allSettled([h.request(1000), h.request(1000)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    assert.equal(h.state.withdrawals.length, 2, "two requests, two rows, no duplicate from the retry");
    assert.equal(reservedTotal(h.state), 2000);
    const conflicts = h.events.filter((e) => e.type === "conflict").length;
    const commits = h.events.filter((e) => e.type === "commit" && e.inserted > 0).length;
    assert.equal(conflicts, 1);
    assert.equal(commits, 2);
    assert.equal(new Set(h.state.withdrawals.map((w) => w.reference)).size, 2, "references unique");
  });

  it("gives up after the bounded number of serialization retries instead of looping", async () => {
    const ledger = fakeLedgerDb({ transactions: [ft({ clientPayable: 5000 })] });
    let attempts = 0;
    const service = new PortalDashboardService({
      prisma: { clientBankAccount: { findUnique: async () => ({ id: "b" }) }, clientWithdrawal: { findMany: async () => [] }, clientCampaignAssignment: { findMany: async () => [] } },
      partnerCampaigns: { assertPartnerClient: async () => ({ id: CLIENT_ID, currency: "USD" }) },
      audit: { record: async () => ({}) },
      balances: new ClientBalanceService({ prisma: ledger }),
      runInTransaction: async () => {
        attempts += 1;
        const err = new Error("conflict");
        err.code = "P2034";
        throw err;
      },
    });
    await assert.rejects(service.requestWithdrawal(CLIENT_ID, { amount: 1000 }), (err) => err.code === "P2034");
    assert.equal(attempts, 4, "1 attempt + 3 bounded retries");
  });

  it("a reference collision is retried with a new reference and inserts exactly once", async () => {
    const h = harness({ transactions: [ft({ clientPayable: 5000 })], withdrawals: [] });
    // Pre-seed every WD-1000..WD-9999 except one so the generator collides until it finds it? Too
    // large; instead seed a committed row and force the generator to hit it first.
    const realRandom = Math.random;
    const seededRef = { clientId: CLIENT_ID, reference: "WD-1234", amount: new Prisma.Decimal("10"), currency: "USD", status: "PAID" };
    h.state.withdrawals.push(seededRef);
    let calls = 0;
    Math.random = () => {
      calls += 1;
      return calls === 1 ? (1234 - 1000) / 9000 : (5678 - 1000) / 9000; // first WD-1234 (collides), then WD-5678
    };
    try {
      const out = await h.request(1000);
      assert.equal(out.reference, "WD-5678");
    } finally {
      Math.random = realRandom;
    }
    assert.equal(h.state.withdrawals.filter((w) => w.status === "REQUESTED").length, 1);
  });
});
