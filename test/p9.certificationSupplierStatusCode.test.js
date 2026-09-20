import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.AWIN_MIN_INTERVAL_MS = "1";
process.env.PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS = "1";
process.env.LOG_LEVEL = "silent";

const {
  NetworkCertificationService,
  certificationFailure,
  statusCategory,
  supplierStatusCode,
} = await import("../src/modules/ops/networkCertification.service.js");
const { createAwinAdapter } = await import("../src/adapters/awin.adapter.js");

const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

const TOKEN = "zzaccesstokenzz";
const PUBLISHER_ID = "zzpub9876zz";

/** A supplier error carrying a body, headers and a URL — none of which may ever be reported. */
function supplierError(status, { message = "supplier said no" } = {}) {
  return Object.assign(new Error(message), {
    response: {
      status,
      statusText: "zzstatustextzz",
      data: { error: "zzbodyerrorzz", token: TOKEN, publisher: PUBLISHER_ID, trace: "zztracezz" },
      headers: { "x-request-id": "zzrequestidzz", authorization: `Bearer ${TOKEN}` },
      config: { url: `/publisher/${PUBLISHER_ID}/promotions`, data: '{"filters":{}}' },
    },
    config: { url: `/publisher/${PUBLISHER_ID}/promotions` },
  });
}

function certifyAwinWith(error, sourceObject = "coupons") {
  const calls = [];
  const client = {
    get: async (path, config) => {
      calls.push({ path, config });
      throw error;
    },
    post: async (path, body, config) => {
      calls.push({ path, body, config });
      throw error;
    },
  };
  const service = new NetworkCertificationService({
    prisma: {},
    adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: client }),
    awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
  });
  return service
    .certify("awin", { sourceObjects: [sourceObject] })
    .then((result) => ({ result, entry: result.results[0], calls }));
}

/* ------------------------------------------------------- the helper */

describe("supplierStatusCode — the number, and only the number", () => {
  it("1 — reads an axios response status", () => {
    for (const status of [500, 502, 503, 504, 404, 401, 403, 429, 400, 422]) {
      assert.equal(supplierStatusCode(supplierError(status)), status);
    }
  });

  it("2 — reads a bare .status when there is no response object", () => {
    assert.equal(supplierStatusCode(Object.assign(new Error("x"), { status: 503 })), 503);
  });

  it("3 — a transport failure with no HTTP status yields null", () => {
    for (const error of [
      new Error("socket hang up"),
      Object.assign(new Error("dns"), { code: "ENOTFOUND" }),
      Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      Object.assign(new Error("abort"), { code: "ECONNABORTED" }),
      Object.assign(new Error("no status"), { response: {} }),
      Object.assign(new Error("zero"), { response: { status: 0 } }),
      undefined,
      null,
    ]) {
      assert.equal(supplierStatusCode(error), null, String(error?.message ?? error));
    }
  });

  it("4 — a non-numeric or nonsense status is not reported as a number", () => {
    assert.equal(supplierStatusCode({ response: { status: "gateway timeout" } }), null);
    assert.equal(supplierStatusCode({ response: { status: -1 } }), null);
    assert.equal(supplierStatusCode({ response: { status: 503.5 } }), null);
  });
});

