/**
 * Client API endpoint toggles — requireApiEndpoint must be ESM-safe.
 *
 * The backend is native ESM ("type": "module"); the middleware previously resolved the
 * endpoint-toggle helper with a CommonJS `require()` at request time, so an API-key caller
 * authenticated successfully and then crashed with "require is not defined". These tests run
 * the real middleware module end to end.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { requireApiEndpoint } from "../src/middleware/auth.js";

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = mock.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = mock.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
}

function apiKeyRequest({ environment = "PRODUCTION", apiEnvironmentConfig = null, deliveryMethod = "API_ONLY" } = {}) {
  return {
    headers: { "x-api-key": "mbo_live_abcdefghijklmnopqrstuvwx" },
    partnerAuth: { type: "api_key", environment, clientId: "client-a" },
    partnerClient: { id: "client-a", status: "ACTIVE", deliveryMethod, apiEnvironmentConfig },
  };
}

async function run(middleware, req) {
  const res = mockRes();
  const next = mock.fn();
  await middleware(req, res, next);
  return { res, next };
}

describe("Client API endpoint toggles — requireApiEndpoint is ESM-safe", () => {
  it("A. an API-key caller reaches the middleware without an ESM runtime failure", async () => {
    // Regression guard: the middleware module must not resolve dependencies with CommonJS require.
    const source = readFileSync(fileURLToPath(new URL("../src/middleware/auth.js", import.meta.url)), "utf8");
    assert.equal(/\brequire\(/.test(source), false, "auth middleware must not call require() in native ESM");

    const { res, next } = await run(requireApiEndpoint("campaign"), apiKeyRequest());
    assert.equal(next.mock.calls.length, 1);
    assert.equal(res.status.mock.calls.length, 0);
  });

  it("B. enabled endpoint proceeds to the next handler for every endpoint kind", async () => {
    const config = {
      PRODUCTION: { status: "ENABLED", campaignEndpoint: true, productEndpoint: true, reportingEndpoint: true },
    };
    for (const endpoint of ["campaign", "product", "reporting"]) {
      const { res, next } = await run(requireApiEndpoint(endpoint), apiKeyRequest({ apiEnvironmentConfig: config }));
      assert.equal(next.mock.calls.length, 1, endpoint);
      assert.equal(res.status.mock.calls.length, 0, endpoint);
    }
  });

  it("C. disabled endpoint returns the existing 403 without calling next", async () => {
    const config = {
      PRODUCTION: { status: "ENABLED", campaignEndpoint: true, productEndpoint: false, reportingEndpoint: true },
    };
    const { res, next } = await run(requireApiEndpoint("product"), apiKeyRequest({ apiEnvironmentConfig: config }));
    assert.equal(next.mock.calls.length, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
      ok: false,
      message: "The product endpoint is disabled for this client's Production environment.",
    });

    // A disabled environment block gates every endpoint of that environment.
    const disabledEnv = { PRODUCTION: { status: "DISABLED" } };
    const blocked = await run(requireApiEndpoint("campaign"), apiKeyRequest({ apiEnvironmentConfig: disabledEnv }));
    assert.equal(blocked.next.mock.calls.length, 0);
    assert.equal(blocked.res.statusCode, 403);
  });

  it("SANDBOX and PRODUCTION toggles are evaluated independently", async () => {
    const config = {
      SANDBOX: { status: "ENABLED", campaignEndpoint: true, productEndpoint: true, reportingEndpoint: false },
      PRODUCTION: { status: "ENABLED", campaignEndpoint: true, productEndpoint: true, reportingEndpoint: true },
    };
    const sandbox = await run(
      requireApiEndpoint("reporting"),
      apiKeyRequest({ environment: "SANDBOX", apiEnvironmentConfig: config }),
    );
    assert.equal(sandbox.next.mock.calls.length, 0);
    assert.equal(sandbox.res.statusCode, 403);
    assert.equal(sandbox.res.body.message, "The reporting endpoint is disabled for this client's Sandbox environment.");

    const production = await run(
      requireApiEndpoint("reporting"),
      apiKeyRequest({ environment: "PRODUCTION", apiEnvironmentConfig: config }),
    );
    assert.equal(production.next.mock.calls.length, 1);
    assert.equal(production.res.status.mock.calls.length, 0);
  });

  it("D. portal users bypass API endpoint toggles", async () => {
    const config = { PRODUCTION: { status: "DISABLED" }, SANDBOX: { status: "DISABLED" } };
    const req = {
      headers: {},
      partnerAuth: { type: "portal_user", clientId: "client-a" },
      partnerClient: { id: "client-a", status: "ACTIVE", deliveryMethod: "PORTAL_ONLY", apiEnvironmentConfig: config },
    };
    for (const endpoint of ["campaign", "product", "reporting"]) {
      const { res, next } = await run(requireApiEndpoint(endpoint), req);
      assert.equal(next.mock.calls.length, 1, endpoint);
      assert.equal(res.status.mock.calls.length, 0, endpoint);
    }
  });
});
