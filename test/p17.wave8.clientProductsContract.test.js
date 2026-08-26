/**
 * P1.7 Wave 8 — Client portal products contract (11E) + tenant / visibility safety.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  ClientProductService,
  FORBIDDEN_CLIENT_PRODUCT_KEYS,
  resolveClientReportingCurrency,
  toClientProductDto,
} from "../src/modules/product/productFeed.service.js";
import { CLIENT_API } from "../../frontend/src/apiUrl.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

function baseProduct(overrides = {}) {
  return {
    id: "prod-1",
    title: "Running Shoe",
    imageUrl: "https://cdn.example/shoe.jpg",
    price: 100,
    salePrice: 80,
    currency: "USD",
    clientReportingCurrency: "INR",
    availability: "IN_STOCK",
    category: "Shoes",
    brand: "Nike",
    status: "ACTIVE",
    feedStatus: "ACTIVE",
    merchant: { displayName: "Nike", logoUrl: "https://cdn.example/logo.png" },
    campaignSource: {
      canonicalCampaign: { id: "cc-1", displayName: "Nike India Offers" },
      supplierCampaign: { campaignType: "CPS", pricingModel: "CPS" },
    },
    ...overrides,
  };
}

function visibleAssignment(overrides = {}) {
  return {
    id: "cpa-1",
    clientId: "client-a",
    productId: "prod-1",
    clientCampaignAssignmentId: "asg-1",
    status: "ACTIVE",
    product: baseProduct(),
    clientCampaignAssignment: {
      id: "asg-1",
      clientId: "client-a",
      published: true,
      status: "ACTIVE",
      channel: "LINK",
      startDate: new Date("2026-08-01"),
      endDate: new Date("2026-08-31"),
      canonicalCampaign: { id: "cc-1", displayName: "Nike India Offers" },
      campaignSource: {
        supplierCampaign: { campaignType: "CPS", pricingModel: "CPS" },
      },
      commissionRules: [{ status: "EFFECTIVE", displayLabel: "Up to 5%" }],
    },
    productTrackingLinks: [{ mboProductTrackingUrl: "https://mborewards.com/t/product/ABC" }],
    ...overrides,
  };
}

describe("P1.7 Wave 8 — path + currency + DTO", () => {
  it("CLIENT_API.products is /v1/client/products", () => {
    assert.equal(CLIENT_API.products, "/v1/client/products");
  });

  it("09J currency: IN→INR, AE→USD, unknown→null (no invent)", () => {
    assert.equal(resolveClientReportingCurrency({ country: "IN" }), "INR");
    assert.equal(resolveClientReportingCurrency({ country: "AE" }), "USD");
    assert.equal(resolveClientReportingCurrency({}), null);
  });

  it("DTO lineage + commercial≠channel + forbidden absent", () => {
    const dto = toClientProductDto(visibleAssignment(), { id: "client-a", country: "IN" });
    assert.equal(dto.productName, "Running Shoe");
    assert.equal(dto.campaignName, "Nike India Offers");
    assert.equal(dto.brandName, "Nike");
    assert.equal(dto.commercialModel, "CPS");
    assert.equal(dto.channel, "LINK");
    assert.equal(dto.campaignType, "LINK");
    assert.equal(dto.commissionDisplay, "Up to 5%");
    assert.equal(dto.discountPercentage, 20);
    assert.equal(dto.currency, "INR");
    assert.equal(dto.originalCurrency, "USD");
    assert.equal(dto.mboProductTrackingUrl, "https://mborewards.com/t/product/ABC");
    assert.equal(dto.price, 100);
    // Product.price is catalog — not commission.
    assert.notEqual(dto.commissionDisplay, String(dto.price));
    const blob = JSON.stringify(dto);
    for (const key of [
      ...FORBIDDEN_CLIENT_PRODUCT_KEYS,
      "supplierReceivable",
      "mboMargin",
      "apiKey",
      "keyHash",
      "rawPayload",
    ]) {
      assert.equal(blob.includes(`"${key}"`), false, key);
    }
    assert.equal(dto.supplierProductTrackingUrl, undefined);
  });

  it("does not invent product URL or image", () => {
    const dto = toClientProductDto(
      visibleAssignment({
        product: baseProduct({ imageUrl: null, url: null }),
        productTrackingLinks: [],
      }),
      { country: "IN" },
    );
    assert.equal(dto.productImageUrl, null);
    assert.equal(dto.mboProductTrackingUrl, null);
  });

  it("does not fuzzy-match campaign by name — uses assignment lineage", () => {
    const dto = toClientProductDto(
      visibleAssignment({
        clientCampaignAssignment: {
          id: "asg-1",
          published: true,
          status: "ACTIVE",
          channel: "COUPON",
          canonicalCampaign: { id: "cc-9", displayName: "Exact From Assignment" },
          campaignSource: null,
          commissionRules: [],
        },
        product: baseProduct({
          campaignSource: {
            canonicalCampaign: { id: "cc-other", displayName: "Wrong Fuzzy Name Match" },
            supplierCampaign: { campaignType: "CPA", pricingModel: "CPA" },
          },
        }),
      }),
      { country: "IN" },
    );
    assert.equal(dto.campaignName, "Exact From Assignment");
    assert.notEqual(dto.campaignName, "Wrong Fuzzy Name Match");
  });
});

describe("P1.7 Wave 8 — list visibility + pagination + isolation", () => {
  function mockDb({ rows = [], clientStatus = "ACTIVE" } = {}) {
    return {
      client: {
        findUnique: mock.fn(async ({ where }) =>
          where.id === "client-a"
            ? { id: "client-a", country: "IN", status: clientStatus, deletedAt: null }
            : where.id === "client-b"
              ? { id: "client-b", country: "AE", status: "ACTIVE", deletedAt: null }
              : null,
        ),
      },
      clientProductAssignment: {
        count: mock.fn(async () => rows.length),
        findMany: mock.fn(async () => rows),
      },
    };
  }

  it("valid client gets own products with pagination metadata", async () => {
    const rows = [visibleAssignment()];
    const svc = new ClientProductService({ prisma: mockDb({ rows }) });
    const out = await svc.listClientProducts("client-a", { page: 1, pageSize: 25 });
    assert.equal(out.items.length, 1);
    assert.equal(out.dataAvailable, true);
    assert.equal(out.pagination.page, 1);
    assert.equal(out.pagination.pageSize, 25);
    assert.equal(out.pagination.total, 1);
    assert.equal(out.contract, "v15-11E-client-products");
  });

  it("empty state honest", async () => {
    const svc = new ClientProductService({ prisma: mockDb({ rows: [] }) });
    const out = await svc.listClientProducts("client-a");
    assert.equal(out.items.length, 0);
    assert.equal(out.dataAvailable, false);
    assert.equal(out.dataState, "empty");
  });

  it("forces clientId in where (tenant) and requires published campaign assignment", async () => {
    let capturedWhere = null;
    const db = mockDb({ rows: [] });
    db.clientProductAssignment.count = mock.fn(async ({ where }) => {
      capturedWhere = where;
      return 0;
    });
    db.clientProductAssignment.findMany = mock.fn(async ({ where }) => {
      capturedWhere = where;
      return [];
    });
    const svc = new ClientProductService({ prisma: db });
    await svc.listClientProducts("client-a", { clientId: "client-b", brand: "Nike" });
    assert.equal(capturedWhere.clientId, "client-a");
    assert.equal(capturedWhere.clientCampaignAssignment.is.published, true);
    assert.equal(capturedWhere.clientCampaignAssignment.is.status, "ACTIVE");
    // PAUSED / REVOKED / unpublished excluded by status+published gate (not a second engine).
    assert.notEqual(capturedWhere.clientCampaignAssignment.is.status, "PAUSED");
    assert.notEqual(capturedWhere.clientCampaignAssignment.is.status, "REVOKED");
    assert.ok(capturedWhere.product.AND);
  });

  it("price is catalog not commission; supplier commission fields absent", async () => {
    const dto = toClientProductDto(visibleAssignment(), { country: "IN" });
    assert.equal(dto.price, 100);
    assert.equal(dto.commissionDisplay, "Up to 5%");
    assert.equal(Object.prototype.hasOwnProperty.call(dto, "supplierCommission"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(dto, "mboCommission"), false);
  });

  it("inactive client → 403", async () => {
    const svc = new ClientProductService({ prisma: mockDb({ clientStatus: "SUSPENDED" }) });
    await assert.rejects(
      () => svc.listClientProducts("client-a"),
      (err) => err.statusCode === 403 || err.status === 403,
    );
  });

  it("filters brand search is backend-side", async () => {
    let capturedWhere = null;
    const db = mockDb({ rows: [] });
    db.clientProductAssignment.findMany = mock.fn(async ({ where }) => {
      capturedWhere = where;
      return [];
    });
    db.clientProductAssignment.count = mock.fn(async ({ where }) => {
      capturedWhere = where;
      return 0;
    });
    const svc = new ClientProductService({ prisma: db });
    await svc.listClientProducts("client-a", { search: "shoe", brand: "Nike" });
    const and = capturedWhere.product.AND;
    assert.ok(Array.isArray(and));
    assert.ok(and.some((clause) => clause.OR?.some((o) => o.title?.contains === "shoe")));
  });
});

describe("P1.7 Wave 8 — HTTP auth", () => {
  let server;
  it("boot", async () => {
    server = await startTestServer();
  });

  it("missing credentials → 401 on client products", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/v1/client/products" });
    assert.equal(status, 401);
  });

  it("portal products alias → 401", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/portal/v1/products" });
    assert.equal(status, 401);
  });

  it("admin products not open to anonymous (401/403)", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/ops/products" });
    assert.ok(status === 401 || status === 403);
  });

  it("teardown", async () => {
    await server.close();
  });
});
