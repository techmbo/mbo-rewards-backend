/**
 * Pointer 40 — Commission summary and Avg Commission.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  AVG_COMMISSION_TYPE,
  CAMPAIGN_COMMISSION_SUMMARY_RULES,
  CONTRACT_POINTER,
  RECOMMENDED_CAMPAIGN_SUMMARY_FIELDS,
  applyCampaignCommissionSummaryContract,
  assertAvgCommissionComparable,
  assertSummaryNotUsedForPayable,
  buildCampaignCommissionSummaryGuide,
  computeCampaignCommissionSummary,
} from "../src/modules/networkOps/campaignCommissionSummary.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");

describe("Pointer 40 — campaignCommissionSummary.contract", () => {
  it("declares contract pointer 40 and recommended summary fields", () => {
    assert.equal(CONTRACT_POINTER, 40);
    assert.equal(RECOMMENDED_CAMPAIGN_SUMMARY_FIELDS.length, 6);
    assert.ok(RECOMMENDED_CAMPAIGN_SUMMARY_FIELDS.includes("avg_commission_type"));
    assert.match(CAMPAIGN_COMMISSION_SUMMARY_RULES.authoritativeBoundary, /derived summaries only/i);
    assert.match(CAMPAIGN_COMMISSION_SUMMARY_RULES.displayOnly, /never participate in client payable calculation/i);
  });

  it("computeCampaignCommissionSummary averages active percentage rules", () => {
    const summary = computeCampaignCommissionSummary({
      now: NOW,
      rules: [
        { ratePercent: 10, effectiveFrom: "2026-01-01T00:00:00.000Z" },
        { ratePercent: 20, effectiveFrom: "2026-01-01T00:00:00.000Z" },
      ],
    });
    assert.equal(summary.commission_count, 2);
    assert.equal(summary.avg_commission_type, AVG_COMMISSION_TYPE.PERCENT);
    assert.equal(summary.avg_commission, 15);
    assert.equal(summary.min_commission, 10);
    assert.equal(summary.max_commission, 20);
    assert.equal(summary.payableRateAllowed, false);
  });

  it("computeCampaignCommissionSummary averages comparable fixed rules in one currency", () => {
    const summary = computeCampaignCommissionSummary({
      now: NOW,
      rules: [
        { fixedAmount: 10, currency: "USD", basis: "CPA", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        { fixedAmount: 20, currency: "USD", basis: "CPA", effectiveFrom: "2026-01-01T00:00:00.000Z" },
      ],
    });
    assert.equal(summary.avg_commission_type, AVG_COMMISSION_TYPE.FIXED);
    assert.equal(summary.avg_commission, 15);
  });

  it("computeCampaignCommissionSummary returns MIXED for percent/fixed mix", () => {
    const summary = computeCampaignCommissionSummary({
      now: NOW,
      rules: [
        { ratePercent: 12, effectiveFrom: "2026-01-01T00:00:00.000Z" },
        { fixedAmount: 10, currency: "USD", basis: "CPA", effectiveFrom: "2026-01-01T00:00:00.000Z" },
      ],
    });
    assert.equal(summary.avg_commission_type, AVG_COMMISSION_TYPE.MIXED);
    assert.equal(summary.avg_commission, null);
    assert.match(summary.campaign_commission_summary, /Mixed commissions/i);
  });

  it("computeCampaignCommissionSummary returns MIXED for different currencies or incompatible bases", () => {
    const crossCurrency = computeCampaignCommissionSummary({
      now: NOW,
      rules: [
        { fixedAmount: 10, currency: "USD", basis: "CPA", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        { fixedAmount: 10, currency: "EUR", basis: "CPA", effectiveFrom: "2026-01-01T00:00:00.000Z" },
      ],
    });
    assert.equal(crossCurrency.avg_commission_type, AVG_COMMISSION_TYPE.MIXED);

    const incompatibleBasis = computeCampaignCommissionSummary({
      now: NOW,
      rules: [
        { fixedAmount: 10, currency: "USD", basis: "CPA", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        { fixedAmount: 12, currency: "USD", basis: "CPI", effectiveFrom: "2026-01-01T00:00:00.000Z" },
      ],
    });
    assert.equal(incompatibleBasis.avg_commission_type, AVG_COMMISSION_TYPE.MIXED);
  });

  it("computeCampaignCommissionSummary excludes expired rules from current average", () => {
    const summary = computeCampaignCommissionSummary({
      now: NOW,
      rules: [
        { ratePercent: 10, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2026-08-01T00:00:00.000Z" },
        { ratePercent: 20, effectiveFrom: "2026-01-01T00:00:00.000Z" },
      ],
    });
    assert.equal(summary.commission_count, 1);
    assert.equal(summary.avg_commission, 20);
  });

  it("assertSummaryNotUsedForPayable blocks summary fields in payable calculation", () => {
    assert.doesNotThrow(() => assertSummaryNotUsedForPayable({ usedInPayableCalculation: false }));
    assert.throws(
      () => assertSummaryNotUsedForPayable({ usedInPayableCalculation: true, field: "avg_commission" }),
      (err) => {
        assert.equal(err.code, "SUMMARY_USED_FOR_PAYABLE");
        return true;
      },
    );
  });

  it("assertAvgCommissionComparable validates MIXED handling", () => {
    assert.doesNotThrow(() =>
      assertAvgCommissionComparable({
        rules: [
          { ratePercent: 10, effectiveFrom: "2026-01-01T00:00:00.000Z" },
          { ratePercent: 20, effectiveFrom: "2026-01-01T00:00:00.000Z" },
        ],
        now: NOW,
      }),
    );
    assert.throws(
      () =>
        assertAvgCommissionComparable({
          rules: [
            { ratePercent: 10, effectiveFrom: "2026-01-01T00:00:00.000Z" },
            { fixedAmount: 5, currency: "USD", basis: "CPA", effectiveFrom: "2026-01-01T00:00:00.000Z" },
          ],
          avgCommissionType: AVG_COMMISSION_TYPE.PERCENT,
          now: NOW,
        }),
      (err) => {
        assert.equal(err.code, "AVG_COMMISSION_NOT_MIXED");
        return true;
      },
    );
  });

  it("buildCampaignCommissionSummaryGuide includes scoped object refs", () => {
    const globalGuide = buildCampaignCommissionSummaryGuide();
    assert.equal(globalGuide.contractPointer, 40);
    assert.equal(globalGuide.recommendedFields.length, 6);

    const objectGuide = buildCampaignCommissionSummaryGuide({
      network: "optimise",
      sourceObject: "campaigns",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.match(objectGuide.objectRefs.campaignFields, /buildNetworkCampaignFields/);
  });

  it("applyCampaignCommissionSummaryContract stamps response meta", () => {
    const wrapped = applyCampaignCommissionSummaryContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.campaignCommissionSummaryPointer, 40);
    assert.equal(wrapped.meta.campaignCommissionSummaryNetwork, "optimise");
  });
});

describe("Pointer 40 — AI integration guide includes campaign commission summary", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes campaignCommissionSummary", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.campaignCommissionSummaryPointer, 40);
    assert.equal(payload.campaignCommissionSummary.contractPointer, 40);
    assert.match(payload.campaignCommissionSummary.summary.displayOnly, /client payable calculation/i);
  });

  it("object guide includes scoped summary refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.campaignCommissionSummary.contractPointer, 40);
    assert.match(payload.campaignCommissionSummary.objectRefs.campaignFields, /importedRecords\.service\.js/);
  });
});

describe("Pointer 40 — GET /ops/network/ai-integration-guide", () => {
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

describe("Pointer 40 — explicit zero participates in Avg / Min / Max", () => {
  it("[0%, 10%] gives avg 5%, min 0%, max 10%", () => {
    const summary = computeCampaignCommissionSummary({
      now: NOW,
      rules: [
        { ratePercent: 0, effectiveFrom: "2026-01-01T00:00:00.000Z" },
        { ratePercent: 10, effectiveFrom: "2026-01-01T00:00:00.000Z" },
      ],
    });
    assert.equal(summary.commission_count, 2);
    assert.equal(summary.avg_commission_type, AVG_COMMISSION_TYPE.PERCENT);
    assert.equal(summary.avg_commission, 5);
    assert.equal(summary.min_commission, 0);
    assert.equal(summary.max_commission, 10);
    assert.equal(summary.payableRateAllowed, false);
  });

  it("[USD 0/order, USD 10/order] gives avg 5, min 0, max 10", () => {
    const summary = computeCampaignCommissionSummary({
      now: NOW,
      rules: [
        { fixedAmount: 0, currency: "USD", basis: "FIXED_PER_ORDER", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        { fixedAmount: 10, currency: "USD", basis: "FIXED_PER_ORDER", effectiveFrom: "2026-01-01T00:00:00.000Z" },
      ],
    });
    assert.equal(summary.avg_commission_type, AVG_COMMISSION_TYPE.FIXED);
    assert.equal(summary.avg_commission, 5);
    assert.equal(summary.min_commission, 0);
    assert.equal(summary.max_commission, 10);
    assert.equal(summary.payableRateAllowed, false);
  });

  it("a zero rule mixed with a fixed rule or another currency remains MIXED", () => {
    const percentAndFixed = computeCampaignCommissionSummary({
      now: NOW,
      rules: [
        { ratePercent: 0, effectiveFrom: "2026-01-01T00:00:00.000Z" },
        { fixedAmount: 10, currency: "USD", basis: "CPA", effectiveFrom: "2026-01-01T00:00:00.000Z" },
      ],
    });
    assert.equal(percentAndFixed.avg_commission_type, AVG_COMMISSION_TYPE.MIXED);
    assert.equal(percentAndFixed.avg_commission, null);

    const crossCurrency = computeCampaignCommissionSummary({
      now: NOW,
      rules: [
        { fixedAmount: 0, currency: "USD", basis: "CPA", effectiveFrom: "2026-01-01T00:00:00.000Z" },
        { fixedAmount: 10, currency: "EUR", basis: "CPA", effectiveFrom: "2026-01-01T00:00:00.000Z" },
      ],
    });
    assert.equal(crossCurrency.avg_commission_type, AVG_COMMISSION_TYPE.MIXED);
  });
});
