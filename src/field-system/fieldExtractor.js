import { computeSchemaSignature } from "./schemaSignature.js";
import { getExtractionCache } from "./fieldSyncCache.js";

function detectType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function extractFieldsUncached(rawData, source, entityType) {
  const fields = new Map();

  function visit(value, path) {
    const dataType = detectType(value);
    if (path) {
      fields.set(`${source}::${entityType}::${path}`, {
        fieldPath: path,
        source,
        entityType,
        dataType,
      });
    }

    if (Array.isArray(value)) {
      value.forEach((item) => {
        const nextPath = path ? `${path}[]` : "[]";
        visit(item, nextPath);
      });
      return;
    }

    if (value && typeof value === "object") {
      Object.entries(value).forEach(([key, child]) => {
        const nextPath = path ? `${path}.${key}` : key;
        visit(child, nextPath);
      });
    }
  }

  visit(rawData, "");
  return Array.from(fields.values());
}

function buildExtractionCacheKey(source, entityType, schemaSignature) {
  return `${source}:${entityType}:${schemaSignature}`;
}

/**
 * Extract field paths from raw JSON, reusing results for identical schemas within a sync.
 */
export function extractFields(rawData, source, entityType) {
  const schemaSignature = computeSchemaSignature(rawData ?? {});
  const cacheKey = buildExtractionCacheKey(source, entityType, schemaSignature);
  const cache = getExtractionCache();

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const fields = extractFieldsUncached(rawData ?? {}, source, entityType);
  cache.set(cacheKey, fields);
  return fields;
}
