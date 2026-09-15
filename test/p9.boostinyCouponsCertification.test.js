import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";
// Production spaces Boostiny requests six seconds apart; that stays. Shortened here for a fake client.
process.env.BOOSTINY_MIN_INTERVAL_MS = "1";

const { createBoostinyAdapter, BOOSTINY_COUPONS_PATH, BOOSTINY_CAMPAIGNS_PATH } = await import(
  "../src/adapters/boostiny.adapter.js"
);
const { NetworkCertificationService, listProbeSourceObjects, BOOSTINY_CERTIFICATION_COUPON_PARAMS } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/boostiny.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/sync.job.js", "utf8");

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
function codeOf(source) {
  let out = "";
  let i = 0;
  let quote = null;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }

    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") quote = char;
    out += char;
    i += 1;
  }

  return out;
}

const API_KEY = "zzboostinyapikeyzz";

/** One dedicated coupon row carrying every field the phase wants to observe, each a marker. */
const COUPON = {
  id: "zzcouponidzz",
  campaign_id: "zzcampaignidzz",
  campaign_name: "zzcampaignnamezz",
  coupon: "zzcouponcodezz",
  code: "zzaltcodezz",
  countries: ["zzcountryonezz", "zzcountrytwozz"],
  start_date: "2031-07-08",
  end_date: "2031-09-10",
  status: "zzstatuszz",
  ad_set: "zzadsetzz",
  account_manager: { name: "zzmanagernamezz", email: "zzmanager@example.test" },
  advertiser: { id: "zzadvertiseridzz", name: "zzadvertisernamezz" },
  url: "https://zzcouponurlzz.example/offer",
  terms: "zztermszz",
  description: "zzdescriptionzz",
};
/** A coupon asset with no code under any spelling: still a complete row. */
const CODELESS = { id: "zzcodelessidzz", campaign_id: "zzcampaignidzz", countries: ["zzcountryonezz"], ad_set: "zzadsetzz" };
const SECOND = { id: "zzsecondidzz", coupon: "zzsecondcodezz", secondOnly: true };

/** A campaign row with EMBEDDED coupons, served if anything ever asked the campaigns endpoint. */
const CAMPAIGN_WITH_EMBEDDED = {
  id: "zzembeddedcampaignzz",
  coupons: [{ coupon: "zzembeddedcodezz", countries: ["zzembeddedcountryzz"], start_date: "2031-01-01", ad_set: "zzembeddedadsetzz", account_manager: "zzembeddedmanagerzz" }],
};

function spyHttp(pages = [{ data: [COUPON], pagination: { hasNext: true } }]) {
  const calls = [];
  const sequence = Array.isArray(pages) ? pages : [pages];
  let index = 0;
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, config });
        if (path === BOOSTINY_CAMPAIGNS_PATH) return { data: { data: [CAMPAIGN_WITH_EMBEDDED] } };
        const next = sequence[Math.min(index, sequence.length - 1)];
        index += 1;
        if (next instanceof Error) throw next;
        return { data: next };
      },
    },
  };
}

function adapterWith(spy) {
  return createBoostinyAdapter({ apiKey: API_KEY, httpClient: spy.client });
}

function serviceWith(adapter) {
  return new NetworkCertificationService({
    prisma: {
      rawPayload: {
        findMany: async () => {
          throw new Error("certification must not read RawPayload unless compareRaw is requested");
        },
      },
    },
    adapterFactory: () => adapter,
    boostinyCredentialResolver: async () => ({ apiKey: API_KEY }),
  });
}

async function certifyCoupons(adapter) {
  return serviceWith(adapter).certify("boostiny", { sourceObjects: ["coupons"] });
}

async function rowFor(pages) {
  return (await certifyCoupons(adapterWith(spyHttp(pages)))).results[0];
}

function chainSource() {
  return codeOf(SERVICE_SRC).split("async certifyBoostinyCoupons")[1].split("\n  }")[0];
}

