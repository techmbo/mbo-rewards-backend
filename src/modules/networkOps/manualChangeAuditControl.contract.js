/**
 * Pointer 31 — Manual change and audit-control rules.
 * Manual ops changes require audit entries; raw evidence stays immutable; mappings are versioned.
 */

export const CONTRACT_POINTER = 31;

export const MANUAL_CHANGE_AUDIT_SUMMARY = Object.freeze({
  auditRule:
    "Any manual change to mapping status, campaign relationship, attribution, commission rule, payment/reconciliation state or exception resolution must create an audit entry containing actor, timestamp, object, field, old value, new value and reason.",
  immutableRawRule: "Manual operations must never rewrite immutable raw source evidence.",
  mappingVersionRule:
    "Mappings must be versioned. Do not edit an already-used mapping in place. Create a new version and reprocess affected preserved raw records.",
});

/** Manual change categories that require audit entries. */
export const MANUAL_CHANGE_CATEGORIES = Object.freeze([
  {
    key: "mapping_status",
    label: "Mapping status",
    objectTypes: ["mapping_registry", "mapping_rule"],
    enforcedBy: ["mappingRegistry.contract.js", "ops/mappingReviewOps.service.js"],
  },
  {
    key: "campaign_relationship",
    label: "Campaign relationship",
    objectTypes: ["supplier_campaign", "canonical_campaign", "brand_link"],
    enforcedBy: ["ops/campaignNormalization.service.js", "supplierCampaigns.controller.js"],
  },
  {
    key: "attribution",
    label: "Attribution",
    objectTypes: ["conversion", "order", "attribution_link"],
    enforcedBy: ["reporting/services/attribution.service.js", "order/orderIngestion.service.js"],
  },
  {
    key: "commission_rule",
    label: "Commission rule",
    objectTypes: ["commission_rule", "supplier_commission_rule"],
    enforcedBy: ["commercial/commercialRuleEngine.js", "commercial/supplierCommissionRuleSync.service.js"],
  },
  {
    key: "payment_reconciliation_state",
    label: "Payment/reconciliation state",
    objectTypes: ["financial_transaction", "reconciliation_row", "network_payment"],
    enforcedBy: ["finance/financeSeparation.contract.js", "finance/financialTransaction.service.js"],
  },
  {
    key: "exception_resolution",
    label: "Exception resolution",
    objectTypes: ["exception_case"],
    enforcedBy: ["order/exceptionCase.service.js", "ops/alertException.contract.js"],
  },
]);

export const REQUIRED_AUDIT_ENTRY_FIELDS = Object.freeze([
  "actor",
  "timestamp",
  "object",
  "field",
  "oldValue",
  "newValue",
  "reason",
]);

/** Runtime field mapping to AuditService.record(). */
export const AUDIT_ENTRY_FIELD_MAP = Object.freeze({
  actor: "actorId",
  timestamp: "createdAt",
  object: "aggregateType",
  field: "metadata.field",
  oldValue: "before",
  newValue: "after",
  reason: "reason",
});

export const IMMUTABLE_RAW_EVIDENCE_FIELDS = Object.freeze([
  "payload",
  "body",
  "bodyRef",
  "payloadHash",
  "rawHash",
  "immutablePayload",
]);

export const MAPPING_VERSION_CONTROL_RULES = Object.freeze({
  versioned: true,
  inPlaceEditForbiddenOnceUsed: true,
  requiredFollowUp: "reprocess_preserved_raw_records",
  versionFilePattern: "{network}/{sourceObject}.v{version}.mapping.json",
  enforcedBy: [
    "mapping/loader.js",
    "mapping/mappingRegistry.compiler.js",
    "networkOps/reprocessing.contract.js",
    "networkOps/reprocessOrchestrator.service.js",
  ],
});

