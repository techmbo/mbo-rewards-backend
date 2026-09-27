import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";
import { CLIENT_FINANCE_GATED_STATUSES } from "../order/paymentState.service.js";

/**
 * Authoritative client withdrawal balance — the one place that decides how much of a client's
 * money is available to withdraw, for ONE client and ONE settlement currency.
 *
 *   earnedNet    = net FinancialTransaction client payable in the currency (COMMISSION_EARNED plus
 *                  signed REVERSAL and ADJUSTMENT rows), restricted to orders whose client payment
 *                  status has passed the existing payable gate (see ELIGIBILITY below)
 *   reserved     = Σ ClientWithdrawal.amount, same client + currency, status REQUESTED | PROCESSING
 *   paid         = Σ ClientWithdrawal.amount, same client + currency, status PAID
 *   availableRaw = earnedNet − reserved − paid           (may be negative; never hidden)
 *   available    = max(0, availableRaw)
 *
 * REJECTED and CANCELLED withdrawals never consume availability.
 *
 * CURRENCY. A FinancialTransaction contributes to currency C through exactly one leg:
 *   - reportingClientPayable, when reportingCurrency = C and reportingClientPayable is set;
 *   - otherwise clientPayable, only when originalCurrency = C.
 * Amounts in different currencies are never added together. All sums are database aggregates
 * (groupBy/_sum) — no row cap, no in-memory paging.
 *
 * ELIGIBILITY. The existing payable rule lives in PaymentStateService.transitionClientPayment:
 * an order may enter CLIENT_PAYMENT_PAYABLE / INVOICED / PROCESSING / PAID only when it is
 * VALIDATION_APPROVED, the supplier payment is PAYMENT_RECEIVED, an MBO actual bank receipt is
 * recorded, and reconciliation passes (financeSeparation.contract.resolveClientPayableEligibility).
 * Order.clientPaymentStatus is the persisted outcome of that rule, and every earn, reversal and
 * adjustment row carries the orderId, so the ledger is tied to the gate through
 * FinancialTransaction.order.clientPaymentStatus ∈ CLIENT_FINANCE_GATED_STATUSES. Rows without an
 * order are not eligible. The gate is on by default; `requirePayableOrder: false` exists only for
 * callers that deliberately want the ungated ledger net (reporting), never for authorising money.
 */

export const WITHDRAWAL_RESERVED_STATUSES = Object.freeze(["REQUESTED", "PROCESSING"]);
export const WITHDRAWAL_PAID_STATUSES = Object.freeze(["PAID"]);
export const WITHDRAWAL_NON_CONSUMING_STATUSES = Object.freeze(["REJECTED", "CANCELLED"]);

/** Existing portal rule (requestWithdrawal). See the Phase 1 report for the 1,000 vs "100.00" question. */
export const MIN_WITHDRAWAL_AMOUNT = 1000;

export const PAYABLE_ORDER_STATUSES = Object.freeze([...CLIENT_FINANCE_GATED_STATUSES]);

export const BALANCE_ELIGIBILITY_GATE =
  "FinancialTransaction.order.clientPaymentStatus IN (" + PAYABLE_ORDER_STATUSES.join(", ") + ")";

export function money4(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(4)) : 0;
}

/**
 * Settlement currency of a client: an explicit 3-letter code or null. Never a default.
 * Callers that authorise money must fail closed on null.
 */