describe("certificationFailure — adds a field, changes none", () => {
  it("5 — statusCategory is exactly what statusCategory() returns", () => {
    for (const status of [500, 502, 503, 504, 404, 401, 403, 429, 400, 418]) {
      const error = supplierError(status);
      const entry = certificationFailure({ network: "x", sourceObject: "y" }, error);
      assert.equal(entry.statusCategory, statusCategory(error), String(status));
      assert.equal(entry.ok, false);
      assert.equal(entry.supplierStatusCode, status);
    }
  });

  it("6 — the four 5xx statuses are distinguishable behind one category", () => {
    const seen = [500, 502, 503, 504].map((s) => certificationFailure({}, supplierError(s)));
    assert.deepEqual([...new Set(seen.map((e) => e.statusCategory))], ["UPSTREAM_ERROR"]);
    assert.deepEqual(seen.map((e) => e.supplierStatusCode), [500, 502, 503, 504]);
  });

  it("7 — 404 and 401/403 keep their own categories and carry their status", () => {
    const notFound = certificationFailure({}, supplierError(404));
    assert.equal(notFound.statusCategory, "NOT_FOUND");
    assert.equal(notFound.supplierStatusCode, 404);
    for (const status of [401, 403]) {
      const entry = certificationFailure({}, supplierError(status));
      assert.equal(entry.statusCategory, "AUTH_FAILED");
      assert.equal(entry.supplierStatusCode, status);
    }
  });

  it("8 — no HTTP status means the KEY IS ABSENT, not null or zero", () => {
    const entry = certificationFailure({ network: "x" }, new Error("socket hang up"));
    assert.equal(entry.statusCategory, "NETWORK_ERROR");
    assert.ok(!("supplierStatusCode" in entry), "a status key was reported without a status");
    assert.deepEqual(Object.keys(entry).sort(), ["network", "ok", "statusCategory"]);
  });

  it("9 — extras are preserved and base fields survive", () => {
    const entry = certificationFailure(
      { network: "partnerize", sourceObject: "campaigns", endpointKey: "GET /x", httpMethod: "GET" },
      supplierError(502),
      { campaignsChecked: 3, sampleCount: 0, fieldPaths: [] },
    );
    assert.equal(entry.campaignsChecked, 3);
    assert.equal(entry.endpointKey, "GET /x");
    assert.equal(entry.supplierStatusCode, 502);
    assert.deepEqual(entry.fieldPaths, []);
  });

  it("10 — nothing but the number leaves: no body, headers, URL or credential", () => {
    const serialised = JSON.stringify(certificationFailure({ network: "awin" }, supplierError(503)));
    // zzbodyerrorzz sits under the allowlisted `error` key, so it IS the supplier's message and is
    // surfaced by design since supplierMessage shipped. Everything else stays out: the trace, the
    // request id, the status text, the credentials, the URL, the request payload, and the internal
    // error.message — which is not a message source at all.
    for (const banned of [
      "zztracezz",
      "zzrequestidzz",
      "zzstatustextzz",
      TOKEN,
      PUBLISHER_ID,
      "promotions",
      "filters",
      "Bearer",
      "supplier said no",
    ]) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
    assert.deepEqual(Object.keys(JSON.parse(serialised)).sort(), [
      "network",
      "ok",
      "statusCategory",
      "supplierMessage",
      "supplierStatusCode",
    ]);
  });
});

/* ------------------------------------------------------- end to end */

describe("a real certification run reports the status", () => {
  it("11 — the AWIN coupons UPSTREAM_ERROR now says which 5xx it was", async () => {
    for (const status of [500, 502, 503, 504]) {
      const { entry } = await certifyAwinWith(supplierError(status));
      assert.equal(entry.sourceObject, "coupons");
      assert.equal(entry.statusCategory, "UPSTREAM_ERROR");
      assert.equal(entry.supplierStatusCode, status);
      assert.equal(entry.ok, false);
      assert.equal(entry.sampleCount, 0);
    }
  });

  it("12 — the same holds for the campaigns GET chain", async () => {
    const { entry } = await certifyAwinWith(supplierError(503), "campaigns");
    assert.equal(entry.statusCategory, "UPSTREAM_ERROR");
    assert.equal(entry.supplierStatusCode, 503);
  });

  it("13 — 404 and 401 round-trip through a real run", async () => {
    const notFound = await certifyAwinWith(supplierError(404));
    assert.equal(notFound.entry.statusCategory, "NOT_FOUND");
    assert.equal(notFound.entry.supplierStatusCode, 404);
    const auth = await certifyAwinWith(supplierError(401));
    assert.equal(auth.entry.statusCategory, "AUTH_FAILED");
    assert.equal(auth.entry.supplierStatusCode, 401);
  });

  it("14 — a transport failure reports no status key at all", async () => {
    const { entry } = await certifyAwinWith(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    assert.equal(entry.statusCategory, "NETWORK_ERROR");
    assert.ok(!("supplierStatusCode" in entry));
  });

  it("15 — the whole run response leaks nothing of the supplier error", async () => {
    const { result } = await certifyAwinWith(supplierError(502));
    const serialised = JSON.stringify(result);
    // zzbodyerrorzz is the supplier's own message under the allowlisted `error` key and surfaces
    // by design; nothing else in the body, headers or config does.
    for (const banned of ["zztracezz", "zzrequestidzz", "zzstatustextzz", TOKEN, PUBLISHER_ID]) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
    assert.equal(result.results[0].supplierMessage, "zzbodyerrorzz");
  });

  it("16 — retry behaviour is untouched: still one attempt", async () => {
    const { calls } = await certifyAwinWith(supplierError(503));
    assert.equal(calls.length, 1, "the failing request was retried");
  });

  it("17 — a success carries no supplierStatusCode", async () => {
    const client = {
      get: async () => ({ data: { programmes: [{ id: 1, name: "x" }] } }),
      post: async () => ({ data: { data: [{ promotionId: 1 }] } }),
    };
    const service = new NetworkCertificationService({
      prisma: {},
      adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: client }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    });
    const result = await service.certify("awin", { sourceObjects: ["campaigns", "coupons"] });
    for (const entry of result.results) {
      assert.equal(entry.ok, true, entry.sourceObject);
      assert.ok(!("supplierStatusCode" in entry), `${entry.sourceObject} reported a status on success`);
    }
  });
});

