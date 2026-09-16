import { prisma } from "../../../database/prisma.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

export class EntityRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.entity.findUnique({ where: { id } });
  }

  async findManyForPromotion(
    { entityTypes, networkSource, entityIds, batchSize, cursorId } = {},
    client = null,
  ) {
    const db = resolveClient(client);

    const where = {
      entityType: { in: entityTypes },
      ...(networkSource ? { networkSource } : {}),
      ...(entityIds?.length ? { id: { in: entityIds } } : {}),
    };

    return db.entity.findMany({
      where,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: batchSize,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });
  }

  /**
   * One page of promotable entities for a DURABLE bounded unit: one type, one network, keyset by
   * primary key alone.
   *
   * This deliberately differs from findManyForPromotion above, which orders by
   * [updatedAt asc, id asc] and positions with a Prisma `cursor` plus `skip: 1`. That shape needs
   * the cursor ROW to still exist and to still sort where it did, so a row re-staged between two
   * pages moves to the end of the ordering and the next page resumes from the wrong place. Inside
   * one uninterrupted call that is survivable; across two worker invocations minutes apart it is
   * not. `id` is immutable, so `id > cursor` ordered `id asc` is a stable total order and pages
   * neither repeat nor skip a row.
   *
   * There is no entityIds and no date filter here: the page is defined by type, network and
   * cursor, and nothing else.
   */
  async findPageForPromotion({ entityType, networkSource, batchSize, cursorId } = {}, client = null) {
    const db = resolveClient(client);

    return db.entity.findMany({
      where: {
        entityType,
        ...(networkSource ? { networkSource } : {}),
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      orderBy: { id: "asc" },
      take: batchSize,
    });
  }
}
