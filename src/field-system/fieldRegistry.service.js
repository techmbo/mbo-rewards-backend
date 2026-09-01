import { prisma } from "../database/prisma.js";
import { resolveSourceObjectKey } from "./resolveSourceObject.js";
import {
  lookupMboTarget,
  resolveMappingStatus,
} from "./sourceSchemaMappingIndex.js";

function toFieldDto(row, statsByKey) {
  const sourceObject = row.sourceObject || resolveSourceObjectKey({ entityType: row.entityType });
  const statsKey = `${row.source}::${sourceObject}`;
  const stats = statsByKey.get(statsKey);
  const total = stats?.totalPayloadsObserved ?? 0;
  const occurrenceRate =
    total > 0 && row.occurrenceCount != null ? Number(row.occurrenceCount) / total : null;
  const mboTarget = lookupMboTarget({
    network: row.source,
    sourceObject,
    sourcePath: row.fieldPath,
  });
  const fieldMappingOutcome = resolveMappingStatus(mboTarget, {
    sampleValue: row.sampleValue,
    required: Boolean(row.required),
  });

  return {
    ...row,
    networkSource: row.source,
    network: row.source,
    sourceObject,
    sourcePath: row.fieldPath,
    sourceType: row.dataType,
    observedExample: row.sampleValue,
    occurrenceRate,
    mboTarget,
    fieldMappingOutcome,
    mappingStatus: fieldMappingOutcome,
    evidence:
      row.lastSeenAt && row.firstSeenAt
        ? `seen ${row.occurrenceCount ?? 0}× · last ${String(row.lastSeenAt).slice(0, 10)}`
        : null,
  };
}

export async function listFields({ entityType, source, sourceObject, mappingStatus, page, pageSize }) {
  const where = {
    ...(entityType ? { entityType } : {}),
    ...(source ? { source } : {}),
    ...(sourceObject ? { sourceObject } : {}),
  };

  const filterByOutcome = Boolean(mappingStatus);
  const [allRows, dbTotal] = await Promise.all([
    filterByOutcome
      ? prisma.fieldRegistry.findMany({
          where,
          orderBy: [{ source: "asc" }, { sourceObject: "asc" }, { fieldPath: "asc" }],
        })
      : prisma.fieldRegistry.findMany({
          where,
          orderBy: [{ source: "asc" }, { sourceObject: "asc" }, { fieldPath: "asc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    prisma.fieldRegistry.count({ where }),
  ]);

  const statsKeys = [...new Set(allRows.map((row) => {
    const obj = row.sourceObject || resolveSourceObjectKey({ entityType: row.entityType });
    return { network: row.source, sourceObject: obj };
  }))];

  let statsByKey = new Map();
  if (statsKeys.length && prisma.sourceSchemaStats?.findMany) {
    const statsRows = await prisma.sourceSchemaStats.findMany({
      where: {
        OR: statsKeys.map(({ network, sourceObject: obj }) => ({ network, sourceObject: obj })),
      },
    });
    statsByKey = new Map(statsRows.map((s) => [`${s.network}::${s.sourceObject}`, s]));
  }

  let mapped = allRows.map((row) => toFieldDto(row, statsByKey));
  if (filterByOutcome) {
    const wanted = String(mappingStatus).toUpperCase();
    mapped = mapped.filter(
      (row) => (row.fieldMappingOutcome || row.mappingStatus) === wanted,
    );
  }

  const total = filterByOutcome ? mapped.length : dbTotal;
  const rows = filterByOutcome
    ? mapped.slice((page - 1) * pageSize, page * pageSize)
    : mapped;

  return {
    rows,
    total,
  };
}

/** @deprecated Schema observation runs from immutable raw payload persist. */
export async function upsertExtractedFields() {}
