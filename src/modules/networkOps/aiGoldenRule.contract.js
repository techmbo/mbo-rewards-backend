/**
 * Pointer 37 — Golden rule for AI-assisted implementation.
 * Unproven fields, paths, transforms and finance events must not be assumed — mark VERIFY_LIVE or REVIEW_REQUIRED.
 */
import { FIELD_MAPPING_OUTCOME } from "../mapping/mappingOutcome.contract.js";

export const CONTRACT_POINTER = 37;

export const AI_GOLDEN_RULE_SUMMARY = Object.freeze({
  verbatim:
    "If a source field, JSON path, transformation, relationship, status meaning or finance event cannot be proven from an actual sanitized fixture, an approved MBO mapping/rule, or verified network documentation, do not implement an assumption. Mark it VERIFY_LIVE or REVIEW_REQUIRED as appropriate and continue only with the parts that are proven.",
  mandatoryScope:
    "This rule is mandatory for Claude Code, Copilot, ChatGPT or any other AI-assisted implementation workflow.",
});

/** Acceptable proof sources for AI-assisted implementation. */
export const AI_IMPLEMENTATION_PROOF_SOURCES = Object.freeze([
  {
    key: "sanitized_fixture",
    label: "Actual sanitized fixture",
    contractRef: "test/fixtures/networks/{network}/{sourceObject}/source.api.json",
    enforcedBy: ["networkOps/aiAssistedDevelopment.contract.js", "networkOps/securityFixtureRules.contract.js"],
  },
  {
    key: "approved_mbo_mapping",
    label: "Approved MBO mapping/rule",
    contractRef: "network-mappings/{network}/{sourceObject}.mapping.json",
    enforcedBy: ["mapping/mappingRegistry.contract.js", "mapping/mboCanonicalObjects.contract.js"],
  },
  {
    key: "verified_network_documentation",
    label: "Verified network documentation",
    contractRef: null,
    enforcedBy: ["networkOps/sourceObjects.catalog.js", "networkOps/engineeringSourceOfTruth.contract.js"],
  },
]);

/** Item types covered by the golden rule. */
export const AI_GOLDEN_RULE_ITEM_TYPES = Object.freeze([
  "source_field",
  "json_path",
  "transformation",
  "relationship",
  "status_meaning",
  "finance_event",
]);

/** Allowed markers when proof is absent — assumptions are forbidden. */
export const UNPROVEN_IMPLEMENTATION_MARKERS = Object.freeze([
  FIELD_MAPPING_OUTCOME.VERIFY_LIVE,
  FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED,
]);

/** AI tools/workflows this rule applies to. */
export const MANDATORY_AI_WORKFLOWS = Object.freeze([
  "claude_code",
  "copilot",
  "chatgpt",
  "any_ai_assisted_implementation",
]);

