import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

function buildWhere(filters = {}) {
  const where = { deletedAt: null };

  if (filters.status) where.status = filters.status;
  if (filters.country) where.country = filters.country;
  if (filters.industry) where.industry = filters.industry;

  if (filters.search) {
    const term = String(filters.search).trim();
    where.OR = [
      { name: { contains: term, mode: "insensitive" } },
      { slug: { contains: term, mode: "insensitive" } },
    ];
  }

  return where;
}

export class ClientRepository {
  async findById(id, { includeRelations = false } = {}, client = null) {
    const db = resolveClient(client);
    return db.client.findFirst({
      where: { id, deletedAt: null },
      include: includeRelations
        ? {
            brandRequests: { orderBy: [{ requestedAt: "desc" }] },
            assignments: {
              orderBy: [{ createdAt: "desc" }],
              include: { canonicalCampaign: true },
            },
          }
        : undefined,
    });
  }

  async findBySlug(slug, client = null) {
    const db = resolveClient(client);
    return db.client.findFirst({ where: { slug, deletedAt: null } });
  }

  /** Uniqueness checks must include soft-deleted rows — slug is unique globally. */
  async findBySlugAny(slug, client = null) {
    const db = resolveClient(client);
    return db.client.findFirst({ where: { slug } });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildWhere(filters);

    const [rows, total] = await Promise.all([
      db.client.findMany({
        where,
        skip,
        take,
        orderBy: [{ name: "asc" }, { id: "asc" }],
      }),
      db.client.count({ where }),
    ]);

    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildWhere(filters),
      ...buildCursorWhere(cursor, ["name", "id"]),
    };

    const rows = await db.client.findMany({
      where,
      take: take + 1,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });

    return slicePage(rows, take);
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.client.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.client.update({ where: { id }, data });
  }

  async softDelete(id, client = null) {
    const db = resolveClient(client);
    const current = await db.client.findUnique({ where: { id } });
    if (!current) return null;

    // Free the public slug so a new client can reuse it after soft delete.
    const releasedSlug = `${current.slug}-deleted-${Date.now().toString(36)}`;

    return db.client.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: "OFFBOARDED",
        slug: releasedSlug,
      },
    });
  }
}
