import { prisma } from "../../../database/prisma.js";
import { buildCursorWhere, slicePage } from "../../../core/cursorPagination.js";
import { periodsOverlap } from "../commissionMath.js";

function resolveClient(tx) {
  return tx ?? prisma;
}

function buildWhere(filters = {}) {
  const where = { deletedAt: null };
  if (filters.assignmentId) where.assignmentId = filters.assignmentId;
  if (filters.status) where.status = filters.status;
  if (filters.isPrimary === true) where.isPrimary = true;
  if (filters.campaignSourceId) where.campaignSourceId = filters.campaignSourceId;

  const and = [];

  const assignmentWhere = {};
  if (filters.clientId) assignmentWhere.clientId = filters.clientId;
  if (filters.canonicalCampaignId) assignmentWhere.canonicalCampaignId = filters.canonicalCampaignId;
  if (Object.keys(assignmentWhere).length) {
    and.push({ assignment: assignmentWhere });
  }

  if (filters.search) {
    const term = String(filters.search).trim();
    if (term) {
      and.push({
        OR: [
          { slug: { contains: term, mode: "insensitive" } },
          { subId: { contains: term, mode: "insensitive" } },
          { mboTrackingUrl: { contains: term, mode: "insensitive" } },
          {
            assignment: {
              client: { name: { contains: term, mode: "insensitive" } },
            },
          },
          {
            assignment: {
              canonicalCampaign: {
                OR: [
                  { displayName: { contains: term, mode: "insensitive" } },
                  { merchant: { displayName: { contains: term, mode: "insensitive" } } },
                ],
              },
            },
          },
        ],
      });
    }
  }

  if (and.length) where.AND = and;
  return where;
}

const LIST_INCLUDE = {
  assignment: {
    include: {
      client: { select: { id: true, name: true, slug: true, status: true } },
      canonicalCampaign: {
        include: {
          merchant: { select: { id: true, displayName: true, slug: true } },
        },
      },
      campaignSource: {
        include: {
          supplierCampaign: {
            select: { id: true, supplier: true, trackingUrl: true, destinationUrl: true },
          },
        },
      },
    },
  },
  campaignSource: {
    include: {
      supplierCampaign: {
        select: { id: true, supplier: true, trackingUrl: true, destinationUrl: true },
      },
    },
  },
  _count: { select: { clicks: true } },
};

const REDIRECT_INCLUDE = {
  assignment: {
    include: {
      client: true,
      canonicalCampaign: { include: { merchant: true } },
      campaignSource: { include: { supplierCampaign: true } },
      couponAssignments: {
        where: { status: { in: ["ACTIVE", "ASSIGNED"] } },
        include: { supplierCoupon: { include: { entity: true } } },
        orderBy: [{ createdAt: "desc" }],
        take: 20,
      },
    },
  },
  campaignSource: { include: { supplierCampaign: true } },
};

export class TrackingLinkRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.trackingLink.findFirst({ where: { id, deletedAt: null } });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildWhere(filters);
    const [rows, total] = await Promise.all([
      db.trackingLink.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        include: LIST_INCLUDE,
      }),
      db.trackingLink.count({ where }),
    ]);
    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildWhere(filters),
      ...buildCursorWhere(cursor, ["createdAt", "id"]),
    };
    const rows = await db.trackingLink.findMany({
      where,
      take: take + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: LIST_INCLUDE,
    });
    return slicePage(rows, take);
  }

  async findPrimaryForAssignment(assignmentId, client = null) {
    const db = resolveClient(client);
    return db.trackingLink.findFirst({
      where: { assignmentId, isPrimary: true, deletedAt: null, status: { in: ["GENERATED", "ACTIVE"] } },
    });
  }

  async findBySubId(subId, client = null) {
    const db = resolveClient(client);
    return db.trackingLink.findFirst({
      where: { subId, deletedAt: null },
      include: REDIRECT_INCLUDE,
    });
  }

  async findBySlugAndToken(slug, token, client = null) {
    const db = resolveClient(client);
    const subId = String(token || "").trim();
    const linkSlug = String(slug || "").trim().toLowerCase();
    if (!subId) return null;

    const link = await db.trackingLink.findFirst({
      where: { subId, deletedAt: null },
      include: REDIRECT_INCLUDE,
    });
    if (!link) return null;

    // Legacy links may have no slug — allow token-only match when slug absent.
    if (link.slug) {
      if (link.slug.toLowerCase() !== linkSlug) return null;
    }

    return link;
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.trackingLink.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.trackingLink.update({ where: { id }, data });
  }

  async clearPrimaryForAssignment(assignmentId, exceptId = null, client = null) {
    const db = resolveClient(client);
    return db.trackingLink.updateMany({
      where: {
        assignmentId,
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { isPrimary: false },
    });
  }

  async revoke(id, client = null) {
    const db = resolveClient(client);
    return db.trackingLink.update({
      where: { id },
      data: { status: "REVOKED", isPrimary: false, deletedAt: new Date() },
    });
  }
}

