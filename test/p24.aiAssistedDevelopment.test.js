/**
 * Pointer 24 — AI-assisted development contract tests.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  AI_TASK_REQUIRED_INPUTS,
  CONTRACT_POINTER,
  NETWORK_INTEGRATION_OBJECT_SEQUENCE,
  NETWORK_PLUG_IN_LAYERS,
  AiIntegrationTaskError,
  assertAiIntegrationTaskBundle,
  loadAiIntegrationFixtureBundle,
} from "../src/modules/networkOps/aiAssistedDevelopment.contract.js";
import {
  AiIntegrationGuideService,
  buildTargetContractRef,
} from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import {
  resolveSequenceRank,
  resolveSequenceStage,
} from "../src/modules/networkOps/networkIntegrationSequence.js";
import { getSourceObject } from "../src/modules/networkOps/sourceObjects.catalog.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 24 — aiAssistedDevelopment.contract", () => {
  it("declares contract pointer 24 and five required AI task inputs", () => {
    assert.equal(CONTRACT_POINTER, 24);
    assert.deepEqual(AI_TASK_REQUIRED_INPUTS, [
      "targetContract",
      "sourceFixture",
      "mappingRows",
      "expectedCanonical",
      "testCases",
    ]);
  });

  it("defines recommended network integration object sequence", () => {
    assert.equal(NETWORK_INTEGRATION_OBJECT_SEQUENCE.length, 9);
    assert.equal(NETWORK_INTEGRATION_OBJECT_SEQUENCE[0].stage, "campaigns");
    assert.equal(NETWORK_INTEGRATION_OBJECT_SEQUENCE.at(-1).stage, "finance");
    assert.ok(NETWORK_PLUG_IN_LAYERS.length >= 5);
  });

  it("resolveSequenceRank orders campaigns before finance", () => {
    assert.equal(resolveSequenceRank("campaigns", "campaign"), 1);
    assert.equal(resolveSequenceRank("voucher_codes", "coupon"), 3);
    assert.equal(resolveSequenceRank("conversions", "conversion"), 6);
    assert.equal(resolveSequenceRank("invoices", "payment"), 9);
    assert.ok(resolveSequenceRank("campaigns") < resolveSequenceRank("payment_overview", "payment"));
  });

  it("resolveSequenceStage returns stage metadata", () => {
    const stage = resolveSequenceStage("campaigns", "campaign");
    assert.equal(stage.stage, "campaigns");
    assert.equal(stage.mboTargetObject, "NetworkCampaign");
  });

  it("assertAiIntegrationTaskBundle rejects multi-network scope", () => {
    assert.throws(
      () =>
        assertAiIntegrationTaskBundle({
          networks: ["optimise", "impact"],
          network: "optimise",
          sourceObject: "campaigns",
          targetContract: {},
          sourceFixture: {},
          mappingRows: {},
          expectedCanonical: {},
          testCases: "test.js",
        }),
      (err) => {
        assert.equal(err instanceof AiIntegrationTaskError, true);
        assert.equal(err.code, "AI_TASK_MULTI_NETWORK");
        return true;
      },
    );
  });

  it("assertAiIntegrationTaskBundle rejects incomplete bundles", () => {
    assert.throws(
      () =>
        assertAiIntegrationTaskBundle({
          network: "optimise",
          sourceObject: "campaigns",
          targetContract: {},
          sourceFixture: {},
          mappingRows: {},
          expectedCanonical: {},
        }),
      (err) => {
        assert.equal(err.code, "AI_TASK_INPUTS_INCOMPLETE");
        return true;
      },
    );
  });

  it("buildTargetContractRef links mapping registry and sequence", () => {
    const ref = buildTargetContractRef({ network: "optimise", sourceObject: "campaigns" });
    assert.equal(ref.mboTargetObject, "NetworkCampaign");
    assert.equal(ref.mappingVersion, "OPT-CMP-1");
    assert.equal(ref.sequenceRank, 1);
  });

  it("loads optimise/campaigns exemplar fixture bundle", () => {
    const bundle = loadAiIntegrationFixtureBundle("optimise", "campaigns");
    assert.equal(bundle.network, "optimise");
    assert.equal(bundle.sourceObject, "campaigns");
    assert.equal(bundle.targetContract.mboTargetObject, "NetworkCampaign");
    assert.equal(bundle.sourceFixture.name, "Travel Deals Q1");
    assert.ok(Array.isArray(bundle.mappingRows.fields));
    assert.equal(bundle.expectedCanonical.campaignName, "Travel Deals Q1");
    assert.match(String(bundle.testCases), /p24\.optimise\.campaigns/);
  });
});

describe("Pointer 24 — source object catalog sequenceRank", () => {
  it("assigns sequenceRank to catalog entries", () => {
    const campaigns = getSourceObject("optimise", "campaigns");
    const invoices = getSourceObject("optimise", "invoices");
    assert.equal(campaigns.sequenceRank, 1);
    assert.ok(invoices.sequenceRank >= 8);
  });
});

describe("Pointer 24 — ai integration guide service", () => {
  const guide = new AiIntegrationGuideService();

  it("returns global guide with required inputs and sequence", () => {
    const global = guide.getGlobalGuide();
    assert.equal(global.contractPointer, 24);
    assert.equal(global.requiredInputs.length, 5);
    assert.equal(global.recommendedSequence.length, 9);
    assert.equal(global.systemInstructionPointer, 25);
    assert.ok(global.systemInstruction);
    assert.equal(global.prohibitions.length, 9);
  });

  it("returns network guide sorted by sequenceRank", () => {
    const net = guide.getNetworkGuide("optimise");
    assert.equal(net.network, "optimise");
    assert.ok(net.sourceObjects.length > 0);
    const ranks = net.sourceObjects.map((o) => o.sequenceRank ?? 99);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    const campaigns = net.sourceObjects.find((o) => o.sourceObject === "campaigns");
    assert.equal(campaigns.hasFixtureBundle, true);
  });

  it("returns object guide checklist for optimise campaigns", () => {
    const obj = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(obj.sourceObject, "campaigns");
    assert.equal(obj.checklist.length, 5);
    assert.equal(obj.checklist.every((c) => c.satisfied), true);
    assert.equal(obj.exemplarBundle.hasManifest, true);
  });
});

describe("Pointer 24 — GET /ops/network/ai-integration-guide", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("returns 401 without auth", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/network/ai-integration-guide",
    });
    assert.equal(status, 401);
  });
});
