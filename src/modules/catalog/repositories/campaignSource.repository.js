import { prisma } from "../../../database/prisma.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

export class CampaignSourceRepository {
  async findById(id, { includeSupplierCampaign = false } = {}, client = null) {
    const db = resolveClient(client);
    return db.campaignSource.findUnique({
      where: { id },
      include: includeSupplierCampaign ? { supplierCampaign: true, canonicalCampaign: true } : undefined,
    });
  }

  async findByCampaignPair({ canonicalCampaignId, supplierCampaignId }, client = null) {
    const db = resolveClient(client);
    return db.campaignSource.findUnique({
      where: {
        canonicalCampaignId_supplierCampaignId: { canonicalCampaignId, supplierCampaignId },
      },
    });
  }

  async findBySupplierCampaignId(supplierCampaignId, client = null) {
    const db = resolveClient(client);
    return db.campaignSource.findMany({
      where: { supplierCampaignId },
      include: { canonicalCampaign: true },
    });
  }

  async findByCanonicalCampaignId(canonicalCampaignId, client = null) {
    const db = resolveClient(client);
    return db.campaignSource.findMany({
      where: { canonicalCampaignId },
      orderBy: [{ isPrimary: "desc" }, { priority: "asc" }, { createdAt: "asc" }],
      include: { supplierCampaign: true },
    });
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.campaignSource.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.campaignSource.update({ where: { id }, data });
  }

  async clearPrimaryForCampaign(canonicalCampaignId, exceptId = null, client = null) {
    const db = resolveClient(client);
    return db.campaignSource.updateMany({
      where: {
        canonicalCampaignId,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { isPrimary: false, status: "ACTIVE" },
    });
  }

  async deactivate(id, client = null) {
    const db = resolveClient(client);
    return db.campaignSource.update({
      where: { id },
      data: { isActive: false, isPrimary: false, status: "DEPRECATED" },
    });
  }
}