function buildCouponWhere(filters = {}) {
  const where = {};
  if (filters.assignmentId) where.assignmentId = filters.assignmentId;
  if (filters.status) where.status = filters.status;
  if (filters.couponType) where.couponType = filters.couponType;
  return where;
}

export class CouponAssignmentRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.clientCouponAssignment.findUnique({ where: { id } });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildCouponWhere(filters);
    const [rows, total] = await Promise.all([
      db.clientCouponAssignment.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      db.clientCouponAssignment.count({ where }),
    ]);
    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildCouponWhere(filters),
      ...buildCursorWhere(cursor, ["createdAt", "id"]),
    };
    const rows = await db.clientCouponAssignment.findMany({
      where,
      take: take + 1,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return slicePage(rows, take);
  }

  /**
   * §13 unique-coupon attribution: match active/assigned codes (exact, case-insensitive).
   * Caller decides unique vs shared from result length.
   */
  async findActiveByCouponCode(couponCode, client = null) {
    const code = String(couponCode ?? "").trim();
    if (!code) return [];
    const db = resolveClient(client);
    return db.clientCouponAssignment.findMany({
      where: {
        status: { in: ["ASSIGNED", "ACTIVE"] },
        OR: [
          { supplierCouponCode: { equals: code, mode: "insensitive" } },
          { clientCouponCode: { equals: code, mode: "insensitive" } },
        ],
        assignment: {
          status: { in: ["ASSIGNED", "ACTIVE"] },
          published: true,
        },
      },
      include: {
        assignment: {
          select: {
            id: true,
            clientId: true,
            campaignSourceId: true,
            canonicalCampaignId: true,
            status: true,
            published: true,
          },
        },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 20,
    });
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    return db.clientCouponAssignment.create({ data });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    return db.clientCouponAssignment.update({ where: { id }, data });
  }

  async updateManyForAssignment(assignmentId, whereExtra, data, client = null) {
    const db = resolveClient(client);
    return db.clientCouponAssignment.updateMany({
      where: { assignmentId, ...whereExtra },
      data,
    });
  }
}

function buildCommissionWhere(filters = {}) {
  const where = {};
  if (filters.assignmentId) where.assignmentId = filters.assignmentId;
  if (filters.status) where.status = filters.status;
  return where;
}

const COMMISSION_GRAPH_INCLUDE = {
  conditions: { orderBy: [{ conditionType: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
  tiers: { orderBy: [{ sequence: "asc" }, { id: "asc" }] },
};

function normalizeConditionCreate(condition, assignmentId) {
  return {
    assignmentId,
    conditionType: condition.conditionType,
    operator: condition.operator ?? "EQ",
    value: condition.value ?? null,
    field: condition.field ?? null,
    metadata: condition.metadata ?? null,
  };
}

function normalizeTierCreate(tier, assignmentId, index) {
  return {
    assignmentId,
    sequence: tier.sequence ?? index + 1,
    minInclusive: tier.minInclusive,
    maxExclusive: tier.maxExclusive ?? null,
    payoutType: tier.payoutType,
    sharePercent: tier.sharePercent ?? null,
    orderValuePercent: tier.orderValuePercent ?? null,
    fixedAmount: tier.fixedAmount ?? null,
    metadata: tier.metadata ?? null,
  };
}

export class CommissionRuleRepository {
  async findById(id, client = null) {
    const db = resolveClient(client);
    return db.clientCommissionRule.findUnique({
      where: { id },
      include: COMMISSION_GRAPH_INCLUDE,
    });
  }

  async findMany(filters = {}, { skip = 0, take = 20 } = {}, client = null) {
    const db = resolveClient(client);
    const where = buildCommissionWhere(filters);
    const [rows, total] = await Promise.all([
      db.clientCommissionRule.findMany({
        where,
        skip,
        take,
        orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
        include: COMMISSION_GRAPH_INCLUDE,
      }),
      db.clientCommissionRule.count({ where }),
    ]);
    return { rows, total };
  }

  async findManyCursor(filters = {}, { take = 20, cursor = null } = {}, client = null) {
    const db = resolveClient(client);
    const where = {
      ...buildCommissionWhere(filters),
      ...buildCursorWhere(cursor, ["effectiveFrom", "id"]),
    };
    const rows = await db.clientCommissionRule.findMany({
      where,
      take: take + 1,
      orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
      include: COMMISSION_GRAPH_INCLUDE,
    });
    return slicePage(rows, take);
  }

  async findEffectiveRulesForAssignment(assignmentId, at = new Date(), client = null) {
    const db = resolveClient(client);
    return db.clientCommissionRule.findMany({
      where: {
        assignmentId,
        status: "EFFECTIVE",
        effectiveFrom: { lte: at },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: at } }],
      },
      orderBy: [{ effectiveFrom: "desc" }, { id: "asc" }],
      include: COMMISSION_GRAPH_INCLUDE,
    });
  }

  /** Backward-compatible convenience only. Financial matching must use all effective rules. */
  async findEffectiveForAssignment(assignmentId, at = new Date(), client = null) {
    const rules = await this.findEffectiveRulesForAssignment(assignmentId, at, client);
    return rules[0] ?? null;
  }

  async findOverlappingEffective(
    assignmentId,
    effectiveFrom,
    effectiveUntil,
    excludeId = null,
    client = null,
  ) {
    const db = resolveClient(client);
    const rules = await db.clientCommissionRule.findMany({
      where: {
        assignmentId,
        status: "EFFECTIVE",
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      include: COMMISSION_GRAPH_INCLUDE,
    });

    return rules.filter((rule) =>
      periodsOverlap(effectiveFrom, effectiveUntil, rule.effectiveFrom, rule.effectiveUntil),
    );
  }

  async create(data, client = null) {
    const db = resolveClient(client);
    const { conditions = [], tiers = [], ...ruleData } = data;
    const assignmentId = ruleData.assignmentId;
    return db.clientCommissionRule.create({
      data: {
        ...ruleData,
        ...(conditions.length
          ? { conditions: { create: conditions.map((row) => normalizeConditionCreate(row, assignmentId)) } }
          : {}),
        ...(tiers.length
          ? { tiers: { create: tiers.map((row, index) => normalizeTierCreate(row, assignmentId, index)) } }
          : {}),
      },
      include: COMMISSION_GRAPH_INCLUDE,
    });
  }

  async update(id, data, client = null) {
    const db = resolveClient(client);
    const existing = await db.clientCommissionRule.findUnique({ where: { id }, select: { assignmentId: true } });
    if (!existing) return null;

    const { conditions, tiers, ...ruleData } = data;
    return db.clientCommissionRule.update({
      where: { id },
      data: {
        ...ruleData,
        ...(conditions !== undefined
          ? {
              conditions: {
                deleteMany: {},
                create: conditions.map((row) => normalizeConditionCreate(row, existing.assignmentId)),
              },
            }
          : {}),
        ...(tiers !== undefined
          ? {
              tiers: {
                deleteMany: {},
                create: tiers.map((row, index) => normalizeTierCreate(row, existing.assignmentId, index)),
              },
            }
          : {}),
      },
      include: COMMISSION_GRAPH_INCLUDE,
    });
  }

  /**
   * Legacy broad supersede helper. Do not use it for conditional client rules because
   * multiple effective rules may legitimately coexist and the matcher resolves them.
   */
  async supersedeActiveRules(assignmentId, beforeDate, client = null) {
    const db = resolveClient(client);
    return db.clientCommissionRule.updateMany({
      where: {
        assignmentId,
        status: "EFFECTIVE",
        effectiveFrom: { lt: beforeDate },
      },
      data: { status: "SUPERSEDED", effectiveUntil: beforeDate },
    });
  }
}
