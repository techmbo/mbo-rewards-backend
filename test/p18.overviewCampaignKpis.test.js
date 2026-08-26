/**
 * P1.8 — Overview campaign KPI population (must use full PartnerCampaignService total).
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { PortalDashboardService } from "../src/modules/client/services/portalDashboard.service.js";

function makeCampaign(i, { live = true } = {}) {
  return {
    id: `asg-${i}`,
    campaignName: `Camp ${i}`,
    assignmentStatus: live ? "CLIENT_VISIBLE" : "PAUSED",
    displayStatus: live ? "Live" : "Paused",
    isNew: false,
  };
}

function makePortal(listCampaignsImpl) {
  const partnerCampaigns = {
    assertPartnerClient: mock.fn(async (id) => ({
      id,
      name: "A",
      slug: "a",
      status: "ACTIVE",
      currency: null,
      deletedAt: null,
    })),
    listCampaigns: mock.fn(listCampaignsImpl),
  };
  return new PortalDashboardService({
    partnerCampaigns,
    clientReporting: {
      listPerformance: mock.fn(async () => ({
        rows: [],
        items: [],
        kpis: { linkClicks: null, netOrderValue: null },
        dataAvailable: false,
      })),
    },
    prisma: {
      client: {
        findUnique: mock.fn(async ({ where }) => ({
          id: where.id,
          name: "A",
          slug: "a",
          status: "ACTIVE",
          currency: null,
          deletedAt: null,
        })),
      },
      clientBankAccount: { findUnique: mock.fn(async () => null) },
      clientCampaignAssignment: { findMany: mock.fn(async () => []) },
      conversion: { findMany: mock.fn(async () => []) },
      click: { groupBy: mock.fn(async () => []), findMany: mock.fn(async () => []) },
      clientWithdrawal: { findMany: mock.fn(async () => []) },
    },
    financeConsumer: {
      getMode: () => "LEGACY",
      compareClientEarnings: mock.fn(async () => ({
        finance: { net: 0 },
        legacy: {},
        comparison: { status: "MATCH" },
      })),
      resolveDisplayCommission: ({ legacyApproved, legacyPending }) => ({
        approvedCommission: legacyApproved,
        pendingCommission: legacyPending,
        source: "legacy",
        authoritative: true,
      }),
    },
  });
}

describe("P1.8 — Overview campaign KPI full population", () => {
  it("Case A: total 6, pageSize 100 → KPI 6", async () => {
    const all = Array.from({ length: 6 }, (_, i) => makeCampaign(i + 1));
    const portal = makePortal(async (_id, query = {}) => {
      const pageSize = Number(query.pageSize) || 20;
      return {
        campaigns: all.slice(0, pageSize),
        pagination: { page: 1, pageSize, total: 6, totalPages: 1 },
      };
    });
    const overview = await portal.getOverview("client-a");
    assert.equal(overview.kpis.totalCampaigns, 6);
    assert.equal(overview.kpis.activeCampaigns, 6);
    assert.equal(overview.kpis.campaignRepoTotal, 6);
  });

  it("Case B: total 157, pageSize probe 1 then fetch 157 → KPI 157 (not 100)", async () => {
    const all = Array.from({ length: 157 }, (_, i) => makeCampaign(i + 1));
    const portal = makePortal(async (_id, query = {}) => {
      const pageSize = Number(query.pageSize) || 20;
      return {
        campaigns: all.slice(0, pageSize),
        pagination: { page: 1, pageSize, total: 157, totalPages: Math.ceil(157 / pageSize) },
      };
    });
    const overview = await portal.getOverview("client-a");
    assert.equal(overview.kpis.totalCampaigns, 157);
    assert.equal(overview.kpis.activeCampaigns, 157);
    assert.notEqual(overview.kpis.totalCampaigns, 100);
    // Probe pageSize=1 then full fetch
    assert.ok(portal.partnerCampaigns.listCampaigns.mock.calls.length >= 2);
    const secondCall = portal.partnerCampaigns.listCampaigns.mock.calls[1].arguments[1];
    assert.equal(secondCall.pageSize, 157);
  });

  it("Case C: visible population 0 → KPI 0 (honest zero)", async () => {
    const portal = makePortal(async () => ({
      campaigns: [],
      pagination: { page: 1, pageSize: 1, total: 0, totalPages: 0 },
    }));
    const overview = await portal.getOverview("client-a");
    assert.equal(overview.kpis.totalCampaigns, 0);
    assert.equal(overview.kpis.activeCampaigns, 0);
    assert.equal(overview.kpis.campaignRepoTotal, 0);
  });
});
