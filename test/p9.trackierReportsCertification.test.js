import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const {
  createTrackierAdapter,
  TRACKIER_REPORTS_PATH,
  TRACKIER_REPORTS_KPI_PATH,
  TRACKIER_CONVERSIONS_PATH,
  TRACKIER_DEFAULT_REPORT_KPIS,
  TRACKIER_DEFAULT_REPORT_GROUPING,
  TRACKIER_WINDOW_NOT_ONE_CHUNK,
} = await import("../src/adapters/trackier.adapter.js");
const {
  NetworkCertificationService,
  listProbeSourceObjects,
  selectTrackierCertificationKpis,
  TRACKIER_CERTIFICATION_REPORT_PARAMS,
  WINDOW_PRESETS,
  DEFAULT_WINDOW_PRESET,
} = await import("../src/modules/ops/networkCertification.service.js");
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

/** The supplier's KPI list: three of production's preferred names, in the supplier's own order,
 *  plus names production never sends. Marker names are distinctive; the preferred ones must be
 *  the literal production spellings, since literal presence is what is under test. */
const ALLOWED = ["zzimpressionszz", "payout", "clicks", "zzprofitzz", "saleAmount"];
const KPI_ONLY_BODY = { allowedKpi: ["zzonlykpizz", "zzsecondkpizz"] };

/** One report row carrying every field the phase wants to observe, each a distinctive marker. */
const ROW = {
  campaign_name: "zzcampaignnamezz",
  campaign_id: "zzcampaignidzz",
  created: "2031-05-06",
  date: "2031-05-06",
  clicks: 4321,
  approvedConversions: 87,
  conversions: 91,
  payout: 1234.56,
  saleAmount: 9876.54,
  revenue: 2222.22,
  profit: 333.33,
  currency: "zzcurrencyzz",
  grouping: "zzgroupingzz",
  publisher_id: "zzpublisheridzz",
};
const SECOND_ROW = { campaign_name: "zzsecondcampaignzz", clicks: 8765, payout: 55.55 };

/** A reports page that advertises many more pages. */
function moreToCome(rows = [ROW]) {
  return { records: rows, pagination: { currentPage: 1, perPage: 1, total: 500 }, total: 500 };
}

/** Pages served in order: [0] answers the KPI request, [1..] the reports request(s). */
function spyHttp(pages = [{ allowedKpi: ALLOWED }, moreToCome()]) {
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

async function certifyReports(adapter, options = {}) {
  return serviceWith(adapter).certify("trackier", { sourceObjects: ["tracking"], ...options });
}

async function rowFor(pages, options = {}) {
  return (await certifyReports(adapterWith(spyHttp(pages)), options)).results[0];
}

const DAY_MS = 86400000;
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function chainSource() {
  return codeOf(SERVICE_SRC).split("async certifyTrackierReports(")[1].split("\n  }")[0];
}

const VALUE_MARKERS = [
  "zzcampaignnamezz",
  "zzcampaignidzz",
  "zzsecondcampaignzz",
  "zzcurrencyzz",
  "zzgroupingzz",
  "zzpublisheridzz",
  "2031-05-06",
  "4321",
  "8765",
  "87",
  "91",
  "1234.56",
  "9876.54",
  "2222.22",
  "333.33",
  "55.55",
];

describe("the two-request contract, in order", () => {
  it("first asks exactly GET /v2/publishers/reports-kpi with no parameters", async () => {
    const spy = spyHttp();
    await certifyReports(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/v2/publishers/reports-kpi");
    assert.equal(TRACKIER_REPORTS_KPI_PATH, "/v2/publishers/reports-kpi");
    assert.ok(!Object.hasOwn(spy.calls[0].config, "params"));
  });

  it("then asks exactly GET /v2/publishers/reports", async () => {
    const spy = spyHttp();
    await certifyReports(adapterWith(spy));
    assert.equal(TRACKIER_REPORTS_PATH, "/v2/publishers/reports");
    assert.equal(spy.calls[1].path, "/v2/publishers/reports");
    assert.equal(spy.calls.length, 2);
  });

  it("is a GET under the catalog's existing name for this endpoint: tracking", async () => {
    const row = (await certifyReports(adapterWith(spyHttp()))).results[0];
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "tracking");
    assert.equal(
      row.endpointKey,
      "GET /v2/publishers/reports (startDate/endDate window, kpis from reports-kpi, grouping=campaign_name,created, limit=1, page=1)",
    );
    const entry = getSourceObject("trackier", "tracking");
    assert.equal(entry.endpoint, "GET /v2/publishers/reports");
    assert.equal(entry.live, true);
    assert.ok(listProbeSourceObjects("trackier").includes("tracking"));
    assert.ok(!listProbeSourceObjects("trackier").includes("reports"), "no second name for the same endpoint");
  });

  it("reuses the X-Api-Key auth on both requests, with no second header scheme", async () => {
    const spy = spyHttp();
    await certifyReports(adapterWith(spy));
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /"X-Api-Key": String\(apiKey\)/);
    assert.ok(!code.includes("Authorization"));
    assert.ok(!code.includes("Bearer"));
    for (const call of spy.calls) assert.ok(!JSON.stringify(call.config).includes(API_KEY));
  });

  it("carries a bounded timeout on both requests", async () => {
    const spy = spyHttp();
    await certifyReports(adapterWith(spy));
    for (const call of spy.calls) assert.ok(Number(call.config.timeout) > 0);
  });

  it("reports both request counts", async () => {
    const row = (await certifyReports(adapterWith(spyHttp()))).results[0];
    assert.equal(row.kpiDiscoveryRequestCount, 1);
    assert.equal(row.reportsRequestCount, 1);
  });
});

