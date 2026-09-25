/**
 * Product read / write permission split.
 *
 * PRODUCTS_READ authorized the three product mutation routes (feed sync, feed ingest, client
 * product assignment), so ANALYST — a read-only role everywhere else — could ingest or overwrite
 * catalog products and publish them to any client. The writes now require PRODUCTS_MANAGE, held
 * by ADMIN, OPERATIONS and TECH, and each write carries an auditAction. The five product GET
 * routes stay on PRODUCTS_READ.
 *
 * Route tests run the real Express app (real router, real `authenticate`, `requirePermission`
 * and `auditAction`) with the user lookup, the access-log write and the product services
 * replaced in memory, so a denied request proves the handler and service were never reached and
 * a permitted request proves the audit row carries the actor.
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
const { PERMISSIONS, ROLE_PERMISSIONS, STAFF_USER_ROLES, USER_ROLES, getPermissionsForRole, roleHasPermission } =
  await import("../src/auth/permissions.js");
const { signAccessToken } = await import("../src/modules/auth/auth.service.js");
const { ProductFeedService, ClientProductService } = await import(
  "../src/modules/product/productFeed.service.js"
);
const { ProductOpsService } = await import("../src/modules/ops/productOps.service.js");
const { createApp } = await import("../src/app.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_SOURCE = fs.readFileSync(path.join(HERE, "../src/routes/index.js"), "utf8");
const PERMISSIONS_SOURCE = fs.readFileSync(path.join(HERE, "../src/auth/permissions.js"), "utf8");

const DENIED_403 = { ok: false, message: "You do not have permission to perform this action." };
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

// ─── fixtures ───────────────────────────────────────────────────────────────────────────────

const USERS = Object.fromEntries(
  USER_ROLES.map((role) => [
    role,
    {
      id: `user-${role.toLowerCase()}`,
      email: `${role.toLowerCase()}@mbo.test`,
      name: `${role} User`,
      role,
      clientId: role === "CLIENT" ? "client-a" : null,
      isActive: true,
    },
  ]),
);

const WRITE_ROUTES = [
  {
    method: "POST",
    path: "/ops/products/sync-feeds",
    body: { maxFeeds: 1, maxRowsPerFeed: 1 },
    service: null, // dynamic job import; proven by a 200 from the skipped-account path
    action: "products.feed_sync",
    resource: "ProductFeed",
    okStatus: 200,
  },
  {
    method: "POST",
    path: "/ops/product-feeds/ingest",
    body: { supplier: "PARTNERIZE", rows: [{ product_id: "p-1", title: "Shoe" }] },
    service: "ingestFeedBatch",
    action: "products.feed_ingest",
    resource: "ProductFeed",
    okStatus: 201,
  },
  {
    method: "POST",
    path: "/ops/client-products/assign",
    body: { clientId: "client-a", productId: "prod-1" },
    service: "assignProductToClient",
    action: "products.client_assign",
    resource: "clients:client-a",
    okStatus: 201,
  },
];

const READ_ROUTES = [
  { path: "/ops/products", service: "listProducts" },
  { path: "/ops/product-feeds", service: "productFeed.findMany" },
];

const PERMITTED = ["ADMIN", "OPERATIONS", "TECH"];
const DENIED = ["ANALYST", "SUPPORT", "CLIENT"];

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

async function call(baseUrl, { method = "GET", path: routePath, bearer, body } = {}) {
  const headers = { Accept: "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

/** Prisma doubles: user lookup for `authenticate`, access-log sink for `auditAction`,
 *  no-account marketplace lookups so the sync job takes its skipped path, empty feed table. */
function installPrismaDoubles(state) {
  const originals = {
    user: prisma.user,
    accessLog: prisma.accessLog,
    marketplaceAccount: prisma.marketplaceAccount,
    productFeed: prisma.productFeed,
  };
  prisma.user = {
    async findUnique({ where }) {
      return Object.values(USERS).find((u) => u.id === where.id) ?? null;
    },
  };
  prisma.accessLog = {
    async create({ data }) {
      state.accessLogs.push(data);
      return { id: `log-${state.accessLogs.length}`, ...data };
    },
  };
  prisma.marketplaceAccount = {
    async findMany() {
      return [];
    },
    async findUnique() {
      return null;
    },
    async findFirst() {
      return null;
    },
  };
  prisma.productFeed = {
    async findMany() {
      state.calls.push({ method: "productFeed.findMany" });
      return [];
    },
    async count() {
      return 0;
    },
  };
  return () => {
    prisma.user = originals.user;
    prisma.accessLog = originals.accessLog;
    prisma.marketplaceAccount = originals.marketplaceAccount;
    prisma.productFeed = originals.productFeed;
  };
}

