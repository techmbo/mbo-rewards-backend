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

const {
  createBoostinyAdapter,
  BOOSTINY_LINK_PERFORMANCE_PATH,
  BOOSTINY_PERFORMANCE_PATH,
  BOOSTINY_CAMPAIGNS_PATH,
  BOOSTINY_COUPONS_PATH,
} = await import("../src/adapters/boostiny.adapter.js");
const {
  NetworkCertificationService,
  listProbeSourceObjects,
  BOOSTINY_CERTIFICATION_LINK_PERFORMANCE_PARAMS,
  WINDOW_PRESETS,
  DEFAULT_WINDOW_PRESET,
} = await import("../src/modules/ops/networkCertification.service.js");
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

/** One link-performance row carrying every field the phase wants to observe, each a marker. */
const ROW = {
  campaign_id: "zzcampaignidzz",
  campaign_name: "zzcampaignnamezz",
  link_id: "zzlinkidzz",
  tracking_url: "https://zztrackingzz.example/click?l=1",
  deeplink: "https://zzdeeplinkzz.example/go",
  destination_url: "https://zzdestinationzz.example/product",
  clicks: 4321,
  conversions: 87,
  orders: 91,
  payout: 1234.56,
  commission: 987.65,
  revenue: 9876.54,
  sales: 8765.43,
  date: "2031-05-06",
  period_from: "2031-05-01",
  period_to: "2031-05-07",
  sub_id: "zzsubidzz",
  sub_id2: "zzsubidtwozz",
  status: "zzstatuszz",
  country: "zzcountryzz",
  device: "zzdevicezz",
  source: "zzsourcezz",
  report_type: "zzreporttypezz",
  publisher_id: "zzpublisheridzz",
};
const SECOND_ROW = { link_id: "zzsecondlinkzz", clicks: 8765, secondOnly: true };

function spyHttp(pages = [{ data: [ROW], pagination: { hasNext: true } }]) {
  const calls = [];
  const sequence = Array.isArray(pages) ? pages : [pages];
  let index = 0;
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, config });
        if (path !== BOOSTINY_LINK_PERFORMANCE_PATH) return { data: { data: [{ id: "zzotherresourcezz" }] } };
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

async function certifyLinks(adapter, options = {}) {
  return serviceWith(adapter).certify("boostiny", { sourceObjects: ["link_reports"], ...options });
}

async function rowFor(pages, options = {}) {
  return (await certifyLinks(adapterWith(spyHttp(pages)), options)).results[0];
}

const DAY_MS = 86400000;
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function chainSource() {
  return codeOf(SERVICE_SRC).split("async certifyBoostinyLinkPerformance")[1].split("\n  }")[0];
}

const VALUE_MARKERS = [
  "zzcampaignidzz",
  "zzcampaignnamezz",
  "zzlinkidzz",
  "zzsecondlinkzz",
  "zztrackingzz",
  "zzdeeplinkzz",
  "zzdestinationzz",
  "https://",
  "4321",
  "8765",
  "87",
  "91",
  "1234.56",
  "987.65",
  "9876.54",
  "8765.43",
  "2031-05",
  "zzsubidzz",
  "zzsubidtwozz",
  "zzstatuszz",
  "zzcountryzz",
  "zzdevicezz",
  "zzsourcezz",
  "zzreporttypezz",
  "zzpublisheridzz",
  "zzotherresourcezz",
];

