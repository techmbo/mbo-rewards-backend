import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const {
  buildRakutenCertificationPaymentHistoryParams,
  createRakutenAdapter,
  extractRakutenCsvSample,
  normalizeRakutenAdvancedReportRow,
  parseCsv,
  parseRakutenAdvancedReport,
  rakutenAdvancedReportDateParam,
  RAKUTEN_ADVANCED_REPORTS_PATH,
  RAKUTEN_CERTIFICATION_MAX_ROWS,
  RAKUTEN_CERTIFICATION_SPECS,
  RAKUTEN_PAYMENT_HISTORY_REPORT_ID,
} = await import("../src/adapters/rakuten.adapter.js");
const {
  DEFAULT_WINDOW_PRESET,
  NetworkCertificationService,
  listProbeSourceObjects,
} = await import("../src/modules/ops/networkCertification.service.js");
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");
const { buildRakutenPaymentHistoryWindow } = await import("../src/jobs/rakutenSupplierSync.js");

const ADAPTER_SRC = readFileSync("src/adapters/rakuten.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/rakutenSupplierSync.js", "utf8");

/**
 * Comments are prose; an assertion that matches one proves nothing about behaviour.
 *
 * A single pass tracking BOTH comment state and string state. This adapter needs it: getCsv sends
 * `Accept: "text/csv,text/plain,*\/*"`, whose `/*` opens a comment span in a naive regex stripper
 * and swallows everything to the next `*\/`.
 */
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

const TOKEN = "zzrakutentokenzz";
const SECURITY_TOKEN = "zzsecuritytokenzz";

/** A bounded window in the shape the service computes one: ISO YYYY-MM-DD, UTC, plus its preset. */
const WINDOW = Object.freeze({ from: "2026-09-08", to: "2026-09-15", preset: "7d" });

/** Report 1's documented columns. Names real, every VALUE a distinctive marker — a realistic
 *  payment id is indistinguishable by substring from a column named Payment ID. The amount and
 *  check number are chosen so they cannot collide with a count or an ISO timestamp. */
const HEADER_ROW = 'Payment ID,Date,Payment Type,Check Number,Currency Code,Total Commission Amount Paid,Payment Status';
const ONE_PAYMENT_CSV = `${HEADER_ROW}\nzzpaymentidzz,2031-03-17,zzpaymenttypezz,zzchecknumberzz,SGD,8123.47,zzpaymentstatuszz`;

/** Two data rows, to prove only one is kept. */
const TWO_PAYMENTS_CSV = `${HEADER_ROW}\nzzfirstpaymentzz,2031-03-17,zzfirsttypezz,zzfirstcheckzz,SGD,1111.11,zzfirststatuszz\nzzsecondpaymentzz,2031-04-19,zzsecondtypezz,zzsecondcheckzz,SGD,2222.22,zzsecondstatuszz`;

/** The documented header row with no payments under it. */
const HEADER_ONLY_CSV = `${HEADER_ROW}\n`;

/** An adjustment: a reversed payment carries a negative amount. */
const NEGATIVE_CSV = `${HEADER_ROW}\nzznegativepaymentzz,2031-03-17,zzreversalzz,zznegcheckzz,SGD,-8123.47,zzreversedzz`;

/** A column whose value contains a comma, quoted per RFC 4180 — and a quoted header too. */
const QUOTED_CSV =
  'Payment ID,"Total Commission Amount Paid, Net",Payment Status\n' +
  'zzquotedpaymentzz,"9876.54, plus adjustments",zzquotedstatuszz';

