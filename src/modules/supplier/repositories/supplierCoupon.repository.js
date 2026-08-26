import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

function buildWhere(filters = {}) {
  const where = {};

  if (filters.supplierCampaignId) where.supplierCampaignId = filters.supplierCampaignId;
  if (filters.couponType) where.couponType = filters.couponType;
  if (filters.couponStatus) where.couponStatus = filters.couponStatus;
  if (filters.entityId) where.entityId = filters.entityId;

  if (filters.search) {
    const term = String(filters.search).trim();
    where.OR = [
      { couponCode: { contains: term, mode: "insensitive" } },
      { couponDescription: { contains: term, mode: "insensitive" } },
      { supplierCouponId: { contains: term, mode: "insensitive" } },
    ];
  }

  return where;
}

const CAMPAIGN_SUMMARY_SELECT = {
  id: true,
  supplier: true,
  supplierRegion: true,
  supplierCampaignId: true,
  campaignName: true,
  merchantNameRaw: true,
  campaignStatus: true,
};

export class SupplierCouponRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.supplierCoupon.findUnique({
      where: { id },
      include: { supplierCampaign: { select: CAMPAIGN_SUMMARY_SELECT } },
    });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildWhere(filters);

    const [rows, total] = await Promise.all([
      db.supplierCoupon.findMany({
        where,
        skip,
        take,
        orderBy: [{ lastSyncedAt: "desc" }, { id: "desc" }],
        include: { supplierCampaign: { select: CAMPAIGN_SUMMARY_SELECT } },
      }),
      db.supplierCoupon.count({ where }),
    ]);

    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildWhere(filters),
      ...buildCursorWhere(cursor, ["lastSyncedAt", "id"]),
    };

    const rows = await db.supplierCoupon.findMany({
      where,
      take: take + 1,
      orderBy: [{ lastSyncedAt: "desc" }, { id: "desc" }],
      include: { supplierCampaign: { select: CAMPAIGN_SUMMARY_SELECT } },
    });

    return slicePage(rows, take);
  }

  async findByNaturalKey({ supplierCampaignId, couponType, couponCode, couponLink }, client = null) {
    const db = resolveClient(client);

    if (couponType === "CODE" && couponCode) {
      return db.supplierCoupon.findFirst({
        where: { supplierCampaignId, couponType: "CODE", couponCode },
      });
    }

    if (couponType === "LINK" && couponLink) {
      return db.supplierCoupon.findFirst({
        where: { supplierCampaignId, couponType: "LINK", couponLink },
      });
    }

    return null;
  }

  async findByEntityId(entityId, client = null) {
    const db = resolveClient(client);
    return db.supplierCoupon.findFirst({ where: { entityId } });
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.supplierCoupon.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.supplierCoupon.update({ where: { id }, data });
  }

  async upsertNaturalKey(
    { supplierCampaignId, couponType, couponCode, couponLink },
    createData,
    updateData,
    client = null,
  ) {
    const db = resolveClient(client);
    const existing = await this.findByNaturalKey(
      { supplierCampaignId, couponType, couponCode, couponLink },
      db,
    );

    if (existing) {
      return db.supplierCoupon.update({ where: { id: existing.id }, data: updateData });
    }

    try {
      return await db.supplierCoupon.create({ data: createData });
    } catch (error) {
      const retry = await this.findByNaturalKey(
        { supplierCampaignId, couponType, couponCode, couponLink },
        db,
      );
      if (!retry) throw error;
      return db.supplierCoupon.update({ where: { id: retry.id }, data: updateData });
    }
  }
}
