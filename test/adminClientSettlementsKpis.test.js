import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";

import { AdminClientSettlementsService } from "../src/modules/ops/adminClientSettlements.service.js";
import { ClientBalanceService, MIN_WITHDRAWAL_AMOUNT } from "../src/modules/finance/clientBalance.service.js";
import { fakeLedgerDb, ft, wd } from "./helpers/ledgerFakes.js";

function dec(v) {
  return new Prisma.Decimal(String(v));
}

/** FinancialTransaction rows with the relations listPayableOrders searches. */
function payableRow({ id, clientId = "c1", effectiveAt = "2026-08-10T00:00:00Z", supplierOrderId, merchant, campaign, clientPayable = 70 }) {
  return {
    id,
    clientId,
    effectiveAt: new Date(effectiveAt),
    supplierReceivable: dec(100),
    clientPayable: dec(clientPayable),
    mboMargin: dec(100 - clientPayable),
    originalCurrency: "USD",
    commissionRule: { grossCommission: dec(100), clientCommission: dec(70), mboCommission: dec(30), commissionType: "PERCENT", currency: "USD" },
    order: {
      supplierOrderId,
      merchant: { displayName: merchant },
      canonicalCampaign: { displayName: campaign },
    },
    statementLines: [],
  };
}

function containsInsensitive(haystack, needle) {
  return String(haystack || "").toLowerCase().includes(String(needle).toLowerCase());
}

/** Evaluates the exact where shape listPayableOrders builds (clientId, effectiveAt range, OR of relation filters). */
function matchesPayableWhere(row, where) {
  if (where.clientId && row.clientId !== where.clientId) return false;
  if (where.effectiveAt) {
    if (where.effectiveAt.gte && row.effectiveAt < where.effectiveAt.gte) return false;
    if (where.effectiveAt.lte && row.effectiveAt > where.effectiveAt.lte) return false;
  }
  if (where.OR) {
    return where.OR.some((branch) => {
      const o = branch.order?.is ?? branch.order ?? {};
      if (o.supplierOrderId) return containsInsensitive(row.order?.supplierOrderId, o.supplierOrderId.contains);
      if (o.merchant) return containsInsensitive(row.order?.merchant?.displayName, (o.merchant.is ?? o.merchant).displayName.contains);
      if (o.canonicalCampaign) {
        return containsInsensitive(row.order?.canonicalCampaign?.displayName, (o.canonicalCampaign.is ?? o.canonicalCampaign).displayName.contains);
      }
      return false;
    });
  }
  return true;
}

function adminHarness({ transactions = [], withdrawals = [], payableRows = [] } = {}) {
  const ledger = fakeLedgerDb({ transactions, withdrawals });
  const queries = [];
  const db = {
    financialTransaction: {
      groupBy: ledger.financialTransaction.groupBy,
      count: async ({ where }) => payableRows.filter((r) => matchesPayableWhere(r, where)).length,
      findMany: async ({ where, skip = 0, take = 25 }) => {
        queries.push({ where, skip, take });
        return payableRows
          .filter((r) => matchesPayableWhere(r, where))
          .sort((a, b) => b.effectiveAt - a.effectiveAt)
          .slice(skip, skip + take);
      },
    },
    clientWithdrawal: { groupBy: ledger.clientWithdrawal.groupBy, count: async () => 0, findMany: async () => [] },
  };
  const service = new AdminClientSettlementsService({ prisma: db, balances: new ClientBalanceService({ prisma: ledger }) });
  return { service, queries };
}

