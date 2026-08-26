/**
 * Admin Reporting v20 — Client Overview, Client Performance, Client Confirmed Orders.
 * Staff-only: may include network commission and MBO commission (unlike client portal).
 */
import { prisma } from "../../database/prisma.js";
import { getPagination } from "../../core/pagination.js";
import {
  summarizeConversionsForBucket,
  sumDistinctOrderValues,
  classifyConversionChannel,
  isConfirmedConversionStatus,
  isPendingConversionStatus,
  isRejectedConversionStatus,
  isCancelledConversionStatus,
  toClientCampaignTypeLabel,
} from "./v15PerformanceGrain.js";
import { ClientReportingService } from "../client/services/clientReporting.service.js";
import { toClientConfirmedOrderDto } from "../client/dto/clientPerformance.dto.js";

function money(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : null;
}

function countryName(iso) {
  if (!iso) return null;
  const map = {
    IN: "India",
    AE: "UAE",
    EG: "Egypt",
    SA: "Saudi Arabia",
    US: "United States",
    GB: "United Kingdom",
  };
  const code = String(iso).toUpperCase();
  return map[code] || code;
}

function dateWhere(field, from, to) {
  if (!from && !to) return {};
  return {
    [field]: {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: endOfDay(to) } : {}),
    },
  };
}

/** Inclusive end-of-day for date-only query params (YYYY-MM-DD). */
function endOfDay(iso) {
  if (!iso) return undefined;
  const s = String(iso);
  if (s.includes("T")) return new Date(s);
  return new Date(`${s.slice(0, 10)}T23:59:59.999Z`);
}

/**
 * Soft-attribute conversions to a client when assignment/order links are missing:
 * direct assignment, order.clientId, or same supplier as the client's campaigns.
 */
