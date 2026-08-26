function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toMapperErrorDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    entityId: record.entityId,
    supplier: record.supplier,
    entityType: record.entityType,
    errorCode: record.errorCode,
    message: record.message,
    stackTrace: record.stackTrace,
    mapperVersion: record.mapperVersion,
    status: record.status,
    attempts: record.attempts,
    createdAt: toIso(record.createdAt),
    resolvedAt: toIso(record.resolvedAt),
    entity: record.entity
      ? {
          id: record.entity.id,
          externalId: record.entity.externalId,
          networkSource: record.entity.networkSource,
          entityType: record.entity.entityType,
        }
      : undefined,
  };
}
