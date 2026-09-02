import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateClientCommercialPayout,
  evaluateNegativeMarginProtection,
  selectClientCommercialTier,
  validateClientCommercialLineage,
} from "../src/modules/commercial/clientCommercialCalculation.js";

const lineage = {
  agreementRef: "IO-2026-001",
  agreementApprovedAt: "2026-09-01T10:00:00Z",
  agreementApprovedBy: "commercial-admin",
};

describe("Client Commercial Calculation", () => {
  it("requires agreement/approval lineage before calculation", () => {
    const result = calculateClientCommercialPayout({
      rule: {
        commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
        grossCommission: 100,
        clientCommission: 70,
      },
      context: { networkActualCommission: 1000 },
    });

    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "commercial_agreement_lineage_incomplete");
  });

  it("calculates percentage of network actual supplier commission", () => {
    const result = calculateClientCommercialPayout({
      rule: {
        ...lineage,
        commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
        grossCommission: 100,
        clientCommission: 70,
        currency: "INR",
      },
      context: { networkActualCommission: 1150, networkActualCurrency: "INR" },
    });

    assert.equal(result.status, "CALCULATED");
    assert.equal(result.clientPayable, 805);
    assert.equal(result.mboMargin, 345);
    assert.equal(result.payable, false);
  });

  it("never makes provisional expected-supplier calculation payable", () => {
    const result = calculateClientCommercialPayout({
      rule: {
        ...lineage,
        commissionType: "PERCENT",
        grossCommission: 100,
        clientCommission: 50,
        currency: "USD",
      },
      context: {
        expectedSupplierCommission: 200,
        provisionalAllowed: true,
        networkActualCommission: null,
        networkActualCurrency: "USD",
      },
    });

    assert.equal(result.status, "PROVISIONAL");
    assert.equal(result.clientPayable, 100);
    assert.equal(result.payable, false);
  });

  it("blocks negative margin by default", () => {
    const result = calculateClientCommercialPayout({
      rule: {
        ...lineage,
        commissionType: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
        fixedAmount: 120,
        grossCommission: 120,
        clientCommission: 120,
        currency: "USD",
      },
      context: { networkActualCommission: 100, networkActualCurrency: "USD" },
    });

    assert.equal(result.status, "BLOCKED_NEGATIVE_MARGIN");
    assert.equal(result.clientPayable, 120);
    assert.equal(result.mboMargin, -20);
    assert.equal(result.payable, false);
  });

  it("allows negative margin only with complete explicit subsidy approval", () => {
    const result = evaluateNegativeMarginProtection({
      clientPayable: 120,
      networkActualCommission: 100,
      supplierCurrency: "USD",
      clientCurrency: "USD",
      subsidyApproval: {
        allowed: true,
        approvedAt: "2026-09-02T12:00:00Z",
        approvedBy: "finance-admin",
        approvalRef: "SUBSIDY-001",
      },
    });

    assert.equal(result.status, "ALLOWED_WITH_APPROVED_SUBSIDY");
    assert.equal(result.margin, -20);
    assert.equal(result.approvalRef, "SUBSIDY-001");
  });

  it("does not guess FX for currency mismatch", () => {
    const result = evaluateNegativeMarginProtection({
      clientPayable: 80,
      networkActualCommission: 100,
      supplierCurrency: "USD",
      clientCurrency: "INR",
    });

    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "currency_mismatch_no_fx_guessing");
  });

  it("selects tier with min-inclusive and max-exclusive boundaries", () => {
    const rule = {
      tierMetric: "ORDER_VALUE",
      tierPeriod: "TRANSACTION",
      tiers: [
        { id: "low", minInclusive: 0, maxExclusive: 1000, payoutType: "FIXED", fixedAmount: 10 },
        { id: "high", minInclusive: 1000, maxExclusive: 5000, payoutType: "FIXED", fixedAmount: 20 },
      ],
    };

    const result = selectClientCommercialTier({ rule, context: { orderValue: 1000 } });
    assert.equal(result.status, "MATCHED");
    assert.equal(result.selectedTierId, "high");
  });

  it("fails closed on overlapping tier bands", () => {
    const result = selectClientCommercialTier({
      rule: {
        tierMetric: "ORDER_COUNT",
        tierPeriod: "MONTHLY",
        tiers: [
          { id: "a", minInclusive: 0, maxExclusive: 100 },
          { id: "b", minInclusive: 50, maxExclusive: 200 },
        ],
      },
      context: { orderCount: 75 },
    });

    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.equal(result.reason, "overlapping_tier_bands");
  });

  it("calculates a matched tier payout from supplier commission", () => {
    const result = calculateClientCommercialPayout({
      rule: {
        ...lineage,
        commissionType: "TIERED",
        tierMetric: "ORDER_COUNT",
        tierPeriod: "MONTHLY",
        currency: "USD",
        tiers: [
          {
            id: "tier-1",
            minInclusive: 0,
            maxExclusive: 100,
            payoutType: "PERCENT_OF_SUPPLIER_COMMISSION",
            sharePercent: 60,
          },
          {
            id: "tier-2",
            minInclusive: 100,
            maxExclusive: null,
            payoutType: "PERCENT_OF_SUPPLIER_COMMISSION",
            sharePercent: 70,
          },
        ],
      },
      context: {
        orderCount: 120,
        networkActualCommission: 1000,
        networkActualCurrency: "USD",
      },
    });

    assert.equal(result.status, "CALCULATED");
    assert.equal(result.clientPayable, 700);
    assert.equal(result.mboMargin, 300);
    assert.equal(result.tierSelection.selectedTierId, "tier-2");
  });

  it("validates agreement lineage completeness", () => {
    const result = validateClientCommercialLineage({
      agreementRef: "SOW-10",
      agreementApprovedAt: "2026-09-01T10:00:00Z",
      agreementApprovedBy: "admin",
    });
    assert.equal(result.status, "COMPLETE");
    assert.deepEqual(result.missing, []);
  });
});
