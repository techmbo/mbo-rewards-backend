/**
 * Pointer 27 — Engineering source-of-truth hierarchy.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  ENGINEERING_SOURCE_OF_TRUTH_LAYERS,
  FINAL_IMPLEMENTATION_PRINCIPLE,
  NETWORK_CHANGE_RULE,
  EngineeringSourceOfTruthError,
  applyEngineeringSourceOfTruthContract,
  assertChangeRespectsHierarchy,
  buildEngineeringSourceOfTruthGuide,
  getHigherAuthorityLayer,
  getSourceOfTruthLayer,
} from "../src/modules/networkOps/engineeringSourceOfTruth.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 27 — engineeringSourceOfTruth.contract", () => {
  it("declares contract pointer 27 and five ranked layers", () => {
    assert.equal(CONTRACT_POINTER, 27);
    assert.equal(ENGINEERING_SOURCE_OF_TRUTH_LAYERS.length, 5);
    assert.equal(ENGINEERING_SOURCE_OF_TRUTH_LAYERS[0].key, "mbo_canonical_standard");
    assert.equal(ENGINEERING_SOURCE_OF_TRUTH_LAYERS.at(-1).key, "immutable_raw_payload");
    assert.ok(
      ENGINEERING_SOURCE_OF_TRUTH_LAYERS.every((layer, index) => layer.rank === index + 1),
    );
  });

  it("states network change rule and final implementation principle verbatim", () => {
    assert.match(NETWORK_CHANGE_RULE.summary, /update source schema \+ adapter mapping \+ mapping version first/i);
    assert.match(NETWORK_CHANGE_RULE.summary, /Do not change the Client API unless the MBO business model/i);
    assert.match(FINAL_IMPLEMENTATION_PRINCIPLE.verbatim, /Capture 100% of source data/);
    assert.match(FINAL_IMPLEMENTATION_PRINCIPLE.verbatim, /Never let a network redefine MBO Rewards/);
    assert.equal(FINAL_IMPLEMENTATION_PRINCIPLE.rules.length, 4);
  });

  it("getSourceOfTruthLayer and getHigherAuthorityLayer resolve hierarchy", () => {
    const mapping = getSourceOfTruthLayer("mbo_network_mapping_registry");
    assert.equal(mapping.rank, 2);
    const higher = getHigherAuthorityLayer("mbo_network_mapping_registry");
    assert.equal(higher.key, "mbo_canonical_standard");
    assert.equal(getHigherAuthorityLayer("mbo_canonical_standard"), null);
  });

  it("assertChangeRespectsHierarchy blocks client API changes without MBO model gate", () => {
    assert.throws(
      () =>
        assertChangeRespectsHierarchy({
          changeTarget: "client_api",
          changeLayer: "live_sanitized_network_response",
          reason: "network_changed_field_name",
        }),
      (err) => {
        assert.equal(err instanceof EngineeringSourceOfTruthError, true);
        assert.equal(err.code, "CLIENT_API_CHANGE_WITHOUT_MBO_MODEL_CHANGE");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertChangeRespectsHierarchy({
        changeTarget: "client_api",
        changeLayer: "mbo_canonical_standard",
        reason: NETWORK_CHANGE_RULE.clientApiChangeGate,
      }),
    );
  });

  it("buildEngineeringSourceOfTruthGuide includes object refs when scoped", () => {
    const globalGuide = buildEngineeringSourceOfTruthGuide();
    assert.equal(globalGuide.contractPointer, 27);
    assert.equal(globalGuide.hierarchy.length, 5);
    assert.equal(globalGuide.objectRefs, undefined);

    const objectGuide = buildEngineeringSourceOfTruthGuide({
      network: "optimise",
      sourceObject: "campaigns",
    });
    assert.match(objectGuide.objectRefs.mappingRegistry, /optimise\/campaigns\.mapping\.json/);
    assert.match(objectGuide.objectRefs.liveSanitizedResponse, /optimise\/campaigns\/source\.api\.json/);
    assert.match(
      objectGuide.hierarchy.find((layer) => layer.key === "mbo_network_mapping_registry").objectRef,
      /optimise\/campaigns\.mapping\.json/,
    );
  });

  it("applyEngineeringSourceOfTruthContract stamps response meta", () => {
    const wrapped = applyEngineeringSourceOfTruthContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.sourceOfTruthPointer, 27);
    assert.equal(wrapped.meta.sourceOfTruthNetwork, "optimise");
    assert.equal(wrapped.meta.sourceOfTruthSourceObject, "campaigns");
  });
});

describe("Pointer 27 — AI integration guide includes source-of-truth hierarchy", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes sourceOfTruthHierarchy", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.sourceOfTruthPointer, 27);
    assert.equal(payload.sourceOfTruthHierarchy.contractPointer, 27);
    assert.equal(payload.sourceOfTruthHierarchy.hierarchy.length, 5);
  });

  it("object guide includes scoped hierarchy refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.sourceOfTruthHierarchy.contractPointer, 27);
    assert.ok(payload.sourceOfTruthHierarchy.objectRefs.mappingRegistry.includes("campaigns"));
  });

  it("instruction-only guide includes hierarchy", () => {
    const payload = guide.getSystemInstructionGuide();
    assert.equal(payload.sourceOfTruthHierarchy.contractPointer, 27);
  });
});

describe("Pointer 27 — GET /ops/network/ai-integration-guide", () => {
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
