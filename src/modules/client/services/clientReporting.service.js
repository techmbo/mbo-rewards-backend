import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import { getPagination } from "../../../core/pagination.js";
import {
  FinanceConsumerService,
  FINANCE_CONSUMER_MODES,
  getFinanceConsumerMode,
} from "../../finance/financeConsumer.service.js";
import {
  summarizeConversionsForBucket,
  sumDistinctOrderValues,
} from "../../ops/v15PerformanceGrain.js";
import { PartnerCampaignService } from "./partnerCampaign.service.js";
import { toPartnerClientSummaryDto } from "../dto/partnerCampaign.dto.js";
import {
  toClientOrderDto,
  toClientPaymentStatusDto,
  mapClientFacingPaymentStatus,
  CLIENT_PAYMENT_UNAVAILABLE_FIELDS,
  FORBIDDEN_CLIENT_PAYMENT_KEYS,
} from "../dto/clientReporting.dto.js";
import {
  toClientPerformanceItemDto,
  toClientConfirmedOrderDto,
  CLIENT_PERFORMANCE_UNAVAILABLE_FIELDS,
  CLIENT_PERFORMANCE_FORBIDDEN_KEYS,
} from "../dto/clientPerformance.dto.js";
import { mapCampaignType } from "../../ops/v15FieldContract.js";

function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(4)) : 0;
}

/** Sum clientCommission from conversions — never supplier/approvedCommission as client payout. */
function splitClientCommission(conversions = []) {
  let approved = 0;
  let pending = 0;
  let generated = 0;
  let hasApproved = false;
  let hasPending = false;
  let hasGenerated = false;
  for (const c of conversions) {
    if (c.clientCommission == null || c.clientCommission === "") continue;
    const amt = Number(c.clientCommission);
    if (!Number.isFinite(amt)) continue;
    const status = String(c.status || "").toUpperCase();
    if (status === "REJECTED") continue;
    generated += amt;
    hasGenerated = true;
    if (status === "APPROVED" || status === "PAID") {
      approved += amt;
      hasApproved = true;
    } else {
      pending += amt;
      hasPending = true;
    }
  }
  return {
    clientCommission: hasApproved ? approved : null,
    pendingClientCommission: hasPending ? pending : null,
    clientCommissionGenerated: hasGenerated ? generated : null,
  };
}

function parseDateBound(value, endOfDay = false) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}

function billingKeyFromDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
  };
}

/**
 * Epic 1 — tenant-scoped client orders + payment-status report (v15 09C / 05A).
 * Withdrawals remain on PortalDashboardService.getPaymentsSummary.
 */
export class ClientReportingService {
  constructor(deps = {}) {
    this.prisma = deps.prisma ?? prisma;
    this.partnerCampaigns = deps.partnerCampaigns ?? new PartnerCampaignService();
    this.financeConsumer = deps.financeConsumer ?? new FinanceConsumerService({ prisma: this.prisma });
  }

