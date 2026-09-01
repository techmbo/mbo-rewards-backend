import { prisma } from "../../../database/prisma.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

const SUPPLIER_SEEDS = [
  { key: "BOOSTINY", displayName: "Boostiny" },
  { key: "OPTIMISE", displayName: "Optimise" },
  { key: "TRACKIER", displayName: "Trackier" },
  { key: "PARTNERIZE", displayName: "Partnerize", status: "PLANNED" },
  { key: "IMPACT", displayName: "Impact", status: "PLANNED" },
];

export class SupplierRepository {
  async findAll({ status } = {}, client = null) {
    const db = resolveClient(client);
    return db.supplier.findMany({
      where: status ? { status } : undefined,
      orderBy: { displayName: "asc" },
    });
  }

  async findByKey(key, client = null) {
    const db = resolveClient(client);
    return db.supplier.findUnique({ where: { key } });
  }

  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.supplier.findUnique({ where: { id } });
  }

  async upsertSeeds(client = null) {
    const db = resolveClient(client);

    for (const seed of SUPPLIER_SEEDS) {
      await db.supplier.upsert({
        where: { key: seed.key },
        create: {
          key: seed.key,
          displayName: seed.displayName,
          status: seed.status ?? "ENABLED",
        },
        update: {},
      });
    }
  }
}