const VALUE_MARKERS = [
  "zzcouponidzz",
  "zzcampaignidzz",
  "zzcampaignnamezz",
  "zzcouponcodezz",
  "zzaltcodezz",
  "zzcountryonezz",
  "zzcountrytwozz",
  "2031-07-08",
  "2031-09-10",
  "zzstatuszz",
  "zzadsetzz",
  "zzmanagernamezz",
  "zzmanager@example.test",
  "zzadvertiseridzz",
  "zzadvertisernamezz",
  "zzcouponurlzz",
  "https://",
  "zztermszz",
  "zzdescriptionzz",
  "zzsecondidzz",
  "zzsecondcodezz",
  "zzembedded",
];

describe("the documented coupons request contract", () => {
  it("addresses exactly GET /publisher/coupons", async () => {
    assert.equal(BOOSTINY_COUPONS_PATH, "/publisher/coupons");
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/publisher/coupons");
  });

  it("is a GET under the catalog's existing name, and the endpointKey names the bounds", async () => {
    const row = await rowFor();
    assert.equal(row.network, "boostiny");
    assert.equal(row.sourceObject, "coupons");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.endpointKey, "GET /publisher/coupons (limit=1, page=1)");
    const entry = getSourceObject("boostiny", "coupons");
    assert.equal(entry.live, true);
    assert.equal(entry.entityType, "coupon");
    assert.ok(listProbeSourceObjects("boostiny").includes("coupons"));
  });

  it("sends page=1 and limit=1, and nothing else", async () => {
    assert.deepEqual(BOOSTINY_CERTIFICATION_COUPON_PARAMS, { page: 1, limit: 1 });
    assert.ok(Object.isFrozen(BOOSTINY_CERTIFICATION_COUPON_PARAMS));
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.deepEqual(spy.calls[0].config.params, { page: 1, limit: 1 });
  });

  it("page and limit are evidenced: production's pager sends both on every coupons call", async () => {
    const spy = spyHttp([{ data: [COUPON] }]);
    await adapterWith(spy).fetchCoupons();
    assert.deepEqual(spy.calls[0].config.params, { page: 1, limit: 100 });
  });

  it("carries a bounded timeout", async () => {
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
  });

  it("reuses the shared client, auth and limiter: no client, header or limiter of its own", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/createHttpClient\(/g) ?? []).length, 1);
    assert.equal((code.match(/createRateLimiter\(/g) ?? []).length, 1);
    assert.ok(!code.includes("Bearer"));
    const chain = chainSource();
    for (const own of ["httpClient", "createHttpClient", "RateLimiter", "acquireSlot", "Authorization", "apiKey"]) {
      assert.ok(!chain.includes(own), own);
    }
    assert.match(codeOf(SERVICE_SRC), /boostiny: "buildBoostinyAdapter"/);
    assert.equal((codeOf(SERVICE_SRC).match(/async buildBoostinyAdapter/g) ?? []).length, 1, "the one builder, shared with campaigns");
  });
});

