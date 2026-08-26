import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

function buildWhere(filters = {}) {
  const where = { deletedAt: null };

  if (filters.merchantId) where.merchantId = filters.merchantId;
  if (filters.status) where.status = filters.status;
  if (filters.visibility) where.visibility = filters.visibility;
  if (filters.category) where.category = filters.category;
  if (filters.country) where.countries = { has: filters.country };

  if (filters.search) {
    const term = String(filters.search).trim();
    where.displayName = { contains: term, mode: "insensitive" };
  }

  if (filters.supplier || filters.joined !== undefined || filters.supportsCoupon !== undefined || filters.supportsLink !== undefined) {
    where.sources = { some: {} };
    const sourceWhere = where.sources.some;

    if (filters.supplier) {
      sourceWhere.supplierCampaign = { supplier: filters.supplier };
    }
    if (filters.joined === true) {
      sourceWhere.relationshipStatus = "JOINED";
      sourceWhere.isActive = true;
    }
    if (filters.joined === false) {
      sourceWhere.relationshipStatus = { not: "JOINED" };
    }
    if (filters.supportsCoupon === true) sourceWhere.supportsCoupon = true;
    if (filters.supportsLink === true) sourceWhere.supportsLink = true;
  }

  return where;
}

export class CatalogRepository {
  async findById(id, { includeSources = false } = {}, client = null) {
    const db = resolveClient(client);
    return db.canonicalCampaign.findFirst({
      where: { id, deletedAt: null },
      include: includeSources
        ? {
            sources: {
              orderBy: [{ isPrimary: "desc" }, { priority: "asc" }, { createdAt: "asc" }],
              include: { supplierCampaign: true },
            },
          }
        : undefined,
    });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildWhere(filters);

    const [rows, total] = await Promise.all([
      db.canonicalCampaign.findMany({
        where,
        skip,
        take,
        orderBy: [{ displayName: "asc" }, { id: "asc" }],
      }),
      db.canonicalCampaign.count({ where }),
    ]);

    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildWhere(filters),
      ...buildCursorWhere(cursor, ["displayName", "id"]),
    };

    const rows = await db.canonicalCampaign.findMany({
      where,
      take: take + 1,
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    });

    return slicePage(rows, take);
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.canonicalCampaign.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.canonicalCampaign.update({ where: { id }, data });
  }

  async softDelete(id, client = null) {
    const db = resolveClient(client);
    return db.canonicalCampaign.update({
      where: { id },
      data: { deletedAt: new Date(), status: "ARCHIVED" },
    });
  }
}
