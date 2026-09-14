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
  createAdmitadAdapter,
  extractAdmitadCollection,
  admitadActionDateParam,
  buildAdmitadActionParams,
  ADMITAD_CERTIFICATION_MAX_ROWS,
  ADMITAD_CERTIFICATION_SPECS,
} = await import("../src/adapters/admitad.adapter.js");
const {
  NetworkCertificationService,
  listProbeSourceObjects,
  WINDOW_PRESETS,
  DEFAULT_WINDOW_PRESET,
} = await import("../src/modules/ops/networkCertification.service.js");
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/admitad.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/admitadSupplierSync.js", "utf8");

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const TOKEN = "zzadmitadtokenzz";

/**
 * One action row inside the real envelope shape.
 *
 * Every value is distinctive so a leak is detectable, and the row deliberately carries every shape
 * this probe must NOT emit: action and order ids, all four subids, monetary and commission values,
 * a currency, a click URL and customer-ish fields.
 */
const ACTION_PAYLOAD = {
  results: [
    {
      action_id: 987654321,
      id: 987654321,
      order_id: "ZZORDERIDZZ",
      advcampaign_id: 778899,
      advcampaign_name: "zzprogramnamezz",
      website_id: 991122,
      status: "approved",
      processed: true,
      paid: 1,
      payment: "12.3400",
      cart: "150.0000",
      currency: "AED",
      comment: "zzcustomercommentzz",
      subid: "zzsubidzz",
      subid1: "zzsubidonezz",
      subid2: "zzsubidtwozz",
      subid3: "zzsubidthreezz",
      subid4: "zzsubidfourzz",
      click_url: "https://ad.admitad.com/g/zzclickzz/",
      datetime: "2026-09-10T11:22:33",
      action_date: "2026-09-10T11:22:33",
      closing_date: "2026-10-10",
      keyword: "zzkeywordzz",
      action_type: "sale",
    },
  ],
  _meta: { count: 1, limit: 1, offset: 0 },
};

const EMPTY_PAYLOAD = { results: [], _meta: { count: 0, limit: 1, offset: 0 } };

const WINDOW = { from: "2026-09-07", to: "2026-09-14", preset: "7d" };

/**
 * Reads back Admitad's DD.MM.YYYY HH:mm:ss so a test can measure the span actually requested.
 * Date.parse cannot read this format — which is precisely why the ISO serializer was wrong.
 */
function parseAdmitadParam(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value));
  assert.ok(match, `not Admitad's documented format: ${value}`);
  const [, d, mo, y, h, mi, sec] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, sec);
}

function windowDays(params) {
  return (
    (parseAdmitadParam(params.status_updated_end) -
      parseAdmitadParam(params.status_updated_start)) /
    86400000
  );
}

function spyHttp(dataOrError = ACTION_PAYLOAD) {
  const calls = [];
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, config });
        if (dataOrError instanceof Error) throw dataOrError;
        return { data: dataOrError };
      },
    },
  };
}

function adapterWith(spy) {
  return createAdmitadAdapter({ accessToken: TOKEN, httpClient: spy.client });
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
    admitadCredentialResolver: async () => ({ accessToken: TOKEN }),
  });
}

async function certifyActions(adapter, certifyOptions = {}) {
  return serviceWith(adapter).certify("admitad", {
    sourceObjects: ["actions"],
    ...certifyOptions,
  });
}