describe("the documented link-performance request contract", () => {
  it("addresses exactly GET /publisher/link-performance", async () => {
    assert.equal(BOOSTINY_LINK_PERFORMANCE_PATH, "/publisher/link-performance");
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/publisher/link-performance");
  });

  it("is a GET under the catalog's existing name link_reports, with no competing name", async () => {
    const row = await rowFor();
    assert.equal(row.network, "boostiny");
    assert.equal(row.sourceObject, "link_reports");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.endpointKey, "GET /publisher/link-performance (from/to window, limit=1, page=1)");
    const entry = getSourceObject("boostiny", "link_reports");
    assert.equal(entry.live, true);
    assert.equal(entry.entityType, "link");
    assert.ok(listProbeSourceObjects("boostiny").includes("link_reports"));
    for (const competing of ["link_performance", "links", "tracking_links", "tracking"]) {
      assert.ok(!listProbeSourceObjects("boostiny").includes(competing), competing);
    }
    assert.match(codeOf(SYNC_SRC), /sourceObject: "link_reports",\s*endpoint: "GET link performance"/);
  });

  it("sends from and to, under the names production sends, from the 7d preset", async () => {
    assert.equal(DEFAULT_WINDOW_PRESET, "7d");
    assert.equal(WINDOW_PRESETS["7d"], 7);
    const spy = spyHttp();
    const row = (await certifyLinks(adapterWith(spy))).results[0];
    const { params } = spy.calls[0].config;
    assert.equal(params.from, isoDaysAgo(7));
    assert.equal(params.to, isoDaysAgo(0));
    assert.equal(daysBetween(params.from, params.to), 7);
    assert.equal(row.windowPreset, "7d");
    for (const alias of ["startDate", "endDate", "start", "end", "dateFrom", "dateTo", "start_date", "end_date"]) {
      assert.ok(!Object.hasOwn(params, alias), alias);
    }
  });

  it("the date names are evidenced: production's sync job sends { from, to } to this endpoint", async () => {
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchLinkPerformance\(\{ from, to \}, stats\)/);
    const spy = spyHttp([{ data: [ROW] }]);
    await adapterWith(spy).fetchLinkPerformance({ from: isoDaysAgo(7), to: isoDaysAgo(0) });
    assert.deepEqual(spy.calls[0].config.params, { page: 1, limit: 100, from: isoDaysAgo(7), to: isoDaysAgo(0) });
  });

  it("sends page=1 and limit=1, and exactly these four parameters", async () => {
    assert.deepEqual(BOOSTINY_CERTIFICATION_LINK_PERFORMANCE_PARAMS, { page: 1, limit: 1 });
    assert.ok(Object.isFrozen(BOOSTINY_CERTIFICATION_LINK_PERFORMANCE_PARAMS));
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy));
    const { params } = spy.calls[0].config;
    assert.equal(params.page, 1);
    assert.equal(params.limit, 1);
    assert.deepEqual(Object.keys(params).sort(), ["from", "limit", "page", "to"]);
    for (const scope of ["campaign_id", "link_id", "sub_id", "status", "group_by"]) {
      assert.ok(!Object.hasOwn(params, scope), scope);
    }
  });

  it("uses a named preset only: 30d is a wider window, an unknown token falls back to 7d", async () => {
    const thirty = spyHttp();
    const row30 = (await certifyLinks(adapterWith(thirty), { windowPreset: "30d" })).results[0];
    assert.equal(row30.windowPreset, "30d");
    assert.equal(daysBetween(thirty.calls[0].config.params.from, thirty.calls[0].config.params.to), 30);
    const unknown = spyHttp();
    const rowX = (await certifyLinks(adapterWith(unknown), { windowPreset: "999d" })).results[0];
    assert.equal(rowX.windowPreset, "7d");
    assert.equal(daysBetween(unknown.calls[0].config.params.from, unknown.calls[0].config.params.to), 7);
  });

  it("ignores any dates a caller tries to pass", async () => {
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy), { from: "2020-01-01", to: "2020-01-02", window: { from: "2020-01-01", to: "2020-01-02" } });
    assert.ok(!JSON.stringify(spy.calls).includes("2020-01-0"));
    assert.equal(spy.calls[0].config.params.from, isoDaysAgo(7));
  });

  it("makes no request at all without a window", async () => {
    const spy = spyHttp();
    const adapter = adapterWith(spy);
    for (const window of [null, {}, { from: isoDaysAgo(7) }, { to: isoDaysAgo(0) }]) {
      const row = await serviceWith(adapter).certifyBoostinyLinkPerformance({
        adapter,
        key: "boostiny",
        probe: { method: "GET", endpointKey: "x" },
        budgetLeft: () => 5000,
        sourceObject: "link_reports",
        window,
      });
      assert.equal(row.statusCategory, "SKIPPED_NO_WINDOW", JSON.stringify(window));
      assert.equal(row.ok, false);
    }
    assert.equal(spy.calls.length, 0);
  });

  it("is declared dated, and reports the preset but never the dates", async () => {
    assert.match(codeOf(SERVICE_SRC), /chain: "boostinyLinkPerformance",\s*dated: true,/);
    const row = await rowFor();
    assert.equal(row.windowPreset, "7d");
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(isoDaysAgo(7)));
    assert.ok(!serialised.includes(isoDaysAgo(0)));
  });

  it("carries a bounded timeout, and reuses the shared client, auth and limiter", async () => {
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy));
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/createHttpClient\(/g) ?? []).length, 1);
    assert.equal((code.match(/createRateLimiter\(/g) ?? []).length, 1);
    const chain = chainSource();
    for (const own of ["httpClient", "createHttpClient", "RateLimiter", "acquireSlot", "Authorization", "apiKey"]) {
      assert.ok(!chain.includes(own), own);
    }
  });
});

