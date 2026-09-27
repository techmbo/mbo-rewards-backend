import { prisma } from "../../database/prisma.js";
import {
  BALANCE_ELIGIBILITY_GATE,
  ClientBalanceService,
  MIN_WITHDRAWAL_AMOUNT,
  money4,
} from "../finance/clientBalance.service.js";

const MONTHS_SHORT = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthYearFromLabel(label) {
  if (!label) return null;
  const s = String(label).trim();
  // Accept "Aug 2026"
  const m = s.match(/^([A-Za-z]{3})\s*(\d{4})$/);
  if (m) {
    const mon = MONTHS_SHORT[m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()];
    const year = Number(m[2]);
    if (mon && Number.isFinite(year)) return { month: mon, year };
  }
  // Accept "2026-08"
  const m2 = s.match(/^(\d{4})-(\d{2})$/);
  if (m2) {
    const year = Number(m2[1]);
    const mon = Number(m2[2]);
    if (mon >= 1 && mon <= 12 && Number.isFinite(year)) return { month: mon, year };
  }
  return null;
}

function monthYearLabel(month, year) {
  if (!month || !year) return "—";
  const idx = Number(month) - 1;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[idx] || "—"} ${year}`;
}

function isoToDateAndTime(iso) {
  if (!iso) return { date: null, time: null };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: null, time: null };
  return {
    date: d.toISOString(),
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}

function mapWithdrawalStatusToRequestStatus(status) {
  const s = String(status || "").toUpperCase();
  if (s === "REQUESTED") return "UNDER_REVIEW";
  if (s === "PROCESSING") return "APPROVED";
  if (s === "PAID") return "PAID";
  if (s === "REJECTED") return "REJECTED";
  return s || "—";
}

function mapWithdrawalStatusToPayoutStatus(status) {
  const s = String(status || "").toUpperCase();
  if (s === "REQUESTED") return "PENDING";
  if (s === "PROCESSING") return "PROCESSING";
  if (s === "PAID") return "PAID";
  if (s === "REJECTED") return "REJECTED";
  return s || "—";
}

export class AdminClientSettlementsService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.balances = deps.balances ?? new ClientBalanceService({ prisma: this.db });
  }

  /**
   * Settlement KPIs, per currency, from complete database aggregates.
   *
   * Withdrawal-request sums (requested / processing / paid) are reported as what they are. Ledger
   * figures come from the finance ledger through ClientBalanceService:
   *   ledgerPayable          = net FinancialTransaction client payable (gated, see BALANCE_ELIGIBILITY_GATE)
   *   availableForWithdrawal = max(0, ledgerPayable − requested − processing − paid)
   *   eligibleByThreshold    = availableForWithdrawal when it meets the minimum withdrawal, else 0
   *
   * With a clientId every figure is scoped to that client. Amounts of different currencies are
   * never added: `byCurrency` always carries the full picture, and the legacy top-level fields are
   * populated only when exactly one currency is present (null otherwise, currency null).
   */
  async getKpisFromWithdrawals({ clientId = null } = {}) {
    const scope = { clientId: clientId ? String(clientId) : null };
    const [withdrawals, ledger] = await Promise.all([
      this.balances.withdrawalSumsByCurrency(scope, this.db),
      this.balances.ledgerNetByCurrency(scope, this.db),
    ]);

    const currencies = [...new Set([...withdrawals.keys(), ...ledger.keys()])].sort();
    const byCurrency = currencies.map((currency) => {
      const w = withdrawals.get(currency) ?? { requested: 0, processing: 0, paid: 0, rejected: 0, cancelled: 0 };
      const ledgerPayable = money4(ledger.get(currency) ?? 0);
      const availableRaw = money4(ledgerPayable - w.requested - w.processing - w.paid);
      const availableForWithdrawal = Math.max(0, availableRaw);
      return {
        currency,
        requested: money4(w.requested),
        processing: money4(w.processing),
        paid: money4(w.paid),
        rejected: money4(w.rejected),
        cancelled: money4(w.cancelled),
        ledgerPayable,
        availableRaw,
        availableForWithdrawal,
        eligibleByThreshold: availableForWithdrawal >= MIN_WITHDRAWAL_AMOUNT ? availableForWithdrawal : 0,
      };
    });

    const single = byCurrency.length === 1 ? byCurrency[0] : null;
    const none = byCurrency.length === 0;
    const pick = (key) => (single ? single[key] : none ? 0 : null);

    return {
      // Legacy field names, truthful values: ledger-based, single-currency only.
      totalPayable: pick("ledgerPayable"),
      eligibleByThreshold: pick("eligibleByThreshold"),
      availableForWithdrawal: pick("availableForWithdrawal"),
      requestsUnderReview: pick("requested"),
      payoutProcessing: pick("processing"),
      paid: pick("paid"),
      currency: single ? single.currency : null,
      scope: clientId ? "client" : "all_clients",
      clientId: scope.clientId,
      multiCurrency: byCurrency.length > 1,
      byCurrency,
      semantics: {
        totalPayable: "ledger net client payable (FinancialTransaction), not withdrawal-request sums",
        availableForWithdrawal: "ledgerPayable - requested - processing - paid, floored at 0",
        eligibleByThreshold: `availableForWithdrawal when >= minimum withdrawal ${MIN_WITHDRAWAL_AMOUNT}, else 0`,
        eligibilityGate: BALANCE_ELIGIBILITY_GATE,
        source: "financial_transaction",
      },
    };
  }

  async listPayableOrders({ clientId = null, settlementPeriod = null, q = null, skip = 0, take = 25 } = {}) {
    if (!clientId || !settlementPeriod) {
      return { total: 0, items: [], kpis: await this.getKpisFromWithdrawals({ clientId }) };
    }

    const parsed = monthYearFromLabel(settlementPeriod);
    if (!parsed) {
      return { total: 0, items: [], kpis: await this.getKpisFromWithdrawals({ clientId }) };
    }
    const from = new Date(Date.UTC(parsed.year, parsed.month - 1, 1, 0, 0, 0));
    const to = new Date(Date.UTC(parsed.year, parsed.month, 0, 23, 59, 59));

    const where = {
      clientId: String(clientId),
      effectiveAt: { gte: from, lte: to },
    };

    // Search predicates belong in the query: filtering the page after skip/take returned
    // incomplete results, a wrong total and a wrong hasMore.
    const needle = q && String(q).trim() ? String(q).trim() : null;
    if (needle) {
      where.OR = [
        { order: { is: { supplierOrderId: { contains: needle, mode: "insensitive" } } } },
        { order: { is: { merchant: { is: { displayName: { contains: needle, mode: "insensitive" } } } } } },
        { order: { is: { canonicalCampaign: { is: { displayName: { contains: needle, mode: "insensitive" } } } } } },
      ];
    }

    const total = await this.db.financialTransaction.count({ where });

    const transactions = await this.db.financialTransaction.findMany({
      where,
      orderBy: [{ effectiveAt: "desc" }],
      skip,
      take,
      include: {
        commissionRule: true,
        order: {
          include: {
            merchant: true,
            canonicalCampaign: true,
          },
        },
        statementLines: {
          include: {
            statement: {
              include: {
                invoices: true,
              },
            },
          },
        },
      },
    });

    const items = transactions.map((tx) => {
      const gross = Number(tx.commissionRule?.grossCommission ?? 0);
      const clientSplitRate = gross > 0 ? (Number(tx.commissionRule?.clientCommission ?? 0) / gross) * 100 : null;
      const mboSplitRate = gross > 0 ? (Number(tx.commissionRule?.mboCommission ?? 0) / gross) * 100 : null;

      const invoices = (tx.statementLines || []).flatMap((sl) => sl?.statement?.invoices || []);
      const invoiceStatuses = invoices.map((i) => String(i.status || "").toUpperCase());
      let payableStatus = "INVOICED";
      if (invoiceStatuses.includes("PAID")) payableStatus = "PAID";
      else if (invoiceStatuses.includes("PARTIALLY_PAID") || invoiceStatuses.includes("ISSUED") || invoiceStatuses.includes("OVERDUE")) payableStatus = "PAYMENT_PENDING";

      return {
        id: tx.id,
        receivedDate: tx.effectiveAt?.toISOString?.() ?? null,
        confirmedNetworkCommissionAmount: tx.supplierReceivable ?? null,
        splitType: tx.commissionRule?.commissionType ?? null,
        clientSplitRate: clientSplitRate == null ? null : Number(clientSplitRate.toFixed(4)),
        mboSplitRate: mboSplitRate == null ? null : Number(mboSplitRate.toFixed(4)),
        clientCommissionAmount: tx.clientPayable ?? null,
        mboCommissionAmount: tx.mboMargin ?? null,
        currency: tx.originalCurrency ?? tx.commissionRule?.currency ?? null,
        payableStatus,
      };
    });

    return {
      total,
      items,
      kpis: await this.getKpisFromWithdrawals({ clientId }),
    };
  }

  async listWithdrawalInvoiceRequests({ clientId = null, requestStatus = null, q = null, skip = 0, take = 25 } = {}) {
    const where = {};
    if (clientId) where.clientId = String(clientId);
    if (requestStatus) {
      // UI request statuses map to internal withdrawal statuses:
      const s = String(requestStatus).toUpperCase();
      where.status =
        s === "UNDER_REVIEW" ? "REQUESTED" : s === "APPROVED" ? "PROCESSING" : s === "PAID" ? "PAID" : s === "REJECTED" ? "REJECTED" : s;
    }
    if (q && String(q).trim()) {
      // Search by reference (best-effort).
      where.reference = { contains: String(q).trim() };
    }

    const total = await this.db.clientWithdrawal.count({ where });
    const rows = await this.db.clientWithdrawal.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip,
      take,
      include: { client: true },
    });

    const items = rows.map((w) => {
      const { date: requestDate, time: requestTime } = isoToDateAndTime(w.createdAt?.toISOString?.() ?? null);
      const d = w.createdAt ? new Date(w.createdAt) : null;
      const settlementPeriod = d ? monthYearLabel(d.getUTCMonth() + 1, d.getUTCFullYear()) : "—";

      return {
        id: w.id,
        requestId: w.reference,
        client: w.client?.name ?? "—",
        requestDate,
        requestTime,
        settlementPeriod,
        payableRecordCount: null,
        availableAmount: w.amount,
        requestedAmount: w.amount,
        currency: w.currency ?? null,
        billingMethod: "CLIENT_INVOICE_REQUIRED",
        invoiceNumber: null,
        invoiceDocument: null,
        requestStatus: mapWithdrawalStatusToRequestStatus(w.status),
        action: null,
      };
    });

    return { total, items, kpis: await this.getKpisFromWithdrawals({ clientId }) };
  }

  async listPayouts({ clientId = null, payoutStatus = null, skip = 0, take = 25 } = {}) {
    const where = {};
    if (clientId) where.clientId = String(clientId);
    if (payoutStatus) {
      const s = String(payoutStatus).toUpperCase();
      where.status = s === "PROCESSING" ? "PROCESSING" : s === "PAID" ? "PAID" : s === "PENDING" ? "REQUESTED" : s === "REJECTED" ? "REJECTED" : s;
    }

    const total = await this.db.clientWithdrawal.count({ where });
    const rows = await this.db.clientWithdrawal.findMany({
      where,
      orderBy: [{ processedAt: "desc" }, { createdAt: "desc" }],
      skip,
      take,
      include: { client: true },
    });

    const items = rows.map((w) => {
      const baseDate = w.processedAt || w.createdAt;
      const { date: paymentDate, time: paymentTime } = isoToDateAndTime(baseDate?.toISOString?.() ?? null);
      const d = baseDate ? new Date(baseDate) : null;
      const settlementPeriod = d ? monthYearLabel(d.getUTCMonth() + 1, d.getUTCFullYear()) : "—";

      return {
        id: w.id,
        clientPayoutId: w.reference,
        client: w.client?.name ?? "—",
        settlementPeriod,
        requestId: w.reference,
        payableRecordCount: null,
        grossPayableAmount: w.amount,
        adjustmentAmount: 0,
        finalPayoutAmount: w.amount,
        currency: w.currency ?? null,
        payoutStatus: mapWithdrawalStatusToPayoutStatus(w.status),
        paymentDate,
        paymentTime,
        paymentReference: w.reference,
      };
    });

    return { total, items, kpis: await this.getKpisFromWithdrawals({ clientId }) };
  }
}

