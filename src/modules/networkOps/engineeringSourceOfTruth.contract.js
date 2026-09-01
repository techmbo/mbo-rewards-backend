/**
 * Pointer 27 — Engineering source-of-truth hierarchy.
 * Defines authority precedence when network integrations conflict across layers.
 */

export const CONTRACT_POINTER = 27;

/** Ranked authority layers — lower rank number = higher authority. */
export const ENGINEERING_SOURCE_OF_TRUTH_LAYERS = Object.freeze([
  {
    rank: 1,
    key: "mbo_canonical_standard",
    label: "MBO Canonical Standard",
    role: "Controls MBO/client meaning.",
    contractRef: "mboCanonicalObjects.contract.js",
    enforcedBy: [
      "mboCanonicalObjects.contract.js",
      "mapping/mboCanonicalObjects.contract.js",
      "clientBoundary.contract.js",
    ],
  },
  {
    rank: 2,
    key: "mbo_network_mapping_registry",
    label: "MBO-to-Network Mapping Registry",
    role: "Controls translation from network source fields to MBO canonical fields.",
    contractRef: "network-mappings/{network}/{sourceObject}.mapping.json",
    enforcedBy: [
      "mappingRegistry.contract.js",
      "mappingRegistry.compiler.js",
      "network-mappings/{network}/{sourceObject}.mapping.json",
    ],
  },
  {
    rank: 3,
    key: "live_sanitized_network_response",
    label: "Actual live/sanitized network response",
    role: "Proves what the account really returns.",
    contractRef: "test/fixtures/networks/{network}/{sourceObject}/source.api.json",
    enforcedBy: ["aiAssistedDevelopment.contract.js", "sourceSchemaObserver.service.js"],
  },
  {
    rank: 4,
    key: "official_network_documentation",
    label: "Official network documentation",
    role: "Verifies endpoint/schema semantics and versions.",
    contractRef: null,
    enforcedBy: ["sourceObjects.catalog.js"],
  },
  {
    rank: 5,
    key: "immutable_raw_payload",
    label: "Immutable raw payload",
    role: "Audit evidence of what arrived on a specific run.",
    contractRef: "rawPayload.service.js",
    enforcedBy: ["rawPayload.service.js", "raw/rawPayload.service.js", "networkOps/pipeline/stages.js"],
  },
]);

export const NETWORK_CHANGE_RULE = Object.freeze({
  summary:
    "If a network changes, update source schema + adapter mapping + mapping version first. Do not change the Client API unless the MBO business model itself genuinely changes.",
  requiredUpdates: Object.freeze([
    "source_schema",
    "adapter_mapping",
    "mapping_version",
  ]),
  clientApiChangeGate: "mbo_business_model_change_only",
});

export const FINAL_IMPLEMENTATION_PRINCIPLE = Object.freeze({
  verbatim:
    "Capture 100% of source data. Standardize only what belongs in the MBO model. Never silently lose source fields. Never let a network redefine MBO Rewards.",
  rules: Object.freeze([
    "capture_all_source_data",
    "standardize_mbo_model_only",
    "never_silently_lose_source_fields",
    "never_let_network_redefine_mbo",
  ]),
});

const LAYER_BY_KEY = Object.freeze(
  Object.fromEntries(ENGINEERING_SOURCE_OF_TRUTH_LAYERS.map((layer) => [layer.key, layer])),
);

export class EngineeringSourceOfTruthError extends Error {
  constructor(message, { code = "SOURCE_OF_TRUTH_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "EngineeringSourceOfTruthError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

export function getSourceOfTruthLayer(key) {
  return LAYER_BY_KEY[String(key || "")] || null;
}

export function getHigherAuthorityLayer(key) {
  const layer = getSourceOfTruthLayer(key);
  if (!layer) return null;
  return ENGINEERING_SOURCE_OF_TRUTH_LAYERS.find((item) => item.rank === layer.rank - 1) || null;
}

/**
 * Assert a proposed change respects hierarchy — lower layers cannot override higher authority.
 */
export function assertChangeRespectsHierarchy({
  changeTarget,
  changeLayer,
  reason = null,
} = {}) {
  const layer = getSourceOfTruthLayer(changeLayer);
  if (!layer) {
    throw new EngineeringSourceOfTruthError(`Unknown source-of-truth layer: ${changeLayer}`, {
      code: "UNKNOWN_SOURCE_OF_TRUTH_LAYER",
    });
  }

  if (changeTarget === "client_api" && reason !== NETWORK_CHANGE_RULE.clientApiChangeGate) {
    throw new EngineeringSourceOfTruthError(
      "Client API changes require a genuine MBO business model change — update source schema and mapping first.",
      {
        code: "CLIENT_API_CHANGE_WITHOUT_MBO_MODEL_CHANGE",
        details: { changeTarget, changeLayer, reason },
      },
    );
  }

  return true;
}

function interpolateRef(template, { network, sourceObject } = {}) {
  if (!template) return null;
  return String(template)
    .replaceAll("{network}", String(network || "").toLowerCase())
    .replaceAll("{sourceObject}", String(sourceObject || "").toLowerCase());
}

export function buildEngineeringSourceOfTruthGuide({ network = null, sourceObject = null } = {}) {
  const layers = ENGINEERING_SOURCE_OF_TRUTH_LAYERS.map((layer) => ({
    ...layer,
    objectRef: interpolateRef(layer.contractRef, { network, sourceObject }),
  }));

  const guide = {
    contractPointer: CONTRACT_POINTER,
    hierarchy: layers,
    networkChangeRule: { ...NETWORK_CHANGE_RULE },
    finalImplementationPrinciple: { ...FINAL_IMPLEMENTATION_PRINCIPLE },
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      mboCanonicalStandard: "platform_backend/src/modules/mapping/mboCanonicalObjects.contract.js",
      mappingRegistry: `platform_backend/src/network-mappings/${family}/${obj}.mapping.json`,
      liveSanitizedResponse: `platform_backend/test/fixtures/networks/${family}/${obj}/source.api.json`,
      observedSchema: `platform_backend/test/fixtures/networks/${family}/${obj}/schema.observed.json`,
      officialNetworkDocumentation: null,
      immutableRawPayload: "platform_backend/src/modules/raw/rawPayload.service.js",
    });
  }

  return guide;
}

export function applyEngineeringSourceOfTruthContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    sourceOfTruthPointer: CONTRACT_POINTER,
    sourceOfTruthNetwork: network || null,
    sourceOfTruthSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