describe("exactly one request: no retry, no page 2, no fetchAll, no fallback", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request page 2 on hasNext, has_next, totalPages or the full-page heuristic", async () => {
    for (const first of [
      { data: [ROW], pagination: { hasNext: true } },
      { data: [ROW], pagination: { has_next: true } },
      { data: [ROW], pagination: { totalPages: 50 } },
      { data: [ROW], totalPages: 50 },
      { data: [ROW] },
    ]) {
      const spy = spyHttp([first, { data: [SECOND_ROW] }, { data: [] }]);
      await certifyLinks(adapterWith(spy));
      assert.equal(spy.calls.length, 1, JSON.stringify(first));
    }
  });

  it("proves the unbounded pager really would have walked on, on each hint", async () => {
    for (const first of [
      { data: [ROW], pagination: { hasNext: true } },
      { data: [ROW], pagination: { has_next: true } },
      { data: [ROW], pagination: { totalPages: 2 } },
      { data: [ROW], totalPages: 2 },
      { data: [ROW] },
    ]) {
      const spy = spyHttp([first, { data: [SECOND_ROW] }, { data: [] }]);
      await adapterWith(spy).fetchLinkPerformance({ from: isoDaysAgo(7), to: isoDaysAgo(0), limit: 1 });
      assert.ok(spy.calls.length > 1, JSON.stringify(first));
      assert.equal(spy.calls[1].config.params.page, 2);
    }
  });

  it("reads no other resource: never campaigns, performance or coupons alongside", async () => {
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy));
    for (const other of [BOOSTINY_CAMPAIGNS_PATH, BOOSTINY_PERFORMANCE_PATH, BOOSTINY_COUPONS_PATH]) {
      assert.ok(!spy.calls.some((c) => c.path === other), other);
    }
  });

  it("proves fetchAll really would have read every resource", async () => {
    const spy = spyHttp([{ data: [ROW] }]);
    await adapterWith(spy).fetchAll({}, {});
    assert.ok(spy.calls.length >= 4);
    assert.ok(spy.calls.some((c) => c.path === BOOSTINY_CAMPAIGNS_PATH));
    assert.ok(spy.calls.some((c) => c.path === BOOSTINY_PERFORMANCE_PATH));
  });

  it("never calls fetchAll, fetchPerformanceReport or the per-campaign reader", () => {
    const chain = chainSource();
    assert.match(chain, /adapter\.fetchLinkPerformance\(/);
    for (const forbidden of ["fetchAll", "fetchPerformanceReport", "fetchPerformanceByCampaigns", "fetchPerformance(", "fetchCampaigns", "fetchCoupons", "usePerCampaign", "campaigns", "httpClient"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
    assert.equal((codeOf(SERVICE_SRC).match(/adapter\.fetchAll\(/g) ?? []).length, 0, "nowhere in the service");
  });

  it("does not retry a failed request, including 5xx", async () => {
    for (const failure of [
      new Error("zzsupplierfailurezz"),
      Object.assign(new Error("zz500zz"), { response: { status: 500, data: {} } }),
      Object.assign(new Error("zz503zz"), { response: { status: 503, data: {} } }),
    ]) {
      const spy = spyHttp([failure, { data: [ROW] }]);
      const row = (await certifyLinks(adapterWith(spy))).results[0];
      assert.equal(spy.calls.length, 1, failure.message);
      assert.equal(row.ok, false);
      assert.equal(row.windowPreset, "7d");
    }
  });

  it("proves production really would have retried", async () => {
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp([error, { data: [ROW] }]);
    const rows = await adapterWith(spy).fetchLinkPerformance({ from: isoDaysAgo(7), to: isoDaysAgo(0) });
    assert.equal(spy.calls.length, 2);
    assert.equal(rows.length, 1);
  });

  it("pins the same bounds through the same seam, and leaves production's defaults alone", () => {
    const chain = chainSource();
    assert.match(chain, /\{ singlePage: true, retries: 1, timeoutMs \}/);
    assert.match(chain, /BOOSTINY_CERTIFICATION_LINK_PERFORMANCE_PARAMS/);
    assert.match(chain, /from: window\.from, to: window\.to/);
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/async function fetchPaginated/g) ?? []).length, 1, "one pager");
    assert.equal((code.match(/\{ singlePage = false, retries, timeoutMs \} = \{\}/g) ?? []).length, 1, "one seam");
    assert.match(code, /fetchPaginated\(httpClient, resolvedEndpoints\.linkPerformance, params, stats, options\)/);
    assert.match(code, /\{ retries: 2, delayMs: 2000, \.\.\.\(retries \? \{ retries \} : \{\}\) \}/);
  });
});

