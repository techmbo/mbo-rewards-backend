import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { createTrackierAdapter, TRACKIER_COUPONS_PATH } = await import(
  "../src/adapters/trackier.adapter.js"
);
const { NetworkCertificationService, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/trackier.adapter.js", "utf8");
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

const API_KEY = "zztrackierapikeyzz";

/**
 * One coupon row with BOTH shapes the supplier can use: a direct code on the row, and a nested
 * coupons[] list carrying its own codes.
 *
 * Field names plausible, every value a distinctive marker: a realistic code is indistinguishable
 * by substring from a path named code.
 */
const COUPON = {
  id: "zzcouponrowidzz",
  code: "zzdirectcodezz",
  coupons: [
    { code: "zznestedcodeonezz", expiry: "2031-04-19" },
    { code: "zznestedcodetwozz", expiry: "2031-05-20" },
  ],
  description: "zzdescriptiontextzz",
  campaign_id: "zzcampaignidzz",
  campaign_name: "zzcampaignnamezz",
  advertiser: { id: "zzadvertiseridzz", name: "zzmerchantnamezz" },
  status: "zzcouponstatuszz",
  type: "zzcoupontypezz",
  start_date: "2031-03-17",
  end_date: "2031-06-21",
  url: "https://zzcouponurlzz.example/offer",
};

/** A promotional row with NO code anywhere — still a valid row. */
const CODELESS_COUPON = {
  id: "zzcodelessrowidzz",
  description: "zzcodelessdescriptionzz",
  campaign_id: "zzcampaignidzz",
  type: "zzpromotiontypezz",
  start_date: "2031-03-17",
};

const SECOND_COUPON = {
  id: "zzsecondcouponidzz",
  code: "zzsecondcodezz",
  description: "zzseconddescriptionzz",
};

/**
 * A spy whose pages each advertise a next page token, so a chain that follows the cursor shows up
 * immediately as a second call carrying pageToken.
 */
function spyHttp(pages = [{ coupons: [COUPON], nextPageToken: "zztokentwozz" }]) {
  const calls = [];
  const sequence = Array.isArray(pages) ? pages : [pages];
  let index = 0;
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, config });
        const next = sequence[Math.min(index, sequence.length - 1)];
        index += 1;
        if (next instanceof Error) throw next;
        return { data: next };
      },
    },
  };
}

function adapterWith(spy) {
  return createTrackierAdapter({ apiKey: API_KEY, httpClient: spy.client });
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
    trackierCredentialResolver: async () => ({ apiKey: API_KEY }),
  });
}

async function certifyCoupons(adapter) {
  return serviceWith(adapter).certify("trackier", { sourceObjects: ["coupons"] });
}

