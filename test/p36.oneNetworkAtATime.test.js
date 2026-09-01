/**
 * Pointer 36 — One-network-at-a-time delivery rule.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  NETWORK_DELIVERY_OBJECT_SEQUENCE,
  ONE_NETWORK_DELIVERY_SUMMARY,
  SOURCE_OBJECT_COMPLETION_GATE_KEYS,
  applyOneNetworkAtATimeContract,
  assertNetworkDeliverySequence,
  assertSingleNetworkScope,
  assertSourceObjectDeliveryComplete,
  buildOneNetworkAtATimeGuide,
} from "../src/modules/networkOps/oneNetworkAtATime.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

function allGatesPassed() {
  return Object.fromEntries(SOURCE_OBJECT_COMPLETION_GATE_KEYS.map((key) => [key, true]));
}

describe("Pointer 36 — oneNetworkAtATime.contract", () => {
  it("declares contract pointer 36 and nine-stage delivery sequence", () => {
    assert.equal(CONTRACT_POINTER, 36);
    assert.equal(NETWORK_DELIVERY_OBJECT_SEQUENCE.length, 9);
    assert.equal(NETWORK_DELIVERY_OBJECT_SEQUENCE[0].label, "Campaigns");
    assert.equal(NETWORK_DELIVERY_OBJECT_SEQUENCE[1].label, "Supplier Commission Rules");
    assert.equal(NETWORK_DELIVERY_OBJECT_SEQUENCE.at(-1).label, "Network Finance");
    assert.match(ONE_NETWORK_DELIVERY_SUMMARY.scopeRule, /Do not ask AI to integrate all networks together/i);
    assert.match(ONE_NETWORK_DELIVERY_SUMMARY.completionRule, /not complete because data appears on a screen/i);
    assert.equal(SOURCE_OBJECT_COMPLETION_GATE_KEYS.length, 11);
  });

  it("assertSingleNetworkScope rejects multi-network tasks", () => {
    assert.doesNotThrow(() => assertSingleNetworkScope({ networks: ["optimise"], network: "optimise" }));
    assert.throws(
      () => assertSingleNetworkScope({ networks: ["optimise", "impact"] }),
      (err) => {
        assert.equal(err.code, "MULTI_NETWORK_SCOPE");
        return true;
      },
    );
  });

  it("assertNetworkDeliverySequence rejects out-of-order objects", () => {
    assert.doesNotThrow(() =>
      assertNetworkDeliverySequence({ completedObjects: ["campaigns", "commission_rules", "coupons"] }),
    );
    assert.throws(
      () => assertNetworkDeliverySequence({ completedObjects: ["coupons", "campaigns"] }),
      (err) => {
        assert.equal(err.code, "DELIVERY_SEQUENCE_OUT_OF_ORDER");
        return true;
      },
    );
  });

  it("assertSourceObjectDeliveryComplete rejects UI-only and incomplete gates", () => {
    assert.doesNotThrow(() =>
      assertSourceObjectDeliveryComplete({ gates: allGatesPassed(), uiOnlyComplete: false }),
    );
    assert.throws(
      () => assertSourceObjectDeliveryComplete({ gates: allGatesPassed(), uiOnlyComplete: true }),
      (err) => {
        assert.equal(err.code, "UI_ONLY_COMPLETION");
        return true;
      },
    );
    assert.throws(
      () =>
        assertSourceObjectDeliveryComplete({
          gates: { fetch: true, raw_retention: true },
          uiOnlyComplete: false,
        }),
      (err) => {
        assert.equal(err.code, "DELIVERY_GATES_INCOMPLETE");
        return true;
      },
    );
  });

  it("buildOneNetworkAtATimeGuide includes scoped object refs", () => {
    const globalGuide = buildOneNetworkAtATimeGuide();
    assert.equal(globalGuide.contractPointer, 36);
    assert.equal(globalGuide.deliverySequence.length, 9);
    assert.equal(globalGuide.completionGates.length, 11);

    const objectGuide = buildOneNetworkAtATimeGuide({ network: "optimise", sourceObject: "campaigns" });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.equal(objectGuide.objectRefs.sequenceRank, 1);
    assert.match(objectGuide.objectRefs.fixtureDir, /optimise\/campaigns/);
  });

  it("applyOneNetworkAtATimeContract stamps response meta", () => {
    const wrapped = applyOneNetworkAtATimeContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.oneNetworkAtATimePointer, 36);
    assert.equal(wrapped.meta.oneNetworkAtATimeNetwork, "optimise");
  });
});

describe("Pointer 36 — AI integration guide includes one-network-at-a-time delivery", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes oneNetworkAtATimeDelivery", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.oneNetworkAtATimePointer, 36);
    assert.equal(payload.oneNetworkAtATimeDelivery.contractPointer, 36);
    assert.equal(payload.oneNetworkAtATimeDelivery.deliverySequence.length, 9);
    assert.match(payload.oneNetworkAtATimeDelivery.summary.completionRule, /UI inspection all pass/i);
  });

  it("object guide includes scoped delivery refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.oneNetworkAtATimeDelivery.contractPointer, 36);
    assert.match(payload.oneNetworkAtATimeDelivery.objectRefs.mappingFile, /campaigns\.mapping\.json/);
  });
});

describe("Pointer 36 — GET /ops/network/ai-integration-guide", () => {
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
