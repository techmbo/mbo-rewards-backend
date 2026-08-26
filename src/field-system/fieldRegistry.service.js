import { prisma } from "../database/prisma.js";
import { runWithConcurrency } from "../core/concurrency.js";

const FIELD_UPSERT_CONCURRENCY = 25;

function fieldKey(field) {
  return `${field.fieldPath}|${field.source}|${field.entityType}`;
}

/**
 * Phase 8 — skip registry writes when schema paths already exist with the same type.
 */
async function filterNewOrChangedFields(fields) {
  if (!fields.length) return [];

  const uniqueByKey = new Map();
  for (const field of fields) {
    uniqueByKey.set(fieldKey(field), field);
  }
  const deduped = [...uniqueByKey.values()];

  const existing = await prisma.fieldRegistry.findMany({
    where: {
      OR: deduped.map((field) => ({
        fieldPath: field.fieldPath,
        source: field.source,
        entityType: field.entityType,
      })),
    },
    select: {
      fieldPath: true,
      source: true,
      entityType: true,
      dataType: true,
    },
  });

  const existingByKey = new Map(existing.map((row) => [fieldKey(row), row]));

  return deduped.filter((field) => {
    const existingRow = existingByKey.get(fieldKey(field));
    if (!existingRow) return true;
    return existingRow.dataType !== field.dataType;
  });
}

export async function upsertExtractedFields(fields) {
  const toUpsert = await filterNewOrChangedFields(fields);
  if (!toUpsert.length) return;

  await runWithConcurrency(toUpsert, FIELD_UPSERT_CONCURRENCY, async (field) => {
    await prisma.fieldRegistry.upsert({
      where: {
        fieldPath_source_entityType: {
          fieldPath: field.fieldPath,
          source: field.source,
          entityType: field.entityType,
        },
      },
      create: {
        fieldPath: field.fieldPath,
        source: field.source,
        entityType: field.entityType,
        dataType: field.dataType,
      },
      update: {
        dataType: field.dataType,
      },
    });
  });
}

export async function listFields({ entityType, source, page, pageSize }) {
  const where = {
    ...(entityType ? { entityType } : {}),
    ...(source ? { source } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.fieldRegistry.findMany({
      where,
      orderBy: [{ fieldPath: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.fieldRegistry.count({ where }),
  ]);

  return { rows, total };
}
