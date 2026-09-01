/**
 * Pointer 25 — Required AI system instruction for Network Operations work.
 * Verbatim instruction text + machine-checkable prohibitions and pipeline mapping.
 */
import { PIPELINE_STAGES } from "./pipeline/stages.js";
import { MBO_CANONICAL_OBJECT } from "../mapping/mboCanonicalObjects.contract.js";
import {
  ENGINEERING_DEFECT_OUTCOMES,
  FIELD_MAPPING_OUTCOME,
  isEngineeringDefect,
} from "../mapping/mappingOutcome.contract.js";

export const CONTRACT_POINTER = 25;

/** Verbatim system instruction for AI agents working on Network Operations. */
export const NETWORK_OPS_AI_SYSTEM_INSTRUCTION = `You are implementing MBO Rewards Network Operations. MBO Rewards owns the canonical data model. Affiliate networks are source systems only.

Do not change MBO canonical field names to match a network. Do not invent network fields or JSON paths. Do not discard raw source fields. Do not combine Campaigns, Coupons, Tracking Links, Commission Rules, Offers, Products or Payments into one generic asset field. Do not infer values when a source field is absent. Do not treat SOURCE_PRESENT_MAPPING_MISSING as NOT_SUPPORTED. Do not expose raw network fields directly to the client model. Do not treat network payment status as MBO actual receipt. Do not create duplicate canonical orders from repeated API responses.

Required pipeline: Network API → immutable RawSourceRecord → Source Schema Registry → Versioned Mapping Registry → MBO Canonical Objects → Network Operations → Client-safe MBO model.`;

/** AI-facing pipeline narrative (maps to runtime PIPELINE_STAGES). */
export const NETWORK_OPS_AI_PIPELINE_NARRATIVE = Object.freeze([
  {
    step: 1,
    stage: "network_api",
    label: "Network API",
    description: "Fetch source facts from the affiliate network adapter.",
    runtimeStages: ["FETCH_SOURCE"],
  },
  {
    step: 2,
    stage: "raw_source_record",
    label: "immutable RawSourceRecord",
    description: "Store the full immutable raw payload before any mapping.",
    runtimeStages: ["STORE_RAW_PAYLOAD"],
  },
  {
    step: 3,
    stage: "source_schema_registry",
    label: "Source Schema Registry",
    description: "Observe and register source paths; never invent paths.",
    runtimeStages: ["DETECT_SOURCE_SCHEMA"],
  },
  {
    step: 4,
    stage: "versioned_mapping_registry",
    label: "Versioned Mapping Registry",
    description: "Apply approved versioned mapping rows to canonical fields.",
    runtimeStages: ["APPLY_VERSIONED_MAPPING"],
  },
  {
    step: 5,
    stage: "mbo_canonical_objects",
    label: "MBO Canonical Objects",
    description: "Normalize and validate MBO-standard canonical objects.",
    runtimeStages: ["NORMALIZE_CANONICAL", "VALIDATE_MBO_STANDARD"],
  },
  {
    step: 6,
    stage: "network_operations",
    label: "Network Operations",
    description: "Idempotent upsert, attribution, commercial rules, ops tables, finance reconciliation.",
    runtimeStages: [
      "IDEMPOTENT_UPSERT",
      "RESOLVE_ATTRIBUTION",
      "APPLY_COMMERCIAL_RULES",
      "UPDATE_NETWORK_OPS",
      "RECONCILE_FINANCE",
    ],
  },
  {
    step: 7,
    stage: "client_safe_mbo_model",
    label: "Client-safe MBO model",
    description: "Project client-safe models; never expose raw network fields.",
    runtimeStages: ["EXPOSE_CLIENT_SAFE_MODEL"],
  },
]);

/** Canonical objects that must never collapse into a generic asset field. */
export const NON_COLLAPSIBLE_CANONICAL_OBJECTS = Object.freeze([
  MBO_CANONICAL_OBJECT.NETWORK_CAMPAIGN,
  MBO_CANONICAL_OBJECT.COUPON_VOUCHER,
  MBO_CANONICAL_OBJECT.TRACKING_LINK,
  MBO_CANONICAL_OBJECT.SUPPLIER_COMMISSION_RULE,
  MBO_CANONICAL_OBJECT.OFFER_PROMOTION,
  MBO_CANONICAL_OBJECT.PRODUCT,
  MBO_CANONICAL_OBJECT.NETWORK_PAYMENT,
]);

