import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

function buildWhere(filters = {}) {
  const where = { deletedAt: null };

  if (filters.status) where.status = filters.status;
  if (filters.verificationStatus) where.verificationStatus = filters.verificationStatus;
  if (filters.isVerified !== undefined) where.isVerified = filters.isVerified;
  if (filters.country) where.country = filters.country;
  if (filters.merchantId) where.id = filters.merchantId;
  if (filters.excludeMerged === true) where.status = { not: "MERGED" };

  if (filters.search) {
    const term = String(filters.search).trim();
    where.OR = [
      { displayName: { contains: term, mode: "insensitive" } },
      { normalizedName: { contains: term, mode: "insensitive" } },
      { slug: { contains: term, mode: "insensitive" } },
    ];
  }

  return where;
}

const ALIAS_INCLUDE = {
  aliases: {
    where: { status: "CONFIRMED" },
    orderBy: [{ source: "asc" }, { updatedAt: "desc" }],
  },
};

export class MerchantRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.merchant.findFirst({
      where: { id, deletedAt: null },
      include: ALIAS_INCLUDE,
    });
  }

  async findByNormalizedName(normalizedName, client = null) {
    const db = resolveClient(client);
    return db.merchant.findFirst({
      where: { normalizedName, deletedAt: null, status: { not: "MERGED" } },
    });
  }

  async findBySlug(slug, client = null) {
    const db = resolveClient(client);
    return db.merchant.findFirst({ where: { slug, deletedAt: null } });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildWhere(filters);

    const [rows, total] = await Promise.all([
      db.merchant.findMany({
        where,
        skip,
        take,
        orderBy: [{ displayName: "asc" }, { id: "asc" }],
        include: ALIAS_INCLUDE,
      }),
      db.merchant.count({ where }),
    ]);

    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildWhere(filters),
      ...buildCursorWhere(cursor, ["displayName", "id"]),
    };

    const rows = await db.merchant.findMany({
      where,
      take: take + 1,
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      include: ALIAS_INCLUDE,
    });

    return slicePage(rows, take);
  }

  async findByNormalizedNames(names = [], client = null) {
    const db = resolveClient(client);
    if (!names.length) return [];

    return db.merchant.findMany({
      where: {
        normalizedName: { in: names },
        deletedAt: null,
        status: { not: "MERGED" },
      },
    });
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.merchant.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.merchant.update({ where: { id }, data });
  }

  async softDelete(id, client = null) {
    const db = resolveClient(client);
    return db.merchant.update({
      where: { id },
      data: { deletedAt: new Date(), status: "ARCHIVED" },
    });
  }
}
