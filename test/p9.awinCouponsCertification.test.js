import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.AWIN_MIN_INTERVAL_MS = "1";
process.env.LOG_LEVEL = "silent";

const { createAwinAdapter, listAwinCertificationSamples } = await import("../src/adapters/awin.adapter.js");
const { NetworkCertificationService, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);

const ADAPTER_SRC = readFileSync("src/adapters/awin.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

const TOKEN = "zzaccesstokenzz";
const PUBLISHER_ID = "zzpub9876zz";

/** A realistic promotion row, every value distinctive: any of them in the result is a leak. */
const PROMOTION_ROW = {
  promotionId: 556677,
  advertiser: { id: 998877, name: "zzadvertisernamezz" },
  type: "voucher",
  title: "zzpromotitlezz",
  description: "zzpromodescriptionzz",
  terms: "zztermszz",
  voucher: { code: "zzvouchercodezz", exclusive: true },
  url: "https://www.awin1.com/cread.php?zzcreadzz",
  deepLink: "https://zzmerchantzz.example/sale",
  startDate: "2026-09-01T00:00:00",
  endDate: null,
  // Distinctive on purpose: a short value like 7.5 also occurs inside probedAt's ISO
  // timestamp (…:07.512Z), which made the leak assertion below fail about 1 run in 100.
  commission: { amount: 6543.21, currency: "GBP" },
  regions: [{ countryCode: "GB" }],
};

const envelope = (rows) => ({ data: { data: rows } });

function spyHttp(response) {
  const calls = [];
  const handler = async (method, path, a, b) => {
    const config = method === "post" ? b : a;
    calls.push({
      method,
      path,
      body: method === "post" ? a : undefined,
      // The full config, so a body smuggled onto a GET as `data` is visible.
      config: config ?? {},
      params: config?.params,
      timeout: config?.timeout,
    });
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    calls,
    client: {
      get: (path, config) => handler("get", path, config),
      post: (path, body, config) => handler("post", path, body, config),
    },
  };
}

/** The REAL adapter, with only its transport replaced. */
function adapterWith(response, { publisherId = PUBLISHER_ID } = {}) {
  const spy = spyHttp(response);
  return {
    spy,
    adapter: createAwinAdapter({ accessToken: TOKEN, publisherId, httpClient: spy.client }),
  };
}

/** The real service driving the real adapter. No sampler is reimplemented in this file. */
function serviceWith({ response, publisherId = PUBLISHER_ID } = {}) {
  const spy = spyHttp(response);
  return {
    spy,
    service: new NetworkCertificationService({
      prisma: {},
      adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: spy.client }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId }),
    }),
  };
}

const certify = async (opts) => {
  const { service, spy } = serviceWith(opts);
  const result = await service.certify("awin", { sourceObjects: ["coupons"] });
  return { result, spy, entry: result.results.find((r) => r.sourceObject === "coupons") };
};

/* ------------------------------------------------------- registration */

describe("awin coupons is registered", () => {
  it("1 — coupons is a probeable awin source object", () => {
    assert.ok(listProbeSourceObjects("awin").includes("coupons"));
    assert.ok(listAwinCertificationSamples().includes("coupons"));
    // Every adapter sample spec must have a probe. The converse does not hold: commission_groups
    // is probed through a DEDICATED sampler taking a discovered advertiser id as a named argument,
    // rather than through fetchCertificationSample, whose ctx surface stays {timeoutMs, window}.
    const probes = listProbeSourceObjects("awin");
    for (const spec of listAwinCertificationSamples()) {
      assert.ok(probes.includes(spec), `${spec} has a spec but no probe`);
    }
    assert.deepEqual(
      probes.filter((name) => !listAwinCertificationSamples().includes(name)),
      ["commission_groups"],
      "a probe exists with neither a spec nor a dedicated sampler",
    );
  });

  it("1b — campaigns is untouched by its addition", () => {
    assert.ok(listProbeSourceObjects("awin").includes("campaigns"));
    assert.ok(SERVICE_SRC.includes('endpointKey: "GET /publishers/{publisherId}/programmes"'));
  });

  it("1c — no tracking-link certification came with it, and no invented source object", () => {
    // None of these ever became a probe. commission_groups did, in a later phase.
    for (const absent of ["transactions", "invoices", "payments", "product_feeds", "offers"]) {
      assert.ok(!listProbeSourceObjects("awin").includes(absent), absent);
    }
    // awinCommissionGroups arrived in a later phase as its own bounded discovery chain.
    for (const absent of ["awinTransactions", "awinTrackingLinks"]) {
      assert.ok(!SERVICE_SRC.includes(absent), absent);
    }
  });
});

