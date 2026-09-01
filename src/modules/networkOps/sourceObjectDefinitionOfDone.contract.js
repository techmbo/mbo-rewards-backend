/**
 * Pointer 26 — Definition of done for one adapter/source object.
 * A source object is not production-ready until every applicable criterion passes.
 */

export const CONTRACT_POINTER = 26;

export const SOURCE_OBJECT_DONE_STATUS = Object.freeze({
  PASSED: "passed",
  FAILED: "failed",
  NOT_APPLICABLE: "not_applicable",
  BLOCKED: "blocked",
});

/** Canonical production-readiness criteria (order matches contract). */
export const SOURCE_OBJECT_DONE_CRITERIA = Object.freeze([
  {
    key: "source_fixture_captured",
    label: "Real/sanitized source fixture captured",
    description: "A representative source API fixture exists for the scoped network + source object.",
  },
  {
    key: "raw_payload_retention_verified",
    label: "Raw payload retention verified",
    description: "Mapping does not mutate the source payload; raw fields remain available for replay.",
  },
  {
    key: "observed_schema_recorded",
    label: "Observed schema recorded",
    description: "Observed source paths are documented for the fixture-backed schema.",
  },
  {
    key: "mapping_rules_versioned",
    label: "Exact mapping rules versioned",
    description: "Approved mapping rules exist in the versioned mapping registry for this object.",
  },
  {
    key: "required_mbo_fields_populated",
    label: "Required MBO fields populated correctly",
    description: "Required canonical fields map successfully from the fixture payload.",
  },
  {
    key: "source_only_fields_retained",
    label: "Source-only fields retained",
    description: "Unmapped supplier-only paths are retained and classified as SOURCE_ONLY, not discarded.",
  },
  {
    key: "mapping_gaps_classified",
    label: "Mapping gaps classified correctly",
    description: "No engineering-defect outcomes; unmapped paths carry valid mapping outcomes.",
  },
  {
    key: "duplicate_idempotency_tests",
    label: "Duplicate/idempotency tests pass",
    description: "Repeated mapping of the same payload yields identical canonical output.",
  },
  {
    key: "null_conditional_field_tests",
    label: "Null/conditional-field tests pass",
    description: "Optional or absent source fields do not break canonical mapping.",
  },
  {
    key: "status_update_tests",
    label: "Status update tests pass",
    description: "Status-bearing payloads map to updated canonical status values.",
  },
  {
    key: "attribution_tests",
    label: "Attribution tests pass where applicable",
    description: "Conversion/order objects must pass attribution checks; other objects are N/A.",
    applicability: "attribution",
  },
  {
    key: "reconciliation_sample",
    label: "Reconciliation sample passes",
    description: "Finance/payment objects must pass a reconciliation sample; other objects are N/A.",
    applicability: "reconciliation",
  },
  {
    key: "client_data_leakage_review",
    label: "Client data leakage review passes",
    description: "Client-safe projection contains no raw network or internal keys.",
  },
  {
    key: "verify_live_resolved",
    label: "VERIFY_LIVE items resolved or blocked",
    description: "VERIFY_LIVE mapping gaps are verified live or explicitly blocked from production exposure.",
  },
]);

const CRITERIA_BY_KEY = Object.freeze(
  Object.fromEntries(SOURCE_OBJECT_DONE_CRITERIA.map((item) => [item.key, item])),
);

export class SourceObjectDefinitionOfDoneError extends Error {
  constructor(message, { code = "SOURCE_OBJECT_NOT_PRODUCTION_READY", details = null } = {}) {
    super(message);
    this.name = "SourceObjectDefinitionOfDoneError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

export function getSourceObjectDoneCriterion(key) {
  return CRITERIA_BY_KEY[String(key || "")] || null;
}

export function isAttributionApplicable({ sequenceStage, entityType } = {}) {
  const stage = String(sequenceStage?.stage || "").toLowerCase();
  const type = String(entityType || "").toLowerCase();
  return (
    stage === "conversions_orders" ||
    stage === "order_items" ||
    stage === "performance" ||
    type === "conversion" ||
    type === "conversion_item" ||
    type === "performance"
  );
}

export function isReconciliationApplicable({ sequenceStage, entityType } = {}) {
  const stage = String(sequenceStage?.stage || "").toLowerCase();
  const type = String(entityType || "").toLowerCase();
  return stage === "finance" || type === "payment";
}

export function applySourceObjectDefinitionOfDoneContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    definitionOfDonePointer: CONTRACT_POINTER,
    definitionOfDoneNetwork: network || null,
    definitionOfDoneSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
