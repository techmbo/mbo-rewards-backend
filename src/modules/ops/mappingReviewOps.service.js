import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { toRawPayloadDetailDto, toRawPayloadListDto } from "../networkOps/rawPayload.contract.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { MappingReplayService, buildMappingReview } from "../mapping/index.js";
import { ReprocessOrchestratorService } from "../networkOps/reprocessOrchestrator.service.js";
import { REPROCESS_MODES } from "../networkOps/reprocessing.contract.js";
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
    this.reprocess =
      deps.reprocess ?? new ReprocessOrchestratorService({ prisma: this.db, exceptions: this.exceptions });
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
          network: true,
          networkAccountId: true,
          sourceObject: true,
          endpointOrReport: true,
          apiVersion: true,
          syncRunId: true,
          requestWindow: true,
          httpStatus: true,
          bodyKind: true,
          bodyRef: true,
          entityId: true,
        },
      }),
      this.db.rawPayload.count({ where }),
    ]);
    return { rows: rows.map((row) => toRawPayloadListDto(row)), total };
  }

  async getRawPayload(id) {
    const row = await this.db.rawPayload.findUnique({ where: { id } });
    if (!row) throw fail("RawPayload not found.", 404);
    return toRawPayloadDetailDto(row);
  }

  async replay(rawPayloadId, { mappingVersion = null, mode = REPROCESS_MODES.MAP_ONLY, actorId = null } = {}) {
    if (String(mode).toUpperCase() === REPROCESS_MODES.FULL) {
      return this.reprocessOne(rawPayloadId, { mappingVersion, actorId });
    }
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

  async reprocessOne(rawPayloadId, {
    mappingVersion = null,
    rerunReconciliation = true,
    closeExceptions = true,
    actorId = null,
  } = {}) {
    const result = await this.reprocess.reprocessOne({
      rawPayloadId,
      mappingVersion,
      mode: REPROCESS_MODES.FULL,
      rerunReconciliation,
      closeExceptions,
      actorId,
    });
    try {
      await this.audit.record({
        aggregateType: "RawPayload",
        aggregateId: rawPayloadId,
        action: "reprocess.full",
        actorId,
        after: {
          ok: result.ok,
          mappingVersion: result.mappingVersion,
          diff: result.diff,
          closedExceptions: result.closedExceptions,
        },
      });
    } catch {
      // ignore
    }
    return result;
  }

  async reprocessBatch(body = {}, { actorId = null } = {}) {
    return this.reprocess.reprocessBatch({
      rawPayloadIds: body.rawPayloadIds,
      mappingVersion: body.mappingVersion ?? null,
      mode: REPROCESS_MODES.FULL,
      rerunReconciliation: body.rerunReconciliation !== false,
      closeExceptions: body.closeExceptions !== false,
      actorId,
    });
  }

  async retryException(exceptionId, { actorId = null, mappingVersion = null } = {}) {
    const ex = await this.exceptions.getById(exceptionId);
    const policy = this.exceptions.getRetryPolicy(ex.type);
    if (!policy.allowed) {
      throw fail(`Retry not allowed: ${policy.note}`, 409);
    }
    const rawPayloadId = ex.metadata?.rawPayloadId;
    if (!rawPayloadId) {
      throw fail("Exception has no rawPayloadId metadata for replay.", 400);
    }
    const result = await this.reprocessOne(rawPayloadId, {
      mappingVersion: mappingVersion ?? ex.metadata?.mappingVersion ?? null,
      actorId,
    });
    await this.audit.record({
      aggregateType: "ExceptionCase",
      aggregateId: exceptionId,
      action: "exception.retried",
      actorId,
      after: { mode: policy.mode, ok: result.ok, reprocess: true },
    }).catch(() => {});
    return { policy, result };
  }
}
