/**
 * Per-sync caches for field validation, extraction, and deduplicated warnings.
 * Reset at the start of each sync job.
 */

const validationResultCache = new Map();
const extractionResultCache = new Map();
const loggedFieldWarnings = new Set();

export function resetFieldSyncCaches() {
  validationResultCache.clear();
  extractionResultCache.clear();
  loggedFieldWarnings.clear();
}

export function getValidationCache() {
  return validationResultCache;
}

export function getExtractionCache() {
  return extractionResultCache;
}

export function getLoggedFieldWarnings() {
  return loggedFieldWarnings;
}
