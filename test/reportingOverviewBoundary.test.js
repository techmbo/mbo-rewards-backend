/**
 * GET /ops/admin/reporting-overview — financial boundary.
 *
 * Money in the overview (order value, network / confirmed commission, mboCommissionMade) needs the
 * same permission as the performance endpoint: finance_ops:read or commission:read. Counts,
 * networks and brands stay visible with performance:read alone. Aggregation itself is unchanged.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  AdminClientReportingService,
  REPORTING_OVERVIEW_FINANCIAL_FIELDS,
  canViewReportingFinancial,
} from "../src/modules/ops/adminClientReporting.service.js";
import { PERMISSIONS } from "../src/auth/permissions.js";

const TOKEN = "tok_DECOY_OVERVIEW_9";

function fact(extra) {
  return {
    sourceAccountLabel: "default",
    reportDate: new Date("2026-09-01T00:00:00.000Z"),
    supplierCampaignDbId: null,
    supplierCampaign: null,
    supplierCampaignId: null,
    campaignName: "Campaign",
    campaignChannelType: "LINK",
    networkTrackingLink: `https://track.example.test/c?token=${TOKEN}`,
    networkClickId: "nclick-DECOY",
    mboClickId: "mclick-DECOY",
    subId1: "sub1-DECOY",
    rawPayloadId: "raw-DECOY",
    metadata: { sourceOnly: { api_key: TOKEN } },
    ...extra,
  };
}

// Two networks in two currencies: the overview sums them as it did before (mixed-currency issue
// is out of scope and deliberately left unchanged).
const FACTS = [
  fact({ id: "f1", supplier: "OPTIMISE", brandName: "Brand A", currency: "AED", grossOrders: 10, confirmedOrders: 6, grossOrderValue: 1000, grossCommission: 80, confirmedCommission: 50, mboReceivable: 50 }),
  fact({ id: "f2", supplier: "OPTIMISE", brandName: "Brand B", currency: "AED", grossOrders: 4, confirmedOrders: 3, grossOrderValue: 400, grossCommission: 30, confirmedCommission: null, payableCommission: 20, mboReceivable: 20 }),
  fact({ id: "f3", supplier: "AWIN", brandName: "Brand A", currency: "GBP", grossOrders: 5, confirmedOrders: 5, grossOrderValue: 900, grossCommission: 120, confirmedCommission: 110, mboReceivable: 110 }),
];

function fakeDb(calls) {
  return {
    networkPerformanceFact: {
      findMany: async (args) => {
        calls.push({ op: "findMany", args });
        return FACTS;
      },
      count: async () => FACTS.length,
      aggregate: async () => ({ _sum: {} }),
    },
    supplierCampaign: { findMany: async () => [] },
  };
}

async function overview(permissions, query = {}) {
  const calls = [];
  const svc = new AdminClientReportingService({ prisma: fakeDb(calls), clientReporting: {} });
  return { result: await svc.getReportingOverview(query, permissions), calls };
}

const NETWORK_ROW_KEYS = [
  "network",
  "ordersGenerated",
  "grossOrderValue",
  "networkCommission",
  "confirmedOrders",
  "confirmedCommission",
  "mboCommissionMade",
].sort();

describe("reporting-overview financial boundary", () => {
  it("permission helper matches the performance endpoint rule", () => {
    assert.equal(canViewReportingFinancial([PERMISSIONS.PERFORMANCE_READ]), false);
    assert.equal(canViewReportingFinancial([PERMISSIONS.COMMISSION_READ]), true);
    assert.equal(canViewReportingFinancial([PERMISSIONS.FINANCE_OPS_READ]), true);
    assert.equal(canViewReportingFinancial(undefined), false);
  });

  it("performance:read only: counts, networks and brands visible; every amount null", async () => {
    const { result } = await overview([PERMISSIONS.PERFORMANCE_READ]);
    assert.equal(result.includeFinancial, false);
    assert.deepEqual(result.financial, { state: "REDACTED", reason: "insufficient_permission" });

    assert.equal(result.kpis.ordersGenerated, 19);
    assert.equal(result.kpis.confirmedOrders, 14);
    for (const key of REPORTING_OVERVIEW_FINANCIAL_FIELDS) assert.equal(result.kpis[key], null, `kpis.${key}`);

    for (const list of [result.topNetworks, result.networkSummary]) {
      assert.equal(list.length, 2);
      for (const row of list) {
        assert.ok(row.network);
        assert.equal(typeof row.ordersGenerated, "number");
        assert.equal(typeof row.confirmedOrders, "number");
        for (const key of REPORTING_OVERVIEW_FINANCIAL_FIELDS) assert.equal(row[key], null, `${row.network}.${key}`);
      }
    }
    const optimise = result.networkSummary.find((n) => n.network === "OPTIMISE");
    assert.equal(optimise.ordersGenerated, 14);
    assert.equal(optimise.confirmedOrders, 9);
    assert.deepEqual(result.topBrands, [
      { brandName: "Brand A", orders: 15 },
      { brandName: "Brand B", orders: 4 },
    ]);

    const body = JSON.stringify(result);
    for (const amount of ["1000", "2300", "230", "180", "160"]) assert.ok(!body.includes(`:${amount}`), `amount ${amount} leaked`);
  });

  for (const [label, perm] of [
    ["commission:read", PERMISSIONS.COMMISSION_READ],
    ["finance_ops:read", PERMISSIONS.FINANCE_OPS_READ],
  ]) {
    it(`${label}: financial values returned with the existing formulas`, async () => {
      const { result } = await overview([PERMISSIONS.PERFORMANCE_READ, perm]);
      assert.equal(result.includeFinancial, true);
      assert.equal(result.financial.state, "INCLUDED");
      // Existing aggregation, unchanged: sums across currencies; confirmed falls back to netCommission.
      assert.deepEqual(result.kpis, {
        ordersGenerated: 19,
        grossOrderValue: 2300,
        networkCommission: 230,
        confirmedOrders: 14,
        confirmedCommission: 180,
        mboCommissionMade: 180,
      });
      // Sorted by networkCommission, as before.
      assert.deepEqual(result.networkSummary.map((n) => n.network), ["AWIN", "OPTIMISE"]);
      const optimise = result.networkSummary.find((n) => n.network === "OPTIMISE");
      assert.equal(optimise.grossOrderValue, 1400);
      assert.equal(optimise.networkCommission, 110);
      assert.equal(optimise.confirmedCommission, 70);
      assert.equal(optimise.mboCommissionMade, 70);
    });
  }

  it("redacted response is the authorized response with only the amounts nulled", async () => {
    const full = (await overview([PERMISSIONS.COMMISSION_READ])).result;
    const redacted = (await overview([PERMISSIONS.PERFORMANCE_READ])).result;
    const strip = (r) => {
      const clone = JSON.parse(JSON.stringify(r));
      delete clone.includeFinancial;
      delete clone.financial;
      for (const key of REPORTING_OVERVIEW_FINANCIAL_FIELDS) clone.kpis[key] = null;
      for (const list of [clone.topNetworks, clone.networkSummary]) {
        for (const row of list) for (const key of REPORTING_OVERVIEW_FINANCIAL_FIELDS) row[key] = null;
      }
      return clone;
    };
    assert.deepEqual(strip(redacted), strip(full));
  });

  it("no raw supplier fields reach the overview, with or without finance permission", async () => {
    for (const perms of [[PERMISSIONS.PERFORMANCE_READ], [PERMISSIONS.FINANCE_OPS_READ]]) {
      const { result } = await overview(perms);
      assert.deepEqual(
        Object.keys(result).sort(),
        ["contract", "financial", "grainNote", "includeFinancial", "kpis", "networkSummary", "topBrands", "topNetworks"],
      );
      for (const row of [...result.topNetworks, ...result.networkSummary]) {
        assert.deepEqual(Object.keys(row).sort(), NETWORK_ROW_KEYS);
      }
      for (const row of result.topBrands) assert.deepEqual(Object.keys(row).sort(), ["brandName", "orders"]);
      const body = JSON.stringify(result);
      for (const decoy of [TOKEN, "nclick-DECOY", "mclick-DECOY", "sub1-DECOY", "raw-DECOY", "track.example.test", "sourceOnly"]) {
        assert.ok(!body.includes(decoy), `${decoy} leaked`);
      }
    }
  });

  it("the fact query keeps the 5,000-row cap and the same filters", async () => {
    const a = await overview([PERMISSIONS.PERFORMANCE_READ], { network: "awin", brand: "Brand", from: "2026-09-01", to: "2026-09-30" });
    const b = await overview([PERMISSIONS.FINANCE_OPS_READ], { network: "awin", brand: "Brand", from: "2026-09-01", to: "2026-09-30" });
    const findA = a.calls.find((c) => c.op === "findMany").args;
    const findB = b.calls.find((c) => c.op === "findMany").args;
    assert.deepEqual(findA, findB);
    assert.equal(findA.skip, 0);
    assert.equal(findA.take, 5000);
    assert.equal(findA.where.supplier, "AWIN");
    assert.equal(findA.where.brandName.contains, "Brand");
  });

  it("route path and performance:read gate unchanged; controller passes caller permissions", () => {
    const routes = fs.readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
    assert.ok(
      routes.includes(
        'router.get("/ops/admin/reporting-overview", authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ), adminReportingOverviewHandler);',
      ),
    );
    const controller = fs.readFileSync(new URL("../src/controllers/adminContract.controller.js", import.meta.url), "utf8");
    assert.ok(controller.includes("adminClientReporting.getReportingOverview(req.query ?? {}, req.permissions || [])"));
  });

  it("a caller that passes no permissions gets the redacted response", async () => {
    const calls = [];
    const svc = new AdminClientReportingService({ prisma: fakeDb(calls), clientReporting: {} });
    const result = await svc.getReportingOverview({});
    assert.equal(result.includeFinancial, false);
    assert.equal(result.kpis.networkCommission, null);
  });
});
