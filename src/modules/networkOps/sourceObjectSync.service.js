/**
 * Isolated sync runs per source object.
 * Failure of one object never throws to abort a sibling object.
 * Declared-but-not-live objects complete as NOT_AVAILABLE — no invented fetch.
 */

import { prisma as defaultPrisma } from "../../database/prisma.js";
import { logger } from "../../platform/logging/logger.js";
import { platformsForSupplier } from "../ops/networkOps.contract.js";
import { sanitizeSecretError } from "./networkAccount.contract.js";
import { getSourceObject, listSourceObjectCatalog, networkFamily } from "./sourceObjects.catalog.js";
import {
  SYNC_RUN_STATUS,
  buildSyncRunIdentity,
  syncRunIdentityKey,
  toSyncRunDto,
} from "./syncRun.contract.js";
import {
  SYNC_OBS_STATUS,
  SYNC_TRIGGER,
  inferJobType,
  resolveTerminalStatus,
  rollupIngestCounters,
  toSyncObservabilityDto,
} from "./syncObservability.contract.js";
import { reportRateLimitExhaustion } from "../ops/syncAlert.service.js";

function recordCountFrom(result) {
  if (result == null) return 0;
  if (typeof result.recordCount === "number") return result.recordCount;
  if (typeof result.recordsFetched === "number") return result.recordsFetched;
  if (Array.isArray(result.rows)) return result.rows.length;
  if (Array.isArray(result)) return result.length;
  return 0;
}

function identityLog(identity, extra = {}) {
  return {
    network: identity.network,
    network_account_id: identity.network_account_id,
    source_object: identity.source_object,
    endpoint: identity.endpoint,
    sync_run_id: identity.sync_run_id,
    ...extra,
  };
}

function countersFromResult(result) {
  if (!result || typeof result !== "object") return {};
  return {
    recordsFetched: recordCountFrom(result),
    recordsCreated: result.recordsCreated ?? result.counters?.recordsCreated ?? 0,
    recordsUpdated: result.recordsUpdated ?? result.counters?.recordsUpdated ?? 0,
    recordsUnchanged: result.recordsUnchanged ?? result.counters?.recordsUnchanged ?? 0,
    recordsQuarantined: result.recordsQuarantined ?? result.counters?.recordsQuarantined ?? 0,
  };
}