export class ManualChangeAuditControlError extends Error {
  constructor(message, { code = "MANUAL_CHANGE_AUDIT_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "ManualChangeAuditControlError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function hasAuditField(entry, field) {
  if (!entry || typeof entry !== "object") return false;
  switch (field) {
    case "actor":
      return Boolean(entry.actor || entry.actorId || entry.actorEmail);
    case "timestamp":
      return Boolean(entry.timestamp || entry.createdAt || entry.occurredAt);
    case "object":
      return Boolean(entry.object || entry.aggregateType || entry.objectType);
    case "field":
      return Boolean(entry.field || entry.metadata?.field);
    case "oldValue":
      return entry.oldValue !== undefined || entry.before !== undefined;
    case "newValue":
      return entry.newValue !== undefined || entry.after !== undefined;
    case "reason":
      return Boolean(String(entry.reason || "").trim());
    default:
      return false;
  }
}

/**
 * Assert a manual change created a complete audit entry.
 */
export function assertManualChangeAudited({
  category,
  auditEntry = null,
  manual = true,
} = {}) {
  if (!manual) return true;

  const known = MANUAL_CHANGE_CATEGORIES.some((item) => item.key === category);
  if (!known) {
    throw new ManualChangeAuditControlError(`Unknown manual change category: ${category}`, {
      code: "UNKNOWN_MANUAL_CHANGE_CATEGORY",
      details: { category },
    });
  }

  if (!auditEntry) {
    throw new ManualChangeAuditControlError("Manual changes require an audit entry.", {
      code: "AUDIT_ENTRY_MISSING",
      details: { category },
    });
  }

  const missing = REQUIRED_AUDIT_ENTRY_FIELDS.filter((field) => !hasAuditField(auditEntry, field));
  if (missing.length) {
    throw new ManualChangeAuditControlError(
      `Audit entry missing required fields: ${missing.join(", ")}`,
      {
        code: "AUDIT_ENTRY_INCOMPLETE",
        details: { category, missing, auditEntry },
      },
    );
  }

  return true;
}

/**
 * Assert manual operations did not mutate immutable raw evidence.
 */
export function assertRawEvidenceImmutable({
  action,
  targetFields = [],
  before = null,
  after = null,
} = {}) {
  if (action === "rewrite_raw_payload" || action === "mutate_immutable_raw") {
    throw new ManualChangeAuditControlError(
      "Manual operations must never rewrite immutable raw source evidence.",
      {
        code: "IMMUTABLE_RAW_REWRITE_FORBIDDEN",
        details: { action, targetFields },
      },
    );
  }

  const touched = (Array.isArray(targetFields) ? targetFields : []).filter((field) =>
    IMMUTABLE_RAW_EVIDENCE_FIELDS.includes(String(field)),
  );
  if (touched.length) {
    throw new ManualChangeAuditControlError(
      "Manual operations attempted to modify immutable raw evidence fields.",
      {
        code: "IMMUTABLE_RAW_FIELD_MUTATION",
        details: { touched, action },
      },
    );
  }

  if (before && after && typeof before === "object" && typeof after === "object") {
    for (const field of IMMUTABLE_RAW_EVIDENCE_FIELDS) {
      if (before[field] !== undefined && after[field] !== undefined && before[field] !== after[field]) {
        throw new ManualChangeAuditControlError(
          `Immutable raw evidence field mutated: ${field}`,
          {
            code: "IMMUTABLE_RAW_FIELD_MUTATION",
            details: { field, action },
          },
        );
      }
    }
  }

  return true;
}

/**
 * Assert mapping changes are versioned and trigger reprocess — never edited in place once used.
 */
export function assertMappingVersionedChange({
  previousVersion = null,
  nextVersion = null,
  editedInPlace = false,
  mappingAlreadyUsed = false,
  reprocessPlanned = false,
} = {}) {
  if (mappingAlreadyUsed && editedInPlace) {
    throw new ManualChangeAuditControlError(
      "Do not edit an already-used mapping in place — create a new version.",
      {
        code: "MAPPING_IN_PLACE_EDIT_FORBIDDEN",
        details: { previousVersion, nextVersion },
      },
    );
  }

  if (mappingAlreadyUsed && (!nextVersion || nextVersion === previousVersion)) {
    throw new ManualChangeAuditControlError(
      "Already-used mappings require a new version identifier.",
      {
        code: "MAPPING_VERSION_REQUIRED",
        details: { previousVersion, nextVersion },
      },
    );
  }

  if (mappingAlreadyUsed && nextVersion && nextVersion !== previousVersion && !reprocessPlanned) {
    throw new ManualChangeAuditControlError(
      "New mapping versions must reprocess affected preserved raw records.",
      {
        code: "MAPPING_REPROCESS_REQUIRED",
        details: { previousVersion, nextVersion },
      },
    );
  }

  return true;
}

export function buildManualChangeAuditControlGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...MANUAL_CHANGE_AUDIT_SUMMARY },
    manualChangeCategories: MANUAL_CHANGE_CATEGORIES.map((item) => ({ ...item })),
    requiredAuditEntryFields: [...REQUIRED_AUDIT_ENTRY_FIELDS],
    auditEntryFieldMap: { ...AUDIT_ENTRY_FIELD_MAP },
    immutableRawEvidenceFields: [...IMMUTABLE_RAW_EVIDENCE_FIELDS],
    mappingVersionControl: {
      ...MAPPING_VERSION_CONTROL_RULES,
      enforcedBy: [...MAPPING_VERSION_CONTROL_RULES.enforcedBy],
    },
    runtimeRefs: Object.freeze({
      auditService: "platform/audit/audit.service.js",
      accessLog: "modules/auth/auth.service.js",
      reprocessing: "modules/networkOps/reprocessing.contract.js",
      reprocessOrchestrator: "modules/networkOps/reprocessOrchestrator.service.js",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      mappingRegistry: `platform_backend/src/network-mappings/${family}/${obj}.mapping.json`,
      mappingVersionPattern: `platform_backend/src/network-mappings/${family}/${obj}.v{version}.mapping.json`,
      reprocessEndpoint: "/ops/imported-records/reprocess",
    });
  }

  return guide;
}

export function applyManualChangeAuditControlContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    manualChangeAuditPointer: CONTRACT_POINTER,
    manualChangeAuditNetwork: network || null,
    manualChangeAuditSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
