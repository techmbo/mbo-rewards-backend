import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { createTrackierAdapter, TRACKIER_CONVERSIONS_PATH, TRACKIER_CAMPAIGNS_PATH, TRACKIER_WINDOW_NOT_ONE_CHUNK } = await import(
  "../src/adapters/trackier.adapter.js"
);
const {
  NetworkCertificationService,
  listProbeSourceObjects,
  TRACKIER_CERTIFICATION_CONVERSION_PARAMS,
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

/**
 * One conversion row carrying every identifier and money field the phase forbids conflating, each
 * with its own distinctive marker value. conversion id, order id and click id are three fields;
 * payout and sale amount are two; p1..p5 are five.
 */
const CONVERSION = {
  id: "zzconversionidzz",
  conversion_id: "zzconversionfieldidzz",
  order_id: "zzorderidzz",
  txn_id: "zztransactionidzz",
  click_id: "zzclickidzz",
  campaign_id: "zzcampaignidzz",
  campaign_name: "zzcampaignnamezz",
  advertiser_id: "zzadvertiseridzz",
  status: "zzconversionstatuszz",
  payout: 1234.56,
  commission: 987.65,
  sale_amount: 4321.09,
  order_amount: 8765.43,
  currency: "zzcurrencyzz",
  p1: "zzpublisheronezz",
  p2: "zzpublishertwozz",
  p3: "zzpublisherthreezz",
  p4: "zzpublisherfourzz",
  p5: "zzpublisherfivezz",
  customer_email: "zzcustomer@example.test",
  customer_ip: "203.0.113.77",
  referer: "https://zzrefererzz.example/landing",
  created: "2031-04-05 06:07:08",
  updated: "2031-04-06 09:10:11",
};

const SECOND_CONVERSION = {
  id: "zzsecondconversionidzz",
  order_id: "zzsecondorderidzz",
  click_id: "zzsecondclickidzz",
  payout: 22.22,
};

/** A page that advertises many more pages, so a pager that reads the hint shows up as a call. */
function moreToCome(rows = [CONVERSION]) {
  return { conversions: rows, pagination: { currentPage: 1, perPage: 1, total: 500 }, total: 500 };
}

function spyHttp(pages = [moreToCome()]) {
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

async function certifyConversions(adapter, options = {}) {
  return serviceWith(adapter).certify("trackier", { sourceObjects: ["conversions"], ...options });
}

const DAY_MS = 86400000;
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function chainSource() {
  return codeOf(SERVICE_SRC).split("async certifyTrackierConversions")[1].split("\n  }")[0];
}

describe("the documented conversions request contract", () => {
  it("addresses exactly GET /v2/publishers/conversions", async () => {
    assert.equal(TRACKIER_CONVERSIONS_PATH, "/v2/publishers/conversions");
    const spy = spyHttp();
    await certifyConversions(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/v2/publishers/conversions");
  });

  it("is a GET, and the endpointKey names the window and the bounds", async () => {
    const row = (await certifyConversions(adapterWith(spyHttp()))).results[0];
    assert.equal(row.httpMethod, "GET");
    assert.equal(
      row.endpointKey,
      "GET /v2/publishers/conversions (startDate/endDate window, limit=1, page=1)",
    );
    assert.equal(row.sourceObject, "conversions");
  });

  it("sends startDate and endDate, under those exact names", async () => {
    const spy = spyHttp();
    await certifyConversions(adapterWith(spy));
    const { params } = spy.calls[0].config;
    assert.match(params.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(params.endDate, /^\d{4}-\d{2}-\d{2}$/);
    for (const alias of ["start", "end", "from", "to", "dateFrom", "dateTo", "start_date", "end_date"]) {
      assert.ok(!Object.hasOwn(params, alias), alias);
    }
  });

  it("sends limit=1 and page=1, and nothing else", async () => {
    assert.deepEqual(TRACKIER_CERTIFICATION_CONVERSION_PARAMS, { limit: 1, page: 1 });
    assert.ok(Object.isFrozen(TRACKIER_CERTIFICATION_CONVERSION_PARAMS));
    const spy = spyHttp();
    await certifyConversions(adapterWith(spy));
    const { params } = spy.calls[0].config;
    assert.equal(params.limit, 1);
    assert.equal(params.page, 1);
    assert.deepEqual(Object.keys(params).sort(), ["endDate", "limit", "page", "startDate"]);
  });

  it("sends no status, click or sub-id filter of its own", async () => {
    const spy = spyHttp();
    await certifyConversions(adapterWith(spy));
    const { params } = spy.calls[0].config;
    for (const filter of ["status", "click_id", "clickId", "p1", "p2", "p3", "p4", "p5"]) {
      assert.ok(!Object.hasOwn(params, filter), filter);
    }
  });

  it("reuses the X-Api-Key auth, with no second header scheme", async () => {
    const spy = spyHttp();
    await certifyConversions(adapterWith(spy));
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /"X-Api-Key": String\(apiKey\)/);
    assert.ok(!code.includes("Authorization"));
    assert.ok(!code.includes("Bearer"));
    assert.ok(!JSON.stringify(spy.calls[0].config).includes(API_KEY));
  });

  it("carries a bounded timeout", async () => {
    const spy = spyHttp();
    await certifyConversions(adapterWith(spy));
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
  });

  it("is declared dated, like every other windowed probe", () => {
    assert.match(codeOf(SERVICE_SRC), /chain: "trackierConversions",\s*dated: true,/);
  });

  it("is catalogued under the existing canonical name, on the existing endpoint", () => {
    const entry = getSourceObject("trackier", "conversions");
    assert.ok(entry);
    assert.equal(entry.endpoint, "GET /v2/publishers/conversions");
    assert.equal(entry.live, true);
    assert.ok(listProbeSourceObjects("trackier").includes("conversions"));
    // The sync job already reads it under this name and through this fetcher.
    assert.match(codeOf(SYNC_SRC), /"conversions",\s*credentials,\s*\(\)\s*=>\s*adapter\.fetchConversions\(\{/);
  });
});

describe("the window is the framework's, and it is 7d", () => {
  it("starts from the 7d preset", async () => {
    assert.equal(DEFAULT_WINDOW_PRESET, "7d");
    assert.equal(WINDOW_PRESETS["7d"], 7);
    const spy = spyHttp();
    const row = (await certifyConversions(adapterWith(spy))).results[0];
    assert.equal(row.windowPreset, "7d");
    const { startDate, endDate } = spy.calls[0].config.params;
    assert.equal(daysBetween(startDate, endDate), 7);
    assert.equal(endDate, new Date().toISOString().slice(0, 10));
  });

  it("passes the framework's dates through unchanged", async () => {
    const spy = spyHttp();
    await certifyConversions(adapterWith(spy));
    const { startDate, endDate } = spy.calls[0].config.params;
    assert.equal(startDate, isoDaysAgo(7));
    assert.equal(endDate, isoDaysAgo(0));
  });

  it("ignores any dates a caller tries to pass", async () => {
    const spy = spyHttp();
    await certifyConversions(adapterWith(spy), {
      startDate: "2020-01-01",
      endDate: "2020-01-02",
      window: { from: "2020-01-01", to: "2020-01-02" },
      from: "2020-01-01",
      to: "2020-01-02",
    });
    assert.ok(!JSON.stringify(spy.calls).includes("2020-01-0"));
    assert.equal(spy.calls[0].config.params.startDate, isoDaysAgo(7));
  });

  it("uses a named preset only, never a caller-shaped window", async () => {
    const spy = spyHttp();
    const row = (await certifyConversions(adapterWith(spy), { windowPreset: "30d" })).results[0];
    assert.equal(row.windowPreset, "30d");
    assert.equal(daysBetween(spy.calls[0].config.params.startDate, spy.calls[0].config.params.endDate), 30);
    assert.equal(spy.calls.length, 1, "30 days still fits one chunk, one page");

    const unknown = spyHttp();
    const fallback = (await certifyConversions(adapterWith(unknown), { windowPreset: "999d" })).results[0];
    assert.equal(fallback.windowPreset, "7d");
    assert.equal(daysBetween(unknown.calls[0].config.params.startDate, unknown.calls[0].config.params.endDate), 7);
  });

  it("makes no supplier request and reports SKIPPED_NO_WINDOW when the chain has no window", async () => {
    const spy = spyHttp();
    const adapter = adapterWith(spy);
    const service = serviceWith(adapter);
    for (const window of [null, undefined, {}, { from: isoDaysAgo(7) }, { to: isoDaysAgo(0) }]) {
      const row = await service.certifyTrackierConversions({
        adapter,
        key: "trackier",
        probe: { method: "GET", endpointKey: "GET /v2/publishers/conversions (startDate/endDate window, limit=1, page=1)" },
        budgetLeft: () => 5000,
        sourceObject: "conversions",
        window,
      });
      assert.equal(row.ok, false, JSON.stringify(window));
      assert.equal(row.statusCategory, "SKIPPED_NO_WINDOW");
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
    }
    assert.equal(spy.calls.length, 0);
  });

  it("reports the window preset, and never the dates themselves", async () => {
    const row = (await certifyConversions(adapterWith(spyHttp()))).results[0];
    const serialised = JSON.stringify(row);
    assert.equal(row.windowPreset, "7d");
    assert.ok(!serialised.includes(isoDaysAgo(7)));
    assert.ok(!serialised.includes(isoDaysAgo(0)));
    assert.ok(!Object.hasOwn(row, "window"));
  });
});

describe("the 7d window is exactly one date chunk", () => {
  it("the adapter asserts a single chunk when asked to, and 7d satisfies it", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchConversions(
      { startDate: isoDaysAgo(7), endDate: isoDaysAgo(0), limit: 1, page: 1 },
      { singleChunk: true, singlePage: true, retries: 1, timeoutMs: 1000 },
    );
    assert.equal(spy.calls.length, 1);
  });

  it("refuses, before any request, a window that would need a second chunk", async () => {
    const spy = spyHttp();
    await assert.rejects(
      () =>
        adapterWith(spy).fetchConversions(
          { startDate: isoDaysAgo(40), endDate: isoDaysAgo(0) },
          { singleChunk: true, singlePage: true, retries: 1, timeoutMs: 1000 },
        ),
      /one date chunk; 2 would be needed/,
    );
    assert.equal(spy.calls.length, 0, "the refusal happens before the first request");
  });

  it("the guard is a real check, not a truncation: production still walks every chunk", async () => {
    const spy = spyHttp([{ conversions: [CONVERSION] }]);
    await adapterWith(spy).fetchConversions({ startDate: isoDaysAgo(40), endDate: isoDaysAgo(0) });
    assert.equal(spy.calls.length, 2, "two chunks for 41 days at the 31-day maximum");
    assert.notEqual(spy.calls[0].config.params.startDate, spy.calls[1].config.params.startDate);
  });

  it("the chain pins singleChunk, so a wider preset could never fan out silently", () => {
    const chain = chainSource();
    assert.match(chain, /singleChunk: true/);
    assert.match(codeOf(ADAPTER_SRC), /if \(singleChunk && chunks\.length !== 1\)/);
    // The check precedes the request loop in source order.
    const code = codeOf(ADAPTER_SRC);
    const fetcher = code.split("async fetchConversions(")[1];
    assert.ok(fetcher.indexOf("singleChunk && chunks.length !== 1") < fetcher.indexOf("for (const chunk of chunks)"));
  });

  it("every preset the framework offers fits one chunk", () => {
    const maxDays = Number(process.env.TRACKIER_CONVERSIONS_MAX_DAYS || 31);
    for (const [preset, days] of Object.entries(WINDOW_PRESETS)) {
      if (preset === "90d") continue; // 90d would need three chunks; it is refused, not fanned out.
      assert.ok(days + 1 <= maxDays, preset);
    }
  });

  it("refuses the 90d preset rather than making three requests, and says so as a skip", async () => {
    const spy = spyHttp();
    const row = (await certifyConversions(adapterWith(spy), { windowPreset: "90d" })).results[0];
    assert.equal(spy.calls.length, 0);
    assert.equal(row.ok, false);
    assert.equal(row.windowPreset, "90d");
    assert.equal(row.statusCategory, "SKIPPED_WINDOW_NOT_ONE_CHUNK");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.match(row.note, /no supplier request was made/);
    for (const wrong of ["NETWORK_ERROR", "UPSTREAM_ERROR", "supplierStatusCode", "supplierMessage"]) {
      assert.ok(!JSON.stringify(row).includes(wrong), wrong);
    }
    assert.equal(TRACKIER_WINDOW_NOT_ONE_CHUNK, "TRACKIER_WINDOW_NOT_ONE_CHUNK");
  });
});

describe("exactly one request: no retry, no page 2, no second chunk", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await certifyConversions(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request page 2, although the page says 500 rows exist", async () => {
    const spy = spyHttp([moreToCome([CONVERSION]), moreToCome([SECOND_CONVERSION])]);
    await certifyConversions(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].config.params.page, 1);
  });

  it("does not request page 2 on the row-count heuristic either", async () => {
    // No pagination block at all: the pager's last resort is rowsCount >= pageSize, and one row
    // at limit=1 satisfies it. Certification must break before that heuristic runs.
    const spy = spyHttp([{ conversions: [CONVERSION] }, { conversions: [SECOND_CONVERSION] }, { conversions: [] }]);
    await certifyConversions(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request page 2 on a hasNext hint", async () => {
    const spy = spyHttp([{ conversions: [CONVERSION], pagination: { hasNext: true } }, { conversions: [] }]);
    await certifyConversions(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("proves the unbounded pager really would have walked on", async () => {
    const spy = spyHttp([moreToCome([CONVERSION]), moreToCome([SECOND_CONVERSION]), { conversions: [] }]);
    await adapterWith(spy).fetchConversions({ startDate: isoDaysAgo(7), endDate: isoDaysAgo(0), limit: 1 });
    assert.ok(spy.calls.length > 1, "production pages; certification must not");
    assert.equal(spy.calls[1].config.params.page, 2);
  });

  it("does not retry a failed request", async () => {
    const spy = spyHttp([new Error("zzsupplierfailurezz")]);
    await certifyConversions(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a retryable status either", async () => {
    for (const status of [500, 502, 503]) {
      const error = new Error("zzupstreamzz");
      error.response = { status, data: {} };
      const spy = spyHttp([error]);
      await certifyConversions(adapterWith(spy));
      assert.equal(spy.calls.length, 1, String(status));
    }
  });

  it("proves production really would have retried", async () => {
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp([error, { conversions: [CONVERSION] }]);
    const rows = await adapterWith(spy).fetchConversions({ startDate: isoDaysAgo(7), endDate: isoDaysAgo(0) });
    assert.equal(spy.calls.length, 2);
    assert.equal(rows.length, 1);
  });

  it("pins the bounds in the chain, and leaves production's defaults alone", () => {
    const chain = chainSource();
    assert.match(chain, /singleChunk: true/);
    assert.match(chain, /singlePage: true/);
    assert.match(chain, /retries: 1/);
    assert.match(chain, /timeoutMs/);
    assert.match(chain, /TRACKIER_CERTIFICATION_CONVERSION_PARAMS/);
    assert.match(codeOf(ADAPTER_SRC), /retries: 6, delayMs: 2000/);
    assert.match(codeOf(ADAPTER_SRC), /singleChunk = false/);
    assert.match(codeOf(ADAPTER_SRC), /singlePage = false/);
  });

  it("breaks out of the pager before the paging heuristic, in source order", () => {
    const code = codeOf(ADAPTER_SRC);
    const pager = code.split("async function fetchPageNumberPaginated")[1].split("\n}")[0];
    const breakAt = pager.indexOf("if (singlePage) break;");
    assert.ok(breakAt >= 0);
    assert.ok(breakAt < pager.indexOf("hasMoreNumberedPages("), "before the heuristic");
    assert.ok(breakAt < pager.indexOf("page += 1"), "before the increment");
    assert.ok(breakAt > pager.indexOf("rows.push("), "after the page's rows are kept");
  });
});

describe("the certification reuses production's fetcher, and adds no second one", () => {
  it("calls adapter.fetchConversions and nothing else on the adapter", () => {
    const chain = chainSource();
    assert.match(chain, /adapter\.fetchConversions\(/);
    for (const other of ["fetchReports", "fetchCampaigns", "fetchCoupons", "fetchDeals", "fetchProfile", "httpClient", ".get("]) {
      assert.ok(!chain.includes(other), other);
    }
  });

  it("defines one fetchConversions and one conversions path in the adapter", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/async fetchConversions\(/g) ?? []).length, 1);
    assert.equal((code.match(/"\/v2\/publishers\/conversions"/g) ?? []).length, 1);
    assert.equal((code.match(/TRACKIER_CONVERSIONS_PATH,/g) ?? []).length, 1);
  });

  it("creates no parallel client: the service builds it through the registered builder", () => {
    const code = codeOf(SERVICE_SRC);
    assert.match(code, /trackier: "buildTrackierAdapter"/);
    // The builder falls back to the ONE exported factory; the service never constructs a client.
    assert.match(code, /this\.adapterFactory \?\? createTrackierAdapter/);
    assert.equal((code.match(/createTrackierAdapter\(/g) ?? []).length, 0);
    assert.ok(!code.includes("axios.create"));
  });

  it("extracts the conversions envelope the way production does", async () => {
    for (const body of [{ conversions: [CONVERSION] }, { data: { conversions: [CONVERSION] } }, [CONVERSION]]) {
      const spy = spyHttp([body]);
      const row = (await certifyConversions(adapterWith(spy))).results[0];
      assert.equal(row.sampleCount, 1, JSON.stringify(Object.keys(body)));
    }
  });

  it("leaves production's call shape unchanged: dates only, page limit 100, chunked, retried", async () => {
    const spy = spyHttp([{ conversions: [CONVERSION] }]);
    await adapterWith(spy).fetchConversions({ startDate: isoDaysAgo(7), endDate: isoDaysAgo(0) });
    assert.deepEqual(spy.calls[0].config.params, {
      startDate: isoDaysAgo(7),
      endDate: isoDaysAgo(0),
      page: 1,
      limit: 100,
    });
    assert.equal(spy.calls[0].config.timeout, undefined, "no timeout imposed");
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchConversions\(\{\s*startDate: dateRange\.start,\s*endDate: dateRange\.end,\s*\}\)/);
  });
});

describe("the sample is bounded to one row, locally too", () => {
  it("keeps one row even when the page carries several", async () => {
    const spy = spyHttp([{ conversions: [CONVERSION, SECOND_CONVERSION, CONVERSION] }]);
    const row = (await certifyConversions(adapterWith(spy))).results[0];
    assert.equal(spy.calls.length, 1);
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldPaths.every((f) => f.sampleCount === 1));
  });

  it("never returns the later rows' values", async () => {
    const serialised = JSON.stringify(
      await certifyConversions(adapterWith(spyHttp([{ conversions: [CONVERSION, SECOND_CONVERSION] }]))),
    );
    for (const secret of ["zzsecondconversionidzz", "zzsecondorderidzz", "zzsecondclickidzz", "22.22"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("slices to one in the chain", () => {
    assert.match(chainSource(), /\.slice\(0, 1\)/);
  });
});

describe("supplier field names are preserved, and nothing is conflated", () => {
  async function paths() {
    return (await certifyConversions(adapterWith(spyHttp()))).results[0].fieldPaths.map((f) => f.path);
  }

  it("reports the supplier's own field names", async () => {
    const seen = await paths();
    for (const supplierName of [
      "id",
      "conversion_id",
      "order_id",
      "txn_id",
      "click_id",
      "campaign_id",
      "campaign_name",
      "advertiser_id",
      "status",
      "payout",
      "commission",
      "sale_amount",
      "order_amount",
      "currency",
      "created",
      "updated",
    ]) {
      assert.ok(seen.includes(supplierName), supplierName);
    }
  });

  it("renames none of them into MBO canon", async () => {
    const seen = await paths();
    for (const alias of [
      "externalId",
      "orderId",
      "clickId",
      "transactionId",
      "conversionId",
      "campaignId",
      "merchantId",
      "commissionAmount",
      "saleAmount",
      "orderValue",
      "payableAmount",
      "settledRevenue",
      "createdAt",
      "occurredAt",
    ]) {
      assert.ok(!seen.includes(alias), alias);
    }
  });

  it("keeps p1..p5 as five separate fields", async () => {
    const seen = await paths();
    for (const sub of ["p1", "p2", "p3", "p4", "p5"]) {
      assert.ok(seen.includes(sub), sub);
    }
    for (const merged of ["subId", "sub_id", "subid", "subIds", "clickRef", "params"]) {
      assert.ok(!seen.includes(merged), merged);
    }
    assert.equal(new Set(["p1", "p2", "p3", "p4", "p5"].filter((s) => seen.includes(s))).size, 5);
  });

  it("keeps conversion id, order id and click id as distinct fields", async () => {
    const seen = await paths();
    for (const field of ["id", "conversion_id", "order_id", "txn_id", "click_id"]) {
      assert.ok(seen.includes(field), field);
    }
    assert.equal(new Set(["id", "conversion_id", "order_id", "txn_id", "click_id"]).size, 5);
  });

  it("keeps payout and sale amount as distinct fields", async () => {
    const seen = await paths();
    for (const field of ["payout", "commission", "sale_amount", "order_amount"]) {
      assert.ok(seen.includes(field), field);
    }
  });

  it("writes no equivalence into the chain", () => {
    const chain = chainSource();
    for (const forbidden of [
      "order_id",
      "orderId",
      "click_id",
      "clickId",
      "transaction",
      "payout",
      "commission",
      "sale",
      "revenue",
      "payable",
      "settled",
      "p1",
      "subId",
      "canonical",
      "normalise",
      "normalize",
      "mapTrackier",
      "externalId",
    ]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });

  it("does not certify a conversion as a finance record", async () => {
    const serialised = JSON.stringify(await certifyConversions(adapterWith(spyHttp())));
    for (const claim of [
      "FINAL_PAYABLE",
      "SETTLED",
      "PAYMENT_CONFIRMED",
      "INVOICED",
      "ORDER_FINANCE",
      "isPayable",
      "finalPayable",
      "settledRevenue",
    ]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });

  it("certifies a row with none of the optional fields as a complete row", async () => {
    const bare = { id: "zzbareidzz", status: "zzbarestatuszz" };
    const row = (await certifyConversions(adapterWith(spyHttp([{ conversions: [bare] }])))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    const seen = row.fieldPaths.map((f) => f.path);
    for (const absent of ["order_id", "click_id", "payout", "sale_amount", "p1"]) {
      assert.ok(!seen.includes(absent), absent);
    }
    assert.ok(!JSON.stringify(row).includes("zzbareidzz"));
  });
});

describe("the conversions outcome vocabulary", () => {
  it("reports OK with a structural field dictionary", async () => {
    const row = (await certifyConversions(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
    const row = (await certifyConversions(adapterWith(spyHttp()))).results[0];
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

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for an empty window", async () => {
    for (const empty of [{ conversions: [] }, { data: { conversions: [] } }, {}]) {
      const row = (await certifyConversions(adapterWith(spyHttp([empty])))).results[0];
      assert.equal(row.ok, true, JSON.stringify(empty));
      assert.equal(row.statusCategory, "OK_NO_ROWS", JSON.stringify(empty));
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA", JSON.stringify(empty));
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
      assert.deepEqual(row.fieldPaths, []);
      assert.equal(row.windowPreset, "7d");
    }
  });

  it("infers no joined, account or tracking state from zero rows", async () => {
    const serialised = JSON.stringify(await certifyConversions(adapterWith(spyHttp([{ conversions: [] }]))));
    for (const invented of [
      "NOT_SUPPORTED",
      "UNSUPPORTED",
      "accountStateBlocker",
      "NO_JOINED_CAMPAIGNS",
      "NEEDS_ACTIVE_PARTNERSHIP",
      "relationshipState",
      "JOINED",
      "NO_TRAFFIC",
      "TRACKING_BROKEN",
    ]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("preserves an auth rejection safely", async () => {
    const error = new Error("zzupstreamauthmessagezz");
    error.response = { status: 401, data: { message: "zzupstreambodyzz" } };
    const row = (await certifyConversions(adapterWith(spyHttp([error])))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.equal(row.supplierStatusCode, 401);
    assert.equal(row.windowPreset, "7d");
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(API_KEY));
    assert.ok(!serialised.includes("zzupstreambodyzz"), "no supplier response body");
  });

  it("preserves a supplier validation failure safely", async () => {
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: { errors: ["zzvalidationdetailzz"] } };
    const row = (await certifyConversions(adapterWith(spyHttp([error])))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
    assert.ok(!JSON.stringify(row).includes("zzvalidationdetailzz"));
  });

  it("classifies an upstream error and a not-found without retrying", async () => {
    for (const [status, category] of [[502, "UPSTREAM_ERROR"], [404, "NOT_FOUND"]]) {
      const error = new Error("zzupstreamzz");
      error.response = { status, data: {} };
      const spy = spyHttp([error]);
      const row = (await certifyConversions(adapterWith(spy))).results[0];
      assert.equal(row.statusCategory, category);
      assert.equal(spy.calls.length, 1);
    }
  });
});

describe("nothing transactional can leak", () => {
  it("never returns a conversion, order, transaction or click id", async () => {
    const serialised = JSON.stringify(await certifyConversions(adapterWith(spyHttp())));
    for (const secret of ["zzconversionidzz", "zzconversionfieldidzz", "zzorderidzz", "zztransactionidzz", "zzclickidzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns campaign or advertiser identity", async () => {
    const serialised = JSON.stringify(await certifyConversions(adapterWith(spyHttp())));
    for (const secret of ["zzcampaignidzz", "zzcampaignnamezz", "zzadvertiseridzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns a payout, commission, sale or order value", async () => {
    const serialised = JSON.stringify(await certifyConversions(adapterWith(spyHttp())));
    for (const secret of ["1234.56", "987.65", "4321.09", "8765.43", "zzcurrencyzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns a sub-id value", async () => {
    const serialised = JSON.stringify(await certifyConversions(adapterWith(spyHttp())));
    for (const secret of ["zzpublisheronezz", "zzpublishertwozz", "zzpublisherthreezz", "zzpublisherfourzz", "zzpublisherfivezz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns customer data, URLs, status or timestamps", async () => {
    const serialised = JSON.stringify(await certifyConversions(adapterWith(spyHttp())));
    for (const secret of [
      "zzcustomer@example.test",
      "203.0.113.77",
      "zzrefererzz",
      "https://",
      "zzconversionstatuszz",
      "2031-04-05",
      "2031-04-06",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the API key or the raw row, on success or on failure", async () => {
    const ok = JSON.stringify(await certifyConversions(adapterWith(spyHttp())));
    const error = new Error(`zzfailurezz ${API_KEY}`);
    error.response = { status: 500, data: { conversions: [CONVERSION] } };
    const failed = JSON.stringify(await certifyConversions(adapterWith(spyHttp([error]))));
    for (const serialised of [ok, failed]) {
      for (const secret of [API_KEY, "X-Api-Key", 'conversions":[{', "zzconversionidzz"]) {
        assert.ok(!serialised.includes(secret), secret);
      }
    }
  });

  it("returns only the safe result keys", async () => {
    const row = (await certifyConversions(adapterWith(spyHttp()))).results[0];
    for (const forbidden of ["rows", "conversions", "body", "raw", "data", "sample", "headers", "window", "params"]) {
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
      "windowPreset",
    ]) {
      assert.ok(Object.hasOwn(row, expected), expected);
    }
  });
});

describe("read-only, and the other probes unchanged", () => {
  it("performs no database read or write", async () => {
    assert.equal((await certifyConversions(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain", () => {
    const chain = chainSource();
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany", "rawPayload", "Conversion."]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("adds no report, finance or relationship path", () => {
    const chain = chainSource();
    for (const forbidden of ["fetchReports", "fetchPerformance", "relationshipState", "SupplierCommissionRule", "Payment", "Invoice"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
    for (const notYet of ["tracking", "finance", "reports"]) {
      assert.ok(!listProbeSourceObjects("trackier").includes(notYet), notYet);
    }
  });

  it("leaves the profile, campaigns, campaign_detail, coupons and deals probes unchanged", async () => {
    const profileSpy = spyHttp([{ profile: { id: "zzprofileidzz" } }]);
    const profile = (
      await serviceWith(adapterWith(profileSpy)).certify("trackier", { sourceObjects: ["profile"] })
    ).results[0];
    assert.equal(profileSpy.calls[0].path, "/v2/publishers/profile");
    assert.equal(profileSpy.calls.length, 1);
    assert.equal(profile.statusCategory, "OK");
    assert.ok(!Object.hasOwn(profile, "windowPreset"));

    const listSpy = spyHttp([{ campaigns: [{ id: "zzcampaignzz" }] }]);
    const list = (
      await serviceWith(adapterWith(listSpy)).certify("trackier", { sourceObjects: ["campaigns"] })
    ).results[0];
    assert.equal(listSpy.calls[0].path, TRACKIER_CAMPAIGNS_PATH);
    assert.deepEqual(listSpy.calls[0].config.params, { limit: 1, page: 1 });
    assert.equal(listSpy.calls.length, 1);
    assert.equal(list.endpointKey, "GET /v2/publisher/campaigns (limit=1, page=1)");

    const detailSpy = spyHttp([{ campaigns: [{ id: "zzdiscoveredzz" }] }, { data: { id: "zzdiscoveredzz" } }]);
    const detail = (
      await serviceWith(adapterWith(detailSpy)).certify("trackier", { sourceObjects: ["campaign_detail"] })
    ).results[0];
    assert.equal(detailSpy.calls.length, 2);
    assert.equal(detailSpy.calls[1].path, "/v2/publisher/campaign/zzdiscoveredzz");
    assert.equal(detail.statusCategory, "OK");

    const couponSpy = spyHttp([{ coupons: [{ id: "zzcouponzz", code: "zzcouponcodezz" }], nextPageToken: "zztokzz" }]);
    const coupons = (
      await serviceWith(adapterWith(couponSpy)).certify("trackier", { sourceObjects: ["coupons"] })
    ).results[0];
    assert.equal(couponSpy.calls[0].path, "/v2/publishers/coupons");
    assert.equal(couponSpy.calls.length, 1);
    assert.deepEqual(couponSpy.calls[0].config.params, {});
    assert.equal(coupons.statusCategory, "OK");

    const dealSpy = spyHttp([{ deals: [{ id: "zzdealzz", title: "zzdealtitlezz" }], nextPageToken: "zztokzz" }]);
    const deals = (
      await serviceWith(adapterWith(dealSpy)).certify("trackier", { sourceObjects: ["deals"] })
    ).results[0];
    assert.equal(dealSpy.calls[0].path, "/v2/publishers/deals");
    assert.equal(dealSpy.calls.length, 1);
    assert.deepEqual(dealSpy.calls[0].config.params, {});
    assert.equal(deals.statusCategory, "OK");
  });

  it("runs the whole Trackier set with one conversions request among them", async () => {
    const spy = spyHttp([
      { profile: { id: "zzprofileidzz" } },
      { campaigns: [{ id: "zzdiscoveredzz" }] },
      { campaigns: [{ id: "zzdiscoveredzz" }] },
      { data: { id: "zzdiscoveredzz" } },
      { coupons: [{ id: "zzcouponzz" }] },
      { deals: [{ id: "zzdealzz" }] },
      moreToCome([CONVERSION]),
      { allowedKpi: [{ name: "zzkpinamezz" }] },
    ]);
    const out = await serviceWith(adapterWith(spy)).certify("trackier");
    assert.deepEqual(
      out.results.map((r) => r.sourceObject),
      ["profile", "campaigns", "campaign_detail", "coupons", "deals", "conversions", "reports_kpi"],
    );
    const conversionCalls = spy.calls.filter((c) => c.path === TRACKIER_CONVERSIONS_PATH);
    assert.equal(conversionCalls.length, 1);
    assert.equal(spy.calls.length, 8);
    assert.ok(out.results.every((r) => r.ok), JSON.stringify(out.results.map((r) => r.statusCategory)));
    const conversions = out.results.find((r) => r.sourceObject === "conversions");
    assert.equal(conversions.windowPreset, "7d");
    for (const other of out.results.filter((r) => r.sourceObject !== "conversions")) {
      assert.ok(!Object.hasOwn(other, "windowPreset"), other.sourceObject);
    }
  });
});

// Last on purpose: production's shared report limiter cools down for a minute after a 429, and
// that behaviour is kept (a bounded probe must not defeat the supplier's back-off). Anything that
// ran after this would wait for it.
describe("a rate limit is reported once, and not retried", () => {
  it("classifies 429 as RATE_LIMITED after exactly one request", async () => {
    const error = new Error("zzratelimitzz");
    error.response = { status: 429, data: {}, headers: { "retry-after": "1" } };
    const spy = spyHttp([error]);
    const row = (await certifyConversions(adapterWith(spy))).results[0];
    assert.equal(spy.calls.length, 1);
    assert.equal(row.statusCategory, "RATE_LIMITED");
    assert.equal(row.supplierStatusCode, 429);
    assert.equal(row.windowPreset, "7d");
  });
});
