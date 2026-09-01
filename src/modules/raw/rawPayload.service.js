import { createHash } from "node:crypto";
import { prisma } from "../../database/prisma.js";
import { parseNetworkSource, parseSourceAccountLabel } from "../supplier/entityIdentity.js";
import { cloneRawJson, RAW_BODY_KIND } from "../networkOps/rawPayload.contract.js";
import { getSourceEvidence } from "../networkOps/sourceEvidence.context.js";
import { observeSourceSchemaFromPersist } from "../../field-system/sourceSchemaObserver.service.js";

/**
 * Deterministic canonical JSON serialization for hashing.
 * Sorts object keys recursively; leaves arrays in order (supplier order is significant).
 */
export function canonicalizeForHash(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalizeForHash(value[key]);
  }
  return out;
}

export function hashPayload(payload) {
  const canonical = canonicalizeForHash(payload ?? null);
  const serialized = JSON.stringify(canonical);
  return createHash("sha256").update(serialized).digest("hex");
}

export function hashRawBody({ bodyKind, payload, payloadText, bodyRef }) {
  const kind = bodyKind || RAW_BODY_KIND.JSON;
  if (kind === RAW_BODY_KIND.JSON) return hashPayload(payload);
  if (payloadText != null) {
    return createHash("sha256").update(String(payloadText)).digest("hex");
  }
  if (bodyRef) {
    return hashPayload({ bodyKind: kind, bodyRef });
  }
  return hashPayload(payload);
}

function compactRequestWindow(window, checkpoint) {
  if (window == null && checkpoint == null) return null;
  const out = {};
  if (window && typeof window === "object") {
    for (const [key, value] of Object.entries(window)) {
      if (value === undefined || value === null || value === "") continue;
      out[key] = value;
    }
  }
  if (checkpoint != null && checkpoint !== "") out.checkpoint = checkpoint;
  return Object.keys(out).length ? out : null;
}

function resolveBody(payload, extras = {}) {
  const kind = String(extras.bodyKind || RAW_BODY_KIND.JSON).toUpperCase();
  if (typeof payload === "string") {
    return {
      bodyKind: extras.bodyKind || RAW_BODY_KIND.TEXT,
      payload: null,
      payloadText: payload,
      bodyRef: extras.bodyRef ?? null,
    };
  }
  if (kind !== RAW_BODY_KIND.JSON) {
    return {
      bodyKind: kind,
      payload: null,
      payloadText: extras.payloadText ?? null,
      bodyRef: extras.bodyRef ?? null,
    };
  }
  return {
    bodyKind: RAW_BODY_KIND.JSON,
    payload: cloneRawJson(payload ?? {}),
    payloadText: null,
    bodyRef: extras.bodyRef ?? null,
  };
}

function mergeEvidence(explicit = {}) {
  const als = getSourceEvidence();
  return {
    network: explicit.network ?? als.network ?? null,
    networkAccountId: explicit.networkAccountId ?? als.networkAccountId ?? null,
    sourceObject: explicit.sourceObject ?? als.sourceObject ?? null,
    endpointOrReport: explicit.endpointOrReport ?? als.endpointOrReport ?? null,
    apiVersion: explicit.apiVersion ?? als.apiVersion ?? null,
    syncRunId: explicit.syncRunId ?? als.syncRunId ?? null,
    fetchedAt: explicit.fetchedAt ?? als.fetchedAt ?? null,
    requestWindow: compactRequestWindow(
      explicit.requestWindow ?? als.requestWindow,
      explicit.checkpoint ?? als.checkpoint,
    ),
    httpStatus: explicit.httpStatus ?? als.httpStatus ?? null,
    bodyKind: explicit.bodyKind ?? als.bodyKind ?? null,
    bodyRef: explicit.bodyRef ?? als.bodyRef ?? null,
    payloadText: explicit.payloadText ?? als.payloadText ?? null,
  };
}

