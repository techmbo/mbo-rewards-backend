import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";

const ENTITY_BATCH_SIZE = Number(process.env.SYNC_ENTITY_BATCH_SIZE || 100);

/**
 * The key Postgres enforces, and therefore the only key a de-duplication may use.
 * Mirrors Entity's @@unique([externalId, networkSource, entityType]).
 */
export function entityConflictKey(record) {
  return [record.externalId, record.networkSource, record.entityType].join("\u0000");
}

/**
 * Collapse records that would conflict with each other inside one INSERT.
 *
 * "ON CONFLICT DO UPDATE command cannot affect row a second time" is raised when a single
 * statement proposes the same constrained values twice, so two identical keys in one chunk abort
 * the whole statement. Chunking made that positional: the same pair of rows failed at positions
 * 98 and 99 and succeeded at 99 and 100, where the chunk boundary split them into separate
 * statements. Collapsing before chunking removes the positional behaviour entirely.
 *
 * The last record for a key wins, which is what a sequence of prisma.entity.upsert calls left
 * behind and what separate INSERT statements in row order would have left behind. The survivor
 * keeps the first occurrence's position so the batch order stays deterministic.
 */
export function dedupeEntityRecords(records) {
  const byKey = new Map();
  for (const record of records) {
    const key = entityConflictKey(record);
    const existing = byKey.get(key);
    if (existing) existing.record = record;
    else byKey.set(key, { record });
  }
  const deduped = [...byKey.values()].map((entry) => entry.record);
  return { records: deduped, duplicatesCollapsed: records.length - deduped.length };
}

/**
 * Bulk INSERT … ON CONFLICT for non-coupon entities.
 * Preserves unique (externalId, networkSource, entityType) and update semantics of prisma.entity.upsert.
 */
export async function batchUpsertEntities(records, { db = prisma } = {}) {
  if (!records.length) {
    return { count: 0, batchMs: 0, duplicatesCollapsed: 0 };
  }

  const startedAt = Date.now();
  // Before chunking, so a conflicting pair can never be split across two statements and pass.
  const { records: unique, duplicatesCollapsed } = dedupeEntityRecords(records);
  let count = 0;

  for (let offset = 0; offset < unique.length; offset += ENTITY_BATCH_SIZE) {
    const chunk = unique.slice(offset, offset + ENTITY_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    await executeBatchUpsert(chunk, db);
    count += chunk.length;
  }

  return { count, batchMs: Date.now() - startedAt, duplicatesCollapsed };
}

async function executeBatchUpsert(records, db = prisma) {
  const now = new Date();
  const tuples = records.map((record) => {
    const id = randomUUID();
    return Prisma.sql`(
      ${id}::uuid,
      ${record.externalId},
      ${record.networkSource},
      ${record.entityType},
      ${record.entityName},
      ${record.campaignName},
      ${record.advertiserName},
      ${record.entityStatus},
      ${record.entitySubType},
      ${record.code},
      ${record.discount},
      ${record.revenue},
      ${record.commission},
      ${record.eventDate},
      ${JSON.stringify(record.normalizedData ?? {})}::jsonb,
      ${JSON.stringify(record.rawData ?? {})}::jsonb,
      ${now}
    )`;
  });

  await db.$executeRaw`
    INSERT INTO "Entity" (
      "id",
      "externalId",
      "networkSource",
      "entityType",
      "entityName",
      "campaignName",
      "advertiserName",
      "entityStatus",
      "entitySubType",
      "code",
      "discount",
      "revenue",
      "commission",
      "eventDate",
      "normalizedData",
      "rawData",
      "updatedAt"
    )
    VALUES ${Prisma.join(tuples)}
    ON CONFLICT ("externalId", "networkSource", "entityType")
    DO UPDATE SET
      "entityName" = EXCLUDED."entityName",
      "campaignName" = EXCLUDED."campaignName",
      "advertiserName" = EXCLUDED."advertiserName",
      "entityStatus" = EXCLUDED."entityStatus",
      "entitySubType" = EXCLUDED."entitySubType",
      "code" = EXCLUDED."code",
      "discount" = EXCLUDED."discount",
      "revenue" = EXCLUDED."revenue",
      "commission" = EXCLUDED."commission",
      "eventDate" = EXCLUDED."eventDate",
      "normalizedData" = EXCLUDED."normalizedData",
      "rawData" = EXCLUDED."rawData",
      "updatedAt" = EXCLUDED."updatedAt"
  `;
}
