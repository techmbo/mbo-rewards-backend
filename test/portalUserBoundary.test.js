/**
 * Portal-user boundary for money / account actions.
 *
 * `authenticatePartner` accepts two credentials for the same tenant: an `mbo_live_` / `mbo_test_`
 * API key (machine data access, no `req.user`) and a CLIENT portal JWT. Bank details, withdrawals,
 * settings, support, credential management and the settings/team reads are interactive portal
 * actions, so `requirePortalUser` rejects every API key — production or sandbox, whatever the
 * client's delivery method — with one 403 before any handler or service runs. Portal users keep
 * reaching the existing handlers unchanged, and the machine-readable client API stays open to keys.
 *
 * Route tests run the real Express app (real router, real `authenticatePartner`, real API-key
 * hashing) against the exported Prisma instance with its lookup delegates replaced in memory, and
 * with the downstream service methods replaced by recorders so a forbidden call is visible.
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
const {
  PORTAL_USER_REQUIRED_MESSAGE,
  authenticatePartner,
  requireDeliveryChannel,
  requirePortalUser,
} = await import("../src/middleware/auth.js");
const { ClientCredentialService, hashApiKey } = await import(
  "../src/modules/client/services/clientCredential.service.js"
);
const { PortalDashboardService } = await import(
  "../src/modules/client/services/portalDashboard.service.js"
);
const { ClientReportingService } = await import(
  "../src/modules/client/services/clientReporting.service.js"
);
const { PartnerCampaignService } = await import(
  "../src/modules/client/services/partnerCampaign.service.js"
);
const { signAccessToken } = await import("../src/modules/auth/auth.service.js");
const { ROLE_PERMISSIONS, PERMISSIONS } = await import("../src/auth/permissions.js");
const { createApp } = await import("../src/app.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_SOURCE = fs.readFileSync(path.join(HERE, "../src/routes/index.js"), "utf8");
const AUTH_SOURCE = fs.readFileSync(path.join(HERE, "../src/middleware/auth.js"), "utf8");
const PORTAL_CONTROLLER_SOURCE = fs.readFileSync(
  path.join(HERE, "../src/controllers/portal.controller.js"),
  "utf8",
);

const PORTAL_403 = { ok: false, message: "Use the client portal login for this action." };

// ─── fixtures ───────────────────────────────────────────────────────────────────────────────

const CLIENT_ID = "client-portal-boundary";
const OTHER_CLIENT_ID = "client-other-tenant";
const PROD_KEY = "mbo_live_boundaryproductionkey0123456789";
const SANDBOX_KEY = "mbo_test_boundarysandboxkey00123456789ab";

function makeClient(overrides = {}) {
  return {
    id: CLIENT_ID,
    name: "Boundary Client",
    slug: "boundary",
    status: "ACTIVE",
    deletedAt: null,
    deliveryMethod: "API_AND_PORTAL",
    apiEnvironmentConfig: null,
    ...overrides,
  };
}

const CREDENTIALS = [
  {
    id: "cred-production",
    clientId: CLIENT_ID,
    keyPrefix: PROD_KEY.slice(0, 16),
    keyHash: hashApiKey(PROD_KEY),
    environment: "PRODUCTION",
    revokedAt: null,
  },
  {
    id: "cred-sandbox",
    clientId: CLIENT_ID,
    keyPrefix: SANDBOX_KEY.slice(0, 16),
    keyHash: hashApiKey(SANDBOX_KEY),
    environment: "SANDBOX",
    revokedAt: null,
  },
];

const PORTAL_USER = {
  id: "user-portal-client",
  email: "portal@boundary.test",
  name: "Portal User",
  role: "CLIENT",
  clientId: CLIENT_ID,
  isActive: true,
};
const STAFF_USER = {
  id: "user-staff-admin",
  email: "admin@mbo.test",
  name: "Staff Admin",
  role: "ADMIN",
  clientId: null,
  isActive: true,
};
const USERS = [PORTAL_USER, STAFF_USER];

// ─── middleware unit harness ────────────────────────────────────────────────────────────────

function mockRes() {
  const res = { statusCode: null, body: null, statusCalls: 0, jsonCalls: 0 };
  res.status = (code) => {
    res.statusCalls += 1;
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.jsonCalls += 1;
    res.body = body;
    return res;
  };
  return res;
}

function runMiddleware(middleware, req) {
  const res = mockRes();
  let nextCalls = 0;
  let nextArg;
  middleware(req, res, (arg) => {
    nextCalls += 1;
    nextArg = arg;
  });
  return { res, nextCalls, nextArg };
}

function apiKeyReq(environment) {
  return {
    headers: { "x-api-key": environment === "SANDBOX" ? SANDBOX_KEY : PROD_KEY },
    partnerClientId: CLIENT_ID,
    partnerClient: makeClient(),
    partnerAuth: { type: "api_key", credentialId: `cred-${environment}`, environment },
  };
}

function portalUserReq(overrides = {}) {
  return {
    headers: { authorization: "Bearer <portal-jwt>" },
    user: { ...PORTAL_USER },
    permissions: [...ROLE_PERMISSIONS.CLIENT],
    partnerClientId: CLIENT_ID,
    partnerClient: makeClient(),
    partnerAuth: { type: "portal_user", userId: PORTAL_USER.id },
    ...overrides,
  };
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

async function call(baseUrl, { method = "GET", path: routePath, bearer, apiKeyHeader, body } = {}) {
  const headers = { Accept: "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (apiKeyHeader) headers["X-Api-Key"] = apiKeyHeader;
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

/** Service-call recorder installed on the real service prototypes. */
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
  const record = (method, clientId, extra) => calls.push({ method, clientId, ...extra });

  const portal = PortalDashboardService.prototype;
  stub(portal, "saveBankDetails", async function (clientId, body) {
    record("saveBankDetails", clientId, { body });
    return {
      accountHolder: body.accountHolder,
      bankName: body.bankName,
      accountLast4: String(body.accountNumber || "").slice(-4),
      ifscCode: body.ifscCode,
      accountType: "Current",
      status: "VERIFIED",
    };
  });
  stub(portal, "requestWithdrawal", async function (clientId, args) {
    record("requestWithdrawal", clientId, { args });
    return { id: "wd-1", reference: "WD-1000", date: "2026-09-25", amount: 1000, status: "Requested" };
  });
  stub(portal, "updateSettings", async function (clientId, body) {
    record("updateSettings", clientId, { body });
    return { organisation: { name: body?.organisation?.name ?? "Boundary Client" } };
  });
  stub(portal, "getSettings", async function (clientId) {
    record("getSettings", clientId, {});
    return {
      organisation: { name: "Boundary Client" },
      billing: { billingMethod: "Invoice Required" },
      commercials: { settlementCurrency: "INR" },
      api: { clientId, deliveryMethod: "API_AND_PORTAL" },
    };
  });
  stub(portal, "listTeam", async function (clientId) {
    record("listTeam", clientId, {});
    return [{ id: PORTAL_USER.id, name: PORTAL_USER.name, email: PORTAL_USER.email, role: "Client Admin", status: "Active" }];
  });
  stub(portal, "getMe", async function (clientId, user) {
    record("getMe", clientId, { user: user ? { id: user.id } : null });
    return { client: { id: clientId, name: "Boundary Client" }, bankStatus: "NOT_ADDED", user: user ? { id: user.id } : null };
  });
  stub(portal, "createSupportRequest", async function (clientId, args) {
    record("createSupportRequest", clientId, { args });
    return { id: "sr-1", type: "SUPPORT_TICKET", status: "OPEN", createdAt: "2026-09-25T00:00:00.000Z" };
  });
  stub(portal, "listWithdrawalRequests", async function (clientId) {
    record("listWithdrawalRequests", clientId, {});
    return { requests: [], pagination: { page: 1, pageSize: 20, total: 0 } };
  });

  stub(ClientCredentialService.prototype, "rotatePortalApiCredential", async function (clientId, opts) {
    record("rotatePortalApiCredential", clientId, { opts });
    return { id: "cred-rotated", name: opts?.name ?? "Default", environment: "PRODUCTION", keyPrefix: "mbo_live_rotated" };
  });
  stub(ClientReportingService.prototype, "listPerformance", async function (clientId) {
    record("listPerformance", clientId, {});
    return { items: [], pagination: { page: 1, pageSize: 20, total: 0 } };
  });
  stub(PartnerCampaignService.prototype, "listCampaigns", async function (clientId) {
    record("listCampaigns", clientId, {});
    return { items: [], pagination: { page: 1, pageSize: 20, total: 0 } };
  });

  return () => restore.reverse().forEach((fn) => fn());
}

