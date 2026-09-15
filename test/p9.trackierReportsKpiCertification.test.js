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
  TRACKIER_REPORTS_KPI_PATH,
  TRACKIER_KPI_CONTAINER_KEYS,
  TRACKIER_CONVERSIONS_PATH,
  locateTrackierKpiContainer,
} = await import("../src/adapters/trackier.adapter.js");
const { NetworkCertificationService, listProbeSourceObjects, KPI_MAP_KEY_PLACEHOLDER } = await import(
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

/** One KPI DEFINITION object. Field names plausible, every value a distinctive marker. */
const DEFINITION = {
  key: "zzkpikeyzz",
  name: "zzkpinamezz",
  label: "zzkpilabelzz",
  type: "zzkpitypezz",
  group: "zzkpigroupzz",
  default: true,
  order: 7,
  format: "zzkpiformatzz",
  currency: "zzkpicurrencyzz",
  publisher_id: "zzpublisheridzz",
};

const SECOND_DEFINITION = { key: "zzsecondkeyzz", name: "zzsecondnamezz", extra: "zzsecondextrazz" };

/** The same metadata as a flat list of names. */
const NAME_LIST = ["zzkpinamezz", "zzsecondnamezz", "zzthirdnamezz"];

/** The same metadata as an object map keyed by KPI name. */
const NAME_MAP = {
  zzkpinamezz: { label: "zzkpilabelzz", type: "zzkpitypezz" },
  zzsecondnamezz: { label: "zzsecondlabelzz" },
};

function spyHttp(pages = [{ allowedKpi: [DEFINITION] }]) {
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

async function certifyKpi(adapter) {
  return serviceWith(adapter).certify("trackier", { sourceObjects: ["reports_kpi"] });
}

async function rowFor(body) {
  return (await certifyKpi(adapterWith(spyHttp([body])))).results[0];
}

function chainSource() {
  return codeOf(SERVICE_SRC).split("async certifyTrackierReportsKpi")[1].split("\n  }")[0];
}

const ALL_MARKERS = [
  "zzkpikeyzz",
  "zzkpinamezz",
  "zzkpilabelzz",
  "zzkpitypezz",
  "zzkpigroupzz",
  "zzkpiformatzz",
  "zzkpicurrencyzz",
  "zzpublisheridzz",
  "zzsecondkeyzz",
  "zzsecondnamezz",
  "zzsecondextrazz",
  "zzsecondlabelzz",
  "zzthirdnamezz",
];

describe("the documented reports-kpi request contract", () => {
  it("addresses exactly GET /v2/publishers/reports-kpi", async () => {
    assert.equal(TRACKIER_REPORTS_KPI_PATH, "/v2/publishers/reports-kpi");
    const spy = spyHttp();
    await certifyKpi(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/v2/publishers/reports-kpi");
  });

  it("is a GET, and the endpointKey says it takes no parameters", async () => {
    const row = (await certifyKpi(adapterWith(spyHttp()))).results[0];
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.endpointKey, "GET /v2/publishers/reports-kpi (no parameters)");
    assert.equal(row.sourceObject, "reports_kpi");
  });

  it("sends no parameter at all: no window, no page, no limit, no filter", async () => {
    const spy = spyHttp();
    await certifyKpi(adapterWith(spy));
    assert.ok(!Object.hasOwn(spy.calls[0].config, "params"));
    assert.ok(!spy.calls[0].path.includes("?"), "nothing in the query string either");
    const serialised = JSON.stringify(spy.calls[0].config);
    for (const invented of ["startDate", "endDate", "page", "limit", "pageToken", "kpi", "group", "window"]) {
      assert.ok(!serialised.includes(invented), invented);
    }
    assert.deepEqual(Object.keys(spy.calls[0].config), ["timeout"]);
  });

  it("is not a reports DATA request", async () => {
    const spy = spyHttp();
    await certifyKpi(adapterWith(spy));
    assert.ok(!spy.calls.some((c) => c.path === "/v2/publishers/reports"));
    assert.ok(!spy.calls.some((c) => c.path === TRACKIER_CONVERSIONS_PATH));
    assert.notEqual(TRACKIER_REPORTS_KPI_PATH, "/v2/publishers/reports");
  });

  it("reuses the X-Api-Key auth, with no second header scheme", async () => {
    const spy = spyHttp();
    await certifyKpi(adapterWith(spy));
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /"X-Api-Key": String\(apiKey\)/);
    assert.ok(!code.includes("Authorization"));
    assert.ok(!code.includes("Bearer"));
    assert.ok(!JSON.stringify(spy.calls[0].config).includes(API_KEY));
  });

  it("carries a bounded timeout", async () => {
    const spy = spyHttp();
    await certifyKpi(adapterWith(spy));
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
  });

  it("is catalogued as its own live metadata object, with no entity type", () => {
    const entry = getSourceObject("trackier", "reports_kpi");
    assert.ok(entry);
    assert.equal(entry.endpoint, "GET /v2/publishers/reports-kpi");
    assert.equal(entry.live, true);
    assert.ok(!entry.entityType, "metadata, not an entity MBO stores");
    assert.ok(listProbeSourceObjects("trackier").includes("reports_kpi"));
    // The sync job already reads it, as reportsKpi, through the same fetcher.
    assert.match(codeOf(SYNC_SRC), /"reportsKpi",\s*credentials,\s*\(\)\s*=>\s*adapter\.fetchReportsKpi\(\)/);
  });
});

describe("exactly one request, no retry, no pagination", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await certifyKpi(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not follow a page token or page hint, even though one is offered", async () => {
    const spy = spyHttp([
      { allowedKpi: [DEFINITION], nextPageToken: "zztokentwozz", pagination: { hasNext: true, total: 500 } },
      { allowedKpi: [SECOND_DEFINITION] },
    ]);
    await certifyKpi(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.ok(!JSON.stringify(spy.calls).includes("zztokentwozz"));
  });

  it("does not retry a failed request", async () => {
    const spy = spyHttp([new Error("zzsupplierfailurezz")]);
    await certifyKpi(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a retryable status either", async () => {
    for (const status of [500, 502, 503]) {
      const error = new Error("zzupstreamzz");
      error.response = { status, data: {} };
      const spy = spyHttp([error]);
      await certifyKpi(adapterWith(spy));
      assert.equal(spy.calls.length, 1, String(status));
    }
  });

  it("proves production really would have retried", async () => {
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp([error, { allowedKpi: [DEFINITION] }]);
    const kpis = await adapterWith(spy).fetchReportsKpi();
    assert.equal(spy.calls.length, 2);
    assert.equal(kpis.length, 1);
  });

  it("pins the bounds in the chain, and leaves production's defaults alone", () => {
    const chain = chainSource();
    assert.match(chain, /retries: 1/);
    assert.match(chain, /timeoutMs/);
    assert.match(chain, /preserveShape: true/);
    assert.ok(!chain.includes("singlePage"), "there is no pager to bound");
    assert.match(codeOf(ADAPTER_SRC), /retries: 6, delayMs: 2000/);
    assert.match(codeOf(ADAPTER_SRC), /preserveShape = false/);
  });

  it("routes through no pager in the adapter", () => {
    const fetcher = codeOf(ADAPTER_SRC).split("async fetchReportsKpi(")[1].split("\n    },")[0];
    for (const pager of ["fetchPageNumberPaginated", "fetchPageTokenPaginated", "fetchCampaignPages", "for (", "while ("]) {
      assert.ok(!fetcher.includes(pager), pager);
    }
    assert.match(fetcher, /requestWithRateLimit\(/);
    assert.match(fetcher, /trackierReportRateLimiter/);
  });
});

describe("the certification reuses production's fetcher, and adds no second one", () => {
  it("calls adapter.fetchReportsKpi and nothing else on the adapter", () => {
    const chain = chainSource();
    assert.match(chain, /adapter\.fetchReportsKpi\(/);
    for (const other of ["fetchReports(", "fetchConversions", "fetchCampaigns", "fetchCoupons", "fetchDeals", "fetchProfile", "httpClient", ".get("]) {
      assert.ok(!chain.includes(other), other);
    }
  });

  it("defines one fetchReportsKpi and one reports-kpi path in the adapter", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/async fetchReportsKpi\(/g) ?? []).length, 1);
    assert.equal((code.match(/"\/v2\/publishers\/reports-kpi"/g) ?? []).length, 1);
    assert.equal((code.match(/TRACKIER_REPORTS_KPI_PATH,/g) ?? []).length, 1);
  });

  it("creates no parallel client", () => {
    const code = codeOf(SERVICE_SRC);
    assert.match(code, /trackier: "buildTrackierAdapter"/);
    assert.equal((code.match(/createTrackierAdapter\(/g) ?? []).length, 0);
    assert.ok(!code.includes("axios.create"));
  });

  it("locates the container with the ONE lookup production uses, in production's key order", () => {
    assert.deepEqual([...TRACKIER_KPI_CONTAINER_KEYS], ["allowedKpi", "kpis", "kpi"]);
    assert.ok(Object.isFrozen(TRACKIER_KPI_CONTAINER_KEYS));
    const fetcher = codeOf(ADAPTER_SRC).split("async fetchReportsKpi(")[1].split("\n    },")[0];
    assert.match(fetcher, /locateTrackierKpiContainer\(payload\)/);
    assert.ok(!fetcher.includes("payload.allowedKpi"), "no second, inline lookup");
    // Precedence: allowedKpi over kpis over kpi.
    assert.deepEqual(locateTrackierKpiContainer({ kpi: ["c"], kpis: ["b"], allowedKpi: ["a"] }), {
      key: "allowedKpi",
      container: ["a"],
    });
    assert.deepEqual(locateTrackierKpiContainer({ kpi: ["c"], kpis: ["b"] }), { key: "kpis", container: ["b"] });
    assert.deepEqual(locateTrackierKpiContainer({ kpi: ["c"] }), { key: "kpi", container: ["c"] });
    assert.deepEqual(locateTrackierKpiContainer({ allowedKpi: null, kpis: ["b"] }), { key: "kpis", container: ["b"] });
    for (const none of [{}, [], null, undefined, "x", { other: [] }]) {
      assert.deepEqual(locateTrackierKpiContainer(none), { key: null, container: undefined }, JSON.stringify(none));
    }
  });

  it("leaves production's call shape unchanged: no config, retried, arrays only", async () => {
    for (const [body, expected] of [
      [{ allowedKpi: [DEFINITION] }, [DEFINITION]],
      [{ kpis: NAME_LIST }, NAME_LIST],
      [{ kpi: [DEFINITION] }, [DEFINITION]],
      [{ allowedKpi: NAME_MAP }, []],
      [{ allowedKpi: "zzkpinamezz" }, []],
      [{ data: { allowedKpi: [DEFINITION] } }, []],
      [{}, []],
    ]) {
      const spy = spyHttp([body]);
      const kpis = await adapterWith(spy).fetchReportsKpi();
      assert.deepEqual(kpis, expected, JSON.stringify(body).slice(0, 40));
      assert.equal(spy.calls[0].path, TRACKIER_REPORTS_KPI_PATH);
      assert.deepEqual(spy.calls[0].config, {}, "no timeout, no params");
      assert.equal(spy.calls.length, 1);
    }
  });
});

describe("the supplier shape is preserved, and nothing is invented", () => {
  it("an array of definitions: samples ONE and reports it under the supplier's own key", async () => {
    const row = await rowFor({ allowedKpi: [DEFINITION, SECOND_DEFINITION] });
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.schema, "KPI_DEFINITION_ARRAY");
    assert.equal(row.sampleCount, 1);
    const byPath = Object.fromEntries(row.fieldPaths.map((f) => [f.path, f]));
    assert.equal(byPath["allowedKpi"].observedType, "ARRAY");
    assert.equal(byPath["allowedKpi[]"].observedType, "OBJECT");
    for (const field of ["key", "name", "label", "type", "group", "default", "order", "format", "currency"]) {
      assert.ok(byPath[`allowedKpi[].${field}`], field);
    }
    assert.equal(byPath["allowedKpi[].default"].observedType, "BOOLEAN");
    assert.equal(byPath["allowedKpi[].order"].observedType, "NUMBER");
    // The second definition's fields are not walked.
    assert.ok(!byPath["allowedKpi[].extra"]);
    assert.equal(row.fieldCount, row.fieldPaths.length);
  });

  it("a flat list of names: preserved as an array of strings, no object fabricated", async () => {
    const row = await rowFor({ kpis: NAME_LIST });
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.schema, "KPI_VALUE_ARRAY");
    assert.equal(row.sampleCount, 1);
    assert.deepEqual(
      row.fieldPaths.map((f) => [f.path, f.observedType]),
      [
        ["kpis", "ARRAY"],
        ["kpis[]", "STRING"],
      ],
    );
    assert.ok(!row.fieldPaths.some((f) => f.path.includes("name") || f.path.includes("value")), "no invented object field");
  });

  it("a list of numbers is a value array too, not a definition array", async () => {
    const row = await rowFor({ kpis: [1, 2, 3] });
    assert.equal(row.schema, "KPI_VALUE_ARRAY");
    assert.deepEqual(
      row.fieldPaths.map((f) => [f.path, f.observedType]),
      [
        ["kpis", "ARRAY"],
        ["kpis[]", "NUMBER"],
      ],
    );
  });

  it("a null or nested-array first entry is not a definition object", async () => {
    const nulls = await rowFor({ kpis: [null, DEFINITION] });
    assert.equal(nulls.schema, "KPI_VALUE_ARRAY");
    assert.deepEqual(
      nulls.fieldPaths.map((f) => [f.path, f.observedType]),
      [
        ["kpis", "ARRAY"],
        ["kpis[]", "NULL"],
      ],
    );
    const nested = await rowFor({ kpis: [["zzkpinamezz"], DEFINITION] });
    assert.equal(nested.schema, "KPI_VALUE_ARRAY");
    assert.deepEqual(
      nested.fieldPaths.map((f) => [f.path, f.observedType]),
      [
        ["kpis", "ARRAY"],
        ["kpis[]", "ARRAY"],
        ["kpis[][]", "STRING"],
      ],
    );
  });

  it("an object map: one entry's structure under a placeholder, the KPI name itself withheld", async () => {
    assert.equal(KPI_MAP_KEY_PLACEHOLDER, "*");
    const row = await rowFor({ kpi: NAME_MAP });
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.schema, "KPI_OBJECT_MAP");
    assert.equal(row.sampleCount, 1);
    assert.deepEqual(
      row.fieldPaths.map((f) => [f.path, f.observedType]),
      [
        ["kpi", "OBJECT"],
        ["kpi.*", "OBJECT"],
        ["kpi.*.label", "STRING"],
        ["kpi.*.type", "STRING"],
      ],
    );
    assert.match(row.note, /production's fetcher reads as zero KPIs/);
  });

  it("a scalar: preserved as a scalar under the supplier's key", async () => {
    const row = await rowFor({ allowedKpi: "zzkpinamezz,zzsecondnamezz" });
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.schema, "KPI_SCALAR");
    assert.equal(row.sampleCount, 1);
    assert.deepEqual(
      row.fieldPaths.map((f) => [f.path, f.observedType]),
      [["allowedKpi", "STRING"]],
    );
    assert.match(row.note, /production's fetcher reads as zero KPIs/);
  });

  it("an envelope with none of the known keys: top-level paths only, and says production reads nothing", async () => {
    const row = await rowFor({ data: { allowedKpi: [DEFINITION] }, status: "zzsuccesszz", meta: { count: 1 }, allowedKpi: null });
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.schema, "KPI_CONTAINER_NOT_RECOGNISED");
    assert.equal(row.sampleCount, 1);
    assert.deepEqual(
      row.fieldPaths.map((f) => [f.path, f.observedType]),
      [
        ["allowedKpi", "NULL"],
        ["data", "OBJECT"],
        ["meta", "OBJECT"],
        ["status", "STRING"],
      ],
    );
    assert.ok(!row.fieldPaths.some((f) => f.path.includes(".")), "nothing below the top level is walked");
    assert.match(row.note, /production's fetcher would read zero KPIs/);
  });

  it("interprets no KPI name and maps none to a canonical metric", () => {
    const chain = chainSource();
    for (const forbidden of [
      "clicks",
      "conversions",
      "payout",
      "revenue",
      "impressions",
      "canonical",
      "metric",
      "normalise",
      "normalize",
      "toLowerCase",
      "includes(",
      "match(",
      "test(",
      "KPI_ALIASES",
      "mapKpi",
    ]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });

  it("builds no object around a string, and no name from a definition", () => {
    const chain = chainSource();
    for (const fabrication of ["{ name:", "{ value:", "{ kpi:", "String(", ".split(", ".join(", "JSON.parse"]) {
      assert.ok(!chain.includes(fabrication), fabrication);
    }
  });

  it("does not classify a non-array shape as invalid or unsupported", async () => {
    for (const body of [{ kpi: NAME_MAP }, { allowedKpi: "zzkpinamezz" }, { data: { allowedKpi: [] } }]) {
      const serialised = JSON.stringify(await rowFor(body));
      for (const claim of ["NOT_SUPPORTED", "UNSUPPORTED", "INVALID", "REQUEST_REJECTED", "accountStateBlocker"]) {
        assert.ok(!serialised.includes(claim), claim);
      }
    }
  });
});

