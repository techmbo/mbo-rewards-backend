/**
 * P1.14.2 — MBO click enrich + customerType mapping acceptance tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregatePerformanceRowsByGrain,
  enrichFactsWithMboLinkClicks,
  mapPerformanceRowToFactInput,
  normalizeCustomerType,
} from "../src/modules/networkPortal/networkPerformanceFact.ingestion.js";

describe("P1.14.2 customerType — Optimise custType", () => {
  it("maps Optimise custType without inventing when absent", () => {
    const withType = mapPerformanceRowToFactInput(
      {
        date: "2026-08-10",
        custType: "New",
        clicks: 5,
        orders: 1,
      },
      { networkSource: "optimise_sea" },
    );
    assert.equal(withType.customerType, "NEW");
    assert.equal(withType.networkClicks, 5);
    assert.equal(withType.mboLinkClicks, null);

    const without = mapPerformanceRowToFactInput(
      { date: "2026-08-10", clicks: 5 },
      { networkSource: "optimise_mena" },
    );
    assert.equal(without.customerType, null);
  });

  it("normalizeCustomerType only normalizes labels — never invents", () => {
    assert.equal(normalizeCustomerType(null), null);
    assert.equal(normalizeCustomerType(""), null);
    assert.equal(normalizeCustomerType("returning"), "EXISTING");
    assert.equal(normalizeCustomerType("VIP-SEGMENT"), "VIP-SEGMENT");
  });

  it("keeps customerType in daily aggregation grain", () => {
    const rows = aggregatePerformanceRowsByGrain([
      { date: "2026-08-10", campaign_id: "c1", custType: "New", orders: 1, commission: 1 },
      { date: "2026-08-10", campaign_id: "c1", custType: "Returning", orders: 1, commission: 2 },
      { date: "2026-08-10", campaign_id: "c1", custType: "New", orders: 1, commission: 3 },
    ]);
    assert.equal(rows.length, 2);
    const neu = rows.find((r) => r.customerType === "NEW");
    const ret = rows.find((r) => r.customerType === "EXISTING");
    assert.equal(neu.orders, 2);
    assert.equal(neu.commission, 4);
    assert.equal(ret.orders, 1);
    assert.equal(ret.commission, 2);
  });
});

describe("P1.14.2 enrichFactsWithMboLinkClicks", () => {
  it("counts clicks for resolvable CampaignSource and leaves unresolved null", async () => {
    const updates = [];
    const db = {
      networkPerformanceFact: {
        findMany: async () => [
          {
            id: "f1",
            supplier: "BOOSTINY",
            sourceAccountLabel: "default",
            reportDate: new Date("2026-08-10T00:00:00Z"),
            campaignSourceId: "cs-1",
            supplierCampaignDbId: null,
            supplierCampaignId: "ext-1",
            networkClicks: 100,
            mboLinkClicks: null,
          },
          {
            id: "f2",
            supplier: "BOOSTINY",
            sourceAccountLabel: "default",
            reportDate: new Date("2026-08-10T00:00:00Z"),
            campaignSourceId: null,
            supplierCampaignDbId: null,
            supplierCampaignId: null,
            networkClicks: 50,
            mboLinkClicks: null,
          },
          {
            id: "f3",
            supplier: "BOOSTINY",
            sourceAccountLabel: "default",
            reportDate: new Date("2026-08-11T00:00:00Z"),
            campaignSourceId: "cs-1",
            supplierCampaignDbId: null,
            supplierCampaignId: "ext-1",
            networkClicks: 10,
            mboLinkClicks: null,
          },
        ],
        update: async ({ where, data }) => {
          updates.push({ id: where.id, ...data });
          return { id: where.id, ...data };
        },
      },
      campaignSource: { findMany: async () => [] },
      supplierCampaign: { findFirst: async () => null },
      click: {
        count: async ({ where }) => {
          if (where.campaignSourceId === "cs-1") {
            const start = where.clickedAt.gte.toISOString().slice(0, 10);
            if (start === "2026-08-10") return 3;
            if (start === "2026-08-11") return 0;
          }
          return 0;
        },
      },
    };

    const result = await enrichFactsWithMboLinkClicks({ db, supplier: "BOOSTINY" });
    assert.equal(result.examined, 3);
    assert.equal(result.updated, 2);
    assert.equal(result.unresolved, 1);

    const f1 = updates.find((u) => u.id === "f1");
    const f3 = updates.find((u) => u.id === "f3");
    assert.equal(f1.mboLinkClicks, 3);
    assert.equal(f3.mboLinkClicks, 0);
    assert.ok(!updates.some((u) => u.id === "f2"));
    // Never copied network clicks
    assert.notEqual(f1.mboLinkClicks, 100);
    assert.notEqual(f3.mboLinkClicks, 10);
  });

  it("is idempotent when mboLinkClicks already matches count", async () => {
    let updateCalls = 0;
    const db = {
      networkPerformanceFact: {
        findMany: async () => [
          {
            id: "f1",
            supplier: "TRACKIER",
            sourceAccountLabel: "default",
            reportDate: new Date("2026-08-12T00:00:00Z"),
            campaignSourceId: "cs-9",
            supplierCampaignDbId: null,
            supplierCampaignId: "x",
            networkClicks: 99,
            mboLinkClicks: 2,
          },
        ],
        update: async () => {
          updateCalls += 1;
        },
      },
      campaignSource: { findMany: async () => [] },
      supplierCampaign: { findFirst: async () => null },
      click: { count: async () => 2 },
    };
    const result = await enrichFactsWithMboLinkClicks({ db });
    assert.equal(result.updated, 0);
    assert.equal(updateCalls, 0);
  });
});

describe("P1.14.2 settlement / payable separation", () => {
  it("never copies payable commission into mboActuallyReceived", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-10",
        commission: 25,
        payableCommission: 25,
        confirmedCommission: 25,
      },
      { networkSource: "partnerize" },
    );
    assert.equal(input.payableCommission, 25);
    assert.equal(input.mboActuallyReceived, null);
  });
});
