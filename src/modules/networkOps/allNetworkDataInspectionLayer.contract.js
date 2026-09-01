/**
 * Pointer 34 — All Network Data view is not a new schema.
 * The inspection/custom-columns screen changes the view only — never the canonical model.
 */
import { FIELD_MAPPING_OUTCOME } from "../mapping/mappingOutcome.contract.js";
import { VIEW_MODE } from "../ops/allNetworkData.contract.js";

export const CONTRACT_POINTER = 34;

export const INSPECTION_LAYER_SUMMARY = Object.freeze({
  layerRole:
    "The All Network Data / Custom Columns screen is an inspection layer only. It lets ops inspect source-backed rows with different column layouts.",
  viewNotSchema:
    "Selecting an extra source column changes the view, not the canonical model. Custom column choices do not define, extend, or mutate MBO canonical schema.",
  sourceOnlyRetention:
    "Extra network-specific fields remain SOURCE_ONLY until MBO deliberately promotes them through the canonical-governance process.",
  promotionGate:
    "Canonical promotion requires an explicit MBO canonical-governance process decision — never automatic from All Network Data column selection, UI labels, or AI assumptions.",
});

/** What the inspection layer may do — view projection only. */
export const INSPECTION_LAYER_CAPABILITIES = Object.freeze([
  {
    key: "display_canonical_columns",
    label: "Display canonical MBO columns",
    allowed: true,
  },
  {
    key: "display_source_only_columns",
    label: "Display extra source-only columns (source:* keys)",
    allowed: true,
  },
  {
    key: "switch_view_modes",
    label: "Switch MBO Default / Compact / All Columns / Custom view modes",
    allowed: true,
  },
  {
    key: "custom_column_selection",
    label: "Select additional source columns for inspection",
    allowed: true,
  },
]);

/** Actions the inspection layer must never perform. */
export const FORBIDDEN_INSPECTION_ACTIONS = Object.freeze([
  "mutate_canonical_model",
  "create_canonical_field",
  "auto_promote_source_field",
  "update_mapping_registry_from_ui",
  "change_client_api_from_view",
  "persist_custom_columns_as_schema",
]);

/** Required classification for extra fields shown in the inspection layer. */
export const EXTRA_FIELD_CLASSIFICATION = Object.freeze({
  defaultOutcome: FIELD_MAPPING_OUTCOME.SOURCE_ONLY,
  promotionPath: "canonical_governance_process",
  autoPromotionFromView: false,
});