describe("the certification reuses production's fetcher, and adds no second one", () => {
  it("defines one fetchLinkPerformance and one link-performance path in the adapter", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/async fetchLinkPerformance\(/g) ?? []).length, 1);
    assert.equal((code.match(/"\/publisher\/link-performance"/g) ?? []).length, 1);
  });

  it("creates no parallel client", () => {
    const code = codeOf(SERVICE_SRC);
    assert.equal((code.match(/createBoostinyAdapter\(/g) ?? []).length, 0);
    assert.ok(!code.includes("api.boostiny.com"));
  });

  it("extracts the rows envelope the way production does", async () => {
    for (const body of [{ data: [ROW] }, { payload: { data: [ROW] } }, { payload: { rows: [ROW] } }, { payload: { report: [ROW] } }, { results: [ROW] }, [ROW]]) {
      const row = await rowFor([body]);
      assert.equal(row.sampleCount, 1, JSON.stringify(Object.keys(body)));
    }
  });
});

describe("the sample is bounded to one row, locally too", () => {
  it("keeps one row even when the page carries several", async () => {
    const row = await rowFor([{ data: [ROW, SECOND_ROW, ROW] }]);
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldPaths.every((f) => f.sampleCount === 1));
    assert.ok(!row.fieldPaths.some((f) => f.path === "secondOnly"));
  });

  it("slices to one in the chain", () => {
    assert.match(chainSource(), /\.slice\(0, 1\)/);
  });
});