/** Service recorders on the real prototypes so a forbidden call is visible. */
function installServiceRecorders(calls) {
  const restore = [];
  const stub = (proto, name, impl) => {
    const original = proto[name];
    assert.equal(typeof original, "function", `${name} must exist on the real service`);
    proto[name] = impl;
    restore.push(() => {
      proto[name] = original;
    });
  };
  stub(ProductFeedService.prototype, "ingestFeedBatch", async function (input) {
    calls.push({ method: "ingestFeedBatch", supplier: input.supplier, rows: input.rows?.length ?? 0 });
    return { feed: { id: "feed-1" }, summary: { feedId: "feed-1", processed: 1, created: 1, updated: 0, failed: 0, errors: [] } };
  });
  stub(ClientProductService.prototype, "assignProductToClient", async function (input) {
    calls.push({ method: "assignProductToClient", clientId: input.clientId, productId: input.productId, status: input.status });
    return { ok: true, assignment: { id: "cpa-1", clientId: input.clientId, productId: input.productId, status: input.status }, trackingLink: { id: "ptl-1" } };
  });
  stub(ProductOpsService.prototype, "listProducts", async function () {
    calls.push({ method: "listProducts" });
    return { rows: [], total: 0, contract: "test" };
  });
  return () => restore.reverse().forEach((fn) => fn());
}

/** Route registrations keyed by "METHOD path" with the full argument text (multi-line aware). */
function routeRegistrations(source) {
  const registrations = new Map();
  const pattern = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,([\s\S]*?)\);/g;
  let match;
  while ((match = pattern.exec(source))) {
    registrations.set(`${match[1].toUpperCase()} ${match[2]}`, match[3]);
  }
  return registrations;
}

// ─── 1. permission model ────────────────────────────────────────────────────────────────────

