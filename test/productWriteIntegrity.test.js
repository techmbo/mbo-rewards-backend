/**
 * Product write integrity: request validation for the two direct product-write APIs and the
 * campaign-assignment ownership guard in ClientProductService.
 *
 * Controller cases run the real Express app (real router, auth, permission and error handler)
 * as an ADMIN with the product services replaced by recorders, so a rejected body proves the
 * service was never called and an accepted body proves exactly which fields were forwarded.
 * Service cases use an in-memory Prisma double with write counters, so a rejected campaign
 * assignment proves no ClientProductAssignment or ProductTrackingLink row was written.
 */
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const { prisma } = await import("../src/database/prisma.js");
const { signAccessToken } = await import("../src/modules/auth/auth.service.js");
const { ProductFeedService, ClientProductService } = await import(
  "../src/modules/product/productFeed.service.js"
);
const schemas = await import("../src/modules/product/productWrite.schemas.js");
const { NETWORK_MAPPINGS_ROOT, loadMappingDefinition } = await import("../src/modules/mapping/loader.js");
const { mapPayload } = await import("../src/modules/mapping/engine.js");
const { createApp } = await import("../src/app.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTROLLER_SOURCE = fs.readFileSync(path.join(HERE, "../src/controllers/productFeed.controller.js"), "utf8");
const SERVICE_SOURCE = fs.readFileSync(path.join(HERE, "../src/modules/product/productFeed.service.js"), "utf8");
const SCHEMA_SOURCE = fs.readFileSync(path.join(HERE, "../src/modules/product/productWrite.schemas.js"), "utf8");
const PRISMA_SCHEMA = fs.readFileSync(path.join(HERE, "../prisma/schema.prisma"), "utf8");
const ROUTES_SOURCE = fs.readFileSync(path.join(HERE, "../src/routes/index.js"), "utf8");

const ADMIN = { id: "user-admin", email: "admin@mbo.test", name: "Admin", role: "ADMIN", clientId: null, isActive: true };

function rowsOf(n) {
  return Array.from({ length: n }, (_, i) => ({ product_id: `p-${i}`, title: `Product ${i}` }));
}

// ─── HTTP harness ───────────────────────────────────────────────────────────────────────────

function startServer() {
  const app = createApp();
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/api`,
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
    server.on("error", reject);
  });
}

async function post(baseUrl, routePath, token, body) {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}

function installPrismaDoubles() {
  const originals = { user: prisma.user, accessLog: prisma.accessLog };
  prisma.user = { async findUnique({ where }) { return where.id === ADMIN.id ? ADMIN : null; } };
  prisma.accessLog = { async create({ data }) { return { id: "log", ...data }; } };
  return () => {
    prisma.user = originals.user;
    prisma.accessLog = originals.accessLog;
  };
}

function installServiceRecorders(calls) {
  const restore = [];
  const stub = (proto, name, impl) => {
    const original = proto[name];
    assert.equal(typeof original, "function");
    proto[name] = impl;
    restore.push(() => { proto[name] = original; });
  };
  stub(ProductFeedService.prototype, "ingestFeedBatch", async function (input) {
    calls.push({ method: "ingestFeedBatch", input });
    return { feed: { id: "feed-1" }, summary: { feedId: "feed-1", processed: input.rows.length, created: input.rows.length, updated: 0, failed: 0, errors: [] } };
  });
  stub(ClientProductService.prototype, "assignProductToClient", async function (input) {
    calls.push({ method: "assignProductToClient", input });
    return { ok: true, assignment: { id: "cpa-1", ...input }, trackingLink: { id: "ptl-1" } };
  });
  return () => restore.reverse().forEach((fn) => fn());
}

function assertValidation400(status, json) {
  assert.equal(status, 400, JSON.stringify(json));
  assert.equal(json.ok, false);
  assert.equal(typeof json.message, "string");
  assert.match(json.message, /^Invalid request body: /);
  assert.doesNotMatch(JSON.stringify(json), /ZodError|issues|stack|node_modules/);
  assert.deepEqual(Object.keys(json).sort(), ["message", "ok"]);
}

// ─── service-level Prisma double ────────────────────────────────────────────────────────────

function makeServiceDb({ products = {}, campaignAssignments = {}, existingAssignments = {} } = {}) {
  const writes = { assignmentCreate: 0, assignmentUpdate: 0, linkCreate: 0, linkUpdate: 0, linkRevoke: 0 };
  const assignments = new Map(Object.entries(existingAssignments));
  const links = new Map();
  const db = {
    writes,
    assignments,
    links,
    product: { async findUnique({ where }) { return products[where.id] ?? null; } },
    clientCampaignAssignment: {
      async findUnique({ where }) {
        return campaignAssignments[where.id] ?? null;
      },
    },
    clientProductAssignment: {
      async findUnique({ where }) {
        const k = where.clientId_productId;
        return [...assignments.values()].find((a) => a.clientId === k.clientId && a.productId === k.productId) ?? null;
      },
      async create({ data }) {
        writes.assignmentCreate += 1;
        const row = { id: `cpa-${assignments.size + 1}`, ...data };
        assignments.set(row.id, row);
        return row;
      },
      async update({ where, data }) {
        writes.assignmentUpdate += 1;
        const row = { ...assignments.get(where.id), ...data };
        assignments.set(where.id, row);
        return row;
      },
    },
    productTrackingLink: {
      async findFirst({ where }) {
        return [...links.values()].find((l) => l.clientId === where.clientId && l.productId === where.productId && l.status === where.status) ?? null;
      },
      async create({ data }) {
        writes.linkCreate += 1;
        const row = { id: `ptl-${links.size + 1}`, ...data };
        links.set(row.id, row);
        return row;
      },
      async update({ where, data }) {
        writes.linkUpdate += 1;
        const row = { ...links.get(where.id), ...data };
        links.set(where.id, row);
        return row;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const [id, l] of links) {
          if (l.clientId === where.clientId && l.productId === where.productId && l.status === where.status) {
            links.set(id, { ...l, ...data });
            count += 1;
          }
        }
        writes.linkRevoke += count;
        return { count };
      },
    },
  };
  return db;
}

const PUBLISHABLE = { id: "prod-1", title: "Shoe", url: "https://brand.example/shoe", supplierProductTrackingUrl: "https://supplier.example/track", feedStatus: "ACTIVE", status: "ACTIVE" };
const CAMPAIGN_A = { id: "asg-a", clientId: "client-a", published: true, status: "ACTIVE" };
const CAMPAIGN_B = { id: "asg-b", clientId: "client-b", published: true, status: "ACTIVE" };

function makeService(db) {
  return new ClientProductService({ prisma: db, exceptions: { report: async () => ({}) } });
}

// ─── 1. supplier allow-list is derived from real product mappings ───────────────────────────

describe("product write integrity — supplier allow-list", () => {
  it("pins the discovered product-mapped suppliers", () => {
    assert.deepEqual([...schemas.PRODUCT_INGEST_SUPPLIERS], ["IMPACT", "OPTIMISE", "PARTNERIZE"]);
    assert.ok(Object.isFrozen(schemas.PRODUCT_INGEST_SUPPLIERS));
  });

  it("every listed supplier has a loadable products mapping and mapPayload accepts an object row for it", () => {
    for (const supplier of schemas.PRODUCT_INGEST_SUPPLIERS) {
      const definition = loadMappingDefinition(supplier, "products");
      assert.ok(definition, supplier);
      const mapped = mapPayload({ supplier, resourceKey: "products", payload: { anything: 1 } });
      assert.ok(!mapped.errors?.some((e) => e.code === "MAPPING_NOT_FOUND"), `${supplier} mapping not found`);
    }
  });

  it("no other supplier directory carries a products mapping (the list is complete)", () => {
    const dirs = fs.readdirSync(NETWORK_MAPPINGS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const withProducts = dirs.filter((d) => fs.readdirSync(path.join(NETWORK_MAPPINGS_ROOT, d)).some((f) => /^products.*\.mapping\.json$/.test(f)));
    assert.deepEqual(withProducts.map((d) => d.toUpperCase()).sort(), [...schemas.PRODUCT_INGEST_SUPPLIERS]);
    assert.ok(dirs.length > withProducts.length, "there are suppliers without a products mapping, so the allow-list is a real restriction");
    for (const supplier of ["AWIN", "BOOSTINY", "RAKUTEN", "CJ", "TRACKIER", "ADMITAD", "UNKNOWN"]) {
      assert.equal(schemas.PRODUCT_INGEST_SUPPLIERS.includes(supplier), false, supplier);
    }
  });

  it("enums mirror the Prisma schema exactly", () => {
    const enumValues = (name) =>
      PRISMA_SCHEMA.match(new RegExp(`enum ${name} \\{([^}]*)\\}`))[1].split("\n").map((l) => l.trim()).filter(Boolean);
    assert.deepEqual([...schemas.PRODUCT_FEED_FORMATS], enumValues("ProductFeedFormat"));
    assert.deepEqual([...schemas.CLIENT_PRODUCT_ASSIGNMENT_STATUSES], enumValues("ClientProductAssignmentStatus"));
    assert.equal(schemas.PRODUCT_INGEST_MAX_ROWS, 500);
  });
});

// ─── 2. controller: ingest ──────────────────────────────────────────────────────────────────

describe("product write integrity — POST /ops/product-feeds/ingest (real app, ADMIN)", () => {
  const calls = [];
  let server = null;
  let restorePrisma = null;
  let restoreServices = null;
  let token = null;
  const INGEST = "/ops/product-feeds/ingest";

  before(async () => {
    server = await startServer();
    restorePrisma = installPrismaDoubles();
    restoreServices = installServiceRecorders(calls);
    token = signAccessToken(ADMIN);
  });
  after(async () => {
    restoreServices?.();
    restorePrisma?.();
    if (server) await server.close();
  });
  beforeEach(() => { calls.length = 0; });

  it("1. supported supplier + 1 row -> 201, reaches ingestFeedBatch", async () => {
    const { status, json } = await post(server.baseUrl, INGEST, token, { supplier: "PARTNERIZE", rows: rowsOf(1) });
    assert.equal(status, 201, JSON.stringify(json));
    assert.equal(json.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].input.supplier, "PARTNERIZE");
    assert.equal(calls[0].input.rows.length, 1);
  });

  it("2. supplier lower/mixed case is normalized to the canonical key", async () => {
    for (const [given, expected] of [["optimise", "OPTIMISE"], ["Impact", "IMPACT"], [" partnerize ", "PARTNERIZE"]]) {
      calls.length = 0;
      const { status } = await post(server.baseUrl, INGEST, token, { supplier: given, rows: rowsOf(1) });
      assert.equal(status, 201, given);
      assert.equal(calls[0].input.supplier, expected);
    }
  });

  it("3. unknown supplier -> 400, service not called", async () => {
    for (const supplier of ["AWIN", "boostiny", "RAKUTEN", "UNKNOWN", "", "DROP TABLE"]) {
      const { status, json } = await post(server.baseUrl, INGEST, token, { supplier, rows: rowsOf(1) });
      assertValidation400(status, json);
      assert.match(json.message, /^Invalid request body: supplier /, supplier);
    }
    assert.deepEqual(calls, []);
  });

  it("4. rows missing -> 400", async () => {
    const { status, json } = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE" });
    assertValidation400(status, json);
    assert.match(json.message, /rows/);
    assert.deepEqual(calls, []);
  });

  it("5. rows not an array -> 400", async () => {
    for (const rows of ["row", 5, { product_id: "x" }, null, true]) {
      const { status, json } = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE", rows });
      assertValidation400(status, json);
      assert.match(json.message, /rows/);
    }
    assert.deepEqual(calls, []);
  });

  it("6. rows empty -> 400", async () => {
    const { status, json } = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE", rows: [] });
    assertValidation400(status, json);
    assert.equal(json.message, "Invalid request body: rows must contain at least 1 row");
    assert.deepEqual(calls, []);
  });

  it("7. rows length 500 -> accepted, all 500 forwarded", async () => {
    const { status } = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE", rows: rowsOf(500) });
    assert.equal(status, 201);
    assert.equal(calls[0].input.rows.length, 500);
  });

  it("8. rows length 501 -> 400, service not called, nothing sliced", async () => {
    const { status, json } = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE", rows: rowsOf(501) });
    assertValidation400(status, json);
    assert.equal(json.message, "Invalid request body: rows must contain at most 500 rows");
    assert.deepEqual(calls, []);
  });

  it("8b. a non-object row -> 400 before any per-row work", async () => {
    const { status, json } = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE", rows: [{ a: 1 }, "not-a-row"] });
    assertValidation400(status, json);
    assert.equal(json.message, "Invalid request body: rows.1 each row must be an object");
    assert.deepEqual(calls, []);
  });

  it("9. invalid feedFormat -> 400; valid formats accepted case-insensitively", async () => {
    const bad = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE", rows: rowsOf(1), feedFormat: "PDF" });
    assertValidation400(bad.status, bad.json);
    assert.equal(bad.json.message, "Invalid request body: feedFormat must be one of CSV, XML, JSON, GOOGLE_SHOPPING, UNKNOWN");
    assert.deepEqual(calls, []);
    for (const [given, expected] of [["csv", "CSV"], ["XML", "XML"], ["google_shopping", "GOOGLE_SHOPPING"], ["unknown", "UNKNOWN"]]) {
      calls.length = 0;
      const { status } = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE", rows: rowsOf(1), feedFormat: given });
      assert.equal(status, 201, given);
      assert.equal(calls[0].input.feedFormat, expected);
    }
  });

  it("10. object or array supplied for a string optional field -> 400", async () => {
    const fields = ["sourceAccountLabel", "campaignSourceId", "feedExternalId", "feedName", "feedUrl", "aid", "compressedLocation", "creativeId", "countryHint", "merchantId"];
    for (const field of fields) {
      for (const value of [{ nested: true }, ["x"], 42]) {
        const { status, json } = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE", rows: rowsOf(1), [field]: value });
        assertValidation400(status, json);
        assert.match(json.message, new RegExp(`^Invalid request body: ${field} `), `${field}=${JSON.stringify(value)}`);
      }
    }
    assert.deepEqual(calls, []);
  });

  it("11. oversized optional string -> 400; boundary length accepted", async () => {
    const limits = { sourceAccountLabel: 64, campaignSourceId: 64, feedExternalId: 128, feedName: 256, feedUrl: 2048, aid: 64, compressedLocation: 2048, creativeId: 64, countryHint: 8, merchantId: 64 };
    for (const [field, max] of Object.entries(limits)) {
      const over = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE", rows: rowsOf(1), [field]: "x".repeat(max + 1) });
      assertValidation400(over.status, over.json);
      assert.equal(over.json.message, `Invalid request body: ${field} must be at most ${max} characters`);
      calls.length = 0;
      const atMax = await post(server.baseUrl, INGEST, token, { supplier: "OPTIMISE", rows: rowsOf(1), [field]: "x".repeat(max) });
      assert.equal(atMax.status, 201, field);
      assert.equal(calls[0].input[field], "x".repeat(max));
    }
  });

  it("12. every validation failure above produced no service call; null optionals still mean 'not provided'", async () => {
    calls.length = 0;
    const { status } = await post(server.baseUrl, INGEST, token, {
      supplier: "IMPACT",
      rows: rowsOf(2),
      sourceAccountLabel: null,
      campaignSourceId: null,
      feedExternalId: null,
      feedName: null,
      feedUrl: null,
      feedFormat: null,
      aid: null,
      compressedLocation: null,
      creativeId: null,
      countryHint: null,
      merchantId: null,
    });
    assert.equal(status, 201);
    assert.deepEqual(calls[0].input, {
      supplier: "IMPACT",
      sourceAccountLabel: "default",
      campaignSourceId: null,
      feedExternalId: "default",
      feedName: null,
      feedUrl: null,
      feedFormat: "JSON",
      aid: null,
      compressedLocation: null,
      creativeId: null,
      countryHint: null,
      merchantId: null,
      rows: rowsOf(2),
    });
  });

  it("ingest forwards exactly the thirteen allow-listed fields and drops unknown body keys", async () => {
    const { status } = await post(server.baseUrl, INGEST, token, {
      supplier: "OPTIMISE",
      rows: rowsOf(1),
      feedName: "Feed",
      feedUrl: "https://feeds.example/x.csv",
      mappingVersion: "evil",
      feedStatus: "ERROR",
      metadata: { injected: true },
      id: "feed-override",
    });
    assert.equal(status, 201);
    assert.deepEqual(Object.keys(calls[0].input).sort(), [
      "aid", "campaignSourceId", "compressedLocation", "countryHint", "creativeId", "feedExternalId",
      "feedFormat", "feedName", "feedUrl", "merchantId", "rows", "sourceAccountLabel", "supplier",
    ]);
  });

  it("a non-object body -> 400, service not called", async () => {
    for (const body of [[1, 2], "text", 7, null]) {
      const { status, json } = await post(server.baseUrl, INGEST, token, body);
      assert.equal(status, 400, JSON.stringify(body));
      assert.equal(json.ok, false);
    }
    assert.deepEqual(calls, []);
  });
});

// ─── 3. controller: assign ──────────────────────────────────────────────────────────────────

describe("product write integrity — POST /ops/client-products/assign (real app, ADMIN)", () => {
  const calls = [];
  let server = null;
  let restorePrisma = null;
  let restoreServices = null;
  let token = null;
  const ASSIGN = "/ops/client-products/assign";

  before(async () => {
    server = await startServer();
    restorePrisma = installPrismaDoubles();
    restoreServices = installServiceRecorders(calls);
    token = signAccessToken(ADMIN);
  });
  after(async () => {
    restoreServices?.();
    restorePrisma?.();
    if (server) await server.close();
  });
  beforeEach(() => { calls.length = 0; });

  it("13. clientId missing -> 400, service not called", async () => {
    for (const body of [{ productId: "prod-1" }, { clientId: "", productId: "prod-1" }, { clientId: "   ", productId: "prod-1" }, { clientId: null, productId: "prod-1" }, { clientId: 12, productId: "prod-1" }]) {
      const { status, json } = await post(server.baseUrl, ASSIGN, token, body);
      assertValidation400(status, json);
      assert.match(json.message, /^Invalid request body: clientId /, JSON.stringify(body));
    }
    assert.deepEqual(calls, []);
  });

  it("14. productId missing -> 400, service not called", async () => {
    for (const body of [{ clientId: "client-a" }, { clientId: "client-a", productId: "" }, { clientId: "client-a", productId: ["prod-1"] }]) {
      const { status, json } = await post(server.baseUrl, ASSIGN, token, body);
      assertValidation400(status, json);
      assert.match(json.message, /^Invalid request body: productId /, JSON.stringify(body));
    }
    assert.deepEqual(calls, []);
  });

  for (const status of ["ACTIVE", "PAUSED", "EXPIRED"]) {
    it(`${status === "ACTIVE" ? "15" : status === "PAUSED" ? "16" : "17"}. status ${status} accepted and forwarded verbatim`, async () => {
      const res = await post(server.baseUrl, ASSIGN, token, { clientId: "client-a", productId: "prod-1", status });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      assert.equal(calls[0].input.status, status);
    });
  }

  it("18. invalid status -> 400, service not called", async () => {
    for (const status of ["BOGUS", "active", "REVOKED", "", null, 1, ["ACTIVE"]]) {
      const res = await post(server.baseUrl, ASSIGN, token, { clientId: "client-a", productId: "prod-1", status });
      assertValidation400(res.status, res.json);
      assert.equal(res.json.message, "Invalid request body: status must be one of ACTIVE, PAUSED, EXPIRED", JSON.stringify(status));
    }
    assert.deepEqual(calls, []);
  });

  it("19. omitted status -> service receives ACTIVE; omitted campaign assignment -> null", async () => {
    const res = await post(server.baseUrl, ASSIGN, token, { clientId: "client-a", productId: "prod-1" });
    assert.equal(res.status, 201);
    assert.deepEqual(calls[0].input, { clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: null, status: "ACTIVE" });
  });

  it("20. unexpected extra body fields are not forwarded; ids are trimmed", async () => {
    const res = await post(server.baseUrl, ASSIGN, token, {
      clientId: " client-a ",
      productId: "prod-1",
      clientCampaignAssignmentId: "asg-a",
      publishedAt: "2020-01-01T00:00:00Z",
      metadata: { injected: true },
      id: "cpa-override",
      role: "ADMIN",
    });
    assert.equal(res.status, 201);
    assert.deepEqual(calls[0].input, { clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-a", status: "ACTIVE" });
  });

  it("service guard reasons keep the 409 contract", async () => {
    const original = ClientProductService.prototype.assignProductToClient;
    ClientProductService.prototype.assignProductToClient = async () => ({ ok: false, reason: "campaign_assignment_client_mismatch" });
    try {
      const mismatch = await post(server.baseUrl, ASSIGN, token, { clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-b" });
      assert.equal(mismatch.status, 409);
      assert.equal(mismatch.json.message, "campaign_assignment_client_mismatch");
      ClientProductService.prototype.assignProductToClient = async () => ({ ok: false, reason: "campaign_assignment_not_found" });
      const missing = await post(server.baseUrl, ASSIGN, token, { clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-x" });
      assert.equal(missing.status, 409);
      assert.equal(missing.json.message, "campaign_assignment_not_found");
    } finally {
      ClientProductService.prototype.assignProductToClient = original;
    }
  });
});

// ─── 4. service integrity ───────────────────────────────────────────────────────────────────

describe("product write integrity — ClientProductService.assignProductToClient ownership guard", () => {
  it("21. campaign assignment belongs to the same client -> assignment and link are written", async () => {
    const db = makeServiceDb({ products: { "prod-1": PUBLISHABLE }, campaignAssignments: { "asg-a": CAMPAIGN_A } });
    const result = await makeService(db).assignProductToClient({ clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-a" });
    assert.equal(result.ok, true);
    assert.equal(result.assignment.clientCampaignAssignmentId, "asg-a");
    assert.equal(result.trackingLink.clientCampaignAssignmentId, "asg-a");
    assert.deepEqual(db.writes, { assignmentCreate: 1, assignmentUpdate: 0, linkCreate: 1, linkUpdate: 0, linkRevoke: 0 });
  });

  it("22. campaign assignment does not exist -> no assignment or link writes", async () => {
    const db = makeServiceDb({ products: { "prod-1": PUBLISHABLE }, campaignAssignments: { "asg-a": CAMPAIGN_A } });
    const result = await makeService(db).assignProductToClient({ clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-missing" });
    assert.equal(result.ok, false);
    assert.deepEqual(db.writes, { assignmentCreate: 0, assignmentUpdate: 0, linkCreate: 0, linkUpdate: 0, linkRevoke: 0 });
    assert.equal(db.assignments.size, 0);
    assert.equal(db.links.size, 0);
  });

  it("23. campaign assignment belongs to another client -> no assignment or link writes", async () => {
    const db = makeServiceDb({ products: { "prod-1": PUBLISHABLE }, campaignAssignments: { "asg-a": CAMPAIGN_A, "asg-b": CAMPAIGN_B } });
    const result = await makeService(db).assignProductToClient({ clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-b" });
    assert.equal(result.ok, false);
    assert.deepEqual(db.writes, { assignmentCreate: 0, assignmentUpdate: 0, linkCreate: 0, linkUpdate: 0, linkRevoke: 0 });
    assert.equal(db.assignments.size, 0);
    assert.equal(db.links.size, 0);
  });

  it("24. mismatch reason is exactly campaign_assignment_client_mismatch", async () => {
    const db = makeServiceDb({ products: { "prod-1": PUBLISHABLE }, campaignAssignments: { "asg-b": CAMPAIGN_B } });
    const result = await makeService(db).assignProductToClient({ clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-b" });
    assert.deepEqual(result, { ok: false, reason: "campaign_assignment_client_mismatch" });
  });

  it("25. not-found reason is exactly campaign_assignment_not_found", async () => {
    const db = makeServiceDb({ products: { "prod-1": PUBLISHABLE } });
    const result = await makeService(db).assignProductToClient({ clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-missing" });
    assert.deepEqual(result, { ok: false, reason: "campaign_assignment_not_found" });
  });

  it("26. an existing assignment cannot have its clientCampaignAssignmentId replaced by another client's assignment", async () => {
    const existing = { id: "cpa-1", clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-a", status: "ACTIVE", publishedAt: new Date("2026-01-01") };
    const db = makeServiceDb({
      products: { "prod-1": PUBLISHABLE },
      campaignAssignments: { "asg-a": CAMPAIGN_A, "asg-b": CAMPAIGN_B },
      existingAssignments: { "cpa-1": existing },
    });
    const result = await makeService(db).assignProductToClient({ clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-b", status: "PAUSED" });
    assert.deepEqual(result, { ok: false, reason: "campaign_assignment_client_mismatch" });
    assert.deepEqual(db.writes, { assignmentCreate: 0, assignmentUpdate: 0, linkCreate: 0, linkUpdate: 0, linkRevoke: 0 });
    assert.equal(db.assignments.get("cpa-1").clientCampaignAssignmentId, "asg-a");
    assert.equal(db.assignments.get("cpa-1").status, "ACTIVE");
  });

  it("26b. the same client's assignment can still be updated (status change, campaign kept)", async () => {
    const existing = { id: "cpa-1", clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-a", status: "ACTIVE", publishedAt: new Date("2026-01-01") };
    const db = makeServiceDb({ products: { "prod-1": PUBLISHABLE }, campaignAssignments: { "asg-a": CAMPAIGN_A }, existingAssignments: { "cpa-1": existing } });
    const result = await makeService(db).assignProductToClient({ clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-a", status: "PAUSED" });
    assert.equal(result.ok, true);
    // PAUSED publishes nothing: no link is minted, any ACTIVE link is revoked, trackingLink is null.
    assert.deepEqual(db.writes, { assignmentCreate: 0, assignmentUpdate: 1, linkCreate: 0, linkUpdate: 0, linkRevoke: 0 });
    assert.equal(result.trackingLink, null);
    assert.equal(db.assignments.get("cpa-1").status, "PAUSED");
  });

  it("guard order: product existence and publishability are still checked first, and the guard never touches the campaign table for them", async () => {
    const lookups = [];
    const db = makeServiceDb({ products: { "prod-nr": { ...PUBLISHABLE, id: "prod-nr", feedStatus: "NEEDS_REVIEW" } }, campaignAssignments: { "asg-b": CAMPAIGN_B } });
    const originalFind = db.clientCampaignAssignment.findUnique;
    db.clientCampaignAssignment.findUnique = async (args) => { lookups.push(args); return originalFind(args); };
    const svc = makeService(db);
    assert.deepEqual(await svc.assignProductToClient({ clientId: "client-a", productId: "nope", clientCampaignAssignmentId: "asg-b" }), { ok: false, reason: "product_not_found" });
    const notPublishable = await svc.assignProductToClient({ clientId: "client-a", productId: "prod-nr", clientCampaignAssignmentId: "asg-b" });
    assert.equal(notPublishable.reason, "product_not_publishable");
    assert.deepEqual(lookups, []);
    assert.deepEqual(db.writes, { assignmentCreate: 0, assignmentUpdate: 0, linkCreate: 0, linkUpdate: 0, linkRevoke: 0 });
  });

  it("regression: no clientCampaignAssignmentId -> behaves exactly as before (no campaign lookup, assignment + link written)", async () => {
    const lookups = [];
    const db = makeServiceDb({ products: { "prod-1": PUBLISHABLE } });
    db.clientCampaignAssignment.findUnique = async (args) => { lookups.push(args); return null; };
    const result = await makeService(db).assignProductToClient({ clientId: "client-a", productId: "prod-1" });
    assert.equal(result.ok, true);
    assert.equal(result.assignment.clientCampaignAssignmentId, null);
    assert.equal(result.assignment.status, "ACTIVE");
    assert.ok(result.trackingLink.mboProductTrackingUrl.includes("/t/product/"));
    assert.deepEqual(lookups, []);
    assert.deepEqual(db.writes, { assignmentCreate: 1, assignmentUpdate: 0, linkCreate: 1, linkUpdate: 0, linkRevoke: 0 });
    const explicitNull = makeServiceDb({ products: { "prod-1": PUBLISHABLE } });
    explicitNull.clientCampaignAssignment.findUnique = async (args) => { lookups.push(args); return null; };
    const nullResult = await makeService(explicitNull).assignProductToClient({ clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: null });
    assert.equal(nullResult.ok, true);
    assert.deepEqual(lookups, []);
  });
});

// ─── 5. static proofs ───────────────────────────────────────────────────────────────────────

describe("product write integrity — static proofs", () => {
  it("controllers parse the schema before the service call and forward explicit fields only", () => {
    const ingest = CONTROLLER_SOURCE.slice(CONTROLLER_SOURCE.indexOf("export async function ingestProductFeedHandler"), CONTROLLER_SOURCE.indexOf("export async function assignClientProductHandler"));
    const assign = CONTROLLER_SOURCE.slice(CONTROLLER_SOURCE.indexOf("export async function assignClientProductHandler"));
    assert.ok(ingest.indexOf("parseProductIngestBody(req.body)") < ingest.indexOf("feeds.ingestFeedBatch("));
    assert.ok(assign.indexOf("parseClientProductAssignBody(req.body)") < assign.indexOf("clientProducts.assignProductToClient("));
    assert.doesNotMatch(CONTROLLER_SOURCE, /\.\.\.req\.body|data:\s*req\.body|\.\.\.body\b/);
    assert.doesNotMatch(ingest, /req\.body\.[a-zA-Z]/);
    assert.doesNotMatch(assign, /req\.body\.[a-zA-Z]/);
    assert.match(assign, /throw fail\(result\.reason \|\| "assign_failed", 409\)/);
  });

  it("schema pins rows max 500 and the enums", () => {
    assert.match(SCHEMA_SOURCE, /export const PRODUCT_INGEST_MAX_ROWS = 500;/);
    assert.match(SCHEMA_SOURCE, /\.max\(PRODUCT_INGEST_MAX_ROWS,/);
    assert.match(SCHEMA_SOURCE, /discoverProductMappedSuppliers\(\)/);
    assert.doesNotMatch(SCHEMA_SOURCE, /\.slice\(0,\s*PRODUCT_INGEST_MAX_ROWS\)/);
  });

  it("service guard sits after publishability and before any assignment or link write", () => {
    const body = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf("async assignProductToClient("), SERVICE_SOURCE.indexOf("async unassignProduct("));
    const guard = body.indexOf('reason: "campaign_assignment_client_mismatch"');
    const notFound = body.indexOf('reason: "campaign_assignment_not_found"');
    const publishable = body.indexOf('reason: "product_not_publishable"');
    const firstWrite = Math.min(body.indexOf("clientProductAssignment.update("), body.indexOf("clientProductAssignment.create("), body.indexOf("productTrackingLink.create("));
    const firstAssignmentRead = body.indexOf("clientProductAssignment.findUnique(");
    assert.ok(publishable < notFound && notFound < guard, "guard after publishability");
    assert.ok(guard < firstAssignmentRead && guard < firstWrite, "guard before any assignment read or write");
    assert.match(body, /tx\.clientCampaignAssignment\.findUnique\(\{\s*where: \{ id: clientCampaignAssignmentId \}/);
    assert.match(body, /if \(clientCampaignAssignmentId != null\)/);
  });

  it("routes and permission gates are unchanged by this patch", () => {
    for (const line of [
      'router.post("/ops/product-feeds/ingest", authenticate, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), auditAction("products.feed_ingest", "ProductFeed"), ingestProductFeedHandler);',
      'router.post("/ops/client-products/assign", authenticate, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), auditAction("products.client_assign", (req) => `clients:${req.body?.clientId || "unknown"}`), assignClientProductHandler);',
      'router.post("/ops/products/sync-feeds", authenticate, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), auditAction("products.feed_sync", "ProductFeed"), syncProductFeedsHandler);',
    ]) {
      assert.ok(ROUTES_SOURCE.includes(line), line);
    }
    assert.equal((ROUTES_SOURCE.match(/PERMISSIONS\.PRODUCTS_MANAGE/g) || []).length, 3);
    assert.equal((ROUTES_SOURCE.match(/PERMISSIONS\.PRODUCTS_READ/g) || []).length, 5);
  });
});
