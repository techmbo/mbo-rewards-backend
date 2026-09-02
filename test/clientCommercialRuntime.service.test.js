import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientCommercialRuntimeService } from "../src/modules/commercial/services/clientCommercialRuntime.service.js";

function completeLineage(overrides = {}) {
  return {
    agreementRef: "IO-2026-001",
    agreementApprovedAt: "2026-08-01T00:00:00.000Z",
    agreementApprovedBy: "commercial-admin",
    ...overrides,
  };
}

function repoWith(rules) {
  return {
    async findEffectiveRulesForAssignment(assignmentId) {
      return rules.filter((rule) => rule.assignmentId === assignmentId);
    },
  };
}

describe("ClientCommercialRuntimeService", () => {
  it("loads all effective rules, matches the specific rule and calculates from supplier actual", async () => {
    const service = new ClientCommercialRuntimeService({
      commissionRepo: repoWith([
        {
          id: "default",
          assignmentId: "a1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          grossCommission: 100,
          clientCommission: 50,
          commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
          currency: "INR",
          conditions: [{ conditionType: "DEFAULT" }],
          ...completeLineage(),
        },
        {
          id: "ae",
          assignmentId: "a1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          grossCommission: 100,
          clientCommission: 70,
          commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
          currency: "INR",
          conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }],
          ...completeLineage(),
        },
      ]),
    });

    const result = await service.evaluate({
      assignmentId: "a1",
      attributionResolved: true,
      attributionStatus: "ATTRIBUTED",
      order: {
        orderDate: "2026-09-02T12:00:00Z",
        metadata: { country: "AE" },
      },
      networkActualCommission: 1150,
      networkActualCurrency: "INR",
    });

    assert.equal(result.status, "CALCULATED");
    assert.equal(result.matchedClientCommissionRuleId, "ae");
    assert.equal(result.clientPayable, 805);
    assert.equal(result.mboMargin, 345);
    assert.equal(result.payable, false);
  });

  it("fails closed before commercial matching when attribution is unresolved", async () => {
    const service = new ClientCommercialRuntimeService({
      commissionRepo: repoWith([
        {
          id: "default",
          assignmentId: "a1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          conditions: [{ conditionType: "DEFAULT" }],
        },
      ]),
    });

    const result = await service.evaluate({
      assignmentId: "a1",
      attributionResolved: false,
      networkActualCommission: 100,
    });

    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "attribution_unresolved");
    assert.equal(result.clientPayable, null);
  });

  it("blocks persisted fixed payout that creates negative margin without approved subsidy", async () => {
    const service = new ClientCommercialRuntimeService({
      commissionRepo: repoWith([
        {
          id: "fixed",
          assignmentId: "a1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          grossCommission: 200,
          clientCommission: 200,
          commissionType: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
          fixedAmount: 200,
          currency: "INR",
          conditions: [{ conditionType: "DEFAULT" }],
          ...completeLineage(),
        },
      ]),
    });

    const result = await service.evaluate({
      assignmentId: "a1",
      attributionResolved: true,
      attributionStatus: "ATTRIBUTED",
      networkActualCommission: 150,
      networkActualCurrency: "INR",
    });

    assert.equal(result.status, "BLOCKED_NEGATIVE_MARGIN");
    assert.equal(result.clientPayable, 200);
    assert.equal(result.mboMargin, -50);
    assert.equal(result.payable, false);
  });

  it("allows negative margin only with complete persisted subsidy approval lineage", async () => {
    const service = new ClientCommercialRuntimeService({
      commissionRepo: repoWith([
        {
          id: "fixed",
          assignmentId: "a1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          grossCommission: 200,
          clientCommission: 200,
          commissionType: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
          fixedAmount: 200,
          currency: "INR",
          conditions: [{ conditionType: "DEFAULT" }],
          subsidyApproved: true,
          subsidyApprovalRef: "SUB-7",
          subsidyApprovedAt: "2026-08-15T00:00:00Z",
          subsidyApprovedBy: "finance-admin",
          ...completeLineage(),
        },
      ]),
    });

    const result = await service.evaluate({
      assignmentId: "a1",
      attributionResolved: true,
      attributionStatus: "ATTRIBUTED",
      networkActualCommission: 150,
      networkActualCurrency: "INR",
    });

    assert.equal(result.status, "CALCULATED");
    assert.equal(result.clientPayable, 200);
    assert.equal(result.mboMargin, -50);
    assert.equal(result.marginProtection.status, "ALLOWED_WITH_APPROVED_SUBSIDY");
    assert.equal(result.payable, false);
  });

  it("uses persisted tier rows for tiered rules", async () => {
    const service = new ClientCommercialRuntimeService({
      commissionRepo: repoWith([
        {
          id: "tiered",
          assignmentId: "a1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          grossCommission: 100,
          clientCommission: 50,
          commissionType: "TIERED",
          currency: "INR",
          tierMetric: "ORDER_COUNT",
          tierPeriod: "MONTHLY",
          conditions: [{ conditionType: "DEFAULT" }],
          tiers: [
            { id: "t1", minInclusive: 0, maxExclusive: 100, payoutType: "PERCENT_OF_SUPPLIER_COMMISSION", sharePercent: 50 },
            { id: "t2", minInclusive: 100, maxExclusive: null, payoutType: "PERCENT_OF_SUPPLIER_COMMISSION", sharePercent: 70 },
          ],
          ...completeLineage(),
        },
      ]),
    });

    const result = await service.evaluate({
      assignmentId: "a1",
      attributionResolved: true,
      attributionStatus: "ATTRIBUTED",
      orderCount: 150,
      networkActualCommission: 1000,
      networkActualCurrency: "INR",
    });

    assert.equal(result.status, "CALCULATED");
    assert.equal(result.clientPayable, 700);
    assert.equal(result.tierSelection.selectedTierId, "t2");
  });

  it("requires commercial agreement lineage for persisted runtime rules", async () => {
    const service = new ClientCommercialRuntimeService({
      commissionRepo: repoWith([
        {
          id: "missing-lineage",
          assignmentId: "a1",
          status: "EFFECTIVE",
          effectiveFrom: "2026-01-01T00:00:00Z",
          grossCommission: 100,
          clientCommission: 70,
          commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
          currency: "INR",
          conditions: [{ conditionType: "DEFAULT" }],
        },
      ]),
    });

    const result = await service.evaluate({
      assignmentId: "a1",
      attributionResolved: true,
      attributionStatus: "ATTRIBUTED",
      networkActualCommission: 100,
      networkActualCurrency: "INR",
    });

    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "commercial_agreement_lineage_incomplete");
    assert.equal(result.clientPayable, null);
  });
});