describe("actions is registered as an Admitad source object", () => {
  it("completes the Admitad probe set", () => {
    assert.deepEqual(listProbeSourceObjects("admitad").sort(), [
      "actions",
      "coupons",
      "programs",
      "websites",
    ]);
  });

  it("declares a read-only GET", () => {
    assert.match(codeOf(SERVICE_SRC), /actions: \{\s*method: "GET",/);
    assert.equal(ADMITAD_CERTIFICATION_SPECS.actions.method, "GET");
  });

  it("names the endpoint and its bounds in the endpointKey", async () => {
    const row = (await certifyActions(adapterWith(spyHttp()))).results[0];
    assert.equal(
      row.endpointKey,
      "GET /statistics/actions/ (status_updated window, limit=1, offset=0)",
    );
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "actions");
  });

  it("is catalogued live and stays that way", () => {
    assert.equal(getSourceObject("admitad", "actions")?.live, true);
    assert.equal(getSourceObject("admitad", "actions")?.endpoint, "GET /statistics/actions/");
  });

  it("routes through the one shared bounded chain", () => {
    const code = codeOf(SERVICE_SRC);
    assert.equal(
      (code.match(/chain: "admitadSample"/g) ?? []).length,
      listProbeSourceObjects("admitad").length,
    );
    assert.equal((code.match(/async certifyAdmitadSample\(/g) ?? []).length, 1);
  });
});

describe("the actions request is production's own contract", () => {
  it("uses the production /statistics/actions/ path", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW });
    assert.equal(spy.calls[0].path, "/statistics/actions/");
    assert.equal(ADMITAD_CERTIFICATION_SPECS.actions.path, "/statistics/actions/");
  });

  it("matches the path production's fetchConversions builds", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchConversions")[1]
      .split("async fetchPerformance")[0];
    assert.match(production, /fetchOffsetPaginated\("\/statistics\/actions\/"/);
  });

  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW });
    assert.equal(spy.calls.length, 1);
  });

  it("sends the status_updated pair production sends, and order_by=datetime", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW });
    assert.deepEqual(spy.calls[0].config.params, {
      limit: 1,
      offset: 0,
      status_updated_start: "07.09.2026 00:00:00",
      status_updated_end: "14.09.2026 00:00:00",
      order_by: "datetime",
    });
  });

  it("builds its parameters with production's own builder", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW });
    const { limit, offset, ...dated } = spy.calls[0].config.params;
    assert.equal(limit, 1);
    assert.equal(offset, 0);
    // buildAdmitadActionParams is what fetchConversions runs: same allowlist, same order_by
    // default. Certification does not reimplement it.
    assert.deepEqual(
      dated,
      buildAdmitadActionParams({
        status_updated_start: admitadActionDateParam(WINDOW.from),
        status_updated_end: admitadActionDateParam(WINDOW.to),
      }),
    );
  });

  it("serializes dates exactly as the production sync job does", () => {
    // The sync job now imports this same function rather than keeping a private copy.
    assert.match(codeOf(SYNC_SRC), /admitadActionDateParam/);
    assert.ok(!codeOf(SYNC_SRC).includes("function isoSecond"));
    assert.match(codeOf(SYNC_SRC), /status_updated_start: admitadActionDateParam\(start\)/);
    assert.match(codeOf(SYNC_SRC), /status_updated_end: admitadActionDateParam\(end\)/);
  });

  it("emits Admitad's documented %d.%m.%Y %H:%M:%S, not ISO 8601", () => {
    assert.equal(admitadActionDateParam("2026-09-14T15:46:59.116Z"), "14.09.2026 15:46:59");
    // The example from Admitad's own Publisher Reports documentation.
    assert.equal(admitadActionDateParam("2012-05-01T21:12:01Z"), "01.05.2012 21:12:01");
  });

  it("accepts a Date object and an ISO datetime string alike", () => {
    assert.equal(
      admitadActionDateParam(new Date("2026-09-14T15:46:59.116Z")),
      admitadActionDateParam("2026-09-14T15:46:59.116Z"),
    );
    assert.equal(admitadActionDateParam(new Date(Date.UTC(2026, 8, 14, 15, 46, 59))), "14.09.2026 15:46:59");
  });

  it("zero-pads every component to its documented width", () => {
    assert.equal(admitadActionDateParam("2026-01-02T03:04:05Z"), "02.01.2026 03:04:05");
    assert.equal(admitadActionDateParam("2026-12-31T23:59:59Z"), "31.12.2026 23:59:59");
    // A date-only input is midnight UTC, and midnight is padded rather than collapsed.
    assert.equal(admitadActionDateParam("2026-09-07"), "07.09.2026 00:00:00");
  });

  it("serializes in UTC even when the runtime's local timezone is not UTC", () => {
    // The CI runner happens to be UTC, which makes the local-time getters indistinguishable from
    // the UTC ones. Switching TZ is what actually separates them: under Kiritimati (UTC+14) this
    // instant is already the NEXT DAY locally, so a local-time serializer reports 15.09 and an
    // hour that is off by fourteen.
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati";
      assert.equal(
        admitadActionDateParam(new Date(Date.UTC(2026, 8, 14, 15, 46, 59))),
        "14.09.2026 15:46:59",
      );
      process.env.TZ = "Asia/Kolkata";
      assert.equal(admitadActionDateParam("2026-09-14T15:46:59Z"), "14.09.2026 15:46:59");
      process.env.TZ = "America/Los_Angeles";
      assert.equal(admitadActionDateParam("2026-01-01T02:30:00Z"), "01.01.2026 02:30:00");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("reads its components in UTC, not in the runtime's local timezone", () => {
    const instant = "2026-03-01T00:30:00Z";
    assert.equal(admitadActionDateParam(instant), "01.03.2026 00:30:00");
    // Same instant, written with an offset: the serialized UTC form must be identical.
    assert.equal(admitadActionDateParam("2026-02-28T19:30:00-05:00"), "01.03.2026 00:30:00");
    assert.equal(admitadActionDateParam("2026-03-01T04:30:00+04:00"), "01.03.2026 00:30:00");
  });

  it("carries no millisecond, T or Z anywhere in its output", () => {
    for (const input of [
      "2026-09-14T15:46:59.116Z",
      new Date("2026-01-02T03:04:05.999Z"),
      "2026-09-07",
    ]) {
      const out = admitadActionDateParam(input);
      assert.match(out, /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/, String(input));
      assert.ok(!out.includes("T"), String(input));
      assert.ok(!out.includes("Z"), String(input));
      // The strict whole-string match above already forbids a fractional-seconds group; these
      // pin it explicitly. Dots here are the date separators, so a bare /\.\d+/ would be wrong.
      assert.equal(out.length, 19, String(input));
      assert.match(out, /:\d{2}$/, `seconds must be exactly two digits: ${input}`);
      assert.ok(!out.includes("-"), String(input));
    }
  });

  it("returns null for an invalid date rather than a malformed parameter", () => {
    for (const bad of ["not-a-date", "", "31.31.2026", undefined, null, {}]) {
      assert.equal(admitadActionDateParam(bad), null, String(bad));
    }
  });

  it("serializes the request parameters production actually sends", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW });
    for (const key of ["status_updated_start", "status_updated_end"]) {
      const value = spy.calls[0].config.params[key];
      assert.match(value, /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/, key);
    }
  });

  it("sends no campaign, programme, action or subid filter", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW });
    for (const forbidden of [
      "campaign",
      "advcampaign",
      "action_id",
      "subid",
      "website",
      "status",
      "processed",
      "paid",
    ]) {
      assert.ok(!Object.hasOwn(spy.calls[0].config.params, forbidden), forbidden);
    }
  });

  it("applies the certification timeout", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW, timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("does not paginate even when the envelope reports far more rows", async () => {
    const spy = spyHttp({
      results: ACTION_PAYLOAD.results,
      _meta: { count: 9999, limit: 1, offset: 0 },
    });
    await adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW });
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() =>
      adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW }),
    );
    assert.equal(spy.calls.length, 1);
  });

  it("makes exactly one request for a full actions run", async () => {
    const spy = spyHttp();
    await certifyActions(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("makes one request per object when all four are certified together", async () => {
    const spy = spyHttp();
    const result = await serviceWith(adapterWith(spy)).certify("admitad", {
      sourceObjects: ["websites", "programs", "coupons", "actions"],
    });
    assert.equal(spy.calls.length, 4);
    assert.deepEqual(spy.calls.map((c) => c.path).sort(), [
      "/advcampaigns/",
      "/coupons/",
      "/statistics/actions/",
      "/websites/v2/",
    ]);
    assert.equal(result.results.length, 4);
  });
});

describe("the window is the service's, and it is required", () => {
  it("defaults to the existing 7d preset", async () => {
    const spy = spyHttp();
    await certifyActions(adapterWith(spy));
    assert.equal(DEFAULT_WINDOW_PRESET, "7d");
    assert.equal(WINDOW_PRESETS["7d"], 7);

    assert.equal(windowDays(spy.calls[0].config.params), 7);
  });

  it("honours a wider preset when one is selected", async () => {
    const spy = spyHttp();
    await certifyActions(adapterWith(spy), { windowPreset: "30d" });
    assert.equal(windowDays(spy.calls[0].config.params), 30);
  });

  it("falls back to the default rather than honouring an arbitrary preset", async () => {
    const spy = spyHttp();
    await certifyActions(adapterWith(spy), { windowPreset: "9999d" });
    assert.equal(windowDays(spy.calls[0].config.params), 7);
  });

  it("accepts no caller-supplied dates", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyAdmitadSample")[1]
      .split("async certifyAwinCommissionGroups")[0];
    for (const leak of ["req.body", "req.query", "options.from", "params.from", "ctx.from"]) {
      assert.ok(!chain.includes(leak), leak);
    }
    assert.match(codeOf(SERVICE_SRC), /window: \{ \.\.\.ctx\.window, preset: resolvedWindowPreset \}/);
  });

  it("refuses to build the request with no window at all", async () => {
    const spy = spyHttp();
    await assert.rejects(
      () => adapterWith(spy).fetchCertificationSample("actions", {}),
      (error) => /requires window/.test(error.message),
    );
    assert.equal(spy.calls.length, 0);
  });

  it("refuses to build the request with a half-open window", async () => {
    for (const partial of [{ from: "2026-09-07" }, { to: "2026-09-14" }, {}]) {
      const spy = spyHttp();
      await assert.rejects(
        () => adapterWith(spy).fetchCertificationSample("actions", { window: partial }),
        (error) => /requires/.test(error.message),
        JSON.stringify(partial),
      );
      assert.equal(spy.calls.length, 0, JSON.stringify(partial));
    }
  });

  it("leaves the undated objects unaffected by the window", async () => {
    const spy = spyHttp({ results: [{ id: 1 }], _meta: { count: 1 } });
    for (const undated of ["websites", "programs", "coupons"]) {
      spy.calls.length = 0;
      await adapterWith(spy).fetchCertificationSample(undated, { window: WINDOW });
      assert.deepEqual(spy.calls[0].config.params, { limit: 1, offset: 0 }, undated);
    }
  });

  it("declares the window need on actions and on nothing else", () => {
    assert.deepEqual(ADMITAD_CERTIFICATION_SPECS.actions.needs, ["window"]);
    for (const undated of ["websites", "programs", "coupons"]) {
      assert.equal(ADMITAD_CERTIFICATION_SPECS[undated].needs, undefined, undated);
    }
  });
});

