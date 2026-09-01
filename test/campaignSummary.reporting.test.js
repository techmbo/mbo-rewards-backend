import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toAggregatedReportDto } from "../src/modules/reporting/dto/reporting.dto.js";
import { ReportingQueryService } from "../src/modules/reporting/services/query/reportingQuery.service.js";
import { PERMISSIONS } from "../src/auth/permissions.js";

describe("Campaign Summary DTO honesty", () => {
  it("does not coerce missing clicks/conversions/commission to 0", () => {
    const dto = toAggregatedReportDto({
      dimensionKey: "campaign",
      dimensionId: "c1",
      totals: {
        clickCount: null,
        conversionCount: null,
        grossCommission: null,
        clientCommission: null,
        mboCommission: null,
      },
      meta: { campaignName: "Nike Run", brandName: "Nike" },
    });
    assert.equal(dto.clickCount, null);
    assert.equal(dto.conversionCount, null);
    assert.equal(dto.grossCommission, null);
    assert.equal(dto.clientCommission, null);
    assert.equal(dto.mboCommission, null);
    assert.equal(dto.conversionRate, null);
    assert.equal(dto.epc, null);
    assert.equal(dto.campaignName, "Nike Run");
  });

  it("computes CVR and EPC only when clicks > 0 and inputs exist", () => {
    const dto = toAggregatedReportDto({
      dimensionKey: "campaign",
      dimensionId: "c1",
      totals: {
        clickCount: 100,
        conversionCount: 5,
        grossCommission: "50",
      },
    });
    assert.equal(dto.conversionRate, 0.05);
    assert.equal(dto.epc, 0.5);
  });

  it("returns null CVR/EPC when clicks are 0 (no NaN/Infinity/fake 0%)", () => {
    const dto = toAggregatedReportDto({
      dimensionKey: "campaign",
      dimensionId: "c1",
      totals: {
        clickCount: 0,
        conversionCount: 0,
        grossCommission: "0",
      },
    });
    assert.equal(dto.clickCount, 0);
    assert.equal(dto.conversionCount, 0);
    assert.equal(dto.conversionRate, null);
    assert.equal(dto.epc, null);
  });

  it("never derives EPC from client commission", () => {
    const dto = toAggregatedReportDto({
      dimensionKey: "campaign",
      dimensionId: "c1",
      totals: {
        clickCount: 10,
        conversionCount: 1,
        grossCommission: null,
        clientCommission: "99",
      },
    });
    assert.equal(dto.epc, null);
  });
});

describe("Campaign Summary query service (NPF aggregation)", () => {
  it("maps aggregated fact rows into paged campaign DTOs with date aliases", async () => {
    const service = new ReportingQueryService({
      aggregateCampaignSummary: async (filters) => {
        assert.ok(filters.from instanceof Date);
        assert.ok(filters.to instanceof Date);
        return {
          total: 1,
          rows: [
            {
              dimensionId: "canon-1",
              campaignSourceId: "cs-1",
              canonicalCampaignId: "canon-1",
              campaignName: "Summer Sale",
              brandName: "Acme",
              supplier: "TRACKIER",
              currency: "USD",
              clickCount: 4,
              networkClickCount: 40,
              conversionCount: 2,
              approvedConversionCount: 1,
              grossCommission: 10,
              confirmedCommission: 8,
              clientCommission: "5.6000",
              mboCommission: "2.4000",
              epc: 2.5,
            },
          ],
        };
      },
    });

    const result = await service.listCampaignReports(
      {
        page: 1,
        pageSize: 25,
        fromDate: "2026-08-01",
        toDate: "2026-08-15",
      },
      [PERMISSIONS.PERFORMANCE_READ, PERMISSIONS.COMMISSION_READ],
    );

    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].campaignName, "Summer Sale");
    assert.equal(result.data[0].clickCount, 4);
    assert.equal(result.data[0].networkClickCount, 40);
    assert.equal(result.data[0].conversionCount, 2);
    assert.equal(result.data[0].grossCommission, "10");
    assert.equal(result.data[0].clientCommission, "5.6000");
    assert.equal(result.data[0].mboCommission, "2.4000");
    // network clicks must remain independent (not copied into clickCount)
    assert.notEqual(result.data[0].clickCount, result.data[0].networkClickCount);
  });

  it("redacts commission when permission missing", async () => {
    const service = new ReportingQueryService({
      aggregateCampaignSummary: async () => ({
        total: 1,
        rows: [
          {
            dimensionId: "c1",
            campaignName: "X",
            clickCount: 3,
            conversionCount: 1,
            grossCommission: 9,
            clientCommission: "6",
            mboCommission: "3",
            epc: 3,
          },
        ],
      }),
    });
    const result = await service.listCampaignReports({ page: 1, pageSize: 10 }, [
      PERMISSIONS.PERFORMANCE_READ,
    ]);
    assert.equal(result.data[0].clickCount, 3);
    assert.equal(result.data[0].grossCommission, undefined);
    assert.equal(result.data[0].epc, undefined);
  });
});