/**
 * Map Entity.entityType → normalized resource key (endpoint/resource identity).
 * Prefer adapter metadata.resourceKey when provided; never invent fake URLs.
 */
export function resolveResourceKey(entityType, metadata = null) {
  if (metadata?.resourceKey) return String(metadata.resourceKey).trim().toLowerCase();
  if (metadata?.endpoint) return String(metadata.endpoint).trim().toLowerCase();
  const type = String(entityType ?? "unknown").trim().toLowerCase();
  const map = {
    campaign: "campaigns",
    coupon: "coupons",
    conversion: "conversions",
    payment: "payments",
    invoice: "invoices",
    product: "products",
    click: "clicks",
    reporting: "reporting",
  };
  return map[type] || type || "unknown";
}

export function resolveMapperVersion(networkSource, entityType, metadata = null) {
  if (metadata?.mapperVersion) return String(metadata.mapperVersion);
  const source = String(networkSource ?? "").toLowerCase();
  if (source.startsWith("optimise")) return "optimise-mapper@1";
  if (source === "boostiny") return "boostiny-mapper@1";
  if (source === "trackier") return "trackier-mapper@1";
  if (source === "partnerize") return "partnerize-mapper@1";
  if (source === "impact") return "impact-mapper@1";
  return `${entityType || "entity"}-mapper@1`;
}

/**
 * Append-only RawPayload persist.
 * Identical (supplier, account, resource, externalId, hash) → return existing (DUPLICATE semantics).
 * Different hash for same identity → new row (lineage preserved).
 * Mapping/status/entity-link updates never touch payload, payloadHash, bodyRef, or payloadText.
 */
