import { prisma } from "../../../database/prisma.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

export class MerchantAliasRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.merchantAlias.findUnique({ where: { id } });
  }

  async findBySupplierAlias({ supplier, aliasValue }, client = null) {
    const db = resolveClient(client);
    return db.merchantAlias.findUnique({
      where: { aliasValue_supplier: { aliasValue, supplier } },
    });
  }

  async findByNormalizedAlias(normalizedAlias, { supplier, status } = {}, client = null) {
    const db = resolveClient(client);
    const where = { normalizedAlias };
    if (supplier) where.supplier = supplier;
    if (status) where.status = status;

    return db.merchantAlias.findMany({ where, orderBy: { confidence: "desc" } });
  }

  async findByMerchantId(merchantId, client = null) {
    const db = resolveClient(client);
    return db.merchantAlias.findMany({
      where: { merchantId },
      orderBy: [{ status: "asc" }, { aliasValue: "asc" }],
    });
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.merchantAlias.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.merchantAlias.update({ where: { id }, data });
  }

  async upsertBySupplierAlias({ supplier, aliasValue }, createData, updateData, client = null) {
    const db = resolveClient(client);
    return db.merchantAlias.upsert({
      where: { aliasValue_supplier: { aliasValue, supplier } },
      create: { supplier, aliasValue, ...createData },
      update: updateData,
    });
  }

  async reassignMerchant(fromMerchantId, toMerchantId, client = null) {
    const db = resolveClient(client);
    return db.merchantAlias.updateMany({
      where: { merchantId: fromMerchantId },
      data: { merchantId: toMerchantId, source: "MERGE" },
    });
  }
}