describe("PRODUCTS_MANAGE — permission model", () => {
  it("1. PRODUCTS_MANAGE === \"products:manage\" and PRODUCTS_READ is kept", () => {
    assert.equal(PERMISSIONS.PRODUCTS_MANAGE, "products:manage");
    assert.equal(PERMISSIONS.PRODUCTS_READ, "products:read");
    assert.equal(Object.values(PERMISSIONS).filter((v) => v === "products:manage").length, 1);
  });

  it("2. ADMIN has PRODUCTS_READ and PRODUCTS_MANAGE (inherited from Object.values)", () => {
    assert.ok(roleHasPermission("ADMIN", PERMISSIONS.PRODUCTS_READ));
    assert.ok(roleHasPermission("ADMIN", PERMISSIONS.PRODUCTS_MANAGE));
    assert.deepEqual(ROLE_PERMISSIONS.ADMIN, Object.values(PERMISSIONS));
  });

  it("3. OPERATIONS has PRODUCTS_READ and PRODUCTS_MANAGE", () => {
    assert.ok(roleHasPermission("OPERATIONS", PERMISSIONS.PRODUCTS_READ));
    assert.ok(roleHasPermission("OPERATIONS", PERMISSIONS.PRODUCTS_MANAGE));
  });

  it("4. TECH has PRODUCTS_READ and PRODUCTS_MANAGE", () => {
    assert.ok(roleHasPermission("TECH", PERMISSIONS.PRODUCTS_READ));
    assert.ok(roleHasPermission("TECH", PERMISSIONS.PRODUCTS_MANAGE));
  });

  it("5. ANALYST has PRODUCTS_READ but NOT PRODUCTS_MANAGE", () => {
    assert.ok(roleHasPermission("ANALYST", PERMISSIONS.PRODUCTS_READ));
    assert.equal(roleHasPermission("ANALYST", PERMISSIONS.PRODUCTS_MANAGE), false);
  });

  it("6. SUPPORT has neither product permission", () => {
    assert.equal(roleHasPermission("SUPPORT", PERMISSIONS.PRODUCTS_MANAGE), false);
    assert.equal(roleHasPermission("SUPPORT", PERMISSIONS.PRODUCTS_READ), false);
  });

  it("7. CLIENT has neither product permission", () => {
    assert.equal(roleHasPermission("CLIENT", PERMISSIONS.PRODUCTS_MANAGE), false);
    assert.equal(roleHasPermission("CLIENT", PERMISSIONS.PRODUCTS_READ), false);
  });

  it("holders of PRODUCTS_MANAGE are exactly ADMIN, OPERATIONS, TECH", () => {
    const holders = USER_ROLES.filter((role) => roleHasPermission(role, PERMISSIONS.PRODUCTS_MANAGE));
    assert.deepEqual(holders, ["ADMIN", "OPERATIONS", "TECH"]);
    const readers = USER_ROLES.filter((role) => roleHasPermission(role, PERMISSIONS.PRODUCTS_READ));
    assert.deepEqual(readers, ["ADMIN", "OPERATIONS", "ANALYST", "TECH"]);
  });

  it("ANALYST holds no manage permission at all (read-only role)", () => {
    const manage = getPermissionsForRole("ANALYST").filter((p) => /:manage$/.test(p) || p === "sync:trigger");
    assert.deepEqual(manage, []);
  });

  it("no role drift: every role's permission list is exactly the previous list plus the intended grant", () => {
    const P = PERMISSIONS;
    assert.deepEqual(ROLE_PERMISSIONS.OPERATIONS, [
      P.CAMPAIGNS_READ, P.PERFORMANCE_READ, P.PAYMENTS_READ, P.CONVERSIONS_READ, P.COMMISSION_READ,
      P.EXPORT_DATA, P.COUPONS_READ, P.COUPONS_WRITE, P.SYSTEM_READ, P.MERCHANTS_READ, P.MERCHANTS_MANAGE,
      P.CATALOG_READ, P.CATALOG_MANAGE, P.CLIENTS_READ, P.CLIENTS_MANAGE, P.TRACKING_READ, P.TRACKING_MANAGE,
      P.COUPON_ASSIGN_READ, P.COUPON_ASSIGN_MANAGE, P.COMMISSION_MANAGE, P.OPS_READ, P.OPS_MANAGE,
      P.EXCEPTIONS_READ, P.EXCEPTIONS_MANAGE, P.FINANCE_OPS_READ, P.PRODUCTS_READ, P.PRODUCTS_MANAGE,
    ]);
    assert.deepEqual(ROLE_PERMISSIONS.ANALYST, [
      P.CAMPAIGNS_READ, P.PERFORMANCE_READ, P.CONVERSIONS_READ, P.EXPORT_DATA, P.COUPONS_READ,
      P.MERCHANTS_READ, P.CATALOG_READ, P.CLIENTS_READ, P.TRACKING_READ, P.COUPON_ASSIGN_READ,
      P.EXCEPTIONS_READ, P.PRODUCTS_READ,
    ]);
    assert.deepEqual(ROLE_PERMISSIONS.TECH, [
      P.CAMPAIGNS_READ, P.INTEGRATIONS_READ, P.INTEGRATIONS_MANAGE, P.SYNC_TRIGGER, P.LOGS_READ,
      P.SYSTEM_READ, P.OPS_READ, P.EXCEPTIONS_READ, P.PRODUCTS_READ, P.PRODUCTS_MANAGE,
    ]);
    assert.deepEqual(ROLE_PERMISSIONS.SUPPORT, [
      P.CAMPAIGNS_READ, P.COUPONS_READ, P.EXCEPTIONS_READ, P.CLIENTS_READ,
    ]);
    assert.deepEqual(ROLE_PERMISSIONS.CLIENT, [
      P.PORTAL_CAMPAIGNS_READ, P.PORTAL_PERFORMANCE_READ, P.PORTAL_PAYMENTS_READ,
      P.PORTAL_PAYMENTS_MANAGE, P.PORTAL_SETTINGS_READ, P.PORTAL_SUPPORT,
    ]);
    assert.deepEqual(USER_ROLES, ["ADMIN", "OPERATIONS", "ANALYST", "TECH", "SUPPORT", "CLIENT"]);
    assert.deepEqual(STAFF_USER_ROLES, ["ADMIN", "OPERATIONS", "ANALYST", "TECH", "SUPPORT"]);
    assert.equal(Object.keys(PERMISSIONS).length, 39);
  });
});

// ─── 2. route authorization through the real app ────────────────────────────────────────────

