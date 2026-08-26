import { prisma } from "../../database/prisma.js";
import { NetworkPortalService } from "../networkPortal/networkPortal.service.js";

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthYearLabel(billingMonth, billingYear) {
  const m = Number(billingMonth);
  const y = Number(billingYear);
  if (!Number.isFinite(m) || !Number.isFinite(y)) return "—";
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}

function isoToDateAndTime(value) {
  if (!value) return { date: null, time: null };
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return { date: null, time: null };
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: d.toISOString(),
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

function mapOrderPaymentStatusToUi(supplierPaymentStatus) {
  const s = String(supplierPaymentStatus || "").toUpperCase();
  if (s === "PAYMENT_RECEIVED") return "PAID";
  if (s === "PAYMENT_PAYABLE" || s === "PAYMENT_INVOICED") return "INVOICED";
  if (s === "PAYMENT_REJECTED" || s === "REJECTED") return "REJECTED";
  if (s === "PAYMENT_ON_HOLD") return "ON_HOLD";
  if (s) return "PAYMENT_PENDING";
  return "PAYMENT_PENDING";
}

function supplierReceivableTotal(order) {
  let amt = 0;
  let hasFt = false;
  for (const ft of order.financialTransactions || []) {
    hasFt = true;
    const v = Number(ft.supplierReceivable) || 0;
    if (ft.transactionType === "REVERSAL") amt -= v;
    else amt += v;
  }
  if (hasFt && amt !== 0) return amt;
  const snapshot = Number(order.lastApprovedSupplierCommission);
  if (Number.isFinite(snapshot) && snapshot !== 0) return snapshot;
  const conv = order.conversions?.[0];
  const fromConv = Number(conv?.approvedCommission ?? conv?.supplierCommission);
  return Number.isFinite(fromConv) ? fromConv : 0;
}

function brandNameOf(order, lookups = {}) {
  const direct =
    order.merchant?.displayName ||
    order.canonicalCampaign?.displayName ||
    order.campaignSource?.supplierCampaign?.merchantNameRaw ||
    order.campaignSource?.supplierCampaign?.campaignName ||
    null;
  if (direct) return direct;

  const meta =
    order.conversions?.[0]?.metadata && typeof order.conversions[0].metadata === "object"
      ? order.conversions[0].metadata
      : {};
  const couponCode = String(meta.couponCode || meta.attributionHints?.couponCode || "")
    .trim()
    .toLowerCase();
  if (couponCode && lookups.brandByCoupon?.[couponCode]) {
    return lookups.brandByCoupon[couponCode];
  }
  const scId = String(meta.supplierCampaignId || "").trim();
  if (scId && lookups.brandBySupplierCampaignId?.[scId]) {
    return lookups.brandBySupplierCampaignId[scId];
  }
  return null;
}

function orderBillingPeriod(order) {
  const anchor = order.orderDate || order.receivedAt || order.createdAt;
  if (!anchor) return null;
  const d = anchor instanceof Date ? anchor : new Date(anchor);
  if (Number.isNaN(d.getTime())) return null;
  return { billingMonth: d.getUTCMonth() + 1, billingYear: d.getUTCFullYear(), anchor: d };
}

/**
 * Finance lists that previously depended only on NetworkReconciliationRow.orderDrilldown.
 * Primary source is live Orders (+ FT supplierReceivable) — same truth as Payment Status.
 * Reconciliation rows remain available for R/C/P and are auto-rebuilt when empty.
 */
export class AdminNetworkFinanceService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.networkPortal = deps.networkPortal ?? new NetworkPortalService({ prisma: this.db });
  }

  /**
   * Optimise (and some other) orders often have merchantId/campaignSourceId null.
   * Recover brand via coupon code → SupplierCampaign, or supplierCampaignId → SupplierCampaign.
   */
  async buildBrandLookups(orders = []) {
    const couponCodes = new Set();
    const supplierCampaignIds = new Set();
    for (const order of orders) {
      const meta =
        order.conversions?.[0]?.metadata && typeof order.conversions[0].metadata === "object"
          ? order.conversions[0].metadata
          : {};
      const code = String(meta.couponCode || meta.attributionHints?.couponCode || "").trim();
      if (code) couponCodes.add(code);
      const scId = String(meta.supplierCampaignId || "").trim();
      if (scId) supplierCampaignIds.add(scId);
    }

    /** @type {Record<string, string>} */
    const brandByCoupon = {};
    /** @type {Record<string, string>} */
    const brandBySupplierCampaignId = {};

    if (couponCodes.size) {
      const coupons = await this.db.supplierCoupon.findMany({
        where: {
          OR: [...couponCodes].map((code) => ({
            couponCode: { equals: code, mode: "insensitive" },
          })),
        },
        select: {
          couponCode: true,
          supplierCampaign: {
            select: {
              supplierCampaignId: true,
              merchantNameRaw: true,
              campaignName: true,
              merchant: { select: { displayName: true } },
            },
          },
        },
        take: Math.min(couponCodes.size * 5, 200),
      });
      for (const c of coupons) {
        const brand =
          c.supplierCampaign?.merchant?.displayName ||
          c.supplierCampaign?.merchantNameRaw ||
          c.supplierCampaign?.campaignName ||
          null;
        if (!brand || !c.couponCode) continue;
        brandByCoupon[String(c.couponCode).trim().toLowerCase()] = brand;
        if (c.supplierCampaign?.supplierCampaignId) {
          brandBySupplierCampaignId[String(c.supplierCampaign.supplierCampaignId)] = brand;
        }
      }
    }

    const missingScIds = [...supplierCampaignIds].filter((id) => !brandBySupplierCampaignId[id]);
    if (missingScIds.length) {
      const campaigns = await this.db.supplierCampaign.findMany({
        where: { supplierCampaignId: { in: missingScIds } },
        select: {
          supplierCampaignId: true,
          merchantNameRaw: true,
          campaignName: true,
          merchant: { select: { displayName: true } },
        },
        take: 200,
      });
      for (const sc of campaigns) {
        const brand = sc.merchant?.displayName || sc.merchantNameRaw || sc.campaignName || null;
        if (brand && sc.supplierCampaignId) {
          brandBySupplierCampaignId[String(sc.supplierCampaignId)] = brand;
        }
      }
    }

    return { brandByCoupon, brandBySupplierCampaignId };
  }

  async loadOrdersForFinance({ network = null, billingMonth = null, billingYear = null } = {}) {
    const where = {};
    if (network) where.supplier = String(network).trim().toUpperCase();

    const orders = await this.db.order.findMany({
      where,
      include: {
        merchant: { select: { displayName: true } },
        canonicalCampaign: { select: { displayName: true } },
        campaignSource: {
          select: {
            supplierCampaign: {
              select: { merchantNameRaw: true, campaignName: true },
            },
          },
        },
        conversions: {
          select: { supplierCommission: true, approvedCommission: true, metadata: true },
          take: 1,
          orderBy: { createdAt: "desc" },
        },
        financialTransactions: {
          select: { supplierReceivable: true, transactionType: true },
        },
      },
      orderBy: { orderDate: "desc" },
      take: 5000,
    });

    const lookups = await this.buildBrandLookups(orders);

    const bm = billingMonth != null && billingMonth !== "" ? Number(billingMonth) : null;
    const by = billingYear != null && billingYear !== "" ? Number(billingYear) : null;

    return orders
      .map((order) => {
        const period = orderBillingPeriod(order);
        if (!period) return null;
        if (bm != null && period.billingMonth !== bm) return null;
        if (by != null && period.billingYear !== by) return null;
        return {
          order,
          ...period,
          payable: supplierReceivableTotal(order),
          paymentUi: mapOrderPaymentStatusToUi(order.supplierPaymentStatus),
          brandName: brandNameOf(order, lookups),
        };
      })
      .filter(Boolean);
  }

  /**
   * Ensure NetworkReconciliationRow exists for periods that have orders/facts.
   * Safe no-op when periods already rebuilt.
   */
  async ensureReconciliationRows({ billingMonth = null, billingYear = null, network = null } = {}) {
    try {
      const existing = await this.networkPortal.listNetworkReconciliation({
        billingMonth: billingMonth != null && billingMonth !== "" ? Number(billingMonth) : null,
        billingYear: billingYear != null && billingYear !== "" ? Number(billingYear) : null,
        network,
        skip: 0,
        take: 1,
      });
      if ((existing.total || 0) > 0) return existing;

      const periods = await this.discoverBillingPeriods({ billingMonth, billingYear });
      for (const p of periods.slice(0, 12)) {
        await this.networkPortal.rebuildNetworkReconciliation({
          billingMonth: p.billingMonth,
          billingYear: p.billingYear,
        });
      }
      return this.networkPortal.listNetworkReconciliation({
        billingMonth: billingMonth != null && billingMonth !== "" ? Number(billingMonth) : null,
        billingYear: billingYear != null && billingYear !== "" ? Number(billingYear) : null,
        network,
        skip: 0,
        take: 5000,
      });
    } catch {
      return { total: 0, items: [] };
    }
  }

  async discoverBillingPeriods({ billingMonth = null, billingYear = null } = {}) {
    const bm = billingMonth != null && billingMonth !== "" ? Number(billingMonth) : null;
    const by = billingYear != null && billingYear !== "" ? Number(billingYear) : null;
    if (Number.isFinite(bm) && Number.isFinite(by)) {
      return [{ billingMonth: bm, billingYear: by }];
    }

    const orders = await this.db.order.findMany({
      where: { orderDate: { not: null } },
      select: { orderDate: true },
      orderBy: { orderDate: "desc" },
      take: 2000,
    });

    /** @type {Map<string, {billingMonth:number,billingYear:number}>} */
    const map = new Map();
    for (const o of orders) {
      const d = o.orderDate instanceof Date ? o.orderDate : new Date(o.orderDate);
      if (Number.isNaN(d.getTime())) continue;
      const month = d.getUTCMonth() + 1;
      const year = d.getUTCFullYear();
      if (bm != null && month !== bm) continue;
      if (by != null && year !== by) continue;
      map.set(`${year}-${month}`, { billingMonth: month, billingYear: year });
    }

    if (map.size === 0) {
      // Fall back to current UTC month so rebuild can still run.
      const now = new Date();
      return [{ billingMonth: now.getUTCMonth() + 1, billingYear: now.getUTCFullYear() }];
    }

    return [...map.values()].sort((a, b) => b.billingYear - a.billingYear || b.billingMonth - a.billingMonth);
  }

  async listNetworkBilling({
    network = null,
    paymentStatus = null,
    q = null,
    billingMonth = null,
    billingYear = null,
    skip = 0,
    take = 25,
  } = {}) {
    const rows = await this.loadOrdersForFinance({ network, billingMonth, billingYear });

    let items = rows.map(({ order, billingMonth: bm, billingYear: by, payable, paymentUi, anchor, brandName }) => {
      const { date: lastUpdatedDate, time: lastUpdatedTime } = isoToDateAndTime(
        order.supplierPaymentChangedAt || order.updatedAt || anchor,
      );
      const invoiceId = order.supplierOrderId || order.id;
      return {
        id: `inv:${order.id}`,
        network: order.supplier,
        networkSource: order.supplier,
        billingSourceType: "ORDER_LEDGER",
        invoiceId,
        networkInvoiceId: invoiceId,
        billingMonth: bm,
        billingYear: by,
        invoiceDate: lastUpdatedDate || order.orderDate?.toISOString?.() || null,
        invoiceAmount: payable,
        invoiceCurrency: order.currency ?? null,
        currency: order.currency ?? null,
        dueDate: lastUpdatedDate,
        paymentStatus: paymentUi,
        networkInvoiceStatus: paymentUi,
        paymentId: invoiceId,
        paymentDate: lastUpdatedDate,
        paymentAmount: payable,
        paymentCurrency: order.currency ?? null,
        confirmedCommissionAmount: payable,
        outstandingAmount: paymentUi === "PAID" ? 0 : payable,
        settlementCycle: monthYearLabel(bm, by),
        paymentSource: order.sourceAccountLabel || "—",
        sourceReference: `order / ${order.supplier} / ${invoiceId}`,
        brandName: brandName ?? null,
        lastUpdatedDate,
        lastUpdatedTime,
      };
    });

    if (paymentStatus) {
      items = items.filter((x) => String(x.paymentStatus || "").toUpperCase() === String(paymentStatus).toUpperCase());
    }
    if (q && String(q).trim()) {
      const needle = String(q).toLowerCase();
      items = items.filter((x) => {
        return (
          String(x.invoiceId || "").toLowerCase().includes(needle) ||
          String(x.networkSource || "").toLowerCase().includes(needle) ||
          String(x.brandName || "").toLowerCase().includes(needle) ||
          String(x.sourceReference || "").toLowerCase().includes(needle)
        );
      });
    }

    items.sort((a, b) => String(b.lastUpdatedDate || "").localeCompare(String(a.lastUpdatedDate || "")));

    const confirmedCommission = items.reduce((s, x) => s + Number(x.invoiceAmount || 0), 0);
    const paidSettled = items
      .filter((x) => x.paymentStatus === "PAID")
      .reduce((s, x) => s + Number(x.invoiceAmount || 0), 0);
    const paymentPending = Math.max(0, confirmedCommission - paidSettled);
    const networks = new Set(items.map((r) => String(r.network || "").toUpperCase()).filter(Boolean)).size;

    return {
      total: items.length,
      items: items.slice(skip, skip + take),
      kpis: {
        currency: items[0]?.currency || "USD",
        confirmedCommission,
        invoiced: confirmedCommission,
        paymentPending,
        paidSettled,
        outstanding: paymentPending,
        networks,
      },
    };
  }

  async listNetworkPaymentsReceived({
    network = null,
    reconciliationStatus = null,
    q = null,
    billingMonth = null,
    billingYear = null,
    skip = 0,
    take = 25,
  } = {}) {
    const rows = await this.loadOrdersForFinance({ network, billingMonth, billingYear });

    let expanded = rows.map(({ order, billingMonth: bm, billingYear: by, payable, paymentUi, anchor, brandName }) => {
      const stamp = order.supplierPaymentChangedAt || order.updatedAt || anchor;
      const { date: lastUpdatedDate, time: lastUpdatedTime } = isoToDateAndTime(stamp);
      const paymentId = order.supplierOrderId || order.id;
      const reconUi =
        paymentUi === "PAID" ? "FULLY_MATCHED" : paymentUi === "INVOICED" ? "PARTIALLY_MATCHED" : "AGGREGATE_SETTLEMENT";

      return {
        id: `pay:${order.id}`,
        network: order.supplier,
        networkSource: order.supplier,
        paymentSourceType: "ORDER_LEDGER",
        paymentId,
        networkPaymentReference: paymentId,
        networkPaymentDate: lastUpdatedDate,
        networkPaymentTime: lastUpdatedTime,
        mboReceivedDate: paymentUi === "PAID" ? lastUpdatedDate : null,
        mboReceivedTime: paymentUi === "PAID" ? lastUpdatedTime : null,
        paymentAmount: payable,
        paymentCurrency: order.currency ?? null,
        currency: order.currency ?? null,
        paymentStatus: paymentUi,
        networkPaymentStatus: paymentUi,
        invoiceId: paymentId,
        invoiceCycleReference: monthYearLabel(bm, by),
        billingPeriodFrom: new Date(Date.UTC(by, bm - 1, 1)).toISOString(),
        billingPeriodTo: new Date(Date.UTC(by, bm, 0, 23, 59, 59)).toISOString(),
        billingMonth: bm,
        billingYear: by,
        matchedInvoiceAmount: paymentUi === "PAID" ? payable : 0,
        unappliedPaymentAmount: 0,
        confirmedCommissionAmount: payable,
        paymentReference: paymentId,
        settlementCycle: monthYearLabel(bm, by),
        paymentSource: order.sourceAccountLabel || "—",
        reconciliationStatus: reconUi,
        mboReceiptStatus: paymentUi === "PAID" ? "RECEIVED" : "NOT_RECONCILED",
        sourceReference: `order / ${order.supplier} / ${paymentId}`,
        brandName: brandName ?? null,
        lastUpdatedDate,
        lastUpdatedTime,
      };
    });

    if (reconciliationStatus) {
      expanded = expanded.filter(
        (x) => String(x.reconciliationStatus || "").toUpperCase() === String(reconciliationStatus).toUpperCase(),
      );
    }
    if (q && String(q).trim()) {
      const needle = String(q).toLowerCase();
      expanded = expanded.filter((x) => {
        return (
          String(x.paymentId || "").toLowerCase().includes(needle) ||
          String(x.networkPaymentReference || "").toLowerCase().includes(needle) ||
          String(x.networkSource || "").toLowerCase().includes(needle) ||
          String(x.sourceReference || "").toLowerCase().includes(needle)
        );
      });
    }

    expanded.sort((a, b) => String(b.lastUpdatedDate || "").localeCompare(String(a.lastUpdatedDate || "")));

    const paymentRecords = expanded.length;
    const networkAmountPaid = expanded.reduce((s, x) => s + Number(x.paymentAmount || 0), 0);
    const mboAmountReceived = expanded
      .filter((x) => x.networkPaymentStatus === "PAID")
      .reduce((s, x) => s + Number(x.paymentAmount || 0), 0);
    const fullyMatched = expanded
      .filter((x) => x.reconciliationStatus === "FULLY_MATCHED")
      .reduce((s, x) => s + Number(x.paymentAmount || 0), 0);
    const unapplied = Math.max(0, networkAmountPaid - fullyMatched);
    const exceptions = expanded.filter((x) => x.reconciliationStatus !== "FULLY_MATCHED").length;

    return {
      total: expanded.length,
      items: expanded.slice(skip, skip + take),
      kpis: {
        currency: expanded[0]?.currency || "USD",
        paymentRecords,
        networkAmountPaid,
        mboAmountReceived,
        fullyMatched,
        unapplied,
        exceptions,
      },
    };
  }

  /**
   * v13 MBO Receipts — only PAYMENT_RECEIVED orders (never invent bank deposits).
   */
  async listMboReceipts({
    network = null,
    q = null,
    billingMonth = null,
    billingYear = null,
    skip = 0,
    take = 25,
  } = {}) {
    const payments = await this.listNetworkPaymentsReceived({
      network,
      q,
      billingMonth,
      billingYear,
      skip: 0,
      take: 5000,
    });

    const receipts = (payments.items || [])
      .filter((p) => String(p.networkPaymentStatus || p.paymentStatus || "").toUpperCase() === "PAID")
      .map((p, idx) => {
        const receivedAt = p.mboReceivedDate || p.networkPaymentDate || null;
        const time = p.mboReceivedTime || p.networkPaymentTime || null;
        return {
          id: `rcpt:${p.id}`,
          mboReceiptId: `RCPT-${String(idx + 1).padStart(4, "0")}`,
          networkSource: p.networkSource || p.network || null,
          network: p.network || null,
          networkPaymentReference: p.networkPaymentReference || p.paymentReference || p.paymentId || null,
          mboReceivedDateTime: receivedAt
            ? `${String(receivedAt).slice(0, 10)}${time ? ` ${time}` : ""}`
            : null,
          mboReceivedDate: receivedAt,
          mboReceivedTime: time,
          amountReceived: p.paymentAmount ?? null,
          currency: p.currency || p.paymentCurrency || null,
          evidenceSource: p.sourceReference || "Order supplier payment received",
          reconciliationStatus:
            p.reconciliationStatus === "FULLY_MATCHED"
              ? "MATCHED"
              : p.reconciliationStatus === "PARTIALLY_MATCHED"
                ? "PARTIAL"
                : "NOT_RECONCILED",
          recordedBy: "System",
        };
      });

    return {
      total: receipts.length,
      items: receipts.slice(skip, skip + take),
      contract: "v13-mbo-receipts",
      kpis: {
        currency: payments.kpis?.currency || "USD",
        receiptCount: receipts.length,
        amountReceived: receipts.reduce((s, r) => s + Number(r.amountReceived || 0), 0),
        matched: receipts.filter((r) => r.reconciliationStatus === "MATCHED").length,
      },
    };
  }
}
