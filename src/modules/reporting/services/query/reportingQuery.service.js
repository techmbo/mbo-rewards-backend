import { decodeCursor, encodeCursor } from "../../../../core/cursorPagination.js";
import { getPagination, toStandardPagedResponse } from "../../../../core/pagination.js";
import { applyConversionAccess, applyDailyReportAccess } from "../../../../auth/reportingDataAccess.js";
import { prisma } from "../../../../database/prisma.js";
import {
  ClickRepository,
  ConversionRepository,
  DailyReportRepository,
} from "../../repositories/reporting.repository.js";
import { aggregateCampaignSummaryFromFacts } from "../../campaignSummary.aggregation.js";
import { toAggregatedReportDto, toClickDto } from "../../dto/reporting.dto.js";

function buildSortOrder(query) {
  const sortBy = query.sortBy ?? "reportDate";
  const sortDir = query.sortDir ?? "desc";
  return [{ [sortBy]: sortDir }, { id: "desc" }];
}

function coerceDate(value) {
  if (value == null || value === "") return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function resolveReportDates(query = {}) {
  return {
    from: coerceDate(query.from ?? query.fromDate),
    to: coerceDate(query.to ?? query.toDate),
  };
}

export class ReportingQueryService {
  constructor(deps = {}) {
    this.db = deps.db ?? prisma;
    this.clickRepo = deps.clickRepo ?? new ClickRepository();
    this.conversionRepo = deps.conversionRepo ?? new ConversionRepository();
    this.dailyReportRepo = deps.dailyReportRepo ?? new DailyReportRepository();
    this.aggregateCampaignSummary =
      deps.aggregateCampaignSummary ?? aggregateCampaignSummaryFromFacts;
  }

  async listClicks(query) {
    return this.list(this.clickRepo, this.buildClickFilters(query), query, toClickDto, ["clickedAt", "id"]);
  }

  async listConversions(query, permissions = []) {
    return this.list(
      this.conversionRepo,
      this.buildConversionFilters(query),
      query,
      (row) => applyConversionAccess(row, permissions),
      ["conversionDate", "id"],
    );
  }

  async listDailyReports(query, permissions = []) {
    return this.list(
      this.dailyReportRepo,
      this.buildReportFilters(query),
      query,
      (row) => applyDailyReportAccess(row, permissions),
      ["reportDate", "id"],
      buildSortOrder(query),
    );
  }

  async listClientReports(query, permissions = []) {
    const rows = await this.dailyReportRepo.aggregateByClient(this.buildReportFilters(query));
    const clientIds = [...new Set(rows.map((r) => r.clientId).filter(Boolean))];
    const clients =
      clientIds.length > 0
        ? await this.db.client.findMany({
            where: { id: { in: clientIds } },
            select: {
              id: true,
              name: true,
              slug: true,
              users: {
                where: { isActive: true },
                orderBy: [{ role: "asc" }, { createdAt: "asc" }],
                take: 5,
                select: { email: true, role: true },
              },
            },
          })
        : [];
    const byId = new Map(clients.map((c) => [c.id, c]));

    const data = rows.map((row) => {
      const client = byId.get(row.clientId);
      const clientName = client?.name || null;
      const users = client?.users || [];
      const preferred =
        users.find((u) => u.role === "CLIENT") || users[0] || null;
      const clientEmail = preferred?.email || null;
      return applyDailyReportAccess(
        toAggregatedReportDto({
          dimensionKey: "client",
          dimensionId: row.clientId,
          totals: {
            clickCount: row._sum.clickCount,
            conversionCount: row._sum.conversionCount,
            approvedConversionCount: row._sum.approvedConversionCount,
            grossCommission: row._sum.grossCommission,
            clientCommission: row._sum.clientCommission,
            mboCommission: row._sum.mboCommission,
          },
          meta: {
            clientName,
            clientEmail,
            clientSlug: client?.slug || null,
          },
        }),
        permissions,
      );
    });
    return { ok: true, data, pagination: { page: 1, pageSize: data.length, total: data.length, hasMore: false } };
  }

  async listMerchantReports(query, permissions = []) {
    const rows = await this.dailyReportRepo.aggregateByMerchant(this.buildReportFilters(query));
    const data = rows.map((row) =>
      applyDailyReportAccess(
        toAggregatedReportDto({
          dimensionKey: "merchant",
          dimensionId: row.merchantId,
          totals: {
            clickCount: row._sum.clickCount,
            conversionCount: row._sum.conversionCount,
            approvedConversionCount: row._sum.approvedConversionCount,
            grossCommission: row._sum.grossCommission,
            clientCommission: row._sum.clientCommission,
            mboCommission: row._sum.mboCommission,
          },
        }),
        permissions,
      ),
    );
    return { ok: true, data, pagination: { page: 1, pageSize: data.length, total: data.length, hasMore: false } };
  }

  /**
   * Campaign Summary — NetworkPerformanceFact campaign grain (P1.14).
   * Same route GET /reports/campaign. DailyReport remains for client portal reports.
   */
  async listCampaignReports(query, permissions = []) {
    const { page, pageSize, skip } = getPagination(query);
    const filters = this.buildReportFilters(query);
    const { rows, total } = await this.aggregateCampaignSummary(filters, {
      skip,
      take: pageSize,
    });
    const data = rows.map((row) =>
      applyDailyReportAccess(
        toAggregatedReportDto({
          dimensionKey: "campaign",
          dimensionId: row.dimensionId,
          totals: {
            clickCount: row.clickCount,
            networkClickCount: row.networkClickCount,
            conversionCount: row.conversionCount,
            approvedConversionCount: row.approvedConversionCount,
            grossCommission: row.grossCommission,
            confirmedCommission: row.confirmedCommission,
            clientCommission: row.clientCommission,
            mboCommission: row.mboCommission,
            epc: row.epc,
          },
          meta: {
            campaignName: row.campaignName,
            brandName: row.brandName,
            campaignSourceId: row.campaignSourceId,
            canonicalCampaignId: row.canonicalCampaignId,
            supplier: row.supplier,
            currency: row.currency,
          },
        }),
        permissions,
      ),
    );
    return toStandardPagedResponse({
      rows: data,
      total,
      page,
      pageSize,
      hasMore: skip + rows.length < total,
    });
  }

  async listSourceReports(query, permissions = []) {
    const rows = await this.dailyReportRepo.aggregateBySource(this.buildReportFilters(query));
    const data = rows.map((row) =>
      applyDailyReportAccess(
        toAggregatedReportDto({
          dimensionKey: "source",
          dimensionId: row.campaignSourceId,
          totals: {
            clickCount: row._sum.clickCount,
            conversionCount: row._sum.conversionCount,
            approvedConversionCount: row._sum.approvedConversionCount,
            grossCommission: row._sum.grossCommission,
            clientCommission: row._sum.clientCommission,
            mboCommission: row._sum.mboCommission,
          },
        }),
        permissions,
      ),
    );
    return { ok: true, data, pagination: { page: 1, pageSize: data.length, total: data.length, hasMore: false } };
  }

  buildClickFilters(query) {
    const { from, to } = resolveReportDates(query);
    return {
      trackingLinkId: query.trackingLinkId,
      clientAssignmentId: query.clientAssignmentId,
      campaignSourceId: query.campaignSourceId,
      subId: query.subId || query.search || undefined,
      country: query.country,
      from,
      to,
    };
  }

  buildConversionFilters(query) {
    const { from, to } = resolveReportDates(query);
    return {
      trackingLinkId: query.trackingLinkId,
      clientAssignmentId: query.clientAssignmentId,
      campaignSourceId: query.campaignSourceId,
      status: query.status,
      attributionStatus: query.attributionStatus,
      supplier: query.supplier,
      from,
      to,
    };
  }

  buildReportFilters(query) {
    const { from, to } = resolveReportDates(query);
    return {
      clientId: query.clientId,
      merchantId: query.merchantId,
      canonicalCampaignId: query.canonicalCampaignId,
      campaignSourceId: query.campaignSourceId,
      country: query.country,
      supplier: query.supplier,
      from,
      to,
    };
  }

  async list(repo, filters, query, projector, cursorFields, orderBy) {
    const { page, pageSize, skip } = getPagination(query);
    const useCursor = Boolean(query.cursor);

    if (useCursor) {
      const cursor = decodeCursor(query.cursor, cursorFields);
      const options = { take: pageSize, cursor };
      if (orderBy) options.orderBy = orderBy;
      const { rows, hasMore } = await repo.findManyCursor(filters, options);
      const data = rows.map((row) => projector(row));
      const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1], cursorFields) : null;
      return toStandardPagedResponse({ rows: data, total: null, page: null, pageSize, nextCursor, hasMore });
    }

    const listOptions = { skip, take: pageSize };
    if (orderBy) listOptions.orderBy = orderBy;
    const { rows, total } = await repo.findMany(filters, listOptions);
    const data = rows.map((row) => projector(row));
    return toStandardPagedResponse({ rows: data, total, page, pageSize, hasMore: skip + rows.length < total });
  }
}