/** Prisma lookup doubles for authenticatePartner (API key rows, client row, user rows). */
function installPrismaDoubles(state) {
  const originals = {
    clientApiCredential: prisma.clientApiCredential,
    client: prisma.client,
    user: prisma.user,
  };
  prisma.clientApiCredential = {
    async findMany({ where }) {
      return CREDENTIALS.filter((row) => row.keyPrefix === where.keyPrefix && row.revokedAt === null).map(
        (row) => ({ ...row, client: state.client }),
      );
    },
    async update() {
      return {};
    },
  };
  prisma.client = {
    async findFirst({ where }) {
      return where.id === state.client.id && state.client.deletedAt == null ? state.client : null;
    },
    async findUnique({ where }) {
      return where.id === state.client.id ? state.client : null;
    },
  };
  prisma.user = {
    async findUnique({ where }) {
      return USERS.find((user) => user.id === where.id) ?? null;
    },
  };
  return () => {
    prisma.clientApiCredential = originals.clientApiCredential;
    prisma.client = originals.client;
    prisma.user = originals.user;
  };
}

const GATED_ROUTES = [
  { method: "PUT", path: "/portal/v1/bank", body: { accountHolder: "A", bankName: "B", accountNumber: "123456789", ifscCode: "HDFC0001" }, service: "saveBankDetails", okStatus: 200 },
  { method: "POST", path: "/portal/v1/withdrawals", body: { amount: 1000 }, service: "requestWithdrawal", okStatus: 201 },
  { method: "PATCH", path: "/portal/v1/settings", body: { organisation: { name: "Renamed" } }, service: "updateSettings", okStatus: 200 },
  { method: "POST", path: "/portal/v1/support", body: { body: "Need help" }, service: null, okStatus: null },
  { method: "GET", path: "/portal/v1/settings", service: "getSettings", okStatus: 200 },
  { method: "GET", path: "/portal/v1/team", service: "listTeam", okStatus: 200 },
  { method: "GET", path: "/portal/v1/api-keys", service: null, okStatus: null },
  { method: "POST", path: "/portal/v1/api-keys/rotate", body: { name: "Default" }, service: "rotatePortalApiCredential", okStatus: 201 },
  { method: "POST", path: "/v1/client/withdrawal-requests", body: { amount: 1000 }, service: "requestWithdrawal", okStatus: 201 },
];