async function clientConversionScope(prismaClient, clientId) {
  if (!clientId) return null;
  const assignments = await prismaClient.clientCampaignAssignment.findMany({
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
  const or = [{ clientAssignment: { clientId } }, { order: { clientId } }];
  if (suppliers.length) {
    or.push({ clientAssignmentId: null, supplier: { in: suppliers } });
  }
  return { OR: or, suppliers };
}

export class AdminClientReportingService {
  constructor(deps = {}) {
    this.prisma = deps.prisma ?? prisma;
    this.clientReporting = deps.clientReporting ?? new ClientReportingService({ prisma: this.prisma });
  }

  /**
   * v20 Client Overview — one row per client (admin finance fields included).
   */
  async listClientOverview(query = {}, permissions = []) {
    const { page, pageSize, skip } = getPagination(query);
    const from = query.from || null;
    const to = query.to || null;
    const countryFilter = query.country && query.country !== "All Countries"
      ? String(query.country).trim()
      : null;
    const networkFilter = query.network && query.network !== "All Networks"
      ? String(query.network).trim().toUpperCase()
      : null;
    const search = String(query.q || query.search || "").trim().toLowerCase();

    const clientWhere = {
      deletedAt: null,
      ...(countryFilter
        ? countryFilter.length === 2
          ? { country: countryFilter.toUpperCase() }
          : {
              OR: [
                { country: { equals: Object.entries({ IN: "India", AE: "UAE", EG: "Egypt" }).find(([, n]) => n === countryFilter)?.[0] || countryFilter.slice(0, 2).toUpperCase() } },
              ],
            }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { slug: { contains: search, mode: "insensitive" } },
              { country: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    // Prefer clients with reporting activity or active assignments
    const [clients, totalClients] = await Promise.all([
      this.prisma.client.findMany({
        where: clientWhere,
        select: {
          id: true,
          name: true,
          country: true,
          currency: true,
          status: true,
          updatedAt: true,
          _count: {
            select: {
              assignments: { where: { status: { in: ["ACTIVE", "ASSIGNED"] } } },
            },
          },
        },
        orderBy: { name: "asc" },
        skip,
        take: pageSize,
      }),
      this.prisma.client.count({ where: clientWhere }),
    ]);

    const clientIds = clients.map((c) => c.id);
    if (!clientIds.length) {
      return this.emptyOverview(page, pageSize);
    }

    const reportDateWhere = dateWhere("reportDate", from, to);
    const convDateWhere = dateWhere("conversionDate", from, to);

    const [dailyAggs, assignments, conversions] = await Promise.all([
      this.prisma.dailyReport.groupBy({
        by: ["clientId"],
        where: { clientId: { in: clientIds }, ...reportDateWhere },
        _sum: {
          conversionCount: true,
          approvedConversionCount: true,
          clickCount: true,
          grossCommission: true,
          clientCommission: true,
          mboCommission: true,
        },
        _max: { updatedAt: true },
      }),
      this.prisma.clientCampaignAssignment.findMany({
        where: { clientId: { in: clientIds } },
        select: {
          clientId: true,
          campaignSourceId: true,
          campaignSource: {
            select: {
              id: true,
              supplierCampaign: { select: { supplier: true } },
            },
          },
        },
      }),
      this.prisma.conversion.findMany({
        where: {
          clientAssignment: { clientId: { in: clientIds } },
          ...convDateWhere,
          ...(networkFilter
            ? { supplier: networkFilter }
            : {}),
        },
        select: {
          id: true,
          status: true,
          supplier: true,
          supplierCommission: true,
          approvedCommission: true,
          clientCommission: true,
          mboCommission: true,
          clickId: true,
          trackingLinkId: true,
          orderId: true,
          metadata: true,
          updatedAt: true,
          clientAssignment: { select: { clientId: true } },
          order: { select: { orderValue: true, validationStatus: true } },
        },
      }),
    ]);

    const dailyByClient = new Map(dailyAggs.map((r) => [r.clientId, r]));
    const networksByClient = new Map();
    const sourceIdsByClient = new Map();
    for (const a of assignments) {
      if (!networksByClient.has(a.clientId)) networksByClient.set(a.clientId, new Set());
      if (!sourceIdsByClient.has(a.clientId)) sourceIdsByClient.set(a.clientId, new Set());
      const supplier = a.campaignSource?.supplierCampaign?.supplier;
      if (supplier) networksByClient.get(a.clientId).add(supplier);
      if (a.campaignSourceId) sourceIdsByClient.get(a.clientId).add(a.campaignSourceId);
    }

    // Network-side orders: conversions on assigned sources (attributed or not) in range
    const allSourceIds = [...new Set(assignments.map((a) => a.campaignSourceId).filter(Boolean))];
    let networkConvBySource = new Map();
    if (allSourceIds.length) {
      const networkConvs = await this.prisma.conversion.groupBy({
        by: ["campaignSourceId"],
        where: {
          campaignSourceId: { in: allSourceIds },
          ...convDateWhere,
          ...(networkFilter ? { supplier: networkFilter } : {}),
        },
        _count: { _all: true },
      });
      networkConvBySource = new Map(networkConvs.map((r) => [r.campaignSourceId, r._count._all]));
    }

    /** @type {Map<string, object>} */
    const funnelByClient = new Map();
    for (const id of clientIds) {
      funnelByClient.set(id, {
        clientOrders: 0,
        pending: 0,
        confirmed: 0,
        rejected: 0,
        cancelled: 0,
        couponOrders: 0,
        affiliateOrders: 0,
        grossOrderValue: 0,
        confirmedOrderValue: 0,
        grossNetworkCommission: 0,
        confirmedNetworkCommission: 0,
        clientCommissionGenerated: 0,
        confirmedClientCommission: 0,
        mboCommission: 0,
        lastUpdatedAt: null,
        orderIds: new Set(),
        confirmedOrderIds: new Set(),
      });
    }

    for (const c of conversions) {
      const clientId = c.clientAssignment?.clientId;
      if (!clientId || !funnelByClient.has(clientId)) continue;
      const f = funnelByClient.get(clientId);
      f.clientOrders += 1;
      if (isPendingConversionStatus(c.status)) f.pending += 1;
      if (isConfirmedConversionStatus(c.status)) f.confirmed += 1;
      if (isRejectedConversionStatus(c.status, c.metadata)) f.rejected += 1;
      if (isCancelledConversionStatus(c.status, c.metadata)) f.cancelled += 1;

      const channel = classifyConversionChannel(c);
      if (channel === "Coupon" || channel === "Link + Coupon") f.couponOrders += 1;
      if (channel === "Link" || channel === "Link + Coupon") f.affiliateOrders += 1;

      const sc = Number(c.supplierCommission);
      if (Number.isFinite(sc)) f.grossNetworkCommission += sc;
      const ac = Number(c.approvedCommission);
      if (Number.isFinite(ac) && isConfirmedConversionStatus(c.status)) {
        f.confirmedNetworkCommission += ac;
      }
      const cc = Number(c.clientCommission);
      if (Number.isFinite(cc) && String(c.status).toUpperCase() !== "REJECTED") {
        f.clientCommissionGenerated += cc;
        if (isConfirmedConversionStatus(c.status)) f.confirmedClientCommission += cc;
      }
      const mc = Number(c.mboCommission);
      if (Number.isFinite(mc) && isConfirmedConversionStatus(c.status)) {
        f.mboCommission += mc;
      }

      if (c.orderId) {
        f.orderIds.add(c.orderId);
        if (isConfirmedConversionStatus(c.status)) f.confirmedOrderIds.add(c.orderId);
      }
      if (c.updatedAt && (!f.lastUpdatedAt || c.updatedAt > f.lastUpdatedAt)) {
        f.lastUpdatedAt = c.updatedAt;
      }
    }

    // Distinct order values
    const allOrderIds = [...new Set([...funnelByClient.values()].flatMap((f) => [...f.orderIds]))];
    const orders = allOrderIds.length
      ? await this.prisma.order.findMany({
          where: { id: { in: allOrderIds } },
          select: { id: true, orderValue: true, validationStatus: true },
        })
      : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));
    for (const f of funnelByClient.values()) {
      const bucket = [...f.orderIds].map((id) => orderById.get(id)).filter(Boolean);
      const vals = sumDistinctOrderValues(bucket);
      f.grossOrderValue = vals.grossOrderValue ?? 0;
      const confirmedBucket = [...f.confirmedOrderIds].map((id) => orderById.get(id)).filter(Boolean);
      const cvals = sumDistinctOrderValues(confirmedBucket);
      f.confirmedOrderValue = cvals.grossOrderValue ?? cvals.netOrderValue ?? 0;
    }

    let items = clients.map((client) => {
      const daily = dailyByClient.get(client.id);
      const funnel = funnelByClient.get(client.id);
      const sources = [...(sourceIdsByClient.get(client.id) || [])];
      let networkOrders = 0;
      for (const sid of sources) networkOrders += networkConvBySource.get(sid) || 0;

      const mboOrders = daily?._sum?.conversionCount != null
        ? Number(daily._sum.conversionCount)
        : funnel.clientOrders;
      const clientOrders = funnel.clientOrders || Number(daily?._sum?.conversionCount || 0);

      // Prefer conversion funnel; fall back to DailyReport commissions when no conversions projected
      let grossNetwork = funnel.grossNetworkCommission;
      let confirmedNetwork = funnel.confirmedNetworkCommission;
      let clientGen = funnel.clientCommissionGenerated;
      let clientConf = funnel.confirmedClientCommission;
      let mboComm = funnel.mboCommission;
      if (!funnel.clientOrders && daily?._sum) {
        grossNetwork = Number(daily._sum.grossCommission || 0);
        clientConf = Number(daily._sum.clientCommission || 0);
        clientGen = clientConf;
        mboComm = Number(daily._sum.mboCommission || 0);
        confirmedNetwork = grossNetwork; // honest fallback only when no status split
      }

      const lastUpdated =
        funnel.lastUpdatedAt || daily?._max?.updatedAt || client.updatedAt || null;

      return {
        clientId: client.id,
        clientName: client.name,
        country: countryName(client.country) || client.country,
        countryCode: client.country,
        currency: client.currency,
        networks: [...(networksByClient.get(client.id) || [])].join(", ") || null,
        networkOrders,
        mboOrders,
        clientOrders,
        pendingOrders: funnel.pending,
        confirmedOrders:
          funnel.confirmed || Number(daily?._sum?.approvedConversionCount || 0),
        rejectedOrders: funnel.rejected,
        cancelledOrders: funnel.cancelled,
        grossOrderValue: money(funnel.grossOrderValue),
        confirmedOrderValue: money(funnel.confirmedOrderValue),
        grossNetworkCommission: money(grossNetwork),
        confirmedNetworkCommission: money(confirmedNetwork),
        clientCommissionGenerated: money(clientGen),
        confirmedClientCommission: money(clientConf),
        mboCommission: money(mboComm),
        couponOrders: funnel.couponOrders,
        affiliateLinkOrders: funnel.affiliateOrders,
        activeCampaigns: client._count?.assignments ?? 0,
        lastUpdatedAt: lastUpdated ? new Date(lastUpdated).toISOString() : null,
        status: client.status,
      };
    });

    if (networkFilter) {
      items = items.filter(
        (r) => r.networks && r.networks.toUpperCase().includes(networkFilter),
      );
    }
    if (countryFilter && countryFilter.length > 2) {
      items = items.filter(
        (r) =>
          String(r.country || "").toLowerCase() === countryFilter.toLowerCase() ||
          String(r.countryCode || "").toUpperCase() === countryFilter.toUpperCase(),
      );
    }

    const kpis = {
      activeClients: totalClients,
      networkOrders: items.reduce((s, r) => s + (Number(r.networkOrders) || 0), 0),
      mboOrders: items.reduce((s, r) => s + (Number(r.mboOrders) || 0), 0),
      clientOrders: items.reduce((s, r) => s + (Number(r.clientOrders) || 0), 0),
      pendingClientOrders: items.reduce((s, r) => s + (Number(r.pendingOrders) || 0), 0),
      confirmedClientOrders: items.reduce((s, r) => s + (Number(r.confirmedOrders) || 0), 0),
      confirmedClientCommission: money(
        items.reduce((s, r) => s + (Number(r.confirmedClientCommission) || 0), 0),
      ),
      mboCommission: money(items.reduce((s, r) => s + (Number(r.mboCommission) || 0), 0)),
    };

    return {
      items,
      kpis,
      dataAvailable: items.length > 0,
      contract: "v20-admin-client-overview",
      grainNote:
        "One row per client. Admin may see network + MBO commission. Client portal must not use this endpoint.",
      pagination: {
        page,
        pageSize,
        total: totalClients,
        totalPages: Math.max(Math.ceil(totalClients / pageSize), 1),
      },
    };
  }

  emptyOverview(page, pageSize) {
    return {
      items: [],
      kpis: {
        activeClients: 0,
        networkOrders: 0,
        mboOrders: 0,
        clientOrders: 0,
        pendingClientOrders: 0,
        confirmedClientOrders: 0,
        confirmedClientCommission: 0,
        mboCommission: 0,
      },
      dataAvailable: false,
      contract: "v20-admin-client-overview",
      pagination: { page, pageSize, total: 0, totalPages: 1 },
    };
  }

  /**
   * Admin Client Performance — campaign grain for one client (v20 columns).
   * Reuses client performance projection; admin may pass any clientId.
   * Network/MBO commission still excluded on this screen per v20 Client Performance model.
   */
  async listClientPerformance(query = {}) {
    const clientId = query.clientId || null;
    const clientPicker = async () => {
      const rows = await this.prisma.client.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          name: true,
          country: true,
          currency: true,
          _count: { select: { assignments: true } },
        },
        orderBy: { name: "asc" },
        take: 200,
      });
      const suggested =
        [...rows].sort((a, b) => (b._count?.assignments || 0) - (a._count?.assignments || 0))[0] ||
        null;
      return {
        clients: rows.map(({ _count, ...c }) => c),
        suggestedClientId:
          suggested && (suggested._count?.assignments || 0) > 0
            ? suggested.id
            : rows[0]?.id || null,
      };
    };

    if (!clientId) {
      const picker = await clientPicker();
      return {
        ...picker,
        items: [],
        kpis: {},
        dataAvailable: false,
        contract: "v20-admin-client-performance",
        message: "Select a client to load campaign performance.",
      };
    }

    const payload = await this.clientReporting.listPerformance(clientId, query, {
      requireActive: false,
    });
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, name: true, country: true, currency: true },
    });
    const picker = await clientPicker();

    return {
      ...payload,
      selectedClient: client,
      clients: picker.clients,
      suggestedClientId: picker.suggestedClientId,
      contract: "v20-admin-client-performance",
      grainNote:
        "Admin Client Performance — same campaign grain as portal; network/MBO commission excluded by design.",
    };
  }

  /**
   * Admin Client Confirmed Orders — across clients (individual confirmed only).
   */
  async listClientConfirmedOrders(query = {}) {
    const { page, pageSize, skip } = getPagination(query);
    const from = query.from || null;
    const to = query.to || null;
    const clientId = query.clientId || null;
    const networkFilter = query.network && query.network !== "All Networks"
      ? String(query.network).trim().toUpperCase()
      : null;
    const confirmationType = query.confirmationType || query.type || null;
    const search = String(query.q || query.search || "").trim().toLowerCase();

    const wantAggregate =
      !confirmationType ||
      String(confirmationType).toLowerCase().includes("aggregate") ||
      String(confirmationType).toLowerCase() === "all types";
    const wantIndividual =
      !confirmationType ||
      String(confirmationType).toLowerCase().includes("individual") ||
      String(confirmationType).toLowerCase() === "all types";
    // Aggregate-only short-circuit after we load settlements (below).

    const dateFilter = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = endOfDay(to);
    const hasDate = Object.keys(dateFilter).length > 0;

    const scope = clientId ? await clientConversionScope(this.prisma, clientId) : null;
    const selectedClient = clientId
      ? await this.prisma.client.findUnique({
          where: { id: clientId },
          select: { id: true, name: true },
        })
      : null;

    // Do not require clientAssignmentId — many synced conversions are unlinked.
    // When a client is selected, soft-attribute via assignment, order.clientId, or supplier match.
    const where = {
      status: { in: ["APPROVED", "PAID"] },
      ...(scope ? { OR: scope.OR } : {}),
      ...(networkFilter && networkFilter !== "BOOSTINY" ? { supplier: networkFilter } : {}),
      ...(networkFilter === "BOOSTINY" ? { supplier: "BOOSTINY" } : {}),
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

    const settlementWhere = {
      status: { in: ["SETTLED", "PENDING_REVIEW"] },
      ...(clientId ? { clientId } : {}),
      ...(hasDate
        ? {
            updatedAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: endOfDay(to) } : {}),
            },
          }
        : {}),
    };

    const loadIndividuals = wantIndividual && networkFilter !== "BOOSTINY";
    const loadAggregates =
      wantAggregate && (!networkFilter || networkFilter === "BOOSTINY" || networkFilter === "");

    const [conversions, individualTotal, clientCount, settlements] = await Promise.all([
      loadIndividuals
        ? this.prisma.conversion.findMany({
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
                  supplierCampaign: {
                    select: { campaignName: true, supplier: true, merchantNameRaw: true },
                  },
                },
              },
              clientAssignment: {
                select: {
                  id: true,
                  client: { select: { id: true, name: true } },
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
            take: Math.min(pageSize * 5, 500),
          })
        : Promise.resolve([]),
      loadIndividuals ? this.prisma.conversion.count({ where }) : Promise.resolve(0),
      loadIndividuals
        ? this.prisma.conversion.findMany({
            where,
            select: { clientAssignment: { select: { clientId: true } } },
            distinct: ["clientAssignmentId"],
            take: 5000,
          })
        : Promise.resolve([]),
      loadAggregates
        ? this.prisma.boostinyPartnerPaymentSettlement.findMany({
            where: settlementWhere,
            include: {
              client: { select: { id: true, name: true } },
            },
            orderBy: [{ updatedAt: "desc" }],
            take: 500,
          })
        : Promise.resolve([]),
    ]);

    let items = conversions.map((c) => {
      const rule = c.clientAssignment?.commissionRules?.[0];
      let rateLabel = null;
      if (rule?.displayLabel) rateLabel = String(rule.displayLabel);
      else if (rule?.orderValuePercent != null) rateLabel = `${Number(rule.orderValuePercent)}%`;
      else if (rule?.fixedAmount != null) rateLabel = String(rule.fixedAmount);
      else if (
        rule?.grossCommission != null &&
        Number(rule.grossCommission) > 0 &&
        rule?.clientCommission != null
      ) {
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
          clientName: c.clientAssignment?.client?.name || selectedClient?.name || null,
          network: c.campaignSource?.supplierCampaign?.supplier || c.supplier || null,
          brandName,
          campaignName:
            c.campaignSource?.canonicalCampaign?.displayName ||
            c.campaignSource?.supplierCampaign?.campaignName ||
            null,
          campaignType: channel.clientCampaignType || toClientCampaignTypeLabel(channel.campaignType),
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
        clientId: c.clientAssignment?.client?.id || selectedClient?.id || null,
        // Admin extras (not in client-facing HTML clientConfirmedFields)
        confirmedNetworkCommission: money(c.approvedCommission),
        mboCommissionAmount: money(c.mboCommission),
      };
    });

    const aggregateItems = settlements.map((s) => {
      const updated = s.updatedAt ? new Date(s.updatedAt) : null;
      return {
        ...toClientConfirmedOrderDto({
          confirmationType: "Aggregate Settlement",
          orderConfirmedDate: updated?.toISOString?.()?.slice(0, 10) || null,
          orderDate: null,
          cycle: s.cycle || null,
          clientName: s.client?.name || null,
          network: "BOOSTINY",
          brandName: s.paymentSource || null,
          campaignName: s.paymentSource || null,
          campaignType: null,
          couponCode: null,
          mboTrackingLink: null,
          networkOrderId: null,
          networkConversionId: null,
          mboClickId: null,
          confirmedOrders: s.ordersCount != null ? Number(s.ordersCount) : null,
          confirmedOrderValueAmount: s.salesAmountUsd ?? s.revenue ?? null,
          currency: s.currency || "USD",
          clientCommissionRate: "Contract Rule",
          confirmedClientCommissionAmount: s.extra ?? null,
          confirmationStatus: "Aggregate Confirmed",
          settlementStatus: String(s.status || "").replace(/_/g, " / "),
          lastUpdatedAt: s.updatedAt,
          orderId: null,
        }),
        clientId: s.clientId || null,
        confirmedNetworkCommission: money(s.revenue),
        mboCommissionAmount: null,
      };
    });

    if (wantAggregate) items = items.concat(aggregateItems);

    if (search) {
      items = items.filter((r) =>
        Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(search)),
      );
    }

    const uniqueClients = new Set([
      ...clientCount.map((c) => c.clientAssignment?.clientId).filter(Boolean),
      ...settlements.map((s) => s.clientId).filter(Boolean),
    ]);

    const aggregateConfirmed = settlements.reduce(
      (sum, s) => sum + (Number(s.ordersCount) || 0),
      0,
    );
    const total = individualTotal + aggregateItems.length;
    const paged = items.slice(skip, skip + pageSize);

    const kpis = {
      confirmedClientOrders: individualTotal + aggregateConfirmed,
      confirmedOrderValue: money(
        items.reduce((s, r) => s + (Number(r.confirmedOrderValueAmount) || 0), 0),
      ),
      confirmedClientCommission: money(
        items.reduce((s, r) => s + (Number(r.confirmedClientCommissionAmount) || 0), 0),
      ),
      individualConfirmed: individualTotal,
      aggregateConfirmed,
      clients: uniqueClients.size,
    };

    const clients = await this.prisma.client.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 200,
    });

    return {
      items: paged,
      clients,
      kpis,
      dataAvailable: total > 0,
      contract: "v20-admin-client-confirmed-orders",
      grainNote:
        "Individual order-level confirmation plus Boostiny Partner Payment aggregate settlement cycles. Aggregates never invent Network Order ID / Conversion ID / Coupon / MBO Click ID.",
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
      },
    };
  }

  /**
   * Reporting Overview — all-network generated + confirmed summary (v20 HTML screen 1).
   */
  async getReportingOverview(query = {}) {
    const from = query.from || null;
    const to = query.to || null;
    const network = query.network || null;
    const brand = query.brand || null;

    const { NetworkPortalService } = await import("../networkPortal/networkPortal.service.js");
    const portal = new NetworkPortalService({ prisma: this.prisma });
    const result = await portal.listNetworkPerformance({
      network,
      from,
      to,
      brand,
      skip: 0,
      take: 5000,
    });

    const items = result.items || [];
    const byNetwork = new Map();
    const byBrand = new Map();

    for (const row of items) {
      const net = String(row.network || row.networkSource || "UNKNOWN").toUpperCase();
      const brandName = row.brandName || "Unknown";
      const bucket = byNetwork.get(net) || {
        network: net,
        ordersGenerated: 0,
        grossOrderValue: 0,
        networkCommission: 0,
        confirmedOrders: 0,
        confirmedCommission: 0,
        mboCommissionMade: 0,
      };
      bucket.ordersGenerated += Number(row.grossOrders) || 0;
      bucket.grossOrderValue += Number(row.grossOrderValue) || 0;
      bucket.networkCommission += Number(row.grossCommission) || 0;
      bucket.confirmedOrders += Number(row.confirmedOrders) || 0;
      bucket.confirmedCommission += Number(row.confirmedCommission || row.netCommission) || 0;
      // MBO margin not always on network fact — leave 0 unless present
      bucket.mboCommissionMade += Number(row.mboReceivable) || 0;
      byNetwork.set(net, bucket);

      const bb = byBrand.get(brandName) || { brandName, orders: 0 };
      bb.orders += Number(row.grossOrders) || 0;
      byBrand.set(brandName, bb);
    }

    const networks = [...byNetwork.values()].sort(
      (a, b) => b.networkCommission - a.networkCommission,
    );
    const topBrands = [...byBrand.values()].sort((a, b) => b.orders - a.orders).slice(0, 8);

    const kpis = {
      ordersGenerated: networks.reduce((s, n) => s + n.ordersGenerated, 0),
      grossOrderValue: money(networks.reduce((s, n) => s + n.grossOrderValue, 0)),
      networkCommission: money(networks.reduce((s, n) => s + n.networkCommission, 0)),
      confirmedOrders: networks.reduce((s, n) => s + n.confirmedOrders, 0),
      confirmedCommission: money(networks.reduce((s, n) => s + n.confirmedCommission, 0)),
      mboCommissionMade: money(networks.reduce((s, n) => s + n.mboCommissionMade, 0)),
    };

    return {
      kpis,
      topNetworks: networks.slice(0, 8).map((n) => ({
        ...n,
        grossOrderValue: money(n.grossOrderValue),
        networkCommission: money(n.networkCommission),
        confirmedCommission: money(n.confirmedCommission),
        mboCommissionMade: money(n.mboCommissionMade),
      })),
      topBrands,
      networkSummary: networks.map((n) => ({
        ...n,
        grossOrderValue: money(n.grossOrderValue),
        networkCommission: money(n.networkCommission),
        confirmedCommission: money(n.confirmedCommission),
        mboCommissionMade: money(n.mboCommissionMade),
      })),
      contract: "v20-reporting-overview",
      grainNote:
        "Aggregated from NetworkPerformanceFact. Boostiny confirmation remains aggregate-settlement based.",
    };
  }
}
