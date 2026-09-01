/**
 * Pointer 37 — Golden rule for AI-assisted implementation.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  AI_GOLDEN_RULE_ITEM_TYPES,
  AI_GOLDEN_RULE_SUMMARY,
  CONTRACT_POINTER,
  MANDATORY_AI_WORKFLOWS,
  applyAiGoldenRuleContract,
  assertMandatoryAiWorkflow,
  assertProvenBeforeImplement,
  assertUnprovenMarkedNotAssumed,
  buildAiGoldenRuleGuide,
  resolveUnprovenMarker,
} from "../src/modules/networkOps/aiGoldenRule.contract.js";
import { FIELD_MAPPING_OUTCOME } from "../src/modules/mapping/mappingOutcome.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 37 — aiGoldenRule.contract", () => {
  it("declares contract pointer 37 and golden rule summary", () => {
    assert.equal(CONTRACT_POINTER, 37);
    assert.match(AI_GOLDEN_RULE_SUMMARY.verbatim, /do not implement an assumption/i);
    assert.match(AI_GOLDEN_RULE_SUMMARY.verbatim, /VERIFY_LIVE or REVIEW_REQUIRED/i);
    assert.match(AI_GOLDEN_RULE_SUMMARY.mandatoryScope, /Claude Code, Copilot, ChatGPT/i);
    assert.equal(AI_GOLDEN_RULE_ITEM_TYPES.length, 6);
    assert.ok(MANDATORY_AI_WORKFLOWS.includes("claude_code"));
  });

  it("resolveUnprovenMarker selects VERIFY_LIVE or REVIEW_REQUIRED appropriately", () => {
    assert.equal(resolveUnprovenMarker({ itemType: "json_path" }), FIELD_MAPPING_OUTCOME.VERIFY_LIVE);
    assert.equal(resolveUnprovenMarker({ itemType: "finance_event" }), FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED);
    assert.equal(resolveUnprovenMarker({ itemType: "status_meaning" }), FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED);
  });

  it("assertProvenBeforeImplement rejects assumptions without proof", () => {
    assert.doesNotThrow(() =>
      assertProvenBeforeImplement({
        itemType: "json_path",
        proven: true,
        proofSource: "sanitized_fixture",
      }),
    );
    assert.throws(
      () =>
        assertProvenBeforeImplement({
          itemType: "transformation",
          proven: false,
          assumed: true,
        }),
      (err) => {
        assert.equal(err.code, "UNPROVEN_ASSUMPTION_IMPLEMENTED");
        return true;
      },
    );
  });

  it("assertUnprovenMarkedNotAssumed requires VERIFY_LIVE or REVIEW_REQUIRED", () => {
    assert.doesNotThrow(() =>
      assertUnprovenMarkedNotAssumed({
        proven: false,
        marker: FIELD_MAPPING_OUTCOME.VERIFY_LIVE,
      }),
    );
    assert.throws(
      () =>
        assertUnprovenMarkedNotAssumed({
          proven: false,
          marker: "MAPPED",
        }),
      (err) => {
        assert.equal(err.code, "UNPROVEN_ITEM_NOT_MARKED");
        return true;
      },
    );
    assert.throws(
      () =>
        assertUnprovenMarkedNotAssumed({
          proven: false,
          assumed: true,
        }),
      (err) => {
        assert.equal(err.code, "UNPROVEN_ASSUMPTION_IMPLEMENTED");
        return true;
      },
    );
  });

  it("assertMandatoryAiWorkflow applies to listed AI tools", () => {
    assert.doesNotThrow(() => assertMandatoryAiWorkflow({ workflow: "claude_code" }));
    assert.doesNotThrow(() => assertMandatoryAiWorkflow({ workflow: "copilot" }));
    assert.doesNotThrow(() => assertMandatoryAiWorkflow({ workflow: "chatgpt" }));
  });

  it("buildAiGoldenRuleGuide includes scoped object refs", () => {
    const globalGuide = buildAiGoldenRuleGuide();
    assert.equal(globalGuide.contractPointer, 37);
    assert.equal(globalGuide.proofSources.length, 3);
    assert.equal(globalGuide.unprovenMarkers.length, 2);

    const objectGuide = buildAiGoldenRuleGuide({ network: "optimise", sourceObject: "campaigns" });
    assert.match(objectGuide.objectRefs.sourceFixture, /optimise\/campaigns\/source\.api\.json/);
  });

  it("applyAiGoldenRuleContract stamps response meta", () => {
    const wrapped = applyAiGoldenRuleContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.aiGoldenRulePointer, 37);
    assert.equal(wrapped.meta.aiGoldenRuleNetwork, "optimise");
  });
});

describe("Pointer 37 — AI integration guide includes golden rule", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes aiGoldenRule", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.aiGoldenRulePointer, 37);
    assert.equal(payload.aiGoldenRule.contractPointer, 37);
    assert.match(payload.aiGoldenRule.summary.verbatim, /continue only with the parts that are proven/i);
  });

  it("object guide includes scoped golden-rule refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.aiGoldenRule.contractPointer, 37);
    assert.match(payload.aiGoldenRule.objectRefs.mappingFile, /campaigns\.mapping\.json/);
  });
});

describe("Pointer 37 — GET /ops/network/ai-integration-guide", () => {
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
