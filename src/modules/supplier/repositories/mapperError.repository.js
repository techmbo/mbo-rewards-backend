import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

const ENTITY_SUMMARY_SELECT = {
  id: true,
  externalId: true,
  networkSource: true,
  entityType: true,
};

export class MapperErrorRepository {
  async create(data, client = null) {
    const db = resolveClient(client);
    return db.mapperError.create({ data });
  }

  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.mapperError.findUnique({
      where: { id },
      include: { entity: { select: ENTITY_SUMMARY_SELECT } },
    });
  }

  async findByIds(ids = [], client = null) {
    const db = resolveClient(client);
    if (!ids.length) return [];

    return db.mapperError.findMany({
      where: { id: { in: ids } },
      orderBy: { createdAt: "asc" },
      include: { entity: { select: ENTITY_SUMMARY_SELECT } },
    });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = {};

    if (filters.status) where.status = filters.status;
    if (filters.supplier) where.supplier = filters.supplier;
    if (filters.entityType) where.entityType = filters.entityType;
    if (filters.entityId) where.entityId = filters.entityId;

    const [rows, total] = await Promise.all([
      db.mapperError.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: { entity: { select: ENTITY_SUMMARY_SELECT } },
      }),
      db.mapperError.count({ where }),
    ]);

    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.supplier ? { supplier: filters.supplier } : {}),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...buildCursorWhere(cursor, ["createdAt", "id"]),
    };

    const rows = await db.mapperError.findMany({
      where,
      take: take + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { entity: { select: ENTITY_SUMMARY_SELECT } },
    });

    return slicePage(rows, take);
  }

  async findOpenByEntityId(entityId, client = null) {
    const db = resolveClient(client);
    return db.mapperError.findFirst({
      where: { entityId, status: { in: ["OPEN", "RETRYING"] } },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateStatus(id, status, extra = {}, client = null) {
    const db = resolveClient(client);
    return db.mapperError.update({
      where: { id },
      data: {
        status,
        ...extra,
        ...(status === "RESOLVED" ? { resolvedAt: new Date() } : {}),
      },
    });
  }
}