export class AiGoldenRuleError extends Error {
  constructor(message, { code = "AI_GOLDEN_RULE_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "AiGoldenRuleError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function isKnownProofSource(source) {
  return AI_IMPLEMENTATION_PROOF_SOURCES.some((item) => item.key === source);
}

/**
 * Resolve the appropriate marker for an unproven item.
 */
export function resolveUnprovenMarker({ itemType = null, financeRelated = false } = {}) {
  const type = String(itemType || "").toLowerCase();
  if (
    financeRelated ||
    type === "finance_event" ||
    type === "status_meaning" ||
    type === "relationship"
  ) {
    return FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED;
  }
  return FIELD_MAPPING_OUTCOME.VERIFY_LIVE;
}

/**
 * Assert implementation is backed by proof — assumptions are forbidden.
 */
export function assertProvenBeforeImplement({
  itemType = null,
  proven = false,
  proofSource = null,
  assumed = false,
} = {}) {
  if (proven) {
    if (proofSource && !isKnownProofSource(proofSource)) {
      throw new AiGoldenRuleError(`Unknown proof source: ${proofSource}`, {
        code: "UNKNOWN_PROOF_SOURCE",
        details: { itemType, proofSource },
      });
    }
    return true;
  }

  if (assumed) {
    throw new AiGoldenRuleError(
      "Do not implement an assumption when a source field, path, transform, relationship, status meaning or finance event is unproven.",
      {
        code: "UNPROVEN_ASSUMPTION_IMPLEMENTED",
        details: { itemType, proofSource, assumed },
      },
    );
  }

  return true;
}

/**
 * Assert unproven items are marked VERIFY_LIVE or REVIEW_REQUIRED — not silently implemented.
 */
export function assertUnprovenMarkedNotAssumed({
  proven = false,
  marker = null,
  assumed = false,
  itemType = null,
} = {}) {
  if (proven) return true;

  if (assumed) {
    throw new AiGoldenRuleError(
      "Unproven items must be marked VERIFY_LIVE or REVIEW_REQUIRED — not implemented as assumptions.",
      {
        code: "UNPROVEN_ASSUMPTION_IMPLEMENTED",
        details: { itemType, marker, assumed },
      },
    );
  }

  const status = String(marker || "").toUpperCase();
  if (!UNPROVEN_IMPLEMENTATION_MARKERS.includes(status)) {
    throw new AiGoldenRuleError(
      "Mark unproven items VERIFY_LIVE or REVIEW_REQUIRED and continue only with proven parts.",
      {
        code: "UNPROVEN_ITEM_NOT_MARKED",
        details: { itemType, marker: status, allowed: [...UNPROVEN_IMPLEMENTATION_MARKERS] },
      },
    );
  }

  return true;
}

/**
 * Assert an AI workflow is subject to the golden rule.
 */
export function assertMandatoryAiWorkflow({ workflow = null } = {}) {
  const key = String(workflow || "").toLowerCase().replace(/[\s-]+/g, "_");
  const known = MANDATORY_AI_WORKFLOWS.some(
    (item) => item === key || (key.includes("ai") && item === "any_ai_assisted_implementation"),
  );

  if (!known && workflow) {
    throw new AiGoldenRuleError("All AI-assisted implementation workflows are subject to the golden rule.", {
      code: "UNKNOWN_AI_WORKFLOW",
      details: { workflow, mandatory: [...MANDATORY_AI_WORKFLOWS] },
    });
  }

  return true;
}

export function buildAiGoldenRuleGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...AI_GOLDEN_RULE_SUMMARY },
    proofSources: AI_IMPLEMENTATION_PROOF_SOURCES.map((item) => ({ ...item })),
    itemTypes: [...AI_GOLDEN_RULE_ITEM_TYPES],
    unprovenMarkers: [...UNPROVEN_IMPLEMENTATION_MARKERS],
    mandatoryWorkflows: [...MANDATORY_AI_WORKFLOWS],
    runtimeRefs: Object.freeze({
      mappingOutcomeContract: "mapping/mappingOutcome.contract.js",
      aiAssistedDevelopment: "networkOps/aiAssistedDevelopment.contract.js",
      networkOpsAiSystemInstruction: "networkOps/networkOpsAiSystemInstruction.contract.js",
      twoAuthorityRule: "networkOps/twoAuthorityRule.contract.js",
      definitionOfDone: "networkOps/sourceObjectDefinitionOfDone.contract.js",
    }),
    crossRefs: Object.freeze({
      pointer24RequiredInputs: "Fixture + mapping rows are mandatory proof artifacts.",
      pointer25Prohibitions: "AI system instruction prohibits inference without source evidence.",
      pointer26VerifyLive: "VERIFY_LIVE items must be resolved or blocked before production.",
      pointer28TwoAuthority: "AI assumptions must never override canonical or source-fact authority.",
    }),
  };

  if (network && sourceObject) {
    const family = String(network).toLowerCase();
    const obj = String(sourceObject).toLowerCase();
    guide.objectRefs = Object.freeze({
      network: family,
      sourceObject: obj,
      sourceFixture: `platform_backend/test/fixtures/networks/${family}/${obj}/source.api.json`,
      mappingFile: `platform_backend/src/network-mappings/${family}/${obj}.mapping.json`,
      integrationTest: `platform_backend/test/p24.${family}.${obj}.integration.test.js`,
    });
  }

  return guide;
}

export function applyAiGoldenRuleContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    aiGoldenRulePointer: CONTRACT_POINTER,
    aiGoldenRuleNetwork: network || null,
    aiGoldenRuleSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
