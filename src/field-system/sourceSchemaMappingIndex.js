import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { NETWORK_MAPPINGS_ROOT } from "../modules/mapping/loader.js";
import { networkFamily } from "../modules/networkOps/sourceObjects.catalog.js";
import { resolveObservedPathOutcome } from "../modules/mapping/mappingOutcome.contract.js";

/** @type {Map<string, string> | null} */
let INDEX = null;

function mappingIndexKey(supplier, resourceKey, sourcePath) {
  return `${String(supplier).toLowerCase()}::${String(resourceKey).toLowerCase()}::${sourcePath}`;
}

function collectSourcePathsFromField(field, out) {
  if (field.sourcePath) out.add(String(field.sourcePath));
  for (const path of field.sources || field.paths || []) {
    out.add(String(path));
  }
}

export function buildSourceSchemaMappingIndex({ root = NETWORK_MAPPINGS_ROOT } = {}) {
  const index = new Map();
  if (!existsSync(root)) return index;

  for (const supplierDir of readdirSync(root, { withFileTypes: true })) {
    if (!supplierDir.isDirectory()) continue;
    const supplier = supplierDir.name.toLowerCase();
    const dir = join(root, supplier);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".mapping.json")) continue;
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const resourceKey = String(raw.resourceKey || file.split(".")[0]).toLowerCase();
      const fields = Array.isArray(raw.fields) ? raw.fields : [];
      for (const field of fields) {
        const targetField = field.targetField ?? field.target;
        if (!targetField) continue;
        const paths = new Set();
        collectSourcePathsFromField(field, paths);
        for (const sourcePath of paths) {
          index.set(mappingIndexKey(supplier, resourceKey, sourcePath), String(targetField));
        }
      }
    }
  }

  return index;
}

export function getSourceSchemaMappingIndex() {
  if (!INDEX) INDEX = buildSourceSchemaMappingIndex();
  return INDEX;
}

export function clearSourceSchemaMappingIndex() {
  INDEX = null;
}

export function lookupMboTarget({ network, sourceObject, sourcePath }) {
  const supplier = networkFamily(network);
  const resourceKey = String(sourceObject || "").toLowerCase();
  const index = getSourceSchemaMappingIndex();
  return index.get(mappingIndexKey(supplier, resourceKey, sourcePath)) || null;
}

export function resolveMappingStatus(mboTarget, { sampleValue = null, required = false } = {}) {
  return resolveObservedPathOutcome({ mboTarget, sampleValue, required });
}

/** @deprecated Use resolveMappingStatus — returns pointer-7 fieldMappingOutcome. */
export function resolveFieldMappingOutcome(mboTarget, options = {}) {
  return resolveMappingStatus(mboTarget, options);
}
