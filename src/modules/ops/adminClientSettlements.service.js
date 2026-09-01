import { prisma } from "../../database/prisma.js";

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
  }

  async getKpisFromWithdrawals() {
    const sums = await this.db.clientWithdrawal.groupBy({
      by: ["status"],
      where: { status: { in: ["REQUESTED", "PROCESSING", "PAID", "REJECTED", "CANCELLED"] } },
      _sum: { amount: true },
    });
    const byStatus = Object.fromEntries(sums.map((r) => [r.status, Number(r._sum.amount ?? 0)]));

    const requestsUnderReview = byStatus.REQUESTED ?? 0;
    const payoutProcessing = byStatus.PROCESSING ?? 0;
    const paid = byStatus.PAID ?? 0;
    const totalPayable = requestsUnderReview + payoutProcessing + paid;
    const eligibleByThreshold = totalPayable;
    const availableForWithdrawal = requestsUnderReview + payoutProcessing;

    return {
      totalPayable,
      eligibleByThreshold,
      availableForWithdrawal,
      requestsUnderReview,
      payoutProcessing,
      paid,
      currency: "USD",
    };
  }

  async listPayableOrders({ clientId = null, settlementPeriod = null, q = null, skip = 0, take = 25 } = {}) {
    if (!clientId || !settlementPeriod) {
      return { total: 0, items: [], kpis: await this.getKpisFromWithdrawals() };
    }

    const parsed = monthYearFromLabel(settlementPeriod);
    if (!parsed) {
      return { total: 0, items: [], kpis: await this.getKpisFromWithdrawals() };
    }
    const from = new Date(Date.UTC(parsed.year, parsed.month - 1, 1, 0, 0, 0));
    const to = new Date(Date.UTC(parsed.year, parsed.month, 0, 23, 59, 59));

    const where = {
      clientId: String(clientId),
      effectiveAt: { gte: from, lte: to },
    };

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

      // q is optional; we can filter more precisely here using order refs.
      if (q && String(q).trim()) {
        const needle = String(q).toLowerCase();
        const orderRef = String(tx.order?.supplierOrderId || "").toLowerCase();
        const brand = String(tx.order?.merchant?.displayName || "").toLowerCase();
        const campaign = String(tx.order?.canonicalCampaign?.displayName || "").toLowerCase();
        if (!orderRef.includes(needle) && !brand.includes(needle) && !campaign.includes(needle)) {
          return null;
        }
      }

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

    const filteredItems = items.filter(Boolean);

    return {
      total: filteredItems.length,
      items: filteredItems,
      kpis: await this.getKpisFromWithdrawals(),
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

    return { total, items, kpis: await this.getKpisFromWithdrawals() };
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

    return { total, items, kpis: await this.getKpisFromWithdrawals() };
  }
}

