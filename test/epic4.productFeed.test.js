/**
 * Epic 4 — Product Feed & Client Product Assignment tests.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { mapPayload } from "../src/modules/mapping/index.js";
import {
  ProductFeedService,
  ClientProductService,
  resolveClientReportingCurrency,
  toClientProductDto,
  FORBIDDEN_CLIENT_PRODUCT_KEYS,
} from "../src/modules/product/productFeed.service.js";
import { ProductTrackingRedirectService } from "../src/modules/product/productTrackingRedirect.service.js";
import { appendTrackingParams } from "../src/modules/tracking/index.js";

describe("Epic 4 — mapping Optimise / Partnerize / Impact products", () => {
  it("maps Optimise product feed row", () => {
    const result = mapPayload({
      supplier: "OPTIMISE",
      resourceKey: "products",
      payload: {
        productId: "opt-1",
        name: "Shoe",
        price: "10",
        currency: "USD",
        product_url: "https://brand.example/p/1",
        tracking_url: "https://go.optimise.example/t/1",
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.normalizedData.supplierProductId, "opt-1");
    assert.equal(result.normalizedData.supplierProductTrackingUrl, "https://go.optimise.example/t/1");
  });

  it("maps Partnerize product feed row (v15 Yes/High — not N/A)", () => {
    const result = mapPayload({
      supplier: "PARTNERIZE",
      resourceKey: "products",
      payload: {
        product_id: "pz-9",
        title: "Bag",
        price: "20",
        currency: "GBP",
        url: "https://brand.example/bag",
        tracking_link: "https://prf.hn/product/9",
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.normalizedData.supplierProductId, "pz-9");
    assert.equal(result.normalizedData.title, "Bag");
    assert.equal(result.normalizedData.supplierProductTrackingUrl, "https://prf.hn/product/9");
  });
});

describe("Epic 4 — currency display rule", () => {
  it("India → INR; known non-India → USD; unknown → null", () => {
    assert.equal(resolveClientReportingCurrency({ country: "IN" }), "INR");
    assert.equal(resolveClientReportingCurrency({ country: "AE" }), "USD");
    assert.equal(resolveClientReportingCurrency({}), null);
  });
});

function mockFeedDb() {
  const feeds = new Map();
  const items = new Map();
  const products = new Map();
  const sources = new Map();
  const raws = new Map();
  const exceptions = [];
  const assignments = new Map();
  const links = new Map();
  const campaignAssignments = new Map();

  function matchesProductWhere(product, productWhere) {
    if (!productWhere || !product) return !!product;
    if (productWhere.status?.in && !productWhere.status.in.includes(product.status)) return false;
    return true;
  }

  function matchesCampaignAssignmentGate(where, row) {
    const gate = where?.clientCampaignAssignment?.is;
    if (!gate) return true;
    if (!row.clientCampaignAssignmentId) return false;
    const ca = campaignAssignments.get(row.clientCampaignAssignmentId);
    if (!ca) return false;
    if (gate.published === true && ca.published !== true) return false;
    if (gate.status && ca.status !== gate.status) return false;
    if (gate.clientId && ca.clientId !== gate.clientId) return false;
    return true;
  }

  const db = {
    productFeed: {
      findUnique: async ({ where }) => {
        const k = where.supplier_sourceAccountLabel_feedExternalId;
        return (
          [...feeds.values()].find(
            (f) =>
              f.supplier === k.supplier &&
              f.sourceAccountLabel === k.sourceAccountLabel &&
              f.feedExternalId === k.feedExternalId,
          ) || null
        );
      },
      create: async ({ data }) => {
        const row = { id: `feed-${feeds.size + 1}`, ...data, updatedAt: new Date() };
        feeds.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...feeds.get(where.id), ...data, updatedAt: new Date() };
        if (data.errorCount?.increment) {
          row.errorCount = (row.errorCount || 0) + data.errorCount.increment;
        }
        feeds.set(where.id, row);
        return row;
      },
    },
    productFeedItem: {
      findUnique: async ({ where }) => {
        const k = where.productFeedId_supplierProductId;
        return (
          [...items.values()].find(
            (i) => i.productFeedId === k.productFeedId && i.supplierProductId === k.supplierProductId,
          ) || null
        );
      },
      create: async ({ data }) => {
        const row = { id: `item-${items.size + 1}`, ...data };
        items.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...items.get(where.id), ...data };
        items.set(where.id, row);
        return row;
      },
    },
    productSource: {
      findUnique: async ({ where }) => {
        const k = where.supplier_sourceAccountLabel_supplierProductId;
        const source = [...sources.values()].find(
          (s) =>
            s.supplier === k.supplier &&
            s.sourceAccountLabel === k.sourceAccountLabel &&
            s.supplierProductId === k.supplierProductId,
        );
        if (!source) return null;
        return { ...source, product: products.get(source.productId) };
      },
    },
    product: {
      create: async ({ data }) => {
        const row = { id: `prod-${products.size + 1}`, ...data };
        products.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...products.get(where.id), ...data };
        products.set(where.id, row);
        return row;
      },
      findUnique: async ({ where }) => products.get(where.id) || null,
    },
    rawPayload: {
      create: async ({ data }) => {
        const row = { id: `raw-${raws.size + 1}`, ...data };
        raws.set(row.id, row);
        return row;
      },
      findFirst: async () => null,
    },
    clientCampaignAssignment: {
      findUnique: async ({ where }) => campaignAssignments.get(where.id) || null,
    },
    clientProductAssignment: {
      findUnique: async ({ where }) => {
        const k = where.clientId_productId;
        return (
          [...assignments.values()].find((a) => a.clientId === k.clientId && a.productId === k.productId) ||
          null
        );
      },
      create: async ({ data }) => {
        const row = { id: `cpa-${assignments.size + 1}`, ...data };
        assignments.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...assignments.get(where.id), ...data };
        assignments.set(where.id, row);
        return row;
      },
      count: async ({ where }) =>
        [...assignments.values()].filter(
          (a) =>
            a.clientId === where.clientId &&
            a.status === where.status &&
            matchesCampaignAssignmentGate(where, a) &&
            matchesProductWhere(products.get(a.productId), where.product),
        ).length,
      findMany: async ({ where }) => {
        return [...assignments.values()]
          .filter(
            (a) =>
              a.clientId === where.clientId &&
              a.status === where.status &&
              matchesCampaignAssignmentGate(where, a) &&
              matchesProductWhere(products.get(a.productId), where.product),
          )
          .map((a) => {
            const ca = a.clientCampaignAssignmentId
              ? campaignAssignments.get(a.clientCampaignAssignmentId)
              : null;
            return {
              ...a,
              product: products.get(a.productId),
              productTrackingLinks: [...links.values()].filter(
                (l) => l.clientId === a.clientId && l.productId === a.productId && l.status === "ACTIVE",
              ),
              clientCampaignAssignment: ca
                ? {
                    ...ca,
                    canonicalCampaign: ca.canonicalCampaign || {
                      id: "camp-1",
                      displayName: ca.campaignName || "Campaign",
                    },
                    campaignSource: ca.campaignSource || null,
                    commissionRules: ca.commissionRules || [],
                  }
                : null,
            };
          });
      },
    },
    productTrackingLink: {
      findFirst: async ({ where }) =>
        [...links.values()].find(
          (l) => l.clientId === where.clientId && l.productId === where.productId && l.status === where.status,
        ) || null,
      findUnique: async ({ where }) => {
        const link = [...links.values()].find((l) => l.token === where.token) || null;
        if (!link) return null;
        return {
          ...link,
          product: {
            ...products.get(link.productId),
            sources: [...sources.values()].filter((s) => s.productId === link.productId),
            campaignSource: null,
          },
        };
      },
      create: async ({ data }) => {
        const row = { id: `ptl-${links.size + 1}`, ...data };
        links.set(row.id, row);
        return row;
      },
      updateMany: async () => ({ count: 0 }),
    },
    client: {
      findUnique: async ({ where }) =>
        where.id === "client-a"
          ? { id: "client-a", country: "IN", currency: "INR", status: "ACTIVE", deletedAt: null }
          : where.id === "client-b"
            ? { id: "client-b", country: "AE", currency: "USD", status: "ACTIVE", deletedAt: null }
            : null,
    },
    trackingLink: { findFirst: async () => null },
    _feeds: feeds,
    _items: items,
    _products: products,
    _sources: sources,
    _raws: raws,
    _assignments: assignments,
    _campaignAssignments: campaignAssignments,
    _links: links,
    _exceptions: exceptions,
  };

  // Default published campaign assignment used by client product visibility tests.
  campaignAssignments.set("asg-1", {
    id: "asg-1",
    clientId: "client-a",
    published: true,
    status: "ACTIVE",
    channel: "LINK",
    startDate: null,
    endDate: null,
    campaignName: "Nike India",
    commissionRules: [{ status: "EFFECTIVE", displayLabel: "Up to 5%", orderValuePercent: null }],
  });
  campaignAssignments.set("asg-gold", {
    id: "asg-gold",
    clientId: "client-a",
    published: true,
    status: "ACTIVE",
    channel: "DEEPLINK",
    startDate: null,
    endDate: null,
    campaignName: "Gold Campaign",
    commissionRules: [],
  });

  // ProductSource create used by ProductService
  db.productSource.create = async ({ data }) => {
    const row = { id: `src-${sources.size + 1}`, ...data };
    sources.set(row.id, row);
    return row;
  };
  db.productSource.update = async ({ where, data }) => {
    const row = { ...sources.get(where.id), ...data };
    sources.set(where.id, row);
    return row;
  };

  return db;
}

describe("Epic 4 — feed ingest + idempotency", () => {
  it("ingests Partnerize feed rows into ProductFeed/Item/Product/Source with RawPayload", async () => {
    const db = mockFeedDb();
    const svc = new ProductFeedService({
      prisma: db,
      exceptions: { report: async (e) => db._exceptions.push(e) },
    });
    const first = await svc.ingestFeedBatch({
      supplier: "PARTNERIZE",
      feedExternalId: "feed-100",
      feedFormat: "JSON",
      compressedLocation: "s3://feeds/100.gz",
      rows: [
        {
          product_id: "pz-1",
          title: "Jacket",
          price: "99",
          currency: "USD",
          url: "https://brand.example/j",
          tracking_link: "https://prf.hn/j",
        },
      ],
    });
    assert.equal(first.summary.created, 1);
    assert.equal(db._feeds.size, 1);
    assert.equal(db._items.size, 1);
    assert.equal(db._products.size, 1);
    assert.equal(db._raws.size, 1);

    const second = await svc.ingestFeedBatch({
      supplier: "PARTNERIZE",
      feedExternalId: "feed-100",
      rows: [
        {
          product_id: "pz-1",
          title: "Jacket Updated",
          price: "89",
          currency: "USD",
          url: "https://brand.example/j",
          tracking_link: "https://prf.hn/j",
        },
      ],
    });
    assert.equal(second.summary.updated, 1);
    assert.equal(db._feeds.size, 1);
    assert.equal(db._products.size, 1);
  });

  it("records exception when product id missing", async () => {
    const db = mockFeedDb();
    const svc = new ProductFeedService({
      prisma: db,
      exceptions: { report: async (e) => db._exceptions.push(e) },
    });
    const out = await svc.ingestFeedBatch({
      supplier: "OPTIMISE",
      rows: [{ name: "No ID", price: "1" }],
    });
    assert.equal(out.summary.failed, 1);
    assert.ok(db._exceptions.some((e) => e.type === "PRODUCT_MISSING_ID" || e.reason));
  });
});

describe("Epic 4 — client assignment + DTO safety + tenant isolation", () => {
  it("assigns product, builds MBO tracking URL, hides supplier URL", async () => {
    const db = mockFeedDb();
    db._products.set("prod-1", {
      id: "prod-1",
      title: "Shoe",
      url: "https://brand.example/shoe",
      supplierProductTrackingUrl: "https://supplier.example/track",
      price: "10",
      currency: "USD",
      feedStatus: "ACTIVE",
      status: "ACTIVE",
      brand: "Nike",
    });
    const svc = new ClientProductService({
      prisma: db,
      exceptions: { report: async () => ({}) },
    });
    const assigned = await svc.assignProductToClient({
      clientId: "client-a",
      productId: "prod-1",
      clientCampaignAssignmentId: "asg-1",
    });
    assert.equal(assigned.ok, true);
    assert.ok(assigned.trackingLink.mboProductTrackingUrl.includes("/t/product/"));
    assert.equal(assigned.trackingLink.supplierProductTrackingUrl, "https://supplier.example/track");

    const listedA = await svc.listClientProducts("client-a");
    assert.equal(listedA.items.length, 1);
    assert.equal(listedA.items[0].currency, "INR");
    assert.ok(listedA.items[0].mboProductTrackingUrl);
    for (const key of FORBIDDEN_CLIENT_PRODUCT_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(listedA.items[0], key), false);
    }

    // Client B sees nothing
    const listedB = await svc.listClientProducts("client-b");
    assert.equal(listedB.items.length, 0);
  });

  it("DTO omits supplier tracking URL", () => {
    const dto = toClientProductDto({
      status: "ACTIVE",
      clientCampaignAssignmentId: null,
      product: {
        id: "p1",
        title: "X",
        supplierProductTrackingUrl: "SECRET",
        price: 1,
        currency: "USD",
        clientReportingCurrency: "USD",
      },
      productTrackingLinks: [{ mboProductTrackingUrl: "https://mbo/t/product/ABC" }],
    });
    assert.equal(dto.mboProductTrackingUrl, "https://mbo/t/product/ABC");
    assert.equal(dto.supplierProductTrackingUrl, undefined);
  });
});

describe("Epic 4 — product tracking URL safety", () => {
  it("preserves existing query and injects confirmed supplier params", async () => {
    const db = mockFeedDb();
    db._products.set("prod-1", {
      id: "prod-1",
      title: "Shoe",
      sources: [{ supplier: "IMPACT" }],
    });
    db._links.set("ptl-1", {
      id: "ptl-1",
      token: "PTOKEN1",
      status: "ACTIVE",
      clientId: "client-a",
      productId: "prod-1",
      clientCampaignAssignmentId: "asg-1",
      supplierProductTrackingUrl: "https://goto.impact.com/c?mid=1&keep=1#x",
    });
    // Override findUnique include shape
    db.productTrackingLink.findUnique = async () => ({
      ...db._links.get("ptl-1"),
      product: {
        id: "prod-1",
        sources: [{ supplier: "IMPACT" }],
        campaignSource: null,
      },
    });

    const svc = new ProductTrackingRedirectService({
      prisma: db,
      attribution: { recordClick: mock.fn(async () => ({ id: "click-1" })) },
    });
    db.trackingLink.findFirst = async () => ({ id: "tl-1", assignmentId: "asg-1" });

    const result = await svc.redirect("PTOKEN1");
    const dest = new URL(result.destination);
    assert.equal(dest.searchParams.get("keep"), "1");
    assert.equal(dest.hash, "#x");
    assert.equal(dest.searchParams.get("subId1"), "client-a");
    assert.equal(dest.searchParams.get("subId2"), "asg-1");
    assert.equal(result.attributionInjection.injected, true);
  });

  it("appendTrackingParams does not overwrite", () => {
    const out = appendTrackingParams("https://x.test/?subId1=keep", { subId1: "new", subId2: "a" });
    assert.equal(new URL(out.url).searchParams.get("subId1"), "keep");
    assert.equal(new URL(out.url).searchParams.get("subId2"), "a");
  });
});

describe("Epic 4 — golden path Feed→Product→Assignment→Client API", () => {
  it("proves end-to-end fixture path without live supplier calls", async () => {
    const db = mockFeedDb();
    const feedSvc = new ProductFeedService({
      prisma: db,
      exceptions: { report: async () => ({}) },
    });
    const clientSvc = new ClientProductService({
      prisma: db,
      exceptions: { report: async () => ({}) },
    });

    const ingested = await feedSvc.ingestFeedBatch({
      supplier: "OPTIMISE",
      feedExternalId: "AID-1",
      aid: "AID-1",
      countryHint: "IN",
      rows: [
        {
          productId: "gold-1",
          name: "Gold Product",
          price: "50",
          currency: "EUR",
          product_url: "https://brand.example/gold",
          tracking_url: "https://go.optimise.example/gold",
          image_url: "https://cdn.example/gold.png",
        },
      ],
    });
    assert.equal(ingested.summary.created, 1);
    const productId = [...db._products.keys()][0];

    const assigned = await clientSvc.assignProductToClient({
      clientId: "client-a",
      productId,
      clientCampaignAssignmentId: "asg-gold",
    });
    assert.equal(assigned.ok, true);

    const api = await clientSvc.listClientProducts("client-a");
    assert.equal(api.items.length, 1);
    assert.equal(api.items[0].productName, "Gold Product");
    assert.equal(api.items[0].currency, "INR");
    assert.ok(api.items[0].mboProductTrackingUrl.includes("/t/product/"));
    assert.equal(api.items[0].originalCurrency, "EUR");
  });
});