describe("AdminClientSettlementsService — KPI semantics", () => {
  it("scoped to a client: ledger payable and available are separated from withdrawal-request sums", async () => {
    const { service } = adminHarness({
      transactions: [ft({ clientId: "c1", clientPayable: 5000 }), ft({ clientId: "c2", clientPayable: 9999 })],
      withdrawals: [
        wd({ clientId: "c1", amount: 1000, status: "REQUESTED" }),
        wd({ clientId: "c1", amount: 500, status: "PROCESSING" }),
        wd({ clientId: "c1", amount: 1500, status: "PAID" }),
        wd({ clientId: "c1", amount: 700, status: "REJECTED" }),
        wd({ clientId: "c2", amount: 9999, status: "PAID" }),
      ],
    });
    const k = await service.getKpisFromWithdrawals({ clientId: "c1" });
    assert.equal(k.scope, "client");
    assert.equal(k.currency, "USD");
    assert.equal(k.requestsUnderReview, 1000);
    assert.equal(k.payoutProcessing, 500);
    assert.equal(k.paid, 1500);
    assert.equal(k.totalPayable, 5000, "ledger net, not requested+processing+paid (3000)");
    assert.equal(k.availableForWithdrawal, 2000, "5000 − 1000 − 500 − 1500; REJECTED ignored");
    assert.equal(k.eligibleByThreshold, 2000);
    assert.equal(k.byCurrency.length, 1);
    assert.equal(k.byCurrency[0].ledgerPayable, 5000);
    assert.equal(k.byCurrency[0].rejected, 700);
    assert.equal(k.multiCurrency, false);
    assert.match(k.semantics.eligibilityGate, /clientPaymentStatus IN/);
  });

  it("eligibleByThreshold is 0 when available is below the minimum withdrawal", async () => {
    const { service } = adminHarness({ transactions: [ft({ clientPayable: MIN_WITHDRAWAL_AMOUNT - 1 })] });
    const k = await service.getKpisFromWithdrawals({ clientId: "c1" });
    assert.equal(k.availableForWithdrawal, MIN_WITHDRAWAL_AMOUNT - 1);
    assert.equal(k.eligibleByThreshold, 0);
  });

  it("all clients, one currency: top-level fields populated, currency not hardcoded", async () => {
    const { service } = adminHarness({
      transactions: [ft({ clientId: "c1", clientPayable: 100, currency: "INR" }), ft({ clientId: "c2", clientPayable: 200, currency: "INR" })],
      withdrawals: [wd({ clientId: "c2", amount: 50, currency: "INR", status: "PAID" })],
    });
    const k = await service.getKpisFromWithdrawals();
    assert.equal(k.scope, "all_clients");
    assert.equal(k.currency, "INR");
    assert.equal(k.totalPayable, 300);
    assert.equal(k.paid, 50);
    assert.equal(k.availableForWithdrawal, 250);
  });

  it("all clients, mixed currencies: never summed into one number; grouped per currency", async () => {
    const { service } = adminHarness({
      transactions: [ft({ clientId: "c1", clientPayable: 100, currency: "USD" }), ft({ clientId: "c2", clientPayable: 8000, currency: "INR" })],
      withdrawals: [wd({ clientId: "c1", amount: 40, currency: "USD", status: "REQUESTED" }), wd({ clientId: "c2", amount: 3000, currency: "INR", status: "PAID" })],
    });
    const k = await service.getKpisFromWithdrawals();
    assert.equal(k.multiCurrency, true);
    assert.equal(k.currency, null);
    assert.equal(k.totalPayable, null);
    assert.equal(k.availableForWithdrawal, null);
    assert.equal(k.requestsUnderReview, null);
    assert.deepEqual(
      k.byCurrency.map((c) => [c.currency, c.ledgerPayable, c.requested, c.paid, c.availableForWithdrawal]),
      [
        ["INR", 8000, 0, 3000, 5000],
        ["USD", 100, 40, 0, 60],
      ],
    );
  });

  it("no data: zeros and null currency, not a fabricated USD", async () => {
    const { service } = adminHarness();
    const k = await service.getKpisFromWithdrawals();
    assert.equal(k.currency, null);
    assert.equal(k.totalPayable, 0);
    assert.equal(k.availableForWithdrawal, 0);
    assert.deepEqual(k.byCurrency, []);
  });

  it("a withdrawal in a currency with no ledger shows negative availableRaw, floored available", async () => {
    const { service } = adminHarness({ withdrawals: [wd({ clientId: "c1", amount: 300, currency: "USD", status: "PAID" })] });
    const k = await service.getKpisFromWithdrawals({ clientId: "c1" });
    assert.equal(k.byCurrency[0].availableRaw, -300);
    assert.equal(k.availableForWithdrawal, 0);
  });
});

describe("AdminClientSettlementsService — listPayableOrders search pagination (18)", () => {
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    rows.push(
      payableRow({
        id: `ft-${String(i).padStart(2, "0")}`,
        effectiveAt: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T0${i % 10}:00:00Z`,
        supplierOrderId: i % 4 === 0 ? `ACME-${i}` : `ORD-${i}`,
        merchant: i % 4 === 1 ? "Acme Stores" : "Other Brand",
        campaign: i % 4 === 2 ? "Acme Summer" : "Generic Campaign",
      }),
    );
  }
  // Matches for "acme": i%4 ∈ {0,1,2} → 30 rows; non-matches i%4===3 → 10 rows.

  it("total reflects the filtered query and every page is drawn from matches only", async () => {
    const { service, queries } = adminHarness({ payableRows: rows });
    const page1 = await service.listPayableOrders({ clientId: "c1", settlementPeriod: "Aug 2026", q: "acme", skip: 0, take: 25 });
    assert.equal(page1.total, 30, "true filtered total, not the size of the filtered first page");
    assert.equal(page1.items.length, 25);
    const page2 = await service.listPayableOrders({ clientId: "c1", settlementPeriod: "Aug 2026", q: "acme", skip: 25, take: 25 });
    assert.equal(page2.items.length, 5);
    assert.equal(page2.total, 30);
    const ids = new Set([...page1.items, ...page2.items].map((i) => i.id));
    assert.equal(ids.size, 30, "the two pages together cover exactly the 30 matches");
    for (const q of queries) assert.ok(Array.isArray(q.where.OR) && q.where.OR.length === 3, "search predicate is in the DB where");
    const hasMore = 0 + page1.items.length < page1.total;
    assert.equal(hasMore, true);
    assert.equal(25 + page2.items.length < page2.total, false);
  });

  it("before the fix a page could be empty while matches existed later; now a non-matching-heavy page still returns matches", async () => {
    // Only the LAST 5 rows (by effectiveAt desc) match; a post-pagination filter on page 1 of 25 would return 0.
    const tail = [];
    for (let i = 0; i < 30; i += 1) {
      tail.push(
        payableRow({
          id: `t-${i}`,
          effectiveAt: `2026-08-${String(28 - (i % 28)).padStart(2, "0")}T12:00:00Z`,
          supplierOrderId: i >= 25 ? `NEEDLE-${i}` : `PLAIN-${i}`,
          merchant: "Plain",
          campaign: "Plain",
        }),
      );
    }
    const { service } = adminHarness({ payableRows: tail });
    const out = await service.listPayableOrders({ clientId: "c1", settlementPeriod: "2026-08", q: "needle", skip: 0, take: 25 });
    assert.equal(out.total, 5);
    assert.equal(out.items.length, 5);
    assert.ok(out.items.every((i) => i.id.startsWith("t-2")));
  });

  it("without q no OR predicate is added and items are not filtered", async () => {
    const { service, queries } = adminHarness({ payableRows: rows });
    const out = await service.listPayableOrders({ clientId: "c1", settlementPeriod: "Aug 2026", skip: 0, take: 10 });
    assert.equal(out.total, 40);
    assert.equal(out.items.length, 10);
    assert.equal(queries[0].where.OR, undefined);
    assert.equal(out.kpis.scope, "client");
  });
});
