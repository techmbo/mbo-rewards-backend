import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const NETWORK_MAPPINGS_ROOT = join(__dirname, "../../network-mappings");

/** @type {Map<string, object>} */
const CACHE = new Map();

function cacheKey(supplier, resourceKey, version) {
  return `${String(supplier).toLowerCase()}::${String(resourceKey).toLowerCase()}::${version || "latest"}`;
}

/**
 * Load mapping definition JSON for supplier/resource.
 * Files: network-mappings/{supplier}/{resource}.v{N}.mapping.json
 *        network-mappings/{supplier}/{resource}.mapping.json
 */
export function loadMappingDefinition(supplier, resourceKey, { version = null, root = NETWORK_MAPPINGS_ROOT } = {}) {
  const key = cacheKey(supplier, resourceKey, version);
  if (CACHE.has(key)) return CACHE.get(key);

  const dir = join(root, String(supplier).toLowerCase());
  if (!existsSync(dir)) {
    const err = new Error(`No mapping directory for supplier ${supplier}`);
    err.code = "MAPPING_NOT_FOUND";
    throw err;
  }

  const resource = String(resourceKey).toLowerCase();
  let filePath = null;

  if (version) {
    const exact = join(dir, `${resource}.v${version}.mapping.json`);
    const alt = join(dir, `${resource}@${version}.mapping.json`);
    if (existsSync(exact)) filePath = exact;
    else if (existsSync(alt)) filePath = alt;
  }

  if (!filePath) {
    const preferred = join(dir, `${resource}.mapping.json`);
    if (existsSync(preferred)) {
      filePath = preferred;
    } else {
      const files = readdirSync(dir)
        .filter((f) => f.startsWith(`${resource}.`) && f.endsWith(".mapping.json"))
        .sort();
      filePath = files.length ? join(dir, files[files.length - 1]) : null;
    }
  }

  if (!filePath) {
    const err = new Error(`No mapping config for ${supplier}/${resourceKey}`);
    err.code = "MAPPING_NOT_FOUND";
    throw err;
  }

  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  if (!raw.mappingVersion) {
    raw.mappingVersion = raw.version || "1";
  }
  raw._filePath = filePath;
  CACHE.set(key, raw);
  if (!version) CACHE.set(cacheKey(supplier, resourceKey, raw.mappingVersion), raw);
  return raw;
}

export function clearMappingCache() {
  CACHE.clear();
}

export function listMappingFiles(supplier, { root = NETWORK_MAPPINGS_ROOT } = {}) {
  const dir = join(root, String(supplier).toLowerCase());
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".mapping.json"));
}
