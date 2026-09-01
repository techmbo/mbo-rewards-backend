/**
 * Pointer 36 — One-network-at-a-time delivery rule.
 * Complete one network end-to-end before repeating the adapter pattern.
 */
import {
  NETWORK_INTEGRATION_OBJECT_SEQUENCE,
  resolveSequenceRank,
} from "./networkIntegrationSequence.js";

export const CONTRACT_POINTER = 36;

export const ONE_NETWORK_DELIVERY_SUMMARY = Object.freeze({
  scopeRule:
    "Do not ask AI to integrate all networks together. Complete one network end-to-end, then repeat the adapter pattern.",
  sequenceRule:
    "For each network, complete and test source objects in the required sequence where supported.",
  completionRule:
    "A network/source object is not complete because data appears on a screen. It is complete only when fetch, raw retention, schema detection, mapping, validation, idempotent upsert, updates, exception handling, reprocessing, observability and UI inspection all pass.",
});

/** Per-network delivery sequence — aligns with NETWORK_INTEGRATION_OBJECT_SEQUENCE (P24). */
export const NETWORK_DELIVERY_OBJECT_SEQUENCE = Object.freeze(
  NETWORK_INTEGRATION_OBJECT_SEQUENCE.map((stage) => ({
    rank: stage.rank,
    key: stage.stage,
    label:
      stage.stage === "commission_rules"
        ? "Supplier Commission Rules"
        : stage.stage === "coupons"
          ? "Coupons/Vouchers"
          : stage.stage === "finance"
            ? "Network Finance"
            : stage.label,
    mboTargetObject: stage.mboTargetObject,
    patterns: [...stage.patterns],
  })),
);

export const NETWORK_DELIVERY_OBJECT_KEYS = Object.freeze(
  NETWORK_DELIVERY_OBJECT_SEQUENCE.map((item) => item.key),
);

/** Gates that must all pass before a source object is delivery-complete. */
export const SOURCE_OBJECT_COMPLETION_GATES = Object.freeze([
  { key: "fetch", label: "Fetch", enforcedBy: ["networkOps/pipeline/stages.js", "networkOps/sourceObjectSync.service.js"] },
  { key: "raw_retention", label: "Raw retention", enforcedBy: ["raw/rawPayload.service.js", "networkOps/rawPayload.contract.js"] },
  { key: "schema_detection", label: "Schema detection", enforcedBy: ["field-system/sourceSchemaObserver.service.js"] },
  { key: "mapping", label: "Mapping", enforcedBy: ["mapping/mappingRegistry.contract.js", "mapping/engine.js"] },
  { key: "validation", label: "Validation", enforcedBy: ["networkOps/sourceObjectDefinitionOfDone.contract.js"] },
  { key: "idempotent_upsert", label: "Idempotent upsert", enforcedBy: ["networkOps/pipeline/ingestSourceRecord.js", "order/orderIngestion.service.js"] },
  { key: "updates", label: "Updates", enforcedBy: ["order/orderMerge.js", "ops/importedRecords.service.js"] },
  { key: "exception_handling", label: "Exception handling", enforcedBy: ["order/exceptionCase.service.js", "ops/alertException.contract.js"] },
  { key: "reprocessing", label: "Reprocessing", enforcedBy: ["networkOps/reprocessOrchestrator.service.js", "networkOps/reprocessing.contract.js"] },
  { key: "observability", label: "Observability", enforcedBy: ["networkOps/syncObservability.contract.js", "ops/syncRunOps.service.js"] },
  { key: "ui_inspection", label: "UI inspection", enforcedBy: ["ops/allNetworkData.contract.js", "mbo_frontend/platform/src/pages/ops/AllNetworkDataPage.jsx"] },
]);

export const SOURCE_OBJECT_COMPLETION_GATE_KEYS = Object.freeze(
  SOURCE_OBJECT_COMPLETION_GATES.map((gate) => gate.key),
);

