/**
 * Pointer 28 — Two-authority rule: MBO meaning vs source facts.
 * MBO Canonical Standard owns meaning; live/raw network evidence owns supplied facts.
 * The Mapping Registry connects the two — neither side may be overridden by UI, docs, or AI.
 */
import { FIELD_MAPPING_OUTCOME } from "../mapping/mappingOutcome.contract.js";

export const CONTRACT_POINTER = 28;

export const TWO_AUTHORITY_RULE_SUMMARY = Object.freeze({
  verbatim:
    "MBO Canonical Standard is the authority for what a field means inside MBO Rewards. Actual live/sanitized network payload plus immutable raw evidence is the authority for what the network actually supplied. The Mapping Registry connects the two. UI labels, old code, documentation examples, or AI assumptions must never override either authority.",
});

/** Authority for MBO/client field meaning. */
export const MBO_MEANING_AUTHORITY = Object.freeze({
  key: "mbo_meaning",
  label: "MBO Canonical Standard",
  owns: "What a field means inside MBO Rewards.",
  contractRef: "mboCanonicalObjects.contract.js",
  enforcedBy: [
    "mboCanonicalObjects.contract.js",
    "mapping/mboCanonicalObjects.contract.js",
    "clientBoundary.contract.js",
  ],
});

/** Authority for what the network actually supplied. */
export const SOURCE_FACTS_AUTHORITY = Object.freeze({
  key: "source_facts",
  label: "Live/sanitized network payload + immutable raw evidence",
  owns: "What the network actually supplied on a specific run.",
  contractRef: "rawPayload.service.js",
  enforcedBy: [
    "rawPayload.service.js",
    "sourceSchemaObserver.service.js",
    "test/fixtures/networks/{network}/{sourceObject}/source.api.json",
  ],
});

/** Bridge between meaning and facts — translation only, not redefinition. */
export const MAPPING_REGISTRY_BRIDGE = Object.freeze({
  key: "mapping_registry_bridge",
  label: "MBO-to-Network Mapping Registry",
  role: "Connects MBO meaning to source facts through approved translation rules.",
  contractRef: "network-mappings/{network}/{sourceObject}.mapping.json",
  enforcedBy: [
    "mappingRegistry.contract.js",
    "mappingRegistry.compiler.js",
    "mapping/engine.js",
  ],
});

export const FORBIDDEN_AUTHORITY_OVERRIDES = Object.freeze([
  "ui_labels",
  "old_code",
  "documentation_examples",
  "ai_assumptions",
]);

export const TWO_AUTHORITY_RESOLUTION_RULES = Object.freeze([
  {
    key: "missed_mapper_value",
    situation: "Network payload contains a value that the mapper misses.",
    action: "Fix the mapping.",
    forbiddenActions: ["change_mbo_canonical_standard", "change_client_api", "discard_source_value"],
    requiredOutcome: FIELD_MAPPING_OUTCOME.MAPPED,
  },
  {
    key: "source_only_without_canonical",
    situation: "MBO canonical field does not exist for a source-only concept.",
    action: "Retain the source value without creating a new canonical field automatically.",
    forbiddenActions: ["auto_create_canonical_field", "discard_source_value", "expose_raw_to_client"],
    requiredOutcome: FIELD_MAPPING_OUTCOME.SOURCE_ONLY,
  },
]);

