import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";
// The shared Boostiny limiter spaces requests six seconds apart in production. That spacing is
// production's and stays; this file only shortens it for its own fake client.
process.env.BOOSTINY_MIN_INTERVAL_MS = "1";

const { createBoostinyAdapter, BOOSTINY_CAMPAIGNS_PATH } = await import("../src/adapters/boostiny.adapter.js");
const {
  NetworkCertificationService,
  listProbeNetworks,
  listProbeSourceObjects,
  BOOSTINY_CERTIFICATION_CAMPAIGN_PARAMS,
} = await import("../src/modules/ops/networkCertification.service.js");
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");
const { SUPPLIER_CAPABILITY_CATALOG } = await import("../src/adapters/registry.js");
const { SUPPLIER_CAPABILITIES } = await import("../src/adapters/contract.js");

const ADAPTER_SRC = readFileSync("src/adapters/boostiny.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/sync.job.js", "utf8");
const CREDS_SRC = readFileSync("src/modules/integrations/boostinyCredentials.js", "utf8");

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

/**
 * One campaign row carrying every field the phase wants to observe, nested where a real listing
 * nests, each value a distinctive marker.
 */
const CAMPAIGN = {
  id: "zzcampaignidzz",
  name: "zzcampaignnamezz",
  advertiser: { id: "zzadvertiseridzz", name: "zzadvertisernamezz" },
  merchant_name: "zzmerchantnamezz",
  status: "zzstatuszz",
  application_status: "zzapplicationstatuszz",
  category: { id: "zzcategoryidzz", name: "zzcategorynamezz" },
  countries: ["zzcountryonezz", "zzcountrytwozz"],
  landing_url: "https://zzlandingzz.example/offer",
  tracking_url: "https://zztrackingzz.example/click",
  payout: { type: "zzpayouttypezz", amount: 1234.56, currency: "zzcurrencyzz" },
  commission: [{ model: "zzmodelzz", value: 98.7 }],
  campaign_type: "zzcampaigntypezz",
  creatives: [{ id: "zzcreativeidzz", url: "https://zzcreativezz.example/banner.png" }],
  publisher_id: "zzpublisheridzz",
};
const SECOND_CAMPAIGN = { id: "zzsecondidzz", name: "zzsecondnamezz", secondOnly: true };

function spyHttp(pages = [{ data: [CAMPAIGN], pagination: { hasNext: true } }]) {
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
  return createBoostinyAdapter({ apiKey: API_KEY, httpClient: spy.client });
}

function serviceWith(adapter, { credentials = { apiKey: API_KEY } } = {}) {
  return new NetworkCertificationService({
    prisma: {
      rawPayload: {
        findMany: async () => {
          throw new Error("certification must not read RawPayload unless compareRaw is requested");
        },
      },
    },
    adapterFactory: () => adapter,
    boostinyCredentialResolver: async () => credentials,
  });
}

async function certifyCampaigns(adapter) {
  return serviceWith(adapter).certify("boostiny", { sourceObjects: ["campaigns"] });
}

async function rowFor(pages) {
  return (await certifyCampaigns(adapterWith(spyHttp(pages)))).results[0];
}

function chainSource() {
  return codeOf(SERVICE_SRC).split("async certifyBoostinyCampaigns")[1].split("\n  }")[0];
}

const VALUE_MARKERS = [
  "zzcampaignidzz",
  "zzcampaignnamezz",
  "zzadvertiseridzz",
  "zzadvertisernamezz",
  "zzmerchantnamezz",
  "zzstatuszz",
  "zzapplicationstatuszz",
  "zzcategoryidzz",
  "zzcategorynamezz",
  "zzcountryonezz",
  "zzcountrytwozz",
  "zzlandingzz",
  "zztrackingzz",
  "zzpayouttypezz",
  "1234.56",
  "zzcurrencyzz",
  "zzmodelzz",
  "98.7",
  "zzcampaigntypezz",
  "zzcreativeidzz",
  "zzcreativezz",
  "zzpublisheridzz",
  "zzsecondidzz",
  "zzsecondnamezz",
  "https://",
];