describe("the sample is bounded to one action row, twice and independently", () => {
  it("slices in the adapter even when the supplier ignores limit=1", async () => {
    const many = { results: [...Array(60)].map((_, i) => ({ action_id: i })) };
    const spy = spyHttp(many);
    const rows = await adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW });
    assert.equal(rows.length, 1);
    assert.equal(ADMITAD_CERTIFICATION_MAX_ROWS, 1);
  });

  it("slices again in the service when an adapter hands back more than one row", async () => {
    const result = await certifyActions({
      fetchCertificationSample: async () => [{ action_id: 1 }, { action_id: 2 }],
    });
    assert.equal(result.results[0].sampleCount, 1);
  });

  it("parses rows with production's own collection extractor", async () => {
    const spy = spyHttp();
    const rows = await adapterWith(spy).fetchCertificationSample("actions", { window: WINDOW });
    assert.deepEqual(rows, extractAdmitadCollection(ACTION_PAYLOAD).slice(0, 1));
  });

  it("certifies a row and never the {results, _meta} envelope", async () => {
    const paths = (await certifyActions(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(!paths.some((p) => String(p).startsWith("results")));
    assert.ok(!paths.some((p) => String(p).startsWith("_meta")));
    assert.ok(paths.includes("action_id"));
  });
});

