import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { createTrackierAdapter, TRACKIER_COUPONS_PATH, TRACKIER_DEALS_PATH } = await import(
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
 * One deal row carrying ALL THREE code-ish fields the mapper may look for, each distinct, plus a
 * title and a description that must never become one.
 *
 * Field names plausible, every value a distinctive marker: a realistic title is indistinguishable
 * by substring from a path named title.
 */
const DEAL = {
  id: "zzdealrowidzz",
  campaign_id: "zzcampaignidzz",
  campaign_name: "zzcampaignnamezz",
  title: "zzdealtitlezz",
  description: "zzdealdescriptionzz",
  code: "zzdealcodezz",
  coupon: "zzcouponfieldzz",
  deal_code: "zzdealcodefieldzz",
  status: "zzdealstatuszz",
  type: "zzdealtypezz",
  url: "https://zzdealurlzz.example/offer",
  start: "2031-03-17",
  end: "2031-06-21",
  created: "2031-01-02",
};

/** A deal with a title and description but NO code of any spelling — still a valid deal. */
const CODELESS_DEAL = {
  id: "zzcodelessdealidzz",
  title: "zzcodelesstitlezz",
  description: "zzcodelessdescriptionzz",
  campaign_id: "zzcampaignidzz",
  type: "zzpromotiontypezz",
};

const SECOND_DEAL = {
  id: "zzseconddealidzz",
  title: "zzsecondtitlezz",
  code: "zzsecondcodezz",
};

/** Pages that each advertise a next token, so following the cursor shows up as a second call. */
function spyHttp(pages = [{ deals: [DEAL], nextPageToken: "zztokentwozz" }]) {
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

async function certifyDeals(adapter) {
  return serviceWith(adapter).certify("trackier", { sourceObjects: ["deals"] });
}

describe("the documented deals request contract", () => {
  it("addresses exactly GET /v2/publishers/deals", async () => {
    assert.equal(TRACKIER_DEALS_PATH, "/v2/publishers/deals");
    const spy = spyHttp();
    await certifyDeals(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/v2/publishers/deals");
  });

  it("is a GET, and the endpointKey names the bound", async () => {
    const row = (await certifyDeals(adapterWith(spyHttp()))).results[0];
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.endpointKey, "GET /v2/publishers/deals (one page, no page token)");
    assert.equal(row.sourceObject, "deals");
  });

  it("is a different endpoint from coupons, and never asks for that one", async () => {
    assert.notEqual(TRACKIER_DEALS_PATH, TRACKIER_COUPONS_PATH);
    const spy = spyHttp();
    await certifyDeals(adapterWith(spy));
    assert.ok(!spy.calls.some((c) => c.path === TRACKIER_COUPONS_PATH));
  });

  it("reuses the X-Api-Key auth, with no second header scheme", async () => {
    const spy = spyHttp();
    await certifyDeals(adapterWith(spy));
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /"X-Api-Key": String\(apiKey\)/);
    assert.ok(!code.includes("Authorization"));
    assert.ok(!code.includes("Bearer"));
    assert.ok(!JSON.stringify(spy.calls[0].config).includes(API_KEY));
  });

  it("sends NO page-size parameter, because none is evidenced for this endpoint", async () => {
    const spy = spyHttp();
    await certifyDeals(adapterWith(spy));
    assert.deepEqual(spy.calls[0].config.params, {});
    const serialised = JSON.stringify(spy.calls[0].config);
    for (const invented of ["limit", "page", "perPage", "per_page", "size", "count"]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("sends no page token on the one request it makes", async () => {
    const spy = spyHttp();
    await certifyDeals(adapterWith(spy));
    assert.ok(!Object.hasOwn(spy.calls[0].config.params, "pageToken"));
  });

  it("carries a bounded timeout", async () => {
    const spy = spyHttp();
    await certifyDeals(adapterWith(spy));
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
  });

  it("is catalogued as its own live source object", () => {
    const entry = getSourceObject("trackier", "deals");
    assert.ok(entry);
    assert.equal(entry.endpoint, "GET /v2/publishers/deals");
    assert.equal(entry.live, true);
    assert.ok(listProbeSourceObjects("trackier").includes("deals"));
    // The sync job already read it under this name; it simply had no catalog entry.
    assert.match(codeOf(SYNC_SRC), /fetchTrackierSourceObject\("deals"/);
  });
});

describe("exactly one request, no retry, no page-token follow-up", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await certifyDeals(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not follow nextPageToken, even though one is offered", async () => {
    const spy = spyHttp([
      { deals: [DEAL], nextPageToken: "zztokentwozz" },
      { deals: [SECOND_DEAL], nextPageToken: "zztokenthreezz" },
      { deals: [] },
    ]);
    await certifyDeals(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.ok(!JSON.stringify(spy.calls).includes("zztokentwozz"), "the cursor is never sent back");
  });

  it("does not follow a pageToken offered under the alternate key either", async () => {
    const spy = spyHttp([{ deals: [DEAL], pageToken: "zzalttokenzz" }, { deals: [SECOND_DEAL] }]);
    await certifyDeals(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.ok(!JSON.stringify(spy.calls).includes("zzalttokenzz"));
  });

  it("proves the unbounded pager really would have walked on", async () => {
    const spy = spyHttp([
      { deals: [DEAL], nextPageToken: "zztokentwozz" },
      { deals: [SECOND_DEAL], nextPageToken: "zztokenthreezz" },
      { deals: [] },
    ]);
    await adapterWith(spy).fetchDeals();
    assert.ok(spy.calls.length > 1, "production follows the token; certification must not");
    assert.equal(spy.calls[1].config.params.pageToken, "zztokentwozz");
  });

  it("does not retry a failed request", async () => {
    const spy = spyHttp([new Error("zzsupplierfailurezz")]);
    await certifyDeals(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a retryable status either", async () => {
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp([error]);
    await certifyDeals(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("pins the bounds in the chain, and leaves production's defaults alone", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierDeals")[1]
      .split("\n  }")[0];
    assert.match(chain, /singlePage: true/);
    assert.match(chain, /retries: 1/);
    assert.match(chain, /timeoutMs/);
    assert.match(codeOf(ADAPTER_SRC), /retries: 6, delayMs: 2000/);
  });
});

describe("deals are certified independently of coupons", () => {
  it("has its own chain, not a parameter on the coupons one", () => {
    assert.match(codeOf(SERVICE_SRC), /chain: "trackierDeals"/);
    assert.match(codeOf(SERVICE_SRC), /async certifyTrackierDeals\(/);
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierDeals")[1]
      .split("\n  }")[0];
    assert.match(chain, /adapter\.fetchDeals\(/);
    assert.ok(!chain.includes("fetchCoupons"), "never reads the coupons endpoint");
  });

  it("reads the deals key, and a caller cannot repoint it at coupons", async () => {
    const code = codeOf(ADAPTER_SRC);
    const fetcher = code.split("fetchDeals(params = {}, options = {})")[1].split("fetchConversions")[0];
    assert.ok(fetcher.indexOf("...options") < fetcher.indexOf('collectionKeys: ["deals"]'));

    // A body carrying a coupons key and no deals key yields no rows.
    const spy = spyHttp([{ coupons: [DEAL], deals: [] }]);
    const row = (await certifyDeals(adapterWith(spy))).results[0];
    assert.equal(row.statusCategory, "OK_NO_ROWS");
  });

  it("merges nothing: the coupons probe still reads its own endpoint", async () => {
    const spy = spyHttp([{ coupons: [{ id: "zzcouponzz", code: "zzcouponcodezz" }] }]);
    const row = (
      await serviceWith(adapterWith(spy)).certify("trackier", { sourceObjects: ["coupons"] })
    ).results[0];
    assert.equal(spy.calls[0].path, "/v2/publishers/coupons");
    assert.equal(row.endpointKey, "GET /v2/publishers/coupons (one page, no page token)");
    assert.equal(row.statusCategory, "OK");
  });

  it("extracts the deals envelope the way production does", async () => {
    for (const body of [{ deals: [DEAL] }, { data: { deals: [DEAL] } }, [DEAL]]) {
      const spy = spyHttp([body]);
      const row = (await certifyDeals(adapterWith(spy))).results[0];
      assert.equal(row.sampleCount, 1, JSON.stringify(Object.keys(body)));
    }
  });

  it("adds no second deals fetcher", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/fetchDeals\(/g) ?? []).length, 1);
    assert.equal((code.match(/"\/v2\/publishers\/deals"/g) ?? []).length, 1);
  });
});

describe("a deal row is not a coupon code", () => {
  it("keeps code, coupon and deal_code as three separate supplier fields", async () => {
    const paths = (await certifyDeals(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const field of ["code", "coupon", "deal_code"]) {
      assert.ok(paths.includes(field), field);
    }
    assert.equal(new Set(["code", "coupon", "deal_code"]).size, 3);
    // None is renamed into the others, or into an MBO alias.
    for (const alias of ["couponCode", "dealCode", "voucher_code", "coupon_code"]) {
      assert.ok(!paths.includes(alias), alias);
    }
  });

  it("keeps title and description distinct from each other", async () => {
    const paths = (await certifyDeals(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(paths.includes("title"));
    assert.ok(paths.includes("description"));
    assert.notEqual("title", "description");
  });

  it("certifies a deal with NO code of any spelling as a complete row", async () => {
    const row = (await certifyDeals(adapterWith(spyHttp([{ deals: [CODELESS_DEAL] }])))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    const paths = row.fieldPaths.map((f) => f.path);
    for (const absent of ["code", "coupon", "deal_code"]) {
      assert.ok(!paths.includes(absent), absent);
    }
    // The row is still fully reported.
    assert.ok(paths.includes("title"));
    assert.ok(paths.includes("description"));
    assert.ok(row.fieldCount > 0);
  });

  it("never promotes a title or description into a code", async () => {
    const row = (await certifyDeals(adapterWith(spyHttp([{ deals: [CODELESS_DEAL] }])))).results[0];
    const paths = row.fieldPaths.map((f) => f.path);
    assert.ok(!paths.includes("code"), "no code is manufactured from the title");
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierDeals")[1]
      .split("\n  }")[0];
    for (const forbidden of ["title", "description", "code", "coupon"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });

  it("does not classify a code-less deal as invalid or unsupported", async () => {
    const serialised = JSON.stringify(
      await certifyDeals(adapterWith(spyHttp([{ deals: [CODELESS_DEAL] }]))),
    );
    for (const claim of ["NOT_SUPPORTED", "UNSUPPORTED", "COUPON_CODE_REQUIRED", "INVALID"]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });

  it("creates no tracking link from any URL in the row", async () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierDeals")[1]
      .split("\n  }")[0];
    for (const forbidden of ["TrackingLink", "buildDeepLink", "createTrackingLink", "url"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
    const serialised = JSON.stringify(await certifyDeals(adapterWith(spyHttp())));
    for (const claim of ["trackingLink", "TRACKING_LINK_USABLE", "deepLink"]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });

  it("preserves the supplier's own field names", async () => {
    const paths = (await certifyDeals(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const supplierName of ["campaign_id", "campaign_name", "start", "end", "created", "status", "type"]) {
      assert.ok(paths.includes(supplierName), supplierName);
    }
    for (const alias of ["campaignId", "startDate", "endDate", "createdAt", "merchantName"]) {
      assert.ok(!paths.includes(alias), alias);
    }
  });
});

describe("the deals outcome vocabulary", () => {
  it("reports OK with a structural field dictionary", async () => {
    const row = (await certifyDeals(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
    const row = (await certifyDeals(adapterWith(spyHttp()))).results[0];
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
    for (const empty of [{ deals: [] }, { data: { deals: [] } }, {}]) {
      const row = (await certifyDeals(adapterWith(spyHttp([empty])))).results[0];
      assert.equal(row.ok, true, JSON.stringify(empty));
      assert.equal(row.statusCategory, "OK_NO_ROWS", JSON.stringify(empty));
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA", JSON.stringify(empty));
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
      assert.deepEqual(row.fieldPaths, []);
    }
  });

  it("infers no joined or account state from zero rows", async () => {
    const serialised = JSON.stringify(await certifyDeals(adapterWith(spyHttp([{ deals: [] }]))));
    for (const invented of [
      "NOT_SUPPORTED",
      "UNSUPPORTED",
      "accountStateBlocker",
      "NO_JOINED_CAMPAIGNS",
      "NEEDS_ACTIVE_PARTNERSHIP",
      "relationshipState",
      "JOINED",
    ]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("preserves an auth rejection safely", async () => {
    const error = new Error("zzupstreamauthmessagezz");
    error.response = { status: 401, data: { message: "zzupstreambodyzz" } };
    const row = (await certifyDeals(adapterWith(spyHttp([error])))).results[0];
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
    const row = (await certifyDeals(adapterWith(spyHttp([error])))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
  });
});

describe("the sample is bounded to one row", () => {
  it("keeps one row even when the page carries several", async () => {
    const spy = spyHttp([{ deals: [DEAL, SECOND_DEAL, CODELESS_DEAL] }]);
    const row = (await certifyDeals(adapterWith(spy))).results[0];
    assert.equal(spy.calls.length, 1);
    assert.equal(row.sampleCount, 1);
  });

  it("never returns the later rows' values", async () => {
    const serialised = JSON.stringify(
      await certifyDeals(adapterWith(spyHttp([{ deals: [DEAL, SECOND_DEAL] }]))),
    );
    for (const secret of ["zzseconddealidzz", "zzsecondtitlezz", "zzsecondcodezz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });
});

describe("nothing identifying can leak", () => {
  it("never returns a code, coupon or deal_code value", async () => {
    const serialised = JSON.stringify(await certifyDeals(adapterWith(spyHttp())));
    for (const secret of ["zzdealcodezz", "zzcouponfieldzz", "zzdealcodefieldzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns campaign identity", async () => {
    const serialised = JSON.stringify(await certifyDeals(adapterWith(spyHttp())));
    for (const secret of ["zzcampaignidzz", "zzcampaignnamezz", "zzdealrowidzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns title or description text", async () => {
    const serialised = JSON.stringify(await certifyDeals(adapterWith(spyHttp())));
    for (const secret of ["zzdealtitlezz", "zzdealdescriptionzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns status, type, dates or URLs", async () => {
    const serialised = JSON.stringify(await certifyDeals(adapterWith(spyHttp())));
    for (const secret of [
      "zzdealstatuszz",
      "zzdealtypezz",
      "zzdealurlzz",
      "https://",
      "2031-03-17",
      "2031-06-21",
      "2031-01-02",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the API key or the raw row", async () => {
    const serialised = JSON.stringify(await certifyDeals(adapterWith(spyHttp())));
    for (const secret of [API_KEY, "X-Api-Key", "deals\":[{"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("returns only the safe result keys", async () => {
    const row = (await certifyDeals(adapterWith(spyHttp()))).results[0];
    for (const forbidden of ["rows", "deals", "body", "raw", "data", "sample", "headers"]) {
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
    assert.equal((await certifyDeals(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierDeals")[1]
      .split("\n  }")[0];
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("adds no conversion, report or relationship path", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierDeals")[1]
      .split("\n  }")[0];
    for (const forbidden of [
      "fetchConversions",
      "fetchReports",
      "fetchPerformance",
      "relationshipState",
      "SupplierCommissionRule",
    ]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
    for (const notYet of ["finance", "reports", "payments"]) {
      assert.ok(!listProbeSourceObjects("trackier").includes(notYet), notYet);
    }
  });

  it("leaves production's fetchDeals following the page token", async () => {
    const spy = spyHttp([
      { deals: [DEAL], nextPageToken: "zztokentwozz" },
      { deals: [SECOND_DEAL] },
    ]);
    const rows = await adapterWith(spy).fetchDeals();
    assert.equal(spy.calls.length, 2);
    assert.equal(spy.calls[0].config.timeout, undefined, "no timeout imposed");
    assert.equal(rows.length, 2);
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchDeals\(\)/);
  });

  it("leaves production's fetchCoupons following the page token too", async () => {
    const spy = spyHttp([
      { coupons: [{ id: "zzcouponzz" }], nextPageToken: "zztokentwozz" },
      { coupons: [{ id: "zzcoupontwozz" }] },
    ]);
    const rows = await adapterWith(spy).fetchCoupons();
    assert.equal(spy.calls[0].path, "/v2/publishers/coupons");
    assert.equal(spy.calls.length, 2);
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
    assert.deepEqual(listSpy.calls[0].config.params, { limit: 1, page: 1 });
    assert.equal(list.endpointKey, "GET /v2/publisher/campaigns (limit=1, page=1)");

    const detailSpy = spyHttp([
      { campaigns: [{ id: "zzdiscoveredzz" }] },
      { data: { id: "zzdiscoveredzz" } },
    ]);
    const detail = (
      await serviceWith(adapterWith(detailSpy)).certify("trackier", {
        sourceObjects: ["campaign_detail"],
      })
    ).results[0];
    assert.equal(detailSpy.calls.length, 2);
    assert.equal(detailSpy.calls[1].path, "/v2/publisher/campaign/zzdiscoveredzz");
    assert.equal(detail.detailRequestCount, 1);
  });
});