/* ------------------------------------------------------- applied everywhere */

describe("the failure path is shared, so every network gets it", () => {
  it("18 — no failure site builds its own statusCategory entry any more", () => {
    // The only surviving occurrence is inside certificationFailure itself.
    assert.equal((SERVICE_SRC.match(/statusCategory: statusCategory\(error\)/g) || []).length, 1);
    const helper = SERVICE_SRC.slice(SERVICE_SRC.indexOf("export function certificationFailure"));
    assert.ok(helper.startsWith("export function certificationFailure"));
    assert.ok(helper.includes("statusCategory: statusCategory(error)"));
  });

  it("19 — every catch that reports a supplier failure goes through the helper", () => {
    const uses = (SERVICE_SRC.match(/certificationFailure\(/g) || []).length;
    // One definition plus one call per failure site.
    assert.ok(uses >= 10, `only ${uses} references`);
  });

  it("20 — the categories that are NOT supplier failures are untouched", () => {
    for (const preserved of [
      '"SKIPPED_NO_PUBLISHER_ID"',
      '"SKIPPED_NO_CERTIFICATION_CAMPAIGN_ID"',
      '"PRODUCT_ITEM_SAMPLE_NOT_BOUNDED"',
      '"BLOCKED_NOT_READ_ONLY"',
      '"RUN_BUDGET_EXHAUSTED"',
      '"UNSUPPORTED"',
      '"OK_NO_ROWS"',
    ]) {
      assert.ok(SERVICE_SRC.includes(preserved), preserved);
    }
  });

  it("21 — statusCategory's own mapping is unchanged", () => {
    assert.equal(statusCategory(supplierError(500)), "UPSTREAM_ERROR");
    assert.equal(statusCategory(supplierError(504)), "UPSTREAM_ERROR");
    assert.equal(statusCategory(supplierError(429)), "RATE_LIMITED");
    assert.equal(statusCategory(supplierError(404)), "NOT_FOUND");
    assert.equal(statusCategory(supplierError(403)), "AUTH_FAILED");
    assert.equal(statusCategory(supplierError(400)), "REQUEST_REJECTED");
    assert.equal(statusCategory(new Error("x")), "NETWORK_ERROR");
    assert.equal(statusCategory({ certificationTimeout: true }), "SUPPLIER_TIMEOUT");
    assert.equal(statusCategory({ certificationThrottled: true }), "SUPPLIER_RATE_LIMITED");
  });

  it("22 — the AWIN endpoint and body are unchanged by this task", () => {
    const adapter = readFileSync("src/adapters/awin.adapter.js", "utf8");
    assert.match(adapter, /path: \(resolved\) => `\/publisher\/\$\{resolved\.publisherId\}\/promotions`/);
    assert.match(adapter, /body: \(\) => \(\{ filters: \{\}, pagination: \{ page: 1, pageSize: 200 \} \}\)/);
    // 9A.0b-ii gave production's fetchCoupons a page walk. The certification body above is
    // unchanged, and the page size production asks for is still 200.
    assert.match(adapter, /export const AWIN_OFFERS_PAGE_SIZE = 200;/);
  });
});
