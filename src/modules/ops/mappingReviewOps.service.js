import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { MappingReplayService, buildMappingReview } from "../mapping/index.js";
import { auditService } from "../../platform/audit/audit.service.js";

const MAPPING_TYPES = [
  "MAPPING_REQUIRED_FIELD_MISSING",
  "MAPPING_INVALID_VALUE",
  "MAPPING_UNKNOWN_ENUM",
  "MAPPING_UNMAPPED_CRITICAL_FIELD",
  "MAPPING_CONFLICT",
];

/**
 * Wave G — mapping review + safe RawPayload replay (no re-fetch).
 */
export class MappingReviewOpsService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db });
    this.replay = deps.replay ?? new MappingReplayService({ db: this.db, exceptions: this.exceptions });
    this.audit = deps.audit ?? auditService;
  }

  async listMappingExceptions(filters = {}, pagination = {}) {
    const typeFilter = filters.type && MAPPING_TYPES.includes(filters.type)
      ? filters.type
      : { in: MAPPING_TYPES };
    return this.exceptions.list(
      {
        ...filters,
        type: typeFilter,
      },
      pagination,
    );
  }

  async listRawPayloads(filters = {}, { skip = 0, take = 50 } = {}) {
    const where = {};
    if (filters.supplier) where.supplier = filters.supplier;
    if (filters.resourceKey) where.resourceKey = filters.resourceKey;
    if (filters.externalId) where.externalId = String(filters.externalId);
    if (filters.sourceAccountLabel) where.sourceAccountLabel = filters.sourceAccountLabel;
    if (filters.processingStatus) where.processingStatus = filters.processingStatus;

    const [rows, total] = await Promise.all([
      this.db.rawPayload.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          supplier: true,
          sourceAccountLabel: true,
          resourceKey: true,
          entityType: true,
          externalId: true,
          payloadHash: true,
          mapperVersion: true,
          processingStatus: true,
          fetchedAt: true,
          receivedAt: true,
          networkSource: true,
          entityId: true,
          // payload omitted from list
        },
      }),
      this.db.rawPayload.count({ where }),
    ]);
    return { rows, total };
  }

  async getRawPayload(id) {
    const row = await this.db.rawPayload.findUnique({ where: { id } });
    if (!row) throw fail("RawPayload not found.", 404);
    return {
      id: row.id,
      supplier: row.supplier,
      sourceAccountLabel: row.sourceAccountLabel,
      resourceKey: row.resourceKey,
      entityType: row.entityType,
      externalId: row.externalId,
      payloadHash: row.payloadHash,
      mapperVersion: row.mapperVersion,
      processingStatus: row.processingStatus,
      fetchedAt: row.fetchedAt,
      receivedAt: row.receivedAt,
      networkSource: row.networkSource,
      entityId: row.entityId,
      metadata: row.metadata,
      payload: row.payload,
      immutable: true,
    };
  }

  async replay(rawPayloadId, { mappingVersion = null, actorId = null } = {}) {
    const out = await this.replay.replayRawPayload(rawPayloadId, {
      mappingVersion,
      reportExceptions: true,
    });
    try {
      await this.audit.record({
        aggregateType: "RawPayload",
        aggregateId: rawPayloadId,
        action: "mapping.replayed",
        actorId,
        after: {
          ok: out.ok,
          mappingVersion: out.mappingVersion,
          payloadImmutable: out.payloadImmutable,
        },
      });
    } catch {
      // ignore
    }
    const review = buildMappingReview({
      supplier: out.supplier,
      resourceKey: out.resourceKey,
      mappingVersion: out.mappingVersion,
      recordId: rawPayloadId,
      mapResult: out.result,
    });
    return { ...out, review };
  }

  async retryException(exceptionId, { actorId = null } = {}) {
    const ex = await this.exceptions.getById(exceptionId);
    const policy = this.exceptions.getRetryPolicy(ex.type);
    if (!policy.allowed) {
      throw fail(`Retry not allowed: ${policy.note}`, 409);
    }
    const rawPayloadId = ex.metadata?.rawPayloadId;
    if (!rawPayloadId) {
      throw fail("Exception has no rawPayloadId metadata for replay.", 400);
    }
    const result = await this.replay(rawPayloadId, {
      mappingVersion: ex.metadata?.mappingVersion ?? null,
      actorId,
    });
    await this.audit.record({
      aggregateType: "ExceptionCase",
      aggregateId: exceptionId,
      action: "exception.retried",
      actorId,
      after: { mode: policy.mode, ok: result.ok },
    }).catch(() => {});
    if (result.ok) {
      await this.exceptions.resolve(exceptionId, {
        reason: "Resolved after successful mapping replay",
        actorId,
      });
    }
    return { policy, result };
  }
}