describe("PRODUCTS_MANAGE — route authorization (real router, real authenticate/requirePermission/auditAction)", () => {
  const state = { calls: [], accessLogs: [] };
  const tokens = {};
  let server = null;
  let restorePrisma = null;
  let restoreServices = null;

  before(async () => {
    server = await startServer();
    restorePrisma = installPrismaDoubles(state);
    restoreServices = installServiceRecorders(state.calls);
    for (const role of USER_ROLES) tokens[role] = signAccessToken(USERS[role]);
  });

  after(async () => {
    restoreServices?.();
    restorePrisma?.();
    if (server) await server.close();
  });

  beforeEach(() => {
    state.calls.length = 0;
    state.accessLogs.length = 0;
  });

  for (const route of WRITE_ROUTES) {
    for (const role of DENIED) {
      it(`${route.method} ${route.path}: ${role} -> 403, handler and service not invoked, no audit row`, async () => {
        const { status, json } = await call(server.baseUrl, {
          method: route.method,
          path: route.path,
          bearer: tokens[role],
          body: route.body,
        });
        assert.equal(status, 403);
        assert.deepEqual(json, DENIED_403);
        await yieldTurn();
        assert.deepEqual(state.calls, []);
        assert.deepEqual(state.accessLogs, []);
      });
    }

    for (const role of PERMITTED) {
      it(`${route.method} ${route.path}: ${role} -> permitted, reaches the handler, audit row records actor/action/resource`, async () => {
        const { status, json } = await call(server.baseUrl, {
          method: route.method,
          path: route.path,
          bearer: tokens[role],
          body: route.body,
        });
        assert.equal(status, route.okStatus, JSON.stringify(json));
        assert.equal(json.ok, true);
        if (route.service) {
          const hit = state.calls.find((c) => c.method === route.service);
          assert.ok(hit, `${route.service} not called`);
        }
        await yieldTurn();
        await yieldTurn();
        const audit = state.accessLogs.find((row) => row.action === route.action);
        assert.ok(audit, `no audit row for ${route.action}`);
        assert.equal(audit.userId, USERS[role].id);
        assert.equal(audit.resource, route.resource);
        assert.equal(audit.metadata.method, route.method);
        assert.equal(audit.metadata.path, `/api${route.path}`);
      });
    }
  }

  it("POST /ops/products/sync-feeds: the permitted path is the job's skipped-account result, no ingest call", async () => {
    const { status, json } = await call(server.baseUrl, {
      method: "POST",
      path: "/ops/products/sync-feeds",
      bearer: tokens.ADMIN,
      body: {},
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.data?.results));
    assert.ok(json.data.results.every((r) => r.skipped === true), JSON.stringify(json.data.results));
    assert.equal(state.calls.filter((c) => c.method === "ingestFeedBatch").length, 0);
  });

  it("POST /ops/client-products/assign: audit resource falls back to clients:unknown when no clientId reaches the route", async () => {
    const { status } = await call(server.baseUrl, {
      method: "POST",
      path: "/ops/client-products/assign",
      bearer: tokens.OPERATIONS,
      body: { productId: "prod-1" },
    });
    assert.equal(status, 400);
    await yieldTurn();
    // auditAction only logs successful responses; the 400 must leave no audit row.
    assert.deepEqual(state.accessLogs, []);
    assert.deepEqual(state.calls, []);
  });

  it("unauthenticated writes are 401 and never reach a service", async () => {
    for (const route of WRITE_ROUTES) {
      const { status } = await call(server.baseUrl, { method: route.method, path: route.path, body: route.body });
      assert.equal(status, 401, route.path);
    }
    assert.deepEqual(state.calls, []);
  });

  // read regression
  for (const role of ["ANALYST", "TECH", "OPERATIONS", "ADMIN"]) {
    for (const route of READ_ROUTES) {
      it(`GET ${route.path}: ${role} keeps read access (200)`, async () => {
        const { status, json } = await call(server.baseUrl, { path: route.path, bearer: tokens[role] });
        assert.equal(status, 200, JSON.stringify(json));
        assert.ok(state.calls.some((c) => c.method === route.service), `${route.service} not reached`);
      });
    }
  }

  for (const role of ["SUPPORT", "CLIENT"]) {
    it(`GET /ops/products: ${role} is still denied (403)`, async () => {
      const { status, json } = await call(server.baseUrl, { path: "/ops/products", bearer: tokens[role] });
      assert.equal(status, 403);
      assert.deepEqual(json, DENIED_403);
      assert.deepEqual(state.calls, []);
    });
  }
});

// ─── 3. static proofs ───────────────────────────────────────────────────────────────────────

