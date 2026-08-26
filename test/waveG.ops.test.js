import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { ExceptionCaseService } from "../src/modules/order/exceptionCase.service.js";
import { MappingReviewOpsService } from "../src/modules/ops/mappingReviewOps.service.js";
import { FinanceOpsService, RECON_STATUS } from "../src/modules/ops/financeOps.service.js";
import { ProductOpsService, DataQualityOpsService, SupplierHealthOpsService } from "../src/modules/ops/productOps.service.js";
import { ROLE_PERMISSIONS, PERMISSIONS } from "../src/auth/permissions.js";

function mockDb(overrides = {}) {
  return {
    exceptionCase: {
      findUnique: mock.fn(async () => null),
      findFirst: mock.fn(async () => null),
      findMany: mock.fn(async () => []),
      count: mock.fn(async () => 0),
      create: mock.fn(async ({ data }) => ({ id: "ex1", ...data, detectedAt: new Date() })),
      update: mock.fn(async ({ data }) => ({ id: "ex1", ...data })),
    },
    financialTransaction: {
      findMany: mock.fn(async () => []),
      findUnique: mock.fn(async () => null),
      count: mock.fn(async () => 0),
    },
    clientInvoice: {
      groupBy: mock.fn(async () => []),
    },
    product: {
      findMany: mock.fn(async () => []),
      findUnique: mock.fn(async () => null),
      count: mock.fn(async () => 0),
    },
    productSource: { count: mock.fn(async () => 0) },
    entity: {
      findMany: mock.fn(async () => []),
      findFirst: mock.fn(async () => null),
      count: mock.fn(async () => 0),
    },
    clientCampaignAssignment: {
      count: mock.fn(async () => 0),
      findMany: mock.fn(async () => []),
    },
    conversion: { count: mock.fn(async () => 0) },
    order: { count: mock.fn(async () => 0) },
    rawPayload: {
      findMany: mock.fn(async () => []),
      findUnique: mock.fn(async () => null),
      count: mock.fn(async () => 0),
    },
    ...overrides,
  };
}

describe("Wave G — ExceptionCase operations", () => {
  it("lists with filters", async () => {
    const db = mockDb();
    db.exceptionCase.findMany = mock.fn(async () => [
      { id: "ex1", type: "MAPPING_INVALID_VALUE", severity: "HIGH", status: "OPEN", client: null },
    ]);
    db.exceptionCase.count = mock.fn(async () => 1);
    const svc = new ExceptionCaseService({ prisma: db, audit: { record: async () => {} } });
    const result = await svc.list({ status: "OPEN", severity: "HIGH", supplier: "IMPACT" });
    assert.equal(result.total, 1);
    assert.equal(result.rows[0].id, "ex1");
    const where = db.exceptionCase.findMany.mock.calls[0].arguments[0].where;
    assert.equal(where.status, "OPEN");
    assert.equal(where.severity, "HIGH");
    assert.equal(where.supplier, "IMPACT");
  });

  it("resolves, reopens, and blocks invalid reopen", async () => {
    const db = mockDb();
    const existing = {
      id: "ex1",
      type: "MAPPING_INVALID_VALUE",
      status: "RESOLVED",
      reason: "done",
      metadata: {},
      client: null,
    };
    db.exceptionCase.findUnique = mock.fn(async () => existing);
    db.exceptionCase.update = mock.fn(async ({ data }) => ({ ...existing, ...data }));
    const svc = new ExceptionCaseService({ prisma: db, audit: { record: async () => {} } });

    const resolved = await svc.resolve("ex1", { reason: "fixed", actorId: "u1" });
    assert.equal(resolved.status, "RESOLVED");

    const reopened = await svc.reopen("ex1", { reason: "need again", actorId: "u1" });
    assert.equal(reopened.status, "OPEN");

    db.exceptionCase.findUnique = mock.fn(async () => ({ ...existing, status: "OPEN" }));
    await assert.rejects(() => svc.reopen("ex1", { reason: "nope" }), /Only resolved/);
  });

  it("retry policy allows mapping and blocks finance duplicates", () => {
    const svc = new ExceptionCaseService({ prisma: mockDb(), audit: { record: async () => {} } });
    assert.equal(svc.getRetryPolicy("MAPPING_CONFLICT").allowed, true);
    assert.equal(svc.getRetryPolicy("DUPLICATE_FINANCIAL_RECOGNITION").allowed, false);
    assert.equal(svc.getRetryPolicy("FINANCIAL_RECONCILIATION_MISMATCH").allowed, false);
  });
});