describe("a link-performance row is a report row: fields preserved, no link asset manufactured", () => {
  async function paths(pages) {
    return (await rowFor(pages)).fieldPaths.map((f) => f.path);
  }

  it("reports the supplier's own field names", async () => {
    const seen = await paths();
    for (const supplierName of [
      "campaign_id",
      "campaign_name",
      "link_id",
      "tracking_url",
      "deeplink",
      "destination_url",
      "clicks",
      "conversions",
      "orders",
      "payout",
      "commission",
      "revenue",
      "sales",
      "date",
      "period_from",
      "period_to",
      "sub_id",
      "sub_id2",
      "status",
      "country",
      "device",
      "source",
      "report_type",
    ]) {
      assert.ok(seen.includes(supplierName), supplierName);
    }
  });

  it("renames none of them into MBO canon", async () => {
    const seen = await paths();
    for (const alias of ["campaignId", "campaignName", "linkId", "trackingUrl", "trackingLink", "deepLink", "landingUrl", "destinationUrl", "externalId", "conversionId", "commissionAmount", "payableCommission", "saleAmount", "occurredAt", "subId", "reportType", "slug", "token"]) {
      assert.ok(!seen.includes(alias), alias);
    }
  });

  it("keeps URLs as URL-typed structure, and the three URL fields distinct", async () => {
    const row = await rowFor();
    const byPath = Object.fromEntries(row.fieldPaths.map((f) => [f.path, f]));
    for (const url of ["tracking_url", "deeplink", "destination_url"]) {
      assert.equal(byPath[url].observedType, "URL", url);
    }
    assert.equal(byPath["link_id"].observedType, "STRING");
    assert.equal(byPath["clicks"].observedType, "NUMBER");
  });

  it("does not tag rows the way the sync job does, and injects no campaign identity", async () => {
    const bare = { clicks: 1, tracking_url: "https://zzbarezz.example/x" };
    const row = await rowFor([{ data: [bare] }]);
    assert.deepEqual(row.fieldPaths.map((f) => f.path), ["clicks", "tracking_url"], "no report_type, campaign_id or campaign_name is added");
    assert.ok(!JSON.stringify(row).includes("link_performance"), "the sync job's own report_type tag is not applied");
    assert.match(codeOf(SYNC_SRC), /report_type: "link_performance"/, "which the sync job still applies for itself");
  });

  it("writes no tracking-link, conversion or settlement meaning into the chain", () => {
    const chain = chainSource();
    for (const forbidden of ["TrackingLink", "trackingLink", "buildDeepLink", "createTrackingLink", "slug", "token", "attribution", "conversion", "Conversion", "settle", "Settlement", "payable", "canonical", "normalise", "normalize", "mapBoostiny", "report_type"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });

  it("does not certify a report row as a tracking link, a conversion or a settlement", async () => {
    const serialised = JSON.stringify(await rowFor());
    for (const claim of ["TRACKING_LINK_ASSET", "TRACKING_LINK_USABLE", "trackingLink", "deepLink", "CONVERSION_ROW", "FINAL_SETTLEMENT", "SETTLED", "PAYABLE", "relationshipState"]) {
      assert.ok(!serialised.includes(claim), claim);
    }
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
  });
});

describe("the link-performance outcome vocabulary", () => {
  it("reports OK with a structural field dictionary and the preset", async () => {
    const row = await rowFor();
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.schema, "KNOWN_FROM_LIVE_SAMPLE");
    assert.equal(row.sampleCount, 1);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.equal(row.windowPreset, "7d");
  });

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for an empty window", async () => {
    for (const empty of [{ data: [] }, { payload: { data: [] } }, {}, []]) {
      const row = await rowFor([empty]);
      assert.equal(row.ok, true, JSON.stringify(empty));
      assert.equal(row.statusCategory, "OK_NO_ROWS");
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
      assert.deepEqual(row.fieldPaths, []);
      assert.equal(row.windowPreset, "7d");
    }
  });

  it("infers no joined, account or tracking state from zero rows", async () => {
    const serialised = JSON.stringify(await rowFor([{ data: [] }]));
    for (const invented of ["NOT_SUPPORTED", "UNSUPPORTED", "accountStateBlocker", "NO_JOINED_CAMPAIGNS", "NO_TRAFFIC", "TRACKING_BROKEN", "NO_LINKS", "relationshipState"]) {
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
      const row = (await certifyLinks(adapterWith(spy))).results[0];
      assert.equal(row.statusCategory, category);
      assert.equal(spy.calls.length, 1);
    }
  });
});

