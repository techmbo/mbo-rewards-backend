import { NESTED_FIELD_RESOLVERS, NORMALIZED_FIELD_ALIASES } from "./fieldAliases.js";
import { computeSchemaSignature } from "./schemaSignature.js";
import { getLoggedFieldWarnings, getValidationCache } from "./fieldSyncCache.js";

const SYNTHETIC_FIELDS = new Set(["network_source", "code_type", "link", "display_value"]);

function hasMeaningfulValue(value) {
  return value !== null && value !== undefined && value !== "";
}

function findFirstValueForKey(obj, fieldName) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findFirstValueForKey(item, fieldName);
      if (hasMeaningfulValue(found)) return found;
    }
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(obj, fieldName)) {
    return obj[fieldName];
  }
  for (const value of Object.values(obj)) {
    const found = findFirstValueForKey(value, fieldName);
    if (hasMeaningfulValue(found)) return found;
  }
  return undefined;
}

function hasFieldNameAnywhere(obj, fieldName) {
  return hasMeaningfulValue(findFirstValueForKey(obj, fieldName));
}

function hasKnownRawSource(rawData, entityType, normalizedKey) {
  const nestedResolver = NESTED_FIELD_RESOLVERS[entityType]?.[normalizedKey];
  if (nestedResolver && hasMeaningfulValue(nestedResolver(rawData))) {
    return true;
  }

  const aliases = NORMALIZED_FIELD_ALIASES[entityType]?.[normalizedKey];
  if (aliases) {
    return aliases.some((alias) => hasMeaningfulValue(findFirstValueForKey(rawData, alias)));
  }

  return hasFieldNameAnywhere(rawData, normalizedKey);
}

function computeMismatches(rawData, normalizedData, entityType) {
  const mismatches = [];

  if (!normalizedData || typeof normalizedData !== "object") {
    return mismatches;
  }

  for (const [key, value] of Object.entries(normalizedData)) {
    if (!hasMeaningfulValue(value)) continue;
    if (SYNTHETIC_FIELDS.has(key)) continue;
    if (hasKnownRawSource(rawData, entityType, key)) continue;

    mismatches.push({
      field: key,
      message: `Normalized field "${key}" was not found in raw_data`,
    });
  }

  return mismatches;
}

function buildValidationCacheKey(networkSource, entityType, schemaSignature) {
  return `${networkSource}:${entityType}:${schemaSignature}`;
}

/**
 * Validate normalized fields against raw data with alias awareness and per-schema caching.
 */
export function validateFieldUsage(rawData, normalizedData, entityType = "unknown", networkSource = "unknown") {
  const schemaSignature = computeSchemaSignature(rawData ?? {});
  const cacheKey = buildValidationCacheKey(networkSource, entityType, schemaSignature);
  const cache = getValidationCache();

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const mismatches = computeMismatches(rawData, normalizedData, entityType);
  cache.set(cacheKey, mismatches);
  return mismatches;
}

/**
 * Log each unique field warning once per sync job.
 */
export function logFieldUsageWarnings(networkSource, entityType, mismatches) {
  if (!mismatches.length) return;

  const logged = getLoggedFieldWarnings();
  const toLog = [];

  for (const mismatch of mismatches) {
    const warningKey = `${networkSource}:${entityType}:${mismatch.field}`;
    if (logged.has(warningKey)) continue;
    logged.add(warningKey);
    toLog.push(mismatch);
  }

  if (toLog.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[field-usage] ${networkSource}:${entityType}`, toLog);
  }
}