export function resolveSettlementCurrency(client) {
  const raw = client?.currency;
  if (raw == null) return null;
  const code = String(raw).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

export function normalizeCurrency(value) {
  if (value == null) return null;
  const code = String(value).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** Prisma raises P2034 when a SERIALIZABLE transaction loses a write conflict or deadlocks. */
export function isSerializationConflict(error) {
  return error?.code === "P2034";
}

export function isUniqueViolationOn(error, field) {
  if (error?.code !== "P2002") return false;
  const target = error?.meta?.target;
  if (!field) return true;
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === "string") return target.includes(field);
  return true;
}

function sumOf(row, key) {
  return money4(row?._sum?.[key] ?? 0);
}

function addTo(map, key, amount) {
  if (!key) return;
  map.set(key, money4((map.get(key) ?? 0) + amount));
}

export class ClientBalanceService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.requirePayableOrder = deps.requirePayableOrder !== false;
  }

  #ledgerWhere({ clientId = null } = {}) {
    const where = {};
    if (clientId) where.clientId = clientId;
    if (this.requirePayableOrder) {
      where.order = { is: { clientPaymentStatus: { in: PAYABLE_ORDER_STATUSES } } };
    }
    return where;
  }

  /**
   * Net ledger client payable per currency, as complete database aggregates.
   * Returns Map<currency, net>. With clientId null it spans all clients (admin view).
   */
  async ledgerNetByCurrency({ clientId = null } = {}, client = null) {
    const db = client ?? this.db;
    const base = this.#ledgerWhere({ clientId });
    const net = new Map();

    // Leg 1: rows expressed in a reporting currency → reportingClientPayable under reportingCurrency.
    const reporting = await db.financialTransaction.groupBy({
      by: ["reportingCurrency"],
      where: { ...base, reportingCurrency: { not: null }, reportingClientPayable: { not: null } },
      _sum: { reportingClientPayable: true },
    });
    for (const row of reporting) {
      addTo(net, normalizeCurrency(row.reportingCurrency), sumOf(row, "reportingClientPayable"));
    }

    // Leg 2a: rows with no reporting amount → clientPayable under originalCurrency.
    const originalOnly = await db.financialTransaction.groupBy({
      by: ["originalCurrency"],
      where: { ...base, OR: [{ reportingCurrency: null }, { reportingClientPayable: null }] },
      _sum: { clientPayable: true },
    });
    for (const row of originalOnly) {
      addTo(net, normalizeCurrency(row.originalCurrency), sumOf(row, "clientPayable"));
    }

    // Leg 2b: rows reported in ANOTHER currency also count under their original currency (the
    // same money seen from its original side). Rows whose reporting currency equals the original
    // currency were already counted in leg 1 and are skipped here.
    const crossReported = await db.financialTransaction.groupBy({
      by: ["originalCurrency", "reportingCurrency"],
      where: { ...base, reportingCurrency: { not: null }, reportingClientPayable: { not: null } },
      _sum: { clientPayable: true },
    });
    for (const row of crossReported) {
      const original = normalizeCurrency(row.originalCurrency);
      const reported = normalizeCurrency(row.reportingCurrency);
      if (!original || original === reported) continue;
      addTo(net, original, sumOf(row, "clientPayable"));
    }

    return net;
  }

  /**
   * Withdrawal sums per currency and status, as complete database aggregates.
   * Returns Map<currency, { requested, processing, paid, rejected, cancelled, reserved }>.
   */
  async withdrawalSumsByCurrency({ clientId = null } = {}, client = null) {
    const db = client ?? this.db;
    const rows = await db.clientWithdrawal.groupBy({
      by: ["currency", "status"],
      where: clientId ? { clientId } : {},
      _sum: { amount: true },
    });
    const out = new Map();
    for (const row of rows) {
      const cur = normalizeCurrency(row.currency);
      if (!cur) continue;
      if (!out.has(cur)) {
        out.set(cur, { requested: 0, processing: 0, paid: 0, rejected: 0, cancelled: 0, reserved: 0 });
      }
      const bucket = out.get(cur);
      const amount = sumOf(row, "amount");
      const status = String(row.status || "").toUpperCase();
      if (status === "REQUESTED") bucket.requested = money4(bucket.requested + amount);
      else if (status === "PROCESSING") bucket.processing = money4(bucket.processing + amount);
      else if (status === "PAID") bucket.paid = money4(bucket.paid + amount);
      else if (status === "REJECTED") bucket.rejected = money4(bucket.rejected + amount);
      else if (status === "CANCELLED") bucket.cancelled = money4(bucket.cancelled + amount);
      bucket.reserved = money4(bucket.requested + bucket.processing);
    }
    return out;
  }

  /**
   * The authoritative balance for one client in one settlement currency.
   * Pass the transaction client when the result authorises a write (requestWithdrawal).
   */
  async computeBalance({ clientId, currency }, client = null) {
    if (!clientId) throw new Error("computeBalance requires clientId.");
    const cur = normalizeCurrency(currency);
    if (!cur) throw new Error("computeBalance requires a 3-letter settlement currency.");

    const [ledger, withdrawals] = await Promise.all([
      this.ledgerNetByCurrency({ clientId }, client),
      this.withdrawalSumsByCurrency({ clientId }, client),
    ]);
    const earnedNet = money4(ledger.get(cur) ?? 0);
    const w = withdrawals.get(cur) ?? { requested: 0, processing: 0, paid: 0, reserved: 0 };
    const reserved = money4(w.reserved);
    const paid = money4(w.paid);
    const availableRaw = money4(earnedNet - reserved - paid);

    return {
      clientId,
      currency: cur,
      earnedNet,
      reserved,
      requested: money4(w.requested),
      processing: money4(w.processing),
      paid,
      availableRaw,
      available: Math.max(0, availableRaw),
      source: "financial_transaction",
      eligibilityGate: this.requirePayableOrder ? BALANCE_ELIGIBILITY_GATE : "none",
    };
  }
}

/** Transaction options for money-authorising writes: SERIALIZABLE so concurrent spenders conflict. */
export const SERIALIZABLE_MONEY_TX_OPTIONS = Object.freeze({
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 15_000,
});
