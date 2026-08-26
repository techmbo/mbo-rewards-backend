import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { AggregationService } from "../src/modules/reporting/services/aggregation.service.js";

describe("AggregationService", () => {
  it("aggregates clicks and conversions into daily report buckets", async () => {
    const reportDate = new Date("2026-07-10T00:00:00.000Z");
    const clickRepo = {
      findMany: mock.fn(async () => ({
        rows: [
          {
            id: "clk1",
            clientAssignmentId: "a1",
            campaignSourceId: "cs1",
            country: "US",
            clickedAt: new Date("2026-07-10T12:00:00.000Z"),
          },
        ],
        total: 1,
      })),
    };
    const conversionRepo = {
      findForAggregation: mock.fn(async () => [
        {
          id: "cv1",
          campaignSourceId: "cs1",
          status: "APPROVED",
          supplierCommission: "10.0000",
          approvedCommission: "10.0000",
          clientCommission: "7.0000",
          mboCommission: "3.0000",
          currency: "USD",
          conversionDate: new Date("2026-07-10T15:00:00.000Z"),
          metadata: { country: "US" },
          clientAssignment: {
            clientId: "client1",
            canonicalCampaignId: "cc1",
            canonicalCampaign: { merchantId: "m1" },
          },
        },
      ]),
    };
    const dailyReportRepo = {
      upsertDimension: mock.fn(async (row) => row),
    };

    const tx = {
      clientCampaignAssignment: {
        findUnique: mock.fn(async () => ({
          clientId: "client1",
          canonicalCampaignId: "cc1",
          canonicalCampaign: { merchantId: "m1" },
        })),
      },
    };

    const service = new AggregationService({ clickRepo, conversionRepo, dailyReportRepo });
    const result = await service.aggregateRange(
      {
        from: reportDate,
        to: new Date("2026-07-10T23:59:59.999Z"),
      },
      tx,
    );

    assert.equal(result.rowsUpserted, 1);
    assert.equal(dailyReportRepo.upsertDimension.mock.calls.length, 1);
    const row = dailyReportRepo.upsertDimension.mock.calls[0].arguments[0];
    assert.equal(row.clickCount, 1);
    assert.equal(row.conversionCount, 1);
    assert.equal(row.approvedConversionCount, 1);
    assert.equal(row.grossCommission, "10.0000");
  });
});