describe("Boostiny is registered in the certification framework", () => {
  it("appears as a probe network, with campaigns as its only object this phase", () => {
    assert.ok(listProbeNetworks().includes("boostiny"));
    assert.deepEqual(listProbeSourceObjects("boostiny"), ["campaigns"]);
  });

  it("has an adapter builder registered under its own name", () => {
    assert.match(codeOf(SERVICE_SRC), /boostiny: "buildBoostinyAdapter"/);
  });

  it("keeps every previously registered network intact", () => {
    for (const network of ["optimise", "partnerize", "awin", "cj", "admitad", "rakuten", "trackier"]) {
      assert.ok(listProbeNetworks().includes(network), network);
      assert.ok(listProbeSourceObjects(network).length > 0, network);
    }
  });

  it("uses the catalog's existing name and entity for campaigns", () => {
    const entry = getSourceObject("boostiny", "campaigns");
    assert.ok(entry);
    assert.equal(entry.live, true);
    assert.equal(entry.entityType, "campaign");
  });

  it("refuses an object this phase does not certify", async () => {
    for (const notYet of ["api_reports", "link_reports", "coupons", "settlement", "performance"]) {
      assert.ok(!listProbeSourceObjects("boostiny").includes(notYet), notYet);
      await assert.rejects(
        () => serviceWith(adapterWith(spyHttp())).certify("boostiny", { sourceObjects: [notYet] }),
        /Unknown source objects/,
      );
    }
  });
});

describe("the documented campaigns request contract", () => {
  it("addresses exactly GET /publisher/campaigns", async () => {
    assert.equal(BOOSTINY_CAMPAIGNS_PATH, "/publisher/campaigns");
    const spy = spyHttp();
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/publisher/campaigns");
  });

  it("is a GET, and the endpointKey names the bounds", async () => {
    const row = await rowFor();
    assert.equal(row.network, "boostiny");
    assert.equal(row.sourceObject, "campaigns");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.endpointKey, "GET /publisher/campaigns (limit=1, page=1)");
  });

  it("sends page=1 and limit=1, and nothing else", async () => {
    assert.deepEqual(BOOSTINY_CERTIFICATION_CAMPAIGN_PARAMS, { page: 1, limit: 1 });
    assert.ok(Object.isFrozen(BOOSTINY_CERTIFICATION_CAMPAIGN_PARAMS));
    const spy = spyHttp();
    await certifyCampaigns(adapterWith(spy));
    assert.deepEqual(spy.calls[0].config.params, { page: 1, limit: 1 });
  });

  it("page and limit are evidenced: production's pager sends both on every call", async () => {
    const spy = spyHttp([{ data: [CAMPAIGN] }]);
    await adapterWith(spy).fetchCampaigns();
    assert.deepEqual(spy.calls[0].config.params, { page: 1, limit: 100 });
  });

  it("reuses production's Authorization auth through the shared client, with no second scheme", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /createHttpClient\(\{ baseURL, apiKey \}\)/);
    assert.ok(!code.includes("Bearer"));
    assert.ok(!code.includes("X-Api-Key"));
    assert.ok(!code.includes("headers:"), "no header of its own");
    const builder = codeOf(SERVICE_SRC).split("async buildBoostinyAdapter")[1].split("\n  }")[0];
    assert.match(builder, /this\.adapterFactory \?\? createBoostinyAdapter/);
    assert.match(builder, /apiKey: credentials\.apiKey/);
    assert.ok(!builder.includes("endpoints"), "no endpoint override: the documented path is certified");
  });

  it("resolves credentials in the sync job's own order, with the sync job's own env names", () => {
    const creds = codeOf(CREDS_SRC);
    assert.ok(creds.indexOf('getMarketplaceApiKey("boostiny"') < creds.indexOf('getOAuthAccessToken("boostiny"'));
    assert.ok(creds.indexOf('getOAuthAccessToken("boostiny"') < creds.indexOf("process.env.BOOSTINY_API_KEY"));
    assert.match(creds, /process\.env\.BOOSTINY_BASE_URL/);
    const sync = codeOf(SYNC_SRC);
    assert.match(sync, /getMarketplaceApiKey\("boostiny", accountLabel\)\)\s*\|\|\s*\(await getOAuthAccessToken\("boostiny", accountLabel\)\)\s*\|\|\s*process\.env\.BOOSTINY_API_KEY/);
  });

  it("builds through production's factory with the resolved key and base URL, and nothing else", async () => {
    for (const [credentials, expected] of [
      [{ apiKey: API_KEY }, { apiKey: API_KEY }],
      [{ apiKey: API_KEY, baseURL: "https://zzbasezz.example" }, { apiKey: API_KEY, baseURL: "https://zzbasezz.example" }],
      [{ apiKey: API_KEY, baseURL: undefined }, { apiKey: API_KEY }],
    ]) {
      const received = [];
      const spy = spyHttp();
      const service = new NetworkCertificationService({
        prisma: {},
        adapterFactory: (options) => {
          received.push(options);
          return adapterWith(spy);
        },
        boostinyCredentialResolver: async () => credentials,
      });
      await service.certify("boostiny", { sourceObjects: ["campaigns"] });
      assert.deepEqual(received, [expected]);
    }
  });

  it("refuses to build without a credential, saying nothing about it", async () => {
    await assert.rejects(
      () => serviceWith(adapterWith(spyHttp()), { credentials: null }).certify("boostiny", { sourceObjects: ["campaigns"] }),
      (error) => Number(error?.statusCode ?? error?.status) === 424 && /not configured/.test(error.message) && !error.message.includes(API_KEY),
    );
  });

  it("carries a bounded timeout", async () => {
    const spy = spyHttp();
    await certifyCampaigns(adapterWith(spy));
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
  });
});