export class TwoAuthorityRuleError extends Error {
  constructor(message, { code = "TWO_AUTHORITY_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "TwoAuthorityRuleError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function interpolateRef(template, { network, sourceObject } = {}) {
  if (!template) return null;
  return String(template)
    .replaceAll("{network}", String(network || "").toLowerCase())
    .replaceAll("{sourceObject}", String(sourceObject || "").toLowerCase());
}

/**
 * Assert a proposed resolution respects the two-authority rule.
 */
export function assertTwoAuthorityCompliance({
  situation,
  proposedAction,
  authorityOverride = null,
} = {}) {
  if (authorityOverride && FORBIDDEN_AUTHORITY_OVERRIDES.includes(authorityOverride)) {
    throw new TwoAuthorityRuleError(
      `${authorityOverride} must never override MBO meaning or source facts.`,
      {
        code: "FORBIDDEN_AUTHORITY_OVERRIDE",
        details: { authorityOverride, forbidden: [...FORBIDDEN_AUTHORITY_OVERRIDES] },
      },
    );
  }

  if (situation === "missed_mapper_value") {
    const forbidden = [
      "change_mbo_canonical_standard",
      "change_client_api",
      "discard_source_value",
      "auto_create_canonical_field",
    ];
    if (forbidden.includes(proposedAction)) {
      throw new TwoAuthorityRuleError(
        "Missed mapper values must be fixed in the mapping registry — do not change canonical meaning or discard source facts.",
        {
          code: "MISSED_VALUE_WRONG_RESOLUTION",
          details: { situation, proposedAction, expectedAction: "fix_mapping" },
        },
      );
    }
    if (proposedAction !== "fix_mapping") {
      throw new TwoAuthorityRuleError("Missed mapper values require a mapping fix.", {
        code: "MISSED_VALUE_REQUIRES_MAPPING_FIX",
        details: { situation, proposedAction },
      });
    }
    return true;
  }

  if (situation === "source_only_without_canonical") {
    const forbidden = ["auto_create_canonical_field", "discard_source_value", "expose_raw_to_client"];
    if (forbidden.includes(proposedAction)) {
      throw new TwoAuthorityRuleError(
        "Source-only concepts must be retained as SOURCE_ONLY — do not auto-create canonical fields or expose raw network data.",
        {
          code: "SOURCE_ONLY_WRONG_RESOLUTION",
          details: { situation, proposedAction, expectedOutcome: FIELD_MAPPING_OUTCOME.SOURCE_ONLY },
        },
      );
    }
    if (proposedAction !== "retain_source_only") {
      throw new TwoAuthorityRuleError("Source-only concepts must be retained without new canonical fields.", {
        code: "SOURCE_ONLY_REQUIRES_RETENTION",
        details: { situation, proposedAction },
      });
    }
    return true;
  }

  throw new TwoAuthorityRuleError(`Unknown two-authority situation: ${situation}`, {
    code: "UNKNOWN_TWO_AUTHORITY_SITUATION",
    details: { situation, proposedAction },
  });
}

export function buildTwoAuthorityRuleGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...TWO_AUTHORITY_RULE_SUMMARY },
    authorities: Object.freeze({
      mboMeaning: {
        ...MBO_MEANING_AUTHORITY,
        objectRef: interpolateRef(MBO_MEANING_AUTHORITY.contractRef, { network, sourceObject }),
      },
      sourceFacts: {
        ...SOURCE_FACTS_AUTHORITY,
        objectRef: interpolateRef(
          "test/fixtures/networks/{network}/{sourceObject}/source.api.json",
          { network, sourceObject },
        ),
        rawEvidenceRef: interpolateRef(
          "platform_backend/src/modules/raw/rawPayload.service.js",
          { network, sourceObject },
        ),
      },
      mappingRegistryBridge: {
        ...MAPPING_REGISTRY_BRIDGE,
        objectRef: interpolateRef(MAPPING_REGISTRY_BRIDGE.contractRef, { network, sourceObject }),
      },
    }),
    forbiddenOverrides: [...FORBIDDEN_AUTHORITY_OVERRIDES],
    resolutionRules: TWO_AUTHORITY_RESOLUTION_RULES.map((rule) => ({ ...rule })),
    mappingOutcomes: Object.freeze({
      missedValueFix: FIELD_MAPPING_OUTCOME.MAPPED,
      sourceOnlyRetention: FIELD_MAPPING_OUTCOME.SOURCE_ONLY,
      engineeringDefect: FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING,
    }),
  };

  return guide;
}

export function applyTwoAuthorityRuleContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    twoAuthorityPointer: CONTRACT_POINTER,
    twoAuthorityNetwork: network || null,
    twoAuthoritySourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