/* ------------------------------------------------------- endpoint pinning */

describe("awin coupons — the endpoint is pinned to production's", () => {
  it("2 — it POSTs to exactly the path fetchCoupons builds", async () => {
    const { spy } = await certify({ response: envelope([PROMOTION_ROW]) });
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].method, "post");
    // `/publisher/` singular: Awin's own inconsistency, copied rather than corrected.
    assert.equal(spy.calls[0].path, `/publisher/${PUBLISHER_ID}/promotions`);
    assert.equal(spy.calls[0].params, undefined, "a POST must not also send query parameters");
  });

  it("2b — production sync still builds that same path and verb", () => {
    // 9A.0b-ii moved the body inline when fetchCoupons learned to walk pages. The path and the
    // verb did not change, and both branches of the fetcher still address exactly this one.
    // Three call sites now: the walk's page fetch, the pinned-pagination escape hatch, and the
    // bounded slice. All three address exactly this path and verb, which is what is pinned.
    assert.equal((ADAPTER_SRC.match(/await post\(\s*`\/publisher\/\$\{pubId\}\/promotions`/g) ?? []).length, 3);
    assert.match(ADAPTER_SRC, /path: \(resolved\) => `\/publisher\/\$\{resolved\.publisherId\}\/promotions`/);
  });

  it("2c — the body is BYTE-IDENTICAL to what production sends", async () => {
    const { spy } = await certify({ response: envelope([PROMOTION_ROW]) });
    assert.deepEqual(spy.calls[0].body, { filters: {}, pagination: { page: 1, pageSize: 200 } });

    // Not asserted by eye, and no longer read out of the source either: since 9A.0b-ii taught
    // fetchCoupons to walk pages, production's body is whatever its FIRST page sends. So it is
    // obtained by running production against a spy and compared to the probe's, which cannot
    // drift the way a regex over defaults could. An earlier probe sent pageSize 1 — smaller, not
    // safer — and the supplier answered HTTP 500.
    const productionCalls = [];
    const productionAdapter = createAwinAdapter({
      accessToken: TOKEN,
      publisherId: PUBLISHER_ID,
      httpClient: {
        get: async () => ({ data: {} }),
        post: async (path, body) => {
          productionCalls.push(body);
          return { data: { data: [] } };
        },
      },
    });
    await productionAdapter.fetchCoupons({}, { requestCount: 0 });
    assert.deepEqual(spy.calls[0].body, productionCalls[0], "the probe body diverged from production's");
  });

  it("2c2 — pageSize 200 is REQUESTED, but only one row is kept", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...PROMOTION_ROW, promotionId: 800000 + i }));
    const { entry, spy } = await certify({ response: envelope(many) });
    assert.equal(spy.calls[0].body.pagination.pageSize, 200, "a smaller page was requested");
    assert.equal(entry.sampleCount, 1, "more than one row was kept");
    assert.equal(entry.fieldPaths[0].sampleCount, 1, "the dictionary was built from more than one row");
  });

  it("2d — the endpointKey reports the real verb", async () => {
    const { entry } = await certify({ response: envelope([PROMOTION_ROW]) });
    // The endpointKey shows the verb an operator would send; httpMethod shows the registry marker
    // that let the read-only guard admit it.
    assert.equal(entry.endpointKey, "POST /publisher/{publisherId}/promotions");
    assert.equal(entry.httpMethod, "POST_READONLY");
    assert.notEqual(entry.statusCategory, "BLOCKED_NOT_READ_ONLY");
  });

  it("2e — the campaigns GET is unaffected by POST support", async () => {
    const { service, spy } = serviceWith({ response: { data: { programmes: [{ id: 1, name: "x" }] } } });
    await service.certify("awin", { sourceObjects: ["campaigns"] });
    assert.equal(spy.calls[0].method, "get");
    // The whole request config, not just the recorded body slot: an axios GET can smuggle a body
    // through `data`, which a body-slot check would miss entirely.
    assert.deepEqual(Object.keys(spy.calls[0].config).sort(), ["params", "timeout"]);
    assert.deepEqual(spy.calls[0].params, { relationship: "joined" });
  });
});

