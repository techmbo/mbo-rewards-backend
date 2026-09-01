import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

function buildClickWhere(filters = {}) {
  const where = {};
  if (filters.trackingLinkId) where.trackingLinkId = filters.trackingLinkId;
  if (filters.clientAssignmentId) where.clientAssignmentId = filters.clientAssignmentId;
  if (filters.campaignSourceId) where.campaignSourceId = filters.campaignSourceId;
  if (filters.subId) where.subId = filters.subId;
  if (filters.country) where.country = filters.country;
  if (filters.from || filters.to) {
    where.clickedAt = {};
    if (filters.from) where.clickedAt.gte = filters.from;
    if (filters.to) where.clickedAt.lte = filters.to;
  }
  return where;
}

function buildConversionWhere(filters = {}) {
  const where = {};
  if (filters.trackingLinkId) where.trackingLinkId = filters.trackingLinkId;
  if (filters.clientAssignmentId) where.clientAssignmentId = filters.clientAssignmentId;
  if (filters.campaignSourceId) where.campaignSourceId = filters.campaignSourceId;
  if (filters.status) where.status = filters.status;
  if (filters.attributionStatus) where.attributionStatus = filters.attributionStatus;
  if (filters.supplier) where.supplier = filters.supplier;
  if (filters.from || filters.to) {
    where.conversionDate = {};
    if (filters.from) where.conversionDate.gte = filters.from;
    if (filters.to) where.conversionDate.lte = filters.to;
  }
  return where;
}

function buildDailyReportWhere(filters = {}) {
  const where = {};
  if (filters.clientId) where.clientId = filters.clientId;
  if (filters.merchantId) where.merchantId = filters.merchantId;
  if (filters.canonicalCampaignId) where.canonicalCampaignId = filters.canonicalCampaignId;
  if (filters.campaignSourceId) where.campaignSourceId = filters.campaignSourceId;
  if (filters.country) where.country = filters.country;
  if (filters.from || filters.to) {
    where.reportDate = {};
    if (filters.from) where.reportDate.gte = filters.from;
    if (filters.to) where.reportDate.lte = filters.to;
  }
  return where;
}

const CLICK_LIST_INCLUDE = {
  trackingLink: {
    select: {
      id: true,
      slug: true,
      subId: true,
      mboTrackingUrl: true,
      campaignSource: {
        select: {
          id: true,
          supplierCampaign: {
            select: {
              supplier: true,
              campaignName: true,
              merchantNameRaw: true,
            },
          },
        },
      },
    },
  },
  clientAssignment: {
    select: {
      id: true,
      clientId: true,
      client: { select: { id: true, name: true, slug: true } },
      canonicalCampaign: {
        select: {
          id: true,
          displayName: true,
          merchant: { select: { id: true, displayName: true } },
        },
      },
    },
  },
  campaignSource: {
    select: {
      id: true,
      supplierCampaign: {
        select: {
          supplier: true,
          campaignName: true,
          merchantNameRaw: true,
        },
      },
    },
  },
};

export class ClickRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.click.findUnique({ where: { id }, include: CLICK_LIST_INCLUDE });
  }

  async findBySubId(subId, { from, to } = {}, client = null) {
    const db = resolveClient(client);
    return db.click.findFirst({
      where: {
        subId,
        ...(from || to
          ? {
              clickedAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { clickedAt: "desc" },
      include: CLICK_LIST_INCLUDE,
    });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildClickWhere(filters);
    const [rows, total] = await Promise.all([
      db.click.findMany({
        where,
        skip,
        take,
        orderBy: [{ clickedAt: "desc" }, { id: "desc" }],
        include: CLICK_LIST_INCLUDE,
      }),
      db.click.count({ where }),
    ]);
    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildClickWhere(filters),
      ...buildCursorWhere(cursor, ["clickedAt", "id"]),
    };
    const rows = await db.click.findMany({
      where,
      take: take + 1,
      orderBy: [{ clickedAt: "desc" }, { id: "desc" }],
      include: CLICK_LIST_INCLUDE,
    });
    return slicePage(rows, take);
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.click.create({ data });
  }

  async countForAggregation({ from, to, clientAssignmentId } = {}, client = null) {
    const db = resolveClient(client);
    return db.click.groupBy({
      by: ["clientAssignmentId", "campaignSourceId", "country"],
      where: buildClickWhere({ from, to, clientAssignmentId }),
      _count: { _all: true },
    });
  }
}

export class ConversionRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.conversion.findUnique({ where: { id } });
  }

  async findBySupplierKey({ supplier, supplierConversionId, sourceAccountLabel }, client = null) {
    const db = resolveClient(client);
    return db.conversion.findUnique({
      where: {
        supplier_supplierConversionId_sourceAccountLabel: {
          supplier,
          supplierConversionId,
          sourceAccountLabel: sourceAccountLabel ?? "default",
        },
      },
    });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildConversionWhere(filters);
    const [rows, total] = await Promise.all([
      db.conversion.findMany({
        where,
        skip,
        take,
        orderBy: [{ conversionDate: "desc" }, { id: "desc" }],
      }),
      db.conversion.count({ where }),
    ]);
    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildConversionWhere(filters),
      ...buildCursorWhere(cursor, ["conversionDate", "id"]),
    };
    const rows = await db.conversion.findMany({
      where,
      take: take + 1,
      orderBy: [{ conversionDate: "desc" }, { id: "desc" }],
    });
    return slicePage(rows, take);
  }

  async findPendingAttribution({ take = 100 } = {}, client = null) {
    const db = resolveClient(client);
    return db.conversion.findMany({
      where: { attributionStatus: { in: ["PENDING", "ORPHAN"] } },
      take,
      orderBy: { conversionDate: "asc" },
    });
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.conversion.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.conversion.update({ where: { id }, data });
  }

  async findForAggregation({ from, to, clientAssignmentId } = {}, client = null) {
    const db = resolveClient(client);
    return db.conversion.findMany({
      where: {
        ...buildConversionWhere({ from, to, clientAssignmentId }),
        attributionStatus: "ATTRIBUTED",
        clientAssignmentId: { not: null },
      },
      select: {
        id: true,
        clientAssignmentId: true,
        campaignSourceId: true,
        status: true,
        supplierCommission: true,
        approvedCommission: true,
        clientCommission: true,
        mboCommission: true,
        currency: true,
        conversionDate: true,
        metadata: true,
        clientAssignment: {
          select: {
            clientId: true,
            canonicalCampaignId: true,
            canonicalCampaign: { select: { merchantId: true } },
          },
        },
      },
    });
  }
}

