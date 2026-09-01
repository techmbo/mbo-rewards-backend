/**
 * Pointer 35 — Required engineering build order.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  ENGINEERING_BUILD_ORDER,
  ENGINEERING_BUILD_ORDER_SUMMARY,
  EngineeringBuildOrderError,
  applyEngineeringBuildOrderContract,
  assertBuildOrderRespected,
  assertNextBuildStepAllowed,
  assertUiNotBeforePipeline,
  buildEngineeringBuildOrderGuide,
} from "../src/modules/networkOps/engineeringBuildOrder.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

const FULL_SEQUENCE = ENGINEERING_BUILD_ORDER.map((step) => step.key);

describe("Pointer 35 — engineeringBuildOrder.contract", () => {
  it("declares contract pointer 35 and fifteen-step build order", () => {
    assert.equal(CONTRACT_POINTER, 35);
    assert.equal(ENGINEERING_BUILD_ORDER.length, 15);
    assert.equal(ENGINEERING_BUILD_ORDER[0].key, "freeze_canonical_contracts");
    assert.equal(ENGINEERING_BUILD_ORDER[13].key, "network_operations_ui");
    assert.equal(ENGINEERING_BUILD_ORDER.at(-1).key, "client_safe_model");
    assert.match(ENGINEERING_BUILD_ORDER_SUMMARY.uiLastRule, /Do not start with UI implementation/i);
  });

  it("assertBuildOrderRespected rejects out-of-order steps", () => {
    assert.doesNotThrow(() =>
      assertBuildOrderRespected({ completedSteps: FULL_SEQUENCE }),
    );
    assert.throws(
      () =>
        assertBuildOrderRespected({
          completedSteps: ["network_operations_ui", "raw_ingestion_immutable_storage"],
        }),
      (err) => {
        assert.equal(err.code, "BUILD_ORDER_OUT_OF_SEQUENCE");
        return true;
      },
    );
    assert.throws(
      () => assertBuildOrderRespected({ completedSteps: ["unknown_step"] }),
      (err) => {
        assert.equal(err.code, "UNKNOWN_BUILD_STEP");
        return true;
      },
    );
  });

  it("assertUiNotBeforePipeline blocks UI before pipeline completion", () => {
    assert.doesNotThrow(() =>
      assertUiNotBeforePipeline({
        uiStarted: true,
        completedSteps: FULL_SEQUENCE.slice(0, 13),
      }),
    );
    assert.throws(
      () =>
        assertUiNotBeforePipeline({
          uiStarted: true,
          completedSteps: ["freeze_canonical_contracts", "database_objects_constraints"],
        }),
      (err) => {
        assert.equal(err.code, "UI_BEFORE_PIPELINE_COMPLETE");
        return true;
      },
    );
  });

  it("assertNextBuildStepAllowed blocks skipped steps and early UI", () => {
    assert.doesNotThrow(() =>
      assertNextBuildStepAllowed({
        completedSteps: FULL_SEQUENCE.slice(0, 5),
        nextStep: "versioned_mapping_registry",
      }),
    );
    assert.throws(
      () =>
        assertNextBuildStepAllowed({
          completedSteps: ["freeze_canonical_contracts"],
          nextStep: "network_operations_ui",
        }),
      (err) => {
        assert.equal(err.code, "UI_BEFORE_PIPELINE");
        return true;
      },
    );
    assert.throws(
      () =>
        assertNextBuildStepAllowed({
          completedSteps: FULL_SEQUENCE.slice(0, 3),
          nextStep: "attribution",
        }),
      (err) => {
        assert.equal(err.code, "BUILD_STEP_SKIPPED");
        return true;
      },
    );
    assert.throws(
      () =>
        assertNextBuildStepAllowed({
          completedSteps: FULL_SEQUENCE.slice(0, 12),
          nextStep: "client_safe_model",
        }),
      (err) => {
        assert.equal(err.code, "CLIENT_EXPOSURE_TOO_EARLY");
        return true;
      },
    );
  });

  it("buildEngineeringBuildOrderGuide includes scoped object refs", () => {
    const globalGuide = buildEngineeringBuildOrderGuide();
    assert.equal(globalGuide.contractPointer, 35);
    assert.equal(globalGuide.sequence.length, 15);
    assert.equal(globalGuide.uiBuildStep.rank, 14);

    const objectGuide = buildEngineeringBuildOrderGuide({
      network: "optimise",
      sourceObject: "campaigns",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.match(objectGuide.objectRefs.fixtureDir, /optimise\/campaigns/);
  });

  it("applyEngineeringBuildOrderContract stamps response meta", () => {
    const wrapped = applyEngineeringBuildOrderContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.engineeringBuildOrderPointer, 35);
    assert.equal(wrapped.meta.engineeringBuildOrderNetwork, "optimise");
  });
});

describe("Pointer 35 — AI integration guide includes engineering build order", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes engineeringBuildOrder", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.engineeringBuildOrderPointer, 35);
    assert.equal(payload.engineeringBuildOrder.contractPointer, 35);
    assert.equal(payload.engineeringBuildOrder.sequence.length, 15);
    assert.match(payload.engineeringBuildOrder.summary.uiLastRule, /Do not start with UI/i);
  });

  it("object guide includes scoped build-order refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.engineeringBuildOrder.contractPointer, 35);
    assert.match(payload.engineeringBuildOrder.objectRefs.mappingFile, /campaigns\.mapping\.json/);
  });
});

describe("Pointer 35 — GET /ops/network/ai-integration-guide", () => {
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
