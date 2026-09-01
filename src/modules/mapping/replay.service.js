import { prisma } from "../../database/prisma.js";
import { mapPayload } from "./engine.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import {
  ALERT_CONDITION,
  mapMappingErrorToCondition,
} from "../ops/alertException.contract.js";
import {
  buildMappingVersionId,
  parseMappingVersionId,
  resolveLoaderMappingVersion,
} from "./mappingRegistry.contract.js";

/**
 * Replay RawPayload through Mapping Engine without re-fetching supplier API.
 */
export class MappingReplayService {
  constructor({ db = null, prisma: prismaClient = null, exceptions = null } = {}) {
    this.db = prismaClient ?? db ?? prisma;
    this.exceptions = exceptions || new ExceptionCaseService({ prisma: this.db });
  }

  async replayRawPayload(rawPayloadId, { mappingVersion = null, reportExceptions = true } = {}) {
    const row = await this.db.rawPayload.findUnique({ where: { id: rawPayloadId } });
    if (!row) {
      return { ok: false, reason: "raw_payload_not_found" };
    }

    // Never mutate stored payload — pass clone into engine.
    const payload = structuredClone(row.payload);
    const originalHash = row.payloadHash;

    const requestedVersion = mappingVersion || row.mapperVersion || null;
    const parsedRegistry = parseMappingVersionId(requestedVersion);
    const supplier = parsedRegistry?.supplier || row.supplier;
    const resourceKey = parsedRegistry?.resourceKey || row.resourceKey;
    const loaderVersion = resolveLoaderMappingVersion(requestedVersion);
    const registryVersionId =
      parsedRegistry?.mappingVersion ||
      buildMappingVersionId(row.supplier, row.resourceKey, loaderVersion || "1");

    const result = mapPayload({
      supplier,
      resourceKey,
      payload,
      mappingVersion: loaderVersion,
    });

    // Verify immutability of DB payload
    const still = await this.db.rawPayload.findUnique({ where: { id: rawPayloadId } });
    if (
      still.payloadHash !== originalHash ||
      JSON.stringify(still.payload) !== JSON.stringify(row.payload) ||
      still.payloadText !== row.payloadText ||
      still.bodyRef !== row.bodyRef
    ) {
      return { ok: false, reason: "raw_payload_mutated", result };
    }

    if (!result.success && reportExceptions) {
      for (const err of result.errors) {
        const type =
          err.code &&
          [
            "MAPPING_REQUIRED_FIELD_MISSING",
            "MAPPING_INVALID_VALUE",
            "MAPPING_UNKNOWN_ENUM",
            "MAPPING_UNMAPPED_CRITICAL_FIELD",
            "MAPPING_CONFLICT",
          ].includes(err.code)
            ? err.code
            : "MAPPING_INVALID_VALUE";
        const condition = mapMappingErrorToCondition(err.code) || ALERT_CONDITION.REQUIRED_MAPPING_MISSING;
        await this.exceptions.report({
          condition,
          type,
          supplier: row.supplier,
          dedupeKey: `mapping:${row.id}:${err.targetField || err.sourcePath || err.code}`,
          reason: err.reason || err.code || "mapping_failure",
          metadata: {
            rawPayloadId: row.id,
            resourceKey: row.resourceKey,
            mappingVersion: result.mappingVersion,
            registryVersionId,
            sourceAccountLabel: row.sourceAccountLabel,
            error: err,
          },
        });
      }
    }

    return {
      ok: result.success,
      rawPayloadId: row.id,
      supplier: row.supplier,
      resourceKey: row.resourceKey,
      mappingVersion: result.mappingVersion,
      registryVersionId,
      result,
      payloadImmutable: true,
    };
  }

  async replayLatest({
    supplier,
    resourceKey,
    externalId,
    sourceAccountLabel = "default",
    mappingVersion = null,
  } = {}) {
    const row = await this.db.rawPayload.findFirst({
      where: {
        supplier,
        resourceKey,
        externalId: String(externalId),
        sourceAccountLabel,
      },
      orderBy: { receivedAt: "desc" },
    });
    if (!row) return { ok: false, reason: "raw_payload_not_found" };
    return this.replayRawPayload(row.id, { mappingVersion });
  }
}

/**
 * Service-level mapping review representation (no UI).
 */
export function buildMappingReview({
  supplier,
  resourceKey,
  mappingVersion,
  recordId,
  mapResult,
} = {}) {
  const failures = (mapResult?.errors || []).map((err) => ({
    supplier,
    resource: resourceKey,
    mappingVersion,
    recordId,
    failedField: err.targetField || err.sourcePath,
    sourceValue: err.sourceValue ?? null,
    targetField: err.targetField ?? null,
    reason: err.reason || err.code,
    code: err.code,
  }));

  return {
    supplier,
    resourceKey,
    mappingVersion,
    recordId,
    success: Boolean(mapResult?.success),
    failures,
    warnings: mapResult?.warnings || [],
    unmappedFields: mapResult?.unmappedFields || [],
  };
}