describe("Wave G — Mapping review retry", () => {
  it("refuses retry without rawPayloadId", async () => {
    const exceptions = {
      getById: async () => ({
        id: "ex1",
        type: "MAPPING_INVALID_VALUE",
        metadata: {},
      }),
      getRetryPolicy: (type) => ({ allowed: true, mode: "MAPPING_REPLAY", note: "ok" }),
    };
    const svc = new MappingReviewOpsService({
      prisma: mockDb(),
      exceptions,
      replay: { replayRawPayload: async () => ({ ok: true }) },
      audit: { record: async () => {} },
    });
    await assert.rejects(() => svc.retryException("ex1"), /rawPayloadId/);
  });

  it("refuses unsafe finance retry", async () => {
    const exceptions = {
      getById: async () => ({
        id: "ex1",
        type: "DUPLICATE_FINANCIAL_RECOGNITION",
        metadata: { rawPayloadId: "rp1" },
      }),
      getRetryPolicy: (type) => ({ allowed: false, mode: "NONE", note: "unsafe" }),
    };
    const svc = new MappingReviewOpsService({
      prisma: mockDb(),
      exceptions,
      audit: { record: async () => {} },
    });
    await assert.rejects(() => svc.retryException("ex1"), /Retry not allowed/);
  });
});

describe("Wave G — Finance reconciliation", () => {
  it("marks empty client as MISSING_FINANCIAL_RECORD", async () => {
    const db = mockDb();
    const svc = new FinanceOpsService({
      prisma: db,
      financeConsumer: {
        getFinancialCoverage: async () => ({ complete: false }),
        compareDailyReportDimensions: async () => ({ summary: {}, rows: [] }),
      },
      reconciliation: {
        reconcileTransaction: () => ({ ok: true }),
        reconcileConversion: async () => ({ ok: true }),
      },
    });
    const out = await svc.reconcileClient("client-a");
    assert.equal(out.status, RECON_STATUS.MISSING_FINANCIAL_RECORD);
  });

  it("dashboard totals use FinancialTransaction only", async () => {
    const db = mockDb();
    db.financialTransaction.findMany = mock.fn(async () => [
      {
        transactionType: "COMMISSION_EARNED",
        supplierReceivable: 100,
        clientPayable: 70,
        mboMargin: 30,
        originalCurrency: "USD",
        reportingCurrency: null,
        reportingSupplierReceivable: null,
        reportingClientPayable: null,
        reportingMboMargin: null,
      },
    ]);
    db.exceptionCase.count = mock.fn(async () => 0);
    db.clientInvoice.groupBy = mock.fn(async () => []);
    const svc = new FinanceOpsService({
      prisma: db,
      financeConsumer: {},
      reconciliation: { reconcileTransaction: () => ({ ok: true }) },
    });
    const dash = await svc.getDashboard({});
    assert.equal(dash.totals.supplierReceivable, 100);
    assert.equal(dash.totals.clientPayable, 70);
    assert.equal(dash.totals.mboMargin, 30);
    assert.equal(dash.totals.reconciles, true);
  });
});

