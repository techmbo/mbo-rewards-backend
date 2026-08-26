import { prisma } from "../../database/prisma.js";
import { sanitizeForLog } from "../logging/context.js";
import { getRequestContext } from "../logging/context.js";

export class AuditRepository {
  async create(data, client = null) {
    const db = client ?? prisma;
    return db.auditEvent.create({ data });
  }

  async findMany({ skip = 0, take = 50, aggregateType, action } = {}) {
    const where = {};
    if (aggregateType) where.aggregateType = aggregateType;
    if (action) where.action = action;
    const [rows, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.auditEvent.count({ where }),
    ]);
    return { rows, total };
  }
}

export class AuditService {
  constructor(deps = {}) {
    this.repo = deps.repo ?? new AuditRepository();
  }

  async record({
    aggregateType,
    aggregateId,
    action,
    actorId,
    actorEmail,
    before,
    after,
    reason,
    correlationId,
    metadata,
  }) {
    const ctx = getRequestContext();
    return this.repo.create({
      aggregateType,
      aggregateId: aggregateId ?? null,
      action,
      actorId: actorId ?? ctx.userId ?? null,
      actorEmail: actorEmail ?? null,
      before: before ? sanitizeForLog(before) : null,
      after: after ? sanitizeForLog(after) : null,
      reason: reason ?? null,
      correlationId: correlationId ?? ctx.traceId ?? ctx.requestId ?? null,
      metadata: metadata ? sanitizeForLog(metadata) : null,
    });
  }
}

export const auditService = new AuditService();
