import { Prisma } from "@prisma/client";

/**
 * In-memory Prisma double that implements exactly the aggregate shapes ClientBalanceService uses:
 * financialTransaction.groupBy and clientWithdrawal.groupBy with `where` + `_sum`. Amounts are
 * Prisma.Decimal like the real client returns. No row limits exist anywhere in the double, so a
 * balance that ignores rows can only come from the service under test.
 */
function dec(v) {
  return new Prisma.Decimal(String(v));
}

function matches(row, where = {}) {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!cond.some((sub) => matches(row, sub))) return false;
      continue;
    }
    if (key === "order") {
      const status = row.order?.clientPaymentStatus ?? null;
      const allowed = cond?.is?.clientPaymentStatus?.in ?? cond?.clientPaymentStatus?.in ?? null;
      if (!row.order || (allowed && !allowed.includes(status))) return false;
      continue;
    }
    if (cond !== null && typeof cond === "object" && !(cond instanceof Prisma.Decimal)) {
      if ("not" in cond) {
        if (cond.not === null) {
          if (row[key] == null) return false;
        } else if (row[key] == null || row[key] === cond.not) return false;
        continue;
      }
      if ("in" in cond) {
        if (!cond.in.includes(row[key])) return false;
        continue;
      }
    }
    if (cond === null) {
      if (row[key] != null) return false;
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

function groupBy(rows, { by, where, _sum }) {
  const groups = new Map();
  for (const row of rows.filter((r) => matches(r, where))) {
    const key = by.map((k) => row[k] ?? "∅").join("|");
    if (!groups.has(key)) {
      const g = { _sum: {} };
      for (const k of by) g[k] = row[k] ?? null;
      for (const s of Object.keys(_sum)) g._sum[s] = 0;
      groups.set(key, g);
    }
    const g = groups.get(key);
    for (const s of Object.keys(_sum)) {
      if (row[s] != null) g._sum[s] = Number((g._sum[s] + Number(row[s])).toFixed(4));
    }
  }
  return [...groups.values()].map((g) => ({
    ...g,
    _sum: Object.fromEntries(Object.entries(g._sum).map(([k, v]) => [k, dec(v)])),
  }));
}

export function fakeLedgerDb({ transactions = [], withdrawals = [] } = {}) {
  const state = { transactions: [...transactions], withdrawals: [...withdrawals] };
  return {
    state,
    financialTransaction: { groupBy: async (args) => groupBy(state.transactions, args) },
    clientWithdrawal: { groupBy: async (args) => groupBy(state.withdrawals, args) },
  };
}

export const PAYABLE_ORDER = { clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE" };
export const NOT_READY_ORDER = { clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY" };

/** A ledger row in one currency, reporting leg equal to original (same-currency FX bundle). */
export function ft({
  clientId = "c1",
  clientPayable,
  currency = "USD",
  type = "COMMISSION_EARNED",
  order = PAYABLE_ORDER,
  reportingCurrency = currency,
  reportingClientPayable = clientPayable,
} = {}) {
  return {
    clientId,
    transactionType: type,
    clientPayable: dec(clientPayable),
    originalCurrency: currency,
    reportingCurrency,
    reportingClientPayable: reportingClientPayable == null ? null : dec(reportingClientPayable),
    order,
  };
}

export function wd({ clientId = "c1", amount, currency = "USD", status = "REQUESTED" } = {}) {
  return { clientId, amount: dec(amount), currency, status };
}
