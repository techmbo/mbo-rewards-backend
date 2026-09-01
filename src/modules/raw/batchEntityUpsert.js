import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma.js";

const ENTITY_BATCH_SIZE = Number(process.env.SYNC_ENTITY_BATCH_SIZE || 100);

/**
 * Bulk INSERT … ON CONFLICT for non-coupon entities.
 * Preserves unique (externalId, networkSource, entityType) and update semantics of prisma.entity.upsert.
 */
export async function batchUpsertEntities(records) {
  if (!records.length) {
    return { count: 0, batchMs: 0 };
  }

  const startedAt = Date.now();
  let count = 0;

  for (let offset = 0; offset < records.length; offset += ENTITY_BATCH_SIZE) {
    const chunk = records.slice(offset, offset + ENTITY_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    await executeBatchUpsert(chunk);
    count += chunk.length;
  }

  return { count, batchMs: Date.now() - startedAt };
}

async function executeBatchUpsert(records) {
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

  await prisma.$executeRaw`
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
