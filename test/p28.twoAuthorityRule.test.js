/**
 * Pointer 28 — Two-authority rule: MBO meaning vs source facts.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  FORBIDDEN_AUTHORITY_OVERRIDES,
  MAPPING_REGISTRY_BRIDGE,
  MBO_MEANING_AUTHORITY,
  SOURCE_FACTS_AUTHORITY,
  TWO_AUTHORITY_RESOLUTION_RULES,
  TWO_AUTHORITY_RULE_SUMMARY,
  TwoAuthorityRuleError,
  applyTwoAuthorityRuleContract,
  assertTwoAuthorityCompliance,
  buildTwoAuthorityRuleGuide,
} from "../src/modules/networkOps/twoAuthorityRule.contract.js";
import { FIELD_MAPPING_OUTCOME } from "../src/modules/mapping/mappingOutcome.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 28 — twoAuthorityRule.contract", () => {
  it("declares contract pointer 28 and two authorities plus mapping bridge", () => {
    assert.equal(CONTRACT_POINTER, 28);
    assert.equal(MBO_MEANING_AUTHORITY.key, "mbo_meaning");
    assert.equal(SOURCE_FACTS_AUTHORITY.key, "source_facts");
    assert.equal(MAPPING_REGISTRY_BRIDGE.key, "mapping_registry_bridge");
    assert.match(TWO_AUTHORITY_RULE_SUMMARY.verbatim, /MBO Canonical Standard is the authority for what a field means/);
    assert.match(TWO_AUTHORITY_RULE_SUMMARY.verbatim, /UI labels, old code, documentation examples, or AI assumptions must never override either authority/);
  });

  it("lists forbidden authority overrides and resolution rules", () => {
    assert.deepEqual(FORBIDDEN_AUTHORITY_OVERRIDES, [
      "ui_labels",
      "old_code",
      "documentation_examples",
      "ai_assumptions",
    ]);
    assert.equal(TWO_AUTHORITY_RESOLUTION_RULES.length, 2);
    assert.equal(TWO_AUTHORITY_RESOLUTION_RULES[0].key, "missed_mapper_value");
    assert.equal(TWO_AUTHORITY_RESOLUTION_RULES[1].requiredOutcome, FIELD_MAPPING_OUTCOME.SOURCE_ONLY);
  });

  it("assertTwoAuthorityCompliance rejects forbidden overrides", () => {
    assert.throws(
      () =>
        assertTwoAuthorityCompliance({
          situation: "missed_mapper_value",
          proposedAction: "fix_mapping",
          authorityOverride: "ai_assumptions",
        }),
      (err) => {
        assert.equal(err instanceof TwoAuthorityRuleError, true);
        assert.equal(err.code, "FORBIDDEN_AUTHORITY_OVERRIDE");
        return true;
      },
    );
  });

  it("assertTwoAuthorityCompliance requires mapping fix for missed values", () => {
    assert.doesNotThrow(() =>
      assertTwoAuthorityCompliance({
        situation: "missed_mapper_value",
        proposedAction: "fix_mapping",
      }),
    );
    assert.throws(
      () =>
        assertTwoAuthorityCompliance({
          situation: "missed_mapper_value",
          proposedAction: "change_client_api",
        }),
      (err) => {
        assert.equal(err.code, "MISSED_VALUE_WRONG_RESOLUTION");
        return true;
      },
    );
  });

  it("assertTwoAuthorityCompliance requires source-only retention without auto canonical fields", () => {
    assert.doesNotThrow(() =>
      assertTwoAuthorityCompliance({
        situation: "source_only_without_canonical",
        proposedAction: "retain_source_only",
      }),
    );
    assert.throws(
      () =>
        assertTwoAuthorityCompliance({
          situation: "source_only_without_canonical",
          proposedAction: "auto_create_canonical_field",
        }),
      (err) => {
        assert.equal(err.code, "SOURCE_ONLY_WRONG_RESOLUTION");
        return true;
      },
    );
  });

  it("buildTwoAuthorityRuleGuide includes scoped object refs", () => {
    const globalGuide = buildTwoAuthorityRuleGuide();
    assert.equal(globalGuide.contractPointer, 28);
    assert.equal(globalGuide.authorities.mboMeaning.key, "mbo_meaning");
    assert.equal(globalGuide.mappingOutcomes.sourceOnlyRetention, FIELD_MAPPING_OUTCOME.SOURCE_ONLY);

    const objectGuide = buildTwoAuthorityRuleGuide({ network: "optimise", sourceObject: "campaigns" });
    assert.match(objectGuide.authorities.mappingRegistryBridge.objectRef, /optimise\/campaigns\.mapping\.json/);
    assert.match(objectGuide.authorities.sourceFacts.objectRef, /optimise\/campaigns\/source\.api\.json/);
  });

  it("applyTwoAuthorityRuleContract stamps response meta", () => {
    const wrapped = applyTwoAuthorityRuleContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.twoAuthorityPointer, 28);
    assert.equal(wrapped.meta.twoAuthorityNetwork, "optimise");
  });
});

describe("Pointer 28 — AI integration guide includes two-authority rule", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes twoAuthorityRule", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.twoAuthorityPointer, 28);
    assert.equal(payload.twoAuthorityRule.contractPointer, 28);
    assert.equal(payload.twoAuthorityRule.resolutionRules.length, 2);
  });

  it("object guide includes scoped twoAuthorityRule", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.twoAuthorityRule.contractPointer, 28);
    assert.match(payload.twoAuthorityRule.authorities.mappingRegistryBridge.objectRef, /campaigns/);
  });
});

describe("Pointer 28 — GET /ops/network/ai-integration-guide", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("returns 401 without auth for global guide", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/network/ai-integration-guide",
    });
    assert.equal(status, 401);
  });
});
