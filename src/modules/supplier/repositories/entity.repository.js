import { prisma } from "../../../database/prisma.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

export class EntityRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.entity.findUnique({ where: { id } });
  }

  /**
   * One batch of the unbounded promotion walk, keyset by primary key alone.
   *
   * The walk used to order by [updatedAt asc, id asc] and position with a Prisma `cursor` plus
   * `skip: 1`. `updatedAt` is MUTATED by promotion itself, so a row promoted earlier in the same
   * walk re-sorted to the end of the ordering and the next batch resumed from the wrong place —
   * rows could be repeated or skipped. `id` is immutable, so `id > cursor` ordered `id asc` is a
   * stable total order over the rows this walk can see.
   *
   * `entityIds` and the cursor are both constraints on `id` and are merged into one filter rather
   * than spread over each other: an explicitly scoped walk must still page.
   */
  async findManyForPromotion(
    { entityTypes, networkSource, entityIds, batchSize, cursorId } = {},
    client = null,
  ) {
    const db = resolveClient(client);

    const idFilter = {
      ...(entityIds?.length ? { in: entityIds } : {}),
      ...(cursorId ? { gt: cursorId } : {}),
    };

    const where = {
      entityType: { in: entityTypes },
      ...(networkSource ? { networkSource } : {}),
      ...(Object.keys(idFilter).length ? { id: idFilter } : {}),
    };

    return db.entity.findMany({
      where,
      orderBy: { id: "asc" },
      take: batchSize,
    });
  }

  /**
   * How many entities a promotion walk of this scope would take.
   *
   * The same WHERE the walk uses, minus the cursor: a caller can therefore learn the size of the
   * work before starting it. A COUNT writes nothing, which is what lets an oversized request be
   * refused with the estate untouched.
   */
  async countForPromotion({ entityTypes, networkSource, entityIds } = {}, client = null) {
    const db = resolveClient(client);

    return db.entity.count({
      where: {
        entityType: { in: entityTypes },
        ...(networkSource ? { networkSource } : {}),
        ...(entityIds?.length ? { id: { in: entityIds } } : {}),
      },
    });
  }

  /**
   * One page of promotable entities for a DURABLE bounded unit: one type, one network, keyset by
   * primary key alone.
   *
   * The keyset shape matters most here, because a durable page resumes across two worker
   * invocations minutes apart: the cursor must not depend on a row still sorting where it did.
   * `id` is immutable, so `id > cursor` ordered `id asc` is a stable total order and pages neither
   * repeat nor skip a row. findManyForPromotion above pages the same way for the same reason.
   *
   * What still separates the two: this one takes exactly ONE entityType and takes no entityIds.
   * A durable page is defined by type, network and cursor, and nothing else.
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