describe("the actions outcome vocabulary", () => {
  it("reports OK with a field dictionary when one row comes back", async () => {
    const row = (await certifyActions(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.equal(row.schema, undefined);
  });

  it("reports OK_NO_ROWS with an unknown schema when the window returns nothing", async () => {
    const row = (await certifyActions(adapterWith(spyHttp(EMPTY_PAYLOAD)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("does NOT classify an empty window as unsupported", async () => {
    // An account with no joined programmes has no actions. The endpoint answered; it is live.
    const result = await certifyActions(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    const serialised = JSON.stringify(result);
    for (const wrong of [
      "NOT_SUPPORTED",
      "UNAVAILABLE",
      "NO_ENDPOINT",
      "UNKNOWN_NEEDS_JOINED_CAMPAIGN",
      "NO_JOINED_CAMPAIGNS",
      "BLOCKED_BY_ACCOUNT_STATE",
    ]) {
      assert.ok(!serialised.includes(wrong), wrong);
    }
    assert.equal(result.results[0].accountStateBlocker, undefined);
  });

  it("carries no supplier status code on a successful empty result", async () => {
    const result = await certifyActions(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    assert.equal(result.results[0].supplierStatusCode, undefined);
  });

  it("reports a supplier failure as a failure, not as an empty window", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 401 } });
    const row = (await certifyActions(adapterWith(spyHttp(boom)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.notEqual(row.statusCategory, "OK_NO_ROWS");
  });

  it("reaches the same verdicts as the undated objects for the same responses", async () => {
    for (const [payload, expected] of [
      [ACTION_PAYLOAD, "OK"],
      [EMPTY_PAYLOAD, "OK_NO_ROWS"],
    ]) {
      const all = await serviceWith(adapterWith(spyHttp(payload))).certify("admitad", {
        sourceObjects: ["websites", "programs", "coupons", "actions"],
      });
      for (const row of all.results) {
        assert.equal(row.statusCategory, expected, `${row.sourceObject} ${expected}`);
        assert.equal(row.accountStateBlocker, undefined, row.sourceObject);
      }
    }
  });
});

describe("no action value reaches the result", () => {
  it("returns no ids, order ids, subids, money, commission, URLs or customer data", async () => {
    const result = await certifyActions(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const secret of [
      "987654321",
      "ZZORDERIDZZ",
      "778899",
      "991122",
      "zzprogramnamezz",
      "zzsubidzz",
      "zzsubidonezz",
      "zzsubidtwozz",
      "zzsubidthreezz",
      "zzsubidfourzz",
      "zzclickzz",
      "zzcustomercommentzz",
      "zzkeywordzz",
      "12.3400",
      "150.0000",
      "AED",
      "2026-09-10",
      "2026-10-10",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("reports the money, subid and order-id field PATHS without their values", async () => {
    const result = await certifyActions(adapterWith(spyHttp()));
    const paths = result.results[0].fieldPaths.map((f) => f.path);
    for (const expected of [
      "action_id",
      "order_id",
      "payment",
      "cart",
      "currency",
      "subid",
      "subid4",
      "click_url",
      "status",
      "processed",
      "paid",
    ]) {
      assert.ok(paths.includes(expected), expected);
    }
    assert.ok(!JSON.stringify(result.results[0].fieldPaths).includes("12.3400"));
    assert.ok(!JSON.stringify(result.results[0].fieldPaths).includes("ZZORDERIDZZ"));
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
    const allowed = new Set([
      "ARRAY",
      "BOOLEAN",
      "CURRENCY_CODE",
      "ID_LIKE",
      "ISO_DATE",
      "MIXED",
      "NULL",
      "NUMBER",
      "OBJECT",
      "REDACTED",
      "STRING",
      "URL",
    ]);
    const fields = (await certifyActions(adapterWith(spyHttp()))).results[0].fieldPaths;
    assert.ok(fields.length > 0);
    for (const field of fields) {
      assert.ok(allowed.has(field.observedType), JSON.stringify(field));
      assert.ok(allowed.has(field.exampleCategory), JSON.stringify(field));
      assert.deepEqual(
        Object.keys(field).sort(),
        [
          "arrayObserved",
          "exampleCategory",
          "nullableObserved",
          "objectObserved",
          "observedType",
          "path",
          "presentCount",
          "sampleCount",
        ],
        JSON.stringify(field),
      );
    }
  });

  it("never returns the window dates it queried", async () => {
    const result = await certifyActions(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    assert.ok(!/status_updated_start/.test(serialised));
    assert.ok(!/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}/.test(serialised));
  });

  it("never returns the raw payload", async () => {
    const row = (await certifyActions(adapterWith(spyHttp()))).results[0];
    for (const key of ["raw", "payload", "rows", "sample", "results"]) {
      assert.equal(row[key], undefined, key);
    }
  });

  it("never returns the access token", async () => {
    const boom = Object.assign(new Error(`rejected ${TOKEN}`), {
      response: { status: 403, data: { error: `bad token ${TOKEN}` } },
    });
    const result = await certifyActions(adapterWith(spyHttp(boom)));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
});

describe("nothing here maps commission, payments or tracking", () => {
  it("adds no canonical commission mapping for Admitad", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyAdmitadSample")[1]
      .split("async certifyAwinCommissionGroups")[0];
    const adapterCode = codeOf(ADAPTER_SRC);
    for (const mapping of ["SupplierCommissionRule", "commissionRate", "commission"]) {
      assert.ok(!chain.includes(mapping), `chain: ${mapping}`);
      assert.ok(!adapterCode.includes(mapping), `adapter: ${mapping}`);
    }
  });

  it("leaves status, processed and paid as separate source facts", () => {
    // normalizeAdmitadActionEvidence is production's, and it still collapses nothing.
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /networkRawStatus: input\.status \?\? null/);
    assert.match(code, /networkProcessed: input\.processed \?\? null/);
    assert.match(code, /networkPaid: input\.paid \?\? null/);
  });

  it("adds no payments, invoices or product-feed path", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const absent of ["fetchPayments", "fetchInvoices", "fetchProducts", "product_feed"]) {
      assert.ok(!code.includes(absent), absent);
    }
  });

  it("changes no tracking-link or deeplink behaviour", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.ok(!code.includes("buildDeepLink"));
    assert.ok(!code.includes("fetchDeepLink"));
    assert.ok(!code.includes("trackingUrl"));
    assert.ok(!code.includes("SUPPLIER_CAPABILITIES.DEEP_LINK"));
  });
});

describe("certification stays read-only and changes no sync behaviour", () => {
  it("performs no database read or write for an actions run", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    const row = (await certifyActions(adapterWith(spyHttp()))).results[0];
    assert.equal(row.statusCategory, "OK");
  });

  it("writes nothing and triggers no sync", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyAdmitadSample")[1]
      .split("async certifyAwinCommissionGroups")[0];
    for (const write of ["upsert", "create", "update", "delete", "upsertManyRawEntities"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("leaves the production conversions fetcher paginating and normalising", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchConversions")[1]
      .split("async fetchPerformance")[0];
    assert.ok(production.includes("fetchOffsetPaginated"));
    assert.ok(production.includes("buildAdmitadActionParams"));
    assert.ok(production.includes("normalizeAdmitadActionEvidence"));
  });

  it("leaves the sync job's incremental window logic intact", () => {
    const code = codeOf(SYNC_SRC);
    assert.match(code, /sourceObject: "actions"/);
    assert.match(code, /adapter\.fetchConversions\(actionParams, stats\)/);
    assert.match(code, /buildAdmitadIncrementalActionParams/);
    assert.match(code, /overlapDays/);
  });
});