function spyHttp(dataOrError = ONE_PAYMENT_CSV) {
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

function adapterWith(spy, { securityToken = SECURITY_TOKEN } = {}) {
  return createRakutenAdapter({ accessToken: TOKEN, securityToken, httpClient: spy.client });
}

function serviceWith(adapter, { securityToken = SECURITY_TOKEN } = {}) {
  return new NetworkCertificationService({
    prisma: {
      rawPayload: {
        findMany: async () => {
          throw new Error("certification must not read RawPayload unless compareRaw is requested");
        },
      },
    },
    adapterFactory: () => adapter,
    rakutenCredentialResolver: async () => ({ accessToken: TOKEN, securityToken }),
  });
}

async function certifyReportOne(adapter, options = {}) {
  return serviceWith(adapter, options).certify("rakuten", {
    sourceObjects: ["advanced_reports"],
    ...options,
  });
}

async function sampleReportOne(adapter, options = {}) {
  return adapter.fetchCertificationCsvSample("advanced_reports", { window: WINDOW, ...options });
}

describe("the documented Advanced Report 1 request contract", () => {
  it("addresses exactly GET /advancedreports/1.0", async () => {
    assert.equal(RAKUTEN_ADVANCED_REPORTS_PATH, "/advancedreports/1.0");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.advanced_reports.path, RAKUTEN_ADVANCED_REPORTS_PATH);
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.advanced_reports.method, "GET");

    const spy = spyHttp();
    await sampleReportOne(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/advancedreports/1.0");
  });

  it("sends reportid=1, the id the repo already wires as payment history", async () => {
    assert.equal(RAKUTEN_PAYMENT_HISTORY_REPORT_ID, 1);
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.advanced_reports.reportId, 1);

    const spy = spyHttp();
    await sampleReportOne(adapterWith(spy));
    assert.equal(spy.calls[0].config.params.reportid, 1);

    // fetchPaymentHistory is report 1 in production, and 1 is in the wired set.
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /fetchPaymentHistory\(params = \{\}, stats = null\) \{\s*return this\.fetchAdvancedReport\(1,/);
    assert.ok(code.includes("[1, 2, 3, 22, 23]"));
  });

  it("sends both bdate and edate", async () => {
    const spy = spyHttp();
    await sampleReportOne(adapterWith(spy));
    assert.equal(spy.calls[0].config.params.bdate, "20260908");
    assert.equal(spy.calls[0].config.params.edate, "20260915");
  });

  it("sends nothing beyond reportid, the date pair and the security token", async () => {
    const spy = spyHttp();
    await sampleReportOne(adapterWith(spy));
    assert.deepEqual(Object.keys(spy.calls[0].config.params).sort(), [
      "bdate",
      "edate",
      "reportid",
      "token",
    ]);
    // No payid and no invoiceid: reports 22 and 23 are unreachable from here.
    assert.ok(!Object.hasOwn(spy.calls[0].config.params, "payid"));
    assert.ok(!Object.hasOwn(spy.calls[0].config.params, "invoiceid"));
  });

  it("asks for CSV as text", async () => {
    const spy = spyHttp();
    await sampleReportOne(adapterWith(spy));
    assert.equal(spy.calls[0].config.responseType, "text");
    assert.match(spy.calls[0].config.headers.Accept, /csv/);
  });

  it("carries a bounded timeout rather than the shared client default", async () => {
    const spy = spyHttp();
    await sampleReportOne(adapterWith(spy), { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("is refused by the JSON sampler, which would misread a CSV body", async () => {
    const spy = spyHttp();
    await assert.rejects(
      () => adapterWith(spy).fetchCertificationSample("advanced_reports", { window: WINDOW }),
      /is CSV; use fetchCertificationCsvSample/,
    );
    assert.equal(spy.calls.length, 0);
  });

  it("refuses any other source object through the CSV sampler", async () => {
    const spy = spyHttp();
    for (const notCsv of ["advertisers", "events", "coupons", "constructor", "__proto__"]) {
      await assert.rejects(
        () => adapterWith(spy).fetchCertificationCsvSample(notCsv, { window: WINDOW }),
        /No Rakuten CSV certification sample is defined/,
        notCsv,
      );
    }
    assert.equal(spy.calls.length, 0);
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.advanced_reports.csv, true);
    for (const [name, spec] of Object.entries(RAKUTEN_CERTIFICATION_SPECS)) {
      if (name === "advanced_reports") continue;
      assert.ok(!spec.csv, `${name} must not be CSV`);
    }
  });
});

describe("the date format is production's own", () => {
  it("renders YYYYMMDD with no separators", () => {
    assert.equal(rakutenAdvancedReportDateParam("2026-09-08"), "20260908");
    assert.match(rakutenAdvancedReportDateParam("2026-09-08"), /^\d{8}$/);
    assert.ok(!rakutenAdvancedReportDateParam("2026-09-08").includes("-"));
  });

  it("is byte-identical to what the production window builder produces", () => {
    // Not a new format: buildRakutenPaymentHistoryWindow is what the sync job passes to
    // fetchPaymentHistory, and for the same instants it yields exactly these strings.
    const production = buildRakutenPaymentHistoryWindow({
      now: new Date("2026-09-15T00:00:00.000Z"),
      daysBack: 7,
    });
    assert.deepEqual(production, { bdate: "20260908", edate: "20260915" });
    assert.deepEqual(buildRakutenCertificationPaymentHistoryParams(WINDOW), production);
  });

  it("pads single-digit months and days", () => {
    assert.equal(rakutenAdvancedReportDateParam("2026-01-02"), "20260102");
  });

  it("returns null for an unparseable value rather than a malformed string", () => {
    assert.equal(rakutenAdvancedReportDateParam("not-a-date"), null);
    assert.equal(rakutenAdvancedReportDateParam(""), null);
  });

  it("still reads UTC when the process runs in a negative-offset zone", () => {
    // The container IS UTC, so an in-process assertion would let a local-time renderer pass. The
    // window's from/to are bare YYYY-MM-DD strings parsing as UTC midnight — in
    // America/Los_Angeles that is 17:00 the PREVIOUS day.
    const script = `
      process.env.BACKEND_URL = "https://backend.test";
      process.env.FRONTEND_URL = "https://frontend.test";
      process.env.JWT_SECRET = "test-jwt-secret-value-only";
      process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
      const m = await import("./src/adapters/rakuten.adapter.js");
      process.stdout.write(
        JSON.stringify({
          tzOffsetMinutes: new Date("2026-09-08").getTimezoneOffset(),
          params: m.buildRakutenCertificationPaymentHistoryParams({ from: "2026-09-08", to: "2026-09-15" }),
        }),
      );
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: "America/Los_Angeles" },
      encoding: "utf8",
    });
    const result = JSON.parse(out);
    assert.ok(result.tzOffsetMinutes > 0, "the child must actually run behind UTC");
    assert.deepEqual(result.params, { bdate: "20260908", edate: "20260915" });
    assert.notEqual(result.params.bdate, "20260907");
  });

  it("refuses a missing or half-open window, and makes NO supplier request", async () => {
    for (const partial of [{ from: "2026-09-08" }, { to: "2026-09-15" }, {}, { from: "x", to: "y" }]) {
      const spy = spyHttp();
      await assert.rejects(
        () => adapterWith(spy).fetchCertificationCsvSample("advanced_reports", { window: partial }),
        (error) => /requires/.test(error.message),
        JSON.stringify(partial),
      );
      assert.equal(spy.calls.length, 0, JSON.stringify(partial));
    }
    const spy = spyHttp();
    await assert.rejects(
      () => adapterWith(spy).fetchCertificationCsvSample("advanced_reports", {}),
      /requires window/,
    );
    assert.equal(spy.calls.length, 0);
  });

  it("is driven by the 7d certification preset", async () => {
    const spy = spyHttp();
    await certifyReportOne(adapterWith(spy));
    assert.equal(DEFAULT_WINDOW_PRESET, "7d");
    const { bdate, edate } = spy.calls[0].config.params;
    const asUtc = (yyyymmdd) =>
      Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6)));
    assert.equal((asUtc(edate) - asUtc(bdate)) / 86400000, 7);
    assert.equal((await certifyReportOne(adapterWith(spyHttp()))).results[0].windowPreset, "7d");
  });

  it("follows a wider preset when one is selected", async () => {
    const spy = spyHttp();
    const result = await certifyReportOne(adapterWith(spy), { windowPreset: "30d" });
    const { bdate, edate } = spy.calls[0].config.params;
    const asUtc = (yyyymmdd) =>
      Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6)));
    assert.equal((asUtc(edate) - asUtc(bdate)) / 86400000, 30);
    assert.equal(result.results[0].windowPreset, "30d");
  });
});

describe("exactly one request, no retry, no pagination", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await sampleReportOne(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a failed request", async () => {
    // Production's getCsv retries three times. Certification pins it to a single attempt.
    const spy = spyHttp(new Error("zzsupplierfailurezz"));
    await assert.rejects(() => sampleReportOne(adapterWith(spy)));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a retryable status either", async () => {
    // 503 is on requestWithRetry's retry list, so this is the case a retries seam must actually
    // suppress rather than merely appear to.
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp(error);
    await assert.rejects(() => sampleReportOne(adapterWith(spy)));
    assert.equal(spy.calls.length, 1);
  });

  it("leaves production's retry count untouched", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /async function getCsv\(path, params = \{\}, stats = null, \{ retries = 3/);
    const certification = code
      .split("async fetchCertificationCsvSample")[1]
      .split("async fetchAdvertisers")[0];
    assert.match(certification, /retries: 1/);
  });

  it("does not walk pages", async () => {
    const spy = spyHttp(TWO_PAYMENTS_CSV);
    await sampleReportOne(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    const certification = codeOf(ADAPTER_SRC)
      .split("async fetchCertificationCsvSample")[1]
      .split("async fetchAdvertisers")[0];
    const afterRequest = certification.slice(certification.indexOf("await getCsv("));
    assert.ok(!/for\s*\(|while\s*\(/.test(afterRequest));
    assert.equal((certification.match(/await getCsv\(/g) ?? []).length, 1);
  });

  it("makes one request through the whole certification chain too", async () => {
    const spy = spyHttp();
    await certifyReportOne(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });
});

describe("the existing fetcher is reused, not duplicated", () => {
  it("goes through getCsv, the same helper fetchAdvancedReport uses", () => {
    const code = codeOf(ADAPTER_SRC);
    const certification = code
      .split("async fetchCertificationCsvSample")[1]
      .split("async fetchAdvertisers")[0];
    assert.match(certification, /await getCsv\(/);
    // No parallel client: no second axios instance, no direct httpClient call, no second
    // security-token injection.
    assert.ok(!certification.includes("createHttpClient"));
    assert.ok(!certification.includes("httpClient.get("));
    assert.ok(!certification.includes("axios"));
    assert.equal((code.match(/async function getCsv\(/g) ?? []).length, 1);
  });

  it("keeps the security token, call budget and headers in getCsv's one place", () => {
    const getCsv = codeOf(ADAPTER_SRC)
      .split("async function getCsv(")[1]
      .split("async function fetchPagedJson(")[0];
    assert.ok(getCsv.includes("token: securityToken"));
    assert.ok(getCsv.includes("advancedReportCallBudget"));
    assert.match(getCsv, /Accept: "text\/csv/);
    const certification = codeOf(ADAPTER_SRC)
      .split("async fetchCertificationCsvSample")[1]
      .split("async fetchAdvertisers")[0];
    assert.ok(!certification.includes("token: securityToken"), "not re-injected");
  });

  it("takes its path and report id from the frozen spec, never from a literal", () => {
    // The same rule the JSON sampler follows: the request table is the only thing that chooses a
    // path. A literal here would be a second place to change when the endpoint moves, and a place
    // a spec's own value could silently disagree with.
    const certification = codeOf(ADAPTER_SRC)
      .split("async fetchCertificationCsvSample")[1]
      .split("async fetchAdvertisers")[0];
    assert.match(certification, /await getCsv\(\s*spec\.path,/);
    assert.match(certification, /reportid: spec\.reportId/);
    assert.ok(!certification.includes("RAKUTEN_ADVANCED_REPORTS_PATH"));
    assert.ok(!certification.includes("RAKUTEN_PAYMENT_HISTORY_REPORT_ID"));
    assert.equal((certification.match(/"\/advancedreports/g) ?? []).length, 0);
  });

  it("parses with the existing parseCsv", () => {
    assert.equal(typeof parseCsv, "function");
    const certification = codeOf(ADAPTER_SRC)
      .split("export function extractRakutenCsvSample")[1]
      .split("\n}")[0];
    assert.match(certification, /parseCsv\(text\)/);
  });
});

describe("raw supplier headers are preserved, normalization bypassed", () => {
  it("reports the supplier's own column names", async () => {
    const paths = (await certifyReportOne(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const header of [
      "Payment ID",
      "Date",
      "Payment Type",
      "Check Number",
      "Currency Code",
      "Total Commission Amount Paid",
      "Payment Status",
    ]) {
      assert.ok(paths.includes(header), header);
    }
  });

  it("reports none of the normalised MBO names", async () => {
    // parseRakutenAdvancedReport applies normalizeRakutenAdvancedReportRow, which renames these.
    const renamed = normalizeRakutenAdvancedReportRow(
      { "Payment ID": "x", "Total Commission Amount Paid": "1" },
      1,
    );
    assert.ok(Object.hasOwn(renamed, "payment_id"), "the normaliser still exists");
    assert.ok(Object.hasOwn(renamed, "payment_amount"));
    assert.ok(Object.hasOwn(renamed, "record_source"));

    const paths = (await certifyReportOne(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const mboName of [
      "payment_id",
      "payment_date",
      "payment_type",
      "check_number",
      "payment_amount",
      "network_payment_status",
      "report_id",
      "record_source",
    ]) {
      assert.ok(!paths.includes(mboName), mboName);
    }
  });

  it("does not call the normaliser at all", () => {
    const certification = codeOf(ADAPTER_SRC)
      .split("async fetchCertificationCsvSample")[1]
      .split("async fetchAdvertisers")[0];
    assert.ok(!certification.includes("normalizeRakutenAdvancedReportRow"));
    assert.ok(!certification.includes("parseRakutenAdvancedReport"));
    // And the production parser still does.
    assert.match(codeOf(ADAPTER_SRC), /rows\.slice\(1\)\.map\(\(values\) => normalizeRakutenAdvancedReportRow/);
  });

  it("uses headers verbatim, without trimming or re-casing", () => {
    const sample = extractRakutenCsvSample(" Payment ID ,DATE,payment type\nа,b,c");
    assert.deepEqual(sample.headers, [" Payment ID ", "DATE", "payment type"]);
    assert.ok(Object.hasOwn(sample.rows[0], " Payment ID "));
  });

  it("handles quoted commas in both headers and values", () => {
    const sample = extractRakutenCsvSample(QUOTED_CSV);
    assert.deepEqual(sample.headers, [
      "Payment ID",
      "Total Commission Amount Paid, Net",
      "Payment Status",
    ]);
    assert.equal(sample.rows.length, 1);
    assert.equal(sample.rows[0]["Total Commission Amount Paid, Net"], "9876.54, plus adjustments");
  });

  it("handles escaped quotes and CRLF line endings", () => {
    const sample = extractRakutenCsvSample('Payment ID,Note\r\nzzidzz,"he said ""ok"""\r\n');
    assert.deepEqual(sample.headers, ["Payment ID", "Note"]);
    assert.equal(sample.rows[0].Note, 'he said "ok"');
  });
});

describe("the three CSV outcomes are distinguished", () => {
  it("reports OK with a field dictionary when a data row is present", async () => {
    const row = (await certifyReportOne(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.schema, "KNOWN_FROM_HEADERS");
    assert.equal(row.sampleCount, 1);
    assert.equal(row.fieldCount, 7);
    assert.equal(row.fieldCount, row.fieldPaths.length);
  });

  it("reports OK_NO_ROWS with KNOWN_FROM_HEADERS for a header-only report", async () => {
    // The columns ARE known; the window simply held no payment. Collapsing this into
    // UNKNOWN_NEEDS_LIVE_DATA would throw away the schema the header row just proved.
    const row = (await certifyReportOne(adapterWith(spyHttp(HEADER_ONLY_CSV)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "KNOWN_FROM_HEADERS");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 7);
    assert.deepEqual(
      row.fieldPaths.map((f) => f.path),
      [
        "Check Number",
        "Currency Code",
        "Date",
        "Payment ID",
        "Payment Status",
        "Payment Type",
        "Total Commission Amount Paid",
      ],
    );
    // Present as columns, unobserved as values.
    for (const field of row.fieldPaths) {
      assert.equal(field.presentCount, 0, field.path);
      assert.equal(field.observedType, "NULL", field.path);
    }
  });

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for an empty body", async () => {
    for (const empty of ["", "   ", "\n"]) {
      const row = (await certifyReportOne(adapterWith(spyHttp(empty)))).results[0];
      assert.equal(row.ok, true, JSON.stringify(empty));
      assert.equal(row.statusCategory, "OK_NO_ROWS", JSON.stringify(empty));
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA", JSON.stringify(empty));
      assert.equal(row.fieldCount, 0);
      assert.deepEqual(row.fieldPaths, []);
    }
  });

  it("invents no account-state blocker from an empty report", async () => {
    // This account has no joined campaigns, so having no payments is the expected state — not a
    // finding about the endpoint.
    for (const body of [HEADER_ONLY_CSV, ""]) {
      const serialised = JSON.stringify(await certifyReportOne(adapterWith(spyHttp(body))));
      for (const invented of [
        "NEEDS_ACTIVE_PARTNERSHIP",
        "NO_JOINED_CAMPAIGNS",
        "accountStateBlocker",
        "NOT_SUPPORTED",
        "UNSUPPORTED",
      ]) {
        assert.ok(!serialised.includes(invented), `${invented} for ${JSON.stringify(body)}`);
      }
    }
  });

  it("preserves an auth rejection safely", async () => {
    const error = new Error("zzupstreamauthmessagezz");
    error.response = { status: 401, data: { message: "zzupstreambodyzz" } };
    const row = (await certifyReportOne(adapterWith(spyHttp(error)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.equal(row.supplierStatusCode, 401);
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(TOKEN));
    assert.ok(!serialised.includes(SECURITY_TOKEN));
    assert.ok(!serialised.includes("zzupstreambodyzz"));
  });

  it("preserves a supplier validation failure safely", async () => {
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: {} };
    const row = (await certifyReportOne(adapterWith(spyHttp(error)))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
  });

  it("reports a missing security token as its own condition, with NO request", async () => {
    // Advanced Reports is the one Rakuten surface needing the web security token, and production
    // gates its whole finance chain on the same condition. "Not configured" is not a network error.
    const spy = spyHttp();
    const row = (
      await certifyReportOne(adapterWith(spy, { securityToken: null }), { securityToken: null })
    ).results[0];
    assert.equal(spy.calls.length, 0);
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "SKIPPED_NO_SECURITY_TOKEN");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.ok(!JSON.stringify(row).includes(SECURITY_TOKEN));
    assert.match(codeOf(SYNC_SRC), /Boolean\(creds\.securityToken\)/);
  });
});

describe("the sample is bounded to one row, twice and independently", () => {
  it("slices in the adapter", async () => {
    assert.equal(RAKUTEN_CERTIFICATION_MAX_ROWS, 1);
    assert.equal((await sampleReportOne(adapterWith(spyHttp(TWO_PAYMENTS_CSV)))).rows.length, 1);
    assert.equal(extractRakutenCsvSample(TWO_PAYMENTS_CSV).rows.length, 1);
  });

  it("slices again in the service, independently of the adapter", async () => {
    const unbounded = {
      ...adapterWith(spyHttp(TWO_PAYMENTS_CSV)),
      fetchCertificationCsvSample: async () => extractRakutenCsvSample(TWO_PAYMENTS_CSV, { maxRows: 99 }),
    };
    assert.equal(extractRakutenCsvSample(TWO_PAYMENTS_CSV, { maxRows: 99 }).rows.length, 2);
    assert.equal((await certifyReportOne(unbounded)).results[0].sampleCount, 1);
  });

  it("never returns the second row's values", async () => {
    const serialised = JSON.stringify(await certifyReportOne(adapterWith(spyHttp(TWO_PAYMENTS_CSV))));
    for (const secret of ["zzsecondpaymentzz", "zzsecondcheckzz", "2222.22", "zzfirstpaymentzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });
});

describe("nothing identifying or monetary can leak", () => {
  it("never returns payment ids, check numbers or statuses", async () => {
    const serialised = JSON.stringify(await certifyReportOne(adapterWith(spyHttp())));
    for (const secret of [
      "zzpaymentidzz",
      "zzchecknumberzz",
      "zzpaymenttypezz",
      "zzpaymentstatuszz",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns amounts, currency values or row dates", async () => {
    const serialised = JSON.stringify(await certifyReportOne(adapterWith(spyHttp())));
    for (const secret of ["8123.47", "SGD", "2031-03-17"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns credentials or the raw CSV", async () => {
    const serialised = JSON.stringify(await certifyReportOne(adapterWith(spyHttp())));
    for (const secret of [TOKEN, SECURITY_TOKEN, "Bearer", "token", HEADER_ROW.slice(0, 30)]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("returns only the safe result keys", async () => {
    const row = (await certifyReportOne(adapterWith(spyHttp()))).results[0];
    for (const forbidden of ["rows", "headers", "csv", "body", "raw", "data", "sample"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
    for (const expected of [
      "sourceObject",
      "endpointKey",
      "reportId",
      "httpMethod",
      "sampleCount",
      "fieldCount",
      "fieldPaths",
      "statusCategory",
      "schema",
      "windowPreset",
    ]) {
      assert.ok(Object.hasOwn(row, expected), expected);
    }
    assert.equal(row.reportId, 1);
    assert.equal(row.sourceObject, "advanced_reports");
    assert.equal(row.endpointKey, "GET /advancedreports/1.0 (reportid=1, bdate/edate window)");
    assert.equal(row.httpMethod, "GET");
  });

  it("describes each column structurally and carries no key that could hold a value", async () => {
    const row = (await certifyReportOne(adapterWith(spyHttp()))).results[0];
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

describe("payment-summary evidence only", () => {
  it("accepts a negative amount structurally", async () => {
    const row = (await certifyReportOne(adapterWith(spyHttp(NEGATIVE_CSV)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.equal(row.fieldCount, 7);
    const rows = await sampleReportOne(adapterWith(spyHttp(NEGATIVE_CSV)));
    assert.equal(rows.rows[0]["Total Commission Amount Paid"], "-8123.47");
  });

  it("creates no payable, invoice, payment or receipt classification", () => {
    const code = codeOf(ADAPTER_SRC);
    const service = codeOf(SERVICE_SRC);
    for (const forbidden of [
      "ClientPayable",
      "NetworkInvoice",
      "NetworkPayment",
      "MBOReceipt",
      "settlement",
      "finalCommission",
    ]) {
      assert.ok(!code.includes(forbidden), `adapter: ${forbidden}`);
      assert.ok(!service.includes(forbidden), `service: ${forbidden}`);
    }
  });

  it("makes no settlement or item-level claim in the result", async () => {
    const serialised = JSON.stringify(await certifyReportOne(adapterWith(spyHttp())));
    for (const claim of [
      "ClientPayable",
      "NetworkInvoice",
      "NetworkPayment",
      "MBOReceipt",
      "settled",
      "itemLevel",
      "reconcil",
    ]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });

  it("is catalogued under the existing source object, unchanged", () => {
    const entry = getSourceObject("rakuten", "advanced_reports");
    assert.ok(entry);
    assert.equal(entry.endpoint, "GET /advancedreports/1.0");
    assert.equal(entry.live, true);
    assert.equal(entry.entityType, "payment");
    assert.ok(listProbeSourceObjects("rakuten").includes("advanced_reports"));
    // No competing name was added for it.
    for (const invented of ["payments", "payment_history", "advanced_report_1"]) {
      assert.ok(!listProbeSourceObjects("rakuten").includes(invented), invented);
      assert.equal(getSourceObject("rakuten", invented), null, invented);
    }
  });
});

describe("read-only, and reports 22, 23 and Events untouched", () => {
  it("performs no database read or write", async () => {
    assert.equal((await certifyReportOne(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain that certifies this object", () => {
    const code = codeOf(SERVICE_SRC);
    const chain = code.slice(
      code.indexOf("async certifyRakutenAdvancedReport("),
      code.indexOf("async certifyAwinCommissionGroups("),
    );
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("never requests report 22 or 23, and cannot be pointed at them", async () => {
    const spy = spyHttp();
    await certifyReportOne(adapterWith(spy));
    assert.equal(spy.calls[0].config.params.reportid, 1);

    // The id lives on the frozen spec, not in the parameter builder a window feeds.
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_SPECS.advanced_reports));
    assert.deepEqual(Object.keys(buildRakutenCertificationPaymentHistoryParams(WINDOW)).sort(), [
      "bdate",
      "edate",
    ]);
    const chain = codeOf(SERVICE_SRC).slice(
      codeOf(SERVICE_SRC).indexOf("async certifyRakutenAdvancedReport("),
      codeOf(SERVICE_SRC).indexOf("async certifyAwinCommissionGroups("),
    );
    for (const other of ["payid", "invoiceid", "22", "23"]) {
      assert.ok(!chain.includes(other), other);
    }
  });

  it("leaves the production report 22/23 chain exactly as it was", () => {
    const sync = codeOf(SYNC_SRC);
    assert.ok(sync.includes("reportId: 22"));
    assert.ok(sync.includes("reportId: 23"));
    assert.ok(sync.includes("payid: payment.payment_id"));
    assert.ok(sync.includes("invoiceid: invoice.invoice_number"));
    // And certification is not wired into the sync job.
    assert.ok(!sync.includes("fetchCertificationCsvSample"));
    assert.ok(!sync.includes("Certification"));
  });

  it("leaves fetchAdvancedReport's guards untouched", () => {
    const code = codeOf(ADAPTER_SRC);
    const production = code.split("async fetchAdvancedReport")[1].split("async fetchPaymentHistory")[0];
    assert.ok(production.includes("[1, 2, 3, 22, 23]"));
    assert.ok(production.includes("requires payid"));
    assert.ok(production.includes("requires invoiceid"));
    assert.ok(production.includes("requires bdate and edate"));
    assert.ok(production.includes("parseRakutenAdvancedReport"));
  });

  it("leaves the Events probe and fetcher unchanged", async () => {
    const spy = spyHttp([{ etransaction_id: "zzetidzz" }]);
    await adapterWith(spy).fetchCertificationSample("events", { window: WINDOW });
    assert.equal(spy.calls[0].path, "/events/1.0/transactions");
    assert.equal(spy.calls[0].config.params.limit, 1);
    assert.equal(spy.calls[0].config.params.page, 1);
    assert.ok(spy.calls[0].config.params.process_date_start.endsWith(" 00:00:00"));

    const code = codeOf(ADAPTER_SRC);
    const events = code.split("async fetchConversions")[1].split("async fetchAdvancedReport")[0];
    assert.ok(events.includes("normalizeRakutenEventEvidence"));
    assert.ok(events.includes("getJson"));
    assert.ok(events.includes("maxPages"));
  });

  it("leaves every other Rakuten object sending its own request unchanged", async () => {
    const jsonSpy = spyHttp({ advertisers: [{ id: "zzadvzz" }] });
    await adapterWith(jsonSpy).fetchCertificationSample("advertisers", { window: WINDOW });
    assert.equal(jsonSpy.calls[0].path, "/v2/advertisers");
    assert.deepEqual(jsonSpy.calls[0].config.params, { limit: 1, page: 1 });
  });

  it("still parses a production report through the normalising parser", () => {
    // parseRakutenAdvancedReport is untouched: same input, same normalised output.
    const rows = parseRakutenAdvancedReport(ONE_PAYMENT_CSV, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payment_id, "zzpaymentidzz");
    assert.equal(rows[0].report_id, 1);
    assert.equal(rows[0].record_source, "rakuten_advanced_report_1");
  });
});
