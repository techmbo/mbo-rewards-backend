import { createHash } from "node:crypto";
import { prisma } from "../../database/prisma.js";
import { parseNetworkSource, parseSourceAccountLabel } from "../supplier/entityIdentity.js";

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
  },
  client = null,
) {
  const db = client ?? prisma;
  if (!db?.rawPayload?.create) {
    // Schema not migrated / client not generated — no-op for safety in partial envs.
    return { record: null, created: false, skipped: true };
  }

  const { supplier, supplierRegion } = parseNetworkSource(networkSource);
  const { sourceAccountLabel } = parseSourceAccountLabel(externalId);
  const resourceKey = resolveResourceKey(entityType, metadata);
  const payloadHash = hashPayload(payload);
  const version = mapperVersion ?? resolveMapperVersion(networkSource, entityType, metadata);

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
    // Optionally refresh entity linkage without mutating payload.
    if (entityId && !existing.entityId) {
      try {
        const updated = await db.rawPayload.update({
          where: { id: existing.id },
          data: { entityId, processingStatus: existing.processingStatus === "RECEIVED" ? "STAGED" : existing.processingStatus },
        });
        return { record: updated, created: false, duplicate: true };
      } catch {
        return { record: existing, created: false, duplicate: true };
      }
    }
    return { record: existing, created: false, duplicate: true };
  }

  try {
    const record = await db.rawPayload.create({
      data: {
        supplier,
        supplierRegion,
        sourceAccountLabel,
        resourceKey,
        entityType: String(entityType),
        externalId: String(externalId),
        payload: payload ?? {},
        payloadHash,
        fetchedAt: fetchedAt ? new Date(fetchedAt) : null,
        mapperVersion: version,
        processingStatus,
        networkSource: networkSource ? String(networkSource) : null,
        entityId,
        metadata: metadata ?? undefined,
      },
    });
    return { record, created: true, duplicate: false };
  } catch (error) {
    // Race on unique constraint → treat as duplicate.
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
      return { record: raced, created: false, duplicate: true };
    }
    // Migration not applied / table missing — do not block sync.
    return { record: null, created: false, skipped: true, error };
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
    // Table may not exist until Wave B migration is applied.
    return null;
  }
}

/**
 * Batch-record raw payloads after Entity staging. Failures are isolated per row.
 */
export async function persistRawPayloadsForPreparedRecords(preparedRecords, { metadata = null } = {}) {
  const results = [];
  for (const record of preparedRecords) {
    try {
      const outcome = await persistRawPayload({
        networkSource: record.networkSource,
        entityType: record.entityType,
        externalId: record.externalId,
        payload: record.rawData,
        metadata,
      });
      results.push(outcome);
    } catch {
      results.push({ record: null, created: false, failed: true });
    }
  }
  return results;
}
