import { loadMappingDefinition } from "./loader.js";
import { applyTransform, getValueAtPath, setValueAtPath } from "./transforms.js";
import { resolveLoaderMappingVersion } from "./mappingRegistry.contract.js";
import { attachFieldMappingOutcomes } from "./mappingOutcome.resolver.js";

/**
 * Config-driven Mapping Engine (Wave E).
 *
 * Mapping definition shape:
 * {
 *   supplier, resourceKey, mappingVersion,
 *   fields: [{ sourcePath, targetField, transform, required, default, validation, critical }],
 *   criticalUnmapped?: string[]  // source paths that must be mapped
 * }
 */

function collectSourcePaths(obj, prefix = "", out = new Set()) {
  if (obj == null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    out.add(prefix || "[]");
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      collectSourcePaths(v, path, out);
    }
  }
  return out;
}

function validateValue(value, validation = {}) {
  if (!validation || typeof validation !== "object") return null;
  if (validation.required && (value === undefined || value === null || value === "")) {
    return "required";
  }
  if (value == null || value === "") return null;
  if (validation.min != null && Number(value) < Number(validation.min)) return "min";
  if (validation.max != null && Number(value) > Number(validation.max)) return "max";
  if (validation.pattern) {
    const re = new RegExp(validation.pattern);
    if (!re.test(String(value))) return "pattern";
  }
  return null;
}

/**
 * Map a single payload object using a loaded definition.
 */
export function mapWithDefinition(payload, definition, { mutateSource = false } = {}) {
  const source = mutateSource ? payload : structuredClone(payload ?? {});
  const normalizedData = {};
  const warnings = [];
  const errors = [];
  const mappedSourcePaths = new Set();
  const fieldResults = [];

  const fields = Array.isArray(definition.fields) ? definition.fields : [];

  for (const field of fields) {
    const sourcePath = field.sourcePath ?? field.source ?? null;
    const targetField = field.targetField ?? field.target;
    if (!targetField) {
      errors.push({ code: "MAPPING_INVALID_VALUE", message: "field missing targetField", field });
      continue;
    }

    let rawValue;
    if (field.transform === "COALESCE" || field.transform === "CONCAT") {
      rawValue = null;
      for (const p of field.sources || field.paths || []) {
        mappedSourcePaths.add(p);
        const parts = String(p).split(".");
        for (let i = 1; i < parts.length; i += 1) {
          mappedSourcePaths.add(parts.slice(0, i).join("."));
        }
      }
    } else if (sourcePath) {
      rawValue = getValueAtPath(source, sourcePath);
      mappedSourcePaths.add(sourcePath);
      // Also mark parent paths used
      const parts = String(sourcePath).split(".");
      for (let i = 1; i < parts.length; i += 1) {
        mappedSourcePaths.add(parts.slice(0, i).join("."));
      }
    } else if (Array.isArray(field.sources)) {
      rawValue = null;
      for (const p of field.sources) mappedSourcePaths.add(p);
    }

    let value;
    try {
      value = applyTransform(field.transform || "IDENTITY", rawValue, {
        ...(field.options || {}),
        ...(field.enumMap ? { map: field.enumMap } : {}),
        ...(field.allowed ? { allowed: field.allowed } : {}),
        paths: field.sources || field.paths || field.options?.paths,
        sources: field.sources || field.paths,
        separator: field.separator ?? field.options?.separator,
      }, { source });
    } catch (error) {
      const code = error.code || "MAPPING_INVALID_VALUE";
      const entry = {
        code,
        targetField,
        sourcePath,
        sourceValue: rawValue,
        reason: error.message,
      };
      errors.push(entry);
      fieldResults.push({ ...entry, success: false });
      continue;
    }

    if ((value === undefined || value === null || value === "") && field.default !== undefined) {
      value = field.default;
    }

    const required = Boolean(field.required);
    const validationError = validateValue(value, {
      ...(field.validation || {}),
      required,
    });

    if (validationError) {
      const entry = {
        code:
          validationError === "required"
            ? "MAPPING_REQUIRED_FIELD_MISSING"
            : "MAPPING_INVALID_VALUE",
        targetField,
        sourcePath,
        sourceValue: rawValue,
        reason: validationError,
      };
      if (required || field.critical) errors.push(entry);
      else warnings.push(entry);
      fieldResults.push({ ...entry, success: false });
      continue;
    }

    setValueAtPath(normalizedData, targetField, value);
    fieldResults.push({
      success: true,
      targetField,
      sourcePath,
      value,
      quality: field.quality || (required ? "REQUIRED" : "OPTIONAL"),
    });
  }

  const allSourcePaths = collectSourcePaths(source);
  const unmappedFields = [...allSourcePaths].filter((p) => !mappedSourcePaths.has(p));

  const criticalUnmapped = (definition.criticalUnmapped || []).filter((p) =>
    unmappedFields.includes(p),
  );
  for (const path of criticalUnmapped) {
    errors.push({
      code: "MAPPING_UNMAPPED_CRITICAL_FIELD",
      sourcePath: path,
      targetField: null,
      sourceValue: getValueAtPath(source, path),
      reason: "critical_unmapped",
    });
  }

  const success = errors.length === 0;

  return attachFieldMappingOutcomes(
    {
      success,
      normalizedData,
      warnings,
      errors,
      unmappedFields,
      mappingVersion: definition.mappingVersion || definition.version || "1",
      supplier: definition.supplier || null,
      resourceKey: definition.resourceKey || null,
      fieldResults,
      sourceUnchanged: !mutateSource,
    },
    source,
  );
}

/**
 * High-level map API.
 */
export function mapPayload({
  supplier,
  resourceKey,
  payload,
  mappingVersion = null,
  definition = null,
} = {}) {
  if (payload == null || typeof payload !== "object") {
    return {
      success: false,
      normalizedData: null,
      warnings: [],
      errors: [{ code: "MAPPING_INVALID_VALUE", reason: "payload_not_object" }],
      unmappedFields: [],
      mappingVersion: mappingVersion || null,
    };
  }

  let def = definition;
  try {
    if (!def) {
      const loaderVersion = resolveLoaderMappingVersion(mappingVersion);
      def = loadMappingDefinition(supplier, resourceKey, { version: loaderVersion });
    }
  } catch (error) {
    return {
      success: false,
      normalizedData: null,
      warnings: [],
      errors: [{ code: error.code || "MAPPING_NOT_FOUND", reason: error.message }],
      unmappedFields: [],
      mappingVersion: mappingVersion || null,
    };
  }

  return mapWithDefinition(payload, def, { mutateSource: false });
}

export { loadMappingDefinition };
