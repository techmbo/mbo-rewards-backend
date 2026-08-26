import { prisma } from "../../database/prisma.js";
import { auditService } from "../../platform/audit/audit.service.js";
import { fail } from "../../core/apiResponse.js";

const ACTIVE_STATUSES = ["OPEN", "ACKNOWLEDGED"];
const RESOLVED_STATUSES = ["RESOLVED", "DISMISSED"];

/**
 * Wave C foundation + Wave G operational workflows.
 * Does not bypass uniqueness / financial idempotency.
 */
export class ExceptionCaseService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.audit = deps.audit ?? auditService;
  }

  buildDedupeKey({ type, supplier, supplierOrderId, supplierConversionId, orderId, conversionId }) {
    return [
      type,
      supplier || "-",
      supplierOrderId || orderId || "-",
      supplierConversionId || conversionId || "-",
    ].join("|");
  }

  async findOpenByDedupeKey(dedupeKey, client = null) {
    const db = client ?? this.db;
    if (!db?.exceptionCase?.findFirst) return null;
    return db.exceptionCase.findFirst({
      where: { dedupeKey, status: { in: ACTIVE_STATUSES } },
      orderBy: { detectedAt: "desc" },
    });
  }

  async report(input, client = null) {
    const db = client ?? this.db;
    if (!db?.exceptionCase?.create) {
      return { record: null, created: false, skipped: true };
    }

    const dedupeKey = input.dedupeKey || this.buildDedupeKey(input);
    const existing = await this.findOpenByDedupeKey(dedupeKey, db);
    if (existing) {
      const updated = await db.exceptionCase.update({
        where: { id: existing.id },
        data: {
          reason: input.reason ?? existing.reason,
          metadata: {
            ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
            ...(input.metadata || {}),
            lastDetectedAt: new Date().toISOString(),
            detectCount: Number(existing.metadata?.detectCount || 1) + 1,
          },
          orderId: input.orderId ?? existing.orderId,
          conversionId: input.conversionId ?? existing.conversionId,
          clientId: input.clientId ?? existing.clientId,
          entityId: input.entityId ?? existing.entityId,
        },
      });
      return { record: updated, created: false, reused: true };
    }

    const record = await db.exceptionCase.create({
      data: {
        type: input.type,
        severity: input.severity ?? "MEDIUM",
        status: "OPEN",
        dedupeKey,
        orderId: input.orderId ?? null,
        conversionId: input.conversionId ?? null,
        supplier: input.supplier ?? null,
        clientId: input.clientId ?? null,
        entityId: input.entityId ?? null,
        reason: input.reason ?? null,
        metadata: {
          ...(input.metadata || {}),
          detectCount: 1,
        },
        assignedTo: input.assignedTo ?? null,
      },
    });

    try {
      await this.audit.record({
        aggregateType: "ExceptionCase",
        aggregateId: record.id,
        action: "exception.created",
        after: { type: record.type, dedupeKey, status: record.status },
        reason: record.reason,
      });
    } catch {
      // audit best-effort
    }

    return { record, created: true, reused: false };
  }

  async getById(id, client = null) {
    const db = client ?? this.db;
    const record = await db.exceptionCase.findUnique({
      where: { id },
      include: {
        order: true,
        conversion: true,
        client: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!record) throw fail("Exception case not found.", 404);
    return record;
  }

  async list(filters = {}, { skip = 0, take = 50 } = {}, client = null) {
    const db = client ?? this.db;
    const where = {};
    if (filters.status) where.status = filters.status;
    if (filters.severity) where.severity = filters.severity;
    if (filters.type) {
      where.type = typeof filters.type === "object" ? filters.type : filters.type;
    }
    if (filters.supplier) where.supplier = filters.supplier;
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.orderId) where.orderId = filters.orderId;
    if (filters.conversionId) where.conversionId = filters.conversionId;
    if (filters.assignedTo) where.assignedTo = filters.assignedTo;
    if (filters.from || filters.to) {
      where.detectedAt = {
        ...(filters.from ? { gte: new Date(filters.from) } : {}),
        ...(filters.to ? { lte: new Date(filters.to) } : {}),
      };
    }
    if (filters.updatedFrom || filters.updatedTo) {
      where.updatedAt = {
        ...(filters.updatedFrom ? { gte: new Date(filters.updatedFrom) } : {}),
        ...(filters.updatedTo ? { lte: new Date(filters.updatedTo) } : {}),
      };
    }
    if (filters.campaignId || filters.canonicalCampaignId) {
      where.metadata = {
        path: ["canonicalCampaignId"],
        equals: String(filters.campaignId || filters.canonicalCampaignId),
      };
    }
    if (filters.q) {
      const q = String(filters.q).trim();
      where.OR = [
        { reason: { contains: q, mode: "insensitive" } },
        { dedupeKey: { contains: q, mode: "insensitive" } },
        { id: q },
      ];
    }

    const [rows, total] = await Promise.all([
      db.exceptionCase.findMany({
        where,
        orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
        skip,
        take,
        include: {
          client: { select: { id: true, name: true, slug: true } },
        },
      }),
      db.exceptionCase.count({ where }),
    ]);
    return { rows, total };
  }

  async acknowledge(id, { actorId = null } = {}, client = null) {
    const db = client ?? this.db;
    const existing = await this.getById(id, db);
    if (!ACTIVE_STATUSES.includes(existing.status) && existing.status !== "OPEN") {
      if (existing.status === "ACKNOWLEDGED") return existing;
    }
    const record = await db.exceptionCase.update({
      where: { id },
      data: {
        status: "ACKNOWLEDGED",
        metadata: {
          ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
          acknowledgedAt: new Date().toISOString(),
          acknowledgedBy: actorId,
        },
      },
    });
    await this.#audit(id, "exception.acknowledged", { status: "ACKNOWLEDGED" }, actorId);
    return record;
  }

  async assign(id, { assignedTo, actorId = null } = {}, client = null) {
    if (!assignedTo) throw fail("assignedTo is required.", 400);
    const db = client ?? this.db;
    await this.getById(id, db);
    const record = await db.exceptionCase.update({
      where: { id },
      data: { assignedTo: String(assignedTo) },
    });
    await this.#audit(id, "exception.assigned", { assignedTo }, actorId);
    return record;
  }

  async resolve(id, { reason, status = "RESOLVED", actorId = null } = {}, client = null) {
    const db = client ?? this.db;
    if (!RESOLVED_STATUSES.includes(status) && status !== "RESOLVED") {
      // allow ACKNOWLEDGED via acknowledge(); resolve uses RESOLVED/DISMISSED
    }
    const finalStatus = status === "DISMISSED" ? "DISMISSED" : "RESOLVED";
    const record = await db.exceptionCase.update({
      where: { id },
      data: {
        status: finalStatus,
        resolvedAt: new Date(),
        reason: reason ?? undefined,
      },
    });
    await this.#audit(id, "exception.resolved", { status: finalStatus }, actorId, reason);
    return record;
  }

  async reopen(id, { reason, actorId = null } = {}, client = null) {
    const db = client ?? this.db;
    const existing = await this.getById(id, db);
    if (!RESOLVED_STATUSES.includes(existing.status)) {
      throw fail("Only resolved or dismissed exceptions can be reopened.", 409);
    }
    const record = await db.exceptionCase.update({
      where: { id },
      data: {
        status: "OPEN",
        resolvedAt: null,
        reason: reason ?? existing.reason,
        metadata: {
          ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
          reopenedAt: new Date().toISOString(),
          reopenedBy: actorId,
        },
      },
    });
    await this.#audit(id, "exception.reopened", { status: "OPEN" }, actorId, reason);
    return record;
  }

  /**
   * Classify whether retry is safe for this exception type.
   */
  getRetryPolicy(type) {
    const mapping = new Set([
      "MAPPING_REQUIRED_FIELD_MISSING",
      "MAPPING_INVALID_VALUE",
      "MAPPING_UNKNOWN_ENUM",
      "MAPPING_UNMAPPED_CRITICAL_FIELD",
      "MAPPING_CONFLICT",
    ]);
    const unsafeFinance = new Set([
      "DUPLICATE_FINANCIAL_RECOGNITION",
      "CONFLICTING_FINANCIAL_TRANSACTION",
      "FINANCIAL_RECONCILIATION_MISMATCH",
      "TAX_CONFIGURATION_MISSING",
      "TAX_LEGAL_REVIEW_REQUIRED",
      "TAX_CURRENCY_MISMATCH",
      "TAX_CALCULATION_BLOCKED",
    ]);
    if (mapping.has(type)) {
      return { allowed: true, mode: "MAPPING_REPLAY", note: "Replay RawPayload via MappingReplayService" };
    }
    if (unsafeFinance.has(type)) {
      return { allowed: false, mode: "NONE", note: "Finance retries must use adjustment/reversal services" };
    }
    if (type === "ATTRIBUTION_UNRESOLVED") {
      return { allowed: false, mode: "MANUAL", note: "Re-run attribution via conversion promotion job manually" };
    }
    return { allowed: false, mode: "NONE", note: "No automatic retry for this type" };
  }

  async #audit(id, action, after, actorId, reason) {
    try {
      await this.audit.record({
        aggregateType: "ExceptionCase",
        aggregateId: id,
        action,
        actorId: actorId ?? null,
        after,
        reason: reason ?? null,
      });
    } catch {
      // ignore
    }
  }
}
