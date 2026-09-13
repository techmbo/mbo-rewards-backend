import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const {
  NetworkCertificationService,
  MAX_SUPPLIER_REQUESTS_PARTNERIZE_VOUCHERS,
  MAX_SUPPLIER_REQUESTS_PER_SOURCE,
  MAX_SUPPLIER_REQUESTS_PRODUCTS,
  MAX_SUPPLIER_REQUESTS_COMMISSION_GROUPS,
  MAX_SUPPLIER_REQUESTS_PARTNERIZE_CAMPAIGNS,
  listProbeSourceObjects,
} = await import("../src/modules/ops/networkCertification.service.js");
const { parseRunBody } = await import("../src/controllers/networkCertification.controller.js");
const { createRateLimiter } = await import("../src/core/rateLimiter.js");
const { createPartnerizeAdapter, firstUsablePartnerizePublisherId, listPartnerizeCertificationSamples } = await import(
  "../src/adapters/partnerize.adapter.js"
);
const partnerizeSource = (await import("node:fs")).readFileSync("src/adapters/partnerize.adapter.js", "utf8");
/** The body of the one-request primitive every Partnerize probe goes through. */
const samplerBody = (() => {
  const start = partnerizeSource.indexOf("async function sampleOnce(");
  return partnerizeSource.slice(start, partnerizeSource.indexOf("\n  }", start));
})();
const serviceSource = (await import("node:fs")).readFileSync(
  "src/modules/ops/networkCertification.service.js",
  "utf8",
);

const APP_KEY = "pz_app_MUSTNOTLEAK";
const USER_KEY = "pz_user_MUSTNOTLEAK";
const PUBLISHER_ID = "998877";

/** Records every outbound request the adapter makes. Nothing here reaches a network. */
function recorder({ data = { id: 1 }, error = null, delayMs = 0 } = {}) {
  const requests = [];
  return {
    requests,
    get: async (path, config = {}) => {
      requests.push({ path, params: config.params, timeout: config.timeout });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (error) throw error;
      return { data };
    },
    post: async () => {
      throw new Error("certification must never POST");
    },
  };
}

describe("Partnerize certification — registry and bounds", () => {
  it("1 — Partnerize exists in the certification registry", () => {
    const expected = ["authenticate", "publishers", "campaigns", "vouchers"];
    assert.deepEqual(listProbeSourceObjects("partnerize"), expected);
    assert.deepEqual(listPartnerizeCertificationSamples(), expected);
  });

  it("2 — an unknown Partnerize source object cannot dispatch", async () => {
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => ({ publisherId: PUBLISHER_ID, fetchCertificationSample: async () => [{ a: 1 }] }),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: PUBLISHER_ID,
      }),
    });
    // vouchers moved out of this list once fetchCoupons evidenced its contract; the rest stay.
    for (const unknown of ["conversions", "payments", "products", "offers", "clicks", "invoices"]) {
      await assert.rejects(
        () => service.certify("partnerize", { sourceObjects: [unknown] }),
        /unknown source objects/i,
        unknown,
      );
    }
  });

  it("2b — the objects deliberately left out are absent from the executable registry", () => {
    const listed = listProbeSourceObjects("partnerize");
    for (const excluded of [
      "conversions",
      "payments",
      // "vouchers" is now executable: GET /user/publisher/{id}/campaign/{id}/voucher is evidenced
      // by fetchCoupons. "coupons" stays out — it is not a Partnerize endpoint name.
      "coupons",
      "products",
      "offers",
      "clicks",
      "order_items",
      "invoices",
      "commission_rules",
    ]) {
      assert.equal(listed.includes(excluded), false, `${excluded} must not be executable yet`);
    }
  });

  it("18 — one request per source object, with campaigns the single declared exception", () => {
    assert.equal(MAX_SUPPLIER_REQUESTS_PER_SOURCE, 1);
    const start = serviceSource.indexOf("const PARTNERIZE_PROBES");
    const block = serviceSource.slice(start, serviceSource.indexOf("});", start));
    // Two chains, and both are approved by name. campaigns may make a second request to discover a
    // publisher id; vouchers may not — it is one request or none.
    assert.deepEqual(
      (block.match(/chain: "[^"]+"/g) || []).sort(),
      ['chain: "partnerizeCampaigns"', 'chain: "partnerizeVouchers"'],
      "an undeclared chain was added",
    );
    assert.equal(MAX_SUPPLIER_REQUESTS_PARTNERIZE_VOUCHERS, 1, "vouchers must stay at one request");
    assert.ok(!block.includes("emits:"), "no Partnerize probe may emit extra rows");
    // authenticate and publishers declare nothing extra.
    const single = block.slice(block.indexOf("authenticate:"), block.indexOf("  campaigns:"));
    assert.ok(!single.includes("chain:") && !single.includes("needs:"), single);
  });

  it("17 — the Optimise request-bound exceptions are unchanged", () => {
    assert.equal(MAX_SUPPLIER_REQUESTS_PRODUCTS, 2);
    assert.equal(MAX_SUPPLIER_REQUESTS_COMMISSION_GROUPS, 6);
    assert.match(serviceSource, /export const MAX_SUPPLIER_REQUESTS_PRODUCTS = 2;/);
    assert.match(serviceSource, /COMMISSION_GROUP_CANDIDATE_LIMIT = 5/);
  });

  it("16 — Optimise certification behaviour is unchanged", () => {
    const optimise = listProbeSourceObjects("optimise");
    assert.equal(optimise.length, 11);
    for (const name of ["campaigns", "conversions", "products", "commission_groups", "campaign_detail"]) {
      assert.ok(optimise.includes(name), `optimise lost ${name}`);
    }
    // Its campaign bootstrap still exists and is still keyed on its own identifiers.
    assert.match(serviceSource, /CAMPAIGN_BOOTSTRAP_NEEDS = new Set\(\["campaignDetailId", "commissionGroupCampaignId"\]\)/);
  });
});