/** Hard prohibitions for AI Network Operations work. */
export const NETWORK_OPS_AI_PROHIBITIONS = Object.freeze([
  {
    code: "NO_RENAME_CANONICAL_FIELDS",
    rule: "Do not change MBO canonical field names to match a network.",
    enforcedBy: ["mboCanonicalObjects.contract.js", "mappingRegistry.contract.js"],
    contractPointers: [8, 6],
  },
  {
    code: "NO_INVENT_SOURCE_PATHS",
    rule: "Do not invent network fields or JSON paths.",
    enforcedBy: ["sourceSchemaObserver.service.js", "mappingRegistry.contract.js"],
    contractPointers: [5, 6],
  },
  {
    code: "NO_DISCARD_RAW",
    rule: "Do not discard raw source fields.",
    enforcedBy: ["networkOps/pipeline/stages.js", "rawPayload.service.js"],
    contractPointers: [4],
  },
  {
    code: "NO_GENERIC_ASSET_COLLAPSE",
    rule:
      "Do not combine Campaigns, Coupons, Tracking Links, Commission Rules, Offers, Products or Payments into one generic asset field.",
    enforcedBy: ["mboCanonicalObjects.contract.js"],
    contractPointers: [8],
    canonicalObjects: [...NON_COLLAPSIBLE_CANONICAL_OBJECTS],
  },
  {
    code: "NO_INFER_ABSENT_SOURCE",
    rule: "Do not infer values when a source field is absent.",
    enforcedBy: ["mappingOutcome.contract.js", "performanceRecord.contract.js"],
    contractPointers: [7, 13],
  },
  {
    code: "MAPPING_MISSING_NOT_NOT_SUPPORTED",
    rule: "Do not treat SOURCE_PRESENT_MAPPING_MISSING as NOT_SUPPORTED.",
    enforcedBy: ["mappingOutcome.contract.js"],
    contractPointers: [7],
    mappingOutcomes: {
      defect: FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING,
      notEquivalent: FIELD_MAPPING_OUTCOME.NOT_SUPPORTED,
    },
  },
  {
    code: "NO_RAW_TO_CLIENT",
    rule: "Do not expose raw network fields directly to the client model.",
    enforcedBy: ["clientBoundary.contract.js", "networkOps/pipeline/clientSafe.js"],
    contractPointers: [23],
  },
  {
    code: "NETWORK_PAYMENT_NOT_MBO_RECEIPT",
    rule: "Do not treat network payment status as MBO actual receipt.",
    enforcedBy: ["financeSeparation.contract.js"],
    contractPointers: [17],
  },
  {
    code: "NO_DUPLICATE_ORDERS",
    rule: "Do not create duplicate canonical orders from repeated API responses.",
    enforcedBy: ["orderIngestion.service.js", "networkOps/pipeline/stages.js"],
    contractPointers: [10],
    runtimeStages: ["IDEMPOTENT_UPSERT"],
  },
]);

const PROHIBITION_BY_CODE = Object.freeze(
  Object.fromEntries(NETWORK_OPS_AI_PROHIBITIONS.map((p) => [p.code, p])),
);

const NARRATIVE_RUNTIME_STAGES = Object.freeze(
  NETWORK_OPS_AI_PIPELINE_NARRATIVE.flatMap((step) => step.runtimeStages),
);