export class DailyReportRepository {
  async findMany(filters = {}, { skip = 0, take = 20, orderBy = [{ reportDate: "desc" }] } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildDailyReportWhere(filters);
    const [rows, total] = await Promise.all([
      db.dailyReport.findMany({ where, skip, take, orderBy }),
      db.dailyReport.count({ where }),
    ]);
    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null, orderBy = [{ reportDate: "desc" }, { id: "desc" }] } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildDailyReportWhere(filters),
      ...buildCursorWhere(cursor, ["reportDate", "id"]),
    };
    const rows = await db.dailyReport.findMany({ where, take: take + 1, orderBy });
    return slicePage(rows, take);
  }

  async findByDimensionKey({ clientId, canonicalCampaignId, campaignSourceId, country, reportDate }, client = null) {
    const db = resolveClient(client);
    return db.dailyReport.findFirst({
      where: {
        clientId,
        canonicalCampaignId,
        campaignSourceId: campaignSourceId ?? null,
        country: country ?? null,
        reportDate,
      },
    });
  }

  async upsertDimension(row, client = null) {
    const db = resolveClient(client);
    const existing = await this.findByDimensionKey(row, db);
    if (existing) {
      return db.dailyReport.update({
        where: { id: existing.id },
        data: {
          clickCount: row.clickCount,
          conversionCount: row.conversionCount,
          approvedConversionCount: row.approvedConversionCount,
          grossCommission: row.grossCommission,
          clientCommission: row.clientCommission,
          mboCommission: row.mboCommission,
          conversionRate: row.conversionRate,
          epc: row.epc,
          ctr: row.ctr,
          currency: row.currency,
        },
      });
    }
    return db.dailyReport.create({ data: row });
  }

  async deleteForDateRange({ from, to, clientId } = {}, client = null) {
    const db = resolveClient(client);
    return db.dailyReport.deleteMany({
      where: buildDailyReportWhere({ from, to, clientId }),
    });
  }

  async aggregateByClient(filters = {}, client = null) {
    const db = resolveClient(client);
    return db.dailyReport.groupBy({
      by: ["clientId"],
      where: buildDailyReportWhere(filters),
      _sum: {
        clickCount: true,
        conversionCount: true,
        approvedConversionCount: true,
        grossCommission: true,
        clientCommission: true,
        mboCommission: true,
      },
    });
  }

  async aggregateByMerchant(filters = {}, client = null) {
    const db = resolveClient(client);
    return db.dailyReport.groupBy({
      by: ["merchantId"],
      where: buildDailyReportWhere(filters),
      _sum: {
        clickCount: true,
        conversionCount: true,
        approvedConversionCount: true,
        grossCommission: true,
        clientCommission: true,
        mboCommission: true,
      },
    });
  }

  async aggregateByCampaign(filters = {}, client = null) {
    const db = resolveClient(client);
    return db.dailyReport.groupBy({
      by: ["canonicalCampaignId"],
      where: buildDailyReportWhere(filters),
      _sum: {
        clickCount: true,
        conversionCount: true,
        approvedConversionCount: true,
        grossCommission: true,
        clientCommission: true,
        mboCommission: true,
      },
    });
  }

  async aggregateBySource(filters = {}, client = null) {
    const db = resolveClient(client);
    return db.dailyReport.groupBy({
      by: ["campaignSourceId"],
      where: buildDailyReportWhere(filters),
      _sum: {
        clickCount: true,
        conversionCount: true,
        approvedConversionCount: true,
        grossCommission: true,
        clientCommission: true,
        mboCommission: true,
      },
    });
  }
}
