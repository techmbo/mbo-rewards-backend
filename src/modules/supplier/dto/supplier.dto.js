function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toSupplierDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    key: record.key,
    displayName: record.displayName,
    status: record.status,
    config: record.config,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}
