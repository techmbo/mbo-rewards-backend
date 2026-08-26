/**
 * P1.7 Wave 6 — Client portal performance contract (04A/04C client-safe).
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  toClientPerformanceItemDto,
  CLIENT_PERFORMANCE_FORBIDDEN_KEYS,
} from "../src/modules/client/dto/clientPerformance.dto.js";
import { ClientReportingService } from "../src/modules/client/services/clientReporting.service.js";
import {
  summarizeConversionsForBucket,
  sumDistinctOrderValues,
  uniqueOrNull,
} from "../src/modules/ops/v15PerformanceGrain.js";
import { CLIENT_API } from "../../frontend/src/apiUrl.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("P1.7 Wave 6 — endpoint + DTO safety", () => {
  it("CLIENT_API.performance is canonical /v1/client/performance", () => {
    assert.equal(CLIENT_API.performance, "/v1/client/performance");
  });

  it("customerType and confirm dates stay unavailable", () => {
    const dto = toClientPerformanceItemDto({
      reportDate: "2026-07-31",
      brandName: "Ubuy",
      clickCount: 10,
      conversionCount: 2,
      approvedConversionCount: 1,
      clientCommission: 5,
      currency: "USD",
    });
    assert.equal(dto.customerType, null);
    assert.equal(dto.orderConfirmDate, null);
    assert.equal(dto.orderPaymentConfirmDate, null);
    assert.equal(dto.orderDate, null);
    assert.equal(dto.linkClicks, 10);
    assert.equal(dto.clientCommission, 5);
    assert.equal(dto.confirmedClientCommission, 5);
    assert.equal(dto.currency, "USD");
  });

  it("maps v20 Client Performance funnel and tracking fields", () => {
    const dto = toClientPerformanceItemDto({
      reportDate: "2026-08-16",
      brandName: "Myntra",
      campaignName: "Fashion Sale",
      clientCampaignType: "Coupon",
      couponCode: "HDFC30",
      mboTrackingLink: "https://mborewards.com/r/hdfc/myntra",
      conversionCount: 10,
      pendingOrders: 2,
      confirmedOrders: 7,
      rejectedOrders: 1,
      cancelledOrders: 0,
      grossOrderValue: 1000,
      confirmedOrderValue: 800,
      clientCommission: 50,
      pendingClientCommission: 10,
      clientCommissionGenerated: 60,
      lastUpdatedAt: new Date("2026-08-16T15:40:00Z"),
      currency: "INR",
    });
    assert.equal(dto.campaignType, "Coupon");
    assert.equal(dto.mboTrackingLink, "https://mborewards.com/r/hdfc/myntra");
    assert.equal(dto.pendingOrders, 2);
    assert.equal(dto.confirmedOrders, 7);
    assert.equal(dto.rejectedOrders, 1);
    assert.equal(dto.confirmedOrderValue, 800);
    assert.equal(dto.clientCommissionGenerated, 60);
    assert.equal(dto.confirmedClientCommission, 50);
    assert.ok(dto.lastUpdatedAt);
  });

  it("DTO JSON never includes forbidden finance keys", () => {
    const dto = toClientPerformanceItemDto({
      reportDate: "2026-07-31",
      grossCommission: 999,
      mboCommission: 111,
      netCommission: 222,
      supplierReceivable: 333,
      clientCommission: 10,
    });
    const blob = JSON.stringify(dto);
    for (const key of CLIENT_PERFORMANCE_FORBIDDEN_KEYS) {
      assert.equal(blob.includes(key), false, `leaked ${key}`);
    }
    assert.equal(dto.clientCommission, 10);
    assert.equal(dto.grossCommission, undefined);
  });

  it("currency null stays null — never INR invent in DTO", () => {
    const dto = toClientPerformanceItemDto({ reportDate: "2026-01-01", currency: null });
    assert.equal(dto.currency, null);
  });
});

describe("P1.7 Wave 6 — grain helpers preserved", () => {
  it("mixed channel → null", () => {
    const summary = summarizeConversionsForBucket([
      { status: "APPROVED", clickId: "c1", metadata: {} },
      { status: "APPROVED", clickId: null, metadata: { couponCode: "SAVE" } },
    ]);
    assert.equal(summary.channelType, null);
  });

  it("mixed coupon → null", () => {
    assert.equal(uniqueOrNull(["A", "B"]), null);
    const summary = summarizeConversionsForBucket([
      { status: "APPROVED", metadata: { couponCode: "A" } },
      { status: "APPROVED", metadata: { couponCode: "B" } },
    ]);
    assert.equal(summary.couponCode, null);
  });

  it("distinct order values do not double-count", () => {
    const orders = [
      { id: "o1", orderValue: 100, validationStatus: "VALIDATION_APPROVED" },
      { id: "o1", orderValue: 100, validationStatus: "VALIDATION_APPROVED" },
      { id: "o2", orderValue: 50, validationStatus: "PENDING" },
    ];
    const sum = sumDistinctOrderValues(orders);
    assert.equal(sum.grossOrderValue, 150);
    assert.equal(sum.netOrderValue, 100);
  });
});

describe("P1.7 Wave 6 — empty DailyReport honest KPIs", () => {
  it("returns dataAvailable false and null KPIs when no rows", async () => {
    const client = {
      id: "client-a",
      name: "A",
      slug: "a",
      status: "ACTIVE",
      deletedAt: null,
      currency: null,
    };
    const svc = new ClientReportingService({
      partnerCampaigns: {
        assertPartnerClient: mock.fn(async () => client),
      },
      prisma: {
        dailyReport: {
          findMany: mock.fn(async () => []),
          count: mock.fn(async () => 0),
          aggregate: mock.fn(async () => ({ _sum: {} })),
        },
      },
    });
    const out = await svc.listPerformance("client-a", { pageSize: 50 });
    assert.equal(out.dataAvailable, false);
    assert.equal(out.dataState, "empty");
    assert.equal(out.kpis.linkClicks, null);
    assert.equal(out.kpis.grossOrders, null);
    assert.equal(out.kpis.clientCommission, null);
    assert.equal(out.kpis.currency, null);
    assert.deepEqual(out.items, []);
    const dataBlob = JSON.stringify({ items: out.items, kpis: out.kpis, rows: out.rows });
    for (const key of ["supplierReceivable", "mboMargin", "mboCommission", "rawPayload"]) {
      assert.equal(dataBlob.includes(key), false, key);
    }
  });

  it("forces tenant clientId even if query tries another", async () => {
    const client = {
      id: "client-a",
      name: "A",
      slug: "a",
      status: "ACTIVE",
      deletedAt: null,
      currency: "USD",
    };
    let seenWhere = null;
    const svc = new ClientReportingService({
      partnerCampaigns: {
        assertPartnerClient: mock.fn(async (id) => {
          assert.equal(id, "client-a");
          return client;
        }),
      },
      prisma: {
        dailyReport: {
          findMany: mock.fn(async ({ where }) => {
            seenWhere = where;
            return [];
          }),
          count: mock.fn(async () => 0),
          aggregate: mock.fn(async () => ({ _sum: {} })),
        },
      },
    });
    await svc.listPerformance("client-a", { clientId: "client-b", pageSize: 10 });
    assert.equal(seenWhere.clientId, "client-a");
  });
});

describe("P1.7 Wave 6 — HTTP auth", () => {
  let server;
  it("boot", async () => {
    server = await startTestServer();
  });

  it("missing credentials → 401 on client performance", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/v1/client/performance" });
    assert.equal(status, 401);
  });

  it("portal performance alias → 401 without auth", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/portal/v1/performance" });
    assert.equal(status, 401);
  });

  it("admin performance is not a public client route (401/403 without staff auth)", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/ops/admin/performance" });
    assert.ok(status === 401 || status === 403);
  });

  it("teardown", async () => {
    await server.close();
  });
});
