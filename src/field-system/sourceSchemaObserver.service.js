import { prisma } from "../database/prisma.js";
import { runWithConcurrency } from "../core/concurrency.js";
import { observeSourceFields } from "./fieldExtractor.js";
import { computeSchemaSignature } from "./schemaSignature.js";
import {
  normalizeRegistryNetwork,
  resolveSourceObjectKey,
} from "./resolveSourceObject.js";

const FIELD_UPSERT_CONCURRENCY = 25;

function aggregateObservations(payloads) {
  const byPath = new Map();
  let fingerprint = null;

  for (const payload of payloads) {
    if (!payload || typeof payload !== "object") continue;
    fingerprint = computeSchemaSignature(payload);
    for (const field of observeSourceFields(payload)) {
      const prev = byPath.get(field.fieldPath);
      if (prev) {
        prev.occurrenceDelta += 1;
        if (!prev.sampleValue && field.sampleValue) prev.sampleValue = field.sampleValue;
      } else {
        byPath.set(field.fieldPath, { ...field, occurrenceDelta: 1 });
      }
    }
  }

  return { byPath, fingerprint };
}

async function upsertStats(db, { network, sourceObject, fingerprint, apiVersion, payloadDelta, now }) {
  if (!db?.sourceSchemaStats?.upsert) return null;

  return db.sourceSchemaStats.upsert({
    where: {
      network_sourceObject: {
        network,
        sourceObject,
      },
    },
    create: {
      network,
      sourceObject,
      totalPayloadsObserved: Math.max(payloadDelta, 0),
      schemaFingerprint: fingerprint,
      apiVersion: apiVersion || null,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    update: {
      ...(payloadDelta > 0 ? { totalPayloadsObserved: { increment: payloadDelta } } : {}),
      schemaFingerprint: fingerprint || undefined,
      apiVersion: apiVersion || undefined,
      lastSeenAt: now,
    },
  });
}

async function upsertObservedFields(
  db,
  {
    network,
    sourceObject,
    entityType,
    byPath,
    fingerprint,
    apiVersion,
    incrementOccurrence,
    now,
  },
) {
  if (!db?.fieldRegistry?.upsert || !byPath.size) return;

  const rows = [...byPath.values()];
  await runWithConcurrency(rows, FIELD_UPSERT_CONCURRENCY, async (field) => {
    const occurrenceDelta = incrementOccurrence ? field.occurrenceDelta || 1 : 0;
    await db.fieldRegistry.upsert({
      where: {
        fieldPath_source_sourceObject: {
          fieldPath: field.fieldPath,
          source: network,
          sourceObject,
        },
      },
      create: {
        fieldPath: field.fieldPath,
        source: network,
        sourceObject,
        entityType,
        dataType: field.sourceType,
        nullable: field.nullable,
        isArray: field.isArray,
        isObject: field.isObject,
        sampleValue: field.sampleValue,
        occurrenceCount: occurrenceDelta,
        schemaFingerprint: fingerprint,
        apiVersion: apiVersion || null,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        entityType,
        dataType: field.sourceType,
        nullable: field.nullable,
        isArray: field.isArray,
        isObject: field.isObject,
        sampleValue: field.sampleValue || undefined,
        schemaFingerprint: fingerprint || undefined,
        apiVersion: apiVersion || undefined,
        lastSeenAt: now,
        ...(occurrenceDelta > 0 ? { occurrenceCount: { increment: occurrenceDelta } } : {}),
      },
    });
  });
}

/**
 * Observe one or more immutable raw JSON payloads into the source schema registry.
 * Identity: network + source_object + source_path.
 */
export async function observeSourceSchema(
  {
    network,
    sourceObject = null,
    entityType = "unknown",
    resourceKey = null,
    payloads = [],
    apiVersion = null,
    incrementOccurrence = true,
  },
  client = null,
) {
  const db = client ?? prisma;
  const list = Array.isArray(payloads) ? payloads.filter(Boolean) : [];
  if (!list.length) return;

  const networkKey = normalizeRegistryNetwork(network);
  const resolvedSourceObject = resolveSourceObjectKey({ sourceObject, entityType, resourceKey, network: networkKey });
  const { byPath, fingerprint } = aggregateObservations(list);
  if (!byPath.size) return;

  const now = new Date();
  const payloadDelta = incrementOccurrence ? list.length : 0;

  await upsertStats(db, {
    network: networkKey,
    sourceObject: resolvedSourceObject,
    fingerprint,
    apiVersion,
    payloadDelta,
    now,
  });

  await upsertObservedFields(db, {
    network: networkKey,
    sourceObject: resolvedSourceObject,
    entityType: String(entityType || "unknown"),
    byPath,
    fingerprint,
    apiVersion,
    incrementOccurrence,
    now,
  });
}

export function resolvePayloadForObservation(body = {}) {
  if (body?.payload && typeof body.payload === "object") return body.payload;
  if (body?.payloadText) {
    try {
      const parsed = JSON.parse(String(body.payloadText));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Non-blocking hook from immutable raw payload persist.
 */
export async function observeSourceSchemaFromPersist(
  {
    network,
    networkSource,
    sourceObject,
    entityType,
    resourceKey,
    body,
    apiVersion,
    incrementOccurrence = true,
  },
  client = null,
) {
  const payload = resolvePayloadForObservation(body);
  if (!payload) return;

  await observeSourceSchema(
    {
      network: network || networkSource,
      sourceObject,
      entityType,
      resourceKey,
      payloads: [payload],
      apiVersion,
      incrementOccurrence,
    },
    client,
  );
}