describe("the reports request only happens when KPI metadata exists", () => {
  it("makes no reports request and reports SKIPPED_NO_KPI_SCOPE on an empty KPI list", async () => {
    for (const empty of [{ allowedKpi: [] }, { kpis: [] }, {}, [], { allowedKpi: null }, { allowedKpi: "" }]) {
      const spy = spyHttp([empty, moreToCome()]);
      const row = (await certifyReports(adapterWith(spy))).results[0];
      assert.equal(spy.calls.length, 1, JSON.stringify(empty));
      assert.equal(spy.calls[0].path, TRACKIER_REPORTS_KPI_PATH);
      assert.equal(row.ok, false);
      assert.equal(row.statusCategory, "SKIPPED_NO_KPI_SCOPE");
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
      assert.equal(row.kpiDiscoveryRequestCount, 1);
      assert.equal(row.reportsRequestCount, 0);
    }
  });

  it("makes no reports request when the KPI container is not a list of names", async () => {
    for (const notAList of [{ kpi: { clicks: {} } }, { allowedKpi: "clicks" }, { allowedKpi: [{ name: "clicks" }] }, { allowedKpi: [5, null, ""] }]) {
      const spy = spyHttp([notAList, moreToCome()]);
      const row = (await certifyReports(adapterWith(spy))).results[0];
      assert.equal(spy.calls.length, 1, JSON.stringify(notAList));
      assert.equal(row.statusCategory, "SKIPPED_NO_KPI_SCOPE");
      assert.equal(row.reportsRequestCount, 0);
    }
  });

  it("makes no reports request when the KPI request fails, and reports that failure", async () => {
    const error = new Error("zzkpifailurezz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp([error]);
    const row = (await certifyReports(adapterWith(spy))).results[0];
    assert.equal(spy.calls.length, 1);
    assert.equal(row.statusCategory, "UPSTREAM_ERROR");
    assert.equal(row.kpiDiscoveryRequestCount, 1);
    assert.equal(row.reportsRequestCount, 0);
  });

  it("does not infer unsupported or account state from a missing KPI scope", async () => {
    const serialised = JSON.stringify(await rowFor([{ allowedKpi: [] }]));
    for (const claim of ["NOT_SUPPORTED", "UNSUPPORTED", "accountStateBlocker", "NEEDS_ACTIVE_PARTNERSHIP", "relationshipState"]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });
});

describe("the KPI names sent come only from the supplier's allowedKpi[]", () => {
  it("prefers production's names, but only those literally present, in production's order", async () => {
    assert.deepEqual([...TRACKIER_DEFAULT_REPORT_KPIS], ["clicks", "approvedConversions", "payout", "saleAmount"]);
    assert.ok(Object.isFrozen(TRACKIER_DEFAULT_REPORT_KPIS));
    const spy = spyHttp([{ allowedKpi: ALLOWED }, moreToCome()]);
    await certifyReports(adapterWith(spy));
    // approvedConversions is a production default but the supplier did not list it: not sent.
    assert.equal(spy.calls[1].config.params.kpis, "clicks,payout,saleAmount");
  });

  it("sends every preferred name when the supplier lists them all", async () => {
    const spy = spyHttp([{ allowedKpi: ["saleAmount", "payout", "approvedConversions", "clicks", "zzotherzz"] }, moreToCome()]);
    await certifyReports(adapterWith(spy));
    assert.equal(spy.calls[1].config.params.kpis, "clicks,approvedConversions,payout,saleAmount");
  });

  it("falls back to the FIRST supplier name alone when no preferred name is present", async () => {
    const spy = spyHttp([KPI_ONLY_BODY, moreToCome()]);
    await certifyReports(adapterWith(spy));
    assert.equal(spy.calls[1].config.params.kpis, "zzonlykpizz");
    assert.ok(!spy.calls[1].config.params.kpis.includes("zzsecondkpizz"));
  });

  it("invents nothing: production's defaults are never sent unless the supplier listed them", async () => {
    const spy = spyHttp([KPI_ONLY_BODY, moreToCome()]);
    await certifyReports(adapterWith(spy));
    const sent = spy.calls[1].config.params.kpis.split(",");
    for (const invented of TRACKIER_DEFAULT_REPORT_KPIS) assert.ok(!sent.includes(invented), invented);
    for (const name of sent) assert.ok(KPI_ONLY_BODY.allowedKpi.includes(name), name);
  });

  it("normalises nothing: case, whitespace and spelling are the supplier's or the name is not sent", async () => {
    const spy = spyHttp([{ allowedKpi: ["Clicks", " payout", "saleamount", "zzexactzz"] }, moreToCome()]);
    await certifyReports(adapterWith(spy));
    // None of the three near-misses is a production name, so the first supplier name is sent, verbatim.
    assert.equal(spy.calls[1].config.params.kpis, "Clicks");
  });

  it("reads the same reports-kpi container production reads, and only string entries count", () => {
    assert.deepEqual(selectTrackierCertificationKpis(["zzazz", "clicks", 7, null, "", { name: "payout" }]), ["clicks"]);
    assert.deepEqual(selectTrackierCertificationKpis(["zzazz", "zzbzz"]), ["zzazz"]);
    assert.deepEqual(selectTrackierCertificationKpis([7, null, ""]), []);
    assert.deepEqual(selectTrackierCertificationKpis([]), []);
    assert.deepEqual(selectTrackierCertificationKpis({ clicks: 1 }), []);
    assert.deepEqual(selectTrackierCertificationKpis("clicks"), []);
    assert.deepEqual(selectTrackierCertificationKpis(undefined), []);
  });

  it("never reaches the adapter's default-KPI fallback", () => {
    // The adapter substitutes production's defaults for an EMPTY list. The chain never calls it
    // with one: an empty selection skips before the request.
    const chain = chainSource();
    assert.ok(chain.indexOf("if (!kpis.length)") < chain.indexOf("adapter.fetchReports("));
    assert.match(chain, /statusCategory: "SKIPPED_NO_KPI_SCOPE"/);
    assert.match(codeOf(ADAPTER_SRC), /return normalized\.length > 0 \? normalized : DEFAULT_REPORT_KPIS;/);
  });

  it("writes no KPI name of its own into the chain", () => {
    const chain = chainSource();
    for (const name of ["clicks", "approvedConversions", "payout", "saleAmount", "conversions", "revenue", "profit", "impressions"]) {
      assert.ok(!chain.includes(name), name);
    }
    assert.match(chain, /selectTrackierCertificationKpis\(container\)/);
  });
});

describe("the reports request parameters", () => {
  it("sends startDate and endDate under those exact names, from the 7d preset", async () => {
    assert.equal(DEFAULT_WINDOW_PRESET, "7d");
    assert.equal(WINDOW_PRESETS["7d"], 7);
    const spy = spyHttp();
    const row = (await certifyReports(adapterWith(spy))).results[0];
    const { params } = spy.calls[1].config;
    assert.equal(params.startDate, isoDaysAgo(7));
    assert.equal(params.endDate, isoDaysAgo(0));
    assert.equal(daysBetween(params.startDate, params.endDate), 7);
    assert.equal(row.windowPreset, "7d");
    for (const alias of ["start", "end", "from", "to", "dateFrom", "dateTo", "start_date", "end_date"]) {
      assert.ok(!Object.hasOwn(params, alias), alias);
    }
  });

  it("sends page=1 and limit=1", async () => {
    assert.deepEqual(TRACKIER_CERTIFICATION_REPORT_PARAMS, { limit: 1, page: 1 });
    assert.ok(Object.isFrozen(TRACKIER_CERTIFICATION_REPORT_PARAMS));
    const spy = spyHttp();
    await certifyReports(adapterWith(spy));
    assert.equal(spy.calls[1].config.params.page, 1);
    assert.equal(spy.calls[1].config.params.limit, 1);
  });

  it("limit is evidenced: production's pager sends it on every reports call", async () => {
    const spy = spyHttp([{ records: [ROW] }]);
    await adapterWith(spy).fetchReports({ startDate: isoDaysAgo(7), endDate: isoDaysAgo(0), kpis: ["zzkpizz"] });
    assert.equal(spy.calls[0].config.params.limit, 100);
    assert.equal(spy.calls[0].config.params.page, 1);
  });

  it("sends production's default grouping, and never a grouping of its own", async () => {
    assert.deepEqual([...TRACKIER_DEFAULT_REPORT_GROUPING], ["campaign_name", "created"]);
    const spy = spyHttp();
    await certifyReports(adapterWith(spy));
    assert.equal(spy.calls[1].config.params.grouping, "campaign_name,created");
    const chain = chainSource();
    for (const own of ["grouping", "groupBy", "campaign_name", "created"]) assert.ok(!chain.includes(own), own);
    // It is what the sync job sends live, by leaving the same default in place.
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchReports\(\{\s*startDate: dateRange\.start,\s*endDate: dateRange\.end,\s*kpis: availableKpis,\s*\}\)/);
  });

  it("sends exactly these parameters and no campaign scope", async () => {
    const spy = spyHttp();
    await certifyReports(adapterWith(spy));
    assert.deepEqual(Object.keys(spy.calls[1].config.params).sort(), ["endDate", "grouping", "kpis", "limit", "page", "startDate"]);
    for (const scope of ["campaignId", "campaignIds", "campaign_id", "status", "p1"]) {
      assert.ok(!Object.hasOwn(spy.calls[1].config.params, scope), scope);
    }
  });

  it("uses a named preset only: an unknown token falls back to 7d, and reports 7d", async () => {
    const spy = spyHttp();
    const row = (await certifyReports(adapterWith(spy), { windowPreset: "999d" })).results[0];
    assert.equal(row.windowPreset, "7d");
    assert.ok(!JSON.stringify(row).includes("999d"));
    assert.equal(daysBetween(spy.calls[1].config.params.startDate, spy.calls[1].config.params.endDate), 7);
  });

  it("is declared dated, like every other windowed probe", () => {
    assert.match(codeOf(SERVICE_SRC), /chain: "trackierReports",\s*dated: true,/);
  });

  it("ignores any dates a caller tries to pass", async () => {
    const spy = spyHttp();
    await certifyReports(adapterWith(spy), { startDate: "2020-01-01", endDate: "2020-01-02", window: { from: "2020-01-01", to: "2020-01-02" } });
    assert.ok(!JSON.stringify(spy.calls).includes("2020-01-0"));
    assert.equal(spy.calls[1].config.params.startDate, isoDaysAgo(7));
  });

  it("makes no request at all without a window", async () => {
    const spy = spyHttp();
    const adapter = adapterWith(spy);
    const row = await serviceWith(adapter).certifyTrackierReports({
      adapter,
      key: "trackier",
      probe: { method: "GET", endpointKey: "x" },
      budgetLeft: () => 5000,
      sourceObject: "tracking",
      window: null,
    });
    assert.equal(spy.calls.length, 0);
    assert.equal(row.statusCategory, "SKIPPED_NO_WINDOW");
    assert.equal(row.kpiDiscoveryRequestCount, 0);
    assert.equal(row.reportsRequestCount, 0);
  });
});

describe("one chunk, one page, no retry: at most two supplier requests", () => {
  it("7d is exactly one chunk, and the adapter asserts it", async () => {
    const spy = spyHttp([{ records: [ROW] }]);
    await adapterWith(spy).fetchReports(
      { startDate: isoDaysAgo(7), endDate: isoDaysAgo(0), kpis: ["zzkpizz"], limit: 1, page: 1 },
      { singleChunk: true, singlePage: true, retries: 1, timeoutMs: 1000 },
    );
    assert.equal(spy.calls.length, 1);
  });

  it("refuses, before any request, a window that would need a second chunk", async () => {
    const spy = spyHttp([{ records: [ROW] }]);
    await assert.rejects(
      () =>
        adapterWith(spy).fetchReports(
          { startDate: isoDaysAgo(100), endDate: isoDaysAgo(0), kpis: ["zzkpizz"] },
          { singleChunk: true, retries: 1, timeoutMs: 1000 },
        ),
      (error) => error.code === TRACKIER_WINDOW_NOT_ONE_CHUNK && /one date chunk; 2 would be needed/.test(error.message),
    );
    assert.equal(spy.calls.length, 0);
  });

  it("the guard is a real check: production still walks every chunk", async () => {
    const spy = spyHttp([{ records: [ROW] }]);
    await adapterWith(spy).fetchReports({ startDate: isoDaysAgo(100), endDate: isoDaysAgo(0), kpis: ["zzkpizz"] });
    assert.equal(spy.calls.length, 2, "two chunks for 101 days at the 90-day maximum");
  });

  it("7d and 30d fit one chunk; 90d (91 dates, 90-day maximum) is refused, not fanned out", async () => {
    for (const preset of ["7d", "30d"]) {
      const spy = spyHttp();
      const row = (await certifyReports(adapterWith(spy), { windowPreset: preset })).results[0];
      assert.equal(spy.calls.length, 2, preset);
      assert.equal(row.statusCategory, "OK", preset);
      assert.equal(row.windowPreset, preset);
    }
    assert.equal(WINDOW_PRESETS["90d"], 90);
    const spy = spyHttp();
    const row = (await certifyReports(adapterWith(spy), { windowPreset: "90d" })).results[0];
    assert.equal(spy.calls.length, 1, "KPI discovery only; the reports request is refused before it is sent");
    assert.equal(spy.calls[0].path, TRACKIER_REPORTS_KPI_PATH);
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "SKIPPED_WINDOW_NOT_ONE_CHUNK");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.kpiDiscoveryRequestCount, 1);
    assert.equal(row.reportsRequestCount, 0);
    assert.equal(row.windowPreset, "90d");
    assert.match(row.note, /no reports request was made/);
  });

  it("does not request page 2, although the page says 500 rows exist", async () => {
    const spy = spyHttp([{ allowedKpi: ALLOWED }, moreToCome([ROW]), moreToCome([SECOND_ROW])]);
    await certifyReports(adapterWith(spy));
    assert.equal(spy.calls.length, 2);
  });

  it("does not request page 2 on the row-count heuristic or a hasNext hint", async () => {
    for (const second of [{ records: [ROW] }, { records: [ROW], pagination: { hasNext: true } }]) {
      const spy = spyHttp([{ allowedKpi: ALLOWED }, second, { records: [SECOND_ROW] }, { records: [] }]);
      await certifyReports(adapterWith(spy));
      assert.equal(spy.calls.length, 2, JSON.stringify(second));
    }
  });

  it("proves the unbounded pager really would have walked on", async () => {
    const spy = spyHttp([moreToCome([ROW]), moreToCome([SECOND_ROW]), { records: [] }]);
    await adapterWith(spy).fetchReports({ startDate: isoDaysAgo(7), endDate: isoDaysAgo(0), kpis: ["zzkpizz"], limit: 1 });
    assert.ok(spy.calls.length > 1);
    assert.equal(spy.calls[1].config.params.page, 2);
  });

  it("does not retry a failed reports request", async () => {
    for (const failure of [new Error("zzfailurezz"), Object.assign(new Error("zz503zz"), { response: { status: 503, data: {} } })]) {
      const spy = spyHttp([{ allowedKpi: ALLOWED }, failure]);
      const row = (await certifyReports(adapterWith(spy))).results[0];
      assert.equal(spy.calls.length, 2, failure.message);
      assert.equal(row.ok, false);
      assert.equal(row.kpiDiscoveryRequestCount, 1);
      assert.equal(row.reportsRequestCount, 1);
    }
  });

  it("does not retry a failed KPI request", async () => {
    const spy = spyHttp([Object.assign(new Error("zz503zz"), { response: { status: 503, data: {} } })]);
    await certifyReports(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("proves production really would have retried the reports request", async () => {
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp([error, { records: [ROW] }]);
    const rows = await adapterWith(spy).fetchReports({ startDate: isoDaysAgo(7), endDate: isoDaysAgo(0), kpis: ["zzkpizz"] });
    assert.equal(spy.calls.length, 2);
    assert.equal(rows.length, 1);
  });

  it("pins the bounds in the chain, and leaves production's defaults alone", () => {
    const chain = chainSource();
    assert.match(chain, /adapter\.fetchReportsKpi\(\{ retries: 1, timeoutMs, preserveShape: true \}\)/);
    assert.match(chain, /\{ singleChunk: true, singlePage: true, retries: 1, timeoutMs \}/);
    assert.match(chain, /TRACKIER_CERTIFICATION_REPORT_PARAMS/);
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /retries: 6, delayMs: 2000/);
    assert.match(code, /async fetchReports\(params = \{\}, \{ singleChunk = false, singlePage, retries, timeoutMs \} = \{\}\)/);
    const fetcher = code.split("async fetchReports(")[1];
    assert.ok(fetcher.indexOf("singleChunk && chunks.length !== 1") < fetcher.indexOf("for (const chunk of chunks)"));
  });

  it("makes no third request of any kind", async () => {
    const spy = spyHttp([{ allowedKpi: ALLOWED }, moreToCome([ROW]), moreToCome([SECOND_ROW])]);
    await certifyReports(adapterWith(spy));
    assert.equal(spy.calls.length, 2);
    assert.ok(!spy.calls.some((c) => c.path === TRACKIER_CONVERSIONS_PATH));
    assert.ok(!spy.calls.some((c) => c.path === "/v2/publisher/campaigns"));
  });
});

describe("the certification reuses production's fetchers, and adds no second one", () => {
  it("calls fetchReportsKpi then fetchReports, and nothing else on the adapter", () => {
    const chain = chainSource();
    assert.ok(chain.indexOf("adapter.fetchReportsKpi(") < chain.indexOf("adapter.fetchReports("));
    for (const other of ["fetchConversions", "fetchCampaigns", "fetchCoupons", "fetchDeals", "fetchProfile", "httpClient", ".get("]) {
      assert.ok(!chain.includes(other), other);
    }
  });

  it("defines one fetchReports and one reports path in the adapter", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/async fetchReports\(/g) ?? []).length, 1);
    assert.equal((code.match(/"\/v2\/publishers\/reports"/g) ?? []).length, 1);
    assert.equal((code.match(/TRACKIER_REPORTS_PATH,/g) ?? []).length, 1);
  });

  it("creates no parallel client", () => {
    const code = codeOf(SERVICE_SRC);
    assert.match(code, /trackier: "buildTrackierAdapter"/);
    assert.equal((code.match(/createTrackierAdapter\(/g) ?? []).length, 0);
  });

  it("extracts the records envelope the way production does", async () => {
    for (const body of [{ records: [ROW] }, { data: { records: [ROW] } }, [ROW]]) {
      const row = await rowFor([{ allowedKpi: ALLOWED }, body]);
      assert.equal(row.sampleCount, 1, JSON.stringify(Object.keys(body)));
    }
  });

  it("leaves production's reports call shape unchanged", async () => {
    const spy = spyHttp([{ records: [ROW] }]);
    await adapterWith(spy).fetchReports({ startDate: isoDaysAgo(7), endDate: isoDaysAgo(0), kpis: ["zzkpizz"] });
    assert.deepEqual(spy.calls[0].config.params, {
      startDate: isoDaysAgo(7),
      endDate: isoDaysAgo(0),
      kpis: "zzkpizz",
      grouping: "campaign_name,created",
      page: 1,
      limit: 100,
    });
    assert.equal(spy.calls[0].config.timeout, undefined);
  });

  it("leaves the KPI-container handling as certified in the previous phase", async () => {
    const spy = spyHttp([{ allowedKpi: ALLOWED }]);
    const kpi = (await serviceWith(adapterWith(spy)).certify("trackier", { sourceObjects: ["reports_kpi"] })).results[0];
    assert.equal(kpi.schema, "KPI_VALUE_ARRAY");
    assert.equal(spy.calls.length, 1);
  });
});