describe("PRODUCTS_MANAGE — static proofs", () => {
  const registrations = routeRegistrations(ROUTES_SOURCE);

  const WRITE_KEYS = [
    ["POST /ops/products/sync-feeds", 'auditAction\\("products\\.feed_sync", "ProductFeed"\\)', "syncProductFeedsHandler"],
    ["POST /ops/product-feeds/ingest", 'auditAction\\("products\\.feed_ingest", "ProductFeed"\\)', "ingestProductFeedHandler"],
    [
      "POST /ops/client-products/assign",
      'auditAction\\("products\\.client_assign", \\(req\\) => `clients:\\$\\{req\\.body\\?\\.clientId \\|\\| "unknown"\\}`\\)',
      "assignClientProductHandler",
    ],
  ];
  const READ_KEYS = [
    "GET /ops/products",
    "GET /ops/products/:id",
    "GET /ops/product-feeds",
    "GET /ops/admin/product-feeds",
    "GET /ops/admin/feeds",
  ];

  it("each write route is authenticate -> requirePermission(PRODUCTS_MANAGE) -> auditAction -> handler", () => {
    for (const [key, audit, handler] of WRITE_KEYS) {
      const args = registrations.get(key);
      assert.ok(args, `${key} not registered`);
      const pattern = new RegExp(
        `^\\s*authenticate,\\s*requirePermission\\(PERMISSIONS\\.PRODUCTS_MANAGE\\),\\s*${audit},\\s*${handler}\\s*$`,
      );
      assert.match(args, pattern, key);
      assert.doesNotMatch(args, /PRODUCTS_READ/, key);
    }
  });

  it("each product GET route stays on PRODUCTS_READ without PRODUCTS_MANAGE or auditAction", () => {
    for (const key of READ_KEYS) {
      const args = registrations.get(key);
      assert.ok(args, `${key} not registered`);
      assert.match(args, /^\s*authenticate,\s*requirePermission\(PERMISSIONS\.PRODUCTS_READ\),/, key);
      assert.doesNotMatch(args, /PRODUCTS_MANAGE|auditAction/, key);
    }
  });

  it("exactly three route registrations use PRODUCTS_MANAGE, all POST", () => {
    const gated = [...registrations.entries()]
      .filter(([, args]) => /PERMISSIONS\.PRODUCTS_MANAGE/.test(args))
      .map(([key]) => key);
    assert.deepEqual(gated.sort(), WRITE_KEYS.map(([key]) => key).sort());
    assert.equal((ROUTES_SOURCE.match(/PERMISSIONS\.PRODUCTS_MANAGE/g) || []).length, 3);
  });

  it("exactly three products.* auditAction registrations exist", () => {
    const actions = ROUTES_SOURCE.match(/auditAction\("products\.[a-z_]+"/g) || [];
    assert.deepEqual(actions.sort(), [
      'auditAction("products.client_assign"',
      'auditAction("products.feed_ingest"',
      'auditAction("products.feed_sync"',
    ]);
  });

  it("PRODUCTS_READ route count is unchanged at five reads", () => {
    const reads = [...registrations.entries()]
      .filter(([, args]) => /PERMISSIONS\.PRODUCTS_READ/.test(args))
      .map(([key]) => key);
    assert.deepEqual(reads.sort(), [...READ_KEYS].sort());
    assert.ok(reads.every((key) => key.startsWith("GET ")));
  });

  it("permissions source declares PRODUCTS_MANAGE once and grants it in exactly two role arrays", () => {
    assert.equal((PERMISSIONS_SOURCE.match(/PRODUCTS_MANAGE: "products:manage"/g) || []).length, 1);
    assert.equal((PERMISSIONS_SOURCE.match(/PERMISSIONS\.PRODUCTS_MANAGE,/g) || []).length, 2);
    const operationsBlock = PERMISSIONS_SOURCE.slice(PERMISSIONS_SOURCE.indexOf("OPERATIONS: ["), PERMISSIONS_SOURCE.indexOf("ANALYST: ["));
    const analystBlock = PERMISSIONS_SOURCE.slice(PERMISSIONS_SOURCE.indexOf("ANALYST: ["), PERMISSIONS_SOURCE.indexOf("TECH: ["));
    const techBlock = PERMISSIONS_SOURCE.slice(PERMISSIONS_SOURCE.indexOf("TECH: ["), PERMISSIONS_SOURCE.indexOf("SUPPORT: ["));
    const supportBlock = PERMISSIONS_SOURCE.slice(PERMISSIONS_SOURCE.indexOf("SUPPORT: ["), PERMISSIONS_SOURCE.indexOf("CLIENT: ["));
    assert.match(operationsBlock, /PERMISSIONS\.PRODUCTS_MANAGE/);
    assert.match(techBlock, /PERMISSIONS\.PRODUCTS_MANAGE/);
    assert.doesNotMatch(analystBlock, /PRODUCTS_MANAGE/);
    assert.doesNotMatch(supportBlock, /PRODUCTS_MANAGE/);
    assert.match(PERMISSIONS_SOURCE, /ADMIN: Object\.values\(PERMISSIONS\)/);
  });
});
