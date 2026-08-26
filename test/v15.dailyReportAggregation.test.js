/**
 * DailyReport aggregation — fixture-only. Does not seed production DB.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  AggregationService,
  DAILY_REPORT_GRAIN,
} from "../src/modules/reporting/services/aggregation.service.js";
import {
  summarizeConversionsForBucket,
  sumDistinctOrderValues,
  resolveNetSupplierCommission,
  uniqueOrNull,
} from "../src/modules/ops/v15PerformanceGrain.js";
import { toAdminPerformanceDto } from "../src/modules/ops/adminContract.dto.js";
import { AdminContractService } from "../src/modules/ops/adminContract.service.js";
import { PERMISSIONS } from "../src/auth/permissions.js";

function assignment(clientId = "client-A") {
  return {
    clientId,
    canonicalCampaignId: "cc1",
    canonicalCampaign: { merchantId: "m1" },
  };
}

describe("AggregationService — DailyReport grain", () => {
  it("documents persisted grain", () => {
    assert.match(DAILY_REPORT_GRAIN, /campaignSourceId/);
    assert.match(DAILY_REPORT_GRAIN, /reportDate/);
  });

  it("aggregates real clicks into clickCount", async () => {
    const dailyReportRepo = { upsertDimension: mock.fn(async (row) => row) };
    const service = new AggregationService({
      clickRepo: {
        findMany: mock.fn(async () => ({
          rows: [
            {
              id: "c1",
              clientAssignmentId: "a1",
              campaignSourceId: "cs1",
              country: "US",
              clickedAt: new Date("2026-07-10T10:00:00.000Z"),
            },
            {
              id: "c2",
              clientAssignmentId: "a1",
              campaignSourceId: "cs1",
              country: "US",
              clickedAt: new Date("2026-07-10T11:00:00.000Z"),
            },
          ],
          total: 2,
        })),
      },
      conversionRepo: { findForAggregation: mock.fn(async () => []) },
      dailyReportRepo,
    });
    const tx = {
      clientCampaignAssignment: {
        findUnique: mock.fn(async () => assignment()),
      },
    };
    const result = await service.aggregateDay(new Date("2026-07-10T00:00:00.000Z"), {}, tx);
    assert.equal(result.rowsUpserted, 1);
    assert.equal(result.empty, false);
    const row = dailyReportRepo.upsertDimension.mock.calls[0].arguments[0];
    assert.equal(row.clickCount, 2);
    assert.equal(row.conversionCount, 0);
    assert.equal(row.campaignSourceId, "cs1");
  });

  it("aggregates attributed conversions with status splits and supplier commission", async () => {
    const dailyReportRepo = { upsertDimension: mock.fn(async (row) => row) };
    const service = new AggregationService({
      clickRepo: { findMany: mock.fn(async () => ({ rows: [], total: 0 })) },
      conversionRepo: {
        findForAggregation: mock.fn(async () => [
          {
            id: "cv-approved",
            campaignSourceId: "cs1",
            status: "APPROVED",
            supplierCommission: "10.0000",
            approvedCommission: "10.0000",
            clientCommission: "7.0000",
            mboCommission: "3.0000",
            currency: "USD",
            conversionDate: new Date("2026-07-10T15:00:00.000Z"),
            metadata: { country: "US" },
            clientAssignment: assignment(),
          },
          {
            id: "cv-rejected",
            campaignSourceId: "cs1",
            status: "REJECTED",
            supplierCommission: "5.0000",
            approvedCommission: null,
            currency: "USD",
            conversionDate: new Date("2026-07-10T16:00:00.000Z"),
            metadata: { country: "US" },
            clientAssignment: assignment(),
          },
          {
            id: "cv-pending",
            campaignSourceId: "cs1",
            status: "PENDING",
            supplierCommission: "2.0000",
            currency: "USD",
            conversionDate: new Date("2026-07-10T17:00:00.000Z"),
            metadata: { country: "US" },
            clientAssignment: assignment(),
          },
        ]),
      },
      dailyReportRepo,
    });
    const tx = { clientCampaignAssignment: { findUnique: async () => assignment() } };
    await service.aggregateRange(
      { from: new Date("2026-07-10T00:00:00.000Z"), to: new Date("2026-07-10T23:59:59.999Z") },
      tx,
    );
    const row = dailyReportRepo.upsertDimension.mock.calls[0].arguments[0];
    assert.equal(row.conversionCount, 3);
    assert.equal(row.approvedConversionCount, 1);
    // Rejected excluded from commission; pending + approved included via grossCommissionForConversion
    assert.equal(Number(row.grossCommission), 12);
    assert.equal(row.clientCommission, "7.0000");
  });

  it("deduplicates the same conversion id within a run", async () => {
    const dailyReportRepo = { upsertDimension: mock.fn(async (row) => row) };
    const dup = {
      id: "cv-same",
      campaignSourceId: "cs1",
      status: "APPROVED",
      supplierCommission: "10.0000",
      approvedCommission: "10.0000",
      currency: "USD",
      conversionDate: new Date("2026-07-10T15:00:00.000Z"),
      metadata: { country: "US" },
      clientAssignment: assignment(),
    };
    const service = new AggregationService({
      clickRepo: { findMany: mock.fn(async () => ({ rows: [], total: 0 })) },
      conversionRepo: { findForAggregation: mock.fn(async () => [dup, dup]) },
      dailyReportRepo,
    });
    await service.aggregateDay(new Date("2026-07-10"), {}, {
      clientCampaignAssignment: { findUnique: async () => assignment() },
    });
    const row = dailyReportRepo.upsertDimension.mock.calls[0].arguments[0];
    assert.equal(row.conversionCount, 1);
    assert.equal(row.grossCommission, "10.0000");
  });

  it("isolates clients into separate DailyReport buckets", async () => {
    const dailyReportRepo = { upsertDimension: mock.fn(async (row) => row) };
    const service = new AggregationService({
      clickRepo: { findMany: mock.fn(async () => ({ rows: [], total: 0 })) },
      conversionRepo: {
        findForAggregation: mock.fn(async () => [
          {
            id: "cv-a",
            campaignSourceId: "cs1",
            status: "APPROVED",
            supplierCommission: "10.0000",
            approvedCommission: "10.0000",
            conversionDate: new Date("2026-07-10T15:00:00.000Z"),
            metadata: { country: "US" },
            clientAssignment: assignment("client-A"),
          },
          {
            id: "cv-b",
            campaignSourceId: "cs1",
            status: "APPROVED",
            supplierCommission: "20.0000",
            approvedCommission: "20.0000",
            conversionDate: new Date("2026-07-10T15:00:00.000Z"),
            metadata: { country: "US" },
            clientAssignment: assignment("client-B"),
          },
        ]),
      },
      dailyReportRepo,
    });
    await service.aggregateDay(new Date("2026-07-10"), {}, {
      clientCampaignAssignment: { findUnique: async () => null },
    });
    assert.equal(dailyReportRepo.upsertDimension.mock.calls.length, 2);
    const clients = dailyReportRepo.upsertDimension.mock.calls.map((c) => c.arguments[0].clientId).sort();
    assert.deepEqual(clients, ["client-A", "client-B"]);
  });

  it("returns empty truthful result when no clicks or conversions", async () => {
    const dailyReportRepo = { upsertDimension: mock.fn(async (row) => row) };
    const service = new AggregationService({
      clickRepo: { findMany: mock.fn(async () => ({ rows: [], total: 0 })) },
      conversionRepo: { findForAggregation: mock.fn(async () => []) },
      dailyReportRepo,
    });
    const result = await service.aggregateRange(
      { from: new Date("2026-07-10"), to: new Date("2026-07-10T23:59:59.999Z") },
      { clientCampaignAssignment: { findUnique: async () => null } },
    );
    assert.equal(result.rowsUpserted, 0);
    assert.equal(result.empty, true);
    assert.equal(dailyReportRepo.upsertDimension.mock.calls.length, 0);
  });

  it("rebuild is idempotent for the same fixtures", async () => {
    const upserts = [];
    const dailyReportRepo = {
      deleteForDateRange: mock.fn(async () => ({ count: 0 })),
      upsertDimension: mock.fn(async (row) => {
        upserts.push(row);
        return row;
      }),
    };
    const fixtures = {
      clickRepo: {
        findMany: mock.fn(async () => ({
          rows: [
            {
              id: "c1",
              clientAssignmentId: "a1",
              campaignSourceId: "cs1",
              country: "US",
              clickedAt: new Date("2026-07-10T10:00:00.000Z"),
            },
          ],
          total: 1,
        })),
      },
      conversionRepo: {
        findForAggregation: mock.fn(async () => [
          {
            id: "cv1",
            campaignSourceId: "cs1",
            status: "APPROVED",
            supplierCommission: "10.0000",
            approvedCommission: "10.0000",
            conversionDate: new Date("2026-07-10T15:00:00.000Z"),
            metadata: { country: "US" },
            clientAssignment: assignment(),
          },
        ]),
      },
      dailyReportRepo,
    };
    const service = new AggregationService(fixtures);
    const tx = {
      clientCampaignAssignment: { findUnique: async () => assignment() },
    };
    // rebuild uses prisma when client null — call aggregateDay twice to prove upsert stability
    await service.aggregateDay(new Date("2026-07-10"), {}, tx);
    await service.aggregateDay(new Date("2026-07-10"), {}, tx);
    assert.equal(upserts.length, 2);
    assert.equal(upserts[0].clickCount, upserts[1].clickCount);
    assert.equal(upserts[0].grossCommission, upserts[1].grossCommission);
  });

  it("skips orphan clicks without assignment (no invented client)", async () => {
    const dailyReportRepo = { upsertDimension: mock.fn(async (row) => row) };
    const service = new AggregationService({
      clickRepo: {
        findMany: mock.fn(async () => ({
          rows: [
            {
              id: "orphan",
              clientAssignmentId: "missing",
              campaignSourceId: "cs1",
              country: "US",
              clickedAt: new Date("2026-07-10T10:00:00.000Z"),
            },
          ],
          total: 1,
        })),
      },
      conversionRepo: { findForAggregation: mock.fn(async () => []) },
      dailyReportRepo,
    });
    const result = await service.aggregateDay(new Date("2026-07-10"), {}, {
      clientCampaignAssignment: { findUnique: async () => null },
    });
    assert.equal(result.rowsUpserted, 0);
  });
});

describe("Performance projection — order / channel / coupon / finance", () => {
  it("sums distinct order ids only", () => {
    const values = sumDistinctOrderValues([
      { id: "o1", orderValue: 100, validationStatus: "VALIDATION_APPROVED" },
      { id: "o1", orderValue: 100, validationStatus: "VALIDATION_APPROVED" },
      { id: "o2", orderValue: 50, validationStatus: "VALIDATION_PENDING" },
    ]);
    assert.equal(values.grossOrderValue, 150);
    assert.equal(values.netOrderValue, 100);
  });

  it("mixed channel and coupon become null", () => {
    const summary = summarizeConversionsForBucket([
      { status: "APPROVED", clickId: "c1", metadata: { couponCode: "A" } },
      { status: "APPROVED", clickId: null, trackingLinkId: null, metadata: { couponCode: "B" } },
    ]);
    assert.equal(summary.channelType, null);
    assert.equal(summary.couponCode, null);
    assert.equal(uniqueOrNull(["LINK", "COUPON"]), null);
  });

  it("unanimous channel/coupon populate", () => {
    const summary = summarizeConversionsForBucket([
      { status: "APPROVED", clickId: "c1", metadata: { couponCode: "SAVE" } },
      { status: "PAID", trackingLinkId: "tl1", metadata: { couponCode: "SAVE" } },
    ]);
    assert.equal(summary.channelType, "LINK_AND_COUPON");
    assert.equal(summary.couponCode, "SAVE");
    assert.equal(summary.confirmedOrders, 2);
  });

  it("FinancialTransaction precedence for net commission", () => {
    const withFt = resolveNetSupplierCommission({
      ftRows: [{ supplierReceivable: 12, transactionType: "COMMISSION_EARNED" }],
      conversionApprovedSum: 99,
    });
    assert.equal(withFt.netCommission, 12);
    assert.equal(withFt.source, "financial_transaction.supplierReceivable");
    const fallback = resolveNetSupplierCommission({
      ftRows: [],
      conversionApprovedSum: 8,
    });
    assert.equal(fallback.netCommission, 8);
  });

  it("customerType and confirmation dates stay unavailable on DTO", () => {
    const dto = toAdminPerformanceDto(
      {
        clickCount: 1,
        conversionCount: 1,
        approvedConversionCount: 1,
        grossCommission: 10,
        customerType: "NEW",
        orderConfirmDate: "2026-01-01",
      },
      { includeFinancial: true },
    );
    assert.equal(dto.customerType, null);
    assert.equal(dto.operational.customerType, null);
    assert.equal(dto.orderConfirmDate, null);
    assert.equal(dto.financial.mboMargin, undefined);
  });

  it("financial permission redaction", () => {
    const redacted = toAdminPerformanceDto(
      { clickCount: 5, grossCommission: 10, netCommission: 8 },
      { includeFinancial: false },
    );
    assert.equal(redacted.grossCommission, null);
    assert.equal(redacted.financial.state, "REDACTED");
  });
});

describe("Admin listPerformance — empty DailyReport stays empty", () => {
  it("returns zero items and null KPIs when no DailyReport rows", async () => {
    const service = new AdminContractService({
      prisma: {
        dailyReport: {
          findMany: async () => [],
          count: async () => 0,
          aggregate: async () => ({
            _sum: {
              clickCount: null,
              conversionCount: null,
              approvedConversionCount: null,
              grossCommission: null,
            },
          }),
        },
      },
    });
    const out = await service.listPerformance({}, [PERMISSIONS.COMMISSION_READ]);
    assert.equal(out.total, 0);
    assert.equal(out.items.length, 0);
    assert.equal(out.kpis.linkClicks, null);
    assert.equal(out.kpis.grossOrders, null);
    assert.equal(out.kpis.grossCommission, null);
    assert.equal(out.migrationRequired, false);
  });

  it("scopes conversion projection by client|source|day", async () => {
    const day = new Date("2026-07-10T00:00:00.000Z");
    const service = new AdminContractService({
      prisma: {
        dailyReport: {
          findMany: async () => [
            {
              reportDate: day,
              clientId: "client-A",
              canonicalCampaignId: "cc1",
              campaignSourceId: "cs1",
              country: "US",
              currency: "USD",
              clickCount: 1,
              conversionCount: 1,
              approvedConversionCount: 1,
              grossCommission: 10,
              merchant: { displayName: "BrandA" },
              canonicalCampaign: { displayName: "CampA" },
              campaignSource: { id: "cs1", supplierCampaign: { supplier: "OPTIMISE" } },
            },
            {
              reportDate: day,
              clientId: "client-B",
              canonicalCampaignId: "cc1",
              campaignSourceId: "cs1",
              country: "US",
              currency: "USD",
              clickCount: 0,
              conversionCount: 1,
              approvedConversionCount: 1,
              grossCommission: 20,
              merchant: { displayName: "BrandA" },
              canonicalCampaign: { displayName: "CampA" },
              campaignSource: { id: "cs1", supplierCampaign: { supplier: "OPTIMISE" } },
            },
          ],
          count: async () => 2,
          aggregate: async () => ({
            _sum: {
              clickCount: 1,
              conversionCount: 2,
              approvedConversionCount: 2,
              grossCommission: 30,
            },
          }),
        },
        conversion: {
          findMany: async () => [
            {
              id: "cv-a",
              campaignSourceId: "cs1",
              conversionDate: new Date("2026-07-10T12:00:00.000Z"),
              status: "APPROVED",
              approvedCommission: 10,
              clickId: "clk",
              orderId: "ord-a",
              metadata: { couponCode: "AAA" },
              clientAssignment: { clientId: "client-A" },
            },
            {
              id: "cv-b",
              campaignSourceId: "cs1",
              conversionDate: new Date("2026-07-10T12:00:00.000Z"),
              status: "APPROVED",
              approvedCommission: 20,
              clickId: "clk2",
              orderId: "ord-b",
              metadata: { couponCode: "BBB" },
              clientAssignment: { clientId: "client-B" },
            },
          ],
        },
        order: {
          findMany: async ({ where }) =>
            (where.id.in || []).map((id) => ({
              id,
              orderValue: id === "ord-a" ? 100 : 200,
              validationStatus: "VALIDATION_APPROVED",
            })),
        },
        financialTransaction: { findMany: async () => [] },
      },
    });
    const out = await service.listPerformance({}, [PERMISSIONS.COMMISSION_READ]);
    assert.equal(out.items.length, 2);
    const a = out.items.find((i) => i.clientId === "client-A");
    const b = out.items.find((i) => i.clientId === "client-B");
    assert.equal(a.couponCode, "AAA");
    assert.equal(b.couponCode, "BBB");
    assert.equal(a.grossOrderValue, 100);
    assert.equal(b.grossOrderValue, 200);
  });
});