describe("the sample is bounded to one row, locally too", () => {
  it("keeps one row even when the page carries several", async () => {
    const row = await rowFor([{ allowedKpi: ALLOWED }, { records: [ROW, SECOND_ROW, ROW] }]);
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldPaths.every((f) => f.sampleCount === 1));
    assert.ok(!row.fieldPaths.some((f) => f.path === "zzsecondonly"));
  });

  it("slices to one in the chain", () => {
    assert.match(chainSource(), /\.slice\(0, 1\)/);
  });
});

describe("report fields are preserved structurally, and semantics stay separate", () => {
  async function paths() {
    return (await rowFor()).fieldPaths.map((f) => f.path);
  }

  it("reports the supplier's own field names, including the grouping and KPI fields", async () => {
    const seen = await paths();
    for (const supplierName of [
      "campaign_name",
      "campaign_id",
      "created",
      "date",
      "clicks",
      "approvedConversions",
      "conversions",
      "payout",
      "saleAmount",
      "revenue",
      "profit",
      "currency",
      "grouping",
    ]) {
      assert.ok(seen.includes(supplierName), supplierName);
    }
  });

  it("renames none of them into MBO canon", async () => {
    const seen = await paths();
    for (const alias of [
      "campaignName",
      "campaignId",
      "merchantName",
      "occurredAt",
      "reportDate",
      "billableClicks",
      "payableConversions",
      "settledCommission",
      "commissionAmount",
      "orderValue",
      "finalOrderValue",
      "externalId",
      "conversionId",
    ]) {
      assert.ok(!seen.includes(alias), alias);
    }
  });

  it("keeps approvedConversions and conversions as two fields, and payout and saleAmount as two", async () => {
    const seen = await paths();
    assert.ok(seen.includes("approvedConversions") && seen.includes("conversions"));
    assert.ok(seen.includes("payout") && seen.includes("saleAmount"));
    assert.ok(seen.includes("revenue") && seen.includes("profit"));
  });

  it("writes no equivalence or finance meaning into the chain", () => {
    const chain = chainSource();
    for (const forbidden of [
      "billable",
      "payable",
      "settled",
      "finalOrder",
      "conversionRow",
      "Conversion.",
      "reconcile",
      "canonical",
      "normalise",
      "normalize",
      "mapTrackier",
      "Performance.",
      "SupplierPerformance",
    ]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });

  it("does not certify a report row as a conversion or a finance record", async () => {
    const serialised = JSON.stringify(await rowFor());
    for (const claim of ["CONVERSION_ROW", "FINANCE_RECORD", "FINAL_PAYABLE", "SETTLED", "PAYABLE", "BILLABLE", "isPayable"]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
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
    assert.equal(row.fieldPaths.find((f) => f.path === "clicks").observedType, "NUMBER");
    assert.equal(row.fieldPaths.find((f) => f.path === "campaign_name").observedType, "STRING");
  });
});

describe("the reports outcome vocabulary", () => {
  it("reports OK with a structural field dictionary and both counts", async () => {
    const row = await rowFor();
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.schema, "KNOWN_FROM_LIVE_SAMPLE");
    assert.equal(row.sampleCount, 1);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.kpiDiscoveryRequestCount, 1);
    assert.equal(row.reportsRequestCount, 1);
  });

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for an empty window, after both requests", async () => {
    for (const empty of [{ records: [] }, { data: { records: [] } }, {}]) {
      const spy = spyHttp([{ allowedKpi: ALLOWED }, empty]);
      const row = (await certifyReports(adapterWith(spy))).results[0];
      assert.equal(spy.calls.length, 2, JSON.stringify(empty));
      assert.equal(row.ok, true);
      assert.equal(row.statusCategory, "OK_NO_ROWS");
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
      assert.deepEqual(row.fieldPaths, []);
      assert.equal(row.kpiDiscoveryRequestCount, 1);
      assert.equal(row.reportsRequestCount, 1);
      assert.equal(row.windowPreset, "7d");
    }
  });

  it("infers no joined, account or tracking state from zero rows", async () => {
    const serialised = JSON.stringify(await rowFor([{ allowedKpi: ALLOWED }, { records: [] }]));
    for (const invented of ["NOT_SUPPORTED", "UNSUPPORTED", "accountStateBlocker", "NO_JOINED_CAMPAIGNS", "relationshipState", "NO_TRAFFIC", "TRACKING_BROKEN"]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("preserves an auth rejection on either request safely", async () => {
    for (const [pages, discovery, reports] of [
      [[Object.assign(new Error("zzauthzz"), { response: { status: 401, data: { message: "zzupstreambodyzz" } } })], 1, 0],
      [[{ allowedKpi: ALLOWED }, Object.assign(new Error("zzauthzz"), { response: { status: 403, data: { message: "zzupstreambodyzz" } } })], 1, 1],
    ]) {
      const row = await rowFor(pages);
      assert.equal(row.ok, false);
      assert.equal(row.statusCategory, "AUTH_FAILED");
      assert.equal(row.kpiDiscoveryRequestCount, discovery);
      assert.equal(row.reportsRequestCount, reports);
      const serialised = JSON.stringify(row);
      assert.ok(!serialised.includes(API_KEY));
      assert.ok(!serialised.includes("zzupstreambodyzz"));
    }
  });

  it("preserves a supplier validation failure safely", async () => {
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: { errors: ["zzvalidationdetailzz"] } };
    const row = await rowFor([{ allowedKpi: ALLOWED }, error]);
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
    assert.ok(!JSON.stringify(row).includes("zzvalidationdetailzz"));
  });
});

