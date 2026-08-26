import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

function buildWhere(filters = {}) {
  const where = {};

  if (filters.clientId) where.clientId = filters.clientId;
  if (filters.merchantId) where.merchantId = filters.merchantId;
  if (filters.status) where.status = filters.status;

  if (filters.search) {
    const term = String(filters.search).trim();
    where.requestedBrandName = { contains: term, mode: "insensitive" };
  }

  return where;
}

export class ClientBrandRequestRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.clientBrandRequest.findUnique({
      where: { id },
      include: { client: true, merchant: true },
    });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildWhere(filters);

    const [rows, total] = await Promise.all([
      db.clientBrandRequest.findMany({
        where,
        skip,
        take,
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        include: { client: true, merchant: true },
      }),
      db.clientBrandRequest.count({ where }),
    ]);

    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildWhere(filters),
      ...buildCursorWhere(cursor, ["requestedAt", "id"]),
    };

    const rows = await db.clientBrandRequest.findMany({
      where,
      take: take + 1,
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      include: { client: true, merchant: true },
    });

    return slicePage(rows, take);
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.clientBrandRequest.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.clientBrandRequest.update({ where: { id }, data });
  }
}
