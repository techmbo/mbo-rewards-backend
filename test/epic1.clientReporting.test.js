import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  mapClientFacingOrderStatus,
  mapClientFacingPaymentStatus,
  toClientOrderDto,
  toClientPaymentStatusDto,
  FORBIDDEN_CLIENT_ORDER_KEYS,
} from "../src/modules/client/dto/clientReporting.dto.js";
import { ClientReportingService } from "../src/modules/client/services/clientReporting.service.js";

describe("Epic 1 — client order status mapping", () => {
  it("maps validation/payment states to v15 vocabulary", () => {
    assert.equal(
      mapClientFacingOrderStatus({ validationStatus: "VALIDATION_REJECTED", clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY" }),
      "Rejected",
    );
    assert.equal(
      mapClientFacingOrderStatus({ validationStatus: "VALIDATION_APPROVED", clientPaymentStatus: "CLIENT_PAYMENT_PAID" }),
      "Paid",
    );
    assert.equal(
      mapClientFacingOrderStatus({ validationStatus: "VALIDATION_APPROVED", clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE" }),
      "Payable",
    );
    assert.equal(
      mapClientFacingOrderStatus({ validationStatus: "VALIDATION_APPROVED", clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY" }),
      "Confirmed",
    );
    assert.equal(
      mapClientFacingOrderStatus({ validationStatus: "VALIDATION_PENDING", clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY" }),
      "Pending",
    );
    assert.equal(
      mapClientFacingOrderStatus({ validationStatus: "VALIDATION_NEEDS_REVIEW", clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY" }),
      "On Hold",
    );
  });

  it("maps payment_status separately", () => {
    assert.equal(
      mapClientFacingPaymentStatus({ validationStatus: "VALIDATION_APPROVED", clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE" }),
      "Payable",
    );
  });
});

describe("Epic 1 — client order DTO safety", () => {
  it("exposes client-safe fields and omits supplier internals", () => {
    const order = {
      id: "ord-1",
      currency: "USD",
      orderValue: "100.5",
      orderDate: new Date("2026-08-01"),
      validationStatus: "VALIDATION_APPROVED",
      clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE",
      validationChangedAt: new Date("2026-08-02"),
      clientPaymentChangedAt: null,
      merchant: { displayName: "Ubuy" },
      canonicalCampaignId: "cc1",
      canonicalCampaign: { displayName: "Ubuy UAE", merchant: { displayName: "Ubuy" } },
      items: [{ lineKey: "1", sku: "SKU1", quantity: 1, unitPrice: "10", itemValue: "10", currency: "USD" }],
      supplier: "OPTIMISE",
      supplierOrderId: "SUP-SECRET",
      lastApprovedMboCommission: "30",
      lastApprovedSupplierCommission: "100",
    };
    const dto = toClientOrderDto(order, {
      clientCommission: 70,
      commissionSource: "financial_transaction",
    });
    assert.equal(dto.orderId, "ord-1");
    assert.equal(dto.brandName, "Ubuy");
    assert.equal(dto.orderStatus, "Payable");
    assert.equal(dto.clientCommission, 70);
    assert.equal(dto.commissionSource, "financial_transaction");
    for (const key of FORBIDDEN_CLIENT_ORDER_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(dto, key), false, `must not expose ${key}`);
    }
    assert.equal(dto.supplier, undefined);
    assert.equal(dto.mboMargin, undefined);
  });
});

describe("Epic 1 — payment status DTO", () => {
  it("includes billing month/year payable fields", () => {
    const dto = toClientPaymentStatusDto({
      billingMonth: 8,
      billingYear: 2026,
      payableOrders: 3,
      payableCommission: 120.5,
      paymentStatus: "Payable",
      currency: "INR",
      paymentConfirmedDate: null,
      commissionSource: "financial_transaction",
    });
    assert.equal(dto.billingMonth, 8);
    assert.equal(dto.billingYear, 2026);
    assert.equal(dto.payableOrders, 3);
    assert.equal(dto.payableCommission, 120.5);
    assert.equal(dto.paymentStatus, "Payable");
    assert.equal(dto.currency, "INR");
  });
});

describe("Epic 1 — ClientReportingService FT preference + isolation", () => {
  it("prefers FinancialTransaction clientPayable over snapshots", () => {
    const svc = new ClientReportingService({
      prisma: {},
      partnerCampaigns: { assertPartnerClient: async () => ({ id: "c1", currency: "USD" }) },
    });
    const commission = svc.resolveOrderCommission({
      currency: "USD",
      lastApprovedClientCommission: "50",
      financialTransactions: [{ clientPayable: "70", reportingClientPayable: null, reportingCurrency: null }],
      conversions: [{ clientCommission: "50" }],
    });
    assert.equal(commission.clientCommission, 70);
    assert.equal(commission.commissionSource, "financial_transaction");
  });

  it("falls back to order snapshot when no FT", () => {
    const svc = new ClientReportingService({
      prisma: {},
      partnerCampaigns: { assertPartnerClient: async () => ({ id: "c1" }) },
    });
    const commission = svc.resolveOrderCommission({
      lastApprovedClientCommission: "40",
      financialTransactions: [],
      conversions: [],
    });
    assert.equal(commission.clientCommission, 40);
    assert.equal(commission.commissionSource, "order_snapshot");
  });

  it("scopes listOrders to authenticated clientId only", async () => {
    const findMany = mock.fn(async ({ where }) => {
      assert.equal(where.clientId, "client-a");
      assert.equal(where.clientId === "client-b", false);
      return [];
    });
    const count = mock.fn(async () => 0);
    const svc = new ClientReportingService({
      prisma: { order: { findMany, count } },
      partnerCampaigns: {
        assertPartnerClient: async (id) => {
          assert.equal(id, "client-a");
          return { id: "client-a", name: "A", slug: "a", currency: "USD", status: "ACTIVE" };
        },
      },
    });
    const out = await svc.listOrders("client-a", {});
    assert.ok(Array.isArray(out.orders));
    assert.equal(findMany.mock.calls.length, 1);
  });

  it("payment status report does not mix withdrawals semantics", async () => {
    const svc = new ClientReportingService({
      prisma: {
        order: {
          findMany: mock.fn(async () => [
            {
              id: "o1",
              clientId: "client-a",
              currency: "INR",
              orderDate: new Date("2026-08-10"),
              validationStatus: "VALIDATION_APPROVED",
              clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE",
              financialTransactions: [{ clientPayable: "25", reportingClientPayable: null, reportingCurrency: null }],
              conversions: [],
            },
          ]),
        },
        financialTransaction: { findMany: mock.fn(async () => []) },
        clientWithdrawal: { findMany: mock.fn(async () => { throw new Error("must not query withdrawals"); }) },
      },
      partnerCampaigns: {
        assertPartnerClient: async () => ({ id: "client-a", currency: "INR", name: "A", slug: "a", status: "ACTIVE" }),
      },
    });
    const out = await svc.listPaymentStatus("client-a", { billing_month: 8, billing_year: 2026 });
    assert.equal(out.reportType, "payment_status");
    assert.ok(out.note.toLowerCase().includes("withdrawal"));
    assert.equal(out.payments.length, 1);
    assert.equal(out.payments[0].billingMonth, 8);
    assert.equal(out.payments[0].payableOrders, 1);
    assert.equal(out.payments[0].payableCommission, 25);
    assert.equal(out.payments[0].commissionSource, "financial_transaction");
  });
});