describe("exactly one request: no retry, no page 2, no pagination loop", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request page 2 on hasNext", async () => {
    const spy = spyHttp([{ data: [CAMPAIGN], pagination: { hasNext: true } }, { data: [SECOND_CAMPAIGN] }, { data: [] }]);
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request page 2 on has_next", async () => {
    const spy = spyHttp([{ data: [CAMPAIGN], pagination: { has_next: true } }, { data: [SECOND_CAMPAIGN] }, { data: [] }]);
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request page 2 on totalPages, nested or top-level", async () => {
    for (const first of [{ data: [CAMPAIGN], pagination: { totalPages: 50 } }, { data: [CAMPAIGN], totalPages: 50 }]) {
      const spy = spyHttp([first, { data: [SECOND_CAMPAIGN] }, { data: [] }]);
      await certifyCampaigns(adapterWith(spy));
      assert.equal(spy.calls.length, 1, JSON.stringify(first));
    }
  });

  it("does not request page 2 on the full-page heuristic", async () => {
    // No pagination hint at all: one row at limit=1 IS a full page, so production would go on.
    const spy = spyHttp([{ data: [CAMPAIGN] }, { data: [SECOND_CAMPAIGN] }, { data: [] }]);
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("proves the unbounded pager really would have walked on, on each hint", async () => {
    for (const first of [
      { data: [CAMPAIGN], pagination: { hasNext: true } },
      { data: [CAMPAIGN], pagination: { has_next: true } },
      { data: [CAMPAIGN], pagination: { totalPages: 2 } },
      { data: [CAMPAIGN], totalPages: 2 },
      { data: [CAMPAIGN] },
    ]) {
      const spy = spyHttp([first, { data: [SECOND_CAMPAIGN] }, { data: [] }]);
      await adapterWith(spy).fetchCampaigns({ limit: 1 });
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
      const spy = spyHttp([failure, { data: [CAMPAIGN] }]);
      const row = (await certifyCampaigns(adapterWith(spy))).results[0];
      assert.equal(spy.calls.length, 1, failure.message);
      assert.equal(row.ok, false);
    }
  });

  it("proves production really would have retried", async () => {
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp([error, { data: [CAMPAIGN] }]);
    const rows = await adapterWith(spy).fetchCampaigns();
    assert.equal(spy.calls.length, 2);
    assert.equal(rows.length, 1);
  });

  it("pins the bounds in the chain, and leaves production's defaults alone", () => {
    const chain = chainSource();
    assert.match(chain, /singlePage: true/);
    assert.match(chain, /retries: 1/);
    assert.match(chain, /timeoutMs/);
    assert.match(chain, /BOOSTINY_CERTIFICATION_CAMPAIGN_PARAMS/);
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /\{ retries: 2, delayMs: 2000, \.\.\.\(retries \? \{ retries \} : \{\}\) \}/);
    assert.match(code, /\{ singlePage = false, retries, timeoutMs \} = \{\}/);
  });

  it("breaks out of the pager before hasMorePages, in source order", () => {
    const pager = codeOf(ADAPTER_SRC).split("async function fetchPaginated")[1].split("\n}")[0];
    const breakAt = pager.indexOf("if (singlePage) break;");
    assert.ok(breakAt >= 0);
    assert.ok(breakAt < pager.indexOf("hasMorePages("), "before the continuation check");
    assert.ok(breakAt < pager.indexOf("page += 1"), "before the increment");
    assert.ok(breakAt > pager.indexOf("all.push("), "after the page's rows are kept");
  });

  it("takes its slot on the shared limiter and leaves the 429 reset in place", () => {
    const pager = codeOf(ADAPTER_SRC).split("async function fetchPaginated")[1].split("\n}")[0];
    assert.match(pager, /await boostinyRateLimiter\.acquireSlot\(\);/);
    assert.match(pager, /boostinyRateLimiter\.resetAfterRateLimit\(waitMs\)/);
    assert.match(codeOf(ADAPTER_SRC), /process\.env\.BOOSTINY_MIN_INTERVAL_MS \|\| 6000/);
    const chain = chainSource();
    for (const bypass of ["RateLimiter", "acquireSlot", "resetAfterRateLimit", "MIN_INTERVAL"]) {
      assert.ok(!chain.includes(bypass), bypass);
    }
  });
});

