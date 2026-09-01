/**
 * Pointer 35 — Required engineering build order.
 * Network integrations must follow a fixed 15-step sequence — never start with UI.
 */

export const CONTRACT_POINTER = 35;

export const ENGINEERING_BUILD_ORDER_SUMMARY = Object.freeze({
  uiLastRule: "Do not start with UI implementation.",
  sequenceRule:
    "Follow the required 15-step engineering build order. Pipeline, validation, attribution, commercial, finance, and exception handling must precede Network Operations UI and client exposure.",
  scopeRule:
    "Step 7 implements one network + one source object at a time. Do not integrate all networks in one task.",
});

/** Mandatory build order — rank is fixed and sequential. */
export const ENGINEERING_BUILD_ORDER = Object.freeze([
  {
    rank: 1,
    key: "freeze_canonical_contracts",
    label: "Freeze canonical contracts",
    enforcedBy: ["mapping/mboCanonicalObjects.contract.js", "mapping/mappingOutcome.contract.js"],
  },
  {
    rank: 2,
    key: "database_objects_constraints",
    label: "Create database objects and constraints",
    enforcedBy: ["prisma/schema.prisma"],
  },
  {
    rank: 3,
    key: "raw_ingestion_immutable_storage",
    label: "Implement raw ingestion and immutable storage",
    enforcedBy: ["raw/rawPayload.service.js", "networkOps/pipeline/stages.js", "networkOps/pipeline/ingestSourceRecord.js"],
  },
  {
    rank: 4,
    key: "capture_sanitized_fixtures",
    label: "Capture sanitized real fixtures",
    enforcedBy: ["networkOps/aiAssistedDevelopment.contract.js", "test/fixtures/networks/{network}/{sourceObject}/"],
  },
  {
    rank: 5,
    key: "source_schema_detection",
    label: "Implement source-schema detection",
    enforcedBy: ["field-system/sourceSchemaObserver.service.js", "field-system/sourceSchemaMappingIndex.js"],
  },
  {
    rank: 6,
    key: "versioned_mapping_registry",
    label: "Implement versioned Mapping Registry",
    enforcedBy: ["mapping/mappingRegistry.contract.js", "mapping/mappingRegistry.compiler.js", "network-mappings/{network}/{sourceObject}.mapping.json"],
  },
  {
    rank: 7,
    key: "one_network_one_source_object",
    label: "Implement one network + one source object",
    enforcedBy: ["networkOps/aiAssistedDevelopment.contract.js", "networkOps/sourceObjectSync.service.js"],
  },
  {
    rank: 8,
    key: "validate_canonical_output",
    label: "Validate canonical output",
    enforcedBy: ["networkOps/sourceObjectDefinitionOfDone.contract.js", "networkOps/sourceObjectDefinitionOfDone.service.js"],
  },
  {
    rank: 9,
    key: "dedupe_idempotent_updates",
    label: "Implement dedupe/idempotent updates",
    enforcedBy: ["networkOps/syncResilience.contract.js", "networkOps/pipeline/ingestSourceRecord.js", "order/orderIngestion.service.js"],
  },
  {
    rank: 10,
    key: "attribution",
    label: "Implement attribution",
    enforcedBy: ["reporting/services/attribution.service.js", "reporting/attributionLogic.contract.js"],
  },
  {
    rank: 11,
    key: "commercial_calculation",
    label: "Implement commercial calculation",
    enforcedBy: ["commercial/commercialRuleEngine.js", "networkOps/commercialCalculationSequencing.contract.js"],
  },
  {
    rank: 12,
    key: "finance_reconciliation",
    label: "Implement finance/reconciliation",
    enforcedBy: ["finance/reconciliation.service.js", "finance/financeSeparation.contract.js"],
  },
  {
    rank: 13,
    key: "exception_handling_reprocessing",
    label: "Implement exception handling and reprocessing",
    enforcedBy: ["order/exceptionCase.service.js", "networkOps/reprocessOrchestrator.service.js", "networkOps/reprocessing.contract.js"],
  },
  {
    rank: 14,
    key: "network_operations_ui",
    label: "Implement Network Operations UI",
    enforcedBy: ["mbo_frontend/platform/src/pages/ops/", "ops/networkOps.service.js"],
  },
  {
    rank: 15,
    key: "client_safe_model",
    label: "Expose the client-safe model",
    enforcedBy: ["client/clientBoundary.contract.js", "networkOps/pipeline/clientSafe.js"],
  },
]);

