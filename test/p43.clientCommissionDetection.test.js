/**
 * Pointer 43 — Client commission detection and calculation.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CLIENT_COMMISSION_CALCULATION_SEQUENCE,
  CLIENT_COMMISSION_DETECTION_SUMMARY,
  CONTRACT_POINTER,
  POINTER_43_EXAMPLE,
  applyClientCommissionDetectionContract,
  assertAdapterDoesNotCalculateClientCommission,
  assertAttributionBeforeClientRule,
  assertNoCampaignSummaryForClientEarnings,
  buildClientCommissionDetectionGuide,
  calculateClientCommission,
  calculateMboMargin,
  detectAndCalculateClientCommission,
  selectClientCommercialRule,
} from "../src/modules/networkOps/clientCommissionDetection.contract.js";
import { FIELD_MAPPING_OUTCOME } from "../src/modules/mapping/mappingOutcome.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 43 — clientCommissionDetection.contract", () => {
  it("declares contract pointer 43 and eight-step calculation sequence", () => {
    assert.equal(CONTRACT_POINTER, 43);
    assert.equal(CLIENT_COMMISSION_CALCULATION_SEQUENCE.length, 8);
    assert.equal(CLIENT_COMMISSION_CALCULATION_SEQUENCE[1].key, "client_attribution");
    assert.equal(CLIENT_COMMISSION_CALCULATION_SEQUENCE.at(-1).key, "mbo_commission_margin");
    assert.match(CLIENT_COMMISSION_DETECTION_SUMMARY.adapterBoundary, /adapter must never calculate Client Commission/i);
    assert.match(CLIENT_COMMISSION_DETECTION_SUMMARY.noCampaignSummary, /Never use Avg Commission, Min Commission, Max Commission/i);
  });

  it("assertAttributionBeforeClientRule blocks client rule before attribution", () => {
    assert.doesNotThrow(() =>
      assertAttributionBeforeClientRule({
        attributionResolved: true,
        attributionStatus: "ATTRIBUTED",
        clientRuleSelected: true,
      }),
    );
    assert.throws(
      () =>
        assertAttributionBeforeClientRule({
          attributionResolved: false,
          attributionStatus: "REVIEW_REQUIRED",
          clientRuleSelected: true,
        }),
      (err) => {
        assert.equal(err.code, "CLIENT_RULE_BEFORE_ATTRIBUTION");
        return true;
      },
    );
  });

  it("assertNoCampaignSummaryForClientEarnings rejects summary bases", () => {
    assert.doesNotThrow(() => assertNoCampaignSummaryForClientEarnings({ calculationBasis: "network_actual_commission" }));
    assert.throws(
      () => assertNoCampaignSummaryForClientEarnings({ calculationBasis: "avg_commission" }),
      (err) => {
        assert.equal(err.code, "CAMPAIGN_SUMMARY_USED_FOR_CLIENT_EARNINGS");
        return true;
      },
    );
  });

  it("assertAdapterDoesNotCalculateClientCommission rejects adapter-side calculation", () => {
    assert.throws(
      () =>
        assertAdapterDoesNotCalculateClientCommission({
          inAdapter: true,
          clientCommissionCalculated: true,
        }),
      (err) => {
        assert.equal(err.code, "CLIENT_COMMISSION_IN_ADAPTER");
        return true;
      },
    );
  });

  it("calculateClientCommission and calculateMboMargin match pointer example", () => {
    const client = calculateClientCommission({
      baseCommission: POINTER_43_EXAMPLE.networkActualCommission,
      clientSharePercent: POINTER_43_EXAMPLE.clientSharePercent,
    });
    assert.equal(client.clientCommission, 805);
    assert.equal(
      calculateMboMargin({
        networkActualCommission: POINTER_43_EXAMPLE.networkActualCommission,
        clientCommission: client.clientCommission,
      }),
      345,
    );
  });

  it("selectClientCommercialRule marks REVIEW_REQUIRED on equally specific ties", () => {
    const result = selectClientCommercialRule({
      rules: [
        { id: "client-a", clientSharePercent: 70 },
        { id: "client-b", clientSharePercent: 80 },
      ],
      conditionsByRuleId: {
        "client-a": [{ condition_type: "COUNTRY", normalized_value: "IN" }],
        "client-b": [{ condition_type: "COUNTRY", normalized_value: "IN" }],
      },
      orderFacts: { country: "IN", _evidence: { country: true } },
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.fieldMappingOutcome, FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED);
  });

  it("detectAndCalculateClientCommission produces pointer exemplar split", () => {
    const result = detectAndCalculateClientCommission({
      clientRules: [{ id: "client-rule-70", clientSharePercent: 70 }],
      conditionsByRuleId: {
        "client-rule-70": [{ condition_type: "DEFAULT", normalized_value: null }],
      },
    });
    assert.equal(result.clientCommission, 805);
    assert.equal(result.mboCommissionMargin, 345);
    assert.equal(result.calculationBasis, "network_actual_commission");
    assert.equal(result.provisional, false);
  });

  it("buildClientCommissionDetectionGuide includes scoped object refs and example", () => {
    const globalGuide = buildClientCommissionDetectionGuide();
    assert.equal(globalGuide.contractPointer, 43);
    assert.equal(globalGuide.example.result.clientCommission, 805);

    const objectGuide = buildClientCommissionDetectionGuide({
      network: "optimise",
      sourceObject: "conversions_orders",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.match(objectGuide.runtimeRefs.commercialRuleEngine, /commercialRuleEngine/);
  });

  it("applyClientCommissionDetectionContract stamps response meta", () => {
    const wrapped = applyClientCommissionDetectionContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "conversions_orders" },
    );
    assert.equal(wrapped.meta.clientCommissionDetectionPointer, 43);
    assert.equal(wrapped.meta.clientCommissionDetectionNetwork, "optimise");
  });
});

describe("Pointer 43 — AI integration guide includes client commission detection", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes clientCommissionDetection", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.clientCommissionDetectionPointer, 43);
    assert.equal(payload.clientCommissionDetection.contractPointer, 43);
    assert.equal(payload.clientCommissionDetection.calculationSequence.length, 8);
  });

  it("object guide includes scoped client commission refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.clientCommissionDetection.contractPointer, 43);
    assert.match(payload.clientCommissionDetection.crossRefs.pointer32CommercialSequencing, /supplier detection/i);
  });
});

describe("Pointer 43 — GET /ops/network/ai-integration-guide", () => {
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
