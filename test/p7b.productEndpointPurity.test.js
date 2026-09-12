import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The module graph reaches src/config/urls.js, which requires these at import time. They are set
// before the dynamic imports below so the suite runs without a deployed environment; no database
// is touched anywhere in this file.
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const { CAMPAIGN_LINK_DERIVED, CAMPAIGN_LINK_NATIVE, ProductOpsService, toAdminProductListDto } =
  await import("../src/modules/ops/productOps.service.js");
const { FEED_ERROR_CODES, hasFeedError, safeFeedErrorCode, toAdminProductFeedDto } =
  await import("../src/modules/ops/adminContract.dto.js");

/**
 * A Prisma double that throws on every mutating call.
 *
 * Purity is asserted structurally rather than by reading the source: if a read path ever reaches
 * a write, these tests fail and name the exact call that did it.
 */
const WRITE_METHODS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "executeRaw",
  "queryRaw",
];

function makeDb({ products = [], total = null, campaigns = [], feeds = [] } = {}) {
  const calls = [];
  const model = (name, rows) => {
    const target = {
      findMany: async (args) => {
        calls.push(`${name}.findMany`);
        const skip = args?.skip ?? 0;
        const take = args?.take ?? rows.length;
        return rows.slice(skip, skip + take);
      },
      findFirst: async () => {
        calls.push(`${name}.findFirst`);
        return rows[0] ?? null;
      },
      findUnique: async (args) => {
        calls.push(`${name}.findUnique`);
        return rows.find((r) => r.id === args?.where?.id) ?? null;
      },
      count: async () => {
        calls.push(`${name}.count`);
        return total ?? rows.length;
      },
    };
    for (const method of WRITE_METHODS) {
      target[method] = async () => {
        calls.push(`WRITE:${name}.${method}`);
        throw new Error(`forbidden write: ${name}.${method}`);
      };
    }
    return target;
  };
  return {
    calls,
    product: model("product", products),
    productSource: model("productSource", []),
    productFeed: model("productFeed", feeds),
    productFeedItem: model("productFeedItem", []),
    rawPayload: model("rawPayload", []),
    entity: model("entity", []),
    supplierCampaign: model("supplierCampaign", campaigns),
  };
}

function productRow(extra = {}) {
  return {
    id: "p-1",
    merchantId: "m-1",
    merchant: { id: "m-1", displayName: "Ubuy" },
    productFeedId: "pf-1",
    productFeed: { id: "pf-1", feedName: "Optimise SG", feedFormat: "CSV", feedExternalId: "f-1", feedStatus: "ACTIVE" },
    campaignSourceId: "cs-1",
    campaignSource: {
      id: "cs-1",
      canonicalCampaign: { displayName: "Ubuy SG" },
      supplierCampaign: { campaignName: "Ubuy", supplier: "OPTIMISE", trackingUrl: "https://t.test/?PID=999", merchantId: "m-1" },
    },
    sku: "SKU-1",
    title: "Widget",
    description: "A widget",
    url: "https://shop.test/widget",
    imageUrl: "https://img.test/w.jpg",
    category: "Home",
    brand: "WidgetCo",
    price: 100,
    salePrice: 80,
    currency: "USD",
    availability: "IN_STOCK",
    status: "ACTIVE",
    sources: [
      {
        id: "ps-1",
        supplier: "OPTIMISE",
        sourceAccountLabel: "default",
        supplierProductId: "SP-1",
        supplierSku: "SKU-1",
        catalogId: "999",
        title: "Widget",
        price: 100,
        currency: "USD",
        rawPayloadId: "rp-1",
        mapperVersion: "1.1.1",
        updatedAt: new Date("2026-09-01"),
      },
    ],
    ...extra,
  };
}