describe("nothing transactional, configured or identifying can leak", () => {
  it("never returns the KPI names selected or sent", async () => {
    const serialised = JSON.stringify(await rowFor([{ allowedKpi: ["zzonlykpizz"] }, { records: [{ zzfieldzz: 1 }] }]));
    assert.ok(!serialised.includes("zzonlykpizz"));
    const row = await rowFor();
    for (const key of ["kpis", "selectedKpis", "kpiNames", "allowedKpi", "grouping", "params"]) {
      assert.ok(!Object.hasOwn(row, key), key);
    }
  });

  it("never returns a campaign name, count, amount, date, currency or identifier", async () => {
    const serialised = JSON.stringify(await rowFor([{ allowedKpi: ALLOWED }, { records: [ROW, SECOND_ROW] }]));
    for (const secret of VALUE_MARKERS) assert.ok(!serialised.includes(secret), secret);
  });

  it("never returns the window dates", async () => {
    const row = await rowFor();
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(isoDaysAgo(7)));
    assert.ok(!serialised.includes(isoDaysAgo(0)));
  });

  it("never returns the API key or a raw response, on success or on failure", async () => {
    const ok = JSON.stringify(await rowFor());
    const error = new Error(`zzfailurezz ${API_KEY}`);
    error.response = { status: 500, data: { records: [ROW] } };
    const failed = JSON.stringify(await rowFor([{ allowedKpi: ALLOWED }, error]));
    for (const serialised of [ok, failed]) {
      for (const secret of [API_KEY, "X-Api-Key", 'records":[{', "zzcampaignnamezz", "https://"]) {
        assert.ok(!serialised.includes(secret), secret);
      }
    }
  });

  it("returns only the safe result keys", async () => {
    const row = await rowFor();
    for (const forbidden of ["rows", "records", "body", "raw", "data", "sample", "headers", "window", "container", "envelope"]) {
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
      "schema",
      "kpiDiscoveryRequestCount",
      "reportsRequestCount",
      "windowPreset",
    ]) {
      assert.ok(Object.hasOwn(row, expected), expected);
    }
  });
});