describe("the documented coupons request contract", () => {
  it("addresses exactly GET /v2/publishers/coupons", async () => {
    assert.equal(TRACKIER_COUPONS_PATH, "/v2/publishers/coupons");
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/v2/publishers/coupons");
  });

  it("is a GET, and the endpointKey names the bound", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.endpointKey, "GET /v2/publishers/coupons (one page, no page token)");
    assert.equal(row.sourceObject, "coupons");
  });

  it("reuses the X-Api-Key auth, with no second header scheme", async () => {
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /"X-Api-Key": String\(apiKey\)/);
    assert.ok(!code.includes("Authorization"));
    assert.ok(!code.includes("Bearer"));
    // Set once on the shared client, never re-sent per request.
    assert.ok(!JSON.stringify(spy.calls[0].config).includes(API_KEY));
  });

  it("sends NO page-size parameter, because none is evidenced for this endpoint", async () => {
    // Production reaches coupons through the page-TOKEN pager and has never sent a limit here.
    // Inventing one would be sending a parameter the endpoint may not publish.
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.deepEqual(spy.calls[0].config.params, {});
    const serialised = JSON.stringify(spy.calls[0].config);
    for (const invented of ["limit", "page", "perPage", "per_page", "size", "count"]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("sends no page token on the one request it makes", async () => {
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.ok(!Object.hasOwn(spy.calls[0].config.params, "pageToken"));
  });

  it("carries a bounded timeout", async () => {
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
  });

  it("is registered under the existing catalog source object", () => {
    const entry = getSourceObject("trackier", "coupons");
    assert.ok(entry);
    assert.equal(entry.endpoint, "GET /v2/publishers/coupons");
    assert.equal(entry.live, true);
    assert.equal(entry.entityType, "coupon");
    assert.ok(listProbeSourceObjects("trackier").includes("coupons"));
    for (const invented of ["coupon", "vouchers", "coupon_codes"]) {
      assert.ok(!listProbeSourceObjects("trackier").includes(invented), invented);
    }
  });
});

describe("exactly one request, no retry, no page-token follow-up", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not follow nextPageToken, even though one is offered", async () => {
    const spy = spyHttp([
      { coupons: [COUPON], nextPageToken: "zztokentwozz" },
      { coupons: [SECOND_COUPON], nextPageToken: "zztokenthreezz" },
      { coupons: [] },
    ]);
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.ok(!JSON.stringify(spy.calls).includes("zztokentwozz"), "the cursor is never sent back");
  });

  it("does not follow a pageToken offered under the alternate key either", async () => {
    const spy = spyHttp([
      { coupons: [COUPON], pageToken: "zzalttokenzz" },
      { coupons: [SECOND_COUPON] },
    ]);
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.ok(!JSON.stringify(spy.calls).includes("zzalttokenzz"));
  });

  it("proves the unbounded pager really would have walked on", async () => {
    // The counter-example: the same responses, through production's own call shape, keep going.
    const spy = spyHttp([
      { coupons: [COUPON], nextPageToken: "zztokentwozz" },
      { coupons: [SECOND_COUPON], nextPageToken: "zztokenthreezz" },
      { coupons: [] },
    ]);
    await adapterWith(spy).fetchCoupons();
    assert.ok(spy.calls.length > 1, "production follows the token; certification must not");
    assert.equal(spy.calls[1].config.params.pageToken, "zztokentwozz");
  });

  it("breaks BEFORE the next token is even read", () => {
    // Not merely "stop after one page": the instruction is not to follow the cursor at all, so the
    // break must come before extractPageToken runs.
    const pager = codeOf(ADAPTER_SRC)
      .split("async function fetchPageTokenPaginated")[1]
      .split("\n}")[0];
    const breakIndex = pager.indexOf("if (singlePage) break;");
    const tokenIndex = pager.indexOf("extractPageToken(");
    assert.ok(breakIndex > 0, "the break exists");
    assert.ok(tokenIndex > breakIndex, "and comes before the token is extracted");
  });

  it("does not retry a failed request", async () => {
    const spy = spyHttp([new Error("zzsupplierfailurezz")]);
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a retryable status either", async () => {
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp([error]);
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("pins the bounds in the chain, and leaves production's defaults alone", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCoupons")[1]
      .split("\n  }")[0];
    assert.match(chain, /singlePage: true/);
    assert.match(chain, /retries: 1/);
    assert.match(chain, /timeoutMs/);
    assert.match(codeOf(ADAPTER_SRC), /retries: 6, delayMs: 2000/);
  });
});

describe("the existing fetcher is reused, not duplicated", () => {
  it("calls production's own fetchCoupons", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCoupons")[1]
      .split("\n  }")[0];
    assert.match(chain, /adapter\.fetchCoupons\(/);
    assert.ok(!chain.includes("createHttpClient"));
    assert.ok(!chain.includes("httpClient.get"));
    assert.ok(!chain.includes("/v2/publishers"));
    assert.ok(!chain.includes("axios"));
  });

  it("adds no second coupons fetcher", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/fetchCoupons\(/g) ?? []).length, 1);
    assert.equal((code.match(/"\/v2\/publishers\/coupons"/g) ?? []).length, 1);
    assert.equal((code.match(/async function fetchPageTokenPaginated\(/g) ?? []).length, 1);
  });

  it("keeps the extractor and rate limiter beyond a caller's reach", async () => {
    // options are spread FIRST, so collectionKeys and the limiter cannot be repointed.
    const code = codeOf(ADAPTER_SRC);
    const fetcher = code.split("fetchCoupons(params = {}, options = {})")[1].split("fetchDeals")[0];
    assert.ok(fetcher.indexOf("...options") < fetcher.indexOf('collectionKeys: ["coupons"]'));

    const spy = spyHttp([{ results: [COUPON], coupons: [] }]);
    const row = (await certifyCoupons(adapterWith(spy))).results[0];
    assert.equal(row.statusCategory, "OK_NO_ROWS", "still reads the coupons key only");
  });

  it("extracts the coupons envelope the way production does", async () => {
    for (const body of [{ coupons: [COUPON] }, { data: { coupons: [COUPON] } }, [COUPON]]) {
      const spy = spyHttp([body]);
      const row = (await certifyCoupons(adapterWith(spy))).results[0];
      assert.equal(row.sampleCount, 1, JSON.stringify(Object.keys(body)));
    }
  });
});