describe("the certification reuses production's fetcher, and adds no second one", () => {
  it("calls adapter.fetchCampaigns and nothing else on the adapter", () => {
    const chain = chainSource();
    assert.match(chain, /adapter\.fetchCampaigns\(/);
    for (const other of ["fetchPerformance", "fetchLinkPerformance", "fetchCoupons", "fetchAll", "httpClient", ".get(", "fetchPaginated"]) {
      assert.ok(!chain.includes(other), other);
    }
  });

  it("defines one pager and one campaigns path in the adapter", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/async function fetchPaginated/g) ?? []).length, 1);
    assert.equal((code.match(/"\/publisher\/campaigns"/g) ?? []).length, 1);
    assert.equal((code.match(/async fetchCampaigns\(/g) ?? []).length, 1);
  });

  it("creates no parallel client", () => {
    const code = codeOf(SERVICE_SRC);
    assert.equal((code.match(/createBoostinyAdapter\(/g) ?? []).length, 0);
    assert.ok(!code.includes("api.boostiny.com"));
    assert.ok(!code.includes("axios.create"));
  });

  it("extracts the rows envelope the way production does", async () => {
    for (const body of [{ data: [CAMPAIGN] }, { payload: { data: [CAMPAIGN] } }, { results: [CAMPAIGN] }, { items: [CAMPAIGN] }, [CAMPAIGN]]) {
      const row = await rowFor([body]);
      assert.equal(row.sampleCount, 1, JSON.stringify(Object.keys(body)));
    }
  });
});

describe("the sample is bounded to one row, locally too", () => {
  it("keeps one row even when the page carries several", async () => {
    const row = await rowFor([{ data: [CAMPAIGN, SECOND_CAMPAIGN, CAMPAIGN] }]);
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldPaths.every((f) => f.sampleCount === 1));
    assert.ok(!row.fieldPaths.some((f) => f.path === "secondOnly"));
  });

  it("slices to one in the chain", () => {
    assert.match(chainSource(), /\.slice\(0, 1\)/);
  });
});