describe("exactly one request: no retry, no page 2, no pagination loop", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request page 2 on hasNext", async () => {
    const spy = spyHttp([{ data: [COUPON], pagination: { hasNext: true } }, { data: [SECOND] }, { data: [] }]);
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request page 2 on has_next", async () => {
    const spy = spyHttp([{ data: [COUPON], pagination: { has_next: true } }, { data: [SECOND] }, { data: [] }]);
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request page 2 on totalPages, nested or top-level", async () => {
    for (const first of [{ data: [COUPON], pagination: { totalPages: 50 } }, { data: [COUPON], totalPages: 50 }]) {
      const spy = spyHttp([first, { data: [SECOND] }, { data: [] }]);
      await certifyCoupons(adapterWith(spy));
      assert.equal(spy.calls.length, 1, JSON.stringify(first));
    }
  });

  it("does not request page 2 on the full-page heuristic", async () => {
    const spy = spyHttp([{ data: [COUPON] }, { data: [SECOND] }, { data: [] }]);
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("proves the unbounded pager really would have walked on, on each hint", async () => {
    for (const first of [
      { data: [COUPON], pagination: { hasNext: true } },
      { data: [COUPON], pagination: { has_next: true } },
      { data: [COUPON], pagination: { totalPages: 2 } },
      { data: [COUPON], totalPages: 2 },
      { data: [COUPON] },
    ]) {
      const spy = spyHttp([first, { data: [SECOND] }, { data: [] }]);
      await adapterWith(spy).fetchCoupons({ limit: 1 });
      assert.ok(spy.calls.length > 1, JSON.stringify(first));
      assert.equal(spy.calls[1].config.params.page, 2);
    }
  });

  it("does not retry a failed request, including 5xx", async () => {
    for (const failure of [
      new Error("zzsupplierfailurezz"),
      Object.assign(new Error("zz500zz"), { response: { status: 500, data: {} } }),
      Object.assign(new Error("zz503zz"), { response: { status: 503, data: {} } }),
    ]) {
      const spy = spyHttp([failure, { data: [COUPON] }]);
      const row = (await certifyCoupons(adapterWith(spy))).results[0];
      assert.equal(spy.calls.length, 1, failure.message);
      assert.equal(row.ok, false);
    }
  });

  it("proves production really would have retried", async () => {
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp([error, { data: [COUPON] }]);
    const rows = await adapterWith(spy).fetchCoupons();
    assert.equal(spy.calls.length, 2);
    assert.equal(rows.length, 1);
  });

  it("pins the same bounds the campaigns chain pins, through the same seam", () => {
    const chain = chainSource();
    assert.match(chain, /singlePage: true/);
    assert.match(chain, /retries: 1/);
    assert.match(chain, /timeoutMs/);
    assert.match(chain, /BOOSTINY_CERTIFICATION_COUPON_PARAMS/);
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/async function fetchPaginated/g) ?? []).length, 1, "one pager");
    assert.equal((code.match(/\{ singlePage = false, retries, timeoutMs \} = \{\}/g) ?? []).length, 1, "one seam");
    assert.match(code, /fetchPaginated\(httpClient, resolvedEndpoints\.coupons, params, stats, options\)/);
  });
});

describe("the dedicated endpoint, never the embedded campaign coupons", () => {
  it("never asks the campaigns endpoint", async () => {
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.ok(!spy.calls.some((c) => c.path === BOOSTINY_CAMPAIGNS_PATH));
    assert.notEqual(BOOSTINY_COUPONS_PATH, BOOSTINY_CAMPAIGNS_PATH);
  });

  it("calls adapter.fetchCoupons and nothing else on the adapter", () => {
    const chain = chainSource();
    assert.match(chain, /adapter\.fetchCoupons\(/);
    for (const other of ["fetchCampaigns", "fetchPerformance", "fetchLinkPerformance", "fetchAll", ".coupons[", "embedded", "campaign"]) {
      assert.ok(!chain.includes(other), other);
    }
  });

  it("reports OK_NO_ROWS when the dedicated list is empty, even though campaigns embed coupons", async () => {
    const row = await rowFor([{ data: [] }]);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.ok(!JSON.stringify(row).includes("zzembedded"));
  });

  it("defines one fetchCoupons and one coupons path in the adapter", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/async fetchCoupons\(/g) ?? []).length, 1);
    assert.equal((code.match(/"\/publisher\/coupons"/g) ?? []).length, 1);
  });

  it("extracts the rows envelope the way production does", async () => {
    for (const body of [{ data: [COUPON] }, { payload: { data: [COUPON] } }, { results: [COUPON] }, { items: [COUPON] }, [COUPON]]) {
      const row = await rowFor([body]);
      assert.equal(row.sampleCount, 1, JSON.stringify(Object.keys(body)));
    }
  });
});

