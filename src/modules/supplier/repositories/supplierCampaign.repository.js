import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

export const SUPPLIER_CAMPAIGN_MASTER_INCLUDE = {
  merchant: {
    select: {
      id: true,
      displayName: true,
      logoUrl: true,
      website: true,
      category: true,
      country: true,
      status: true,
      isVerified: true,
    },
  },
  coupons: {
    where: { couponStatus: { in: ["ACTIVE", "SCHEDULED", "UNKNOWN"] } },
    orderBy: [{ couponStatus: "asc" }, { lastSyncedAt: "desc" }],
    take: 3,
    select: {
      id: true,
      couponCode: true,
      couponEndDate: true,
      discountValue: true,
      couponDescription: true,
      couponType: true,
    },
  },
  campaignSources: {
    where: { isActive: true },
    orderBy: [{ isPrimary: "desc" }, { priority: "asc" }],
    include: {
      supplierCampaign: {
        select: {
          id: true,
          supplier: true,
          supplierRegion: true,
          campaignName: true,
          merchantNameRaw: true,
          campaignStatus: true,
        },
      },
      _count: {
        select: {
          assignments: true,
          products: true,
          productFeeds: true,
        },
      },
    },
  },
};

function buildWhere(filters = {}) {
  const where = {};

  if (filters.supplier) where.supplier = filters.supplier;
  if (filters.supplierRegion) where.supplierRegion = filters.supplierRegion;
  if (filters.sourceAccountLabel) where.sourceAccountLabel = filters.sourceAccountLabel;
  if (filters.campaignStatus) where.campaignStatus = filters.campaignStatus;
  if (filters.participationStatus) where.participationStatus = filters.participationStatus;
  if (filters.entityId) where.entityId = filters.entityId;
  if (filters.includeArchived !== true) where.archivedAt = null;

  if (filters.merchantId) where.merchantId = filters.merchantId;
  if (filters.brandKey) {
    const key = String(filters.brandKey).trim();
    if (key.startsWith("raw:")) {
      const raw = key.slice(4);
      where.merchantId = null;
      where.OR = [
        { merchantNameRaw: { equals: raw, mode: "insensitive" } },
        ...(filters.search
          ? []
          : [{ merchantNameRaw: { contains: raw, mode: "insensitive" } }]),
      ];
    } else if (key) {
      where.merchantId = key;
    }
  }

  if (filters.search) {
    const term = String(filters.search).trim();
    const searchOr = [
      { campaignName: { contains: term, mode: "insensitive" } },
      { merchantNameRaw: { contains: term, mode: "insensitive" } },
      { supplierCampaignId: { contains: term, mode: "insensitive" } },
      { merchant: { displayName: { contains: term, mode: "insensitive" } } },
    ];
    if (where.OR) {
      where.AND = [{ OR: where.OR }, { OR: searchOr }];
      delete where.OR;
    } else {
      where.OR = searchOr;
    }
  }

  return where;
}

export class SupplierCampaignRepository {
  async findByBusinessKey(
    { supplier, supplierRegion, sourceAccountLabel, supplierCampaignId },
    client = null,
  ) {
    const db = resolveClient(client);
    return db.supplierCampaign.findUnique({
      where: {
        supplier_supplierRegion_sourceAccountLabel_supplierCampaignId: {
          supplier,
          supplierRegion,
          sourceAccountLabel,
          supplierCampaignId,
        },
      },
    });
  }

  /** Fallback when network coupon payloads omit campaign id (e.g. Boostiny). */
  async findByCampaignName(
    { supplier, supplierRegion, sourceAccountLabel, campaignName },
    client = null,
  ) {
    const db = resolveClient(client);
    const name = String(campaignName ?? "").trim();
    if (!name) return null;

    const where = {
      supplier,
      campaignName: { equals: name, mode: "insensitive" },
      archivedAt: null,
    };
    if (supplierRegion != null) where.supplierRegion = supplierRegion;
    if (sourceAccountLabel != null) where.sourceAccountLabel = sourceAccountLabel;

    return db.supplierCampaign.findFirst({
      where,
      orderBy: { lastSyncedAt: "desc" },
    });
  }

  async findById(id, clientOrOptions = null, maybeClient = null) {
    let includeMaster = false;
    let client = null;
    if (
      clientOrOptions &&
      typeof clientOrOptions === "object" &&
      Object.prototype.hasOwnProperty.call(clientOrOptions, "includeMaster")
    ) {
      includeMaster = Boolean(clientOrOptions.includeMaster);
      client = maybeClient;
    } else {
      client = clientOrOptions;
    }
    const db = resolveClient(client);
    return db.supplierCampaign.findUnique({
      where: { id },
      include: includeMaster ? SUPPLIER_CAMPAIGN_MASTER_INCLUDE : undefined,
    });
  }

  async findMany(filters = {}, { skip = 0, take = 20, includeMaster = false } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildWhere(filters);

    const [rows, total] = await Promise.all([
      db.supplierCampaign.findMany({
        where,
        skip,
        take,
        orderBy: [{ lastSyncedAt: "desc" }, { id: "desc" }],
        include: includeMaster ? SUPPLIER_CAMPAIGN_MASTER_INCLUDE : undefined,
      }),
      db.supplierCampaign.count({ where }),
    ]);

    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildWhere(filters),
      ...buildCursorWhere(cursor, ["lastSyncedAt", "id"]),
    };

    const rows = await db.supplierCampaign.findMany({
      where,
      take: take + 1,
      orderBy: [{ lastSyncedAt: "desc" }, { id: "desc" }],
    });

    return slicePage(rows, take);
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.supplierCampaign.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.supplierCampaign.update({ where: { id }, data });
  }

  async upsertByBusinessKey(businessKey, createData, updateData, client = null) {
    const db = resolveClient(client);
    return db.supplierCampaign.upsert({
      where: {
        supplier_supplierRegion_sourceAccountLabel_supplierCampaignId: businessKey,
      },
      create: { ...businessKey, ...createData },
      update: updateData,
    });
  }

  async linkMerchant(id, { merchantId, matchedAt, matchedBy, matchConfidence }, client = null) {
    const db = resolveClient(client);
    return db.supplierCampaign.update({
      where: { id },
      data: {
        merchantId,
        matchedAt: matchedAt ?? new Date(),
        matchedBy: matchedBy ?? null,
        matchConfidence: matchConfidence ?? null,
      },
    });
  }

  async findUnmatchedForMatching({ supplierCampaignIds, batchSize = 100, supplier } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      merchantId: null,
      merchantNameRaw: { not: null },
      archivedAt: null,
    };

    if (supplier) where.supplier = supplier;
    if (supplierCampaignIds?.length) where.id = { in: supplierCampaignIds };

    return db.supplierCampaign.findMany({
      where,
      take: batchSize,
      orderBy: [{ lastSyncedAt: "desc" }, { id: "desc" }],
    });
  }
}