export const ENGINEERING_BUILD_ORDER_STEP_KEYS = Object.freeze(
  ENGINEERING_BUILD_ORDER.map((step) => step.key),
);

export const UI_BUILD_STEP = Object.freeze({
  rank: 14,
  key: "network_operations_ui",
});

export const CLIENT_EXPOSURE_STEP = Object.freeze({
  rank: 15,
  key: "client_safe_model",
});

/** Pipeline steps that must complete before UI work begins (ranks 1–13). */
export const PRE_UI_BUILD_STEP_KEYS = Object.freeze(
  ENGINEERING_BUILD_ORDER.filter((step) => step.rank < UI_BUILD_STEP.rank).map((step) => step.key),
);

export class EngineeringBuildOrderError extends Error {
  constructor(message, { code = "ENGINEERING_BUILD_ORDER_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "EngineeringBuildOrderError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function stepIndex(key) {
  return ENGINEERING_BUILD_ORDER_STEP_KEYS.indexOf(String(key || ""));
}

function stepRank(key) {
  const idx = stepIndex(key);
  return idx >= 0 ? ENGINEERING_BUILD_ORDER[idx].rank : null;
}

/**
 * Assert completed build steps follow the required 15-step order.
 */
export function assertBuildOrderRespected({ completedSteps = [] } = {}) {
  const steps = Array.isArray(completedSteps) ? completedSteps : [];
  let lastRank = 0;

  for (const key of steps) {
    const idx = stepIndex(key);
    if (idx < 0) {
      throw new EngineeringBuildOrderError(`Unknown engineering build step: ${key}`, {
        code: "UNKNOWN_BUILD_STEP",
        details: { key, completedSteps: steps },
      });
    }

    const rank = ENGINEERING_BUILD_ORDER[idx].rank;
    if (rank < lastRank) {
      throw new EngineeringBuildOrderError(
        `Engineering build step out of order: ${key} cannot run before prior build stages.`,
        {
          code: "BUILD_ORDER_OUT_OF_SEQUENCE",
          details: { key, rank, lastRank, completedSteps: steps },
        },
      );
    }
    lastRank = rank;
  }

  return true;
}

/**
 * Assert Network Operations UI is not started before pipeline build steps (1–13).
 */
export function assertUiNotBeforePipeline({
  uiStarted = false,
  completedSteps = [],
  clientExposed = false,
} = {}) {
  const steps = Array.isArray(completedSteps) ? completedSteps : [];
  const uiRank = UI_BUILD_STEP.rank;
  const clientRank = CLIENT_EXPOSURE_STEP.rank;

  if (uiStarted) {
    for (const key of steps) {
      const rank = stepRank(key);
      if (rank != null && rank > uiRank) {
        throw new EngineeringBuildOrderError(
          "Do not start with UI implementation. Network Operations UI is step 14.",
          {
            code: "UI_BEFORE_PIPELINE",
            details: { uiStarted, prematureStep: key, uiRank, stepRank: rank },
          },
        );
      }
    }

    const maxCompletedRank = steps.reduce((max, key) => {
      const rank = stepRank(key);
      return rank != null && rank > max ? rank : max;
    }, 0);

    if (maxCompletedRank > 0 && maxCompletedRank < uiRank - 1) {
      throw new EngineeringBuildOrderError(
        "Network Operations UI must not start before pipeline build steps 1–13 are complete.",
        {
          code: "UI_BEFORE_PIPELINE_COMPLETE",
          details: { uiStarted, maxCompletedRank, requiredMinRank: uiRank - 1 },
        },
      );
    }
  }

  if (clientExposed) {
    for (const key of steps) {
      const rank = stepRank(key);
      if (rank != null && rank >= clientRank) {
        continue;
      }
    }

    const hasUiStep = steps.includes(UI_BUILD_STEP.key);
    const maxCompletedRank = steps.reduce((max, key) => {
      const rank = stepRank(key);
      return rank != null && rank > max ? rank : max;
    }, 0);

    if (maxCompletedRank > 0 && maxCompletedRank < clientRank - 1 && !hasUiStep) {
      throw new EngineeringBuildOrderError(
        "Client-safe model exposure is step 15 — it must follow Network Operations UI and prior pipeline steps.",
        {
          code: "CLIENT_EXPOSURE_BEFORE_UI",
          details: { clientExposed, maxCompletedRank, requiredMinRank: clientRank - 1 },
        },
      );
    }
  }

  return true;
}

/**
 * Assert a proposed next step does not skip ahead of incomplete prerequisites.
 */
export function assertNextBuildStepAllowed({
  completedSteps = [],
  nextStep = null,
} = {}) {
  const steps = Array.isArray(completedSteps) ? completedSteps : [];
  const next = String(nextStep || "");
  const nextIdx = stepIndex(next);

  if (nextIdx < 0) {
    throw new EngineeringBuildOrderError(`Unknown engineering build step: ${next}`, {
      code: "UNKNOWN_BUILD_STEP",
      details: { nextStep: next },
    });
  }

  const nextRank = ENGINEERING_BUILD_ORDER[nextIdx].rank;
  const maxCompletedRank = steps.reduce((max, key) => {
    const rank = stepRank(key);
    return rank != null && rank > max ? rank : max;
  }, 0);

  if (next === UI_BUILD_STEP.key && maxCompletedRank < UI_BUILD_STEP.rank - 1) {
    throw new EngineeringBuildOrderError("Do not start with UI implementation.", {
      code: "UI_BEFORE_PIPELINE",
      details: { nextStep: next, maxCompletedRank, requiredMinRank: UI_BUILD_STEP.rank - 1 },
    });
  }

  if (next === CLIENT_EXPOSURE_STEP.key && maxCompletedRank < CLIENT_EXPOSURE_STEP.rank - 1) {
    throw new EngineeringBuildOrderError(
      "Expose the client-safe model only after Network Operations UI and all prior pipeline steps.",
      {
        code: "CLIENT_EXPOSURE_TOO_EARLY",
        details: { nextStep: next, maxCompletedRank, requiredMinRank: CLIENT_EXPOSURE_STEP.rank - 1 },
      },
    );
  }

  if (nextRank > maxCompletedRank + 1) {
    throw new EngineeringBuildOrderError(
      `Cannot skip to build step ${nextRank} (${next}) — step ${maxCompletedRank + 1} is next.`,
      {
        code: "BUILD_STEP_SKIPPED",
        details: { nextStep: next, nextRank, maxCompletedRank, completedSteps: steps },
      },
    );
  }

  return true;
}

export function buildEngineeringBuildOrderGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...ENGINEERING_BUILD_ORDER_SUMMARY },
    sequence: ENGINEERING_BUILD_ORDER.map((step) => ({ ...step })),
    uiBuildStep: { ...UI_BUILD_STEP },
    clientExposureStep: { ...CLIENT_EXPOSURE_STEP },
    preUiBuildStepKeys: [...PRE_UI_BUILD_STEP_KEYS],
    runtimeRefs: Object.freeze({
      aiIntegrationGuide: "networkOps/aiIntegrationGuide.service.js",
      networkIntegrationSequence: "networkOps/networkIntegrationSequence.js",
      pipelineStages: "networkOps/pipeline/stages.js",
      definitionOfDone: "networkOps/sourceObjectDefinitionOfDone.contract.js",
      commercialSequencing: "networkOps/commercialCalculationSequencing.contract.js",
      clientBoundary: "client/clientBoundary.contract.js",
    }),
    crossRefs: Object.freeze({
      pointer24Scope: "One network + one source object at a time (step 7).",
      pointer25Pipeline: "AI system instruction pipeline narrative aligns with steps 3–15.",
      pointer32Commercial: "Commercial calculation sequencing is step 11.",
      pointer34Inspection: "All Network Data view is part of step 14 — inspection only.",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      mappingFile: `platform_backend/src/network-mappings/${family}/${obj}.mapping.json`,
      fixtureDir: `platform_backend/test/fixtures/networks/${family}/${obj}/`,
      integrationTest: `platform_backend/test/p24.${family}.${obj}.integration.test.js`,
      network: family,
      sourceObject: obj,
    });
  }

  return guide;
}

export function applyEngineeringBuildOrderContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    engineeringBuildOrderPointer: CONTRACT_POINTER,
    engineeringBuildOrderNetwork: network || null,
    engineeringBuildOrderSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