describe("the reports-kpi outcome vocabulary", () => {
  it("describes each path structurally and carries no key that could hold a value", async () => {
    for (const body of [{ allowedKpi: [DEFINITION] }, { kpis: NAME_LIST }, { kpi: NAME_MAP }, { allowedKpi: "zzkpinamezz" }]) {
      const row = await rowFor(body);
      assert.ok(row.fieldPaths.length > 0);
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
        assert.equal(field.sampleCount, 1);
      }
    }
  });

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for every empty shape", async () => {
    for (const empty of [{ allowedKpi: [] }, { kpis: [] }, { kpi: {} }, { allowedKpi: "" }, {}, [], null, "", { allowedKpi: null }]) {
      const row = await rowFor(empty);
      assert.equal(row.ok, true, JSON.stringify(empty));
      assert.equal(row.statusCategory, "OK_NO_ROWS", JSON.stringify(empty));
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA", JSON.stringify(empty));
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
      assert.deepEqual(row.fieldPaths, []);
    }
  });

  it("infers no joined or account state from zero rows", async () => {
    const serialised = JSON.stringify(await rowFor({ allowedKpi: [] }));
    for (const invented of ["NOT_SUPPORTED", "UNSUPPORTED", "accountStateBlocker", "NO_JOINED_CAMPAIGNS", "relationshipState", "JOINED"]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("preserves an auth rejection safely", async () => {
    for (const status of [401, 403]) {
      const error = new Error("zzupstreamauthmessagezz");
      error.response = { status, data: { message: "zzupstreambodyzz" } };
      const row = (await certifyKpi(adapterWith(spyHttp([error])))).results[0];
      assert.equal(row.ok, false);
      assert.equal(row.statusCategory, "AUTH_FAILED");
      assert.equal(row.supplierStatusCode, status);
      const serialised = JSON.stringify(row);
      assert.ok(!serialised.includes(API_KEY));
      assert.ok(!serialised.includes("zzupstreambodyzz"), "no supplier response body");
    }
  });

  it("preserves a supplier validation failure safely", async () => {
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: { errors: ["zzvalidationdetailzz"] } };
    const row = (await certifyKpi(adapterWith(spyHttp([error])))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
    assert.ok(!JSON.stringify(row).includes("zzvalidationdetailzz"));
  });

  it("classifies not-found and upstream errors without retrying", async () => {
    for (const [status, category] of [[404, "NOT_FOUND"], [502, "UPSTREAM_ERROR"]]) {
      const error = new Error("zzupstreamzz");
      error.response = { status, data: {} };
      const spy = spyHttp([error]);
      const row = (await certifyKpi(adapterWith(spy))).results[0];
      assert.equal(row.statusCategory, category);
      assert.equal(spy.calls.length, 1);
    }
  });
});

describe("nothing configured can leak", () => {
  it("never returns a KPI key, name, label, type, group, format or currency value, in any shape", async () => {
    for (const body of [
      { allowedKpi: [DEFINITION, SECOND_DEFINITION] },
      { kpis: NAME_LIST },
      { kpi: NAME_MAP },
      { allowedKpi: "zzkpinamezz,zzsecondnamezz" },
      { data: { allowedKpi: [DEFINITION] }, status: "zzsecondnamezz" },
    ]) {
      const serialised = JSON.stringify(await certifyKpi(adapterWith(spyHttp([body]))));
      for (const secret of ALL_MARKERS) {
        assert.ok(!serialised.includes(secret), `${secret} in ${JSON.stringify(body).slice(0, 30)}`);
      }
    }
  });

  it("never returns an account identifier", async () => {
    const serialised = JSON.stringify(await rowFor({ allowedKpi: [DEFINITION], publisher_id: "zzpublisheridzz", account: "zzaccountzz" }));
    for (const secret of ["zzpublisheridzz", "zzaccountzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the API key or the raw payload, on success or on failure", async () => {
    const ok = JSON.stringify(await certifyKpi(adapterWith(spyHttp())));
    const error = new Error(`zzfailurezz ${API_KEY}`);
    error.response = { status: 500, data: { allowedKpi: [DEFINITION] } };
    const failed = JSON.stringify(await certifyKpi(adapterWith(spyHttp([error]))));
    for (const serialised of [ok, failed]) {
      for (const secret of [API_KEY, "X-Api-Key", 'allowedKpi":[{', "zzkpinamezz", "https://"]) {
        assert.ok(!serialised.includes(secret), secret);
      }
    }
  });

  it("returns only the safe result keys", async () => {
    const row = (await certifyKpi(adapterWith(spyHttp()))).results[0];
    for (const forbidden of ["rows", "kpis", "allowedKpi", "container", "envelope", "body", "raw", "data", "sample", "headers", "payload"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
    for (const expected of ["sourceObject", "endpointKey", "httpMethod", "sampleCount", "fieldCount", "fieldPaths", "statusCategory", "schema"]) {
      assert.ok(Object.hasOwn(row, expected), expected);
    }
    assert.ok(!Object.hasOwn(row, "windowPreset"), "not a dated object");
  });

  it("the preserveShape return never leaves the service", () => {
    const chain = chainSource();
    assert.ok(!chain.includes("...container"), "the container is never spread into the result");
    assert.ok(!chain.includes("...envelope"), "the envelope is never spread into the result");
    for (const path of ["envelope,", "container,", "containerKey,"]) {
      assert.ok(!chain.includes(`\n        ${path}`), `${path} as a result field`);
    }
  });
});

describe("read-only, and the other probes unchanged", () => {
  it("performs no database read or write", async () => {
    assert.equal((await certifyKpi(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain", () => {
    const chain = chainSource();
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany", "rawPayload", "Performance", "availableKpis"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("adds no reports-data, finance or persistence path", () => {
    const chain = chainSource();
    for (const forbidden of ["fetchReports(", "fetchPerformance", "Payment", "Invoice", "SupplierCommissionRule", "relationshipState"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
    for (const notYet of ["tracking", "finance", "reports"]) {
      assert.ok(!listProbeSourceObjects("trackier").includes(notYet), notYet);
    }
  });

  it("leaves the sync job's reportsKpi read exactly as it was", () => {
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchReportsKpi\(\)/);
    assert.ok(!codeOf(SYNC_SRC).includes("preserveShape"));
    assert.ok(!codeOf(SYNC_SRC).includes("reports_kpi"));
  });

  it("leaves profile, campaigns, campaign_detail, coupons, deals and conversions unchanged", async () => {
    const profileSpy = spyHttp([{ profile: { id: "zzprofileidzz" } }]);
    const profile = (await serviceWith(adapterWith(profileSpy)).certify("trackier", { sourceObjects: ["profile"] })).results[0];
    assert.equal(profileSpy.calls[0].path, "/v2/publishers/profile");
    assert.equal(profileSpy.calls.length, 1);
    assert.equal(profile.statusCategory, "OK");

    const listSpy = spyHttp([{ campaigns: [{ id: "zzcampaignzz" }] }]);
    const list = (await serviceWith(adapterWith(listSpy)).certify("trackier", { sourceObjects: ["campaigns"] })).results[0];
    assert.deepEqual(listSpy.calls[0].config.params, { limit: 1, page: 1 });
    assert.equal(listSpy.calls.length, 1);
    assert.equal(list.endpointKey, "GET /v2/publisher/campaigns (limit=1, page=1)");

    const detailSpy = spyHttp([{ campaigns: [{ id: "zzdiscoveredzz" }] }, { data: { id: "zzdiscoveredzz" } }]);
    const detail = (await serviceWith(adapterWith(detailSpy)).certify("trackier", { sourceObjects: ["campaign_detail"] })).results[0];
    assert.equal(detailSpy.calls.length, 2);
    assert.equal(detailSpy.calls[1].path, "/v2/publisher/campaign/zzdiscoveredzz");
    assert.equal(detail.statusCategory, "OK");

    const couponSpy = spyHttp([{ coupons: [{ id: "zzcouponzz" }], nextPageToken: "zztokzz" }]);
    const coupons = (await serviceWith(adapterWith(couponSpy)).certify("trackier", { sourceObjects: ["coupons"] })).results[0];
    assert.equal(couponSpy.calls[0].path, "/v2/publishers/coupons");
    assert.equal(couponSpy.calls.length, 1);
    assert.equal(coupons.statusCategory, "OK");

    const dealSpy = spyHttp([{ deals: [{ id: "zzdealzz" }], nextPageToken: "zztokzz" }]);
    const deals = (await serviceWith(adapterWith(dealSpy)).certify("trackier", { sourceObjects: ["deals"] })).results[0];
    assert.equal(dealSpy.calls[0].path, "/v2/publishers/deals");
    assert.equal(dealSpy.calls.length, 1);
    assert.equal(deals.statusCategory, "OK");

    const convSpy = spyHttp([{ conversions: [{ id: "zzconvzz" }], pagination: { hasNext: true } }]);
    const conversions = (await serviceWith(adapterWith(convSpy)).certify("trackier", { sourceObjects: ["conversions"] })).results[0];
    assert.equal(convSpy.calls[0].path, TRACKIER_CONVERSIONS_PATH);
    assert.equal(convSpy.calls.length, 1);
    assert.equal(convSpy.calls[0].config.params.limit, 1);
    assert.equal(conversions.statusCategory, "OK");
    assert.equal(conversions.windowPreset, "7d");
  });

  it("runs the whole Trackier set with one reports-kpi request among them, and no reports-data request", async () => {
    const spy = spyHttp([
      { profile: { id: "zzprofileidzz" } },
      { campaigns: [{ id: "zzdiscoveredzz" }] },
      { campaigns: [{ id: "zzdiscoveredzz" }] },
      { data: { id: "zzdiscoveredzz" } },
      { coupons: [{ id: "zzcouponzz" }] },
      { deals: [{ id: "zzdealzz" }] },
      { conversions: [{ id: "zzconvzz" }] },
      { allowedKpi: [DEFINITION] },
    ]);
    const out = await serviceWith(adapterWith(spy)).certify("trackier");
    assert.deepEqual(
      out.results.map((r) => r.sourceObject),
      ["profile", "campaigns", "campaign_detail", "coupons", "deals", "conversions", "reports_kpi"],
    );
    assert.equal(spy.calls.filter((c) => c.path === TRACKIER_REPORTS_KPI_PATH).length, 1);
    assert.equal(spy.calls.filter((c) => c.path === "/v2/publishers/reports").length, 0);
    assert.equal(spy.calls.length, 8);
    assert.ok(out.results.every((r) => r.ok), JSON.stringify(out.results.map((r) => r.statusCategory)));
    assert.equal(out.results.at(-1).schema, "KPI_DEFINITION_ARRAY");
  });
});
