/**
 * Pointer 25 — Required AI system instruction for Network Operations work.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  NETWORK_OPS_AI_PROHIBITIONS,
  NETWORK_OPS_AI_SYSTEM_INSTRUCTION,
  NETWORK_OPS_AI_PIPELINE_NARRATIVE,
  NON_COLLAPSIBLE_CANONICAL_OBJECTS,
  NetworkOpsAiInstructionError,
  assertMappingOutcomeNotMisclassified,
  assertNarrativeCoversRuntimePipeline,
  assertNoGenericAssetCollapse,
  assertProhibitionCompliance,
  buildNetworkOpsAiSystemInstructionGuide,
  getProhibition,
  listNarrativeRuntimeStages,
} from "../src/modules/networkOps/networkOpsAiSystemInstruction.contract.js";
import { PIPELINE_STAGES } from "../src/modules/networkOps/pipeline/stages.js";
import {
  ENGINEERING_DEFECT_OUTCOMES,
  FIELD_MAPPING_OUTCOME,
  isEngineeringDefect,
} from "../src/modules/mapping/mappingOutcome.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 25 — networkOpsAiSystemInstruction.contract", () => {
  it("declares contract pointer 25 and verbatim system instruction", () => {
    assert.equal(CONTRACT_POINTER, 25);
    assert.match(NETWORK_OPS_AI_SYSTEM_INSTRUCTION, /MBO Rewards owns the canonical data model/);
    assert.match(NETWORK_OPS_AI_SYSTEM_INSTRUCTION, /Do not treat SOURCE_PRESENT_MAPPING_MISSING as NOT_SUPPORTED/);
    assert.match(NETWORK_OPS_AI_SYSTEM_INSTRUCTION, /Client-safe MBO model/);
  });

  it("lists nine hard prohibitions with enforcement refs", () => {
    assert.equal(NETWORK_OPS_AI_PROHIBITIONS.length, 9);
    const codes = NETWORK_OPS_AI_PROHIBITIONS.map((p) => p.code);
    assert.ok(codes.includes("NO_RAW_TO_CLIENT"));
    assert.ok(codes.includes("NETWORK_PAYMENT_NOT_MBO_RECEIPT"));
    assert.ok(codes.includes("NO_DUPLICATE_ORDERS"));
    for (const p of NETWORK_OPS_AI_PROHIBITIONS) {
      assert.ok(p.enforcedBy?.length > 0, `${p.code} missing enforcedBy`);
    }
  });

  it("names non-collapsible canonical objects", () => {
    assert.ok(NON_COLLAPSIBLE_CANONICAL_OBJECTS.includes("NetworkCampaign"));
    assert.ok(NON_COLLAPSIBLE_CANONICAL_OBJECTS.includes("CouponVoucher"));
    assert.ok(NON_COLLAPSIBLE_CANONICAL_OBJECTS.includes("NetworkPayment"));
    assert.equal(NON_COLLAPSIBLE_CANONICAL_OBJECTS.length, 7);
  });

  it("maps AI pipeline narrative to all runtime stages", () => {
    assert.equal(NETWORK_OPS_AI_PIPELINE_NARRATIVE.length, 7);
    assert.doesNotThrow(() => assertNarrativeCoversRuntimePipeline());
    assert.deepEqual(new Set(listNarrativeRuntimeStages()), new Set(PIPELINE_STAGES));
  });

  it("SOURCE_PRESENT_MAPPING_MISSING is an engineering defect, not NOT_SUPPORTED", () => {
    assert.ok(isEngineeringDefect(FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING));
    assert.equal(isEngineeringDefect(FIELD_MAPPING_OUTCOME.NOT_SUPPORTED), false);
    assert.notEqual(
      FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING,
      FIELD_MAPPING_OUTCOME.NOT_SUPPORTED,
    );
    assert.deepEqual(ENGINEERING_DEFECT_OUTCOMES, [
      FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING,
    ]);
  });

  it("assertMappingOutcomeNotMisclassified rejects NOT_SUPPORTED when source is present", () => {
    assert.throws(
      () =>
        assertMappingOutcomeNotMisclassified(FIELD_MAPPING_OUTCOME.NOT_SUPPORTED, {
          sourcePresent: true,
        }),
      NetworkOpsAiInstructionError,
    );
    assert.doesNotThrow(() =>
      assertMappingOutcomeNotMisclassified(FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING, {
        sourcePresent: true,
      }),
    );
  });

  it("assertNoGenericAssetCollapse rejects generic asset targets", () => {
    assert.throws(
      () => assertNoGenericAssetCollapse({ targetField: "generic_asset" }),
      (err) => {
        assert.equal(err.code, "NO_GENERIC_ASSET_COLLAPSE");
        return true;
      },
    );
  });

  it("assertProhibitionCompliance resolves known prohibition codes", () => {
    const p = assertProhibitionCompliance("NO_RENAME_CANONICAL_FIELDS");
    assert.equal(p.code, "NO_RENAME_CANONICAL_FIELDS");
    assert.ok(getProhibition("NO_RAW_TO_CLIENT"));
  });

  it("buildNetworkOpsAiSystemInstructionGuide returns complete guide payload", () => {
    const guide = buildNetworkOpsAiSystemInstructionGuide();
    assert.equal(guide.contractPointer, 25);
    assert.equal(guide.systemInstructionRef, "networkOpsAiSystemInstruction.contract.js");
    assert.equal(guide.prohibitions.length, 9);
    assert.equal(guide.pipelineNarrative.length, 7);
    assert.deepEqual(guide.runtimePipelineStages, [...PIPELINE_STAGES]);
    assert.equal(guide.mappingOutcomeRules.mappingMissingNotNotSupported, true);
  });
});

describe("Pointer 25 — AI integration guide includes system instruction", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide embeds P25 instruction and keeps P24 contract pointer", () => {
    const global = guide.getGlobalGuide();
    assert.equal(global.contractPointer, 24);
    assert.equal(global.systemInstructionPointer, 25);
    assert.equal(global.systemInstructionRef, "networkOpsAiSystemInstruction.contract.js");
    assert.ok(global.systemInstruction);
    assert.equal(global.prohibitions.length, 9);
    assert.equal(global.pipelineNarrative.length, 7);
  });

  it("getSystemInstructionGuide returns P25-only payload", () => {
    const instruction = guide.getSystemInstructionGuide();
    assert.equal(instruction.contractPointer, 25);
    assert.ok(instruction.systemInstruction);
  });
});

describe("Pointer 25 — GET /ops/network/ai-integration-guide?instruction=1", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("returns 401 without auth for instruction-only guide", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/network/ai-integration-guide?instruction=1",
    });
    assert.equal(status, 401);
  });
});