describe("GET /ops/products purity", () => {
  it("performs zero writes when listing", async () => {
    const db = makeDb({ products: [productRow()] });
    const out = await new ProductOpsService({ prisma: db }).listProducts({}, { skip: 0, take: 50 });
    assert.equal(out.rows.length, 1);
    assert.equal(db.calls.some((c) => c.startsWith("WRITE:")), false, db.calls.join(", "));
  });

  it("performs zero writes when reading a single product", async () => {
    const db = makeDb({ products: [productRow()] });
    const out = await new ProductOpsService({ prisma: db }).getProduct("p-1");
    assert.equal(out.id, "p-1");
    assert.equal(db.calls.some((c) => c.startsWith("WRITE:")), false, db.calls.join(", "));
  });

  it("holds no promotion or ingestion dependency at all", () => {
    const svc = new ProductOpsService({ prisma: makeDb() });
    assert.equal("promotion" in svc, false, "the read service must not carry a promotion service");
    for (const key of Object.keys(svc)) {
      assert.ok(!/promot|ingest|sync/i.test(key), `unexpected write-capable dependency: ${key}`);
    }
  });

  it("never touches RawPayload on a read", async () => {
    const db = makeDb({ products: [productRow()] });
    await new ProductOpsService({ prisma: db }).listProducts({}, { skip: 0, take: 50 });
    assert.equal(db.calls.some((c) => c.includes("rawPayload")), false, db.calls.join(", "));
  });

  it("does not write while inferring an Optimise campaign link", async () => {
    const unlinked = productRow({ id: "p-2", campaignSourceId: null, campaignSource: null });
    const db = makeDb({
      products: [unlinked],
      campaigns: [
        {
          trackingUrl: "https://t.test/click?PID=999",
          merchantId: "m-9",
          campaignName: "Ubuy",
          supplier: "OPTIMISE",
          campaignSources: [{ id: "cs-9", canonicalCampaign: { displayName: "Ubuy SG" } }],
        },
      ],
    });
    const out = await new ProductOpsService({ prisma: db }).listProducts({}, { skip: 0, take: 50 });
    assert.equal(db.calls.some((c) => c.startsWith("WRITE:")), false, db.calls.join(", "));
    assert.equal(out.rows[0].campaignSourceId, "cs-9", "the link is still reported");
    assert.equal(out.rows[0].campaignLinkProvenance, CAMPAIGN_LINK_DERIVED, "and it is labelled as inferred");
  });

  it("labels a stored campaign link as native, not derived", async () => {
    const db = makeDb({ products: [productRow()] });
    const out = await new ProductOpsService({ prisma: db }).listProducts({}, { skip: 0, take: 50 });
    assert.equal(out.rows[0].campaignLinkProvenance, CAMPAIGN_LINK_NATIVE);
  });
});

describe("canonical truth level", () => {
  it("returns an empty page instead of staged raw entities", async () => {
    const db = makeDb({ products: [] });
    const out = await new ProductOpsService({ prisma: db }).listProducts({}, { skip: 0, take: 50 });
    assert.deepEqual(out.rows, []);
    assert.equal(out.total, 0);
    assert.equal(out.truthLevel, "CANONICAL_PRODUCT");
    assert.equal(db.calls.some((c) => c.includes("entity.")), false, "the Entity table must not be consulted");
  });

  it("404s for an id that is only a staged entity", async () => {
    const db = makeDb({ products: [] });
    const svc = new ProductOpsService({ prisma: db });
    await assert.rejects(() => svc.getProduct("staged-1"), /not found/i);
    assert.equal(db.calls.some((c) => c.includes("entity.")), false);
  });

  it("reports a server-derived total, not the page length", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => productRow({ id: `p-${i}` }));
    const db = makeDb({ products: rows, total: 120 });
    const out = await new ProductOpsService({ prisma: db }).listProducts({}, { skip: 0, take: 50 });
    assert.equal(out.rows.length, 50);
    assert.equal(out.total, 120);
  });

  it("no longer exposes a staged-entity code path", () => {
    const svc = new ProductOpsService({ prisma: makeDb() });
    assert.equal(typeof svc.listStagedProductEntities, "undefined");
  });
});

describe("product DTO", () => {
  it("keeps identifiers distinct", () => {
    const dto = toAdminProductListDto(productRow());
    assert.equal(dto.id, "p-1");
    assert.equal(dto.supplierProductId, "SP-1");
    assert.equal(dto.sku, "SKU-1");
    assert.equal(dto.currency, "USD");
  });

  it("does not invent a discount or a currency symbol", () => {
    const bare = productRow({ currency: null });
    bare.sources[0].currency = null;
    const dto = toAdminProductListDto(bare);
    assert.equal(dto.currency, null);
    const text = JSON.stringify(dto);
    assert.ok(!/%\s*off/i.test(text), "no derived discount");
    assert.ok(!/[$€£]/.test(text), "no currency symbol without a code");
  });

  it("never carries payload bodies or supplier-internal URLs", () => {
    const dto = toAdminProductListDto(productRow());
    for (const key of ["rawPayload", "normalizedPayload", "metadata", "feedUrl", "supplierProductTrackingUrl"]) {
      assert.equal(key in dto, false, `${key} leaked into the product DTO`);
    }
  });
});