describe("campaign fields are preserved structurally, nested included", () => {
  async function paths() {
    return (await rowFor()).fieldPaths.map((f) => f.path);
  }

  it("reports the supplier's own field names, including nested identity, payout and creatives", async () => {
    const seen = await paths();
    for (const supplierName of [
      "id",
      "name",
      "advertiser",
      "advertiser.id",
      "advertiser.name",
      "merchant_name",
      "status",
      "application_status",
      "category",
      "category.id",
      "category.name",
      "countries",
      "countries[]",
      "landing_url",
      "tracking_url",
      "payout",
      "payout.type",
      "payout.amount",
      "payout.currency",
      "commission",
      "commission[]",
      "commission[].model",
      "commission[].value",
      "campaign_type",
      "creatives",
      "creatives[]",
      "creatives[].id",
      "creatives[].url",
    ]) {
      assert.ok(seen.includes(supplierName), supplierName);
    }
  });

  it("renames none of them into MBO canon", async () => {
    const seen = await paths();
    for (const alias of [
      "externalId",
      "campaignId",
      "campaignName",
      "advertiserId",
      "merchantId",
      "merchantName",
      "relationshipState",
      "joined",
      "approved",
      "commissionRate",
      "payableCommission",
      "landingUrl",
      "trackingUrl",
      "currencyCode",
    ]) {
      assert.ok(!seen.includes(alias), alias);
    }
  });

  it("keeps status and application_status as two fields, and campaign id and advertiser id as two", async () => {
    const seen = await paths();
    assert.ok(seen.includes("status") && seen.includes("application_status"));
    assert.ok(seen.includes("id") && seen.includes("advertiser.id"));
  });

  it("describes each path structurally, with nested types observed", async () => {
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
    assert.equal(byPath["advertiser"].observedType, "OBJECT");
    assert.equal(byPath["countries"].observedType, "ARRAY");
    assert.equal(byPath["countries[]"].observedType, "STRING");
    assert.equal(byPath["payout.amount"].observedType, "NUMBER");
    // URL-shaped strings are categorised as URL: the category, never the address, is reported.
    assert.equal(byPath["creatives[].url"].observedType, "URL");
    assert.equal(byPath["tracking_url"].observedType, "URL");
  });

  it("writes no relationship, approval or commission meaning into the chain", () => {
    const chain = chainSource();
    for (const forbidden of [
      "joined",
      "approved",
      "relationshipState",
      "advertiser",
      "payable",
      "commission",
      "payout",
      "canonical",
      "normalise",
      "normalize",
      "mapBoostiny",
      "SupplierCommissionRule",
      "ClientCampaignAssignment",
    ]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });

  it("does not certify a listing as a relationship or a commission truth", async () => {
    const serialised = JSON.stringify(await rowFor());
    for (const claim of ["JOINED", "APPROVED", "NEEDS_ACTIVE_PARTNERSHIP", "PAYABLE", "COMMISSION_TRUTH", "relationshipState"]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });
});

describe("the campaigns outcome vocabulary", () => {
  it("reports OK with a structural field dictionary", async () => {
    const row = await rowFor();
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.schema, "KNOWN_FROM_LIVE_SAMPLE");
    assert.equal(row.sampleCount, 1);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.ok(row.fieldCount > 0);
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
    for (const invented of ["NOT_SUPPORTED", "UNSUPPORTED", "accountStateBlocker", "NO_JOINED_CAMPAIGNS", "NEEDS_ACTIVE_PARTNERSHIP", "relationshipState", "JOINED"]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("preserves an auth rejection safely", async () => {
    for (const status of [401, 403]) {
      const error = new Error("zzupstreamauthmessagezz");
      error.response = { status, data: { message: `denied for ${API_KEY}` } };
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
      const row = (await certifyCampaigns(adapterWith(spy))).results[0];
      assert.equal(row.statusCategory, category);
      assert.equal(spy.calls.length, 1);
    }
  });
});

describe("nothing identifying can leak", () => {
  it("never returns a campaign, advertiser, merchant, URL, payout, currency, creative or account value", async () => {
    const serialised = JSON.stringify(await rowFor([{ data: [CAMPAIGN, SECOND_CAMPAIGN] }]));
    for (const secret of VALUE_MARKERS) assert.ok(!serialised.includes(secret), secret);
  });

  it("never returns the credential or a raw response, on success or on failure", async () => {
    const ok = JSON.stringify(await rowFor());
    const error = new Error(`zzfailurezz ${API_KEY}`);
    error.response = { status: 500, data: { data: [CAMPAIGN] }, headers: { "x-account": "zzaccountheaderzz" } };
    const failed = JSON.stringify(await rowFor([error]));
    for (const serialised of [ok, failed]) {
      for (const secret of [API_KEY, "Authorization", 'data":[{', "zzcampaignidzz", "zzaccountheaderzz", "https://"]) {
        assert.ok(!serialised.includes(secret), secret);
      }
    }
  });

  it("returns only the safe result keys", async () => {
    const row = await rowFor();
    for (const forbidden of ["rows", "campaigns", "body", "raw", "data", "sample", "headers", "params", "pages"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
    for (const expected of ["network", "sourceObject", "endpointKey", "httpMethod", "sampleCount", "fieldCount", "fieldPaths", "statusCategory", "schema"]) {
      assert.ok(Object.hasOwn(row, expected), expected);
    }
    assert.ok(!Object.hasOwn(row, "windowPreset"), "not a dated object");
  });
});

describe("read-only, and production Boostiny behaviour unchanged", () => {
  it("performs no database read or write", async () => {
    assert.equal((await rowFor()).statusCategory, "OK");
  });

  it("writes nothing in the chain", () => {
    const chain = chainSource();
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany", "rawPayload", "SupplierCampaign"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("leaves production's fetchCampaigns paging, retrying and counting as they were", async () => {
    const spy = spyHttp([{ data: [CAMPAIGN], pagination: { hasNext: true } }, { data: [SECOND_CAMPAIGN], pagination: { hasNext: false } }]);
    const stats = { requestCount: 0 };
    const rows = await adapterWith(spy).fetchCampaigns({}, stats);
    assert.equal(rows.length, 2);
    assert.equal(spy.calls.length, 2);
    assert.equal(stats.requestCount, 2);
    assert.deepEqual(spy.calls[0].config.params, { page: 1, limit: 100 });
    assert.deepEqual(spy.calls[1].config.params, { page: 2, limit: 100 });
    assert.equal(spy.calls[0].config.timeout, undefined, "no timeout imposed");
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchCampaigns\(|adapter\.fetchAll\(/);
    for (const seam of ["singlePage", "retries: 1"]) assert.ok(!codeOf(SYNC_SRC).includes(seam), seam);
  });

  it("leaves production's fetchAll sequence unchanged", async () => {
    const spy = spyHttp([{ data: [CAMPAIGN] }]);
    const out = await adapterWith(spy).fetchAll({}, {});
    assert.deepEqual(
      spy.calls.slice(0, 4).map((c) => c.path),
      ["/publisher/campaigns", "/publisher/performance", "/publisher/link-performance", "/publisher/coupons"],
    );
    assert.ok(out.apiRequestCount >= 4);
    for (const call of spy.calls) assert.equal(call.config.timeout, undefined);
    const fetchAll = codeOf(ADAPTER_SRC).split("async fetchAll(")[1];
    for (const seam of ["singlePage", "retries", "timeoutMs"]) assert.ok(!fetchAll.includes(seam), seam);
  });

  it("leaves performance, link-performance and coupons paging unchanged", async () => {
    const adapter = adapterWith(spyHttp([{ data: [CAMPAIGN], pagination: { hasNext: true } }, { data: [CAMPAIGN] }]));
    const performance = await adapter.fetchPerformance({});
    assert.equal(performance.rows.length, 2);
    assert.equal(performance.pages.length, 2);
    const linkSpy = spyHttp([{ data: [CAMPAIGN], pagination: { hasNext: true } }, { data: [CAMPAIGN] }]);
    assert.equal((await adapterWith(linkSpy).fetchLinkPerformance({})).length, 2);
    assert.equal(linkSpy.calls[0].path, "/publisher/link-performance");
    const couponSpy = spyHttp([{ data: [CAMPAIGN], pagination: { hasNext: true } }, { data: [CAMPAIGN] }]);
    assert.equal((await adapterWith(couponSpy).fetchCoupons({})).length, 2);
    assert.equal(couponSpy.calls[0].path, "/publisher/coupons");
    const code = codeOf(ADAPTER_SRC);
    for (const untouched of ["fetchPerformance(params = {}, stats = null)", "fetchLinkPerformance(params = {}, stats = null)", "fetchCoupons(params = {}, stats = null)"]) {
      assert.ok(code.includes(untouched), untouched);
    }
  });

  it("keeps PAYMENTS absent: manual settlement only, as already established", () => {
    assert.ok(!SUPPLIER_CAPABILITY_CATALOG.BOOSTINY.capabilities.includes(SUPPLIER_CAPABILITIES.PAYMENTS));
    const adapter = adapterWith(spyHttp());
    assert.ok(!adapter.getCapabilities().capabilities.includes("PAYMENTS"));
    assert.equal(typeof adapter.fetchPayments, "undefined");
    assert.ok(!codeOf(ADAPTER_SRC).includes("fetchPayments"));
    assert.ok(!listProbeSourceObjects("boostiny").includes("settlement"));
    assert.equal(getSourceObject("boostiny", "settlement").live, false);
  });

  it("leaves the Trackier probes unchanged", async () => {
    const spy = spyHttp([{ profile: { id: "zzprofileidzz" } }]);
    const { createTrackierAdapter } = await import("../src/adapters/trackier.adapter.js");
    const trackier = new NetworkCertificationService({
      prisma: {},
      adapterFactory: () => createTrackierAdapter({ apiKey: "zztrackierzz", httpClient: spy.client }),
      trackierCredentialResolver: async () => ({ apiKey: "zztrackierzz" }),
    });
    const out = await trackier.certify("trackier", { sourceObjects: ["profile"] });
    assert.equal(out.results[0].statusCategory, "OK");
    assert.equal(spy.calls[0].path, "/v2/publishers/profile");
  });
});

// Last on purpose: production's shared limiter honours Retry-After after a 429, and that behaviour
// is kept (a bounded probe must not defeat the supplier's back-off). Anything after this would wait.
describe("a rate limit is reported once, safely, and not retried", () => {
  it("classifies 429 as RATE_LIMITED after exactly one request, keeping the safe supplier message", async () => {
    const error = new Error("zzratelimitzz");
    error.response = {
      status: 429,
      // The key embedded as prose, where no pattern could recognise it: only the literal value
      // recorded at build time can scrub it.
      data: { message: `Too Many Attempts for ${API_KEY} today. Retry after 10 minutes.` },
      headers: { "retry-after": "1" },
    };
    const spy = spyHttp([error, { data: [CAMPAIGN] }]);
    const row = (await certifyCampaigns(adapterWith(spy))).results[0];
    assert.equal(spy.calls.length, 1, "never retried");
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "RATE_LIMITED");
    assert.equal(row.supplierStatusCode, 429);
    assert.match(row.supplierMessage, /Too Many Attempts/);
    assert.ok(!row.supplierMessage.includes(API_KEY), "the credential is scrubbed from the message");
    assert.ok(!JSON.stringify(row).includes(API_KEY));
    assert.match(row.supplierMessage, /Retry after 10 minutes/, "the safe part of the message survives");
  });

  it("scrubs a prose-embedded credential on a 401 too", async () => {
    const error = new Error("zzauthzz");
    error.response = { status: 401, data: { message: `Invalid credentials for ${API_KEY} on this account` } };
    const row = await rowFor([error]);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.ok(!JSON.stringify(row).includes(API_KEY));
  });

  it("records the literal key for redaction at build time, and hands it to every failure", () => {
    const builder = codeOf(SERVICE_SRC).split("async buildBoostinyAdapter")[1].split("\n  }")[0];
    assert.match(builder, /recordRedactionValues\(/);
    assert.match(builder, /\[credentials\.apiKey\]/);
    assert.match(chainSource(), /certificationFailure\(base, error, \{\}, redactionValuesFor\(adapter\)\)/);
  });
});
