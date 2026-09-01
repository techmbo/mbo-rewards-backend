/**
 * Pointer 26 — Definition of done for one adapter/source object.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  SOURCE_OBJECT_DONE_CRITERIA,
  SOURCE_OBJECT_DONE_STATUS,
  applySourceObjectDefinitionOfDoneContract,
  isAttributionApplicable,
  isReconciliationApplicable,
} from "../src/modules/networkOps/sourceObjectDefinitionOfDone.contract.js";
import { SourceObjectDefinitionOfDoneService } from "../src/modules/networkOps/sourceObjectDefinitionOfDone.service.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 26 — sourceObjectDefinitionOfDone.contract", () => {
  it("declares contract pointer 26 and fourteen production criteria", () => {
    assert.equal(CONTRACT_POINTER, 26);
    assert.equal(SOURCE_OBJECT_DONE_CRITERIA.length, 14);
    assert.equal(SOURCE_OBJECT_DONE_CRITERIA[0].key, "source_fixture_captured");
    assert.equal(SOURCE_OBJECT_DONE_CRITERIA.at(-1).key, "verify_live_resolved");
  });

  it("marks attribution and reconciliation applicability by stage", () => {
    assert.equal(isAttributionApplicable({ sequenceStage: { stage: "campaigns" }, entityType: "campaign" }), false);
    assert.equal(isAttributionApplicable({ sequenceStage: { stage: "conversions_orders" }, entityType: "conversion" }), true);
    assert.equal(isReconciliationApplicable({ sequenceStage: { stage: "finance" }, entityType: "payment" }), true);
    assert.equal(isReconciliationApplicable({ sequenceStage: { stage: "campaigns" }, entityType: "campaign" }), false);
  });

  it("applySourceObjectDefinitionOfDoneContract stamps response meta", () => {
    const wrapped = applySourceObjectDefinitionOfDoneContract(
      { ok: true, data: { sample: 1 } },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.definitionOfDonePointer, 26);
    assert.equal(wrapped.meta.definitionOfDoneNetwork, "optimise");
    assert.equal(wrapped.meta.definitionOfDoneSourceObject, "campaigns");
  });
});

describe("Pointer 26 — sourceObjectDefinitionOfDone.service", () => {
  const service = new SourceObjectDefinitionOfDoneService();

  it("evaluates optimise/campaigns exemplar as production-ready", async () => {
    const report = service.evaluate("optimise", "campaigns");
    assert.equal(report.contractPointer, 26);
    assert.equal(report.network, "optimise");
    assert.equal(report.sourceObject, "campaigns");
    assert.equal(report.productionReady, true, report.blockers.join(", "));
    assert.equal(report.passedCount, report.applicableCount);
    assert.ok(report.criteria.some((item) => item.key === "source_fixture_captured" && item.status === SOURCE_OBJECT_DONE_STATUS.PASSED));
    assert.ok(report.criteria.some((item) => item.key === "attribution_tests" && item.status === SOURCE_OBJECT_DONE_STATUS.NOT_APPLICABLE));
    assert.ok(report.criteria.some((item) => item.key === "reconciliation_sample" && item.status === SOURCE_OBJECT_DONE_STATUS.NOT_APPLICABLE));
  });

  it("fails unknown source objects without fixtures", () => {
    const report = service.evaluate("optimise", "does_not_exist");
    assert.equal(report.productionReady, false);
    assert.ok(report.blockers.includes("source_fixture_missing"));
  });
});

describe("Pointer 26 — AI integration guide includes definition of done", () => {
  const guide = new AiIntegrationGuideService();

  it("object guide exposes definitionOfDone block", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.ok(payload.definitionOfDone);
    assert.equal(payload.definitionOfDone.contractPointer, 26);
    assert.equal(payload.definitionOfDone.productionReady, true);
    assert.equal(Array.isArray(payload.definitionOfDone.criteria), true);
  });
});

describe("Pointer 26 — GET /ops/network/ai-integration-guide object scope", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("returns 401 without auth for object-scoped guide", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/network/ai-integration-guide?network=optimise&sourceObject=campaigns",
    });
    assert.equal(status, 401);
  });
});
