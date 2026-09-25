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

  /**
   * The rows an AUTOMATIC retry may work: every OPEN row, plus RETRYING rows whose lease has
   * expired. A RETRYING row with a null lease was left by code that predates the lease column
   * and is treated as stale, so it can be reclaimed instead of being skipped forever.
   *
   * Selection only. Nothing is written here: each row is then claimed one at a time by
   * `claimForRetry`, so a row another process claims in between is simply not ours.
   */
  async findRetryTargets({ staleBefore, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    return db.mapperError.findMany({
      where: {
        OR: [{ status: "OPEN" }, { status: "RETRYING", ...staleLeaseWhere(staleBefore) }],
      },
      take,
      orderBy: { createdAt: "desc" },
      include: { entity: { select: ENTITY_SUMMARY_SELECT } },
    });
  }

  /**
   * Conditionally take a row for one retry attempt. Returns true only when THIS call moved it.
   *
   *   from "OPEN"                     OPEN -> RETRYING, lease set, resolvedAt cleared
   *   from "RETRYING" + staleBefore   stale RETRYING (lease older than staleBefore, or null)
   *                                   stays RETRYING, lease refreshed
   *   from "RETRYING", no staleBefore an explicit operator override of any RETRYING row,
   *                                   lease refreshed
   *
   * `updateMany` with the status in the predicate is the compare-and-set: two callers racing for
   * the same OPEN row both issue it, exactly one sees count 1. Nothing else is ever claimable, so
   * RESOLVED and DISCARDED cannot re-enter the retry path through this method.
   */
  async claimForRetry(id, { from = "OPEN", now = new Date(), staleBefore = null } = {}, client = null) {
    const db = resolveClient(client);
    if (from !== "OPEN" && from !== "RETRYING") return false;

    const where = { id, status: from };
    if (from === "RETRYING" && staleBefore) Object.assign(where, staleLeaseWhere(staleBefore));

    const data =
      from === "OPEN"
        ? { status: "RETRYING", retryStartedAt: now, resolvedAt: null }
        : { retryStartedAt: now };

    const { count } = await db.mapperError.updateMany({ where, data });
    return count === 1;
  }

  /**
   * Conditionally end a retry attempt: RETRYING -> RESOLVED | OPEN | DISCARDED, lease cleared.
   *
   * Only a row that is STILL RETRYING is written. Returns false when it is not, which is a normal
   * outcome rather than an error: the promotion service resolves or reopens the active mapper
   * error itself before the job gets here, and a concurrent writer may have moved it too. A
   * conditional write never overwrites a status somebody else already set.
   */
  async finishRetry(id, status, extra = {}, client = null) {
    const db = resolveClient(client);
    if (!FINISH_STATUSES.has(status)) return false;

    const data = { ...extra, status, retryStartedAt: null };
    if (status === "RESOLVED") data.resolvedAt = new Date();
    if (status === "OPEN") data.resolvedAt = null;

    const { count } = await db.mapperError.updateMany({
      where: { id, status: "RETRYING" },
      data,
    });
    return count === 1;
  }
}

const FINISH_STATUSES = new Set(["RESOLVED", "OPEN", "DISCARDED"]);

/** RETRYING rows whose lease is older than `staleBefore`, or that never had one. */
function staleLeaseWhere(staleBefore) {
  return { OR: [{ retryStartedAt: { lt: staleBefore } }, { retryStartedAt: null }] };
}