export class OneNetworkAtATimeError extends Error {
  constructor(message, { code = "ONE_NETWORK_DELIVERY_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "OneNetworkAtATimeError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function objectRank(sourceObject) {
  return resolveSequenceRank(sourceObject);
}

/**
 * Assert an integration task is scoped to a single network.
 */
export function assertSingleNetworkScope({
  networks = [],
  network = null,
} = {}) {
  const list = Array.isArray(networks) ? networks.filter(Boolean) : [];
  const unique = [...new Set(list.map((item) => String(item).toLowerCase()))];

  if (unique.length > 1) {
    throw new OneNetworkAtATimeError("Do not ask AI to integrate all networks together.", {
      code: "MULTI_NETWORK_SCOPE",
      details: { networks: unique },
    });
  }

  if (network && unique.length === 1 && unique[0] !== String(network).toLowerCase()) {
    throw new OneNetworkAtATimeError("Integration task network scope is ambiguous.", {
      code: "NETWORK_SCOPE_MISMATCH",
      details: { network, networks: unique },
    });
  }

  return true;
}

/**
 * Assert completed source objects within a network follow the delivery sequence.
 */
export function assertNetworkDeliverySequence({ completedObjects = [] } = {}) {
  const objects = Array.isArray(completedObjects) ? completedObjects : [];
  let lastRank = 0;

  for (const sourceObject of objects) {
    const rank = objectRank(sourceObject);
    if (rank == null) {
      throw new OneNetworkAtATimeError(`Unknown delivery source object: ${sourceObject}`, {
        code: "UNKNOWN_DELIVERY_OBJECT",
        details: { sourceObject, completedObjects: objects },
      });
    }

    if (rank < lastRank) {
      throw new OneNetworkAtATimeError(
        `Network delivery sequence out of order: ${sourceObject} cannot complete before prior objects.`,
        {
          code: "DELIVERY_SEQUENCE_OUT_OF_ORDER",
          details: { sourceObject, rank, lastRank, completedObjects: objects },
        },
      );
    }
    lastRank = rank;
  }

  return true;
}

/**
 * Assert all completion gates pass — screen visibility alone is insufficient.
 */
export function assertSourceObjectDeliveryComplete({
  gates = {},
  uiOnlyComplete = false,
} = {}) {
  if (uiOnlyComplete) {
    throw new OneNetworkAtATimeError(
      "A network/source object is not complete because data appears on a screen.",
      {
        code: "UI_ONLY_COMPLETION",
        details: { gates },
      },
    );
  }

  const status =
    gates && typeof gates === "object" && !Array.isArray(gates) ? gates : {};
  const missing = SOURCE_OBJECT_COMPLETION_GATE_KEYS.filter((key) => status[key] !== true);

  if (missing.length) {
    throw new OneNetworkAtATimeError(
      "Source object delivery is incomplete — all completion gates must pass.",
      {
        code: "DELIVERY_GATES_INCOMPLETE",
        details: { missing, gates: status },
      },
    );
  }

  return true;
}

export function buildOneNetworkAtATimeGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...ONE_NETWORK_DELIVERY_SUMMARY },
    deliverySequence: NETWORK_DELIVERY_OBJECT_SEQUENCE.map((item) => ({ ...item })),
    completionGates: SOURCE_OBJECT_COMPLETION_GATES.map((gate) => ({ ...gate })),
    runtimeRefs: Object.freeze({
      networkIntegrationSequence: "networkOps/networkIntegrationSequence.js",
      definitionOfDone: "networkOps/sourceObjectDefinitionOfDone.contract.js",
      aiAssistedDevelopment: "networkOps/aiAssistedDevelopment.contract.js",
      engineeringBuildOrder: "networkOps/engineeringBuildOrder.contract.js",
      syncObservability: "networkOps/syncObservability.contract.js",
    }),
    crossRefs: Object.freeze({
      pointer24Sequence: "Recommended per-network object sequence (9 stages).",
      pointer26DefinitionOfDone: "Production-readiness criteria extend these delivery gates.",
      pointer35BuildOrder: "Engineering build order precedes per-network delivery.",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    const rank = objectRank(obj);
    guide.objectRefs = Object.freeze({
      network: family,
      sourceObject: obj,
      sequenceRank: rank,
      mappingFile: `platform_backend/src/network-mappings/${family}/${obj}.mapping.json`,
      fixtureDir: `platform_backend/test/fixtures/networks/${family}/${obj}/`,
      integrationTest: `platform_backend/test/p24.${family}.${obj}.integration.test.js`,
    });
  }

  return guide;
}

export function applyOneNetworkAtATimeContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    oneNetworkAtATimePointer: CONTRACT_POINTER,
    oneNetworkAtATimeNetwork: network || null,
    oneNetworkAtATimeSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
