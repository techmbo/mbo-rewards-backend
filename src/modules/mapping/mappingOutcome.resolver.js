import { getValueAtPath } from "./transforms.js";
import {
  FIELD_MAPPING_OUTCOME,
  isEngineeringDefect,
  normalizeFieldMappingOutcome,
  parseDeclaredOutcomeFromField,
  parseDeclaredOutcomeFromNotes,
  resolveFieldResultOutcome,
  resolveMapErrorOutcome,
  resolveObservedPathOutcome,
  resolveUnmappedPathOutcome,
} from "./mappingOutcome.contract.js";

export {
  FIELD_MAPPING_OUTCOME,
  isEngineeringDefect,
  normalizeFieldMappingOutcome,
  parseDeclaredOutcomeFromField,
  parseDeclaredOutcomeFromNotes,
  resolveFieldResultOutcome,
  resolveMapErrorOutcome,
  resolveObservedPathOutcome,
  resolveUnmappedPathOutcome,
};

export function attachFieldMappingOutcomes(mapResult, sourcePayload = null) {
  if (!mapResult || typeof mapResult !== "object") return mapResult;

  const fieldResults = (mapResult.fieldResults || []).map((entry) => ({
    ...entry,
    fieldMappingOutcome: resolveFieldResultOutcome(entry),
  }));

  const unmappedOutcomes = (mapResult.unmappedFields || []).map((sourcePath) => {
    const sourceValue =
      sourcePayload && typeof sourcePayload === "object"
        ? getValueAtPath(sourcePayload, sourcePath)
        : null;
    const critical = (mapResult.errors || []).some(
      (err) => err.sourcePath === sourcePath && err.code === "MAPPING_UNMAPPED_CRITICAL_FIELD",
    );
    return {
      sourcePath,
      sourceValue,
      fieldMappingOutcome: resolveUnmappedPathOutcome(sourceValue, { critical }),
    };
  });

  const defectCount = [
    ...fieldResults,
    ...unmappedOutcomes,
    ...(mapResult.errors || []).map((err) => ({
      fieldMappingOutcome: resolveMapErrorOutcome(err),
    })),
  ].filter((entry) => isEngineeringDefect(entry.fieldMappingOutcome)).length;

  return {
    ...mapResult,
    fieldResults,
    unmappedOutcomes,
    fieldMappingOutcomes: fieldResults,
    engineeringDefectCount: defectCount,
  };
}

export function enrichMapResult(mapResult, sourcePayload = null) {
  return attachFieldMappingOutcomes(mapResult, sourcePayload);
}