export class AllNetworkDataInspectionLayerError extends Error {
  constructor(message, { code = "ALL_NETWORK_DATA_INSPECTION_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "AllNetworkDataInspectionLayerError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function isSourceOnlyKey(key) {
  return String(key || "").startsWith("source:");
}

/**
 * Assert column/view selection is view-only — it must not mutate canonical schema or mappings.
 */
export function assertViewOnlyColumnSelection({
  viewMode = VIEW_MODE.MBO_DEFAULT,
  selectedKeys = [],
  canonicalMutated = false,
  schemaChanged = false,
  mappingPromoted = false,
  mappingRegistryUpdated = false,
} = {}) {
  const keys = Array.isArray(selectedKeys) ? selectedKeys : [];
  const mode = String(viewMode || VIEW_MODE.MBO_DEFAULT).toUpperCase();

  if (canonicalMutated || schemaChanged) {
    throw new AllNetworkDataInspectionLayerError(
      "All Network Data column selection must not mutate the canonical model.",
      {
        code: "CANONICAL_MODEL_MUTATED_FROM_VIEW",
        details: { viewMode: mode, selectedKeys: keys, canonicalMutated, schemaChanged },
      },
    );
  }

  if (mappingPromoted || mappingRegistryUpdated) {
    throw new AllNetworkDataInspectionLayerError(
      "All Network Data view changes must not promote fields or update the mapping registry.",
      {
        code: "MAPPING_PROMOTED_FROM_VIEW",
        details: { viewMode: mode, selectedKeys: keys, mappingPromoted, mappingRegistryUpdated },
      },
    );
  }

  return true;
}

/**
 * Assert extra fields exposed in the inspection view remain SOURCE_ONLY.
 */
export function assertExtraFieldsRemainSourceOnly({ fieldKeys = [], mappingOutcomes = {} } = {}) {
  const keys = Array.isArray(fieldKeys) ? fieldKeys : [];
  const outcomes =
    mappingOutcomes && typeof mappingOutcomes === "object" && !Array.isArray(mappingOutcomes)
      ? mappingOutcomes
      : {};

  for (const key of keys) {
    const outcome = outcomes[key];
    if (outcome == null) continue;
    if (outcome !== FIELD_MAPPING_OUTCOME.SOURCE_ONLY) {
      throw new AllNetworkDataInspectionLayerError(
        `Extra inspection fields must remain SOURCE_ONLY until canonical governance promotes them: ${key}`,
        {
          code: "EXTRA_FIELD_NOT_SOURCE_ONLY",
          details: { key, outcome, expectedOutcome: FIELD_MAPPING_OUTCOME.SOURCE_ONLY },
        },
      );
    }
  }

  return true;
}

/**
 * Assert an inspection-layer action does not create schema or auto-promote source fields.
 */
export function assertNoSchemaMutationFromInspectionView({
  action = null,
  mutatesCanonicalModel = false,
  createsCanonicalField = false,
  autoPromotesSourceField = false,
  persistsViewAsSchema = false,
} = {}) {
  if (mutatesCanonicalModel) {
    throw new AllNetworkDataInspectionLayerError(
      "The All Network Data inspection layer must not mutate the canonical model.",
      {
        code: "CANONICAL_MODEL_MUTATED_FROM_VIEW",
        details: { action, mutatesCanonicalModel },
      },
    );
  }

  if (createsCanonicalField || autoPromotesSourceField) {
    throw new AllNetworkDataInspectionLayerError(
      "Extra source fields must remain SOURCE_ONLY until MBO deliberately promotes them through canonical governance.",
      {
        code: "AUTO_PROMOTION_FROM_INSPECTION_VIEW",
        details: { action, createsCanonicalField, autoPromotesSourceField },
      },
    );
  }

  if (persistsViewAsSchema) {
    throw new AllNetworkDataInspectionLayerError(
      "Custom column selections are view preferences — they must not be persisted as canonical schema.",
      {
        code: "VIEW_PERSISTED_AS_SCHEMA",
        details: { action, persistsViewAsSchema },
      },
    );
  }

  return true;
}

/**
 * Classify selected column keys for inspection view projection.
 */
export function classifyInspectionColumnKeys(selectedKeys = []) {
  const keys = Array.isArray(selectedKeys) ? selectedKeys : [];
  const canonicalKeys = keys.filter((key) => !isSourceOnlyKey(key));
  const sourceOnlyKeys = keys.filter((key) => isSourceOnlyKey(key));

  return {
    canonicalKeys,
    sourceOnlyKeys,
    extraFieldOutcome: FIELD_MAPPING_OUTCOME.SOURCE_ONLY,
    mutatesCanonicalModel: false,
  };
}

export function buildAllNetworkDataInspectionLayerGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...INSPECTION_LAYER_SUMMARY },
    capabilities: INSPECTION_LAYER_CAPABILITIES.map((item) => ({ ...item })),
    forbiddenActions: [...FORBIDDEN_INSPECTION_ACTIONS],
    extraFieldClassification: { ...EXTRA_FIELD_CLASSIFICATION },
    viewModes: Object.values(VIEW_MODE),
    runtimeRefs: Object.freeze({
      allNetworkDataContract: "ops/allNetworkData.contract.js",
      mappingOutcomeContract: "mapping/mappingOutcome.contract.js",
      mboCanonicalObjects: "mapping/mboCanonicalObjects.contract.js",
      mappingRegistry: "mapping/mappingRegistry.contract.js",
      engineeringSourceOfTruth: "networkOps/engineeringSourceOfTruth.contract.js",
    }),
    pointer22CrossRef: Object.freeze({
      contractPointer: 22,
      sourceOnlyRule:
        "Extra network-specific fields appear in All Columns (source:* keys) and Source Data — never auto-promoted to canonical MBO fields.",
      sourceColumnPrefix: "source:",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      allNetworkDataPage: "mbo_frontend/platform/src/pages/ops/AllNetworkDataPage.jsx",
      columnCatalog: "ops/allNetworkData.contract.js",
      importedRecordsService: "ops/importedRecords.service.js",
      network: family,
      sourceObject: obj,
    });
  }

  return guide;
}

export function applyAllNetworkDataInspectionLayerContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    allNetworkDataInspectionPointer: CONTRACT_POINTER,
    allNetworkDataInspectionNetwork: network || null,
    allNetworkDataInspectionSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