describe("Wave G — Product ops + health", () => {
  it("lists products with supplier filter", async () => {
    const db = mockDb();
    db.product.findMany = mock.fn(async () => [
      {
        id: "p1",
        title: "Shoe",
        brand: "Nike",
        sku: "NK-101",
        price: 8999,
        currency: "INR",
        availability: "IN_STOCK",
        status: "ACTIVE",
        merchant: { id: "m1", displayName: "Nike" },
        productFeed: { id: "f1", feedName: "Catalog Item", feedFormat: "CSV" },
        campaignSource: {
          id: "cs1",
          canonicalCampaign: { displayName: "Nike India CPS" },
          supplierCampaign: { campaignName: "Nike India CPS", supplier: "IMPACT" },
        },
        sources: [
          {
            id: "ps1",
            supplier: "IMPACT",
            sourceAccountLabel: "default",
            supplierProductId: "SKU-NK-101",
            supplierSku: "NK-101",
            title: "Running Shoe",
            price: 8999,
            currency: "INR",
            rawPayloadId: "raw-1",
            mapperVersion: "v1",
          },
        ],
      },
    ]);
    db.product.count = mock.fn(async () => 1);
    const svc = new ProductOpsService({
      prisma: db,
      promotion: { promoteBatch: async () => ({ processed: 0 }) },
    });
    const out = await svc.listProducts({ supplier: "IMPACT", q: "Shoe" });
    assert.equal(out.total, 1);
    assert.equal(out.contract, "v13-products-feeds");
    assert.equal(out.rows[0].networkSource, "IMPACT");
    assert.equal(out.rows[0].brandName, "Nike");
    assert.equal(out.rows[0].campaignName, "Nike India CPS");
    assert.equal(out.rows[0].supplierProductId, "SKU-NK-101");
    assert.equal(out.rows[0].productFeedSource, "Catalog Item");
    assert.equal(out.rows[0].mappingStatus, "MAPPED");
    assert.ok(db.product.findMany.mock.calls[0].arguments[0].where.sources);
  });

  it("falls back to staged entity products when Product table is empty", async () => {
    const db = mockDb();
    db.product.findMany = mock.fn(async () => []);
    db.product.count = mock.fn(async () => 0);
    db.entity.findMany = mock.fn(async () => [
      {
        id: "e1",
        entityType: "product",
        networkSource: "impact",
        externalId: "impact-product:SKU-NK-101",
        rawData: {
          Id: "SKU-NK-101",
          Name: "Running Shoe",
          Sku: "NK-101",
          Brand: "Nike",
          Price: "8999",
          Currency: "INR",
          Availability: "IN_STOCK",
          CampaignName: "Nike India CPS",
        },
      },
    ]);
    db.entity.count = mock.fn(async () => 1);
    const svc = new ProductOpsService({
      prisma: db,
      promotion: { promoteBatch: async () => ({ processed: 0 }) },
    });
    const out = await svc.listProducts({});
    assert.equal(out.total, 1);
    assert.equal(out.source, "entity-product");
    assert.equal(out.rows[0].networkSource, "IMPACT");
    assert.equal(out.rows[0].productName, "Running Shoe");
    assert.equal(out.rows[0].productFeedSource, "Catalog Item");
  });

  it("data quality summary returns structured counts", async () => {
    const db = mockDb();
    const svc = new DataQualityOpsService({ prisma: db });
    const summary = await svc.getSummary();
    assert.ok(summary.assignments);
    assert.ok(summary.exceptions);
    assert.ok(summary.finance);
  });

  it("supplier health includes known networks", async () => {
    const db = mockDb({
      supplier: {
        findMany: mock.fn(async () => [
          { key: "IMPACT", status: "ENABLED", displayName: "Impact" },
        ]),
      },
    });
    const svc = new SupplierHealthOpsService({ prisma: db });
    const health = await svc.getSupplierHealth();
    assert.ok(Array.isArray(health));
    assert.ok(health.some((s) => s.supplier === "IMPACT" || s.supplier === "PARTNERIZE"));
  });
});

describe("Wave G — Authorization matrix", () => {
  it("CLIENT cannot access ops/finance permissions", () => {
    const client = ROLE_PERMISSIONS.CLIENT;
    assert.equal(client.includes(PERMISSIONS.FINANCE_OPS_READ), false);
    assert.equal(client.includes(PERMISSIONS.OPS_READ), false);
    assert.equal(client.includes(PERMISSIONS.EXCEPTIONS_MANAGE), false);
  });

  it("OPERATIONS has exception + finance ops access", () => {
    const ops = ROLE_PERMISSIONS.OPERATIONS;
    assert.ok(ops.includes(PERMISSIONS.EXCEPTIONS_READ));
    assert.ok(ops.includes(PERMISSIONS.EXCEPTIONS_MANAGE));
    assert.ok(ops.includes(PERMISSIONS.FINANCE_OPS_READ));
    assert.ok(ops.includes(PERMISSIONS.OPS_READ));
  });

  it("SUPPORT has exception read but not finance ops", () => {
    const support = ROLE_PERMISSIONS.SUPPORT;
    assert.ok(support.includes(PERMISSIONS.EXCEPTIONS_READ));
    assert.equal(support.includes(PERMISSIONS.FINANCE_OPS_READ), false);
  });

  it("ADMIN has all Wave G permissions", () => {
    const admin = ROLE_PERMISSIONS.ADMIN;
    assert.ok(admin.includes(PERMISSIONS.PRODUCTS_READ));
    assert.ok(admin.includes(PERMISSIONS.OPS_MANAGE));
  });
});