// ─── 1. middleware unit ─────────────────────────────────────────────────────────────────────

describe("requirePortalUser — middleware unit", () => {
  it("1. PRODUCTION api_key -> 403, next not called", () => {
    const { res, nextCalls } = runMiddleware(requirePortalUser, apiKeyReq("PRODUCTION"));
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, PORTAL_403);
  });

  it("2. SANDBOX api_key -> 403, next not called", () => {
    const { res, nextCalls } = runMiddleware(requirePortalUser, apiKeyReq("SANDBOX"));
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, PORTAL_403);
  });

  it("3. portal_user + CLIENT user -> next(), response untouched, request unchanged", () => {
    const req = portalUserReq();
    const snapshot = JSON.parse(JSON.stringify(req));
    const { res, nextCalls, nextArg } = runMiddleware(requirePortalUser, req);
    assert.equal(nextCalls, 1);
    assert.equal(nextArg, undefined);
    assert.equal(res.statusCalls, 0);
    assert.equal(res.jsonCalls, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(req)), snapshot);
    assert.equal(req.partnerClientId, CLIENT_ID);
    assert.equal(req.user.id, PORTAL_USER.id);
    assert.deepEqual(req.permissions, ROLE_PERMISSIONS.CLIENT);
  });

  it("4. portal_user auth shape but missing req.user -> 403", () => {
    const req = portalUserReq();
    delete req.user;
    const { res, nextCalls } = runMiddleware(requirePortalUser, req);
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, PORTAL_403);
  });

  it("5. portal_user auth shape with a staff role -> 403 for every staff role", () => {
    for (const role of ["ADMIN", "OPERATIONS", "ANALYST", "TECH", "SUPPORT"]) {
      const req = portalUserReq({ user: { ...STAFF_USER, role } });
      const { res, nextCalls } = runMiddleware(requirePortalUser, req);
      assert.equal(nextCalls, 0, role);
      assert.equal(res.statusCode, 403, role);
      assert.deepEqual(res.body, PORTAL_403, role);
    }
  });

  it("6. no partner auth -> 403 (staff `authenticate` shape and a bare request)", () => {
    const staffShape = {
      headers: {},
      user: { ...STAFF_USER },
      permissions: ROLE_PERMISSIONS.ADMIN,
    };
    for (const req of [staffShape, { headers: {} }, {}]) {
      const { res, nextCalls } = runMiddleware(requirePortalUser, req);
      assert.equal(nextCalls, 0);
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.body, PORTAL_403);
    }
  });

  it("7. portal_user + CLIENT but missing partnerClientId -> 403", () => {
    for (const partnerClientId of [undefined, null]) {
      const req = portalUserReq({ partnerClientId });
      const { res, nextCalls } = runMiddleware(requirePortalUser, req);
      assert.equal(nextCalls, 0);
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.body, PORTAL_403);
    }
  });

  it("8. exact 403 body pinned; one status call, one json call; constant matches", () => {
    const { res } = runMiddleware(requirePortalUser, apiKeyReq("PRODUCTION"));
    assert.equal(res.statusCalls, 1);
    assert.equal(res.jsonCalls, 1);
    assert.deepEqual(Object.keys(res.body), ["ok", "message"]);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.message, "Use the client portal login for this action.");
    assert.equal(PORTAL_USER_REQUIRED_MESSAGE, "Use the client portal login for this action.");
  });

  it("api_key auth is rejected even if a caller smuggles a CLIENT-shaped req.user", () => {
    const req = { ...apiKeyReq("PRODUCTION"), user: { ...PORTAL_USER } };
    const { res, nextCalls } = runMiddleware(requirePortalUser, req);
    assert.equal(nextCalls, 0);
    assert.equal(res.statusCode, 403);
  });
});

