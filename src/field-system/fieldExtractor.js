import { computeSchemaSignature } from "./schemaSignature.js";
import { getExtractionCache } from "./fieldSyncCache.js";
import { sanitizeSampleValue } from "./sampleSanitizer.js";

function detectType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function observeFieldsUncached(rawData) {
  const fields = new Map();

  function visit(value, path) {
    const sourceType = detectType(value);
    const isArray = Array.isArray(value);
    const isObject = value !== null && typeof value === "object" && !isArray;

    if (path) {
      fields.set(path, {
        fieldPath: path,
        sourceType,
        nullable: value === null,
        isArray: isArray || path.endsWith("[]"),
        isObject,
        sampleValue: sanitizeSampleValue(value, { fieldPath: path }),
      });
    }

    if (isArray) {
      value.forEach((item) => {
        const nextPath = path ? `${path}[]` : "[]";
        visit(item, nextPath);
      });
      return;
    }

    if (isObject) {
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
 * Walk a raw JSON body and return observed paths with type/nullable/sample metadata.
 */
export function observeSourceFields(rawData) {
  return observeFieldsUncached(rawData ?? {});
}

function extractFieldsUncached(rawData, source, entityType) {
  return observeFieldsUncached(rawData).map((field) => ({
    fieldPath: field.fieldPath,
    source,
    entityType,
    dataType: field.sourceType,
  }));
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
