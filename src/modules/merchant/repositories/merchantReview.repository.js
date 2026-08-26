import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

function buildWhere(filters = {}) {
  const where = {};

  if (filters.status) where.status = filters.status;
  if (filters.supplier) where.supplier = filters.supplier;
  if (filters.merchantId) where.merchantId = filters.merchantId;
  if (filters.supplierCampaignId) where.supplierCampaignId = filters.supplierCampaignId;

  if (filters.search) {
    const term = String(filters.search).trim();
    where.merchantNameRaw = { contains: term, mode: "insensitive" };
  }

  return where;
}

export class MerchantReviewRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.merchantReview.findUnique({ where: { id } });
  }

  async findBySupplierCampaignId(supplierCampaignId, client = null) {
    const db = resolveClient(client);
    return db.merchantReview.findUnique({ where: { supplierCampaignId } });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildWhere(filters);

    const [rows, total] = await Promise.all([
      db.merchantReview.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      db.merchantReview.count({ where }),
    ]);

    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildWhere(filters),
      ...buildCursorWhere(cursor, ["createdAt", "id"]),
    };

    const rows = await db.merchantReview.findMany({
      where,
      take: take + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });

    return slicePage(rows, take);
  }

  async upsertBySupplierCampaignId(supplierCampaignId, createData, updateData, client = null) {
    const db = resolveClient(client);
    return db.merchantReview.upsert({
      where: { supplierCampaignId },
      create: { supplierCampaignId, ...createData },
      update: updateData,
    });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.merchantReview.update({ where: { id }, data });
  }
}