describe("nothing identifying can leak", () => {
  it("never returns a URL, link id, campaign, count, amount, date, subid, status or dimension value", async () => {
    const serialised = JSON.stringify(await rowFor([{ data: [ROW, SECOND_ROW] }]));
    for (const secret of VALUE_MARKERS) assert.ok(!serialised.includes(secret), secret);
  });

  it("never returns the credential or a raw response, on success or on failure", async () => {
    const ok = JSON.stringify(await rowFor());
    const error = new Error(`zzfailurezz ${API_KEY}`);
    error.response = { status: 500, data: { data: [ROW] }, headers: { "x-account": "zzaccountheaderzz" } };
    const failed = JSON.stringify(await rowFor([error]));
    for (const serialised of [ok, failed]) {
      for (const secret of [API_KEY, "Authorization", 'data":[{', "zzlinkidzz", "zzaccountheaderzz", "https://"]) {
        assert.ok(!serialised.includes(secret), secret);
      }
    }
  });

  it("hands the literal credential to every failure for redaction, and keeps the preset on failures", () => {
    assert.match(chainSource(), /certificationFailure\(\s*base,\s*error,\s*\{ windowPreset: window\?\.preset \?\? null \},\s*redactionValuesFor\(adapter\),?\s*\)/);
  });

  it("returns only the safe result keys", async () => {
    const row = await rowFor();
    for (const forbidden of ["rows", "pages", "records", "body", "raw", "data", "sample", "headers", "params", "window", "links", "linkPerformance"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
    for (const expected of ["network", "sourceObject", "endpointKey", "httpMethod", "sampleCount", "fieldCount", "fieldPaths", "statusCategory", "schema", "windowPreset"]) {
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
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany", "rawPayload", "linkPerformance", "TrackingLink"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("leaves production's fetchLinkPerformance paging, retrying and counting as they were", async () => {
    const spy = spyHttp([{ data: [ROW], pagination: { hasNext: true } }, { data: [SECOND_ROW], pagination: { hasNext: false } }]);
    const stats = { requestCount: 0 };
    const rows = await adapterWith(spy).fetchLinkPerformance({ from: isoDaysAgo(7), to: isoDaysAgo(0) }, stats);
    assert.equal(rows.length, 2);
    assert.equal(spy.calls.length, 2);
    assert.equal(stats.requestCount, 2);
    assert.deepEqual(spy.calls[0].config.params, { page: 1, limit: 100, from: isoDaysAgo(7), to: isoDaysAgo(0) });
    assert.deepEqual(spy.calls[1].config.params, { page: 2, limit: 100, from: isoDaysAgo(7), to: isoDaysAgo(0) });
    assert.equal(spy.calls[0].config.timeout, undefined);
    for (const seam of ["singlePage", "retries: 1"]) assert.ok(!codeOf(SYNC_SRC).includes(seam), seam);
  });

  it("leaves the campaigns, coupons and api_reports certifications unchanged", async () => {
    for (const [sourceObject, path, dated] of [
      ["campaigns", BOOSTINY_CAMPAIGNS_PATH, false],
      ["coupons", BOOSTINY_COUPONS_PATH, false],
      ["api_reports", BOOSTINY_PERFORMANCE_PATH, true],
    ]) {
      const spy = spyHttp();
      const row = (await serviceWith(adapterWith(spy)).certify("boostiny", { sourceObjects: [sourceObject] })).results[0];
      assert.equal(spy.calls.length, 1, sourceObject);
      assert.equal(spy.calls[0].path, path);
      assert.equal(spy.calls[0].config.params.page, 1);
      assert.equal(spy.calls[0].config.params.limit, 1);
      assert.equal(row.statusCategory, "OK");
      assert.equal(Object.hasOwn(row, "windowPreset"), dated, sourceObject);
      assert.ok(!spy.calls.some((c) => c.path === BOOSTINY_LINK_PERFORMANCE_PATH), `${sourceObject} never reads link performance`);
    }
  });

  it("keeps settlement manual-only and untouched", () => {
    const entry = getSourceObject("boostiny", "settlement");
    assert.equal(entry.live, false);
    assert.ok(!listProbeSourceObjects("boostiny").includes("settlement"));
    assert.ok(!codeOf(ADAPTER_SRC).includes("fetchPayments"));
    assert.ok(!chainSource().includes("Payment"));
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
    const spy = spyHttp([error, { data: [ROW] }]);
    const row = (await certifyLinks(adapterWith(spy))).results[0];
    assert.equal(spy.calls.length, 1);
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "RATE_LIMITED");
    assert.equal(row.supplierStatusCode, 429);
    assert.equal(row.windowPreset, "7d");
    assert.match(row.supplierMessage, /Retry after 10 minutes/);
    assert.ok(!JSON.stringify(row).includes(API_KEY));
  });
});