// ─── 2. route boundary through the real app ─────────────────────────────────────────────────

describe("requirePortalUser — route boundary (real router, real authenticatePartner)", () => {
  const state = { client: makeClient() };
  const calls = [];
  let server = null;
  let restorePrisma = null;
  let restoreServices = null;
  let portalToken = null;
  let staffToken = null;

  before(async () => {
    server = await startServer();
    restorePrisma = installPrismaDoubles(state);
    restoreServices = installServiceRecorders(calls);
    portalToken = signAccessToken(PORTAL_USER);
    staffToken = signAccessToken(STAFF_USER);
  });

  after(async () => {
    restoreServices?.();
    restorePrisma?.();
    if (server) await server.close();
  });

  beforeEach(() => {
    calls.length = 0;
    state.client = makeClient();
  });

  for (const route of GATED_ROUTES) {
    for (const [label, key] of [
      ["PRODUCTION api key", PROD_KEY],
      ["SANDBOX api key", SANDBOX_KEY],
    ]) {
      it(`${route.method} ${route.path}: ${label} -> 403 portal-login, no service call`, async () => {
        const { status, json } = await call(server.baseUrl, {
          method: route.method,
          path: route.path,
          bearer: key,
          body: route.body,
        });
        assert.equal(status, 403);
        assert.deepEqual(json, PORTAL_403);
        assert.deepEqual(calls, []);
      });
    }
  }

  it("PUT /portal/v1/bank: API key via X-Api-Key header -> same 403, no service call", async () => {
    const { status, json } = await call(server.baseUrl, {
      method: "PUT",
      path: "/portal/v1/bank",
      apiKeyHeader: SANDBOX_KEY,
      body: GATED_ROUTES[0].body,
    });
    assert.equal(status, 403);
    assert.deepEqual(json, PORTAL_403);
    assert.deepEqual(calls, []);
  });

  it("API key gets the portal-login 403 whatever the client's deliveryMethod (gate runs before the channel check)", async () => {
    for (const deliveryMethod of ["API_AND_PORTAL", "PORTAL_ONLY", "API_ONLY"]) {
      state.client = makeClient({ deliveryMethod });
      for (const key of [PROD_KEY, SANDBOX_KEY]) {
        const { status, json } = await call(server.baseUrl, {
          method: "POST",
          path: "/portal/v1/withdrawals",
          bearer: key,
          body: { amount: 1000 },
        });
        assert.equal(status, 403, deliveryMethod);
        assert.deepEqual(json, PORTAL_403, deliveryMethod);
      }
    }
    assert.deepEqual(calls, []);
  });

  it("portal user on an API_ONLY client passes requirePortalUser and is then stopped by the channel check", async () => {
    state.client = makeClient({ deliveryMethod: "API_ONLY" });
    const { status, json } = await call(server.baseUrl, {
      method: "POST",
      path: "/portal/v1/withdrawals",
      bearer: portalToken,
      body: { amount: 1000 },
    });
    assert.equal(status, 403);
    assert.equal(json.message, "Portal access is not enabled for this client.");
    assert.deepEqual(calls, []);
  });

  it("staff ADMIN JWT never reaches a gated handler", async () => {
    const { status, json } = await call(server.baseUrl, {
      method: "PUT",
      path: "/portal/v1/bank",
      bearer: staffToken,
      body: GATED_ROUTES[0].body,
    });
    assert.equal(status, 403);
    assert.equal(json.ok, false);
    assert.deepEqual(calls, []);
  });

  it("unauthenticated request to a gated route -> 401, no service call", async () => {
    const { status } = await call(server.baseUrl, { method: "PUT", path: "/portal/v1/bank", body: GATED_ROUTES[0].body });
    assert.equal(status, 401);
    assert.deepEqual(calls, []);
  });

  // portal CLIENT user reaches the downstream handlers
  for (const route of GATED_ROUTES.filter((r) => r.service)) {
    it(`${route.method} ${route.path}: portal CLIENT user reaches ${route.service}`, async () => {
      const { status, json } = await call(server.baseUrl, {
        method: route.method,
        path: route.path,
        bearer: portalToken,
        body: route.body,
      });
      assert.equal(status, route.okStatus, JSON.stringify(json));
      assert.equal(json.ok, true);
      const hit = calls.find((c) => c.method === route.service);
      assert.ok(hit, `${route.service} was not called`);
      assert.equal(hit.clientId, CLIENT_ID);
    });
  }

  for (const route of GATED_ROUTES.filter((r) => !r.service)) {
    it(`${route.method} ${route.path}: portal CLIENT user passes requirePortalUser (handler success not required — pre-existing undefined payload bug)`, async () => {
      const { status, json } = await call(server.baseUrl, {
        method: route.method,
        path: route.path,
        bearer: portalToken,
        body: route.body,
      });
      assert.notEqual(status, 401);
      assert.notEqual(status, 403);
      assert.notEqual(json?.message, PORTAL_403.message);
    });
  }

  it("withdrawal actor: portal user id flows into requestWithdrawal as requestedBy on both withdrawal routes", async () => {
    for (const routePath of ["/portal/v1/withdrawals", "/v1/client/withdrawal-requests"]) {
      calls.length = 0;
      const { status } = await call(server.baseUrl, {
        method: "POST",
        path: routePath,
        bearer: portalToken,
        body: { amount: 1000 },
      });
      assert.equal(status, 201, routePath);
      const hit = calls.find((c) => c.method === "requestWithdrawal");
      assert.ok(hit, routePath);
      assert.equal(hit.clientId, CLIENT_ID);
      assert.equal(hit.args.requestedBy, PORTAL_USER.id, routePath);
      assert.equal(hit.args.amount, 1000);
    }
  });

  it("withdrawal actor: API keys never reach requestWithdrawal on either route", async () => {
    for (const routePath of ["/portal/v1/withdrawals", "/v1/client/withdrawal-requests"]) {
      for (const key of [PROD_KEY, SANDBOX_KEY]) {
        const { status } = await call(server.baseUrl, { method: "POST", path: routePath, bearer: key, body: { amount: 1000 } });
        assert.equal(status, 403, `${routePath} ${key.slice(0, 9)}`);
      }
    }
    assert.equal(calls.filter((c) => c.method === "requestWithdrawal").length, 0);
    assert.deepEqual(calls, []);
  });

  it("credential rotation records the portal user as createdBy", async () => {
    const { status } = await call(server.baseUrl, {
      method: "POST",
      path: "/portal/v1/api-keys/rotate",
      bearer: portalToken,
      body: { name: "Default" },
    });
    assert.equal(status, 201);
    const hit = calls.find((c) => c.method === "rotatePortalApiCredential");
    assert.equal(hit.opts.createdBy, PORTAL_USER.id);
  });

  it("tenant isolation unchanged: a portal user claiming another clientId is refused", async () => {
    const { status, json } = await call(server.baseUrl, {
      method: "POST",
      path: "/portal/v1/withdrawals",
      bearer: portalToken,
      body: { amount: 1000, clientId: OTHER_CLIENT_ID },
    });
    assert.equal(status, 403);
    assert.equal(json.message, "clientId does not match authenticated tenant.");
    assert.deepEqual(calls, []);
  });

  // safe API regression
  const SAFE_API_ROUTES = [
    { path: "/v1/client/account", service: "getMe" },
    { path: "/v1/client/performance", service: "listPerformance" },
    { path: "/partner/v1/campaigns", service: "listCampaigns" },
    { path: "/v1/client/withdrawal-requests", service: "listWithdrawalRequests" },
    { path: "/portal/v1/withdrawal-requests", service: "listWithdrawalRequests" },
    { path: "/portal/v1/me", service: "getMe" },
  ];
  for (const route of SAFE_API_ROUTES) {
    for (const [label, key] of [
      ["PRODUCTION api key", PROD_KEY],
      ["SANDBOX api key", SANDBOX_KEY],
    ]) {
      it(`GET ${route.path}: ${label} still reaches ${route.service} (200)`, async () => {
        const { status, json } = await call(server.baseUrl, { path: route.path, bearer: key });
        assert.equal(status, 200, JSON.stringify(json));
        assert.equal(json.ok, true);
        const hit = calls.find((c) => c.method === route.service);
        assert.ok(hit, `${route.service} not called`);
        assert.equal(hit.clientId, CLIENT_ID);
      });
    }
  }

  it("GET /portal/v1/me under an API key reports no user (unchanged behavior)", async () => {
    const { status } = await call(server.baseUrl, { path: "/portal/v1/me", bearer: PROD_KEY });
    assert.equal(status, 200);
    const hit = calls.find((c) => c.method === "getMe");
    assert.equal(hit.user, null);
  });
});

