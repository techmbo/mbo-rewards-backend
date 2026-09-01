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
}
