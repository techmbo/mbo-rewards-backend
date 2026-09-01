import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { ingestSourceRecord, defaultHandlers } from "./pipeline/ingestSourceRecord.js";
import { PipelineStageError } from "./pipeline/errors.js";
import {
  buildCanonicalDiff,
  pickCanonicalSnapshot,
  REPROCESS_MODES,
  summarizeReprocessResult,
  validateReprocessClose,
} from "./reprocessing.contract.js";
import { OrderIngestionService } from "../order/orderIngestion.service.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { ReconciliationService } from "../finance/reconciliation.service.js";
import { SupplierCampaignPromotionService } from "../supplier/services/supplierCampaignPromotion.service.js";
import { SupplierCampaignRepository } from "../supplier/repositories/supplierCampaign.repository.js";
import { auditService } from "../../platform/audit/audit.service.js";
import { resolveLoaderMappingVersion } from "../mapping/mappingRegistry.contract.js";
import { sourceObjectSync } from "./sourceObjectSync.service.js";
import { SYNC_JOB_TYPE, SYNC_TRIGGER } from "./syncObservability.contract.js";

const ACTIVE_EXCEPTION_STATUSES = ["OPEN", "ACKNOWLEDGED"];

function cloneJson(value) {
  if (value == null) return value;
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function normalizeEntityType(value) {
  return String(value || "").toLowerCase();
}

function buildNetworkSource(rawRow) {
  return rawRow.networkSource || String(rawRow.supplier || "").toLowerCase();
}

export class ReprocessOrchestratorService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.orders = deps.orders ?? new OrderIngestionService({ prisma: this.db });
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db });
    this.reconciliation = deps.reconciliation ?? new ReconciliationService({ prisma: this.db });
    this.campaignPromotion =
      deps.campaignPromotion ?? new SupplierCampaignPromotionService({ prisma: this.db });
    this.campaignRepo = deps.campaignRepo ?? new SupplierCampaignRepository();
    this.audit = deps.audit ?? auditService;
    this.syncRuns = deps.syncRuns ?? sourceObjectSync;
  }

  async reprocessBatch({
    rawPayloadIds = [],
    mappingVersion = null,
    mode = REPROCESS_MODES.FULL,
    rerunReconciliation = true,
    closeExceptions = true,
    actorId = null,
  } = {}) {
    if (!Array.isArray(rawPayloadIds) || rawPayloadIds.length === 0) {
      throw fail("rawPayloadIds is required.", 400);
    }
    const results = [];
    for (const rawPayloadId of rawPayloadIds) {
      results.push(
        await this.reprocessOne({
          rawPayloadId,
          mappingVersion,
          mode,
          rerunReconciliation,
          closeExceptions,
          actorId,
        }),
      );
    }
    return {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      items: results.map(summarizeReprocessResult),
    };
  }

  async reprocessOne({
    rawPayloadId,
    mappingVersion = null,
    mode = REPROCESS_MODES.FULL,
    rerunReconciliation = true,
    closeExceptions = true,
    actorId = null,
  } = {}) {
    const row = await this.db.rawPayload.findUnique({ where: { id: rawPayloadId } });
    if (!row) {
      return { ok: false, rawPayloadId, error: "raw_payload_not_found", mode };
    }

    const originalHash = row.payloadHash;
    const originalPayload = cloneJson(row.payload);
    const entityType = normalizeEntityType(row.entityType);
    const loaderVersion = resolveLoaderMappingVersion(mappingVersion || row.mapperVersion);

    const { identity: syncIdentity } = await this.syncRuns.startRun({
      network: String(row.network || row.supplier || "").toLowerCase(),
      networkAccountId: row.networkAccountId,
      sourceObject: row.resourceKey || row.entityType,
      endpoint: row.endpointOrReport || row.resourceKey,
      jobType: SYNC_JOB_TYPE.REPROCESS,
      trigger: SYNC_TRIGGER.REPROCESS,
      metadata: { rawPayloadId, mode },
    });

    const before = await this.loadCanonicalSnapshot(row, entityType);

    if (mode === REPROCESS_MODES.MAP_ONLY) {
      const mapOnly = await this.runMappingOnly(row, loaderVersion);
      const payloadImmutable = await this.verifyRawImmutability(rawPayloadId, originalHash, originalPayload);
      return {
        ok: mapOnly.ok,
        rawPayloadId,
        mode,
        entityType,
        mappingVersion: mapOnly.mappingVersion ?? loaderVersion,
        review: mapOnly.review ?? null,
        before,
        after: before,
        diff: buildCanonicalDiff(before, before, entityType),
        payloadImmutable,
        error: mapOnly.ok ? null : mapOnly.reason || "mapping_failed",
      };
    }

    let pipelineResult;
    let upsertOutcome = { ok: false, result: null, error: null };
    try {
      pipelineResult = await ingestSourceRecord(
        {
          networkSource: buildNetworkSource(row),
          entityType: row.entityType,
          externalId: row.externalId,
          sourceResponse: cloneJson(row.payload),
          mappingVersion: loaderVersion,
          existingRawPayloadId: row.id,
          metadata: row.metadata,
        },
        {
          handlers: this.buildReprocessHandlers(row),
        },
      );
      upsertOutcome = {
        ok: Boolean(pipelineResult.values?.upsert?.ok),
        result: pipelineResult.values?.upsert ?? null,
        error: pipelineResult.values?.upsert?.error ?? null,
      };
    } catch (error) {
      const payloadImmutable = await this.verifyRawImmutability(rawPayloadId, originalHash, originalPayload);
      return {
        ok: false,
        rawPayloadId,
        mode,
        entityType,
        mappingVersion: loaderVersion,
        before,
        diff: buildCanonicalDiff(before, null, entityType),
        payloadImmutable,
        error: error instanceof PipelineStageError ? error.code : error?.message || String(error),
      };
    }

    const after = await this.loadCanonicalSnapshot(row, entityType);
    const diff = buildCanonicalDiff(before, after, entityType);

    let reconciliation = null;
    if (rerunReconciliation && entityType === "conversion" && after?.id) {
      const recon = await this.reconciliation.reconcileOrder(after.id);
      reconciliation = {
        ok: recon.allMatched !== false && !recon.hasMaterialMismatch,
        blocked: recon.blockClientPayable === true,
        material: recon.hasMaterialMismatch === true,
        checks: recon.checks ?? [],
      };
    }

    const payloadImmutable = await this.verifyRawImmutability(rawPayloadId, originalHash, originalPayload);
    const mappingOk = Boolean(
      pipelineResult?.mapped?.success ?? pipelineResult?.values?.mapped?.success,
    );
    const closeValidation = validateReprocessClose({
      mappingOk,
      upsertOk: upsertOutcome.ok,
      upsertResult: upsertOutcome.result,
      reconciliation,
      diff,
    });

    const closedExceptions = [];
    if (closeExceptions && closeValidation.ok) {
      const closed = await this.closeLinkedExceptions(rawPayloadId, {
        actorId,
        mappingVersion: loaderVersion,
        diff,
        reconciliation,
      });
      closedExceptions.push(...closed);
    }

    try {
      await this.audit.record({
        aggregateType: "RawPayload",
        aggregateId: rawPayloadId,
        action: "reprocess.completed",
        actorId,
        before: { snapshot: before },
        after: {
          snapshot: after,
          mappingVersion: loaderVersion,
          diff,
          upsert: upsertOutcome.result,
        },
      });
    } catch {
      // ignore
    }

    await this.db.rawPayload.update({
      where: { id: rawPayloadId },
      data: {
        mapperVersion: loaderVersion || row.mapperVersion,
      },
    }).catch(() => {});

    await this.syncRuns.finalizeRun(syncIdentity.sync_run_id, {
      recordsFetched: 1,
      recordsCreated: upsertOutcome.ok && !before ? 1 : 0,
      recordsUpdated: upsertOutcome.ok && before ? 1 : 0,
      recordsUnchanged: !upsertOutcome.ok && before ? 1 : 0,
      recordsQuarantined: mappingOk && upsertOutcome.ok ? 0 : 1,
      partial: !closeValidation.ok,
      metadata: { diff, closedExceptions: closedExceptions.map((c) => c.id) },
    });

    return {
      ok: mappingOk && upsertOutcome.ok && payloadImmutable,
      rawPayloadId,
      mode,
      entityType,
      mappingVersion: loaderVersion,
      before,
      after,
      diff,
      upsert: upsertOutcome.result,
      reconciliation,
      closedExceptions,
      payloadImmutable,
      closeValidation,
      completedStages: pipelineResult?.completed ?? [],
      syncRunId: syncIdentity.sync_run_id,
      error: mappingOk && upsertOutcome.ok ? null : upsertOutcome.error || "reprocess_incomplete",
    };
  }

  buildReprocessHandlers(rawRow) {
    const base = defaultHandlers({
      upsert: async (ctx) => this.upsertCanonical(ctx, rawRow),
      reconcileFinance: async (ctx) => this.reconcileFromContext(ctx),
    });

    return {
      ...base,
      async STORE_RAW_PAYLOAD(ctx) {
        const existingId = ctx.input.existingRawPayloadId;
        if (!existingId) {
          throw new PipelineStageError(
            "STORE_RAW_PAYLOAD",
            "RAW_PAYLOAD_REQUIRED",
            "Reprocess requires an existing immutable raw payload id",
          );
        }
        ctx.values.rawPayloadId = existingId;
        ctx.values.rawPayload = rawRow;
        return { summary: "reused_immutable", rawPayloadId: existingId };
      },
    };
  }

  async upsertCanonical(ctx, rawRow) {
    const entityType = normalizeEntityType(ctx.input.entityType);
    const canonical = ctx.values.canonical;
    if (!canonical) {
      return { ok: false, error: "canonical_missing" };
    }

    try {
      if (entityType === "conversion") {
        const order = await this.orders.upsertOrder({
          ...canonical,
          rawPayloadId: rawRow.id,
          supplier: canonical.supplier || rawRow.supplier,
          sourceAccountLabel: canonical.sourceAccountLabel || rawRow.sourceAccountLabel,
        });
        return {
          ok: true,
          entityType,
          result: "upserted",
          orderId: order.id,
          recordId: order.id,
        };
      }

      if (entityType === "campaign") {
        const businessKey = {
          supplier: canonical.supplier || rawRow.supplier,
          supplierRegion: canonical.supplierRegion || rawRow.supplierRegion || "UNKNOWN",
          sourceAccountLabel: canonical.sourceAccountLabel || rawRow.sourceAccountLabel,
          supplierCampaignId: canonical.supplierCampaignId,
        };
        const supplierRow = await this.campaignPromotion.supplierRepo?.findByKey?.(
          businessKey.supplier,
        );
        const syntheticEntity = {
          id: rawRow.entityId,
          networkSource: buildNetworkSource(rawRow),
          externalId: rawRow.externalId,
        };
        let outcome = { result: "skipped", record: null };
        await this.campaignPromotion.runInTransaction(async (tx) => {
          outcome = await this.campaignPromotion.upsertCampaign(
            tx,
            businessKey,
            { ...canonical, entityId: rawRow.entityId },
            supplierRow?.id ?? null,
            syntheticEntity,
            rawRow.id,
          );
        });
        return {
          ok: true,
          entityType,
          result: outcome.result,
          recordId: outcome.record?.id ?? null,
        };
      }

      return { ok: false, error: `unsupported_entity_type:${entityType}`, applicable: false };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async reconcileFromContext(ctx) {
    const upsert = ctx.values.upsert;
    if (!upsert?.orderId && !upsert?.recordId) {
      return { applicable: false, summary: "no_canonical_record" };
    }
    const orderId = upsert.orderId;
    if (!orderId) return { applicable: false, summary: "not_an_order" };
    const recon = await this.reconciliation.reconcileOrder(orderId);
    ctx.values.finance = recon;
    return {
      applicable: true,
      summary: recon.allMatched ? "matched" : "mismatch",
      ok: !recon.hasMaterialMismatch,
    };
  }

  async loadCanonicalSnapshot(rawRow, entityType) {
    const type = normalizeEntityType(entityType || rawRow.entityType);
    if (type === "conversion") {
      const order = await this.findOrderForRawPayload(rawRow);
      if (!order) return null;
      const snap = pickCanonicalSnapshot(order, type);
      const meta = asObject(order.metadata);
      if (meta.mboOrderStatus != null) snap.mboOrderStatus = meta.mboOrderStatus;
      if (meta.networkRawStatus != null) snap.networkRawStatus = meta.networkRawStatus;
      return snap;
    }
    if (type === "campaign") {
      const campaign = await this.findCampaignForRawPayload(rawRow);
      return pickCanonicalSnapshot(campaign, type);
    }
    return null;
  }

  async findOrderForRawPayload(rawRow) {
    if (rawRow.entityId) {
      const byEntity = await this.db.order.findFirst({
        where: { entityId: rawRow.entityId },
      });
      if (byEntity) return byEntity;
    }
    return this.db.order.findFirst({
      where: {
        supplier: rawRow.supplier,
        sourceAccountLabel: rawRow.sourceAccountLabel,
        OR: [
          { supplierOrderId: rawRow.externalId },
          { supplierConversionId: rawRow.externalId },
        ],
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  async findCampaignForRawPayload(rawRow) {
    const payload = asObject(rawRow.payload);
    const supplierCampaignId =
      payload?.id ??
      payload?.campaign_id ??
      payload?.campaignId ??
      rawRow.externalId;
    return this.campaignRepo.findByBusinessKey({
      supplier: rawRow.supplier,
      supplierRegion: rawRow.supplierRegion || "UNKNOWN",
      sourceAccountLabel: rawRow.sourceAccountLabel,
      supplierCampaignId: String(supplierCampaignId),
    });
  }

  async verifyRawImmutability(rawPayloadId, originalHash, originalPayload) {
    const still = await this.db.rawPayload.findUnique({ where: { id: rawPayloadId } });
    if (!still) return false;
    if (still.payloadHash !== originalHash) return false;
    if (JSON.stringify(still.payload) !== JSON.stringify(originalPayload)) return false;
    return true;
  }

  async runMappingOnly(rawRow, mappingVersion) {
    const { MappingReplayService, buildMappingReview } = await import("../mapping/index.js");
    const replay = new MappingReplayService({ db: this.db, exceptions: this.exceptions });
    const out = await replay.replayRawPayload(rawRow.id, {
      mappingVersion,
      reportExceptions: false,
    });
    const review = buildMappingReview({
      supplier: out.supplier,
      resourceKey: out.resourceKey,
      mappingVersion: out.mappingVersion,
      recordId: rawRow.id,
      mapResult: out.result,
    });
    return { ...out, review };
  }

  async closeLinkedExceptions(rawPayloadId, { actorId, mappingVersion, diff, reconciliation } = {}) {
    const rows = await this.db.exceptionCase.findMany({
      where: { status: { in: ACTIVE_EXCEPTION_STATUSES } },
      take: 200,
      orderBy: { detectedAt: "desc" },
    });
    const linked = rows.filter((ex) => {
      const meta = ex.metadata && typeof ex.metadata === "object" ? ex.metadata : {};
      return meta.rawPayloadId === rawPayloadId;
    });

    const closed = [];
    for (const ex of linked) {
      const record = await this.exceptions.resolve(ex.id, {
        reason: "Closed after validated reprocess",
        actorId,
      });
      closed.push({ id: ex.id, type: ex.type, status: record.status });
    }
    return closed;
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