// ─── 3. static proofs ───────────────────────────────────────────────────────────────────────

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

describe("requirePortalUser — static proofs", () => {
  const registrations = routeRegistrations(ROUTES_SOURCE);

  const EXPECTED_GATED = [
    "PUT /portal/v1/bank",
    "POST /portal/v1/withdrawals",
    "GET /portal/v1/settings",
    "PATCH /portal/v1/settings",
    "GET /portal/v1/team",
    "POST /portal/v1/support",
    "GET /portal/v1/api-keys",
    "POST /portal/v1/api-keys/rotate",
    "POST /v1/client/withdrawal-requests",
  ];

  const EXPECTED_OPEN = [
    "GET /v1/client/account",
    "GET /v1/client/performance",
    "GET /v1/client/campaigns",
    "GET /v1/client/payments",
    "GET /v1/client/withdrawal-requests",
    "GET /partner/v1/campaigns",
    "GET /partner/v1/orders",
    "GET /portal/v1/me",
    "GET /portal/v1/overview",
    "GET /portal/v1/performance",
    "GET /portal/v1/payments",
    "GET /portal/v1/payable-statements",
    "GET /portal/v1/withdrawal-requests",
    "GET /portal/v1/notifications",
    "GET /portal/v1/dashboard-summary",
    "GET /portal/v1/api-docs",
  ];

  it("routes file imports requirePortalUser from the auth middleware", () => {
    const importBlock = ROUTES_SOURCE.match(/import \{([\s\S]*?)\} from "\.\.\/middleware\/auth\.js";/);
    assert.ok(importBlock);
    assert.match(importBlock[1], /\brequirePortalUser\b/);
  });

  it("every intended sensitive route is gated, in the order authenticatePartner -> requirePortalUser -> requireDeliveryChannel", () => {
    for (const key of EXPECTED_GATED) {
      const args = registrations.get(key);
      assert.ok(args, `${key} not registered`);
      assert.match(args, /^\s*authenticatePartner,\s*requirePortalUser,\s*requireDeliveryChannel\("(portal|api)"\)/, key);
    }
  });

  it("exactly nine route registrations carry requirePortalUser", () => {
    const gated = [...registrations.entries()].filter(([, args]) => /\brequirePortalUser\b/.test(args)).map(([key]) => key);
    assert.deepEqual(gated.sort(), [...EXPECTED_GATED].sort());
  });

  it("representative machine-readable API and portal read routes are NOT gated", () => {
    for (const key of EXPECTED_OPEN) {
      const args = registrations.get(key);
      assert.ok(args, `${key} not registered`);
      assert.doesNotMatch(args, /\brequirePortalUser\b/, key);
      assert.match(args, /^\s*authenticatePartner,/, key);
    }
  });

  it("no authenticate/requirePermission route was touched by the gate", () => {
    for (const [key, args] of registrations) {
      if (/\brequirePortalUser\b/.test(args)) {
        assert.match(args, /^\s*authenticatePartner,/, `${key} must be a partner route`);
      }
    }
  });

  it("requirePortalUser is exported, is an auth-channel check, and does not use requirePermission or PORTAL_* permissions", () => {
    assert.equal(typeof requirePortalUser, "function");
    const body = AUTH_SOURCE.slice(AUTH_SOURCE.indexOf("export function requirePortalUser"));
    const fn = body.slice(0, body.indexOf("\n}\n") + 3);
    assert.match(fn, /req\.partnerAuth\?\.type === "portal_user"/);
    assert.match(fn, /req\.user\.role === "CLIENT"/);
    assert.match(fn, /req\.partnerClientId != null/);
    assert.match(fn, /sendAuthError\(res, 403, PORTAL_USER_REQUIRED_MESSAGE\)/);
    assert.doesNotMatch(fn, /requirePermission|roleHasAnyPermission|roleHasPermission|PERMISSIONS\.|PORTAL_(CAMPAIGNS|PERFORMANCE|PAYMENTS|SETTINGS|SUPPORT)/);
    assert.doesNotMatch(ROUTES_SOURCE, /PORTAL_PAYMENTS_MANAGE/);
  });

  it("authenticatePartner and requireDeliveryChannel are unchanged in shape", () => {
    assert.equal(typeof authenticatePartner, "function");
    assert.equal(typeof requireDeliveryChannel, "function");
    const partner = AUTH_SOURCE.slice(
      AUTH_SOURCE.indexOf("export async function authenticatePartner"),
      AUTH_SOURCE.indexOf("export const PORTAL_USER_REQUIRED_MESSAGE"),
    );
    assert.match(partner, /type: "api_key",\s*credentialId: match\.credentialId,\s*environment: match\.environment \|\| "PRODUCTION"/);
    assert.match(partner, /req\.partnerAuth = \{ type: "portal_user", userId: user\.id \};/);
    assert.doesNotMatch(partner, /requirePortalUser/);
    const channel = AUTH_SOURCE.slice(AUTH_SOURCE.indexOf("export function requireDeliveryChannel"));
    const channelFn = channel.slice(0, channel.indexOf("\n}\n") + 3);
    assert.doesNotMatch(channelFn, /partnerAuth|requirePortalUser/);
    assert.match(channelFn, /req\.partnerClient\?\.deliveryMethod \|\| "API_AND_PORTAL"/);
  });

  it("existing controller-level API-key checks remain in place (defense in depth)", () => {
    const matches = PORTAL_CONTROLLER_SOURCE.match(/req\.partnerAuth\?\.type === "api_key"/g) || [];
    assert.equal(matches.length, 2);
    assert.match(PORTAL_CONTROLLER_SOURCE, /Use the client portal login to view API credentials\./);
    assert.match(PORTAL_CONTROLLER_SOURCE, /Use the client portal login to rotate API credentials\./);
  });

  it("CLIENT permission set is unchanged (no portal permission redesign)", () => {
    assert.deepEqual(ROLE_PERMISSIONS.CLIENT, [
      PERMISSIONS.PORTAL_CAMPAIGNS_READ,
      PERMISSIONS.PORTAL_PERFORMANCE_READ,
      PERMISSIONS.PORTAL_PAYMENTS_READ,
      PERMISSIONS.PORTAL_PAYMENTS_MANAGE,
      PERMISSIONS.PORTAL_SETTINGS_READ,
      PERMISSIONS.PORTAL_SUPPORT,
    ]);
  });
});
