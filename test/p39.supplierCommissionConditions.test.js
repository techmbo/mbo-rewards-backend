/**
 * Pointer 39 — Conditions belonging to one commission must stay together.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  COMMISSION_CONDITIONS_SUMMARY,
  CONTRACT_POINTER,
  POINTER_39_EXAMPLE,
  SUPPORTED_CONDITION_DIMENSIONS,
  applySupplierCommissionConditionsContract,
  assertConditionsStayWithRule,
  assertNoConditionSplitAcrossRules,
  buildSupplierCommissionCondition,
  buildSupplierCommissionConditionsGuide,
  groupConditionsByRuleId,
} from "../src/modules/networkOps/supplierCommissionConditions.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 39 — supplierCommissionConditions.contract", () => {
  it("declares contract pointer 39 and supported condition dimensions", () => {
    assert.equal(CONTRACT_POINTER, 39);
    assert.match(COMMISSION_CONDITIONS_SUMMARY.flattenOutcomesNotConditions, /Flatten payable outcomes, not the conditions/i);
    assert.match(COMMISSION_CONDITIONS_SUMMARY.oneConditionalOutcome, /one SupplierCommissionRule, not three separate 15% rules/i);
    assert.ok(SUPPORTED_CONDITION_DIMENSIONS.includes("CUSTOMER_TYPE"));
    assert.ok(SUPPORTED_CONDITION_DIMENSIONS.includes("COUPON_VOUCHER"));
    assert.ok(SUPPORTED_CONDITION_DIMENSIONS.includes("CUSTOM"));
    assert.equal(SUPPORTED_CONDITION_DIMENSIONS.length, 16);
  });

  it("buildSupplierCommissionCondition normalizes dimensions and fields", () => {
    const condition = buildSupplierCommissionCondition({
      conditionType: "COUPON/VOUCHER",
      normalizedValue: "SAVE10",
      commissionRuleId: "scr-1",
    });
    assert.equal(condition.condition_type, "COUPON_VOUCHER");
    assert.equal(condition.normalized_value, "SAVE10");
    assert.equal(condition.commission_rule_id, "scr-1");
    assert.equal(condition.operator, "EQUALS");
  });

  it("assertConditionsStayWithRule requires shared commission_rule_id", () => {
    assert.doesNotThrow(() =>
      assertConditionsStayWithRule({
        rule: POINTER_39_EXAMPLE.rule,
        conditions: POINTER_39_EXAMPLE.conditions,
      }),
    );
    assert.throws(
      () =>
        assertConditionsStayWithRule({
          rule: POINTER_39_EXAMPLE.rule,
          conditions: [
            buildSupplierCommissionCondition({
              conditionType: "CATEGORY",
              normalizedValue: "Shoes",
              commissionRuleId: "scr-other",
            }),
          ],
        }),
      (err) => {
        assert.equal(err.code, "CONDITIONS_SPLIT_ACROSS_RULES");
        return true;
      },
    );
  });

  it("assertNoConditionSplitAcrossRules rejects splitting joint AND-conditions", () => {
    assert.doesNotThrow(() =>
      assertNoConditionSplitAcrossRules({
        rules: [POINTER_39_EXAMPLE.rule],
        conditions: POINTER_39_EXAMPLE.conditions,
      }),
    );
    assert.throws(
      () =>
        assertNoConditionSplitAcrossRules({
          rules: [
            { id: "scr-a", ratePercent: 15 },
            { id: "scr-b", ratePercent: 15 },
            { id: "scr-c", ratePercent: 15 },
          ],
          conditions: [
            buildSupplierCommissionCondition({ conditionType: "CATEGORY", normalizedValue: "Shoes", commissionRuleId: "scr-a" }),
            buildSupplierCommissionCondition({ conditionType: "COUNTRY", normalizedValue: "UAE", commissionRuleId: "scr-b" }),
            buildSupplierCommissionCondition({ conditionType: "CUSTOMER_TYPE", normalizedValue: "New", commissionRuleId: "scr-c" }),
          ],
        }),
      (err) => {
        assert.equal(err.code, "JOINT_CONDITIONS_SPLIT_INTO_RULES");
        return true;
      },
    );
  });

  it("groupConditionsByRuleId groups joint conditions on one rule", () => {
    const grouped = groupConditionsByRuleId(POINTER_39_EXAMPLE.conditions);
    assert.equal(grouped.size, 1);
    assert.equal(grouped.get("scr-shoes-uae-new").length, 3);
  });

  it("buildSupplierCommissionConditionsGuide includes scoped object refs and example", () => {
    const globalGuide = buildSupplierCommissionConditionsGuide();
    assert.equal(globalGuide.contractPointer, 39);
    assert.equal(globalGuide.example.conditions.length, 3);

    const objectGuide = buildSupplierCommissionConditionsGuide({
      network: "optimise",
      sourceObject: "commission_rules",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.match(objectGuide.crossRefs.pointer38FlattenOutcomes, /Pointer 38 flattens distinct payable outcomes/i);
  });

  it("applySupplierCommissionConditionsContract stamps response meta", () => {
    const wrapped = applySupplierCommissionConditionsContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.supplierCommissionConditionsPointer, 39);
    assert.equal(wrapped.meta.supplierCommissionConditionsNetwork, "optimise");
  });
});

describe("Pointer 39 — AI integration guide includes supplier commission conditions", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes supplierCommissionConditions", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.supplierCommissionConditionsPointer, 39);
    assert.equal(payload.supplierCommissionConditions.contractPointer, 39);
    assert.equal(payload.supplierCommissionConditions.supportedDimensions.length, 16);
  });

  it("object guide includes scoped condition refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.supplierCommissionConditions.contractPointer, 39);
    assert.match(payload.supplierCommissionConditions.objectRefs.fanOut, /supplierCommissionRuleFanOut/);
  });
});

describe("Pointer 39 — GET /ops/network/ai-integration-guide", () => {
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