/* ------------------------------------------------------- bounds */

describe("awin coupons — one request, one row, no pagination loop", () => {
  it("3 — exactly one supplier request", async () => {
    const { spy } = await certify({ response: envelope([PROMOTION_ROW]) });
    assert.equal(spy.calls.length, 1);
  });

  it("3b — a supplier that ignores pageSize still yields one row and no second request", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ ...PROMOTION_ROW, promotionId: 700000 + i }));
    const { entry, spy } = await certify({ response: envelope(many) });
    assert.equal(entry.sampleCount, 1, "more than one row was kept");
    assert.equal(spy.calls.length, 1, "a second page was fetched");
  });

  it("3b2 — the SERVICE bounds the row too, independently of the adapter", async () => {
    // Defence in depth: if the adapter's slice were removed or bypassed, the chain must still hold
    // one row. Driven by an adapter whose sampler deliberately returns a full page.
    const many = Array.from({ length: 200 }, (_, i) => ({ ...PROMOTION_ROW, promotionId: 810000 + i }));
    const service = new NetworkCertificationService({
      prisma: {},
      adapterFactory: () => ({
        supplierKey: "AWIN",
        fetchCertificationSample: async () => many,
      }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    });
    const result = await service.certify("awin", { sourceObjects: ["coupons"] });
    const entry = result.results[0];
    assert.equal(entry.sampleCount, 1, "the service kept more than one row");
    assert.equal(entry.fieldPaths[0].sampleCount, 1);
    // And the same guard covers campaigns, since both share one sampler.
    const campaigns = await service.certify("awin", { sourceObjects: ["campaigns"] });
    assert.equal(campaigns.results[0].sampleCount, 1);
  });

  it("3c — page is fixed at 1 and nothing increments it", () => {
    const start = ADAPTER_SRC.indexOf("  coupons: {");
    const spec = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n  },", start));
    assert.match(spec, /pagination: \{ page: 1, pageSize: 200 \}/);
    assert.ok(!/for \(|while \(|page\+\+|hasMore|nextPage/.test(spec), "the spec paginates");
  });

  it("3d — the sampler does not retry, so one rejection stays one", () => {
    const start = ADAPTER_SRC.indexOf("async fetchCertificationSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.ok(!body.includes("requestWithRetry"), "the probe inherited sync's three retries");
    assert.ok(!body.includes("await post("), "the probe went through the retrying helper");
    assert.ok(body.includes("awinRateLimiter.acquireSlot()"), "the probe skips the shared limiter");
  });

  it("3e — a supplier failure is one attempt reduced to a category", async () => {
    const failure = Object.assign(new Error("boom"), { response: { status: 500 } });
    const { entry, spy } = await certify({ response: failure });
    assert.equal(spy.calls.length, 1, "the request was retried");
    assert.equal(entry.ok, false);
    assert.ok(entry.statusCategory !== "OK" && entry.statusCategory !== "OK_NO_ROWS");
    assert.equal(entry.sampleCount, 0);
  });
});

/* ------------------------------------------------------- publisher id */

describe("awin coupons — nothing is caller-controlled", () => {
  it("4 — a caller-supplied publisherId, path or body does not reach the request", async () => {
    const { service, spy } = serviceWith({ response: envelope([PROMOTION_ROW]) });
    await service.certify("awin", {
      sourceObjects: ["coupons"],
      publisherId: "zzattackerzz",
      path: "/publisher/zzattackerzz/promotions",
      filters: { advertiserId: "zzattackerzz" },
      pagination: { page: 9, pageSize: 5000 },
      pageSize: 1,
    });
    assert.equal(spy.calls[0].path, `/publisher/${PUBLISHER_ID}/promotions`);
    assert.deepEqual(spy.calls[0].body, { filters: {}, pagination: { page: 1, pageSize: 200 } });
    assert.ok(!JSON.stringify(spy.calls).includes("zzattackerzz"));
  });

  it("4b — the adapter ignores a body or publisherId handed to the sampler in ctx", async () => {
    const { adapter, spy } = adapterWith(envelope([PROMOTION_ROW]));
    await adapter.fetchCertificationSample("coupons", {
      publisherId: "zzattackerzz",
      body: { filters: { advertiserId: "zzattackerzz" }, pagination: { page: 9, pageSize: 5000 } },
    });
    assert.equal(spy.calls[0].path, `/publisher/${PUBLISHER_ID}/promotions`);
    assert.deepEqual(spy.calls[0].body, { filters: {}, pagination: { page: 1, pageSize: 200 } });
  });

  it("4b2 — a mutating verb is refused by the service, and the guard is unweakened", () => {
    assert.match(SERVICE_SRC, /const READ_ONLY_METHODS = new Set\(\["GET", "POST_READONLY"\]\);/);
    assert.match(SERVICE_SRC, /if \(!READ_ONLY_METHODS\.has\(probe\.method\)\) \{/);
    // Every registered probe, on every network, declares a method the guard admits.
    const methods = [...SERVICE_SRC.matchAll(/method: "([A-Z_]+)"/g)].map((m) => m[1]);
    assert.ok(methods.length > 10);
    assert.deepEqual([...new Set(methods)].sort(), ["GET", "POST_READONLY"]);
  });

  it("4c — the verb comes from the spec, not from a caller", () => {
    const start = ADAPTER_SRC.indexOf("async fetchCertificationSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.match(body, /spec\.method === "POST_READONLY"/);
    assert.ok(!/ctx\.method/.test(body), "the verb can be chosen by a caller");
    assert.deepEqual(
      [...new Set([...body.matchAll(/ctx\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort(),
      ["timeoutMs", "window"],
    );
  });
});

/* ------------------------------------------------------- outcomes */

describe("awin coupons — honest outcomes", () => {
  it("5 — one row yields a structural field dictionary", async () => {
    const { entry } = await certify({ response: envelope([PROMOTION_ROW]) });
    assert.equal(entry.ok, true);
    assert.equal(entry.statusCategory, "OK");
    assert.equal(entry.sampleCount, 1);
    assert.ok(entry.fieldCount > 5);
    assert.equal(entry.fieldCount, entry.fieldPaths.length);
    const paths = entry.fieldPaths.map((f) => f.path);
    assert.ok(paths.includes("voucher.exclusive"));
    assert.ok(paths.includes("commission.currency"));
    assert.ok(paths.includes("regions[].countryCode"));
  });

  it("5b — all three evidenced collection keys are read, as production reads them", async () => {
    for (const payload of [{ data: [PROMOTION_ROW] }, { promotions: [PROMOTION_ROW] }, { offers: [PROMOTION_ROW] }]) {
      const { adapter } = adapterWith({ data: payload });
      assert.equal((await adapter.fetchCertificationSample("coupons")).length, 1);
    }
    // Production's keys AND the probe spec's own — the mutation that narrows the spec must fail
    // even though extractCollection's generic fallback would still find the array.
    assert.match(ADAPTER_SRC, /extractCollection\(envelope, \["data", "promotions", "offers"\]\)/);
    const start = ADAPTER_SRC.indexOf("  coupons: {");
    const spec = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n  },", start));
    assert.match(spec, /collectionKeys: \["data", "promotions", "offers"\],/);
    // And campaigns keeps its own, different pair.
    const cStart = ADAPTER_SRC.indexOf("  campaigns: {");
    assert.match(ADAPTER_SRC.slice(cStart, ADAPTER_SRC.indexOf("\n  },", cStart)), /collectionKeys: \["programmes", "data"\],/);
  });

  it("6 — zero rows is OK_NO_ROWS with the schema still unknown", async () => {
    const { entry, spy } = await certify({ response: envelope([]) });
    assert.equal(entry.ok, true, "the endpoint answered; it is not a failure");
    assert.equal(entry.statusCategory, "OK_NO_ROWS");
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(entry.sampleCount, 0);
    assert.equal(entry.fieldCount, 0);
    assert.deepEqual(entry.fieldPaths, []);
    assert.equal(spy.calls.length, 1);
  });

  it("6b — OK_NO_ROWS is not plain OK, and a sampled row is not marked unknown", async () => {
    const empty = await certify({ response: envelope([]) });
    const sampled = await certify({ response: envelope([PROMOTION_ROW]) });
    assert.notEqual(empty.entry.statusCategory, sampled.entry.statusCategory);
    assert.equal(sampled.entry.schema, undefined);
  });

  it("7 — read-only: the shared chain writes nothing", async () => {
    const { result } = await certify({ response: envelope([PROMOTION_ROW]) });
    assert.equal(result.readOnly, true);
    const start = SERVICE_SRC.indexOf("async certifyAwinSample(");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.ok(!/this\.db\.|prisma\.|\.create\(|\.update\(|\.upsert\(/.test(body), "the chain writes");
  });

  it("7b — the POST creates nothing: the body carries empty filters only", async () => {
    const { spy } = await certify({ response: envelope([PROMOTION_ROW]) });
    assert.deepEqual(Object.keys(spy.calls[0].body).sort(), ["filters", "pagination"]);
    assert.deepEqual(spy.calls[0].body.filters, {}, "a filter would narrow, but none is sent");
  });

  it("7c — campaigns and coupons share one control flow and cannot drift", () => {
    const start = SERVICE_SRC.indexOf("async certifyAwinSample(");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.equal((body.match(/statusCategory: "OK_NO_ROWS"/g) || []).length, 1);
    for (const name of ["certifyAwinCampaigns", "certifyAwinCoupons"]) {
      const own = SERVICE_SRC.slice(SERVICE_SRC.indexOf(`async ${name}(`), SERVICE_SRC.indexOf(`async ${name}(`) + 180);
      assert.ok(!own.includes("OK_NO_ROWS"), `${name} implements its own control flow`);
    }
  });
});

/* ------------------------------------------------------- leakage */

describe("awin coupons — nothing but structure leaves", () => {
  it("8 — no code, id, title, description, URL, date or money value appears", async () => {
    const { result } = await certify({ response: envelope([PROMOTION_ROW]) });
    const serialised = JSON.stringify(result);
    for (const banned of [
      "zzvouchercodezz",
      "zzpromotitlezz",
      "zzpromodescriptionzz",
      "zztermszz",
      "zzadvertisernamezz",
      "zzmerchantzz",
      "zzcreadzz",
      "556677",
      "998877",
      "6543.21",
      "GBP",
      "2026-09-01",
      "awin1.com",
      "https://",
      TOKEN,
      PUBLISHER_ID,
    ]) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
  });

  it("8b — every reported field is structure only, and no raw payload is returned", async () => {
    const { entry } = await certify({ response: envelope([PROMOTION_ROW]) });
    for (const field of entry.fieldPaths) {
      assert.deepEqual(Object.keys(field).sort(), [
        "arrayObserved",
        "exampleCategory",
        "nullableObserved",
        "objectObserved",
        "observedType",
        "path",
        "presentCount",
        "sampleCount",
      ]);
    }
    assert.equal(entry.rows, undefined, "raw rows were returned");
    assert.equal(entry.rawPayload, undefined);
    // The voucher code is reported as a typed PATH, never as its value.
    const code = entry.fieldPaths.find((f) => f.path === "voucher.code");
    assert.equal(code.observedType, "STRING");
  });

  it("8c — a supplier error quoting the token is reduced to a category", async () => {
    const leaky = Object.assign(new Error(`401 for Bearer ${TOKEN}`), {
      response: { status: 401, data: { token: TOKEN, publisher: PUBLISHER_ID } },
    });
    const { result } = await certify({ response: leaky });
    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes(TOKEN));
    assert.ok(!serialised.includes(PUBLISHER_ID));
    assert.equal(result.results[0].statusCategory, "AUTH_FAILED");
  });
});

/* ------------------------------------------------------- no collateral change */

describe("nothing else changed", () => {
  it("9 — Optimise and Partnerize registries are untouched", () => {
    assert.equal(listProbeSourceObjects("optimise").length, 11);
    assert.equal(listProbeSourceObjects("partnerize").length, 8);
  });

  it("9b — production's fetchers keep the contract certification depends on", () => {
    assert.match(ADAPTER_SRC, /async fetchCoupons\(params = \{\}, stats = null\) \{/);
    // 9A.0b-ii gave fetchCoupons a page walk. What certification depends on is unchanged: the page
    // size is still 200 and still not a variable, and a caller that pins pagination still gets
    // exactly that one page.
    assert.match(ADAPTER_SRC, /export const AWIN_OFFERS_PAGE_SIZE = 200;/);
    assert.match(ADAPTER_SRC, /if \(params\.pagination\) \{/);
    assert.match(ADAPTER_SRC, /\{ filters, pagination: params\.pagination \}/);
    assert.match(ADAPTER_SRC, /showBasketProducts: params\.showBasketProducts !== false,/);
    const start = ADAPTER_SRC.indexOf("async fetchCertificationSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.ok(!body.includes("fetchCoupons"), "certification reuses the sync fetcher");
  });
});
