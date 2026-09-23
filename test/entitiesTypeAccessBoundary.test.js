/**
 * GET /api/entities (and /entities/summary, /fields) — entity-type authorization boundary.
 *
 * requireEntityTypeAccess used to call next() when no `type` was given, and GET /entities then
 * listed every staged Entity of every type (rawData included) for any authenticated user, CLIENT
 * portal users included. The type is now required, and it is authorized on the query parameter
 * the route's handler actually filters on (`type`; `entity_type` for /fields).
 *
 * These tests drive the real middleware through real Express routing (so `req.route` is exactly
 * what production sees), with a stand-in authenticate step and a stand-in handler that records
 * whether it was reached.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import express from "express";
import { requireEntityTypeAccess, requirePermission } from "../src/middleware/auth.js";
import { ENTITY_TYPE_PERMISSIONS, PERMISSIONS, ROLE_PERMISSIONS, getPermissionsForRole } from "../src/auth/permissions.js";

const reached = [];

function fakeAuthenticate(req, res, next) {
  const role = req.headers["x-test-role"];
  if (role) {
    req.user = { id: `user-${role}`, role, isActive: true };
    req.permissions = getPermissionsForRole(role);
  }
  next();
}

function handler(name) {
  return (req, res) => {
    reached.push({ name, query: { ...req.query } });
    res.json({ ok: true, route: name, data: [{ entityType: req.query.type ?? req.query.entity_type ?? "ALL_TYPES" }] });
  };
}

let server;
let base;

before(async () => {
  const router = express.Router();
  // Same guard order as src/routes/index.js.
  router.get("/entities", fakeAuthenticate, requireEntityTypeAccess, handler("entities"));
  router.get("/entities/summary", fakeAuthenticate, requireEntityTypeAccess, handler("summary"));
  router.get("/fields", fakeAuthenticate, requireEntityTypeAccess, handler("fields"));
  // Unrelated guard, to show it is unaffected.
  router.get("/campaigns-probe", fakeAuthenticate, requirePermission(PERMISSIONS.CAMPAIGNS_READ), handler("probe"));
  const app = express();
  app.use("/api", router);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function call(path, role) {
  const before = reached.length;
  const res = await fetch(`${base}${path}`, { headers: role ? { "x-test-role": role } : {} });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, reachedHandler: reached.length > before };
}

const STAFF = ["ADMIN", "OPERATIONS", "ANALYST", "TECH", "SUPPORT"];

describe("GET /api/entities entity-type boundary", () => {
  it("CLIENT with no type is denied and never reaches the handler", async () => {
    const r = await call("/entities", "CLIENT");
    assert.equal(r.status, 400);
    assert.equal(r.reachedHandler, false);
    assert.deepEqual(r.body, { ok: false, message: "Query parameter 'type' is required." });
  });

  it("CLIENT is denied every staged-record type", async () => {
    for (const type of Object.keys(ENTITY_TYPE_PERMISSIONS)) {
      const r = await call(`/entities?type=${type}`, "CLIENT");
      assert.equal(r.status, 403, type);
      assert.equal(r.reachedHandler, false, type);
    }
  });

  it("no staff role receives an all-types result by omitting type (ADMIN included)", async () => {
    for (const role of STAFF) {
      for (const path of ["/entities", "/entities?type=", "/entities?page=1&pageSize=200", "/entities/summary"]) {
        const r = await call(path, role);
        assert.equal(r.status, 400, `${role} ${path}`);
        assert.equal(r.reachedHandler, false, `${role} ${path}`);
      }
    }
  });

  it("the type cannot be supplied under a name the /entities handler ignores", async () => {
    const r = await call("/entities?entity_type=campaign", "ADMIN");
    assert.equal(r.status, 400);
    assert.equal(r.reachedHandler, false);
  });

  it("authorized caller with an allowed type still succeeds", async () => {
    for (const [type, permission] of Object.entries(ENTITY_TYPE_PERMISSIONS)) {
      for (const role of STAFF) {
        const allowed = ROLE_PERMISSIONS[role].includes(permission);
        const r = await call(`/entities?type=${type}`, role);
        if (allowed) {
          assert.equal(r.status, 200, `${role} ${type}`);
          assert.equal(r.reachedHandler, true, `${role} ${type}`);
          assert.equal(r.body.data[0].entityType, type);
        }
      }
    }
    const summary = await call("/entities/summary?type=campaign", "ANALYST");
    assert.equal(summary.status, 200);
  });

  it("caller without the type's permission is denied (existing mapping preserved)", async () => {
    // SUPPORT holds campaigns:read and coupons:read only among the entity permissions.
    for (const type of ["performance", "payment", "conversion"]) {
      const r = await call(`/entities?type=${type}`, "SUPPORT");
      assert.equal(r.status, 403, type);
      assert.deepEqual(r.body, { ok: false, message: "You do not have permission to view this data." });
      assert.equal(r.reachedHandler, false);
    }
    for (const type of ["campaign", "coupon"]) {
      assert.equal((await call(`/entities?type=${type}`, "SUPPORT")).status, 200, type);
    }
    assert.deepEqual(ENTITY_TYPE_PERMISSIONS, {
      campaign: PERMISSIONS.CAMPAIGNS_READ,
      performance: PERMISSIONS.PERFORMANCE_READ,
      payment: PERMISSIONS.PAYMENTS_READ,
      conversion: PERMISSIONS.CONVERSIONS_READ,
      coupon: PERMISSIONS.COUPONS_READ,
    });
  });

  it("invalid or unknown types are rejected safely", async () => {
    for (const type of ["link", "product", "constructor", "__proto__", "toString"]) {
      const r = await call(`/entities?type=${type}`, "ADMIN");
      assert.equal(r.status, 400, type);
      assert.equal(r.body.message, `Unsupported entity type: ${type}`);
      assert.equal(r.reachedHandler, false);
    }
    const repeated = await call("/entities?type=campaign&type=payment", "SUPPORT");
    assert.equal(repeated.status, 400);
    assert.equal(repeated.reachedHandler, false);
  });

  it("unauthenticated request is still 401", async () => {
    const r = await call("/entities?type=campaign");
    assert.equal(r.status, 401);
    assert.equal(r.reachedHandler, false);
  });

  it("/fields is authorized on entity_type, the parameter its handler reads", async () => {
    assert.equal((await call("/fields?entity_type=campaign&network=optimise", "SUPPORT")).status, 200);
    assert.equal((await call("/fields?entity_type=payment", "SUPPORT")).status, 403);
    assert.equal((await call("/fields?entity_type=campaign", "CLIENT")).status, 403);
    const missing = await call("/fields", "ADMIN");
    assert.equal(missing.status, 400);
    assert.equal(missing.body.message, "Query parameter 'entity_type' is required.");
    // `type` is not what /fields filters on, so it does not authorize the request.
    assert.equal((await call("/fields?type=campaign", "ADMIN")).status, 400);
  });

  it("unrelated guards are unchanged", async () => {
    assert.equal((await call("/campaigns-probe", "SUPPORT")).status, 200);
    assert.equal((await call("/campaigns-probe", "CLIENT")).status, 403);
  });

  it("route wiring is unchanged: GET /entities, /entities/summary and /fields keep the guard", () => {
    const routes = fs.readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
    assert.match(routes, /router\.get\(\s*"\/entities",\s*authenticate,\s*requireEntityTypeAccess,/);
    assert.match(routes, /router\.get\(\s*"\/entities\/summary",\s*authenticate,\s*requireEntityTypeAccess,/);
    assert.match(routes, /router\.get\(\s*"\/fields",\s*authenticate,\s*requireEntityTypeAccess,/);
  });
});
