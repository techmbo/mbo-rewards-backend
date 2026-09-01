/**
 * Epic 8 — Client reporting contract parity (orders, payments status, performance,
 * campaigns, products, tenant isolation, finance mode, forbidden fields).
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  toClientOrderDto,
  toClientPaymentStatusDto,
  FORBIDDEN_CLIENT_ORDER_KEYS,
  FORBIDDEN_CLIENT_PERFORMANCE_KEYS,
  mapClientFacingOrderStatus,
} from "../src/modules/client/dto/clientReporting.dto.js";
import { toPartnerCampaignDto } from "../src/modules/client/dto/partnerCampaign.dto.js";
import { toClientProductDto, FORBIDDEN_CLIENT_PRODUCT_KEYS } from "../src/modules/product/productFeed.service.js";
import { ClientReportingService } from "../src/modules/client/services/clientReporting.service.js";
import {
  FinanceConsumerService,
  FINANCE_CONSUMER_MODES,
} from "../src/modules/finance/financeConsumer.service.js";
import { resolveRuleKind } from "../src/modules/commercial/commercialRuleEngine.js";
import {
  clientListOrdersHandler,
  clientListPaymentsHandler,
  clientPerformanceAliasHandler,
  clientListCampaignsAliasHandler,
} from "../src/controllers/clientReporting.controller.js";
import { clientListProductsHandler } from "../src/controllers/clientProducts.controller.js";

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("Epic 8 — routes exist (handlers)", () => {
  it("orders/payments/performance/campaigns/products handlers are functions", () => {
    assert.equal(typeof clientListOrdersHandler, "function");
    assert.equal(typeof clientListPaymentsHandler, "function");
    assert.equal(typeof clientPerformanceAliasHandler, "function");
    assert.equal(typeof clientListCampaignsAliasHandler, "function");
    assert.equal(typeof clientListProductsHandler, "function");
  });
});

describe("Epic 8 — tenant isolation on clientId mismatch", () => {
  it("rejects mismatched query clientId on orders", async () => {
    const req = { partnerClientId: "client-a", query: { clientId: "client-b" } };
    const res = mockRes();
    await clientListOrdersHandler(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  it("rejects mismatched query clientId on payments", async () => {
    const req = { partnerClientId: "client-a", query: { client_id: "client-b" } };
    const res = mockRes();
    await clientListPaymentsHandler(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  it("rejects mismatched query clientId on products", async () => {
    const req = { partnerClientId: "client-a", query: { clientId: "other" } };
    const res = mockRes();
    await clientListProductsHandler(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });
});

describe("Epic 8 — forbidden field stripping", () => {
  it("order DTO omits supplier/finance internals", () => {
    const dto = toClientOrderDto(
      {
        id: "o1",
        currency: "USD",
        orderValue: "10",
        validationStatus: "VALIDATION_APPROVED",
        clientPaymentStatus: "CLIENT_PAYMENT_PAYABLE",
        merchant: { displayName: "Brand" },
        items: [],
        supplier: "X",
        mboMargin: 1,
        supplierReceivable: 2,
        supplierCommission: 3,
        grossCommission: 4,
      },
      { clientCommission: 7, commissionSource: "financial_transaction" },
    );
    for (const key of FORBIDDEN_CLIENT_ORDER_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(dto, key), false, key);
    }
    assert.equal(dto.clientCommission, 7);
  });

  it("performance forbidden list includes supplier receivable and margin", () => {
    assert.ok(FORBIDDEN_CLIENT_PERFORMANCE_KEYS.includes("supplierReceivable"));
    assert.ok(FORBIDDEN_CLIENT_PERFORMANCE_KEYS.includes("mboMargin"));
    assert.ok(FORBIDDEN_CLIENT_PERFORMANCE_KEYS.includes("grossCommission"));
  });

  it("product DTO omits supplier tracking URL", () => {
    const dto = toClientProductDto({
      status: "ACTIVE",
      product: {
        id: "p1",
        title: "Shoe",
        price: 10,
        currency: "USD",
        availability: "IN_STOCK",
        merchant: { displayName: "Nike" },
      },
      productTrackingLinks: [{ mboProductTrackingUrl: "https://mbo.example/t/1" }],
      supplierProductTrackingUrl: "https://supplier.secret/x",
    });
    for (const key of FORBIDDEN_CLIENT_PRODUCT_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(dto, key), false, key);
    }
    assert.equal(dto.mboProductTrackingUrl, "https://mbo.example/t/1");
  });
});

describe("Epic 8 — campaign display vs payout", () => {
  it("marks commission as display-only estimate", () => {
    const dto = toPartnerCampaignDto({
      assignmentId: "a1",
      assignmentStatus: "ACTIVE",
      published: true,
      campaign: {
        id: "cc1",
        displayName: "Camp",
        brand: "Brand",
        category: "Retail",
        countries: ["AE"],
        defaultCurrency: "USD",
        status: "PUBLISHED",
        validity: {},
      },
      commercial: {
        clientSharePercent: 70,
        commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
        currency: "USD",
      },
      tracking: { mboTrackingUrl: "https://mbo/t", status: "ACTIVE" },
    });
    assert.equal(dto.commission.isDisplayOnly, true);
    assert.ok(dto.commission.commissionDisplayEstimate.includes("display estimate"));
    assert.equal(dto.commission.mboMargin, undefined);
    assert.equal(dto.commission.supplierCommission, undefined);
  });
});

describe("Epic 8 — FINANCE vs LEGACY commission resolution", () => {
  it("FINANCE prefers FT and does not fabricate when FT missing", () => {
    const finance = new FinanceConsumerService({ mode: FINANCE_CONSUMER_MODES.FINANCE, prisma: {} });
    const svc = new ClientReportingService({
      prisma: {},
      partnerCampaigns: { assertPartnerClient: async () => ({ id: "c1" }) },
      financeConsumer: finance,
    });
    const withFt = svc.resolveOrderCommission({
      currency: "USD",
      financialTransactions: [{ clientPayable: 55, reportingClientPayable: null }],
      conversions: [{ clientCommission: 99 }],
      lastApprovedClientCommission: "88",
    });
    assert.equal(withFt.clientCommission, 55);
    assert.equal(withFt.commissionSource, "financial_transaction");

    const noFt = svc.resolveOrderCommission({
      currency: "USD",
      financialTransactions: [],
      conversions: [{ clientCommission: 99 }],
      lastApprovedClientCommission: "88",
    });
    assert.equal(noFt.clientCommission, null);
    assert.equal(noFt.commissionSource, "unavailable");
  });

  it("LEGACY falls back to snapshot when FT missing", () => {
    const finance = new FinanceConsumerService({ mode: FINANCE_CONSUMER_MODES.LEGACY, prisma: {} });
    const svc = new ClientReportingService({
      prisma: {},
      partnerCampaigns: { assertPartnerClient: async () => ({ id: "c1" }) },
      financeConsumer: finance,
    });
    const out = svc.resolveOrderCommission({
      currency: "USD",
      financialTransactions: [],
      conversions: [{ clientCommission: 42 }],
    });
    assert.equal(out.clientCommission, 42);
    assert.equal(out.commissionSource, "conversion_snapshot");
  });

  it("LEGACY prefers FT when present (Epic 1 compatibility)", () => {
    const finance = new FinanceConsumerService({ mode: FINANCE_CONSUMER_MODES.LEGACY, prisma: {} });
    const svc = new ClientReportingService({ financeConsumer: finance, prisma: {} });
    const out = svc.resolveOrderCommission({
      currency: "USD",
      financialTransactions: [
        { clientPayable: 10, transactionType: "COMMISSION_EARNED" },
        { clientPayable: -3, transactionType: "COMMISSION_REVERSAL" },
      ],
      conversions: [{ clientCommission: 99 }],
    });
    assert.equal(out.clientCommission, 7);
    assert.equal(out.commissionSource, "financial_transaction");
  });
});

describe("Epic 8 — payment status vs withdrawals", () => {
  it("payment status DTO is billing report, not withdrawal", () => {
    const dto = toClientPaymentStatusDto({
      billingMonth: 8,
      billingYear: 2026,
      payableOrders: 2,
      payableCommission: 50,
      paymentStatus: "Payable",
      currency: "INR",
      paymentConfirmedDate: null,
      commissionSource: "financial_transaction",
    });
    assert.equal(dto.billingMonth, 8);
    assert.equal(dto.withdrawalStatus, undefined);
    assert.equal(dto.bankAccountId, undefined);
    assert.equal(dto.paymentStatus, "Payable");
  });

  it("Paid is not inferred from validation alone", () => {
    assert.equal(
      mapClientFacingOrderStatus({
        validationStatus: "VALIDATION_APPROVED",
        clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
      }),
      "Confirmed",
    );
  });
});

describe("Epic 8 — tenant-scoped listOrders mock", () => {
  it("queries only authenticated clientId", async () => {
    let whereUsed = null;
    const db = {
      order: {
        findMany: mock.fn(async ({ where }) => {
          whereUsed = where;
          return [];
        }),
        count: mock.fn(async () => 0),
      },
    };
    const svc = new ClientReportingService({
      prisma: db,
      partnerCampaigns: {
        assertPartnerClient: async (id) => ({ id, name: "A", slug: "a", currency: "USD" }),
      },
      financeConsumer: new FinanceConsumerService({ mode: FINANCE_CONSUMER_MODES.LEGACY, prisma: db }),
    });
    await svc.listOrders("tenant-a", { page: 1, pageSize: 10 });
    assert.equal(whereUsed.clientId, "tenant-a");
  });
});

describe("Epic 8 — commercial engines remain green (spot)", () => {
  it("five client rule kinds resolve; TIERED blocked", () => {
    assert.equal(
      resolveRuleKind({ commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION" }),
      "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
    );
    assert.equal(
      resolveRuleKind({ commissionType: "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE" }),
      "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE",
    );
    assert.equal(
      resolveRuleKind({ commissionType: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER" }),
      "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
    );
    assert.equal(
      resolveRuleKind({ commissionType: "MANUAL_APPROVED_CLIENT_COMMISSION" }),
      "MANUAL_APPROVED_CLIENT_COMMISSION",
    );
    assert.equal(
      resolveRuleKind({ commissionType: "DISPLAY_RANGE_WITH_ACTUAL_SPLIT" }),
      "DISPLAY_RANGE_WITH_ACTUAL_SPLIT",
    );
    assert.equal(resolveRuleKind({ commissionType: "TIERED" }), "TIERED_NOT_IMPLEMENTED");
  });

  it("fixed amount / order-value percent / manual / display-range kinds remain distinct", () => {
    assert.notEqual(
      resolveRuleKind({ commissionType: "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER" }),
      resolveRuleKind({ commissionType: "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE" }),
    );
    assert.equal(
      resolveRuleKind({ commissionType: "DISPLAY_RANGE_WITH_ACTUAL_SPLIT" }),
      "DISPLAY_RANGE_WITH_ACTUAL_SPLIT",
    );
  });
});

describe("Epic 8 — payment status list tenant scope", () => {
  it("listPaymentStatus filters by clientId and marks reportType", async () => {
    let orderWhere = null;
    const db = {
      order: {
        findMany: mock.fn(async ({ where }) => {
          orderWhere = where;
          return [];
        }),
      },
      financialTransaction: {
        findMany: mock.fn(async () => []),
      },
      clientStatement: {
        findMany: mock.fn(async () => []),
      },
    };
    const svc = new ClientReportingService({
      prisma: db,
      partnerCampaigns: {
        assertPartnerClient: async (id) => ({ id, name: "A", slug: "a", currency: "USD" }),
      },
      financeConsumer: new FinanceConsumerService({ mode: FINANCE_CONSUMER_MODES.LEGACY, prisma: db }),
    });
    const out = await svc.listPaymentStatus("tenant-pay");
    assert.equal(orderWhere.clientId, "tenant-pay");
    assert.equal(out.reportType, "payment_status");
    assert.ok(String(out.note).includes("Withdrawals"));
  });
});

describe("Epic 8 — products assignment isolation contract", () => {
  it("ACTIVE product DTO never exposes supplierReceivable or mboMargin", () => {
    const dto = toClientProductDto({
      status: "ACTIVE",
      clientCampaignAssignmentId: "asg-1",
      product: { id: "p2", title: "Bag", price: 5, currency: "AED" },
      productTrackingLinks: [],
    });
    assert.equal(dto.supplierReceivable, undefined);
    assert.equal(dto.mboMargin, undefined);
    assert.equal(dto.status, "ACTIVE");
  });
});

describe("Epic 8 — campaign assignment isolation fields", () => {
  it("campaign DTO has assignment identity without supplier IDs", () => {
    const dto = toPartnerCampaignDto({
      assignmentId: "asg-9",
      assignmentStatus: "ACTIVE",
      published: true,
      campaign: { id: "cc9", displayName: "X", brand: "B", countries: [], validity: {} },
      commercial: null,
      tracking: null,
    });
    assert.equal(dto.assignmentId, "asg-9");
    assert.equal(dto.supplierId, undefined);
    assert.equal(dto.supplierCampaignId, undefined);
  });
});

describe("Epic 8 — performance / campaigns handlers reject cross-tenant query", () => {
  it("performance alias rejects mismatched clientId", async () => {
    const req = { partnerClientId: "a", query: { clientId: "b" } };
    const res = mockRes();
    await clientPerformanceAliasHandler(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });

  it("campaigns alias rejects mismatched clientId", async () => {
    const req = { partnerClientId: "a", query: { clientId: "b" } };
    const res = mockRes();
    await clientListCampaignsAliasHandler(req, res, () => {});
    assert.equal(res.statusCode, 403);
  });
});

describe("Epic 8 — FinanceConsumer display modes", () => {
  it("FINANCE KPIs use FT net; LEGACY uses snapshots", () => {
    const fin = new FinanceConsumerService({ mode: FINANCE_CONSUMER_MODES.FINANCE });
    const leg = new FinanceConsumerService({ mode: FINANCE_CONSUMER_MODES.LEGACY });
    assert.equal(
      fin.resolveDisplayCommission({ legacyApproved: 10, legacyPending: 5, financeNet: 8 }).approvedCommission,
      8,
    );
    assert.equal(
      leg.resolveDisplayCommission({ legacyApproved: 10, legacyPending: 5, financeNet: 8 }).approvedCommission,
      10,
    );
  });

  it("SHADOW still displays legacy amounts", () => {
    const shadow = new FinanceConsumerService({ mode: FINANCE_CONSUMER_MODES.SHADOW });
    const out = shadow.resolveDisplayCommission({
      legacyApproved: 12,
      legacyPending: 3,
      financeNet: 9,
    });
    assert.equal(out.approvedCommission, 12);
    assert.equal(out.source, "conversion_snapshot");
  });
});
