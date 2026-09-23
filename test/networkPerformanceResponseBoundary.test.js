/**
 * GET /ops/admin/performance?grain=network — response boundary.
 *
 * The network-grain rows come from the shared, permission-blind toNetworkPerformanceDto. The admin
 * service must (1) null supplier commission / receivable / EPC without finance_ops:read or
 * commission:read, exactly like the default grain, and (2) never send raw supplier references or
 * the unmapped source payload, whatever the permission.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  AdminContractService,
  NETWORK_PERFORMANCE_FINANCIAL_FIELDS,
  NETWORK_PERFORMANCE_PUBLIC_FIELDS,
  toNetworkPerformanceResponseKpis,
  toNetworkPerformanceResponseRow,
} from "../src/modules/ops/adminContract.service.js";
import { PERMISSIONS } from "../src/auth/permissions.js";
import { toNetworkPerformanceDto } from "../src/modules/networkPortal/networkPortal.dto.js";

const TOKEN = "tok_DECOY_SOURCE_ONLY_123";

function fact() {
  return {
    id: "fact-1",
    grainKey: "g1",
    supplier: "OPTIMISE",
    sourceAccountLabel: "default",
    reportDate: new Date("2026-09-01T00:00:00.000Z"),
    reportExternalId: "rpt-77",
    campaignSourceId: "cs-1",
    supplierCampaignDbId: null,
    supplierCampaign: null,
    supplierCampaignId: null,
    brandName: "Brand A",
    campaignName: "Campaign A",
    country: "AE",
    currency: "AED",
    campaignChannelType: "LINK",
    couponCode: "SAVE10",
    networkTrackingLink: `https://track.example.test/c?aff=1&token=${TOKEN}`,
    mboTrackingLink: "https://mbo.example.test/r/abc",
    trackingLinkId: "tl-1",
    networkClickId: "nclick-DECOY",
    mboClickId: "mclick-DECOY",
    subId1: "sub1-DECOY",
    subId2: "sub2-DECOY",
    subId3: "sub3-DECOY",
    impressions: null,
    networkClicks: 120,
    mboLinkClicks: 40,
    grossOrders: 10,
    pendingOrders: 2,
    confirmedOrders: 7,
    cancelledOrders: 1,
    rejectedOrders: 0,
    grossOrderValue: 1000,
    pendingOrderValue: 200,
    confirmedOrderValue: 700,
    cancelledOrderValue: 100,
    rejectedOrderValue: 0,
    paidOrderValue: 500,
    grossCommission: 80,
    pendingCommission: 16,
    confirmedCommission: 56,
    cancelledCommission: 8,
    rejectedCommission: 0,
    payableCommission: 56,
    paidCommission: 40,
    mboReceivable: 56,
    mboActuallyReceived: 40,
    aov: 100,
    epc: 0.67,
    conversionRate: 0.08,
    rawPayloadId: "raw-DECOY",
    sourceEndpoint: "optimise.reporting",
    reportGranularity: "daily",
    lastSyncedAt: new Date("2026-09-02T00:00:00.000Z"),
    lastUpdatedAt: new Date("2026-09-02T00:00:00.000Z"),
    metadata: {
      rawStatus: "approved",
      sourceOnly: { api_token: TOKEN, customer_email: "person@example.test" },
    },
  };
}

function fakeDb(calls) {
  return {
    networkPerformanceFact: {
      findMany: async (args) => {
        calls.push({ op: "findMany", args });
        return [fact()];
      },
      count: async (args) => {
        calls.push({ op: "count", args });
        return 1;
      },
      aggregate: async (args) => {
        calls.push({ op: "aggregate", args });
        return {
          _sum: {
            networkClicks: 120,
            mboLinkClicks: 40,
            grossOrders: 10,
            confirmedOrders: 7,
            grossCommission: 80,
            confirmedCommission: 56,
            mboReceivable: 56,
          },
        };
      },
    },
    supplierCampaign: { findMany: async () => [] },
  };
}

const FILTERS = {
  grain: "network",
  network: "optimise",
  from: "2026-09-01",
  to: "2026-09-30",
  brand: "Brand",
  campaignType: "LINK",
  status: "MATCHED",
  q: "Campaign",
  skip: 50,
  take: 25,
};

const RAW_KEYS = [
  "networkTrackingLink",
  "networkClickId",
  "mboClickId",
  "subId1",
  "subId2",
  "subId3",
  "subIds",
  "rawPayloadId",
  "sourceOnlyFields",
  "sourceOnlyFieldNames",
];

async function run(permissions) {
  const calls = [];
  const svc = new AdminContractService({ prisma: fakeDb(calls) });
  const result = await svc.listPerformance(FILTERS, permissions);
  return { result, calls };
}

describe("network-grain performance response boundary", () => {
  it("performance:read only: non-financial fields present, commission / receivable / EPC nulled", async () => {
    const { result } = await run([PERMISSIONS.PERFORMANCE_READ]);
    assert.equal(result.includeFinancial, false);
    assert.equal(result.grain, "network");
    const row = result.items[0];

    assert.equal(row.networkSource, "OPTIMISE");
    assert.equal(row.brandName, "Brand A");
    assert.equal(row.campaignName, "Campaign A");
    assert.equal(row.currency, "AED");
    assert.equal(row.country, "AE");
    assert.equal(row.date, "2026-09-01");
    assert.equal(row.linkClicks, 120);
    assert.equal(row.grossOrders, 10);
    assert.equal(row.confirmedOrders, 7);
    assert.equal(row.netOrders, 7);
    // Order values and AOV stay performance data, as on the default grain.
    assert.equal(row.grossOrderValue, 1000);
    assert.equal(row.netOrderValue, 700);
    assert.equal(row.aov, 100);

    for (const key of NETWORK_PERFORMANCE_FINANCIAL_FIELDS) {
      assert.equal(row[key], null, `${key} must be null without finance/commission permission`);
    }
    assert.deepEqual(row.financial, { state: "REDACTED", reason: "insufficient_permission" });

    assert.equal(result.kpis.linkClicks, 120);
    assert.equal(result.kpis.grossOrders, 10);
    for (const key of ["grossCommission", "confirmedCommission", "netCommission", "mboReceivable"]) {
      assert.equal(result.kpis[key], null, `kpi ${key} must be null without permission`);
    }
  });

  for (const [label, perm] of [
    ["commission:read", PERMISSIONS.COMMISSION_READ],
    ["finance_ops:read", PERMISSIONS.FINANCE_OPS_READ],
  ]) {
    it(`${label}: financial fields and kpis still returned`, async () => {
      const { result } = await run([PERMISSIONS.PERFORMANCE_READ, perm]);
      assert.equal(result.includeFinancial, true);
      const row = result.items[0];
      assert.equal(row.grossCommission, 80);
      assert.equal(row.confirmedCommission, 56);
      assert.equal(row.netCommission, 56);
      assert.equal(row.pendingCommission, 16);
      assert.equal(row.paidCommission, 40);
      assert.equal(row.mboReceivable, 56);
      assert.equal(row.mboActuallyReceived, 40);
      assert.equal(row.epc, 0.67);
      assert.equal(row.financial.state, "INCLUDED");
      assert.equal(result.kpis.grossCommission, 80);
      assert.equal(result.kpis.confirmedCommission, 56);
      assert.equal(result.kpis.mboReceivable, 56);
    });
  }

  it("sourceOnlyFields and raw supplier references are never sent, with or without finance permission", async () => {
    for (const perms of [[PERMISSIONS.PERFORMANCE_READ], [PERMISSIONS.PERFORMANCE_READ, PERMISSIONS.FINANCE_OPS_READ]]) {
      const { result } = await run(perms);
      const row = result.items[0];
      for (const key of RAW_KEYS) assert.equal(key in row, false, `${key} must not be sent`);
      const body = JSON.stringify(result);
      for (const decoy of [TOKEN, "person@example.test", "nclick-DECOY", "mclick-DECOY", "sub1-DECOY", "raw-DECOY", "track.example.test"]) {
        assert.ok(!body.includes(decoy), `${decoy} leaked`);
      }
      // Kept on purpose: MBO's own link / id and the static source label.
      assert.equal(row.mboTrackingLink, "https://mbo.example.test/r/abc");
      assert.equal(row.trackingLinkId, "tl-1");
      assert.equal(row.sourceEndpoint, "optimise.reporting");
      assert.equal(row.reportId, "rpt-77");
    }
  });

  it("the shared DTO still carries the raw keys: the boundary is this endpoint, not the DTO", () => {
    const dto = toNetworkPerformanceDto(fact());
    assert.ok(dto.sourceOnlyFields && dto.sourceOnlyFields.api_token === TOKEN);
    const shaped = toNetworkPerformanceResponseRow(dto, { includeFinancial: true });
    assert.equal("sourceOnlyFields" in shaped, false);
    // Every DTO key is either allowlisted, financial, or one of the deliberately omitted raw keys.
    const known = new Set([...NETWORK_PERFORMANCE_PUBLIC_FIELDS, ...NETWORK_PERFORMANCE_FINANCIAL_FIELDS, ...RAW_KEYS]);
    assert.deepEqual(Object.keys(dto).filter((k) => !known.has(k)), []);
  });

  it("filters and pagination reach the fact query unchanged, identically for both permission levels", async () => {
    const a = await run([PERMISSIONS.PERFORMANCE_READ]);
    const b = await run([PERMISSIONS.PERFORMANCE_READ, PERMISSIONS.COMMISSION_READ]);
    const findA = a.calls.find((c) => c.op === "findMany").args;
    const findB = b.calls.find((c) => c.op === "findMany").args;
    assert.deepEqual(findA, findB);
    assert.equal(findA.skip, 50);
    assert.equal(findA.take, 25);
    assert.equal(findA.where.supplier, "OPTIMISE");
    assert.equal(findA.where.brandName.contains, "Brand");
    assert.equal(findA.where.campaignChannelType, "AFFILIATE_LINK_ONLY"); // existing channel-filter normalization
    assert.ok(findA.where.reportDate.gte instanceof Date && findA.where.reportDate.lte instanceof Date);
    assert.equal(findA.where.AND.length, 2); // q and status
    assert.equal(a.result.total, 1);
    assert.deepEqual(
      a.calls.find((c) => c.op === "count").args,
      b.calls.find((c) => c.op === "count").args,
    );
  });

  it("kpi helper leaves counts and non-financial kpis untouched", () => {
    const kpis = { linkClicks: 5, grossOrders: 2, grossCommission: 9, confirmedCommission: 3, netCommission: 3, mboReceivable: 3 };
    assert.deepEqual(toNetworkPerformanceResponseKpis(kpis, { includeFinancial: false }), {
      linkClicks: 5,
      grossOrders: 2,
      grossCommission: null,
      confirmedCommission: null,
      netCommission: null,
      mboReceivable: null,
    });
    assert.deepEqual(toNetworkPerformanceResponseKpis(kpis, { includeFinancial: true }), kpis);
  });

  it("endpoint path and permission gate are unchanged", () => {
    const routes = fs.readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
    assert.ok(
      routes.includes(
        'router.get("/ops/admin/performance", authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ), adminListPerformanceHandler);',
      ),
    );
  });
});
