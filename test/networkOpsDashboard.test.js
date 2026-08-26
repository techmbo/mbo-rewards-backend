/**
 * Network Operations daily dashboard — KPI + separated source layers.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { NetworkOpsDashboardService } from "../src/modules/ops/networkOpsDashboard.service.js";

function mockDb(overrides = {}) {
  return {
    marketplaceAccount: {
      count: mock.fn(async (args) => {
        if (args?.where) return overrides.connectedAccounts ?? 2;
        return overrides.marketplaceAccounts ?? 3;
      }),
    },
    campaignSource: {
      count: mock.fn(async () => overrides.campaignSources ?? 9),
    },
    supplierCommissionRule: {
      count: mock.fn(async () => overrides.supplierCommissionRules ?? 5),
    },
    mapperError: {
      count: mock.fn(async () => overrides.openMappingExceptions ?? 2),
    },
    entity: {
      groupBy: mock.fn(async () =>
        overrides.entityTypeGroups ?? [
          { entityType: "campaign", _count: { _all: 12 } },
          { entityType: "coupon", _count: { _all: 4 } },
          { entityType: "performance", _count: { _all: 30 } },
        ],
      ),
    },
    trackingLink: { count: mock.fn(async () => overrides.trackingLinks ?? 7) },
    conversion: { count: mock.fn(async () => overrides.conversions ?? 11) },
    rawPayload: { count: mock.fn(async () => overrides.rawPayloads ?? 100) },
    productFeedItem: { count: mock.fn(async () => overrides.productFeedItems ?? 0) },
    financialTransaction: { count: mock.fn(async () => overrides.financialTransactions ?? 8) },
    ...overrides.extra,
  };
}

describe("NetworkOpsDashboardService", () => {
  it("returns spec-aligned KPI cards with live counts", async () => {
    const svc = new NetworkOpsDashboardService({
      prisma: mockDb({
        marketplaceAccounts: 9,
        connectedAccounts: 7,
        campaignSources: 9,
        supplierCommissionRules: 5,
        openMappingExceptions: 2,
      }),
    });

    const summary = await svc.getSummary();

    assert.equal(summary.kpis.networkSources.count, 9);
    assert.equal(summary.kpis.networkSources.connectedCount, 7);
    assert.equal(summary.kpis.campaignSources.count, 9);
    assert.equal(summary.kpis.supplierCommissionRules.count, 5);
    assert.equal(summary.kpis.openMappingExceptions.count, 2);
    assert.equal(summary.kpis.networkSources.hint, "Connected / implementation profiles");
    assert.equal(summary.kpis.supplierCommissionRules.hint, "Separate rule records");
    assert.equal(summary.kpis.openMappingExceptions.hint, "Require review");
  });

  it("keeps source layers separate — not one combined asset count", async () => {
    const svc = new NetworkOpsDashboardService({ prisma: mockDb() });
    const summary = await svc.getSummary();

    assert.ok(Array.isArray(summary.sourceLayers));
    assert.equal(summary.sourceLayers.length, 9);
    const keys = summary.sourceLayers.map((row) => row.key);
    assert.deepEqual(keys, [
      "campaign",
      "commission",
      "coupon",
      "link",
      "offer",
      "product",
      "performance",
      "order",
      "payment",
    ]);
    for (const layer of summary.sourceLayers) {
      assert.ok(typeof layer.count === "number");
      assert.ok(layer.label);
    }
  });

  it("documents the MBO data-flow stages", async () => {
    const svc = new NetworkOpsDashboardService({ prisma: mockDb() });
    const summary = await svc.getSummary();

    assert.equal(summary.dataFlow.stages.length, 6);
    assert.match(summary.dataFlow.operationalRule, /never discarded/i);
    assert.equal(summary.dataFlow.stages[0].label, "Network API Response");
    assert.equal(summary.dataFlow.stages.at(-1).label, "Client-Safe Model");
  });
});
