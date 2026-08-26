import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";
import { ACTIVE_ASSIGNMENT_STATUSES } from "../constants.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

/** Eager-load graph for partner campaign projection — avoids N+1. */
export const PARTNER_CAMPAIGN_INCLUDE = {
  canonicalCampaign: { include: { merchant: true } },
  campaignSource: {
    include: {
      supplierCampaign: {
        select: {
          campaignName: true,
          campaignDescription: true,
          deepLinkingEnabled: true,
          campaignType: true,
          pricingModel: true,
          campaignStatus: true,
          campaignLogoUrl: true,
          destinationUrl: true,
          merchantNameRaw: true,
          countryCodes: true,
          campaignStartDate: true,
        },
      },
    },
  },
  trackingLinks: {
    where: { deletedAt: null, status: { in: ["GENERATED", "ACTIVE"] } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
  },
  couponAssignments: {
    where: { status: { in: ["ASSIGNED", "ACTIVE"] } },
    orderBy: [{ createdAt: "desc" }],
  },
  commissionRules: {
    where: { status: { in: ["DRAFT", "EFFECTIVE"] } },
    orderBy: [{ effectiveFrom: "desc" }],
  },
};

/** Staff assignment list include — suppliers + coupon/campaign links for order metrics. */
export const ASSIGNMENT_LIST_INCLUDE = {
  canonicalCampaign: {
    include: {
      merchant: true,
      sources: {
        where: { isActive: true },
        include: {
          supplierCampaign: { include: { supplierRef: true } },
        },
      },
    },
  },
  client: true,
  campaignSource: {
    include: {
      supplierCampaign: { include: { supplierRef: true } },
    },
  },
  trackingLinks: {
    where: { deletedAt: null },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
    take: 5,
  },
  commissionRules: {
    where: { status: { in: ["DRAFT", "EFFECTIVE"] } },
    orderBy: [{ effectiveFrom: "desc" }],
    take: 5,
  },
  couponAssignments: {
    where: { status: { in: ["ASSIGNED", "ACTIVE"] } },
    include: {
      supplierCoupon: {
        include: {
          supplierCampaign: { include: { supplierRef: true } },
          entity: { select: { rawData: true, networkSource: true } },
        },
      },
    },
  },
};

function buildWhere(filters = {}) {
  const where = {};

  if (filters.clientId) where.clientId = filters.clientId;
  if (filters.canonicalCampaignId) where.canonicalCampaignId = filters.canonicalCampaignId;
  if (filters.status) where.status = filters.status;
  if (filters.published === true) where.published = true;
  if (filters.published === false) where.published = false;

  if (filters.visibleToClient === true) {
    where.published = true;
    where.status = "ACTIVE";
    where.canonicalCampaign = {
      status: "PUBLISHED",
      visibility: { not: "HIDDEN" },
      deletedAt: null,
    };
    where.client = { status: "ACTIVE", deletedAt: null };
  }

  const network = filters.networkSource || filters.network || null;
  if (network) {
    const net = String(network).toUpperCase();
    where.campaignSource = {
      supplierCampaign: {
        supplier: net,
      },
    };
  }

  const search = filters.search || filters.q || null;
  if (search && String(search).trim()) {
    const term = String(search).trim();
    where.AND = [
      ...(where.AND ?? []),
      {
        OR: [
          { client: { name: { contains: term, mode: "insensitive" } } },
          { canonicalCampaign: { displayName: { contains: term, mode: "insensitive" } } },
          {
            canonicalCampaign: {
              merchant: { displayName: { contains: term, mode: "insensitive" } },
            },
          },
        ],
      },
    ];
  }

  return where;
}

/**
 * Tenant-scoped partner listing filters.
 * Always requires clientId. Defaults to ACTIVE assignments; REVOKED is never listed.
 */
function buildPartnerWhere(filters = {}) {
  if (!filters.clientId) {
    throw new Error("Partner assignment queries require clientId.");
  }

  const campaignWhere = {
    deletedAt: null,
    status: "PUBLISHED",
    visibility: { not: "HIDDEN" },
  };

  if (filters.includeInactive === true) {
    campaignWhere.status = { not: "ARCHIVED" };
  }

  if (filters.category) {
    campaignWhere.category = { equals: filters.category, mode: "insensitive" };
  }
  if (filters.country) {
    campaignWhere.countries = { has: String(filters.country).toUpperCase() };
  }
  if (filters.brand) {
    campaignWhere.merchant = {
      displayName: { contains: String(filters.brand).trim(), mode: "insensitive" },
    };
  }

  const where = {
    clientId: filters.clientId,
    canonicalCampaign: campaignWhere,
  };

  if (filters.status) {
    where.status = filters.status;
  } else if (filters.includeInactive === true) {
    where.status = { in: ACTIVE_ASSIGNMENT_STATUSES };
  } else {
    where.status = "ACTIVE";
  }

  // Default partner catalog = published ACTIVE grants (portal + API parity).
  if (filters.published === true) where.published = true;
  else if (filters.published === false) where.published = false;
  else if (filters.requirePublished !== false && filters.includeInactive !== true) {
    where.published = true;
  }

  if (filters.search) {
    const term = String(filters.search).trim();
    if (term) {
      where.AND = [
        ...(where.AND ?? []),
        {
          OR: [
            { canonicalCampaign: { displayName: { contains: term, mode: "insensitive" } } },
            { canonicalCampaign: { category: { contains: term, mode: "insensitive" } } },
            { canonicalCampaign: { merchant: { displayName: { contains: term, mode: "insensitive" } } } },
            {
              couponAssignments: {
                some: {
                  clientCouponCode: { contains: term, mode: "insensitive" },
                  status: { in: ["ASSIGNED", "ACTIVE"] },
                },
              },
            },
          ],
        },
      ];
    }
  }

  return where;
}

export class ClientCampaignAssignmentRepository {
  async findById(
    id,
    { includeCampaign = false, includeClient = false, includeSource = false } = {},
    client = null,
  ) {
    const db = resolveClient(client);
    return db.clientCampaignAssignment.findUnique({
      where: { id },
      include: {
        canonicalCampaign: includeCampaign ? { include: { merchant: true } } : false,
        client: includeClient,
        campaignSource: includeSource
          ? {
              include: {
                supplierCampaign: {
                  include: { merchant: { select: { displayName: true, slug: true } } },
                },
              },
            }
          : false,
      },
    });
  }

  /**
   * Load one assignment for a tenant with the partner projection include graph.
   * Resolves by assignment id or canonical campaign id.
   */
  async findPartnerCampaignForClient({ clientId, id }, client = null) {
    const db = resolveClient(client);
    const baseWhere = {
      clientId,
      status: { in: ACTIVE_ASSIGNMENT_STATUSES },
      canonicalCampaign: {
        deletedAt: null,
        status: "PUBLISHED",
        visibility: { not: "HIDDEN" },
      },
    };

    const byAssignment = await db.clientCampaignAssignment.findFirst({
      where: { ...baseWhere, id },
      include: PARTNER_CAMPAIGN_INCLUDE,
    });
    if (byAssignment) return byAssignment;

    return db.clientCampaignAssignment.findFirst({
      where: { ...baseWhere, canonicalCampaignId: id },
      include: PARTNER_CAMPAIGN_INCLUDE,
      orderBy: [{ createdAt: "desc" }],
    });
  }

  async findManyForPartner(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildPartnerWhere(filters);

    const [rows, total] = await Promise.all([
      db.clientCampaignAssignment.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: PARTNER_CAMPAIGN_INCLUDE,
      }),
      db.clientCampaignAssignment.count({ where }),
    ]);

    return { rows, total };
  }

  async findManyCursorForPartner(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildPartnerWhere(filters),
      ...buildCursorWhere(cursor, ["createdAt", "id"]),
    };

    const rows = await db.clientCampaignAssignment.findMany({
      where,
      take: take + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: PARTNER_CAMPAIGN_INCLUDE,
    });

    return slicePage(rows, take);
  }

  async findActiveByPair({ clientId, canonicalCampaignId }, client = null) {
    const db = resolveClient(client);
    return db.clientCampaignAssignment.findFirst({
      where: {
        clientId,
        canonicalCampaignId,
        status: { in: ACTIVE_ASSIGNMENT_STATUSES },
      },
    });
  }

  /**
   * §13 approved single-assignment fallback: published ACTIVE rows for a campaign source.
   */
  async findPublishedActiveByCampaignSource(campaignSourceId, client = null) {
    if (!campaignSourceId) return [];
    const db = resolveClient(client);
    return db.clientCampaignAssignment.findMany({
      where: {
        campaignSourceId,
        published: true,
        status: "ACTIVE",
      },
      orderBy: [{ publishedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 5,
    });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildWhere(filters);

    const [rows, total] = await Promise.all([
      db.clientCampaignAssignment.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: ASSIGNMENT_LIST_INCLUDE,
      }),
      db.clientCampaignAssignment.count({ where }),
    ]);

    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildWhere(filters),
      ...buildCursorWhere(cursor, ["createdAt", "id"]),
    };

    const rows = await db.clientCampaignAssignment.findMany({
      where,
      take: take + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: ASSIGNMENT_LIST_INCLUDE,
    });

    return slicePage(rows, take);
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.clientCampaignAssignment.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.clientCampaignAssignment.update({ where: { id }, data });
  }
}