  async assertClient(clientId, { requireActive = true } = {}) {
    if (requireActive) {
      return this.partnerCampaigns.assertPartnerClient(clientId);
    }
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, deletedAt: null },
    });
    if (!client) throw fail("Client not found.", 404);
    if (client.status === "OFFBOARDED") {
      throw fail("Client account is not available.", 403);
    }
    return client;
  }

  /**
   * Client-safe performance — DailyReport grain aligned to Reporting v20 Client Performance.
   * Forced tenant = authenticated clientId. Never trusts query.clientId for scope.
   * Never exposes supplierReceivable / mboCommission / network commission.
   * @param {{ requireActive?: boolean }} [opts] — admin may pass requireActive:false for prospects.
   */
  async listPerformance(clientId, query = {}, opts = {}) {
    const client = await this.assertClient(clientId, opts);
    const { page, pageSize, skip } = getPagination(query);
    const take = pageSize;

    const where = { clientId };
    if (query.merchantId) where.merchantId = query.merchantId;
    if (query.campaignId) where.canonicalCampaignId = query.campaignId;
    if (query.country) where.country = String(query.country).toUpperCase().slice(0, 2);
    if (query.currency) where.currency = String(query.currency).toUpperCase().slice(0, 3);
    if (query.from || query.to) {
      where.reportDate = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    if (query.brand) {
      where.merchant = {
        displayName: { contains: String(query.brand).trim(), mode: "insensitive" },
      };
    }
    if (query.network) {
      const supplier = String(query.network).trim().toUpperCase();
      where.campaignSource = {
        supplierCampaign: { supplier },
      };
    }

    const [rows, total, aggregates] = await Promise.all([
      this.prisma.dailyReport.findMany({
        where,
        include: {
          merchant: { select: { displayName: true } },
          canonicalCampaign: { select: { displayName: true } },
          campaignSource: {
            select: {
              id: true,
              supplierCampaign: { select: { supplier: true, campaignName: true } },
            },
          },
        },
        orderBy: { reportDate: "desc" },
        skip,
        take,
      }),
      this.prisma.dailyReport.count({ where }),
      this.prisma.dailyReport.aggregate({
        where,
        _sum: {
          clickCount: true,
          conversionCount: true,
          approvedConversionCount: true,
          clientCommission: true,
        },
      }),
    ]);

    // DailyReport may be empty while Conversion rows exist (common before aggregation jobs run).
    if (total === 0) {
      return this.listPerformanceFromConversions(client, query, { page, pageSize, skip });
    }

    const sourceIds = [...new Set(rows.map((r) => r.campaignSourceId).filter(Boolean))];
    /** @type {Map<string, any[]>} */
    const convByKey = new Map();
    if (sourceIds.length && rows.length) {
      const dates = rows
        .map((r) => (r.reportDate instanceof Date ? r.reportDate : new Date(r.reportDate)))
        .filter((d) => !Number.isNaN(d.getTime()));
      if (dates.length) {
        const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
        const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
        maxDate.setUTCDate(maxDate.getUTCDate() + 1);
        const conversions = await this.prisma.conversion.findMany({
          where: {
            campaignSourceId: { in: sourceIds },
            conversionDate: { gte: minDate, lt: maxDate },
            clientAssignment: { clientId },
          },
          select: {
            id: true,
            campaignSourceId: true,
            conversionDate: true,
            status: true,
            clientCommission: true,
            approvedCommission: true,
            clickId: true,
            trackingLinkId: true,
            orderId: true,
            metadata: true,
            updatedAt: true,
            clientAssignment: { select: { clientId: true } },
          },
        });
        for (const c of conversions) {
          const day = c.conversionDate?.toISOString?.()?.slice(0, 10);
          if (!day || !c.campaignSourceId) continue;
          const key = `${clientId}|${c.campaignSourceId}|${day}`;
          if (!convByKey.has(key)) convByKey.set(key, []);
          convByKey.get(key).push(c);
        }
      }
    }

    const allOrderIds = new Set();
    const trackingLinkIds = new Set();
    for (const list of convByKey.values()) {
      const summary = summarizeConversionsForBucket(list);
      for (const id of summary.orderIds) allOrderIds.add(id);
      if (summary.trackingLinkId) trackingLinkIds.add(summary.trackingLinkId);
    }
    for (const list of convByKey.values()) {
      for (const c of list) {
        if (c.trackingLinkId) trackingLinkIds.add(c.trackingLinkId);
      }
    }

    const [orders, trackingLinks] = await Promise.all([
      allOrderIds.size
        ? this.prisma.order.findMany({
            where: { id: { in: [...allOrderIds] } },
            select: { id: true, orderValue: true, validationStatus: true },
          })
        : Promise.resolve([]),
      trackingLinkIds.size
        ? this.prisma.trackingLink.findMany({
            where: {
              id: { in: [...trackingLinkIds] },
              assignment: { clientId },
              deletedAt: null,
            },
            select: { id: true, mboTrackingUrl: true, campaignSourceId: true },
          })
        : Promise.resolve([]),
    ]);
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const trackingById = new Map(trackingLinks.map((t) => [t.id, t.mboTrackingUrl]));

    // Fallback: primary tracking link per campaign source for the client
    const missingSourceIds = sourceIds.filter(
      (sid) => ![...trackingLinks].some((t) => t.campaignSourceId === sid),
    );
    let primaryLinkBySource = new Map();
    if (missingSourceIds.length) {
      const primaries = await this.prisma.trackingLink.findMany({
        where: {
          campaignSourceId: { in: missingSourceIds },
          assignment: { clientId },
          deletedAt: null,
          status: { not: "REVOKED" },
        },
        select: { campaignSourceId: true, mboTrackingUrl: true, isPrimary: true, createdAt: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
      });
      for (const t of primaries) {
        if (!t.campaignSourceId || primaryLinkBySource.has(t.campaignSourceId)) continue;
        primaryLinkBySource.set(t.campaignSourceId, t.mboTrackingUrl);
      }
    }

    const campaignTypeFilter = String(query.campaignType || query.type || "")
      .trim()
      .toLowerCase();

    let items = rows.map((r) => {
      const day =
        r.reportDate?.toISOString?.()?.slice(0, 10) ?? String(r.reportDate || "").slice(0, 10);
      const key = r.campaignSourceId ? `${clientId}|${r.campaignSourceId}|${day}` : null;
      const list = key ? convByKey.get(key) || [] : [];
      const summary = summarizeConversionsForBucket(list);
      const bucketOrders = summary.orderIds.map((id) => orderById.get(id)).filter(Boolean);
      const orderValues = sumDistinctOrderValues(bucketOrders);
      const split = splitClientCommission(list);

      let clientCommission = split.clientCommission;
      if (clientCommission == null && r.clientCommission != null && r.clientCommission !== "") {
        clientCommission = Number(r.clientCommission);
      }

      const mboTrackingLink =
        (summary.trackingLinkId ? trackingById.get(summary.trackingLinkId) : null) ||
        (r.campaignSourceId ? primaryLinkBySource.get(r.campaignSourceId) : null) ||
        null;

      let lastUpdatedAt = r.updatedAt || r.reportDate || null;
      for (const c of list) {
        if (c.updatedAt && (!lastUpdatedAt || c.updatedAt > lastUpdatedAt)) {
          lastUpdatedAt = c.updatedAt;
        }
      }

      return toClientPerformanceItemDto({
        id: r.id,
        reportDate: day,
        merchantId: r.merchantId,
        canonicalCampaignId: r.canonicalCampaignId,
        brandName: r.merchant?.displayName ?? null,
        campaignName: r.canonicalCampaign?.displayName ?? null,
        country: r.country,
        currency: r.currency,
        clickCount: r.clickCount,
        conversionCount: r.conversionCount,
        approvedConversionCount: r.approvedConversionCount,
        cancelOrders: list.length ? summary.cancelOrders : null,
        cancelledOrders: list.length ? summary.cancelledOrders : null,
        pendingOrders: list.length ? summary.pendingOrders : null,
        rejectedOrders: list.length ? summary.rejectedOrders : null,
        confirmedOrders: list.length ? summary.confirmedOrders : r.approvedConversionCount,
        channelType: summary.channelType,
        clientCampaignType: summary.clientCampaignType,
        campaignType: summary.campaignType,
        couponCode: summary.couponCode,
        mboTrackingLink,
        grossOrderValue: orderValues.grossOrderValue,
        confirmedOrderValue: orderValues.netOrderValue,
        netOrderValue: orderValues.netOrderValue,
        clientCommission,
        pendingClientCommission: split.pendingClientCommission,
        clientCommissionGenerated: split.clientCommissionGenerated,
        lastUpdatedAt,
        updatedAt: lastUpdatedAt,
      });
    });

    if (campaignTypeFilter && campaignTypeFilter !== "all" && campaignTypeFilter !== "all types") {
      items = items.filter((i) => {
        const label = String(i.campaignType || "").toLowerCase();
        if (campaignTypeFilter.includes("coupon") && !campaignTypeFilter.includes("link")) {
          return label === "coupon";
        }
        if (campaignTypeFilter.includes("affiliate") || campaignTypeFilter === "link") {
          return label === "affiliate link";
        }
        return label.includes(campaignTypeFilter);
      });
    }

    const hasRows = total > 0;
    const sum = aggregates?._sum || {};
    const kpis = {
      linkClicks: hasRows ? Number(sum.clickCount ?? 0) : null,
      grossOrders: hasRows ? Number(sum.conversionCount ?? 0) : null,
      netOrders: hasRows ? Number(sum.approvedConversionCount ?? 0) : null,
      confirmedOrders: hasRows ? Number(sum.approvedConversionCount ?? 0) : null,
      pendingOrders: null,
      rejectedOrders: null,
      cancelledOrders: null,
      cancelOrders: null,
      grossOrderValue: null,
      confirmedOrderValue: null,
      netOrderValue: null,
      clientCommission: hasRows ? Number(sum.clientCommission ?? 0) : null,
      confirmedClientCommission: null,
      clientCommissionGenerated: null,
      pendingClientCommission: null,
      currency: client.currency || null,
    };

    if (hasRows) {
      let pageApproved = 0;
      let pagePending = 0;
      let pageGenerated = 0;
      let pagePendingOrders = 0;
      let pageConfirmedOrders = 0;
      let pageRejectedOrders = 0;
      let pageCancelledOrders = 0;
      let pageGrossValue = 0;
      let pageConfirmedValue = 0;
      let hasA = false;
      let hasP = false;
      let hasG = false;
      let hasStatus = false;
      let hasValue = false;
      for (const item of items) {
        if (item.clientCommission != null) {
          pageApproved += Number(item.clientCommission) || 0;
          hasA = true;
        }
        if (item.pendingClientCommission != null) {
          pagePending += Number(item.pendingClientCommission) || 0;
          hasP = true;
        }
        if (item.clientCommissionGenerated != null) {
          pageGenerated += Number(item.clientCommissionGenerated) || 0;
          hasG = true;
        }
        if (item.pendingOrders != null || item.confirmedOrders != null || item.rejectedOrders != null) {
          hasStatus = true;
          pagePendingOrders += Number(item.pendingOrders) || 0;
          pageConfirmedOrders += Number(item.confirmedOrders) || 0;
          pageRejectedOrders += Number(item.rejectedOrders) || 0;
          pageCancelledOrders += Number(item.cancelledOrders) || 0;
        }
        if (item.grossOrderValue != null || item.confirmedOrderValue != null) {
          hasValue = true;
          pageGrossValue += Number(item.grossOrderValue) || 0;
          pageConfirmedValue += Number(item.confirmedOrderValue) || 0;
        }
      }
      if (hasA) {
        kpis.clientCommission = Number(pageApproved.toFixed(4));
        kpis.confirmedClientCommission = kpis.clientCommission;
      }
      if (hasP) kpis.pendingClientCommission = Number(pagePending.toFixed(4));
      if (hasG) kpis.clientCommissionGenerated = Number(pageGenerated.toFixed(4));
      if (hasStatus) {
        kpis.pendingOrders = pagePendingOrders;
        kpis.confirmedOrders = pageConfirmedOrders;
        kpis.rejectedOrders = pageRejectedOrders;
        kpis.cancelledOrders = pageCancelledOrders;
        kpis.cancelOrders = pageCancelledOrders;
      }
      if (hasValue) {
        kpis.grossOrderValue = Number(pageGrossValue.toFixed(4));
        kpis.confirmedOrderValue = Number(pageConfirmedValue.toFixed(4));
        kpis.netOrderValue = kpis.confirmedOrderValue;
      }
    }

    const brands = [
      ...new Map(
        items
          .filter((i) => i.brandName)
          .map((i) => [i.brandName, { id: i.brandName, name: i.brandName }]),
      ).values(),
    ];

    return {
      client: toPartnerClientSummaryDto(client),
      items,
      /** @deprecated alias for portal overview compatibility */
      rows: items.map((i) => ({
        id: i.id,
        date: i.date,
        brand: i.brandName,
        brandId: i.brandName,
        brandName: i.brandName,
        campaign: i.campaignName,
        campaignName: i.campaignName,
        campaignType: i.campaignType,
        couponCode: i.couponCode,
        trackingLink: i.mboTrackingLink,
        mboTrackingLink: i.mboTrackingLink,
        clicks: i.linkClicks,
        linkClicks: i.linkClicks,
        orders: i.grossOrders,
        grossOrders: i.grossOrders,
        pendingOrders: i.pendingOrders,
        confirmedOrders: i.confirmedOrders,
        rejectedOrders: i.rejectedOrders,
        cancelledOrders: i.cancelledOrders,
        grossOrderValue: i.grossOrderValue,
        confirmedOrderValue: i.confirmedOrderValue,
        orderValue: i.confirmedOrderValue ?? i.grossOrderValue,
        commissionGenerated: i.clientCommissionGenerated,
        clientCommissionGenerated: i.clientCommissionGenerated,
        approvedCommission: i.confirmedClientCommission,
        clientCommission: i.confirmedClientCommission,
        confirmedClientCommission: i.confirmedClientCommission,
        pendingCommission: i.pendingClientCommission,
        currency: i.currency,
        lastUpdatedAt: i.lastUpdatedAt,
      })),
      brands,
      kpis,
      dataAvailable: hasRows,
      dataState: hasRows ? "ok" : "empty",
      unavailableFields: [...CLIENT_PERFORMANCE_UNAVAILABLE_FIELDS],
      forbiddenFields: [...CLIENT_PERFORMANCE_FORBIDDEN_KEYS],
      contract: "v20-client-performance",
      grainNote:
        "DailyReport grain: client × campaign × source? × country? × day. v20 Client Performance fields. Client commission only — no network/MBO commission.",
      migrationRequired: false,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
      },
    };
  }

  /**
   * Fallback when DailyReport is empty: soft-attribute conversions to the client
   * (assignment, order.clientId, or matching assignment suppliers).
   */
  async listPerformanceFromConversions(client, query = {}, pagination = {}) {
    const clientId = client.id;
    const page = pagination.page ?? 1;
    const pageSize = pagination.pageSize ?? 50;
    const skip = pagination.skip ?? 0;

    const assignments = await this.prisma.clientCampaignAssignment.findMany({
      where: { clientId },
      select: {
        id: true,
        campaignSource: { select: { supplierCampaign: { select: { supplier: true } } } },
      },
    });
    const suppliers = [
      ...new Set(
        assignments
          .map((a) => a.campaignSource?.supplierCampaign?.supplier)
          .filter(Boolean)
          .map((s) => String(s).toUpperCase()),
      ),
    ];

    const dateFilter = {};
    if (query.from) dateFilter.gte = new Date(query.from);
    if (query.to) {
      const to = String(query.to);
      dateFilter.lte = to.includes("T")
        ? new Date(to)
        : new Date(`${to.slice(0, 10)}T23:59:59.999Z`);
    }

    const scopeOr = [{ clientAssignment: { clientId } }, { order: { clientId } }];
    if (suppliers.length) {
      scopeOr.push({ clientAssignmentId: null, supplier: { in: suppliers } });
    }

    const where = {
      OR: scopeOr,
      ...(Object.keys(dateFilter).length ? { conversionDate: dateFilter } : {}),
    };
    if (query.network) {
      where.supplier = String(query.network).trim().toUpperCase();
    }

    const conversions = await this.prisma.conversion.findMany({
      where,
      include: {
        order: {
          select: {
            id: true,
            orderValue: true,
            currency: true,
            validationStatus: true,
            merchant: { select: { displayName: true } },
          },
        },
        trackingLink: { select: { mboTrackingUrl: true } },
        campaignSource: {
          select: {
            id: true,
            canonicalCampaign: {
              select: {
                id: true,
                displayName: true,
                merchant: { select: { displayName: true } },
              },
            },
            supplierCampaign: {
              select: { campaignName: true, supplier: true, merchantNameRaw: true },
            },
          },
        },
      },
      orderBy: { conversionDate: "desc" },
      take: 2000,
    });

    /** @type {Map<string, typeof conversions>} */
    const buckets = new Map();
    for (const c of conversions) {
      const day = c.conversionDate?.toISOString?.()?.slice(0, 10) || "unknown";
      const campaignName =
        c.campaignSource?.canonicalCampaign?.displayName ||
        c.campaignSource?.supplierCampaign?.campaignName ||
        "Unmapped campaign";
      const brandName =
        c.order?.merchant?.displayName ||
        c.campaignSource?.canonicalCampaign?.merchant?.displayName ||
        c.campaignSource?.supplierCampaign?.merchantNameRaw ||
        null;
      const key = `${day}|${campaignName}|${brandName || ""}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(c);
    }

    const campaignTypeFilter = String(query.campaignType || query.type || "")
      .trim()
      .toLowerCase();
    const brandFilter = query.brand ? String(query.brand).trim().toLowerCase() : "";

    let items = [...buckets.entries()].map(([key, list]) => {
      const [day] = key.split("|");
      const summary = summarizeConversionsForBucket(list);
      const split = splitClientCommission(list);
      const bucketOrders = list.map((c) => c.order).filter(Boolean);
      const orderValues = sumDistinctOrderValues(bucketOrders);
      const sample = list[0];
      const brandName =
        sample?.order?.merchant?.displayName ||
        sample?.campaignSource?.canonicalCampaign?.merchant?.displayName ||
        sample?.campaignSource?.supplierCampaign?.merchantNameRaw ||
        null;
      const campaignName =
        sample?.campaignSource?.canonicalCampaign?.displayName ||
        sample?.campaignSource?.supplierCampaign?.campaignName ||
        "Unmapped campaign";

      let lastUpdatedAt = null;
      for (const c of list) {
        if (c.updatedAt && (!lastUpdatedAt || c.updatedAt > lastUpdatedAt)) {
          lastUpdatedAt = c.updatedAt;
        }
      }

      return toClientPerformanceItemDto({
        id: `conv:${key}`,
        reportDate: day,
        brandName,
        campaignName,
        currency: sample?.order?.currency || sample?.currency || client.currency || null,
        conversionCount: list.length,
        approvedConversionCount: summary.confirmedOrders,
        cancelOrders: summary.cancelOrders,
        cancelledOrders: summary.cancelledOrders,
        pendingOrders: summary.pendingOrders,
        rejectedOrders: summary.rejectedOrders,
        confirmedOrders: summary.confirmedOrders,
        channelType: summary.channelType,
        clientCampaignType: summary.clientCampaignType,
        campaignType: summary.campaignType,
        couponCode: summary.couponCode,
        mboTrackingLink: sample?.trackingLink?.mboTrackingUrl ?? null,
        grossOrderValue: orderValues.grossOrderValue,
        confirmedOrderValue: orderValues.netOrderValue,
        netOrderValue: orderValues.netOrderValue,
        clientCommission: split.clientCommission,
        pendingClientCommission: split.pendingClientCommission,
        clientCommissionGenerated: split.clientCommissionGenerated,
        lastUpdatedAt,
        updatedAt: lastUpdatedAt,
      });
    });

    if (brandFilter) {
      items = items.filter((i) => String(i.brandName || "").toLowerCase().includes(brandFilter));
    }
    if (campaignTypeFilter && campaignTypeFilter !== "all" && campaignTypeFilter !== "all types") {
      items = items.filter((i) => {
        const label = String(i.campaignType || "").toLowerCase();
        if (campaignTypeFilter.includes("coupon") && !campaignTypeFilter.includes("link")) {
          return label === "coupon";
        }
        if (campaignTypeFilter.includes("affiliate") || campaignTypeFilter === "link") {
          return label === "affiliate link";
        }
        return label.includes(campaignTypeFilter);
      });
    }

    const total = items.length;
    const pageItems = items.slice(skip, skip + pageSize);
    const hasRows = total > 0;

    const kpis = {
      linkClicks: null,
      grossOrders: hasRows ? items.reduce((s, i) => s + (Number(i.grossOrders) || 0), 0) : null,
      netOrders: hasRows ? items.reduce((s, i) => s + (Number(i.confirmedOrders) || 0), 0) : null,
      confirmedOrders: hasRows
        ? items.reduce((s, i) => s + (Number(i.confirmedOrders) || 0), 0)
        : null,
      pendingOrders: hasRows ? items.reduce((s, i) => s + (Number(i.pendingOrders) || 0), 0) : null,
      rejectedOrders: hasRows
        ? items.reduce((s, i) => s + (Number(i.rejectedOrders) || 0), 0)
        : null,
      cancelledOrders: hasRows
        ? items.reduce((s, i) => s + (Number(i.cancelledOrders) || 0), 0)
        : null,
      cancelOrders: hasRows
        ? items.reduce((s, i) => s + (Number(i.cancelledOrders) || 0), 0)
        : null,
      grossOrderValue: hasRows
        ? Number(
            items.reduce((s, i) => s + (Number(i.grossOrderValue) || 0), 0).toFixed(4),
          )
        : null,
      confirmedOrderValue: hasRows
        ? Number(
            items.reduce((s, i) => s + (Number(i.confirmedOrderValue) || 0), 0).toFixed(4),
          )
        : null,
      netOrderValue: null,
      clientCommission: hasRows
        ? Number(
            items.reduce((s, i) => s + (Number(i.confirmedClientCommission) || 0), 0).toFixed(4),
          )
        : null,
      confirmedClientCommission: null,
      clientCommissionGenerated: hasRows
        ? Number(
            items.reduce((s, i) => s + (Number(i.clientCommissionGenerated) || 0), 0).toFixed(4),
          )
        : null,
      pendingClientCommission: hasRows
        ? Number(
            items.reduce((s, i) => s + (Number(i.pendingClientCommission) || 0), 0).toFixed(4),
          )
        : null,
      currency: client.currency || null,
    };
    kpis.confirmedClientCommission = kpis.clientCommission;
    kpis.netOrderValue = kpis.confirmedOrderValue;

    const brands = [
      ...new Map(
        items
          .filter((i) => i.brandName)
          .map((i) => [i.brandName, { id: i.brandName, name: i.brandName }]),
      ).values(),
    ];

    return {
      client: toPartnerClientSummaryDto(client),
      items: pageItems,
      rows: pageItems.map((i) => ({
        id: i.id,
        date: i.date,
        brand: i.brandName,
        brandId: i.brandName,
        brandName: i.brandName,
        campaign: i.campaignName,
        campaignName: i.campaignName,
        campaignType: i.campaignType,
        couponCode: i.couponCode,
        trackingLink: i.mboTrackingLink,
        mboTrackingLink: i.mboTrackingLink,
        clicks: i.linkClicks,
        linkClicks: i.linkClicks,
        orders: i.grossOrders,
        grossOrders: i.grossOrders,
        pendingOrders: i.pendingOrders,
        confirmedOrders: i.confirmedOrders,
        rejectedOrders: i.rejectedOrders,
        cancelledOrders: i.cancelledOrders,
        grossOrderValue: i.grossOrderValue,
        confirmedOrderValue: i.confirmedOrderValue,
        orderValue: i.confirmedOrderValue ?? i.grossOrderValue,
        commissionGenerated: i.clientCommissionGenerated,
        clientCommissionGenerated: i.clientCommissionGenerated,
        approvedCommission: i.confirmedClientCommission,
        clientCommission: i.confirmedClientCommission,
        confirmedClientCommission: i.confirmedClientCommission,
        pendingCommission: i.pendingClientCommission,
        currency: i.currency,
        lastUpdatedAt: i.lastUpdatedAt,
      })),
      brands,
      kpis,
      dataAvailable: hasRows,
      dataState: hasRows ? "ok" : "empty",
      unavailableFields: [...CLIENT_PERFORMANCE_UNAVAILABLE_FIELDS],
      forbiddenFields: [...CLIENT_PERFORMANCE_FORBIDDEN_KEYS],
      contract: "v20-client-performance",
      grainNote:
        "Conversion fallback (DailyReport empty): soft-attributed by assignment / order.clientId / assignment suppliers.",
      migrationRequired: false,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
      },
    };
  }

  /**
   * v20 Client Confirmed Orders — individual confirmed/approved orders for this client.
   * Aggregate Boostiny settlement rows are NOT invented here.
   */
  async listConfirmedOrders(clientId, query = {}) {
    const client = await this.assertClient(clientId);
    const { page, pageSize, skip } = getPagination(query);
    const take = pageSize;

    const dateFilter = {};
    if (query.from) dateFilter.gte = new Date(query.from);
    if (query.to) {
      const to = String(query.to);
      dateFilter.lte = to.includes("T")
        ? new Date(to)
        : new Date(`${to.slice(0, 10)}T23:59:59.999Z`);
    }
    const hasDate = Object.keys(dateFilter).length > 0;

    const assignments = await this.prisma.clientCampaignAssignment.findMany({
      where: { clientId },
      select: {
        campaignSource: { select: { supplierCampaign: { select: { supplier: true } } } },
      },
    });
    const suppliers = [
      ...new Set(
        assignments
          .map((a) => a.campaignSource?.supplierCampaign?.supplier)
          .filter(Boolean)
          .map((s) => String(s).toUpperCase()),
      ),
    ];
    const scopeOr = [{ clientAssignment: { clientId } }, { order: { clientId } }];
    if (suppliers.length) {
      scopeOr.push({ clientAssignmentId: null, supplier: { in: suppliers } });
    }

    const where = {
      OR: scopeOr,
      status: { in: ["APPROVED", "PAID"] },
      ...(hasDate
        ? {
            AND: [
              {
                OR: [
                  { approvedDate: dateFilter },
                  { approvedDate: null, conversionDate: dateFilter },
                ],
              },
            ],
          }
        : {}),
    };

    if (query.brand) {
      where.campaignSource = {
        supplierCampaign: {
          OR: [
            { merchantNameRaw: { contains: String(query.brand).trim(), mode: "insensitive" } },
            { campaignName: { contains: String(query.brand).trim(), mode: "insensitive" } },
          ],
        },
      };
    }

    const [conversions, total] = await Promise.all([
      this.prisma.conversion.findMany({
        where,
        include: {
          order: {
            select: {
              id: true,
              supplierOrderId: true,
              orderValue: true,
              currency: true,
              orderDate: true,
              validationChangedAt: true,
              updatedAt: true,
              merchant: { select: { displayName: true } },
            },
          },
          trackingLink: { select: { mboTrackingUrl: true } },
          click: { select: { id: true } },
          campaignSource: {
            select: {
              canonicalCampaign: {
                select: {
                  displayName: true,
                  merchant: { select: { displayName: true } },
                },
              },
              supplierCampaign: { select: { campaignName: true, supplier: true, merchantNameRaw: true } },
            },
          },
          clientAssignment: {
            select: {
              id: true,
              client: { select: { name: true } },
              commissionRules: {
                where: { status: "EFFECTIVE" },
                take: 1,
                orderBy: { effectiveFrom: "desc" },
                select: {
                  orderValuePercent: true,
                  fixedAmount: true,
                  clientCommission: true,
                  grossCommission: true,
                  displayLabel: true,
                },
              },
            },
          },
        },
        orderBy: [{ approvedDate: "desc" }, { conversionDate: "desc" }],
        skip,
        take,
      }),
      this.prisma.conversion.count({ where }),
    ]);

    const items = conversions.map((c) => {
      const rule = c.clientAssignment?.commissionRules?.[0];
      let rateLabel = null;
      if (rule?.displayLabel) rateLabel = String(rule.displayLabel);
      else if (rule?.orderValuePercent != null) rateLabel = `${Number(rule.orderValuePercent)}%`;
      else if (rule?.fixedAmount != null) rateLabel = String(rule.fixedAmount);
      else if (rule?.grossCommission != null && Number(rule.grossCommission) > 0 && rule?.clientCommission != null) {
        rateLabel = `${Number(((Number(rule.clientCommission) / Number(rule.grossCommission)) * 100).toFixed(2))}%`;
      }

      const channel = summarizeConversionsForBucket([c]);
      const confirmedDate =
        c.approvedDate?.toISOString?.()?.slice(0, 10) ||
        c.order?.validationChangedAt?.toISOString?.()?.slice(0, 10) ||
        null;
      const orderDate =
        c.order?.orderDate?.toISOString?.()?.slice(0, 10) ||
        c.conversionDate?.toISOString?.()?.slice(0, 10) ||
        null;

      const brandName =
        c.order?.merchant?.displayName ||
        c.campaignSource?.canonicalCampaign?.merchant?.displayName ||
        c.campaignSource?.supplierCampaign?.merchantNameRaw ||
        null;

      return {
        ...toClientConfirmedOrderDto({
          confirmationType: "Individual Order",
          orderConfirmedDate: confirmedDate,
          orderDate,
          cycle: null,
          clientName: c.clientAssignment?.client?.name || client.name || null,
          brandName,
          campaignName:
            c.campaignSource?.canonicalCampaign?.displayName ||
            c.campaignSource?.supplierCampaign?.campaignName ||
            null,
          campaignType: channel.clientCampaignType,
          couponCode: channel.couponCode,
          mboTrackingLink: c.trackingLink?.mboTrackingUrl ?? null,
          networkOrderId: c.order?.supplierOrderId ?? null,
          networkConversionId: c.supplierConversionId ?? null,
          mboClickId: c.click?.id ?? c.clickId ?? null,
          confirmedOrders: 1,
          confirmedOrderValueAmount: c.order?.orderValue ?? null,
          currency: c.order?.currency ?? c.currency ?? null,
          clientCommissionRate: rateLabel,
          confirmedClientCommissionAmount: c.clientCommission,
          confirmationStatus: "Confirmed",
          settlementStatus: null,
          lastUpdatedAt: c.updatedAt || c.order?.updatedAt || c.approvedDate || c.conversionDate,
          orderId: c.order?.id ?? null,
        }),
        network: c.campaignSource?.supplierCampaign?.supplier ?? c.supplier ?? null,
      };
    });

    let filtered = items;
    const q = String(query.q || query.search || "").trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((r) =>
        Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q)),
      );
    }

    const kpis = {
      confirmedClientOrders: total,
      confirmedOrderValue: Number(
        filtered.reduce((s, r) => s + (Number(r.confirmedOrderValueAmount) || 0), 0).toFixed(4),
      ),
      confirmedClientCommission: Number(
        filtered
          .reduce((s, r) => s + (Number(r.confirmedClientCommissionAmount) || 0), 0)
          .toFixed(4),
      ),
      individualConfirmed: total,
      aggregateConfirmed: 0,
      currency: client.currency || null,
    };

    return {
      client: toPartnerClientSummaryDto(client),
      items: filtered,
      kpis,
      dataAvailable: total > 0,
      dataState: total > 0 ? "ok" : "empty",
      contract: "v20-client-confirmed-orders",
      grainNote:
        "Individual order-level confirmation only. Boostiny aggregate settlements are not invented as fake orders.",
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
      },
    };
  }

  getFinanceMode() {
    return this.financeConsumer?.getMode?.() ?? getFinanceConsumerMode();
  }

  sumFtClientPayable(order) {
    const txns = Array.isArray(order.financialTransactions) ? order.financialTransactions : [];
    if (!txns.length) return null;
    let sum = 0;
    for (const t of txns) {
      const useReporting =
        t.reportingClientPayable != null &&
        t.reportingCurrency &&
        order.currency &&
        t.reportingCurrency === order.currency;
      sum += Number(useReporting ? t.reportingClientPayable : t.clientPayable) || 0;
    }
    return money(sum);
  }

  sumSnapshotClientCommission(order) {
    if (order.lastApprovedClientCommission != null && order.lastApprovedClientCommission !== "") {
      return {
        clientCommission: money(order.lastApprovedClientCommission),
        commissionSource: "order_snapshot",
      };
    }
    const conversions = Array.isArray(order.conversions) ? order.conversions : [];
    let snap = 0;
    let found = false;
    for (const c of conversions) {
      if (c.clientCommission != null && c.clientCommission !== "") {
        snap += Number(c.clientCommission) || 0;
        found = true;
      }
    }
    if (found) {
      return { clientCommission: money(snap), commissionSource: "conversion_snapshot" };
    }
    return { clientCommission: null, commissionSource: "unavailable" };
  }

  /**
   * Resolve client commission with FINANCE_CONSUMER_MODE awareness.
   * FINANCE: FT only (null if missing — do not fabricate).
   * LEGACY/SHADOW: Epic 1 compatibility — FT if present, else order/conversion snapshot.
   */
  resolveOrderCommission(order) {
    const mode = this.getFinanceMode();
    const ftSum = this.sumFtClientPayable(order);

    if (mode === FINANCE_CONSUMER_MODES.FINANCE) {
      if (ftSum != null) {
        return { clientCommission: ftSum, commissionSource: "financial_transaction" };
      }
      return { clientCommission: null, commissionSource: "unavailable" };
    }

    // LEGACY / SHADOW — preserve Epic 1 prefer-FT-then-snapshot behavior
    if (ftSum != null) {
      return { clientCommission: ftSum, commissionSource: "financial_transaction" };
    }
    return this.sumSnapshotClientCommission(order);
  }

  /**
   * GET /api/v1/client/orders
   */
  async listOrders(clientId, query = {}) {
    const client = await this.assertClient(clientId);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 50));
    const skip = (page - 1) * pageSize;

    const from = parseDateBound(query.date_from || query.from || query.dateFrom);
    const to = parseDateBound(query.date_to || query.to || query.dateTo, true);
    const campaignId = query.campaign_id || query.campaignId || null;
    const statusFilter = query.status ? String(query.status).trim() : null;

    const where = {
      clientId,
      ...(from || to
        ? {
            orderDate: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(campaignId ? { canonicalCampaignId: String(campaignId) } : {}),
    };

    // Status filter applied after mapping (client vocabulary). Prefetch larger set if filtered.
    const take = statusFilter ? Math.min(2000, pageSize * 20) : pageSize;
    const skipDb = statusFilter ? 0 : skip;

    const [rows, totalUnfiltered] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
        skip: skipDb,
        take,
        include: {
          merchant: { select: { id: true, displayName: true } },
          canonicalCampaign: {
            select: {
              id: true,
              displayName: true,
              merchant: { select: { displayName: true } },
            },
          },
          items: true,
          financialTransactions: {
            select: {
              clientPayable: true,
              reportingClientPayable: true,
              reportingCurrency: true,
              transactionType: true,
            },
          },
          conversions: {
            select: { clientCommission: true, status: true },
          },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    let mapped = rows.map((order) => {
      const commission = this.resolveOrderCommission(order);
      return toClientOrderDto(order, commission);
    });

    if (statusFilter) {
      const needle = statusFilter.toLowerCase();
      mapped = mapped.filter((r) => String(r.orderStatus).toLowerCase() === needle);
      const total = mapped.length;
      const pageRows = mapped.slice(skip, skip + pageSize);
      return {
        client: toPartnerClientSummaryDto(client),
        orders: pageRows,
        financeConsumerMode: this.getFinanceMode(),
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
          hasMore: skip + pageSize < total,
        },
      };
    }

    return {
      client: toPartnerClientSummaryDto(client),
      orders: mapped,
      financeConsumerMode: this.getFinanceMode(),
      pagination: {
        page,
        pageSize,
        total: totalUnfiltered,
        totalPages: Math.max(1, Math.ceil(totalUnfiltered / pageSize)),
        hasMore: skip + pageSize < totalUnfiltered,
      },
    };
  }

  /**
   * GET /api/v1/client/payments — client-safe payment STATUS (v15 05E grain).
   * Not withdrawals. Not admin supplierReceivable.
   *
   * Grain: billingMonth + billingYear + brandName + campaignSourceId + commercialModel
   *        + currency + paymentStatus
   * Amount: clientPayable / clientCommission only. linkClicks = null.
   */
  async listPaymentStatus(clientId, query = {}) {
    const client = await this.assertClient(clientId);
    const billingMonth = query.billing_month != null ? Number(query.billing_month) : null;
    const billingYear = query.billing_year != null ? Number(query.billing_year) : null;
    const currencyFilter = query.currency ? String(query.currency).toUpperCase() : null;
    const brandFilter = query.brand ? String(query.brand).trim().toLowerCase() : null;
    const statusFilter = query.payment_status || query.paymentStatus || null;
    const { page, pageSize, skip } = getPagination(query);
    const take = pageSize;

    if (billingMonth != null && (billingMonth < 1 || billingMonth > 12 || Number.isNaN(billingMonth))) {
      throw fail("billing_month must be 1–12.", 400);
    }
    if (billingYear != null && (billingYear < 2000 || Number.isNaN(billingYear))) {
      throw fail("billing_year is invalid.", 400);
    }

    const orders = await this.prisma.order.findMany({
      where: {
        clientId,
        ...(currencyFilter ? { currency: currencyFilter } : {}),
      },
      include: {
        merchant: { select: { displayName: true } },
        canonicalCampaign: { select: { displayName: true } },
        campaignSource: {
          include: {
            supplierCampaign: {
              select: { campaignType: true, pricingModel: true, supplier: true },
            },
          },
        },
        financialTransactions: {
          select: {
            clientPayable: true,
            reportingClientPayable: true,
            reportingCurrency: true,
            effectiveAt: true,
            transactionType: true,
          },
        },
        conversions: { select: { clientCommission: true } },
      },
      take: 5000,
    });

    /** @type {Map<string, any>} */
    const buckets = new Map();

    const ensureBucket = (key, seed) => {
      if (!buckets.has(key)) {
        buckets.set(key, {
          ...seed,
          payableOrders: 0,
          commissionSum: 0,
          hasCommission: false,
          usedFt: false,
          usedSnapshot: false,
          paymentConfirmedDate: null,
          orderDate: null,
          orderConfirmDate: null,
        });
      }
      return buckets.get(key);
    };

    for (const order of orders) {
      const anchor = order.orderDate || order.receivedAt || order.createdAt;
      const bk = billingKeyFromDate(anchor);
      if (!bk) continue;
      if (billingMonth != null && bk.month !== billingMonth) continue;
      if (billingYear != null && bk.year !== billingYear) continue;

      const brandName = order.merchant?.displayName ?? null;
      if (brandFilter && !(brandName || "").toLowerCase().includes(brandFilter)) continue;

      const campaignSourceId = order.campaignSourceId ?? null;
      const commercialModel =
        mapCampaignType(
          order.campaignSource?.supplierCampaign?.campaignType,
          order.campaignSource?.supplierCampaign?.pricingModel,
        ) || null;
      const currency = order.currency || client.currency || null;
      if (currencyFilter && currency !== currencyFilter) continue;

      const paymentStatus = mapClientFacingPaymentStatus(order);
      if (statusFilter && String(paymentStatus).toLowerCase() !== String(statusFilter).toLowerCase()) {
        continue;
      }

      const mapKey = `${bk.year}|${bk.month}|${brandName || "_"}|${campaignSourceId || "_"}|${commercialModel || "_"}|${currency || "_"}|${paymentStatus}`;
      const b = ensureBucket(mapKey, {
        billingMonth: bk.month,
        billingYear: bk.year,
        brandName,
        campaignName: order.canonicalCampaign?.displayName ?? null,
        campaignSourceId,
        commercialModel,
        currency,
        paymentStatus,
        date: `${bk.year}-${String(bk.month).padStart(2, "0")}-01`,
      });

      b.payableOrders += 1;
      const commission = this.resolveOrderCommission(order);
      if (commission.clientCommission != null) {
        b.commissionSum += Number(commission.clientCommission) || 0;
        b.hasCommission = true;
        if (commission.commissionSource === "financial_transaction") b.usedFt = true;
        else b.usedSnapshot = true;
      }

      if (order.orderDate && (!b.orderDate || order.orderDate < b.orderDate)) {
        b.orderDate = order.orderDate;
      }
      if (
        order.validationChangedAt &&
        String(order.validationStatus || "").toUpperCase() === "VALIDATION_APPROVED"
      ) {
        if (!b.orderConfirmDate || order.validationChangedAt > b.orderConfirmDate) {
          b.orderConfirmDate = order.validationChangedAt;
        }
      }
      if (
        String(order.clientPaymentStatus || "").toUpperCase() === "CLIENT_PAYMENT_PAID" &&
        order.clientPaymentChangedAt
      ) {
        if (!b.paymentConfirmedDate || order.clientPaymentChangedAt > b.paymentConfirmedDate) {
          b.paymentConfirmedDate = order.clientPaymentChangedAt;
        }
      }
    }

    // Orphan FT (no order) — still clientPayable only; incomplete brand/source dims stay null.
    const ftOrphans = await this.prisma.financialTransaction.findMany({
      where: {
        clientId,
        orderId: null,
        ...(currencyFilter
          ? {
              OR: [{ reportingCurrency: currencyFilter }, { originalCurrency: currencyFilter }],
            }
          : {}),
      },
      select: {
        clientPayable: true,
        reportingClientPayable: true,
        reportingCurrency: true,
        originalCurrency: true,
        effectiveAt: true,
        transactionType: true,
      },
      take: 2000,
    });

    for (const t of ftOrphans) {
      const bk = billingKeyFromDate(t.effectiveAt);
      if (!bk) continue;
      if (billingMonth != null && bk.month !== billingMonth) continue;
      if (billingYear != null && bk.year !== billingYear) continue;
      const currency = t.reportingCurrency || t.originalCurrency || client.currency || null;
      if (currencyFilter && currency !== currencyFilter) continue;
      const paymentStatus = "Payable";
      if (statusFilter && String(statusFilter).toLowerCase() !== "payable") continue;
      if (brandFilter) continue;

      const mapKey = `${bk.year}|${bk.month}|_|_|_|${currency || "_"}|${paymentStatus}`;
      const b = ensureBucket(mapKey, {
        billingMonth: bk.month,
        billingYear: bk.year,
        brandName: null,
        campaignName: null,
        campaignSourceId: null,
        commercialModel: null,
        currency,
        paymentStatus,
        date: `${bk.year}-${String(bk.month).padStart(2, "0")}-01`,
      });
      const amt =
        t.reportingClientPayable != null && t.reportingCurrency === currency
          ? Number(t.reportingClientPayable)
          : Number(t.clientPayable);
      const signed = t.transactionType === "REVERSAL" ? -Math.abs(amt || 0) : amt || 0;
      if (Number.isFinite(signed)) {
        b.commissionSum += signed;
        b.hasCommission = true;
        b.usedFt = true;
      }
    }

    const allRows = [...buckets.values()]
      .map((b) =>
        toClientPaymentStatusDto({
          billingMonth: b.billingMonth,
          billingYear: b.billingYear,
          brandName: b.brandName,
          campaignName: b.campaignName,
          campaignSourceId: b.campaignSourceId,
          commercialModel: b.commercialModel,
          currency: b.currency,
          paymentStatus: b.paymentStatus,
          payableOrders: b.payableOrders,
          payableCommission: b.hasCommission ? b.commissionSum : null,
          paymentConfirmedDate: b.paymentConfirmedDate,
          orderDate: b.orderDate,
          orderConfirmDate: b.orderConfirmDate,
          date: b.date,
          commissionSource: b.usedFt
            ? b.usedSnapshot
              ? "financial_transaction+snapshot"
              : "financial_transaction"
            : b.usedSnapshot
              ? "order_or_conversion_snapshot"
              : "unavailable",
        }),
      )
      .sort(
        (a, b) =>
          b.billingYear - a.billingYear ||
          b.billingMonth - a.billingMonth ||
          String(a.brandName || "").localeCompare(String(b.brandName || "")),
      );

    // Optional statement / invoice references (read-only; do not invent settlement)
    let statements = [];
    if (typeof this.prisma.clientStatement?.findMany === "function") {
      try {
        statements = await this.prisma.clientStatement.findMany({
          where: { clientId },
          select: {
            id: true,
            periodStart: true,
            periodEnd: true,
            currency: true,
            status: true,
            invoices: {
              select: {
                id: true,
                invoiceNumber: true,
                status: true,
              },
              take: 5,
            },
          },
          take: 24,
          orderBy: { periodStart: "desc" },
        });
      } catch {
        statements = [];
      }
    }

    const enriched = allRows.map((row) => {
      const match = (statements || []).find((s) => {
        if (!s.periodStart) return false;
        const y = new Date(s.periodStart).getUTCFullYear();
        const m = new Date(s.periodStart).getUTCMonth() + 1;
        if (y !== row.billingYear || m !== row.billingMonth) return false;
        if (s.currency && row.currency && s.currency !== row.currency) return false;
        return true;
      });
      if (!match) {
        return {
          ...row,
          statementId: null,
          invoiceReference: null,
          settlementStatus: "NOT_AVAILABLE",
        };
      }
      const inv = match.invoices?.[0] || null;
      return {
        ...row,
        statementId: match.id,
        invoiceReference: inv?.invoiceNumber || inv?.id || null,
        settlementStatus: inv?.status || match.status || "NOT_AVAILABLE",
      };
    });

    const total = enriched.length;
    const pageRows = enriched.slice(skip, skip + take);
    const hasRows = total > 0;

    let payableCommissionTotal = null;
    let paidCommissionTotal = null;
    let pendingCommissionTotal = null;
    let payableOrdersTotal = null;
    if (hasRows) {
      payableCommissionTotal = 0;
      paidCommissionTotal = 0;
      pendingCommissionTotal = 0;
      payableOrdersTotal = 0;
      for (const r of enriched) {
        payableOrdersTotal += Number(r.payableOrders) || 0;
        const amt = r.payableCommission != null ? Number(r.payableCommission) : 0;
        if (r.payableCommission != null) {
          payableCommissionTotal += amt;
          const st = String(r.paymentStatus || "");
          if (st === "Paid") paidCommissionTotal += amt;
          else if (st !== "Rejected") pendingCommissionTotal += amt;
        }
      }
    }

    return {
      client: toPartnerClientSummaryDto(client),
      items: pageRows,
      payments: pageRows,
      rows: pageRows,
      kpis: {
        payableCommissionTotal: hasRows ? Number(payableCommissionTotal.toFixed(4)) : null,
        paidCommissionTotal: hasRows ? Number(paidCommissionTotal.toFixed(4)) : null,
        pendingCommissionTotal: hasRows ? Number(pendingCommissionTotal.toFixed(4)) : null,
        payableOrdersTotal: hasRows ? payableOrdersTotal : null,
        currency: client.currency || null,
      },
      dataAvailable: hasRows,
      dataState: hasRows ? "ok" : "empty",
      unavailableFields: [...CLIENT_PAYMENT_UNAVAILABLE_FIELDS],
      forbiddenFields: [...FORBIDDEN_CLIENT_PAYMENT_KEYS],
      reportType: "payment_status",
      contract: "v15-05E-client-payments",
      grainNote:
        "Grain: billingMonth+billingYear+brandName+campaignSourceId+commercialModel(CPS/CPA…)+currency+paymentStatus. Amount=clientPayable only. linkClicks=null. Admin supplierReceivable never exposed. Withdrawals remain /portal/v1/payments.",
      migrationRequired: false,
      financeConsumerMode: this.getFinanceMode(),
      note: "Client payment-status report. Withdrawals/bank details remain on /portal/v1/payments.",
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize) || 1, 1),
      },
    };
  }
}
