/**
 * Pointer 45 — Commission-history rule.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  COMMISSION_HISTORY_SUMMARY,
  COMMISSION_IMPLEMENTATION_PRINCIPLE,
  CONTRACT_POINTER,
  POINTER_45_EXAMPLE,
  RULE_VERSION_STATUS,
  applyCommissionHistoryRuleContract,
  applyCommissionRateChange,
  assertNoSilentCommissionOverwrite,
  buildCommissionHistoryExample,
  buildCommissionHistoryRuleGuide,
  isRuleEffectiveForOrderDate,
  selectCommissionRuleForOrderDate,
} from "../src/modules/networkOps/commissionHistoryRule.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 45 — commissionHistoryRule.contract", () => {
  it("declares contract pointer 45 and commission implementation principle", () => {
    assert.equal(CONTRACT_POINTER, 45);
    assert.match(COMMISSION_HISTORY_SUMMARY.retainHistory, /retain history/i);
    assert.equal(COMMISSION_IMPLEMENTATION_PRINCIPLE.length, 6);
    assert.match(COMMISSION_IMPLEMENTATION_PRINCIPLE.at(-1).rule, /separate finance decision/i);
  });

  it("assertNoSilentCommissionOverwrite blocks in-place overwrite without history", () => {
    assert.doesNotThrow(() =>
      assertNoSilentCommissionOverwrite({
        previousRule: { id: "scr-v1" },
        historyRetained: true,
        inPlaceOverwrite: true,
      }),
    );
    assert.throws(
      () =>
        assertNoSilentCommissionOverwrite({
          previousRule: { id: "scr-v1" },
          incomingRule: { id: "scr-v1", ratePercent: 15 },
          historyRetained: false,
          inPlaceOverwrite: true,
        }),
      (err) => {
        assert.equal(err.code, "SILENT_COMMISSION_OVERWRITE");
        return true;
      },
    );
  });

  it("isRuleEffectiveForOrderDate respects effective windows", () => {
    const rule = {
      effectiveFrom: "2026-07-01T00:00:00.000Z",
      effectiveUntil: "2026-12-31T23:59:59.999Z",
      status: RULE_VERSION_STATUS.ACTIVE,
    };
    assert.equal(isRuleEffectiveForOrderDate(rule, "2026-08-01T00:00:00.000Z"), true);
    assert.equal(isRuleEffectiveForOrderDate(rule, "2026-05-01T00:00:00.000Z"), false);
  });

  it("applyCommissionRateChange preserves predecessor and creates successor", () => {
    const result = applyCommissionRateChange({
      existingRules: [
        {
          id: "scr-rate-v1",
          sourceRuleId: "network-rate-1",
          ratePercent: 10,
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          displayLabel: "Commission 1",
          status: RULE_VERSION_STATUS.ACTIVE,
        },
      ],
      incomingRule: {
        sourceRuleId: "network-rate-1",
        ratePercent: 15,
        displayLabel: "Commission 1",
      },
      changeEffectiveFrom: POINTER_45_EXAMPLE.rateChangeEffectiveFrom,
    });

    assert.equal(result.rules.length, 2);
    const predecessor = result.rules.find((rule) => rule.id === "scr-rate-v1");
    const successor = result.rules.find((rule) => rule.id !== "scr-rate-v1");
    assert.equal(predecessor.status, RULE_VERSION_STATUS.SUPERSEDED);
    assert.equal(predecessor.effectiveUntil, POINTER_45_EXAMPLE.rateChangeEffectiveFrom);
    assert.equal(successor.ratePercent, 15);
    assert.equal(successor.status, RULE_VERSION_STATUS.ACTIVE);
  });

  it("selectCommissionRuleForOrderDate matches historical vs current rates", () => {
    const example = buildCommissionHistoryExample();
    assert.equal(example.historicalOrder.matchedRuleId, "scr-rate-v1");
    assert.equal(example.historicalOrder.selectedRule.ratePercent, POINTER_45_EXAMPLE.previousRatePercent);
    assert.equal(example.currentOrder.selectedRule.ratePercent, POINTER_45_EXAMPLE.currentRatePercent);
  });

  it("buildCommissionHistoryRuleGuide includes scoped object refs and example", () => {
    const globalGuide = buildCommissionHistoryRuleGuide();
    assert.equal(globalGuide.contractPointer, 45);
    assert.equal(globalGuide.example.historicalOrder.selectedRule.ratePercent, 10);

    const objectGuide = buildCommissionHistoryRuleGuide({
      network: "optimise",
      sourceObject: "campaigns",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.match(objectGuide.crossRefs.pointer41OrderDetection, /effective windows/i);
  });

  it("applyCommissionHistoryRuleContract stamps response meta", () => {
    const wrapped = applyCommissionHistoryRuleContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.commissionHistoryRulePointer, 45);
    assert.equal(wrapped.meta.commissionHistoryRuleNetwork, "optimise");
  });
});

describe("Pointer 45 — AI integration guide includes commission history rule", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes commissionHistoryRule", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.commissionHistoryRulePointer, 45);
    assert.equal(payload.commissionHistoryRule.contractPointer, 45);
    assert.equal(payload.commissionHistoryRule.implementationPrinciple.length, 6);
  });

  it("object guide includes scoped commission history refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.commissionHistoryRule.contractPointer, 45);
    assert.match(payload.commissionHistoryRule.crossRefs.pointer38Flattening, /Commission 1/i);
  });
});

describe("Pointer 45 — GET /ops/network/ai-integration-guide", () => {
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
