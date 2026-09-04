/**
 * P1.7 Wave 7 — Client portal payments / finance contract (05E client-safe).
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  toClientPaymentStatusDto,
  FORBIDDEN_CLIENT_PAYMENT_KEYS,
} from "../src/modules/client/dto/clientReporting.dto.js";
import { ClientReportingService } from "../src/modules/client/services/clientReporting.service.js";
import { CLIENT_API, assertBackendRegisters } from "./helpers/clientApiRoutes.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("P1.7 Wave 7 — API path + DTO", () => {
  it("CLIENT_API.payments is /v1/client/payments", () => {
    assert.equal(CLIENT_API.payments, "/v1/client/payments");
    assert.equal(assertBackendRegisters(CLIENT_API.payments), true);
  });

  it("client DTO exposes commercial model, null linkClicks, no supplier finance", () => {
    const dto = toClientPaymentStatusDto({
      billingMonth: 8,
      billingYear: 2026,
      brandName: "Ubuy",
      campaignName: "Offer",
      commercialModel: "CPS",
      currency: "USD",
      paymentStatus: "Payable",
      payableOrders: 2,
      payableCommission: 40,
    });
    assert.equal(dto.commercialModel, "CPS");
    assert.equal(dto.linkClicks, null);
    assert.equal(dto.payableCommission, 40);
    const blob = JSON.stringify(dto);
    for (const key of FORBIDDEN_CLIENT_PAYMENT_KEYS) {
      assert.equal(blob.includes(key), false, key);
    }
  });

  it("null payableCommission stays null — not forced to 0", () => {
    const dto = toClientPaymentStatusDto({
      billingMonth: 1,
      billingYear: 2026,
      payableCommission: null,
      paymentStatus: "Pending",
    });
    assert.equal(dto.payableCommission, null);
  });

  it("currency null stays null", () => {
    const dto = toClientPaymentStatusDto({
      billingMonth: 1,
      billingYear: 2026,
      currency: null,
      payableCommission: 0,
    });
    assert.equal(dto.currency, null);
    assert.equal(dto.payableCommission, 0);
  });

  it("does not treat LINK as commercial model label in DTO campaignType alias when commercial set", () => {
    const dto = toClientPaymentStatusDto({
      billingMonth: 1,
      billingYear: 2026,
      commercialModel: "CPA",
    });
    assert.equal(dto.campaignType, "CPA");
  });
});

describe("P1.7 Wave 7 — listPaymentStatus grain + isolation", () => {
  it("empty store → dataAvailable false and null KPIs", async () => {
    const svc = new ClientReportingService({
      partnerCampaigns: {
        assertPartnerClient: mock.fn(async () => ({
          id: "c1",
          name: "A",
          slug: "a",
          status: "ACTIVE",
          currency: null,
        })),
      },
      prisma: {
        order: { findMany: mock.fn(async () => []) },
        financialTransaction: { findMany: mock.fn(async () => []) },
      },
    });
    const out = await svc.listPaymentStatus("c1");
    assert.equal(out.dataAvailable, false);
    assert.equal(out.kpis.payableCommissionTotal, null);
    assert.equal(out.kpis.currency, null);
    assert.equal(out.contract, "v15-05E-client-payments");
    const dataBlob = JSON.stringify({ items: out.items, kpis: out.kpis });
    for (const key of ["supplierReceivable", "mboMargin", "mboCommission", "rawPayload"]) {
      assert.equal(dataBlob.includes(key), false, key);
    }
  });

  it("forces tenant clientId and 05E dimensions on buckets", async () => {
    let orderWhere = null;
    const svc = new ClientReportingService({
      partnerCampaigns: {
        assertPartnerClient: mock.fn(async (id) => {
          assert.equal(id, "client-a");
          return { id: "client-a", name: "A", slug: "a", status: "ACTIVE", currency: "INR" };
        }),
      },
      prisma: {
        order: {
          findMany: mock.fn(async ({ where }) => {
            orderWhere = where;
            return [
              {
                id: "o1",
                clientId: "client-a",
                currency: "INR",
                orderDate: new Date("2026-08-10"),
                validationStatus: "VALIDATION_APPROVED",
                clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE",
                campaignSourceId: "src-1",
                merchant: { displayName: "BrandA" },
                canonicalCampaign: { displayName: "CampA" },
                campaignSource: {
                  supplierCampaign: { campaignType: "CPS", pricingModel: "CPS", supplier: "OPTIMISE" },
                },
                financialTransactions: [
                  { clientPayable: "25", reportingClientPayable: null, reportingCurrency: null },
                ],
                conversions: [],
              },
            ];
          }),
        },
        financialTransaction: { findMany: mock.fn(async () => []) },
      },
    });
    const out = await svc.listPaymentStatus("client-a", {
      billing_month: 8,
      billing_year: 2026,
      clientId: "client-b",
    });
    assert.equal(orderWhere.clientId, "client-a");
    assert.equal(out.payments.length, 1);
    assert.equal(out.payments[0].brandName, "BrandA");
    assert.equal(out.payments[0].commercialModel, "CPS");
    assert.equal(out.payments[0].paymentStatus, "Payable");
    assert.equal(out.payments[0].payableCommission, 25);
    assert.equal(out.payments[0].linkClicks, null);
    assert.equal(out.kpis.payableCommissionTotal, 25);
    assert.equal(out.dataAvailable, true);
  });
});

describe("P1.7 Wave 7 — HTTP auth", () => {
  let server;
  it("boot", async () => {
    server = await startTestServer();
  });

  it("missing credentials → 401 on client payments", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/v1/client/payments" });
    assert.equal(status, 401);
  });

  it("portal payment-status alias → 401", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/portal/v1/payment-status" });
    assert.equal(status, 401);
  });

  it("admin payment-status not open to anonymous client (401/403)", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/ops/admin/payment-status" });
    assert.ok(status === 401 || status === 403);
  });

  it("teardown", async () => {
    await server.close();
  });
});