describe("the sample is bounded to one row, locally too", () => {
  it("keeps one row even when the page carries several", async () => {
    const row = await rowFor([{ data: [COUPON, SECOND, COUPON] }]);
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldPaths.every((f) => f.sampleCount === 1));
    assert.ok(!row.fieldPaths.some((f) => f.path === "secondOnly"));
  });

  it("slices to one in the chain", () => {
    assert.match(chainSource(), /\.slice\(0, 1\)/);
  });
});

describe("a coupon row is a coupon asset, not a coupon code", () => {
  async function paths(pages) {
    return (await rowFor(pages)).fieldPaths.map((f) => f.path);
  }

  it("reports the supplier's own field names, nested included", async () => {
    const seen = await paths();
    for (const supplierName of [
      "id",
      "campaign_id",
      "campaign_name",
      "coupon",
      "code",
      "countries",
      "countries[]",
      "start_date",
      "end_date",
      "status",
      "ad_set",
      "account_manager",
      "account_manager.name",
      "account_manager.email",
      "advertiser",
      "advertiser.id",
      "advertiser.name",
      "url",
      "terms",
      "description",
    ]) {
      assert.ok(seen.includes(supplierName), supplierName);
    }
  });

  it("keeps coupon and code as two supplier fields, and invents neither", async () => {
    const seen = await paths();
    assert.ok(seen.includes("coupon") && seen.includes("code"));
    for (const alias of ["couponCode", "coupon_code", "voucher_code", "voucherCode", "promoCode", "externalId", "campaignId", "campaignName", "countryCode", "currency", "currencyCode", "accountManager", "startDate", "endDate", "landingUrl"]) {
      assert.ok(!seen.includes(alias), alias);
    }
  });

  it("certifies a row with no code under any spelling as a complete row", async () => {
    const row = await rowFor([{ data: [CODELESS] }]);
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    const seen = row.fieldPaths.map((f) => f.path);
    for (const absent of ["coupon", "code", "couponCode"]) assert.ok(!seen.includes(absent), absent);
    for (const present of ["id", "campaign_id", "countries[]", "ad_set"]) assert.ok(seen.includes(present), present);
    assert.ok(row.fieldCount > 0);
  });

  it("does not classify a code-less coupon as invalid or unsupported", async () => {
    const serialised = JSON.stringify(await rowFor([{ data: [CODELESS] }]));
    for (const claim of ["NOT_SUPPORTED", "UNSUPPORTED", "COUPON_CODE_REQUIRED", "INVALID", "COUPON_CODE_PRESENT"]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });

  it("keeps countries as an array of strings, distinct from any currency", async () => {
    const row = await rowFor();
    const byPath = Object.fromEntries(row.fieldPaths.map((f) => [f.path, f]));
    assert.equal(byPath["countries"].observedType, "ARRAY");
    assert.equal(byPath["countries[]"].observedType, "STRING");
    assert.ok(!byPath["currency"]);
  });

  it("describes each path structurally", async () => {
    const row = await rowFor();
    for (const field of row.fieldPaths) {
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
    const byPath = Object.fromEntries(row.fieldPaths.map((f) => [f.path, f]));
    assert.equal(byPath["account_manager"].observedType, "OBJECT");
    assert.equal(byPath["url"].observedType, "URL");
  });

  it("writes no code, relationship or currency meaning into the chain", () => {
    const chain = chainSource();
    for (const forbidden of ["code", "coupon.", "currency", "relationshipState", "joined", "approved", "canonical", "normalise", "normalize", "mapBoostiny", "dedupe", "Coupon."]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });

  it("does not certify a coupon status as a campaign relationship", async () => {
    const serialised = JSON.stringify(await rowFor());
    for (const claim of ["relationshipState", "JOINED", "APPROVED", "NEEDS_ACTIVE_PARTNERSHIP", "COUPON_CODE_PRESENT"]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });
});

describe("the coupons outcome vocabulary", () => {
  it("reports OK with a structural field dictionary", async () => {
    const row = await rowFor();
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.schema, "KNOWN_FROM_LIVE_SAMPLE");
    assert.equal(row.sampleCount, 1);
    assert.equal(row.fieldCount, row.fieldPaths.length);
  });

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for an empty list", async () => {
    for (const empty of [{ data: [] }, { payload: { data: [] } }, {}, []]) {
      const row = await rowFor([empty]);
      assert.equal(row.ok, true, JSON.stringify(empty));
      assert.equal(row.statusCategory, "OK_NO_ROWS");
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
      assert.deepEqual(row.fieldPaths, []);
    }
  });

  it("infers no joined or account state from zero rows", async () => {
    const serialised = JSON.stringify(await rowFor([{ data: [] }]));
    for (const invented of ["NOT_SUPPORTED", "UNSUPPORTED", "accountStateBlocker", "NO_JOINED_CAMPAIGNS", "NEEDS_ACTIVE_PARTNERSHIP", "relationshipState"]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("preserves an auth rejection safely", async () => {
    for (const status of [401, 403]) {
      const error = new Error("zzauthzz");
      error.response = { status, data: { message: `denied for ${API_KEY} on this account` } };
      const row = await rowFor([error]);
      assert.equal(row.ok, false);
      assert.equal(row.statusCategory, "AUTH_FAILED");
      assert.equal(row.supplierStatusCode, status);
      assert.ok(!JSON.stringify(row).includes(API_KEY));
    }
  });

  it("preserves a supplier validation failure safely", async () => {
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: { errors: ["zzvalidationdetailzz"], message: "validation failed" } };
    const row = await rowFor([error]);
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
    assert.ok(!JSON.stringify(row).includes("zzvalidationdetailzz"));
  });

  it("classifies not-found and upstream errors without retrying", async () => {
    for (const [status, category] of [[404, "NOT_FOUND"], [502, "UPSTREAM_ERROR"]]) {
      const error = new Error("zzupstreamzz");
      error.response = { status, data: {} };
      const spy = spyHttp([error]);
      const row = (await certifyCoupons(adapterWith(spy))).results[0];
      assert.equal(row.statusCategory, category);
      assert.equal(spy.calls.length, 1);
    }
  });
});

describe("nothing identifying can leak", () => {
  it("never returns a code, campaign, advertiser, account-manager, country, date, URL or text value", async () => {
    const serialised = JSON.stringify(await rowFor([{ data: [COUPON, SECOND] }]));
    for (const secret of VALUE_MARKERS) assert.ok(!serialised.includes(secret), secret);
  });

  it("never returns the credential or a raw response, on success or on failure", async () => {
    const ok = JSON.stringify(await rowFor());
    const error = new Error(`zzfailurezz ${API_KEY}`);
    error.response = { status: 500, data: { data: [COUPON] }, headers: { "x-account": "zzaccountheaderzz" } };
    const failed = JSON.stringify(await rowFor([error]));
    for (const serialised of [ok, failed]) {
      for (const secret of [API_KEY, "Authorization", 'data":[{', "zzcouponcodezz", "zzaccountheaderzz", "https://"]) {
        assert.ok(!serialised.includes(secret), secret);
      }
    }
  });

  it("returns only the safe result keys", async () => {
    const row = await rowFor();
    for (const forbidden of ["rows", "coupons", "body", "raw", "data", "sample", "headers", "params", "pages"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
    for (const expected of ["network", "sourceObject", "endpointKey", "httpMethod", "sampleCount", "fieldCount", "fieldPaths", "statusCategory", "schema"]) {
      assert.ok(Object.hasOwn(row, expected), expected);
    }
  });
});

describe("read-only, and everything else unchanged", () => {
  it("performs no database read or write", async () => {
    assert.equal((await rowFor()).statusCategory, "OK");
  });

  it("writes nothing in the chain", () => {
    const chain = chainSource();
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany", "rawPayload", "SupplierCoupon", "Promotion"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("leaves production's fetchCoupons paging, retrying and counting as they were", async () => {
    const spy = spyHttp([{ data: [COUPON], pagination: { hasNext: true } }, { data: [SECOND], pagination: { hasNext: false } }]);
    const stats = { requestCount: 0 };
    const rows = await adapterWith(spy).fetchCoupons({}, stats);
    assert.equal(rows.length, 2);
    assert.equal(spy.calls.length, 2);
    assert.equal(stats.requestCount, 2);
    assert.deepEqual(spy.calls[0].config.params, { page: 1, limit: 100 });
    assert.deepEqual(spy.calls[1].config.params, { page: 2, limit: 100 });
    assert.equal(spy.calls[0].config.timeout, undefined);
    for (const seam of ["singlePage", "retries: 1"]) assert.ok(!codeOf(SYNC_SRC).includes(seam), seam);
  });

  it("leaves the campaigns certification unchanged", async () => {
    const spy = spyHttp();
    const row = (await serviceWith(adapterWith(spy)).certify("boostiny", { sourceObjects: ["campaigns"] })).results[0];
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, BOOSTINY_CAMPAIGNS_PATH);
    assert.deepEqual(spy.calls[0].config.params, { page: 1, limit: 1 });
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.endpointKey, "GET /publisher/campaigns (limit=1, page=1)");
    assert.ok(row.fieldPaths.some((f) => f.path === "coupons[].coupon"), "the campaign probe still reports the embedded shape as the campaign's own structure");
  });

  it("leaves performance and link-performance paging unchanged", async () => {
    const perfSpy = spyHttp([{ data: [COUPON], pagination: { hasNext: true } }, { data: [COUPON] }]);
    const performance = await adapterWith(perfSpy).fetchPerformance({});
    assert.equal(performance.rows.length, 2);
    assert.equal(perfSpy.calls[0].path, "/publisher/performance");
    const linkSpy = spyHttp([{ data: [COUPON], pagination: { hasNext: true } }, { data: [COUPON] }]);
    assert.equal((await adapterWith(linkSpy).fetchLinkPerformance({})).length, 2);
    assert.equal(linkSpy.calls[0].path, "/publisher/link-performance");
    const code = codeOf(ADAPTER_SRC);
    for (const untouched of ["fetchPerformance(params = {}, stats = null, options = {})", "fetchLinkPerformance(params = {}, stats = null, options = {})"]) {
      assert.ok(code.includes(untouched), untouched);
    }
  });

  it("runs every Boostiny probe with one request each", async () => {
    const spy = spyHttp([{ data: [COUPON] }]);
    const out = await serviceWith(adapterWith(spy)).certify("boostiny");
    assert.deepEqual(out.results.map((r) => r.sourceObject), ["campaigns", "coupons", "api_reports", "link_reports"]);
    assert.deepEqual(spy.calls.map((c) => c.path), [BOOSTINY_CAMPAIGNS_PATH, BOOSTINY_COUPONS_PATH, "/publisher/performance", "/publisher/link-performance"]);
    assert.ok(out.results.every((r) => r.ok));
  });
});

// Last on purpose: production's shared limiter honours Retry-After after a 429, and that stays.
describe("a rate limit is reported once, safely, and not retried", () => {
  it("classifies 429 as RATE_LIMITED after exactly one request", async () => {
    const error = new Error("zzratelimitzz");
    error.response = {
      status: 429,
      data: { message: `Too Many Attempts for ${API_KEY} today. Retry after 10 minutes.` },
      headers: { "retry-after": "1" },
    };
    const spy = spyHttp([error, { data: [COUPON] }]);
    const row = (await certifyCoupons(adapterWith(spy))).results[0];
    assert.equal(spy.calls.length, 1);
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "RATE_LIMITED");
    assert.equal(row.supplierStatusCode, 429);
    assert.match(row.supplierMessage, /Retry after 10 minutes/);
    assert.ok(!JSON.stringify(row).includes(API_KEY));
  });
});
