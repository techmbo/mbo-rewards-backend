/**
 * Pointer 42 — Expected supplier commission vs network actual commission.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  COMMISSION_MATCH_STATUS,
  CONTRACT_POINTER,
  EXPECTED_VS_ACTUAL_SUMMARY,
  POINTER_42_EXAMPLE,
  RECOMMENDED_ORDER_COMMISSION_FIELDS,
  applyExpectedVsActualSupplierCommissionContract,
  assertNetworkActualNotOverwritten,
  assertSeparateCommissionFacts,
  buildExpectedVsActualSupplierCommissionGuide,
  buildOrderCommissionFacts,
  computeExpectedSupplierCommission,
  resolveCommissionMatchStatus,
} from "../src/modules/networkOps/expectedVsActualSupplierCommission.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 42 — expectedVsActualSupplierCommission.contract", () => {
  it("declares contract pointer 42 and recommended order fields", () => {
    assert.equal(CONTRACT_POINTER, 42);
    assert.equal(RECOMMENDED_ORDER_COMMISSION_FIELDS.length, 8);
    assert.ok(RECOMMENDED_ORDER_COMMISSION_FIELDS.includes("commission_variance"));
    assert.match(EXPECTED_VS_ACTUAL_SUMMARY.noOverwrite, /Do not overwrite network actual commission/i);
    assert.match(EXPECTED_VS_ACTUAL_SUMMARY.varianceRouting, /reconciliation\/exception logic/i);
  });

  it("computeExpectedSupplierCommission calculates rate-based expected commission", () => {
    assert.equal(
      computeExpectedSupplierCommission({ ratePercent: 15, orderValue: 1000 }),
      150,
    );
  });

  it("buildOrderCommissionFacts stores expected and actual separately with variance", () => {
    const facts = buildOrderCommissionFacts({
      matchedSupplierCommissionRuleId: "scr-uae-shoes",
      matchedCommissionSequence: 3,
      ratePercent: 15,
      orderValue: 1000,
      currency: "AED",
      networkActualCommission: 140,
      networkActualCommissionCurrency: "AED",
    });
    assert.equal(facts.expected_supplier_commission, 150);
    assert.equal(facts.network_actual_commission, 140);
    assert.equal(facts.commission_variance, -10);
    assert.equal(facts.commission_match_status, COMMISSION_MATCH_STATUS.VARIANCE);
    assert.equal(facts.overwriteNetworkActualWithExpected, false);
  });

  it("resolveCommissionMatchStatus handles matched, variance and partial facts", () => {
    assert.equal(
      resolveCommissionMatchStatus({ expected: 150, actual: 150 }),
      COMMISSION_MATCH_STATUS.MATCHED,
    );
    assert.equal(
      resolveCommissionMatchStatus({ expected: 150, actual: 140 }),
      COMMISSION_MATCH_STATUS.VARIANCE,
    );
    assert.equal(resolveCommissionMatchStatus({ expected: 150, actual: null }), COMMISSION_MATCH_STATUS.EXPECTED_ONLY);
    assert.equal(resolveCommissionMatchStatus({ expected: null, actual: 140 }), COMMISSION_MATCH_STATUS.ACTUAL_ONLY);
  });

  it("assertNetworkActualNotOverwritten rejects expected replacing network actual", () => {
    assert.doesNotThrow(() =>
      assertNetworkActualNotOverwritten({
        expected: 150,
        networkActual: 140,
        storedNetworkActual: 140,
      }),
    );
    assert.throws(
      () =>
        assertNetworkActualNotOverwritten({
          expected: 150,
          networkActual: 140,
          storedNetworkActual: 150,
        }),
      (err) => {
        assert.equal(err.code, "NETWORK_ACTUAL_OVERWRITTEN_BY_EXPECTED");
        return true;
      },
    );
  });

  it("assertSeparateCommissionFacts rejects overwrite flag and inconsistent status", () => {
    assert.doesNotThrow(() =>
      assertSeparateCommissionFacts({
        record: buildOrderCommissionFacts({
          ratePercent: 15,
          orderValue: 1000,
          currency: "AED",
          networkActualCommission: 140,
        }),
      }),
    );
    assert.throws(
      () => assertSeparateCommissionFacts({ record: { overwriteNetworkActualWithExpected: true } }),
      (err) => {
        assert.equal(err.code, "COMMISSION_FACTS_NOT_SEPARATE");
        return true;
      },
    );
  });

  it("buildExpectedVsActualSupplierCommissionGuide includes pointer exemplar", () => {
    const globalGuide = buildExpectedVsActualSupplierCommissionGuide();
    assert.equal(globalGuide.contractPointer, 42);
    assert.equal(globalGuide.example.orderFacts.expected_supplier_commission, 150);
    assert.equal(globalGuide.example.orderFacts.network_actual_commission, 140);

    const objectGuide = buildExpectedVsActualSupplierCommissionGuide({
      network: "optimise",
      sourceObject: "conversions_orders",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
  });

  it("applyExpectedVsActualSupplierCommissionContract stamps response meta", () => {
    const wrapped = applyExpectedVsActualSupplierCommissionContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "conversions_orders" },
    );
    assert.equal(wrapped.meta.expectedVsActualSupplierCommissionPointer, 42);
    assert.equal(wrapped.meta.expectedVsActualSupplierCommissionNetwork, "optimise");
  });
});

describe("Pointer 42 — AI integration guide includes expected vs actual supplier commission", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes expectedVsActualSupplierCommission", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.expectedVsActualSupplierCommissionPointer, 42);
    assert.equal(payload.expectedVsActualSupplierCommission.contractPointer, 42);
    assert.equal(payload.expectedVsActualSupplierCommission.example.orderFacts.commission_variance, -10);
  });

  it("object guide includes scoped expected-vs-actual refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.expectedVsActualSupplierCommission.contractPointer, 42);
    assert.match(payload.expectedVsActualSupplierCommission.crossRefs.pointer41OrderDetection, /Matched rule selection/i);
  });
});

describe("Pointer 42 — GET /ops/network/ai-integration-guide", () => {
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
