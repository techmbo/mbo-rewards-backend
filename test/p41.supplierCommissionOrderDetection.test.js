/**
 * Pointer 41 — Supplier commission detection for an order.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  ORDER_COMMISSION_DETECTION_SUMMARY,
  POINTER_41_EXAMPLE,
  SUPPLIER_COMMISSION_DETECTION_SEQUENCE,
  applySupplierCommissionOrderDetectionContract,
  assertCanonicalFactSupported,
  buildSupplierCommissionOrderDetectionGuide,
  detectSupplierCommissionForOrder,
  ruleMatchesOrder,
  selectSupplierCommissionRule,
} from "../src/modules/networkOps/supplierCommissionOrderDetection.contract.js";
import { FIELD_MAPPING_OUTCOME } from "../src/modules/mapping/mappingOutcome.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 41 — supplierCommissionOrderDetection.contract", () => {
  it("declares contract pointer 41 and eleven-step detection sequence", () => {
    assert.equal(CONTRACT_POINTER, 41);
    assert.equal(SUPPLIER_COMMISSION_DETECTION_SEQUENCE.length, 11);
    assert.equal(SUPPLIER_COMMISSION_DETECTION_SEQUENCE[0].key, "order_conversion");
    assert.equal(SUPPLIER_COMMISSION_DETECTION_SEQUENCE.at(-1).key, "continue_client_commercial_rule");
    assert.match(ORDER_COMMISSION_DETECTION_SUMMARY.factEvidenceRule, /Never fabricate a matching dimension/i);
  });

  it("assertCanonicalFactSupported rejects fabricated facts", () => {
    assert.doesNotThrow(() => assertCanonicalFactSupported({ fact: "country", supported: true }));
    assert.throws(
      () => assertCanonicalFactSupported({ fact: "category", supported: false, fabricated: true }),
      (err) => {
        assert.equal(err.code, "FABRICATED_ORDER_FACT");
        return true;
      },
    );
  });

  it("ruleMatchesOrder requires complete condition set match", () => {
    assert.equal(
      ruleMatchesOrder({
        conditions: POINTER_41_EXAMPLE.conditionsByRuleId["scr-uae-shoes"],
        orderFacts: { country: "UAE", category: "Shoes", _evidence: { country: true, category: true } },
      }),
      true,
    );
    assert.equal(
      ruleMatchesOrder({
        conditions: POINTER_41_EXAMPLE.conditionsByRuleId["scr-uae-shoes"],
        orderFacts: { country: "UAE", category: "Electronics", _evidence: { country: true, category: true } },
      }),
      false,
    );
  });

  it("selectSupplierCommissionRule applies specificity precedence from pointer example", () => {
    const uaeShoes = selectSupplierCommissionRule({
      rules: POINTER_41_EXAMPLE.rules,
      conditionsByRuleId: POINTER_41_EXAMPLE.conditionsByRuleId,
      orderFacts: { country: "UAE", category: "Shoes", _evidence: { country: true, category: true } },
    });
    assert.equal(uaeShoes.status, "MATCHED");
    assert.equal(uaeShoes.matched_commission_rule_id, "scr-uae-shoes");
    assert.equal(uaeShoes.displayLabel, "Commission 3");

    const uaeElectronics = selectSupplierCommissionRule({
      rules: POINTER_41_EXAMPLE.rules,
      conditionsByRuleId: POINTER_41_EXAMPLE.conditionsByRuleId,
      orderFacts: { country: "UAE", category: "Electronics", _evidence: { country: true, category: true } },
    });
    assert.equal(uaeElectronics.matched_commission_rule_id, "scr-uae");
    assert.equal(uaeElectronics.displayLabel, "Commission 2");

    const india = selectSupplierCommissionRule({
      rules: POINTER_41_EXAMPLE.rules,
      conditionsByRuleId: POINTER_41_EXAMPLE.conditionsByRuleId,
      orderFacts: { country: "IN", category: "Shoes", _evidence: { country: true, category: true } },
    });
    assert.equal(india.matched_commission_rule_id, "scr-default");
    assert.equal(india.displayLabel, "Commission 1");
  });

  it("selectSupplierCommissionRule marks REVIEW_REQUIRED on equally specific ties without source precedence", () => {
    const result = selectSupplierCommissionRule({
      rules: [
        { id: "scr-a", ratePercent: 10, displaySequence: 1, displayLabel: "Commission 1" },
        { id: "scr-b", ratePercent: 12, displaySequence: 2, displayLabel: "Commission 2" },
      ],
      conditionsByRuleId: {
        "scr-a": [{ condition_type: "COUNTRY", operator: "EQUALS", normalized_value: "UAE" }],
        "scr-b": [{ condition_type: "COUNTRY", operator: "EQUALS", normalized_value: "UAE" }],
      },
      orderFacts: { country: "UAE", _evidence: { country: true } },
    });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.fieldMappingOutcome, FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED);
  });

  it("detectSupplierCommissionForOrder records expected commission and variance", () => {
    const detected = detectSupplierCommissionForOrder({
      orderFacts: { country: "UAE", category: "Shoes", _evidence: { country: true, category: true } },
      networkReportedCommission: 14,
    });
    assert.equal(detected.matched_commission_rule_id, "scr-uae-shoes");
    assert.equal(detected.expectedSupplierCommission, 15);
    assert.equal(detected.commissionVariance, -1);
    assert.equal(detected.continueToClientCommercialRule, true);
  });

  it("buildSupplierCommissionOrderDetectionGuide includes scoped object refs and examples", () => {
    const globalGuide = buildSupplierCommissionOrderDetectionGuide();
    assert.equal(globalGuide.contractPointer, 41);
    assert.equal(globalGuide.example.uaeShoesOrder.matched_commission_rule_id, "scr-uae-shoes");

    const objectGuide = buildSupplierCommissionOrderDetectionGuide({
      network: "optimise",
      sourceObject: "conversions_orders",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.match(objectGuide.objectRefs.orderIngestion, /orderIngestion\.service\.js/);
  });

  it("applySupplierCommissionOrderDetectionContract stamps response meta", () => {
    const wrapped = applySupplierCommissionOrderDetectionContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "conversions_orders" },
    );
    assert.equal(wrapped.meta.supplierCommissionOrderDetectionPointer, 41);
    assert.equal(wrapped.meta.supplierCommissionOrderDetectionNetwork, "optimise");
  });
});

describe("Pointer 41 — AI integration guide includes supplier commission order detection", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes supplierCommissionOrderDetection", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.supplierCommissionOrderDetectionPointer, 41);
    assert.equal(payload.supplierCommissionOrderDetection.contractPointer, 41);
    assert.equal(payload.supplierCommissionOrderDetection.detectionSequence.length, 11);
  });

  it("object guide includes scoped order-detection refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.supplierCommissionOrderDetection.contractPointer, 41);
    assert.match(payload.supplierCommissionOrderDetection.crossRefs.pointer32CommercialSequencing, /client commercial rule/i);
  });
});

describe("Pointer 41 — GET /ops/network/ai-integration-guide", () => {
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