describe("read-only, and the other probes unchanged", () => {
  it("performs no database read or write", async () => {
    assert.equal((await rowFor()).statusCategory, "OK");
  });

  it("writes nothing in the chain", () => {
    const chain = chainSource();
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany", "rawPayload", "availableKpis", "reportingRows"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("adds no persistence, payable, finance or reconciliation path", () => {
    const chain = chainSource();
    for (const forbidden of ["Payment", "Invoice", "SupplierCommissionRule", "ClientCommission", "reconcil", "payable", "relationshipState"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
    for (const notYet of ["finance", "reports", "payments"]) {
      assert.ok(!listProbeSourceObjects("trackier").includes(notYet), notYet);
    }
  });

  it("leaves the sync job's reports read exactly as it was", () => {
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchReports\(\{/);
    for (const seam of ["singleChunk", "singlePage", "preserveShape", "selectTrackierCertificationKpis"]) {
      assert.ok(!codeOf(SYNC_SRC).includes(seam), seam);
    }
  });

  it("leaves the six earlier probes unchanged", async () => {
    const cases = [
      ["profile", [{ profile: { id: "zzprofileidzz" } }], 1, "/v2/publishers/profile"],
      ["campaigns", [{ campaigns: [{ id: "zzcampaignzz" }] }], 1, "/v2/publisher/campaigns"],
      ["campaign_detail", [{ campaigns: [{ id: "zzdiscoveredzz" }] }, { data: { id: "zzdiscoveredzz" } }], 2, "/v2/publisher/campaigns"],
      ["coupons", [{ coupons: [{ id: "zzcouponzz" }], nextPageToken: "zztokzz" }], 1, "/v2/publishers/coupons"],
      ["deals", [{ deals: [{ id: "zzdealzz" }], nextPageToken: "zztokzz" }], 1, "/v2/publishers/deals"],
      ["conversions", [{ conversions: [{ id: "zzconvzz" }], pagination: { hasNext: true } }], 1, TRACKIER_CONVERSIONS_PATH],
      ["reports_kpi", [{ allowedKpi: ALLOWED }], 1, TRACKIER_REPORTS_KPI_PATH],
    ];
    for (const [sourceObject, pages, requests, firstPath] of cases) {
      const spy = spyHttp(pages);
      const row = (await serviceWith(adapterWith(spy)).certify("trackier", { sourceObjects: [sourceObject] })).results[0];
      assert.equal(spy.calls.length, requests, sourceObject);
      assert.equal(spy.calls[0].path, firstPath, sourceObject);
      assert.equal(row.statusCategory, "OK", sourceObject);
      assert.ok(!spy.calls.some((c) => c.path === TRACKIER_REPORTS_PATH), `${sourceObject} never reads reports`);
    }
  });
});
