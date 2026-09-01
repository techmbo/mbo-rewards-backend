import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { NETWORK_MAPPINGS_ROOT } from "./loader.js";
import { getSourceObject } from "../networkOps/sourceObjects.catalog.js";
import {
  buildMappingVersionId,
  classifyRuleType,
  inferMboTargetObject,
  inferVerificationStatus,
  MAPPING_RULE_STATUS,
  normalizeRegistryNetwork,
} from "./mappingRegistry.contract.js";
import {
  FIELD_MAPPING_OUTCOME,
  parseDeclaredOutcomeFromField,
  parseDeclaredOutcomeFromNotes,
} from "./mappingOutcome.contract.js";

function collectSourcePaths(field) {
  if (field.sourcePath) return [String(field.sourcePath)];
  const paths = field.sources || field.paths || [];
  if (paths.length) return paths.map(String);
  if (field.source) return [String(field.source)];
  if (field.path) return [String(field.path)];
  return [];
}

function buildRuleFromField({
  supplier,
  sourceObject,
  endpointOrReport,
  mappingVersion,
  definitionVersion,
  sourceFile,
  field,
  sourcePath,
  fallbackSourcePaths,
  lastUpdated,
}) {
  const mboCanonicalField = field.targetField || field.target || field.to;
  if (!mboCanonicalField || !sourcePath) return null;

  const quality = String(field.quality || "").toUpperCase();
  const notes = field.notes || null;
  const qa =
    quality === "REQUIRED" ||
    /verified|qa\s*yes|master:/i.test(String(notes || "")) ||
    Boolean(field.required && quality === "IMPORTANT");

  const catalogEntry = getSourceObject(supplier, sourceObject);
  const declaredObject = field.mboTargetObject || field.targetObject || null;
  const declaredOutcome =
    parseDeclaredOutcomeFromField(field) || parseDeclaredOutcomeFromNotes(notes);

  return {
    network: normalizeRegistryNetwork(supplier),
    networkAccountScope: "",
    networkProfile: "",
    sourceObject: String(sourceObject).toLowerCase(),
    endpointOrReport: endpointOrReport || null,
    sourcePath,
    sourceType: null,
    sampleRawValue: null,
    mboTargetObject: inferMboTargetObject(sourceObject, mboCanonicalField, {
      entityType: catalogEntry?.entityType ?? null,
      declaredObject,
    }),
    mboCanonicalField: String(mboCanonicalField),
    transform: field.transform || "IDENTITY",
    enumMap: field.enumMap ?? field.options?.map ?? undefined,
    fallbackSourcePaths: fallbackSourcePaths?.length ? fallbackSourcePaths : undefined,
    conditions: field.conditions ?? undefined,
    mappingStatus: MAPPING_RULE_STATUS.ACTIVE,
    fieldMappingOutcome: declaredOutcome || FIELD_MAPPING_OUTCOME.MAPPED,
    mappingVersion,
    definitionVersion,
    verificationStatus: inferVerificationStatus({
      required: Boolean(field.required),
      quality,
      notes,
      sampleRawValue: null,
      qa,
    }),
    sourceFile,
    required: Boolean(field.required),
    ruleType: classifyRuleType(sourceObject, sourcePath, mboCanonicalField, field.transform),
    notes,
    lastSyncedAt: lastUpdated ? new Date(lastUpdated) : new Date(),
  };
}

/**
 * Compile filesystem mapping JSON into registry rule rows (no DB).
 */
export function compileMappingRegistryFromFiles({ root = NETWORK_MAPPINGS_ROOT } = {}) {
  if (!existsSync(root)) return [];

  const compiled = [];
  const suppliers = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());

  for (const supplierDir of suppliers) {
    const supplier = supplierDir.name;
    const dir = join(root, supplier);
    const files = readdirSync(dir).filter((f) => f.endsWith(".mapping.json"));

    for (const file of files) {
      const fullPath = join(dir, file);
      let def;
      let lastUpdated = null;
      try {
        def = JSON.parse(readFileSync(fullPath, "utf8"));
        lastUpdated = statSync(fullPath).mtime.toISOString();
      } catch {
        continue;
      }

      const sourceObject = String(def.resourceKey || file.split(".")[0]).toLowerCase();
      const definitionVersion = String(def.mappingVersion || def.version || "1");
      const mappingVersion = buildMappingVersionId(supplier, sourceObject, definitionVersion);
      const endpointOrReport = def.endpoint || def.endpointOrReport || null;
      const sourceFile = `${supplier}/${file}`;
      const fields = Array.isArray(def.fields) ? def.fields : [];

      for (const field of fields) {
        const paths = collectSourcePaths(field);
        if (!paths.length) continue;
        const [primary, ...fallbacks] = paths;
        const rule = buildRuleFromField({
          supplier: def.supplier || supplier,
          sourceObject,
          endpointOrReport,
          mappingVersion,
          definitionVersion,
          sourceFile,
          field,
          sourcePath: primary,
          fallbackSourcePaths: fallbacks,
          lastUpdated,
        });
        if (rule) compiled.push(rule);

        for (const altPath of fallbacks) {
          const altRule = buildRuleFromField({
            supplier: def.supplier || supplier,
            sourceObject,
            endpointOrReport,
            mappingVersion,
            definitionVersion,
            sourceFile,
            field,
            sourcePath: altPath,
            fallbackSourcePaths: paths.filter((p) => p !== altPath),
            lastUpdated,
          });
          if (altRule) compiled.push(altRule);
        }
      }
    }
  }

  return compiled;
}

export function dedupeCompiledRules(rules) {
  const byKey = new Map();
  for (const rule of rules) {
    const key = [
      rule.network,
      rule.sourceObject,
      rule.sourcePath,
      rule.mappingVersion,
      rule.networkAccountScope,
      rule.networkProfile,
    ].join("|");
    byKey.set(key, rule);
  }
  return [...byKey.values()];
}