describe("a coupon row is not a coupon code", () => {
  it("preserves the nested coupons[].code structure", async () => {
    const paths = (await certifyCoupons(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(paths.includes("code"), "the direct code path");
    assert.ok(paths.includes("coupons"), "the nested container");
    assert.ok(paths.includes("coupons[].code"), "and the nested code path");
    assert.ok(paths.includes("coupons[].expiry"));
  });

  it("marks the nested container as an array", async () => {
    const byPath = Object.fromEntries(
      (await certifyCoupons(adapterWith(spyHttp()))).results[0].fieldPaths.map((f) => [f.path, f]),
    );
    assert.equal(byPath.coupons.observedType, "ARRAY");
    assert.equal(byPath.coupons.arrayObserved, true);
    assert.equal(byPath.advertiser.observedType, "OBJECT");
    assert.equal(byPath.advertiser.objectObserved, true);
  });

  it("certifies a row with NO code anywhere as a complete row", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp([{ coupons: [CODELESS_COUPON] }])))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    const paths = row.fieldPaths.map((f) => f.path);
    assert.ok(!paths.includes("code"), "no code path, because the row has none");
    assert.ok(paths.includes("description"));
    assert.ok(paths.includes("type"));
    assert.ok(row.fieldCount > 0);
  });

  it("does not classify a code-less row as invalid or unsupported", async () => {
    const serialised = JSON.stringify(
      await certifyCoupons(adapterWith(spyHttp([{ coupons: [CODELESS_COUPON] }]))),
    );
    for (const claim of ["NOT_SUPPORTED", "UNSUPPORTED", "COUPON_CODE_REQUIRED", "INVALID"]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });

  it("preserves the supplier's own field names", async () => {
    const paths = (await certifyCoupons(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const supplierName of ["campaign_id", "campaign_name", "start_date", "end_date", "status", "type"]) {
      assert.ok(paths.includes(supplierName), supplierName);
    }
    for (const alias of ["campaignId", "couponCode", "voucherCode", "merchantName"]) {
      assert.ok(!paths.includes(alias), alias);
    }
  });

  it("creates no tracking link from any URL in the row", async () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCoupons")[1]
      .split("\n  }")[0];
    for (const forbidden of ["TrackingLink", "buildDeepLink", "createTrackingLink", "url"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp())));
    for (const claim of ["trackingLink", "TRACKING_LINK_USABLE", "deepLink"]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });
});

describe("the coupons outcome vocabulary", () => {
  it("reports OK with a structural field dictionary", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
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
  });

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for an empty list", async () => {
    for (const empty of [{ coupons: [] }, { data: { coupons: [] } }, {}]) {
      const row = (await certifyCoupons(adapterWith(spyHttp([empty])))).results[0];
      assert.equal(row.ok, true, JSON.stringify(empty));
      assert.equal(row.statusCategory, "OK_NO_ROWS", JSON.stringify(empty));
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA", JSON.stringify(empty));
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
      assert.deepEqual(row.fieldPaths, []);
    }
  });

  it("invents no relationship or account-state blocker from zero rows", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp([{ coupons: [] }]))));
    for (const invented of [
      "NOT_SUPPORTED",
      "UNSUPPORTED",
      "accountStateBlocker",
      "NO_JOINED_CAMPAIGNS",
      "NEEDS_ACTIVE_PARTNERSHIP",
      "relationshipState",
      "UNKNOWN_FROM_CURRENT_API_SHAPE",
    ]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("preserves an auth rejection safely", async () => {
    const error = new Error("zzupstreamauthmessagezz");
    error.response = { status: 401, data: { message: "zzupstreambodyzz" } };
    const row = (await certifyCoupons(adapterWith(spyHttp([error])))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.equal(row.supplierStatusCode, 401);
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(API_KEY));
    assert.ok(!serialised.includes("zzupstreambodyzz"), "no supplier response body");
  });

  it("preserves a supplier validation failure safely", async () => {
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: {} };
    const row = (await certifyCoupons(adapterWith(spyHttp([error])))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
  });
});