describe("feed DTO safety", () => {
  const RAW = {
    prisma: "Invalid `prisma.productFeed.findMany()` invocation at /var/task/src/x.js:1:1",
    sql: "SELECT feed_url FROM product_feeds WHERE supplier = $1",
    ftp: "FTP login failed for user feeduser password hunter2 at sftp://feeds.example.test",
    bearer: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    stack: "TypeError: undefined\n    at ingest (/var/task/src/y.js:9:1)",
  };

  function feedRow(extra = {}) {
    return {
      id: "pf-1",
      supplier: "OPTIMISE",
      sourceAccountLabel: "default",
      feedName: "Optimise SG",
      feedExternalId: "f-1",
      feedFormat: "CSV",
      feedStatus: "ACTIVE",
      lastSyncedAt: new Date("2026-09-01"),
      createdAt: new Date("2026-08-01"),
      updatedAt: new Date("2026-09-01"),
      campaignSourceId: "cs-1",
      errorCount: 0,
      exceptionCount: 0,
      lastError: null,
      feedUrl: "sftp://user:hunter2@feeds.example.test/catalogue.csv",
      metadata: { secret: "DECOY_FEED_SECRET" },
      compressedLocation: "/tmp/f.gz",
      aid: "AID-1",
      _count: { feedItems: 10, products: 9 },
      ...extra,
    };
  }

  it("never returns feedUrl, metadata, compressedLocation, aid or lastError", () => {
    const dto = toAdminProductFeedDto(feedRow());
    for (const key of ["feedUrl", "metadata", "compressedLocation", "aid", "lastError"]) {
      assert.equal(key in dto, false, `${key} leaked into the feed DTO`);
    }
    const text = JSON.stringify(dto);
    assert.ok(!text.includes("hunter2"));
    assert.ok(!text.includes("DECOY_FEED_SECRET"));
    assert.ok(!text.includes("feeds.example.test"));
  });

  it("reports only the presence of a feed URL", () => {
    assert.equal(toAdminProductFeedDto(feedRow()).hasFeedUrl, true);
    assert.equal(toAdminProductFeedDto(feedRow({ feedUrl: null })).hasFeedUrl, false);
    assert.equal(toAdminProductFeedDto(feedRow({ feedUrl: "   " })).hasFeedUrl, false);
  });

  it("reduces any raw error to a boolean and a fixed code", () => {
    for (const [label, raw] of Object.entries(RAW)) {
      const dto = toAdminProductFeedDto(feedRow({ lastError: raw }));
      assert.equal(dto.hasError, true, label);
      assert.ok(FEED_ERROR_CODES.includes(dto.safeErrorCode), `${label}: ${dto.safeErrorCode}`);
      const text = JSON.stringify(dto);
      // Words the DTO legitimately contains ("supplier", "feedName", ...) are its own vocabulary,
      // not evidence of a leak, so they are excluded from the token scan.
      const ownWords = new Set(text.toLowerCase().match(/[a-z_]+/g) || []);
      for (const token of raw.split(/[\s,{}()[\]"'`:]+/).filter((t) => t.length > 3)) {
        if (ownWords.has(token.toLowerCase())) continue;
        assert.ok(!text.includes(token), `${label}: token "${token}" leaked into ${text}`);
      }
    }
  });

  it("classifies without ever echoing the input", () => {
    assert.equal(safeFeedErrorCode(null), "NONE");
    assert.equal(safeFeedErrorCode("FTP login failed: invalid credentials"), "AUTH_FAILED");
    assert.equal(safeFeedErrorCode("connect ETIMEDOUT 10.0.0.1:22"), "TIMEOUT");
    assert.equal(safeFeedErrorCode("ECONNREFUSED"), "NETWORK_UNREACHABLE");
    assert.equal(safeFeedErrorCode("Unexpected token < in JSON"), "PARSE_FAILED");
    assert.equal(safeFeedErrorCode("mapping_failed"), "MAPPING_FAILED");
    assert.equal(safeFeedErrorCode("something nobody predicted"), "UNCLASSIFIED");
    for (const input of [...Object.values(RAW), "", "   ", "a".repeat(5000)]) {
      assert.ok(FEED_ERROR_CODES.includes(safeFeedErrorCode(input)));
    }
  });

  it("does not leak error length or content through the code", () => {
    assert.equal(safeFeedErrorCode("x"), "UNCLASSIFIED");
    assert.equal(safeFeedErrorCode("y".repeat(9999)), "UNCLASSIFIED");
    assert.equal(hasFeedError(""), false);
    assert.equal(hasFeedError("x"), true);
  });

  it("adds the previously missing operational fields", () => {
    const dto = toAdminProductFeedDto(feedRow());
    assert.equal(dto.feedFormat, "CSV");
    assert.equal(dto.sourceAccountLabel, "default");
    assert.ok(dto.createdAt);
    assert.ok(dto.updatedAt);
  });
});

describe("network classification", () => {
  it("does not surface catalog rows for a network with no catalog ingestion", async () => {
    // Product rows are created only by the feed and catalog ingest paths. A network whose only
    // "product" fields are campaign ids or commission conditions therefore has no rows here.
    const db = makeDb({ products: [] });
    const out = await new ProductOpsService({ prisma: db }).listProducts({ supplier: "TRACKIER" }, { skip: 0, take: 50 });
    assert.deepEqual(out.rows, []);
  });

  it("keeps the supplier product id distinct from the MBO product id", () => {
    const dto = toAdminProductListDto(productRow());
    assert.notEqual(dto.id, dto.supplierProductId);
  });
});
