import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { MasterCatalogDashboardService } from "../src/modules/ops/masterCatalogDashboard.service.js";

describe("MasterCatalogDashboardService", () => {
  it("returns KPI and operational summary shape", async () => {
    const service = new MasterCatalogDashboardService({
      prisma: {
        $queryRawUnsafe: mock.fn(async () => [{ total: 240 }]),
        $queryRaw: mock.fn(async () => [{ total: 3102 }]),
        supplierCampaign: { count: mock.fn(async () => 12480) },
        canonicalCampaign: { count: mock.fn(async () => 3250) },
        couponCodeMaster: { count: mock.fn(async () => 34) },
        clientCampaignAssignment: { count: mock.fn(async () => 3) },
      },
    });

    const summary = await service.getSummary();

    assert.equal(summary.kpis.brands, 240);
    assert.equal(summary.kpis.networkCampaigns, 12480);
    assert.equal(summary.kpis.masterCampaigns, 3250);
    assert.equal(summary.kpis.assignmentReady, 3102);
    assert.equal(summary.kpis.newCodeAlerts, 34);
    assert.equal(summary.navCounts.assignmentReview, 3);
    assert.equal(summary.operationalSummary.length, 3);
    assert.equal(summary.operationalSummary[0].actionPath, "/master/brands");
    assert.equal(summary.operationalSummary[2].actionVariant, "alert");
  });
});