export class NetworkOpsAiInstructionError extends Error {
  constructor(message, { code = "AI_SYSTEM_INSTRUCTION_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "NetworkOpsAiInstructionError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

export function getProhibition(code) {
  return PROHIBITION_BY_CODE[String(code || "").toUpperCase()] || null;
}

/**
 * Assert a field mapping outcome does not misclassify engineering defects as NOT_SUPPORTED.
 */
export function assertMappingOutcomeNotMisclassified(outcome, { sourcePresent = false } = {}) {
  const normalized = String(outcome || "").toUpperCase();
  if (
    sourcePresent &&
    normalized === FIELD_MAPPING_OUTCOME.NOT_SUPPORTED &&
    ENGINEERING_DEFECT_OUTCOMES.includes(FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING)
  ) {
    throw new NetworkOpsAiInstructionError(
      "Do not treat SOURCE_PRESENT_MAPPING_MISSING as NOT_SUPPORTED",
      {
        code: "MAPPING_MISSING_NOT_NOT_SUPPORTED",
        details: { outcome: normalized, sourcePresent },
      },
    );
  }
  if (sourcePresent && normalized === FIELD_MAPPING_OUTCOME.NOT_SUPPORTED) {
    throw new NetworkOpsAiInstructionError(
      "Source-present path classified as NOT_SUPPORTED — use SOURCE_PRESENT_MAPPING_MISSING or SOURCE_ONLY",
      { code: "MAPPING_MISSING_NOT_NOT_SUPPORTED", details: { outcome: normalized } },
    );
  }
  return outcome;
}

/**
 * Assert a generic asset collapse is not attempted.
 */
export function assertNoGenericAssetCollapse({ targetObject, targetField } = {}) {
  const obj = String(targetObject || "").toLowerCase();
  const field = String(targetField || "").toLowerCase();
  if (
    obj.includes("asset") ||
    field === "assets" ||
    field === "genericasset" ||
    field === "generic_asset"
  ) {
    throw new NetworkOpsAiInstructionError(
      "Do not collapse canonical objects into a generic asset field",
      { code: "NO_GENERIC_ASSET_COLLAPSE", details: { targetObject, targetField } },
    );
  }
  return true;
}

export function assertProhibitionCompliance(code, context = {}) {
  const prohibition = getProhibition(code);
  if (!prohibition) {
    throw new NetworkOpsAiInstructionError(`Unknown prohibition code: ${code}`, {
      code: "UNKNOWN_PROHIBITION",
    });
  }

  switch (code) {
    case "MAPPING_MISSING_NOT_NOT_SUPPORTED":
      assertMappingOutcomeNotMisclassified(context.outcome, {
        sourcePresent: context.sourcePresent,
      });
      break;
    case "NO_GENERIC_ASSET_COLLAPSE":
      assertNoGenericAssetCollapse(context);
      break;
    default:
      break;
  }

  return prohibition;
}

/** Flat list of all runtime stages referenced by the AI pipeline narrative. */
export function listNarrativeRuntimeStages() {
  return [...NARRATIVE_RUNTIME_STAGES];
}

/** Verify narrative pipeline covers every runtime stage exactly once. */
export function assertNarrativeCoversRuntimePipeline() {
  const narrative = new Set(NARRATIVE_RUNTIME_STAGES);
  const runtime = new Set(PIPELINE_STAGES);
  const missing = PIPELINE_STAGES.filter((s) => !narrative.has(s));
  const extra = NARRATIVE_RUNTIME_STAGES.filter((s) => !runtime.has(s));
  if (missing.length || extra.length) {
    throw new NetworkOpsAiInstructionError("AI pipeline narrative does not match runtime pipeline", {
      code: "PIPELINE_NARRATIVE_MISMATCH",
      details: { missing, extra },
    });
  }
  return true;
}

export function buildNetworkOpsAiSystemInstructionGuide() {
  return {
    contractPointer: CONTRACT_POINTER,
    systemInstructionRef: "networkOpsAiSystemInstruction.contract.js",
    systemInstruction: NETWORK_OPS_AI_SYSTEM_INSTRUCTION,
    prohibitions: NETWORK_OPS_AI_PROHIBITIONS.map((p) => ({ ...p })),
    nonCollapsibleCanonicalObjects: [...NON_COLLAPSIBLE_CANONICAL_OBJECTS],
    pipelineNarrative: NETWORK_OPS_AI_PIPELINE_NARRATIVE.map((step) => ({ ...step })),
    runtimePipelineStages: [...PIPELINE_STAGES],
    mappingOutcomeRules: {
      engineeringDefects: [...ENGINEERING_DEFECT_OUTCOMES],
      isEngineeringDefect,
      mappingMissingNotNotSupported:
        FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING !== FIELD_MAPPING_OUTCOME.NOT_SUPPORTED,
    },
  };
}

export function applyAiSystemInstructionContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    systemInstructionPointer: CONTRACT_POINTER,
    aiSystemInstructionNetwork: network || null,
    aiSystemInstructionSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