describe("the sample is bounded to one row", () => {
  it("keeps one row even when the page carries several", async () => {
    const spy = spyHttp([{ coupons: [COUPON, SECOND_COUPON, CODELESS_COUPON] }]);
    const row = (await certifyCoupons(adapterWith(spy))).results[0];
    assert.equal(spy.calls.length, 1);
    assert.equal(row.sampleCount, 1);
  });

  it("never returns the later rows' values", async () => {
    const serialised = JSON.stringify(
      await certifyCoupons(adapterWith(spyHttp([{ coupons: [COUPON, SECOND_COUPON] }]))),
    );
    for (const secret of ["zzsecondcouponidzz", "zzsecondcodezz", "zzseconddescriptionzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });
});

describe("nothing identifying can leak", () => {
  it("never returns a coupon code, direct or nested", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp())));
    for (const secret of ["zzdirectcodezz", "zznestedcodeonezz", "zznestedcodetwozz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns campaign identifiers or names", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp())));
    for (const secret of ["zzcampaignidzz", "zzcampaignnamezz", "zzcouponrowidzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the advertiser or merchant identity", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp())));
    for (const secret of ["zzadvertiseridzz", "zzmerchantnamezz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns description text, status, type or dates", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp())));
    for (const secret of [
      "zzdescriptiontextzz",
      "zzcouponstatuszz",
      "zzcoupontypezz",
      "2031-03-17",
      "2031-06-21",
      "2031-04-19",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns URLs, the API key or the raw row", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp())));
    for (const secret of [API_KEY, "X-Api-Key", "zzcouponurlzz", "https://", "coupons\":[{"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("returns only the safe result keys", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    for (const forbidden of ["rows", "coupons", "body", "raw", "data", "sample", "headers"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
    for (const expected of [
      "sourceObject",
      "endpointKey",
      "httpMethod",
      "sampleCount",
      "fieldCount",
      "fieldPaths",
      "statusCategory",
    ]) {
      assert.ok(Object.hasOwn(row, expected), expected);
    }
  });
});

describe("read-only, and the other probes unchanged", () => {
  it("performs no database read or write", async () => {
    assert.equal((await certifyCoupons(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCoupons")[1]
      .split("\n  }")[0];
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("adds no deal, conversion or report path of its own", () => {
    // deals became its own probe on its own chain later. What matters here is that the COUPONS
    // chain still reads coupons and nothing else — the two objects are never merged.
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCoupons")[1]
      .split("\n  }")[0];
    for (const forbidden of ["fetchDeals", "fetchConversions", "fetchReports", "fetchPerformance"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
    for (const notYet of ["tracking", "finance", "reports"]) {
      assert.ok(!listProbeSourceObjects("trackier").includes(notYet), notYet);
    }
  });

  it("leaves production's fetchCoupons following the page token", async () => {
    const spy = spyHttp([
      { coupons: [COUPON], nextPageToken: "zztokentwozz" },
      { coupons: [SECOND_COUPON] },
    ]);
    const rows = await adapterWith(spy).fetchCoupons();
    assert.equal(spy.calls.length, 2);
    assert.equal(spy.calls[0].config.timeout, undefined, "no timeout imposed");
    assert.equal(rows.length, 2);
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchCoupons\(\)/);
  });

  it("leaves fetchDeals on the same pager unchanged", async () => {
    const spy = spyHttp([
      { deals: [{ id: "zzdealonezz" }], nextPageToken: "zztokentwozz" },
      { deals: [{ id: "zzdealtwozz" }] },
    ]);
    const rows = await adapterWith(spy).fetchDeals();
    assert.equal(spy.calls[0].path, "/v2/publishers/deals");
    assert.equal(spy.calls.length, 2, "deals still follows the token");
    assert.equal(rows.length, 2);
  });

  it("leaves the profile, campaigns and campaign_detail probes unchanged", async () => {
    const profileSpy = spyHttp([{ profile: { id: "zzprofileidzz" } }]);
    const profile = (
      await serviceWith(adapterWith(profileSpy)).certify("trackier", { sourceObjects: ["profile"] })
    ).results[0];
    assert.equal(profileSpy.calls[0].path, "/v2/publishers/profile");
    assert.equal(profile.statusCategory, "OK");

    const listSpy = spyHttp([{ campaigns: [{ id: "zzcampaignzz" }] }]);
    const list = (
      await serviceWith(adapterWith(listSpy)).certify("trackier", { sourceObjects: ["campaigns"] })
    ).results[0];
    assert.equal(listSpy.calls[0].path, "/v2/publisher/campaigns");
    assert.deepEqual(listSpy.calls[0].config.params, { limit: 1, page: 1 });
    assert.equal(list.endpointKey, "GET /v2/publisher/campaigns (limit=1, page=1)");

    const detailSpy = spyHttp([{ campaigns: [{ id: "zzdiscoveredzz" }] }, { data: { id: "zzdiscoveredzz" } }]);
    const detail = (
      await serviceWith(adapterWith(detailSpy)).certify("trackier", {
        sourceObjects: ["campaign_detail"],
      })
    ).results[0];
    assert.equal(detailSpy.calls.length, 2);
    assert.equal(detailSpy.calls[1].path, "/v2/publisher/campaign/zzdiscoveredzz");
    assert.equal(detail.discoveryRequestCount, 1);
    assert.equal(detail.detailRequestCount, 1);
  });
});