export class SourceObjectSyncService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? defaultPrisma;
  }

  async startRun({
    network,
    networkAccountId = null,
    sourceObject,
    endpoint = null,
    jobType = null,
    trigger = SYNC_TRIGGER.SCHEDULER,
    parentSyncRunId = null,
    checkpointBefore = null,
    syncRunId = null,
    metadata = null,
  } = {}) {
    const catalog = getSourceObject(network, sourceObject);
    const identity = buildSyncRunIdentity({
      network,
      networkAccountId,
      sourceObject,
      endpoint: endpoint || catalog?.endpoint,
      syncRunId,
    });
    const startedAt = new Date();
    await this.#safeCreate({
      id: identity.sync_run_id,
      network: identity.network,
      networkAccountId: identity.network_account_id,
      sourceObject: identity.source_object,
      endpoint: identity.endpoint,
      status: SYNC_OBS_STATUS.RUNNING,
      jobType: inferJobType(sourceObject, jobType),
      trigger,
      parentSyncRunId,
      checkpointBefore,
      startedAt,
      metadata,
    });
    return { identity, startedAt };
  }

  async finalizeRun(syncRunId, patch = {}) {
    if (!syncRunId) return null;
    const existing = await this.db.networkSyncRun?.findUnique?.({ where: { id: syncRunId } });
    if (!existing) return null;

    const counters = rollupIngestCounters(
      {
        recordsFetched: existing.recordsFetched ?? existing.recordCount ?? 0,
        recordsCreated: existing.recordsCreated ?? 0,
        recordsUpdated: existing.recordsUpdated ?? 0,
        recordsUnchanged: existing.recordsUnchanged ?? 0,
        recordsQuarantined: existing.recordsQuarantined ?? 0,
      },
      patch,
    );

    const status =
      patch.status ||
      resolveTerminalStatus({
        counters,
        hadError: false,
        partial: patch.partial === true,
      });

    const data = {
      ...counters,
      recordCount: counters.recordsFetched,
      status,
      finishedAt: patch.finishedAt ?? new Date(),
      checkpointAfter: patch.checkpointAfter ?? existing.checkpointAfter ?? null,
      retryCount: patch.retryCount ?? existing.retryCount ?? null,
      rateLimitTelemetry: patch.rateLimitTelemetry ?? existing.rateLimitTelemetry ?? null,
      metadata: patch.metadata
        ? { ...(existing.metadata || {}), ...patch.metadata }
        : existing.metadata,
    };

    await this.#safeUpdate(syncRunId, data);
    return toSyncObservabilityDto({ ...existing, ...data, id: syncRunId });
  }

  async execute({
    network,
    networkAccountId = null,
    sourceObject,
    endpoint = null,
    jobType = null,
    trigger = SYNC_TRIGGER.SCHEDULER,
    parentSyncRunId = null,
    checkpointBefore = null,
    checkpointAfter = null,
    retryCount = null,
    rateLimitTelemetry = null,
    metadata = null,
    execute,
  }) {
    const catalog = getSourceObject(network, sourceObject);
    const identity = buildSyncRunIdentity({
      network,
      networkAccountId,
      sourceObject,
      endpoint: endpoint || catalog?.endpoint,
    });

    if (!catalog) {
      return this.#persistTerminal({
        identity,
        status: SYNC_RUN_STATUS.NOT_AVAILABLE,
        errorCode: "UNKNOWN_SOURCE_OBJECT",
        errorMessage: `Unknown source object ${sourceObject} for ${network}`,
        result: null,
        jobType: inferJobType(sourceObject, jobType),
        trigger,
      });
    }

    if (!catalog.live) {
      return this.#persistTerminal({
        identity,
        status: SYNC_RUN_STATUS.NOT_AVAILABLE,
        errorCode: "SOURCE_OBJECT_NOT_LIVE",
        errorMessage: catalog.notes || `${catalog.label} is declared but has no live fetch`,
        result: null,
        availability: catalog.availability,
        jobType: inferJobType(sourceObject, jobType),
        trigger,
      });
    }

    if (typeof execute !== "function") {
      return this.#persistTerminal({
        identity,
        status: SYNC_RUN_STATUS.SKIPPED,
        errorCode: "HANDLER_MISSING",
        errorMessage: `No handler registered for ${network}/${sourceObject}`,
        result: null,
        jobType: inferJobType(sourceObject, jobType),
        trigger,
      });
    }

    const startedAt = new Date();
    const resolvedJobType = inferJobType(sourceObject, jobType);
    await this.#safeCreate({
      id: identity.sync_run_id,
      network: identity.network,
      networkAccountId: identity.network_account_id,
      sourceObject: identity.source_object,
      endpoint: identity.endpoint,
      status: SYNC_OBS_STATUS.RUNNING,
      jobType: resolvedJobType,
      trigger,
      parentSyncRunId,
      checkpointBefore,
      retryCount,
      rateLimitTelemetry,
      metadata,
      startedAt,
    });

    try {
      const result = await execute({ identity, catalog });
      const finishedAt = new Date();
      const counters = countersFromResult(result);
      const partial = Boolean(result?.partial || result?.warnings?.length);
      const status = resolveTerminalStatus({ counters, partial });
      await this.#safeUpdate(identity.sync_run_id, {
        status,
        recordCount: counters.recordsFetched,
        recordsFetched: counters.recordsFetched,
        recordsCreated: counters.recordsCreated,
        recordsUpdated: counters.recordsUpdated,
        recordsUnchanged: counters.recordsUnchanged,
        recordsQuarantined: counters.recordsQuarantined,
        checkpointAfter: result?.checkpointAfter ?? checkpointAfter ?? null,
        retryCount: result?.retryCount ?? retryCount ?? null,
        rateLimitTelemetry: result?.rateLimitTelemetry ?? rateLimitTelemetry ?? null,
        metadata: result?.metadata
          ? { ...(metadata || {}), ...result.metadata }
          : metadata,
        finishedAt,
      });
      logger.info(
        identityLog(identity, { status, ...counters }),
        "source object sync run",
      );
      return {
        identity,
        status,
        result,
        error: null,
        syncRunId: identity.sync_run_id,
      };
    } catch (error) {
      const finishedAt = new Date();
      const errorMessage = sanitizeSecretError(error?.message || String(error));
      await this.#safeUpdate(identity.sync_run_id, {
        status: SYNC_OBS_STATUS.FAILED,
        errorCode: error?.code || "SOURCE_OBJECT_SYNC_FAILED",
        errorMessage,
        retryCount: error?.syncAttemptCount ?? retryCount ?? null,
        rateLimitTelemetry: error?.rateLimitTelemetry ?? rateLimitTelemetry ?? null,
        finishedAt,
      });
      logger.warn(
        identityLog(identity, { status: SYNC_OBS_STATUS.FAILED, err: errorMessage }),
        "source object sync run failed",
      );
      try {
        await reportRateLimitExhaustion({
          network: identity.network,
          networkAccountId: identity.network_account_id,
          syncRunId: identity.sync_run_id,
          error,
          checkpointBefore,
          endpoint: identity.endpoint,
        });
      } catch {
        // ignore
      }
      return {
        identity,
        status: SYNC_OBS_STATUS.FAILED,
        result: null,
        error: { message: errorMessage, code: error?.code || "SOURCE_OBJECT_SYNC_FAILED" },
        syncRunId: identity.sync_run_id,
      };
    }
  }

  async executeMany(runs) {
    const outcomes = [];
    for (const spec of runs) {
      outcomes.push(await this.execute(spec));
    }
    return outcomes;
  }

  async listForSupplier(supplierKey, { networkAccountId = null } = {}) {
    const family = networkFamily(String(supplierKey || "").toLowerCase());
    const catalog = listSourceObjectCatalog(family);
    const platforms = platformsForSupplier(String(supplierKey || "").toUpperCase());
    const networkValues = platforms.length ? platforms : [family];

    let latest = [];
    try {
      if (this.db.networkSyncRun?.findMany) {
        const where = { network: { in: networkValues } };
        if (networkAccountId) where.networkAccountId = networkAccountId;
        latest = await this.db.networkSyncRun.findMany({
          where,
          orderBy: { startedAt: "desc" },
          take: 400,
        });
      }
    } catch {
      latest = [];
    }

    const byObject = new Map();
    for (const row of latest) {
      if (!byObject.has(row.sourceObject)) byObject.set(row.sourceObject, row);
    }

    return catalog.map((item) => ({
      ...item,
      lastRun: byObject.has(item.sourceObject) ? toSyncRunDto(byObject.get(item.sourceObject)) : null,
    }));
  }

  async #safeCreate(data) {
    try {
      if (!this.db.networkSyncRun?.create) return;
      await this.db.networkSyncRun.create({ data });
    } catch (error) {
      logger.warn(
        { err: sanitizeSecretError(error?.message) || error?.message },
        "network sync run persist failed",
      );
    }
  }

  async #safeUpdate(id, data) {
    try {
      if (!this.db.networkSyncRun?.update) return;
      await this.db.networkSyncRun.update({ where: { id }, data });
    } catch (error) {
      logger.warn(
        { err: sanitizeSecretError(error?.message) || error?.message },
        "network sync run persist failed",
      );
    }
  }

  async #persistTerminal({
    identity,
    status,
    errorCode,
    errorMessage,
    result,
    availability,
    jobType = null,
    trigger = null,
  }) {
    const now = new Date();
    await this.#safeCreate({
      id: identity.sync_run_id,
      network: identity.network,
      networkAccountId: identity.network_account_id,
      sourceObject: identity.source_object,
      endpoint: identity.endpoint,
      status,
      jobType,
      trigger,
      errorCode,
      errorMessage: sanitizeSecretError(errorMessage),
      startedAt: now,
      finishedAt: now,
      recordCount: 0,
      recordsFetched: 0,
    });
    logger.info(identityLog(identity, { status, errorCode }), "source object sync run");
    return {
      identity,
      status,
      result,
      error: errorCode ? { code: errorCode, message: sanitizeSecretError(errorMessage) } : null,
      availability,
      syncRunId: identity.sync_run_id,
    };
  }
}

export const sourceObjectSync = new SourceObjectSyncService();

export async function executeSourceObjectRun(args) {
  return sourceObjectSync.execute(args);
}

export function resultRows(run) {
  if (!run) return [];
  const okStatuses = new Set([
    SYNC_OBS_STATUS.SUCCESS,
    SYNC_OBS_STATUS.PARTIAL,
    SYNC_RUN_STATUS.SUCCEEDED,
  ]);
  if (!okStatuses.has(run.status)) return [];
  const result = run.result;
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

export { syncRunIdentityKey };
