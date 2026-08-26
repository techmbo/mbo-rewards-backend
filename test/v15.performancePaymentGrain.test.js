/**
 * v15 Phase 2 — Performance (04E) & Payment (05E) grain investigation tests.
 * No DailyReport migration; null when ambiguous; no invented customerType.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  toAdminPerformanceDto,
  toAdminPaymentStatusDto,
  CLIENT_FORBIDDEN_FINANCE_KEYS,
} from "../src/modules/ops/adminContract.dto.js";
import { mapCanonicalPaymentStatus } from "../src/modules/ops/v15FieldContract.js";
import {
  classifyConversionChannel,
  extractMetadataCouponCode,
  uniqueOrNull,
  summarizeConversionsForBucket,
  sumDistinctOrderValues,
  resolveNetSupplierCommission,
  paymentLinkClicksPolicy,
  isConfirmedConversionStatus,
  isCancelConversionStatus,
  toWorkbookChannelType,
} from "../src/modules/ops/v15PerformanceGrain.js";
import { AdminContractService } from "../src/modules/ops/adminContract.service.js";
import { PERMISSIONS } from "../src/auth/permissions.js";
import { toClientPaymentStatusDto } from "../src/modules/client/dto/clientReporting.dto.js";

describe("04E grain helpers — channel / coupon", () => {
  it("classifies LINK / COUPON / BOTH / UNKNOWN from attribution evidence", () => {
    assert.equal(
      classifyConversionChannel({ clickId: "c1", metadata: null }),
      "Link",
    );
    assert.equal(
      classifyConversionChannel({ trackingLinkId: "t1", metadata: { couponCode: "SAVE10" } }),
      "Link + Coupon",
    );
    assert.equal(
      classifyConversionChannel({ metadata: { couponCode: "SAVE10" } }),
      "Coupon",
    );
    assert.equal(classifyConversionChannel({}), "Unknown");
  });

  it("does not invent coupon from empty metadata", () => {
    assert.equal(extractMetadataCouponCode({}), null);
    assert.equal(extractMetadataCouponCode(null), null);
  });

  it("uniqueOrNull returns null when mixed (no arbitrary pick)", () => {
    assert.equal(uniqueOrNull(["A", "A"]), "A");
    assert.equal(uniqueOrNull(["A", "B"]), null);
    assert.equal(uniqueOrNull([null, "A", null]), "A");
  });

  it("bucket summary nulls ambiguous channel and coupon", () => {
    const summary = summarizeConversionsForBucket([
      { status: "APPROVED", clickId: "1", metadata: { couponCode: "A" }, approvedCommission: 10, orderId: "o1" },
      { status: "PENDING", trackingLinkId: null, metadata: { couponCode: "B" }, approvedCommission: null, orderId: "o2" },
    ]);
    assert.equal(summary.campaignType, null);
    assert.equal(summary.couponCode, null);
    assert.equal(summary.ambiguousCoupon, true);
    assert.equal(summary.cancelOrders, 0);
    assert.equal(summary.confirmedOrders, 1);
  });

  it("preserves BOTH when all conversions are Link + Coupon with same code", () => {
    const summary = summarizeConversionsForBucket([
      {
        status: "APPROVED",
        clickId: "1",
        metadata: { couponCode: "X" },
        approvedCommission: 5,
        orderId: "o1",
      },
      {
        status: "PAID",
        trackingLinkId: "t1",
        metadata: { couponCode: "X" },
        approvedCommission: 7,
        orderId: "o2",
      },
    ]);
    assert.equal(summary.campaignType, "Link + Coupon");
    assert.equal(summary.channelType, "LINK_AND_COUPON");
    assert.equal(summary.couponCode, "X");
    assert.equal(summary.netCommission, 12);
  });

  it("maps workbook channel types and nulls Unknown", () => {
    assert.equal(toWorkbookChannelType("Link"), "LINK");
    assert.equal(toWorkbookChannelType("Coupon"), "COUPON");
    assert.equal(toWorkbookChannelType("Link + Coupon"), "LINK_AND_COUPON");
    assert.equal(toWorkbookChannelType("Unknown"), null);
  });
});

describe("04E — order value distinct-order semantics", () => {
  it("does not double-count the same order via multiple conversions", () => {
    const orders = [
      { id: "o1", orderValue: 100, validationStatus: "VALIDATION_APPROVED" },
      { id: "o1", orderValue: 100, validationStatus: "VALIDATION_APPROVED" },
      { id: "o2", orderValue: 50, validationStatus: "VALIDATION_PENDING" },
    ];
    const { grossOrderValue, netOrderValue } = sumDistinctOrderValues(orders);
    assert.equal(grossOrderValue, 150);
    assert.equal(netOrderValue, 100);
  });

  it("returns null when no order values", () => {
    assert.deepEqual(sumDistinctOrderValues([]), {
      grossOrderValue: null,
      netOrderValue: null,
    });
  });
});

describe("04E — cancel / confirmed / customerType", () => {
  it("maps Conversion status machine only", () => {
    assert.equal(isConfirmedConversionStatus("APPROVED"), true);
    assert.equal(isConfirmedConversionStatus("PAID"), true);
    assert.equal(isConfirmedConversionStatus("PENDING"), false);
    assert.equal(isCancelConversionStatus("REJECTED"), true);
    assert.equal(isCancelConversionStatus("APPROVED"), false);
  });

  it("customerType remains null when unavailable", () => {
    const dto = toAdminPerformanceDto(
      { reportDate: "2026-08-01", clickCount: 1, customerType: null },
      { includeFinancial: true },
    );
    assert.equal(dto.customerType, null);
  });

  it("does not invent campaignType Link when channel unknown", () => {
    const dto = toAdminPerformanceDto(
      { reportDate: "2026-08-01", clickCount: 1, couponCode: null },
      { includeFinancial: false },
    );
    assert.equal(dto.campaignType, null);
  });
});

describe("04E — gross/net commission semantics", () => {
  it("prefers FT.supplierReceivable over conversion approved sum", () => {
    const resolved = resolveNetSupplierCommission({
      ftRows: [
        { supplierReceivable: 40, transactionType: "COMMISSION_EARNED" },
        { supplierReceivable: 10, transactionType: "REVERSAL" },
      ],
      conversionApprovedSum: 99,
    });
    assert.equal(resolved.netCommission, 30);
    assert.equal(resolved.source, "financial_transaction.supplierReceivable");
  });

  it("falls back to approvedCommission then null", () => {
    assert.equal(
      resolveNetSupplierCommission({ ftRows: [], conversionApprovedSum: 12 }).netCommission,
      12,
    );
    assert.equal(resolveNetSupplierCommission({ ftRows: [] }).netCommission, null);
  });

  it("DTO does not treat clientPayable as netCommission and omits mboMargin", () => {
    const dto = toAdminPerformanceDto(
      {
        reportDate: "2026-08-01",
        grossCommission: 100,
        netCommission: 80,
        clientCommission: 70,
        mboCommission: 30,
      },
      { includeFinancial: true },
    );
    assert.equal(dto.netCommission, 80);
    assert.equal(dto.financial.grossCommission, 100);
    assert.equal(dto.financial.netCommission, 80);
    assert.equal(dto.financial.mboMargin, undefined);
    assert.equal(dto.financial.clientPayable, undefined);
    assert.notEqual(dto.netCommission, 70);
  });

  it("does not coerce missing clicks/orders to 0", () => {
    const dto = toAdminPerformanceDto(
      { reportDate: "2026-08-01", clickCount: null, conversionCount: null },
      { includeFinancial: false },
    );
    assert.equal(dto.linkClicks, null);
    assert.equal(dto.grossOrders, null);
    assert.equal(dto.financial.state, "REDACTED");
  });

  it("maps unanimous channel to workbook channelType", () => {
    const dto = toAdminPerformanceDto(
      {
        reportDate: "2026-08-01",
        clickCount: 1,
        channelType: "LINK",
        campaignType: "Link",
      },
      { includeFinancial: false },
    );
    assert.equal(dto.channelType, "LINK");
    assert.equal(dto.operational.channelType, "LINK");
    assert.equal(dto.customerType, null);
    assert.equal(dto.operational.customerType, null);
  });

  it("keeps brand and campaignSourceId honest when missing", () => {
    const dto = toAdminPerformanceDto(
      { reportDate: "2026-08-01", brandName: null, campaignSourceId: null, clickCount: 0 },
      { includeFinancial: false },
    );
    assert.equal(dto.brandName, null);
    assert.equal(dto.campaignSourceId, null);
    assert.equal(dto.linkClicks, 0);
  });
});

describe("04E — confirmation dates stay null on aggregate DTO unless provided", () => {
  it("null when not supplied (no createdAt invent)", () => {
    const dto = toAdminPerformanceDto({ reportDate: "2026-08-01" }, { includeFinancial: false });
    assert.equal(dto.orderDate, null);
    assert.equal(dto.orderConfirmDate, null);
    assert.equal(dto.orderPaymentConfirmDate, null);
  });
});

describe("05E — payment grain + statuses", () => {
  it("maps workbook payment vocabulary from Order states", () => {
    assert.equal(
      mapCanonicalPaymentStatus({
        validationStatus: "VALIDATION_REJECTED",
        supplierPaymentStatus: "PAYMENT_PENDING",
      }),
      "REJECTED",
    );
    assert.equal(
      mapCanonicalPaymentStatus({ supplierPaymentStatus: "PAYMENT_RECEIVED" }),
      "PAID",
    );
    assert.equal(
      mapCanonicalPaymentStatus({ supplierPaymentStatus: "PAYMENT_PAYABLE" }),
      "PAYABLE",
    );
    assert.equal(
      mapCanonicalPaymentStatus({ supplierPaymentStatus: "PAYMENT_INVOICED" }),
      "ADVERTISER_INVOICED",
    );
    assert.equal(
      mapCanonicalPaymentStatus({ supplierPaymentStatus: "PAYMENT_AWAITING_INVOICE" }),
      "APPROVED",
    );
    assert.equal(
      mapCanonicalPaymentStatus({ supplierPaymentStatus: "PAYMENT_PENDING" }),
      "PENDING",
    );
    assert.equal(
      mapCanonicalPaymentStatus({ supplierPaymentStatus: "PAYMENT_ON_HOLD" }),
      "NOT_PAYABLE",
    );
    assert.equal(mapCanonicalPaymentStatus({}), "UNKNOWN");
  });

  it("admin payableCommission is supplier-side; client DTO stays separate", () => {
    const admin = toAdminPaymentStatusDto({
      billingMonth: 8,
      billingYear: 2026,
      brandName: "Brand",
      campaignSourceId: "src1",
      campaignType: "CPS",
      currency: "USD",
      paymentStatus: "PAYABLE",
      payableOrders: 2,
      payableCommission: 55,
      linkClicks: null,
      date: "2026-08-01",
    });
    assert.equal(admin.payableCommission, 55);
    assert.match(admin.payableCommissionSource, /supplier/i);

    const client = toClientPaymentStatusDto({
      billingMonth: 8,
      billingYear: 2026,
      currency: "USD",
      payableCommission: 40,
      paymentStatus: "PAYABLE",
    });
    assert.equal(client.payableCommission, 40);
    for (const key of CLIENT_FORBIDDEN_FINANCE_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(client, key), false);
    }
  });

  it("blocks click fan-out onto payment rows", () => {
    const policy = paymentLinkClicksPolicy();
    assert.equal(policy.linkClicks, null);
    assert.ok(policy.reason.includes("fan-out"));
  });
});

describe("04E/05E — AdminContractService projection flags + finance gate", () => {
  it("listPerformance redacts finance without permission and never invents customerType", async () => {
    const reportDate = new Date("2026-08-01T00:00:00.000Z");
    const fakeDb = {
      dailyReport: {
        findMany: async () => [
          {
            reportDate,
            clientId: "cli1",
            canonicalCampaignId: "can1",
            campaignSourceId: "src1",
            country: "AE",
            currency: "USD",
            clickCount: 3,
            conversionCount: 2,
            approvedConversionCount: 1,
            grossCommission: 20,
            clientCommission: 14,
            mboCommission: 6,
            merchant: { displayName: "BrandX" },
            canonicalCampaign: { displayName: "Campaign X" },
            campaignSource: {
              id: "src1",
              supplierCampaign: { supplier: "OPTIMISE", campaignName: "Campaign X" },
            },
          },
        ],
        count: async () => 1,
        aggregate: async () => ({
          _sum: {
            clickCount: 3,
            conversionCount: 2,
            approvedConversionCount: 1,
            grossCommission: 20,
          },
        }),
      },
      conversion: {
        findMany: async () => [
          {
            id: "cv1",
            campaignSourceId: "src1",
            conversionDate: reportDate,
            status: "APPROVED",
            approvedCommission: 15,
            clickId: "ck1",
            trackingLinkId: null,
            orderId: "ord1",
            metadata: { couponCode: "SAVE" },
            clientAssignment: { clientId: "cli1" },
          },
          {
            id: "cv2",
            campaignSourceId: "src1",
            conversionDate: reportDate,
            status: "REJECTED",
            approvedCommission: null,
            clickId: "ck2",
            orderId: "ord1",
            metadata: { couponCode: "SAVE" },
            clientAssignment: { clientId: "cli1" },
          },
        ],
      },
      order: {
        findMany: async () => [
          { id: "ord1", orderValue: 200, validationStatus: "VALIDATION_APPROVED" },
        ],
      },
      financialTransaction: {
        findMany: async () => [
          {
            conversionId: "cv1",
            supplierReceivable: 15,
            transactionType: "COMMISSION_EARNED",
          },
        ],
      },
    };

    const svc = new AdminContractService({ prisma: fakeDb });
    const redacted = await svc.listPerformance({}, []);
    assert.equal(redacted.items[0].grossCommission, null);
    assert.equal(redacted.items[0].customerType, null);
    assert.equal(redacted.items[0].financial.state, "REDACTED");
    assert.equal(redacted.migrationRequired, false);
    assert.equal(redacted.kpis.linkClicks, 3);
    assert.equal(redacted.kpis.grossCommission, null);

    const financed = await svc.listPerformance({}, [PERMISSIONS.FINANCE_OPS_READ]);
    assert.equal(financed.items[0].brandName, "BrandX");
    assert.equal(financed.items[0].campaignName, "Campaign X");
    assert.equal(financed.items[0].networkSource, "OPTIMISE");
    assert.equal(financed.items[0].campaignSourceId, "src1");
    assert.equal(financed.items[0].country, "AE");
    assert.equal(financed.items[0].currency, "USD");
    assert.equal(financed.items[0].date, "2026-08-01");
    assert.equal(financed.items[0].channelType, "LINK_AND_COUPON");
    assert.equal(financed.items[0].campaignType, "LINK_AND_COUPON");
    assert.equal(financed.items[0].couponCode, "SAVE");
    assert.equal(financed.items[0].grossOrderValue, 200);
    assert.equal(financed.items[0].netOrderValue, 200);
    assert.equal(financed.items[0].cancelOrders, 1);
    assert.equal(financed.items[0].confirmedOrders, 1);
    assert.equal(financed.items[0].netCommission, 15);
    assert.equal(financed.items[0].customerType, null);
    assert.equal(financed.items[0].financial.mboMargin, undefined);
    assert.equal(financed.kpis.grossCommission, 20);
    assert.ok(financed.items[0].operational);
    assert.equal(financed.items[0].operational.brandName, "BrandX");
  });

  it("listPaymentStatus keeps linkClicks null and uses supplierReceivable", async () => {
    const svc = new AdminContractService({
      prisma: {
        order: {
          findMany: async () => [
            {
              orderDate: new Date("2026-08-10T12:00:00.000Z"),
              receivedAt: new Date("2026-08-10T12:00:00.000Z"),
              currency: "USD",
              campaignSourceId: "src1",
              merchant: { displayName: "BrandY" },
              campaignSource: {
                supplierCampaign: { campaignType: "CPS", pricingModel: null },
              },
              validationStatus: "VALIDATION_APPROVED",
              supplierPaymentStatus: "PAYMENT_PAYABLE",
              clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
              validationChangedAt: new Date("2026-08-11T00:00:00.000Z"),
              supplierPaymentChangedAt: null,
              financialTransactions: [
                { supplierReceivable: 25, transactionType: "COMMISSION_EARNED" },
              ],
            },
          ],
        },
      },
    });

    const res = await svc.listPaymentStatus({ billingMonth: 8, billingYear: 2026 });
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].linkClicks, null);
    assert.equal(res.items[0].payableCommission, 25);
    assert.equal(res.items[0].paymentStatus, "PAYABLE");
    assert.equal(res.items[0].brandName, "BrandY");
    assert.equal(res.items[0].campaignSourceId, "src1");
    assert.equal(res.migrationRequired, false);
    assert.ok(res.unavailableFields.includes("linkClicks"));
  });
});