describe("Partnerize certification — the request the sampler actually makes", () => {
  /** The REAL sampler, run against a recording http client injected into the real adapter. */
  async function sample(sourceObject, { publisherId = PUBLISHER_ID, limiter, ...clientOpts } = {}) {
    const httpClient = recorder(clientOpts);
    const adapter = createPartnerizeAdapter({
      applicationKey: APP_KEY,
      userApiKey: USER_KEY,
      publisherId,
      httpClient,
      // A fresh limiter per test: the real one is a module singleton at 750 ms and would make the
      // suite serialise. Spacing behaviour itself is proven separately, against a real limiter.
      certificationRateLimiter: limiter ?? { acquireSlot: async () => {}, resetAfterRateLimit: () => {} },
    });
    const rows = await adapter.fetchCertificationSample(sourceObject, {});
    return { httpClient, rows };
  }

  it("3 — authenticate performs exactly one GET, to /user, with no parameters", async () => {
    const { httpClient } = await sample("authenticate");
    assert.equal(httpClient.requests.length, 1);
    assert.equal(httpClient.requests[0].path, "/user");
    assert.deepEqual(httpClient.requests[0].params, {});
  });

  it("3b — the frozen table declares only GET and only one campaign path", () => {
    const start = partnerizeSource.indexOf("const PARTNERIZE_CERTIFICATION_SAMPLES");
    const table = partnerizeSource.slice(start, partnerizeSource.indexOf("\n});", start));
    assert.match(table, /authenticate: \{ method: "GET", path: \(\) => "\/user", params: \(\) => \(\{\}\) \}/);
    assert.match(table, /publishers: \{ method: "GET", path: \(\) => "\/user\/publisher"/);
    assert.match(table, /campaign\/a`/, "one participation status only");
    assert.match(table, /path: \(resolved\) =>/, "the path argument is resolved values, not caller ctx");
    assert.match(partnerizeSource, /const PARTNERIZE_SINGLE_ROW = \{ limit: 1, offset: 0 \}/);
    // Only GET is ever declared.
    assert.equal((table.match(/method: "GET"/g) || []).length, 4);
    // The voucher entry sends no query parameters, matching fetchCoupons' get(path, {}).
    assert.match(table, /campaign\/\$\{encodeURIComponent\(resolved\.campaignId\)\}\/voucher`,\n\s*params: \(\) => \(\{\}\),/);
    assert.ok(!table.includes('method: "POST"'));
  });

  it("4 — the sampler does not retry", () => {
    const body = samplerBody;
    assert.ok(!body.includes("requestWithRetry"), "must not use the retry wrapper");
    assert.ok(!body.includes("await get("), "must not use the retrying get() helper");
    assert.match(body, /httpClient\.get\(/, "issues the request directly");
  });

  it("5 — the sampler does not paginate", () => {
    const body = samplerBody;
    assert.ok(!body.includes("fetchPaginated"), "must not use the paginator");
    assert.ok(!/while\s*\(/.test(body), "no loop");
    // One loop exists and it is not pagination: it validates the identifiers a spec declares it
    // needs, before any request is issued. No loop may iterate pages, rows or offsets.
    const loops = body.match(/for \(const [^)]+\)/g) || [];
    assert.deepEqual(loops, ["for (const name of required)"], `unexpected loop: ${loops}`);
    assert.ok(!/offset|page|cursor/i.test(body), "the sampler references a pagination parameter");
    assert.match(body, /\.slice\(0, 1\)/, "at most one row");
  });

  it("6 — the publishers probe is one request with the evidenced parameters", async () => {
    const { httpClient } = await sample("publishers");
    assert.equal(httpClient.requests.length, 1);
    assert.equal(httpClient.requests[0].path, "/user/publisher");
    assert.deepEqual(httpClient.requests[0].params, { limit: 1, offset: 0 });
    // Evidence: production code sends these exact keys to this exact endpoint.
    assert.match(partnerizeSource, /get\("\/user\/publisher", \{ limit: 100, offset: 0 \}/);
  });

  it("7 — the campaigns probe is one request against a single participation status", async () => {
    const { httpClient } = await sample("campaigns");
    assert.equal(httpClient.requests.length, 1);
    assert.equal(httpClient.requests[0].path, `/user/publisher/${PUBLISHER_ID}/campaign/a`);
    assert.deepEqual(httpClient.requests[0].params, { limit: 1, offset: 0 });
  });

  it("7b — campaigns without a configured publisher id refuses rather than discovering one", async () => {
    const adapter = createPartnerizeAdapter({
      applicationKey: APP_KEY,
      userApiKey: USER_KEY,
      publisherId: null,
    });
    await assert.rejects(
      () => adapter.fetchCertificationSample("campaigns", {}),
      /requires publisherId/i,
    );
  });

  it("8 — certification never calls the sync fetchers", () => {
    const start = partnerizeSource.indexOf("async fetchCertificationSample");
    const body = partnerizeSource.slice(start, partnerizeSource.indexOf("\n    },", start));
    for (const sync of [
      "fetchCampaigns",
      "fetchConversions",
      "fetchPayments",
      "fetchCoupons",
      "fetchPerformance",
      "fetchAll",
      "resolvePublisherId",
    ]) {
      assert.ok(!body.includes(sync), `sampler must not call ${sync}`);
    }
    // And the service only ever asks for the certification sampler.
    assert.ok(!serviceSource.includes("fetchCampaigns("), "service must not call a sync fetcher");
  });

  it("9 — no fan-out: one status, one publisher, one request", () => {
    const start = partnerizeSource.indexOf("const PARTNERIZE_CERTIFICATION_SAMPLES");
    const table = partnerizeSource.slice(start, partnerizeSource.indexOf("\n});", start));
    assert.ok(!table.includes("partnerizeCampaignListPaths"), "must not expand to several statuses");
    assert.ok(!table.includes("discovery"), "must not add the discovery endpoint");
    // Two campaign-scoped paths now, and neither is a fan-out. The campaign LIST is pinned to one
    // participation status; the voucher path is a different source object addressing one
    // configured campaign. Walking a/p/r, or looping campaigns, would be fan-out.
    assert.equal((table.match(/campaign\/a`/g) || []).length, 1, "exactly one campaign-list path");
    for (const status of ["campaign/p", "campaign/r", "campaign/${status}"]) {
      assert.ok(!table.includes(status), `the table expands to ${status}`);
    }
    assert.equal(
      (table.match(/campaign\/\$\{encodeURIComponent\(resolved\.campaignId\)\}/g) || []).length,
      1,
      "exactly one campaign-scoped path, addressing one configured campaign",
    );
    assert.equal((table.match(/campaign\//g) || []).length, 2, "no third campaign path");
  });

  it("10 — no API-generation fallback inside a probe", () => {
    const start = partnerizeSource.indexOf("async fetchCertificationSample");
    const body = partnerizeSource.slice(start, partnerizeSource.indexOf("\n    },", start));
    for (const generation of ["/v2/", "/v3/", "/reporting/", "campaign-terms-and-conditions"]) {
      assert.ok(!body.includes(generation), `sampler must not reach for ${generation}`);
    }
    assert.ok(!body.includes("catch"), "a failure is reported, never retried against another path");
  });

  it("11 — the request carries a bounded timeout, reduced by the admission wait", async () => {
    const { httpClient } = await sample("authenticate");
    const { timeout } = httpClient.requests[0];
    assert.ok(timeout > 0 && timeout <= 10000, `timeout out of bounds: ${timeout}`);
    assert.match(samplerBody, /timeout: remainingMs/, "the request gets what the budget has left");
    assert.match(samplerBody, /const remainingMs = timeoutMs - \(Date\.now\(\) - startedAt\)/);
    assert.match(partnerizeSource, /PARTNERIZE_CERTIFICATION_TIMEOUT_MS = Number\(\s*process\.env\.CERTIFICATION_SAMPLE_TIMEOUT_MS \|\| 10000,?\s*\)/);
  });

  it("12 — a supplier error is reduced to a category with no body", async () => {
    const error = new Error(`403 for ${APP_KEY} — publisher ${PUBLISHER_ID} not permitted`);
    error.response = { status: 403, data: { message: "forbidden", secret: USER_KEY } };
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => ({
        publisherId: PUBLISHER_ID,
        fetchCertificationSample: async () => {
          throw error;
        },
      }),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: PUBLISHER_ID,
      }),
    });
    const out = await service.certify("partnerize", { sourceObjects: ["authenticate"] });
    assert.equal(out.results[0].statusCategory, "AUTH_FAILED");
    const text = JSON.stringify(out);
    for (const leak of [APP_KEY, USER_KEY, "forbidden", "not permitted", PUBLISHER_ID]) {
      assert.ok(!text.includes(leak), `leaked: ${leak}`);
    }
  });

  it("13 — credentials never appear in a successful result either", async () => {
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => ({
        publisherId: PUBLISHER_ID,
        fetchCertificationSample: async () => [
          { publisher_id: PUBLISHER_ID, name: "MBO", api_key: APP_KEY, secret: USER_KEY },
        ],
      }),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: PUBLISHER_ID,
      }),
    });
    const out = await service.certify("partnerize", { sourceObjects: ["publishers"] });
    assert.equal(out.results[0].statusCategory, "OK");
    const text = JSON.stringify(out);
    for (const leak of [APP_KEY, USER_KEY, PUBLISHER_ID, "MBO"]) {
      assert.ok(!text.includes(leak), `leaked: ${leak}`);
    }
    // But the field names are still reported — that is the point of the probe.
    const paths = out.results[0].fieldPaths.map((f) => f.path).sort();
    assert.deepEqual(paths, ["api_key", "name", "publisher_id", "secret"]);
    // Credential-shaped keys have their category suppressed.
    const byPath = new Map(out.results[0].fieldPaths.map((f) => [f.path, f]));
    assert.equal(byPath.get("api_key").exampleCategory, "REDACTED");
    assert.equal(byPath.get("secret").exampleCategory, "REDACTED");
  });

  it("14 — a caller cannot supply an endpoint, path, publisher id or campaign id", () => {
    for (const key of [
      "endpoint",
      "path",
      "url",
      "method",
      "publisherId",
      "publisher_id",
      "campaignId",
      "campaign_id",
      "status",
      "limit",
      "offset",
    ]) {
      assert.throws(
        () => parseRunBody({ sourceObjects: ["authenticate"], [key]: "x" }),
        (error) => {
          assert.equal(error.statusCode ?? error.status, 400, key);
          assert.match(error.message, /Unsupported field\(s\)/);
          return true;
        },
        `accepted ${key}`,
      );
    }
  });

  it("14b — resolved values never come from ctx", () => {
    // The public entry point hands the closure's id in; the chain hands one it read itself.
    assert.match(partnerizeSource, /return sampleOnce\(sourceObject, \{ publisherId \}, ctx\)/);
    assert.ok(!/ctx\.publisherId/.test(partnerizeSource), "no caller-supplied publisher id anywhere");
    assert.ok(!/ctx\.path|ctx\.endpoint|ctx\.url/.test(samplerBody), "no caller-supplied target");
    assert.match(samplerBody, /spec\.path\(resolved\)/, "the path is built from resolved values only");
  });

  it("15 — a Partnerize certification run performs no database write", async () => {
    const calls = [];
    const writes = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];
    const model = (name) => {
      const target = { findMany: async () => (calls.push(`${name}.findMany`), []) };
      for (const w of writes) {
        target[w] = async () => {
          calls.push(`WRITE:${name}.${w}`);
          throw new Error(`forbidden write: ${name}.${w}`);
        };
      }
      return target;
    };
    const service = new NetworkCertificationService({
      prisma: { rawPayload: model("rawPayload"), marketplaceAccount: model("marketplaceAccount") },
      adapterFactory: () => ({ publisherId: PUBLISHER_ID, fetchCertificationSample: async () => [{ a: 1 }] }),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: PUBLISHER_ID,
      }),
    });
    await service.certify("partnerize", {
      sourceObjects: ["authenticate", "publishers", "campaigns"],
      compareRaw: false,
    });
    assert.equal(calls.some((c) => c.startsWith("WRITE:")), false, calls.join(", "));
  });

  it("missing credentials are reported without describing them", async () => {
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      partnerizeCredentialResolver: async () => null,
    });
    await assert.rejects(
      () => service.certify("partnerize", { sourceObjects: ["authenticate"] }),
      (error) => {
        assert.match(error.message, /Partnerize credentials are not configured/i);
        assert.ok(!/pz_app|pz_user/.test(error.message));
        return true;
      },
    );
  });

  it("a campaigns probe with no discoverable publisher id skips", async () => {
    let called = 0;
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => ({
        publisherId: null,
        fetchCertificationSample: async () => {
          called += 1;
          return [{ a: 1 }];
        },
        fetchCertificationCampaignSample: async () => {
          const error = new Error("no id");
          error.partnerizeNoPublisherId = true;
          throw error;
        },
      }),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: null,
      }),
    });
    const out = await service.certify("partnerize", { sourceObjects: ["campaigns"] });
    assert.equal(out.results[0].statusCategory, "SKIPPED_NO_PUBLISHER_ID");
    assert.equal(called, 0, "no supplier request made");
  });
});

/**
 * A single probe cannot burst, but a single RUN can: one request may ask for three source objects
 * and the service dispatches them one after another. These tests hold the pacing that makes that
 * safe, without reintroducing retries.
 */
describe("Partnerize certification — bounded supplier pacing", () => {
  const INTERVAL = 120;

  /** Records when each request starts and ends, so spacing and overlap are both observable. */
  function timingClient({ delayMs = 20 } = {}) {
    const spans = [];
    return {
      spans,
      get: async (path) => {
        const startedAt = Date.now();
        await new Promise((r) => setTimeout(r, delayMs));
        const endedAt = Date.now();
        spans.push({ path, startedAt, endedAt });
        return { data: { id: 1 } };
      },
    };
  }

  /** One adapter, one real limiter — the shape a single certification run has. */
  function pacedAdapter(httpClient, intervalMs = INTERVAL) {
    return createPartnerizeAdapter({
      applicationKey: APP_KEY,
      userApiKey: USER_KEY,
      publisherId: PUBLISHER_ID,
      httpClient,
      certificationRateLimiter: createRateLimiter(intervalMs),
    });
  }

  it("1 — three source objects in one run are not dispatched back-to-back", async () => {
    const httpClient = timingClient();
    const adapter = pacedAdapter(httpClient);
    for (const source of ["authenticate", "publishers", "campaigns"]) {
      await adapter.fetchCertificationSample(source, {});
    }
    assert.equal(httpClient.spans.length, 3);
    for (let i = 1; i < httpClient.spans.length; i += 1) {
      const gap = httpClient.spans[i].startedAt - httpClient.spans[i - 1].startedAt;
      assert.ok(gap >= INTERVAL - 15, `requests ${i - 1}→${i} were ${gap}ms apart, expected >= ${INTERVAL}`);
    }
  });

  it("1b — concurrent callers are admitted sequentially, never overlapping", async () => {
    const httpClient = timingClient({ delayMs: 40 });
    const adapter = pacedAdapter(httpClient);
    // Fired together on purpose: the limiter, not the caller, must serialise them.
    await Promise.all(
      ["authenticate", "publishers", "campaigns"].map((s) => adapter.fetchCertificationSample(s, {})),
    );
    const ordered = [...httpClient.spans].sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 1; i < ordered.length; i += 1) {
      assert.ok(
        ordered[i].startedAt >= ordered[i - 1].endedAt,
        `request ${i} started before request ${i - 1} finished`,
      );
    }
  });

  it("2 — the configured minimum interval is 750 ms", () => {
    assert.match(
      partnerizeSource,
      /PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS = Number\(\s*process\.env\.PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS \|\| 750,?\s*\)/,
    );
    assert.match(partnerizeSource, /createRateLimiter\(PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS\)/);
    // Its own limiter, not the sync one.
    assert.match(samplerBody, /certLimiter\.acquireSlot\(\)/);
    assert.ok(!samplerBody.includes("partnerizeRateLimiter"), "must not queue on the sync limiter");
    assert.match(partnerizeSource, /const PARTNERIZE_MIN_INTERVAL_MS = Number\(process\.env\.PARTNERIZE_MIN_INTERVAL_MS \|\| 750\)/);
  });

  it("3 — pacing does not add requests: still exactly one per source object", async () => {
    const httpClient = timingClient();
    const adapter = pacedAdapter(httpClient);
    await adapter.fetchCertificationSample("campaigns", {});
    assert.equal(httpClient.spans.length, 1);
    assert.equal(httpClient.spans[0].path, `/user/publisher/${PUBLISHER_ID}/campaign/a`);
  });

  it("4 — retry count remains zero", () => {
    const start = partnerizeSource.indexOf("async fetchCertificationSample");
    const body = partnerizeSource.slice(start, partnerizeSource.indexOf("\n    },", start));
    assert.ok(!body.includes("requestWithRetry"), "no retry wrapper");
    assert.ok(!body.includes("retries"), "no retry count");
    assert.ok(!body.includes("await get("), "not the retrying helper");
  });

  it("4b — a failed request is not re-attempted after admission", async () => {
    let calls = 0;
    const failing = {
      get: async () => {
        calls += 1;
        const error = new Error("boom");
        error.response = { status: 503 };
        throw error;
      },
    };
    await assert.rejects(() => pacedAdapter(failing).fetchCertificationSample("authenticate", {}));
    assert.equal(calls, 1, "a 503 must not be retried");
  });

  it("5 — admission cannot exceed the source budget", async () => {
    // A limiter that never admits: the budget must expire rather than the probe hanging.
    const httpClient = timingClient();
    const adapter = createPartnerizeAdapter({
      applicationKey: APP_KEY,
      userApiKey: USER_KEY,
      publisherId: PUBLISHER_ID,
      httpClient,
      certificationRateLimiter: { acquireSlot: () => new Promise(() => {}), resetAfterRateLimit: () => {} },
    });
    const startedAt = Date.now();
    await assert.rejects(
      () => adapter.fetchCertificationSample("authenticate", { timeoutMs: 200 }),
      (error) => {
        assert.equal(error.certificationThrottled, true);
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1500, `waited ${elapsed}ms — admission must be bounded`);
    assert.equal(httpClient.spans.length, 0, "no request is sent when admission is refused");
  });

  it("5b — the admission wait is charged against the source budget", async () => {
    // A limiter that admits only after a delay: the request must get the remainder, not a fresh
    // full timeout on top of the wait.
    const httpClient = timingClient({ delayMs: 0 });
    const requests = [];
    const observing = {
      get: async (path, config = {}) => {
        requests.push(config.timeout);
        return { data: { id: 1 } };
      },
    };
    const adapter = createPartnerizeAdapter({
      applicationKey: APP_KEY,
      userApiKey: USER_KEY,
      publisherId: PUBLISHER_ID,
      httpClient: observing,
      certificationRateLimiter: {
        acquireSlot: () => new Promise((r) => setTimeout(r, 150)),
        resetAfterRateLimit: () => {},
      },
    });
    await adapter.fetchCertificationSample("authenticate", { timeoutMs: 1000 });
    assert.ok(requests[0] < 1000, `request timeout ${requests[0]} must be reduced by the ~150ms wait`);
    assert.ok(requests[0] > 500, `but not collapsed: ${requests[0]}`);
    assert.equal(httpClient.spans.length, 0);
  });

  it("6 — a throttled probe is reported as a sanitized category", async () => {
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => ({
        publisherId: PUBLISHER_ID,
        fetchCertificationSample: async () => {
          const error = new Error(`throttled for ${APP_KEY} publisher ${PUBLISHER_ID}`);
          error.certificationThrottled = true;
          throw error;
        },
      }),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: PUBLISHER_ID,
      }),
    });
    const out = await service.certify("partnerize", { sourceObjects: ["authenticate"] });
    assert.equal(out.results[0].statusCategory, "SUPPLIER_RATE_LIMITED");
    assert.equal(out.results[0].ok, false);
    const text = JSON.stringify(out);
    for (const leak of [APP_KEY, USER_KEY, PUBLISHER_ID, "throttled for"]) {
      assert.ok(!text.includes(leak), `leaked: ${leak}`);
    }
  });

  it("7 — Optimise pacing is untouched", async () => {
    const optimiseSource = (await import("node:fs")).readFileSync("src/adapters/optimise.adapter.js", "utf8");
    assert.match(optimiseSource, /CERTIFICATION_MIN_INTERVAL_MS = Number\(process\.env\.CERTIFICATION_MIN_INTERVAL_MS \|\| 1000\)/);
    assert.match(optimiseSource, /OPTIMISE_MIN_INTERVAL_MS \|\| 12500/);
    assert.match(optimiseSource, /requestWithRetry\(fn, \{ retries: 6, delayMs: 2000 \}\)/);
    // Partnerize's throttle lives in its own module and cannot affect it.
    assert.ok(!optimiseSource.includes("PARTNERIZE"), "no cross-contamination");
  });

  it("normal Partnerize sync keeps its own limiter and its retries", () => {
    const start = partnerizeSource.indexOf("async function get(path");
    const body = partnerizeSource.slice(start, partnerizeSource.indexOf("\n  }", start));
    assert.match(body, /partnerizeRateLimiter\.acquireSlot\(\)/, "sync still uses the sync limiter");
    assert.match(body, /requestWithRetry/, "sync still retries");
    assert.match(partnerizeSource, /retries: 3,\s*\n\s*delayMs: 900,/);
  });
});

/**
 * The campaigns probe mirrors how production sync resolves a publisher id: configured first, then
 * a bounded discovery call. One request when configured, two when not — and never a third.
 */
describe("Partnerize campaigns — bounded publisher-id discovery chain", () => {
  const DISCOVERED = "554433";
  const CONFIGURED = "998877";
  const CAMPAIGN_ROW = { campaign_id: "c-1", title: "Ubuy", status: "active" };

  /** Answers per path so each leg of the chain can be shaped independently. */
  function chainClient({ publishersData, campaignData = { campaigns: [CAMPAIGN_ROW] }, errors = {} } = {}) {
    const requests = [];
    return {
      requests,
      get: async (path, config = {}) => {
        requests.push({ path, params: config.params, timeout: config.timeout, at: Date.now() });
        if (path === "/user/publisher") {
          if (errors.publishers) throw errors.publishers;
          return { data: publishersData ?? { publishers: [{ publisher_id: DISCOVERED }] } };
        }
        if (errors.campaigns) throw errors.campaigns;
        return { data: campaignData };
      },
    };
  }

  function chainAdapter(httpClient, { publisherId = null, fast = true } = {}) {
    return createPartnerizeAdapter({
      applicationKey: APP_KEY,
      userApiKey: USER_KEY,
      publisherId,
      httpClient,
      certificationRateLimiter: fast
        ? { acquireSlot: async () => {}, resetAfterRateLimit: () => {} }
        : createRateLimiter(120),
    });
  }

  const paths = (httpClient) => httpClient.requests.map((r) => r.path);

  it("1 — a configured publisher id makes exactly one campaign request", async () => {
    const httpClient = chainClient();
    await chainAdapter(httpClient, { publisherId: CONFIGURED }).fetchCertificationCampaignSample({});
    assert.equal(httpClient.requests.length, 1);
    assert.equal(httpClient.requests[0].path, `/user/publisher/${CONFIGURED}/campaign/a`);
    assert.deepEqual(httpClient.requests[0].params, { limit: 1, offset: 0 });
  });

  it("2 — a configured publisher id triggers no discovery call", async () => {
    const httpClient = chainClient();
    await chainAdapter(httpClient, { publisherId: CONFIGURED }).fetchCertificationCampaignSample({});
    assert.equal(paths(httpClient).includes("/user/publisher"), false);
  });

  it("3 — a missing publisher id triggers discovery, then the campaign request", async () => {
    const httpClient = chainClient();
    await chainAdapter(httpClient).fetchCertificationCampaignSample({});
    assert.deepEqual(paths(httpClient), ["/user/publisher", `/user/publisher/${DISCOVERED}/campaign/a`]);
  });

  it("4 — discovery uses limit=1 offset=0", async () => {
    const httpClient = chainClient();
    await chainAdapter(httpClient).fetchCertificationCampaignSample({});
    assert.deepEqual(httpClient.requests[0].params, { limit: 1, offset: 0 });
  });

  it("5 — the first valid supplier-derived id is used, via the production extractor", async () => {
    const httpClient = chainClient({
      publishersData: { publishers: [{ publisher_id: DISCOVERED }, { publisher_id: "111" }] },
    });
    await chainAdapter(httpClient).fetchCertificationCampaignSample({});
    assert.equal(httpClient.requests[1].path, `/user/publisher/${DISCOVERED}/campaign/a`);
    // The nested { publisher: {...} } envelope shape the production extractor also handles.
    assert.equal(firstUsablePartnerizePublisherId({ publishers: [{ publisher: { partner_id: "777" } }] }), "777");
  });

  it("5b — an id carrying path or control syntax is refused, not interpolated", () => {
    for (const hostile of ["12/../admin", "12?x=1", "12#f", "1 2", "12\\\\x", "  "]) {
      assert.equal(
        firstUsablePartnerizePublisherId({ publishers: [{ publisher_id: hostile }] }),
        null,
        hostile,
      );
    }
    // A hostile first entry does not poison a clean later one.
    assert.equal(
      firstUsablePartnerizePublisherId({ publishers: [{ publisher_id: "a/b" }, { publisher_id: "9" }] }),
      "9",
    );
  });

  it("6 — a caller cannot supply a publisher id at any layer", () => {
    for (const key of ["publisherId", "publisher_id", "publishers", "campaignId", "path", "endpoint"]) {
      assert.throws(
        () => parseRunBody({ sourceObjects: ["campaigns"], [key]: "1" }),
        (error) => {
          assert.equal(error.statusCode ?? error.status, 400, key);
          return true;
        },
        `accepted ${key}`,
      );
    }
    // And the chain reads nothing identifier-shaped out of ctx.
    const start = partnerizeSource.indexOf("async fetchCertificationCampaignSample");
    const body = partnerizeSource.slice(start, partnerizeSource.indexOf("\n    },", start));
    assert.ok(!/ctx\.publisherId|ctx\.path|ctx\.endpoint/.test(body));
    assert.match(body, /let resolvedPublisherId = publisherId;/, "starts from the closure");
  });

  it("7 — the discovered id never appears in the certification output", async () => {
    const httpClient = chainClient();
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => chainAdapter(httpClient),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: null,
      }),
    });
    const out = await service.certify("partnerize", { sourceObjects: ["campaigns"] });
    assert.equal(out.results[0].statusCategory, "OK");
    const text = JSON.stringify(out);
    for (const leak of [DISCOVERED, CONFIGURED, "Ubuy", "c-1", APP_KEY, USER_KEY]) {
      assert.ok(!text.includes(leak), `leaked: ${leak}`);
    }
    // Field names are still reported — that is the probe's purpose.
    assert.deepEqual(out.results[0].fieldPaths.map((f) => f.path).sort(), ["campaign_id", "status", "title"]);
  });

  it("8 — the chain performs no database write", async () => {
    const calls = [];
    const writes = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];
    const model = (name) => {
      const t = { findMany: async () => [] };
      for (const w of writes) {
        t[w] = async () => {
          calls.push(`WRITE:${name}.${w}`);
          throw new Error("forbidden write");
        };
      }
      return t;
    };
    const service = new NetworkCertificationService({
      prisma: { rawPayload: model("rawPayload"), marketplaceAccount: model("marketplaceAccount") },
      adapterFactory: () => chainAdapter(chainClient()),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: null,
      }),
    });
    await service.certify("partnerize", { sourceObjects: ["campaigns"] });
    assert.deepEqual(calls, [], "no write attempted");
    // And nothing in the chain reaches for a persistence helper.
    const start = partnerizeSource.indexOf("async fetchCertificationCampaignSample");
    const body = partnerizeSource.slice(start, partnerizeSource.indexOf("\n    },", start));
    for (const token of ["prisma", "marketplaceAccount", "accountExternalId", "upsert", "update("]) {
      assert.ok(!body.includes(token), `chain must not persist: ${token}`);
    }
  });

  it("9 — empty discovery gives SKIPPED_NO_PUBLISHER_ID and no campaign call", async () => {
    const httpClient = chainClient({ publishersData: { publishers: [] } });
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => chainAdapter(httpClient),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: null,
      }),
    });
    const out = await service.certify("partnerize", { sourceObjects: ["campaigns"] });
    assert.equal(out.results[0].statusCategory, "SKIPPED_NO_PUBLISHER_ID");
    assert.equal(out.results[0].sampleCount, 0);
    assert.deepEqual(paths(httpClient), ["/user/publisher"], "no campaign request");
  });

  it("9b — a discovery response whose only id is unusable also skips", async () => {
    const httpClient = chainClient({ publishersData: { publishers: [{ publisher_id: "bad/id" }] } });
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => chainAdapter(httpClient),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: null,
      }),
    });
    const out = await service.certify("partnerize", { sourceObjects: ["campaigns"] });
    assert.equal(out.results[0].statusCategory, "SKIPPED_NO_PUBLISHER_ID");
    assert.equal(httpClient.requests.length, 1);
  });

  it("10/11 — a discovery failure stops the chain with its own category", async () => {
    for (const [status, expected] of [[401, "AUTH_FAILED"], [400, "REQUEST_REJECTED"], [429, "RATE_LIMITED"]]) {
      const error = Object.assign(new Error("x"), { response: { status } });
      const httpClient = chainClient({ errors: { publishers: error } });
      const service = new NetworkCertificationService({
        prisma: { rawPayload: { findMany: async () => [] } },
        adapterFactory: () => chainAdapter(httpClient),
        partnerizeCredentialResolver: async () => ({
          applicationKey: APP_KEY,
          userApiKey: USER_KEY,
          publisherId: null,
        }),
      });
      const out = await service.certify("partnerize", { sourceObjects: ["campaigns"] });
      assert.equal(out.results[0].statusCategory, expected);
      assert.deepEqual(paths(httpClient), ["/user/publisher"], `${expected}: campaigns must not be attempted`);
    }
  });

  it("12 — a campaign-request failure stops, with no fallback", async () => {
    const error = Object.assign(new Error("x"), { response: { status: 403 } });
    const httpClient = chainClient({ errors: { campaigns: error } });
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => chainAdapter(httpClient),
      partnerizeCredentialResolver: async () => ({
        applicationKey: APP_KEY,
        userApiKey: USER_KEY,
        publisherId: null,
      }),
    });
    const out = await service.certify("partnerize", { sourceObjects: ["campaigns"] });
    assert.equal(out.results[0].statusCategory, "AUTH_FAILED");
    assert.equal(httpClient.requests.length, 2, "no third request");
  });

  it("13 — no a/p/r fan-out", async () => {
    const httpClient = chainClient();
    await chainAdapter(httpClient).fetchCertificationCampaignSample({});
    const campaignPaths = paths(httpClient).filter((p) => p.includes("/campaign/"));
    assert.deepEqual(campaignPaths, [`/user/publisher/${DISCOVERED}/campaign/a`]);
    assert.equal(campaignPaths.some((p) => p.endsWith("/p") || p.endsWith("/r")), false);
  });

  it("14/15 — no sync fetcher and no API-generation fallback in the chain", () => {
    const start = partnerizeSource.indexOf("async fetchCertificationCampaignSample");
    const body = partnerizeSource.slice(start, partnerizeSource.indexOf("\n    },", start));
    for (const forbidden of [
      "fetchCampaigns",
      "resolvePublisherId",
      "fetchPaginated",
      "partnerizeCampaignListPaths",
      "/v2/",
      "/v3/",
      "discovery/advertisers",
      "campaign-terms-and-conditions",
    ]) {
      assert.ok(!body.includes(forbidden), `chain must not reach for ${forbidden}`);
    }
  });

  it("16 — the maximum is two supplier requests, and it is declared", async () => {
    assert.equal(MAX_SUPPLIER_REQUESTS_PARTNERIZE_CAMPAIGNS, 2);
    assert.match(serviceSource, /export const MAX_SUPPLIER_REQUESTS_PARTNERIZE_CAMPAIGNS = 2;/);
    const httpClient = chainClient();
    await chainAdapter(httpClient).fetchCertificationCampaignSample({});
    assert.equal(httpClient.requests.length, MAX_SUPPLIER_REQUESTS_PARTNERIZE_CAMPAIGNS);
  });

  it("17 — pacing applies between discovery and the campaign request", async () => {
    const httpClient = chainClient();
    await chainAdapter(httpClient, { fast: false }).fetchCertificationCampaignSample({});
    assert.equal(httpClient.requests.length, 2);
    const gap = httpClient.requests[1].at - httpClient.requests[0].at;
    assert.ok(gap >= 105, `the two legs were ${gap}ms apart, expected >= 120`);
  });

  it("18 — zero retries anywhere in the chain", async () => {
    let calls = 0;
    const failing = {
      get: async () => {
        calls += 1;
        throw Object.assign(new Error("boom"), { response: { status: 503 } });
      },
    };
    await assert.rejects(() => chainAdapter(failing).fetchCertificationCampaignSample({}));
    assert.equal(calls, 1, "discovery failure must not be retried");
    const start = partnerizeSource.indexOf("async fetchCertificationCampaignSample");
    const body = partnerizeSource.slice(start, partnerizeSource.indexOf("\n    },", start));
    assert.ok(!body.includes("requestWithRetry") && !body.includes("retries"));
  });

  it("19 — both legs share one deadline, so the source budget is preserved", async () => {
    const httpClient = chainClient();
    await chainAdapter(httpClient).fetchCertificationCampaignSample({ timeoutMs: 4000 });
    const [discovery, campaign] = httpClient.requests;
    assert.ok(discovery.timeout <= 4000, `discovery ${discovery.timeout}`);
    assert.ok(campaign.timeout <= discovery.timeout, "the second leg gets what the first left");
    const start = partnerizeSource.indexOf("async fetchCertificationCampaignSample");
    const body = partnerizeSource.slice(start, partnerizeSource.indexOf("\n    },", start));
    assert.match(body, /const deadline = Date\.now\(\) \+ totalMs/);
    assert.match(body, /timeoutMs: remaining\(\)/);
  });

  it("20 — authenticate and publishers probes are unchanged", async () => {
    const authClient = chainClient();
    await chainAdapter(authClient, { publisherId: CONFIGURED }).fetchCertificationSample("authenticate", {});
    assert.equal(authClient.requests.length, 1);
    assert.equal(authClient.requests[0].path, "/user");
    assert.deepEqual(authClient.requests[0].params, {});

    const pubClient = chainClient();
    await chainAdapter(pubClient, { publisherId: CONFIGURED }).fetchCertificationSample("publishers", {});
    assert.equal(pubClient.requests.length, 1);
    assert.equal(pubClient.requests[0].path, "/user/publisher");
    assert.deepEqual(pubClient.requests[0].params, { limit: 1, offset: 0 });
  });

  it("21 — Optimise certification is unchanged", () => {
    assert.equal(MAX_SUPPLIER_REQUESTS_PRODUCTS, 2);
    assert.equal(MAX_SUPPLIER_REQUESTS_COMMISSION_GROUPS, 6);
    assert.equal(listProbeSourceObjects("optimise").length, 11);
    assert.match(serviceSource, /probe\.chain === "commissionGroups"/);
    assert.match(serviceSource, /CAMPAIGN_BOOTSTRAP_NEEDS = new Set/);
  });
});
