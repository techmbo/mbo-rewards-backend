/**
 * Pointer 7 — field-level mapping outcome taxonomy.
 * Never use a generic NOT_MAPPED bucket.
 */

export const FIELD_MAPPING_OUTCOME = Object.freeze({
  MAPPED: "MAPPED",
  SOURCE_ONLY: "SOURCE_ONLY",
  SOURCE_PRESENT_MAPPING_MISSING: "SOURCE_PRESENT_MAPPING_MISSING",
  TRANSFORM_FAILED: "TRANSFORM_FAILED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  SOURCE_NULL: "SOURCE_NULL",
  CONDITIONAL: "CONDITIONAL",
  NOT_SUPPORTED: "NOT_SUPPORTED",
  MBO_DERIVED: "MBO_DERIVED",
  MANUAL_REQUIRED: "MANUAL_REQUIRED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  VERIFY_LIVE: "VERIFY_LIVE",
});

export const ENGINEERING_DEFECT_OUTCOMES = Object.freeze([
  FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING,
]);

const OUTCOME_LABELS = Object.freeze({
  MAPPED: "Mapped",
  SOURCE_ONLY: "Source Only",
  SOURCE_PRESENT_MAPPING_MISSING: "Mapping Missing",
  TRANSFORM_FAILED: "Transform Failed",
  VALIDATION_FAILED: "Validation Failed",
  SOURCE_NULL: "Source Null",
  CONDITIONAL: "Conditional",
  NOT_SUPPORTED: "Not Supported",
  MBO_DERIVED: "MBO Derived",
  MANUAL_REQUIRED: "Manual Required",
  REVIEW_REQUIRED: "Review Required",
  VERIFY_LIVE: "Verify Live",
});

export function normalizeFieldMappingOutcome(value) {
  if (value == null || value === "") return null;
  const key = String(value).trim().toUpperCase();
  return FIELD_MAPPING_OUTCOME[key] || null;
}

export function isValidFieldMappingOutcome(value) {
  return Boolean(normalizeFieldMappingOutcome(value));
}

export function isEngineeringDefect(outcome) {
  return ENGINEERING_DEFECT_OUTCOMES.includes(normalizeFieldMappingOutcome(outcome));
}

export function fieldMappingOutcomeLabel(outcome) {
  const key = normalizeFieldMappingOutcome(outcome);
  return key ? OUTCOME_LABELS[key] || key : "—";
}

export function parseDeclaredOutcomeFromField(field = {}) {
  const raw = field.outcome ?? field.mappingOutcome ?? field.fieldMappingOutcome ?? null;
  return normalizeFieldMappingOutcome(raw);
}

export function parseDeclaredOutcomeFromNotes(notes) {
  const text = String(notes || "");
  if (/verify\s*live|unverified\s*live/i.test(text)) return FIELD_MAPPING_OUTCOME.VERIFY_LIVE;
  if (/source\s*only|evidence\s*only/i.test(text)) return FIELD_MAPPING_OUTCOME.SOURCE_ONLY;
  if (/mbo\s*derived|derived\s*by\s*mbo/i.test(text)) return FIELD_MAPPING_OUTCOME.MBO_DERIVED;
  if (/manual\s*required|ops\/finance/i.test(text)) return FIELD_MAPPING_OUTCOME.MANUAL_REQUIRED;
  if (/not\s*supported|api\s*does\s*not/i.test(text)) return FIELD_MAPPING_OUTCOME.NOT_SUPPORTED;
  if (/conditional|only\s*some\s*campaigns/i.test(text)) return FIELD_MAPPING_OUTCOME.CONDITIONAL;
  if (/review\s*required|ambiguous/i.test(text)) return FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED;
  return null;
}

/**
 * Classify an observed schema path (no per-record map run).
 */
export function resolveObservedPathOutcome({
  mboTarget = null,
  required = false,
  sampleValue = null,
  declaredOutcome = null,
  hasSample = null,
} = {}) {
  const declared = normalizeFieldMappingOutcome(declaredOutcome);
  if (declared) return declared;

  if (mboTarget) return FIELD_MAPPING_OUTCOME.MAPPED;

  const samplePresent =
    hasSample ??
    (sampleValue != null && sampleValue !== "" && sampleValue !== "null" && sampleValue !== "[]");

  if (samplePresent && required) {
    return FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING;
  }

  if (samplePresent) {
    return FIELD_MAPPING_OUTCOME.SOURCE_ONLY;
  }

  return FIELD_MAPPING_OUTCOME.SOURCE_ONLY;
}

export function resolveMapErrorOutcome(error = {}) {
  const code = String(error.code || "").toUpperCase();
  const reason = String(error.reason || "").toLowerCase();

  if (code === "MAPPING_REQUIRED_FIELD_MISSING") {
    const raw = error.sourceValue;
    if (raw === null || raw === undefined || raw === "") {
      return FIELD_MAPPING_OUTCOME.SOURCE_NULL;
    }
    return FIELD_MAPPING_OUTCOME.VALIDATION_FAILED;
  }

  if (code === "MAPPING_UNKNOWN_ENUM") return FIELD_MAPPING_OUTCOME.TRANSFORM_FAILED;
  if (code === "MAPPING_INVALID_VALUE") {
    if (reason === "required" || reason === "min" || reason === "max" || reason === "pattern") {
      return FIELD_MAPPING_OUTCOME.VALIDATION_FAILED;
    }
    return FIELD_MAPPING_OUTCOME.TRANSFORM_FAILED;
  }

  if (code === "MAPPING_UNMAPPED_CRITICAL_FIELD") {
    const raw = error.sourceValue;
    if (raw === null || raw === undefined || raw === "") {
      return FIELD_MAPPING_OUTCOME.SOURCE_NULL;
    }
    return FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING;
  }

  return FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED;
}

export function resolveFieldResultOutcome(fieldResult = {}) {
  if (fieldResult.fieldMappingOutcome) {
    return normalizeFieldMappingOutcome(fieldResult.fieldMappingOutcome);
  }
  if (fieldResult.success) return FIELD_MAPPING_OUTCOME.MAPPED;
  return resolveMapErrorOutcome(fieldResult);
}

export function resolveUnmappedPathOutcome(sourceValue, { critical = false } = {}) {
  const empty = sourceValue === null || sourceValue === undefined || sourceValue === "";
  if (empty) return FIELD_MAPPING_OUTCOME.SOURCE_NULL;
  if (critical) return FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING;
  return FIELD_MAPPING_OUTCOME.SOURCE_ONLY;
}