export async function persistRawPayload(
  {
    networkSource,
    entityType,
    externalId,
    payload,
    entityId = null,
    fetchedAt = null,
    metadata = null,
    mapperVersion = null,
    processingStatus = "STAGED",
    network = null,
    networkAccountId = null,
    sourceObject = null,
    endpointOrReport = null,
    apiVersion = null,
    syncRunId = null,
    requestWindow = null,
    checkpoint = null,
    httpStatus = null,
    bodyKind = null,
    bodyRef = null,
    payloadText = null,
  },
  client = null,
) {
  const db = client ?? prisma;
  if (!db?.rawPayload?.create) {
    return { record: null, created: false, skipped: true };
  }

  const evidence = mergeEvidence({
    network,
    networkAccountId,
    sourceObject,
    endpointOrReport,
    apiVersion,
    syncRunId,
    fetchedAt,
    requestWindow,
    checkpoint,
    httpStatus,
    bodyKind,
    bodyRef,
    payloadText,
  });
  const body = resolveBody(payload, evidence);
  const { supplier, supplierRegion } = parseNetworkSource(networkSource);
  const { sourceAccountLabel } = parseSourceAccountLabel(externalId);
  const resourceKey = resolveResourceKey(entityType, metadata);
  const payloadHash = hashRawBody(body);
  const version = mapperVersion ?? resolveMapperVersion(networkSource, entityType, metadata);
  const networkValue = evidence.network || (networkSource ? String(networkSource) : null);

  async function finalizeOutcome(outcome) {
    try {
      await observeSourceSchemaFromPersist(
        {
          network: networkValue,
          networkSource,
          sourceObject: evidence.sourceObject || resourceKey,
          entityType,
          resourceKey,
          body,
          apiVersion: evidence.apiVersion,
          incrementOccurrence: Boolean(outcome?.created),
        },
        db,
      );
    } catch {
      // Source schema registry must not block immutable raw lineage.
    }
    return outcome;
  }

  const existing = await db.rawPayload.findUnique({
    where: {
      supplier_sourceAccountLabel_resourceKey_externalId_payloadHash: {
        supplier,
        sourceAccountLabel,
        resourceKey,
        externalId: String(externalId),
        payloadHash,
      },
    },
  }).catch(() => null);

  if (existing) {
    if (entityId && !existing.entityId) {
      try {
        const updated = await db.rawPayload.update({
          where: { id: existing.id },
          data: {
            entityId,
            processingStatus:
              existing.processingStatus === "RECEIVED" ? "STAGED" : existing.processingStatus,
          },
        });
        return finalizeOutcome({ record: updated, created: false, duplicate: true });
      } catch {
        return finalizeOutcome({ record: existing, created: false, duplicate: true });
      }
    }
    return finalizeOutcome({ record: existing, created: false, duplicate: true });
  }

  try {
    const record = await db.rawPayload.create({
      data: buildCreateData(),
    });
    return finalizeOutcome({ record, created: true, duplicate: false });
  } catch (error) {
    if (error?.code === "P2002") {
      const raced = await db.rawPayload.findUnique({
        where: {
          supplier_sourceAccountLabel_resourceKey_externalId_payloadHash: {
            supplier,
            sourceAccountLabel,
            resourceKey,
            externalId: String(externalId),
            payloadHash,
          },
        },
      });
      return finalizeOutcome({ record: raced, created: false, duplicate: true });
    }
    if (error?.code === "P2003") {
      try {
        const record = await db.rawPayload.create({
          data: { ...buildCreateData(), networkAccountId: null, syncRunId: null },
        });
        return finalizeOutcome({ record, created: true, duplicate: false });
      } catch {
        return finalizeOutcome({ record: null, created: false, skipped: true, error });
      }
    }
    return finalizeOutcome({ record: null, created: false, skipped: true, error });
  }

  function buildCreateData() {
    return {
      supplier,
      supplierRegion,
      sourceAccountLabel,
      resourceKey,
      entityType: String(entityType),
      externalId: String(externalId),
      payload: body.payload,
      payloadHash,
      fetchedAt: evidence.fetchedAt ? new Date(evidence.fetchedAt) : null,
      mapperVersion: version,
      processingStatus,
      networkSource: networkSource ? String(networkSource) : null,
      entityId,
      metadata: metadata ?? undefined,
      network: networkValue,
      networkAccountId: evidence.networkAccountId || null,
      sourceObject: evidence.sourceObject || null,
      endpointOrReport: evidence.endpointOrReport || null,
      apiVersion: evidence.apiVersion || null,
      syncRunId: evidence.syncRunId || null,
      requestWindow: evidence.requestWindow || undefined,
      httpStatus: Number.isFinite(Number(evidence.httpStatus)) ? Number(evidence.httpStatus) : null,
      bodyKind: body.bodyKind,
      bodyRef: body.bodyRef,
      payloadText: body.payloadText,
    };
  }
}

/**
 * Latest RawPayload for an Entity (by receivedAt).
 */
export async function findLatestRawPayloadForEntity(entityId, client = null) {
  const db = client ?? prisma;
  if (!db?.rawPayload?.findFirst || !entityId) return null;
  try {
    return await db.rawPayload.findFirst({
      where: { entityId },
      orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
    });
  } catch {
    return null;
  }
}

/**
 * Persist immutable raw payloads. Call this before Entity staging / mapping.
 * Per-row failures are isolated unless required is true.
 */
export async function persistRawPayloadsForPreparedRecords(
  preparedRecords,
  { metadata = null, required = false, evidence = null } = {},
) {
  const results = [];
  for (const record of preparedRecords) {
    try {
      const outcome = await persistRawPayload({
        networkSource: record.networkSource,
        entityType: record.entityType,
        externalId: record.externalId,
        payload: record.rawData,
        metadata,
        processingStatus: "RECEIVED",
        ...(evidence || {}),
      });
      if (required && !outcome?.record?.id) {
        const err = new Error("Immutable raw payload was not stored");
        err.code = "RAW_PAYLOAD_REQUIRED";
        err.outcome = outcome;
        throw err;
      }
      results.push(outcome);
    } catch (error) {
      if (required) throw error;
      results.push({ record: null, created: false, failed: true, error });
    }
  }
  return results;
}
