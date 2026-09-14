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
  buildRakutenCertificationEventParams,
  buildRakutenEventParams,
  createRakutenAdapter,
  normalizeRakutenEventEvidence,
  rakutenEventDateParam,
  RAKUTEN_CERTIFICATION_MAX_ROWS,
  RAKUTEN_CERTIFICATION_PAGE_PARAMS,
  RAKUTEN_CERTIFICATION_SPECS,
  RAKUTEN_EVENTS_COLLECTION_KEYS,
  RAKUTEN_EVENTS_PATH,
} = await import("../src/adapters/rakuten.adapter.js");
const {
  DEFAULT_WINDOW_PRESET,
  NetworkCertificationService,
  WINDOW_PRESETS,
  listProbeSourceObjects,
} = await import("../src/modules/ops/networkCertification.service.js");
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/rakuten.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

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

/** A bounded window in exactly the shape the service computes one: ISO YYYY-MM-DD, UTC, plus the
 *  preset that produced it. Fixed dates, so the expected parameters are literals a reader can
 *  check by eye rather than a second computation of the thing under test. */
const WINDOW = Object.freeze({ from: "2026-09-08", to: "2026-09-15", preset: "7d" });
const WINDOW_START = "2026-09-08 00:00:00";
const WINDOW_END = "2026-09-15 23:59:59";

/**
 * One transaction row, with the supplier's own field names and distinctive values.
 *
 * A realistic value would make the leak tests worthless: a plausible order id is indistinguishable
 * by substring from a path named order_id. Monetary fields are the exception — they must be real
 * numbers to certify as NUMBER — so they use values that cannot collide with a count, an ISO
 * timestamp, or each other.
 */
const ONE_EVENT = [
  {
    etransaction_id: "zzetransactionidzz",
    advertiser_id: "zzadvertiseridzz",
    sid: "zzsidzz",
    order_id: "zzorderidzz",
    offer_id: "zzofferidzz",
    sku_number: "zzskunumberzz",
    sale_amount: 8123.47,
    quantity: 6291,
    commissions: 4372.19,
    process_date: "2031-03-17 04:05:06",
    transaction_date: "2031-03-16 07:08:09",
    transaction_type: "zztransactiontypezz",
    product_name: "zzproductnamezz",
    u1: "zzu1attributionzz",
    currency: "SGD",
    is_event: "zziseventzz",
    commission_list_id: "zzcommissionlistidzz",
    order_auto_lock_date: "2031-04-19 10:11:12",
    lock_status: "zzlockstatuszz",
  },
];

/** An adjustment: Rakuten creates NEW rows for cancellations, and they carry negative amounts. */
const NEGATIVE_EVENT = [
  {
    etransaction_id: "zznegativeetidzz",
    order_id: "zznegativeorderidzz",
    sale_amount: -8123.47,
    commissions: -4372.19,
    quantity: -1,
    transaction_type: "zzadjustmentzz",
  },
];

/** Two ITEM rows of ONE order: same order_id, different etransaction_id and SKU. */
const TWO_ITEMS_ONE_ORDER = [
  {
    etransaction_id: "zzfirstetidzz",
    order_id: "zzsharedorderidzz",
    sku_number: "zzfirstskuzz",
    sale_amount: 1111.11,
    quantity: 1,
  },
  {
    etransaction_id: "zzsecondetidzz",
    order_id: "zzsharedorderidzz",
    sku_number: "zzsecondskuzz",
    sale_amount: 2222.22,
    quantity: 2,
  },
];

function spyHttp(dataOrError = ONE_EVENT) {
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
  return createRakutenAdapter({
    accessToken: TOKEN,
    securityToken: SECURITY_TOKEN,
    httpClient: spy.client,
  });
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
    rakutenCredentialResolver: async () => ({
      accessToken: TOKEN,
      securityToken: SECURITY_TOKEN,
    }),
  });
}

async function certifyEvents(adapter, options = {}) {
  return serviceWith(adapter).certify("rakuten", { sourceObjects: ["events"], ...options });
}

async function sampleEvents(adapter, options = {}) {
  return adapter.fetchCertificationSample("events", { window: WINDOW, ...options });
}

describe("the documented Events request contract", () => {
  it("addresses exactly GET /events/1.0/transactions", async () => {
    assert.equal(RAKUTEN_EVENTS_PATH, "/events/1.0/transactions");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.events.path, RAKUTEN_EVENTS_PATH);
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.events.method, "GET");

    const spy = spyHttp();
    await sampleEvents(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/events/1.0/transactions");
  });

  it("sends limit=1 and page=1", async () => {
    const spy = spyHttp();
    await sampleEvents(adapterWith(spy));
    assert.equal(spy.calls[0].config.params.limit, 1);
    assert.equal(spy.calls[0].config.params.page, 1);
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_PAGE_PARAMS }, { limit: 1, page: 1 });
  });

  it("sends both process-date parameters, and nothing beyond the four", async () => {
    const spy = spyHttp();
    await sampleEvents(adapterWith(spy));
    assert.deepEqual(spy.calls[0].config.params, {
      process_date_start: WINDOW_START,
      process_date_end: WINDOW_END,
      limit: 1,
      page: 1,
    });
  });

  it("never sends one half of a date pair", () => {
    // Rakuten rejects a half-open pair. Production's builder is what enforces it, and the
    // certification builder runs through that same builder rather than reimplementing the rule.
    const built = buildRakutenCertificationEventParams(WINDOW);
    assert.ok(Object.hasOwn(built, "process_date_start"));
    assert.ok(Object.hasOwn(built, "process_date_end"));
    assert.throws(
      () => buildRakutenEventParams({ process_date_start: WINDOW_START }),
      /must be supplied together/,
    );
    assert.throws(
      () => buildRakutenEventParams({ process_date_end: WINDOW_END }),
      /must be supplied together/,
    );
  });

  it("assembles through production's own parameter builder", () => {
    // Not a second implementation of the contract: the allowlist, the together-or-not-at-all rule
    // for each date pair, and the limit/page normalisation are production's. A hand-rolled object
    // literal would produce the same four keys today and silently lose all three rules.
    const builder = codeOf(ADAPTER_SRC)
      .split("export function buildRakutenCertificationEventParams")[1]
      .split("\n}")[0];
    assert.match(builder, /return buildRakutenEventParams\(\{/);
    assert.ok(!builder.includes("return {"), "no literal short-circuits the builder");

    assert.deepEqual(
      buildRakutenCertificationEventParams(WINDOW),
      buildRakutenEventParams({
        process_date_start: WINDOW_START,
        process_date_end: WINDOW_END,
        limit: 1,
        page: 1,
      }),
    );
  });

  it("declares ownBounds, so a change to the shared pair cannot reach this endpoint", () => {
    // Defensive rather than currently load-bearing: the builder emits limit=1 page=1 and the
    // shared pair holds the same two values, so today they agree. ownBounds is what keeps that a
    // coincidence rather than a dependency — a third key added to the shared pair would otherwise
    // arrive here without passing through production's allowlist.
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.events.ownBounds, true);
    assert.equal(
      RAKUTEN_CERTIFICATION_SPECS.events.buildParams,
      buildRakutenCertificationEventParams,
    );
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.events.params, undefined);
    assert.deepEqual(Object.keys(buildRakutenCertificationEventParams(WINDOW)).sort(), [
      "limit",
      "page",
      "process_date_end",
      "process_date_start",
    ]);
  });

  it("sends the PROCESS pair only, never the transaction pair as well", async () => {
    // Rakuten takes either pair. Sending both would leave it ambiguous which date the window
    // bounded, and the result would be a dictionary nobody could attribute to a window.
    const spy = spyHttp();
    await sampleEvents(adapterWith(spy));
    assert.ok(!Object.hasOwn(spy.calls[0].config.params, "transaction_date_start"));
    assert.ok(!Object.hasOwn(spy.calls[0].config.params, "transaction_date_end"));
  });

  it("uses the Bearer only, and asks for JSON", async () => {
    const spy = spyHttp();
    const bearerOnly = createRakutenAdapter({ accessToken: TOKEN, httpClient: spy.client });
    assert.equal((await sampleEvents(bearerOnly)).length, 1);
    assert.equal(spy.calls[0].config.headers.Accept, "application/json");
    assert.equal(spy.calls[0].config.responseType, undefined);
    assert.ok(!JSON.stringify(spy.calls[0]).includes(SECURITY_TOKEN));
    assert.ok(!JSON.stringify(spy.calls[0]).includes("advancedreports"));
  });

  it("reads rows from production's own collection key", () => {
    assert.deepEqual([...RAKUTEN_EVENTS_COLLECTION_KEYS], ["transactions"]);
    assert.equal(
      RAKUTEN_CERTIFICATION_SPECS.events.collectionKeys,
      RAKUTEN_EVENTS_COLLECTION_KEYS,
    );
    assert.match(codeOf(ADAPTER_SRC), /extractRakutenCollection\(payload, \["transactions"\]\)/);
  });
});

describe("the date format is the documented one, in UTC", () => {
  it("renders YYYY-MM-DD HH:mm:ss", () => {
    assert.equal(rakutenEventDateParam("2031-03-17T04:05:06Z"), "2031-03-17 04:05:06");
    assert.match(buildRakutenCertificationEventParams(WINDOW).process_date_start, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(buildRakutenCertificationEventParams(WINDOW).process_date_end, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("separates date from time with a SPACE and does not pre-encode it", () => {
    // URL encoding is the HTTP client's job. Encoding here would double-encode into %2520.
    const start = buildRakutenCertificationEventParams(WINDOW).process_date_start;
    assert.ok(start.includes(" "));
    assert.ok(!start.includes("%20"));
    assert.ok(!start.includes("T"), "not ISO 8601");
    assert.ok(!start.endsWith("Z"));
  });

  it("pads every component to two digits", () => {
    assert.equal(rakutenEventDateParam("2031-01-02T03:04:05Z"), "2031-01-02 03:04:05");
  });

  it("returns null for an unparseable value rather than a malformed string", () => {
    assert.equal(rakutenEventDateParam("not-a-date"), null);
    assert.equal(rakutenEventDateParam(""), null);
  });

  it("covers the window's whole span: first instant of the start day to the last of the end day", () => {
    // process_date_end is an inclusive upper bound on a TIMESTAMP, and the window's `to` is today.
    // Rendering it at 00:00:00 would end the window the instant today begins and discard every
    // transaction recorded today — on an API holding only the last week or two, the half most
    // likely to carry a row.
    const built = buildRakutenCertificationEventParams(WINDOW);
    assert.equal(built.process_date_start, "2026-09-08 00:00:00");
    assert.equal(built.process_date_end, "2026-09-15 23:59:59");
    assert.ok(built.process_date_start.endsWith(" 00:00:00"));
    assert.ok(built.process_date_end.endsWith(" 23:59:59"));
  });

  it("still reads UTC when the process runs in a negative-offset zone", () => {
    // Asserting this in-process proves nothing: the test container IS UTC, so local and UTC
    // accessors agree and a local-time renderer would pass. So run it where they disagree.
    //
    // The window's from/to are bare "YYYY-MM-DD" strings, which parse as UTC MIDNIGHT — the worst
    // possible instant for a local reader. In America/Los_Angeles that midnight is 17:00 the
    // PREVIOUS day, so a local-time renderer asks Rakuten for a different window than the one the
    // run reports.
    const script = `
      process.env.BACKEND_URL = "https://backend.test";
      process.env.FRONTEND_URL = "https://frontend.test";
      process.env.JWT_SECRET = "test-jwt-secret-value-only";
      process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
      const m = await import("./src/adapters/rakuten.adapter.js");
      process.stdout.write(
        JSON.stringify({
          tzOffsetMinutes: new Date("2026-09-08").getTimezoneOffset(),
          params: m.buildRakutenCertificationEventParams({ from: "2026-09-08", to: "2026-09-15" }),
        }),
      );
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: "America/Los_Angeles" },
      encoding: "utf8",
    });
    const result = JSON.parse(out);

    // Guard the guard: if the child were somehow still UTC, this test would prove nothing.
    assert.ok(result.tzOffsetMinutes > 0, "the child must actually run behind UTC");
    assert.equal(result.params.process_date_start, WINDOW_START);
    assert.equal(result.params.process_date_end, WINDOW_END);
    assert.notEqual(result.params.process_date_start, "2026-09-07 00:00:00");
  });
});

describe("the window is the service's, and it is required", () => {
  /**
   * Whole days between the two rendered process DATES of whatever request actually went out.
   *
   * Measured on the date parts alone, because the preset controls the dates: the span in seconds
   * is a day short of a round number by design, since the window runs from the first instant of
   * the start day to the LAST SECOND of the end day. Measuring instants would report 8 for a 7d
   * preset and hide what the preset actually chose.
   */
  function windowDays(params) {
    const dayOf = (text) => Date.parse(`${text.slice(0, 10)}T00:00:00Z`);
    return (dayOf(params.process_date_end) - dayOf(params.process_date_start)) / 86400000;
  }

  /** The times the two ends must always carry, whatever preset chose the dates. */
  function assertDayBoundaries(params) {
    assert.ok(params.process_date_start.endsWith(" 00:00:00"), params.process_date_start);
    assert.ok(params.process_date_end.endsWith(" 23:59:59"), params.process_date_end);
  }

  it("defaults to the existing 7d preset", async () => {
    const spy = spyHttp();
    await certifyEvents(adapterWith(spy));
    assert.equal(DEFAULT_WINDOW_PRESET, "7d");
    assert.equal(WINDOW_PRESETS["7d"], 7);
    assert.equal(windowDays(spy.calls[0].config.params), 7);
    assertDayBoundaries(spy.calls[0].config.params);
  });

  it("honours a wider preset when one is selected", async () => {
    const spy = spyHttp();
    await certifyEvents(adapterWith(spy), { windowPreset: "30d" });
    assert.equal(windowDays(spy.calls[0].config.params), 30);
    assertDayBoundaries(spy.calls[0].config.params);
  });

  it("falls back to the default rather than honouring an arbitrary preset", async () => {
    const spy = spyHttp();
    await certifyEvents(adapterWith(spy), { windowPreset: "9999d" });
    assert.equal(windowDays(spy.calls[0].config.params), 7);
  });

  it("reports the preset the dates came from, and follows the selection", async () => {
    assert.equal((await certifyEvents(adapterWith(spyHttp()))).results[0].windowPreset, "7d");
    const wider = await certifyEvents(adapterWith(spyHttp()), { windowPreset: "30d" });
    assert.equal(wider.results[0].windowPreset, "30d");
  });

  it("accepts no caller-supplied dates", () => {
    // A caller picks a PRESET TOKEN and never a date.
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyRakutenSample")[1]
      .split("async certifyAwinCommissionGroups")[0];
    for (const leak of ["req.body", "req.query", "options.from", "params.from", "ctx.from"]) {
      assert.ok(!chain.includes(leak), leak);
    }
    assert.match(codeOf(SERVICE_SRC), /window: \{ \.\.\.ctx\.window, preset: resolvedWindowPreset \}/);
  });

  it("refuses to build the request with no window, and makes NO supplier request", async () => {
    const spy = spyHttp();
    await assert.rejects(
      () => adapterWith(spy).fetchCertificationSample("events", {}),
      /requires window/,
    );
    assert.equal(spy.calls.length, 0);
    assert.deepEqual([...RAKUTEN_CERTIFICATION_SPECS.events.needs], ["window"]);
  });

  it("refuses a half-open or unparseable window, and makes NO supplier request", async () => {
    for (const partial of [
      { from: "2026-09-08" },
      { to: "2026-09-15" },
      {},
      { from: "nope", to: "nope" },
    ]) {
      const spy = spyHttp();
      await assert.rejects(
        () => adapterWith(spy).fetchCertificationSample("events", { window: partial }),
        (error) => /requires/.test(error.message),
        JSON.stringify(partial),
      );
      assert.equal(spy.calls.length, 0, JSON.stringify(partial));
    }
  });
});

describe("exactly one request, no retry, no pagination", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await sampleEvents(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a failed request", async () => {
    // getJson wraps requestWithRetry and would turn one read into up to four. The certification
    // sampler calls the client directly.
    const spy = spyHttp(new Error("zzsupplierfailurezz"));
    await assert.rejects(() => sampleEvents(adapterWith(spy)));
    assert.equal(spy.calls.length, 1);
  });

  it("does not walk pages, even when the page comes back full", async () => {
    // production's fetchConversions pages while a page is full. At limit=1, a one-row page IS
    // full, so a pager would ask for page 2 — this must not.
    const spy = spyHttp(ONE_EVENT);
    await sampleEvents(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].config.params.page, 1);
  });

  it("makes one request through the whole certification chain too", async () => {
    const spy = spyHttp();
    await certifyEvents(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("carries a bounded timeout rather than the shared client default", async () => {
    const spy = spyHttp();
    await sampleEvents(adapterWith(spy), { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });
});

describe("supplier field names are preserved, not renamed", () => {
  it("returns the row exactly as the supplier sent it", async () => {
    const rows = await sampleEvents(adapterWith(spyHttp()));
    assert.deepEqual(rows, ONE_EVENT);
  });

  it("does not apply the production normaliser", async () => {
    // normalizeRakutenEventEvidence renames etransaction_id to networkConversionComponentId and
    // commissions to baseCommissionCandidate. Certifying a renamed row would certify MBO's
    // vocabulary instead of Rakuten's.
    const renamed = normalizeRakutenEventEvidence(ONE_EVENT[0]);
    assert.ok(Object.hasOwn(renamed, "networkConversionComponentId"), "the normaliser still exists");
    assert.ok(Object.hasOwn(renamed, "baseCommissionCandidate"));

    const rows = await sampleEvents(adapterWith(spyHttp()));
    for (const renamedKey of [
      "networkConversionComponentId",
      "networkOrderReference",
      "baseCommissionCandidate",
      "attributionU1",
      "itemValue",
    ]) {
      assert.ok(!Object.hasOwn(rows[0], renamedKey), renamedKey);
    }
  });

  it("reports the supplier's own field names in the dictionary", async () => {
    const paths = (await certifyEvents(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const supplierName of [
      "etransaction_id",
      "advertiser_id",
      "sid",
      "order_id",
      "offer_id",
      "sku_number",
      "sale_amount",
      "quantity",
      "commissions",
      "process_date",
      "transaction_date",
      "transaction_type",
      "product_name",
      "u1",
      "currency",
      "is_event",
      "commission_list_id",
      "order_auto_lock_date",
      "lock_status",
    ]) {
      assert.ok(paths.includes(supplierName), supplierName);
    }
    for (const mboName of ["networkConversionComponentId", "baseCommissionCandidate", "itemValue"]) {
      assert.ok(!paths.includes(mboName), mboName);
    }
  });

  it("leaves the production conversion fetcher untouched", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchConversions")[1]
      .split("async fetchAdvancedReport")[0];
    // Still production's own: its own pager, its own normaliser, its own retrying getJson.
    assert.ok(production.includes("normalizeRakutenEventEvidence"));
    assert.ok(production.includes("getJson"));
    assert.ok(production.includes("maxPages"));
  });
});

describe("an event transaction is not a final order finance record", () => {
  it("introduces no payable, invoice or payment classification", () => {
    const code = codeOf(ADAPTER_SRC);
    const service = codeOf(SERVICE_SRC);
    for (const forbidden of [
      "ClientPayable",
      "NetworkInvoice",
      "NetworkPayment",
      "finalCommission",
      "payableCommission",
      "expectedCommission",
    ]) {
      assert.ok(!code.includes(forbidden), `adapter: ${forbidden}`);
      assert.ok(!service.includes(forbidden), `service: ${forbidden}`);
    }
  });

  it("makes no finance claim in the certification result", async () => {
    const serialised = JSON.stringify(await certifyEvents(adapterWith(spyHttp())));
    for (const claim of [
      "FINAL_ORDER_FINANCE_RECORD",
      "ClientPayable",
      "NetworkInvoice",
      "NetworkPayment",
      "payable",
      "reconcil",
    ]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });

  it("reports commissions as a structural NUMBER and nothing more", async () => {
    const row = (await certifyEvents(adapterWith(spyHttp()))).results[0];
    const commissions = row.fieldPaths.find((f) => f.path === "commissions");
    assert.ok(commissions);
    assert.equal(commissions.observedType, "NUMBER");
    // A structural category, never an amount and never a judgement about what the amount means.
    assert.deepEqual(Object.keys(commissions).sort(), [
      "arrayObserved",
      "exampleCategory",
      "nullableObserved",
      "objectObserved",
      "observedType",
      "path",
      "presentCount",
      "sampleCount",
    ]);
  });

  it("changes no Advanced Reports behaviour", () => {
    const code = codeOf(ADAPTER_SRC);
    // The payment/finance surface is Advanced Reports, and it is untouched by this phase.
    assert.ok(code.includes("/advancedreports/1.0"));
    // Advanced Reports gained a probe of its own later, on a separate chain. What matters here is
    // that the Events probe neither reaches it nor changes it.
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.events.reportId, undefined);
    assert.ok(!RAKUTEN_CERTIFICATION_SPECS.events.csv);
    const production = code.split("async fetchAdvancedReport")[1].split("async fetchPaymentHistory")[0];
    assert.ok(production.includes("[1, 2, 3, 22, 23]"));
  });
});

describe("item rows are not collapsed into orders", () => {
  it("keeps etransaction_id and order_id as distinct fields", async () => {
    const paths = (await certifyEvents(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(paths.includes("etransaction_id"));
    assert.ok(paths.includes("order_id"));
    assert.notEqual(ONE_EVENT[0].etransaction_id, ONE_EVENT[0].order_id);
  });

  it("does not dedupe or group two item rows sharing one order_id", async () => {
    // Both rows carry the same order_id and different etransaction_id and SKU. Certification keeps
    // ONE row because of the row bound — never because it merged them.
    assert.equal(TWO_ITEMS_ONE_ORDER[0].order_id, TWO_ITEMS_ONE_ORDER[1].order_id);
    const rows = await sampleEvents(adapterWith(spyHttp(TWO_ITEMS_ONE_ORDER)));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], TWO_ITEMS_ONE_ORDER[0]);

    const row = (await certifyEvents(adapterWith(spyHttp(TWO_ITEMS_ONE_ORDER)))).results[0];
    assert.equal(row.sampleCount, 1);
    // A merged row would carry an array or object where a scalar belongs.
    for (const field of row.fieldPaths) {
      assert.equal(field.arrayObserved, false, field.path);
      assert.equal(field.objectObserved, false, field.path);
    }
  });

  it("contains no grouping or aggregation of its own", () => {
    const code = codeOf(ADAPTER_SRC);
    const service = codeOf(SERVICE_SRC);
    for (const forbidden of ["groupBy", "dedupeByOrder", "aggregateOrder", "sumCommissions"]) {
      assert.ok(!code.includes(forbidden), `adapter: ${forbidden}`);
      assert.ok(!service.includes(forbidden), `service: ${forbidden}`);
    }
  });
});

describe("adjustments and cancellations are structurally valid", () => {
  it("accepts a negative sale_amount", async () => {
    const row = (await certifyEvents(adapterWith(spyHttp(NEGATIVE_EVENT)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.equal(row.fieldPaths.find((f) => f.path === "sale_amount").observedType, "NUMBER");
  });

  it("accepts negative commissions", async () => {
    const row = (await certifyEvents(adapterWith(spyHttp(NEGATIVE_EVENT)))).results[0];
    assert.equal(row.fieldPaths.find((f) => f.path === "commissions").observedType, "NUMBER");
    assert.equal(row.fieldPaths.find((f) => f.path === "quantity").observedType, "NUMBER");
  });

  it("rejects nothing and drops nothing for being negative", async () => {
    const rows = await sampleEvents(adapterWith(spyHttp(NEGATIVE_EVENT)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sale_amount, -8123.47);
    assert.equal(rows[0].commissions, -4372.19);
  });

  it("invents no approved/cancelled mapping for is_event or lock_status", async () => {
    const serialised = JSON.stringify(await certifyEvents(adapterWith(spyHttp())));
    for (const invented of [
      "APPROVED",
      "CANCELLED",
      "CANCELED",
      "PENDING",
      "REJECTED",
      "conversionStatus",
      "canonicalStatus",
    ]) {
      assert.ok(!serialised.includes(invented), invented);
    }
    // Both fields are reported as PATHS, with no canonical meaning attached.
    const paths = (await certifyEvents(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(paths.includes("is_event"));
    assert.ok(paths.includes("lock_status"));
  });
});

describe("nothing identifying, monetary or attributional can leak", () => {
  it("never returns u1", async () => {
    const serialised = JSON.stringify(await certifyEvents(adapterWith(spyHttp())));
    assert.ok(!serialised.includes("zzu1attributionzz"));
  });

  it("never returns supplier identifiers", async () => {
    const serialised = JSON.stringify(await certifyEvents(adapterWith(spyHttp())));
    for (const secret of [
      "zzetransactionidzz",
      "zzadvertiseridzz",
      "zzsidzz",
      "zzorderidzz",
      "zzofferidzz",
      "zzskunumberzz",
      "zzproductnamezz",
      "zzcommissionlistidzz",
      "zztransactiontypezz",
      "zziseventzz",
      "zzlockstatuszz",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns monetary or commission amounts", async () => {
    const serialised = JSON.stringify(await certifyEvents(adapterWith(spyHttp())));
    for (const amount of ["8123.47", "4372.19", "6291", "SGD"]) {
      assert.ok(!serialised.includes(amount), amount);
    }
    const negative = JSON.stringify(await certifyEvents(adapterWith(spyHttp(NEGATIVE_EVENT))));
    for (const amount of ["-8123.47", "-4372.19", "8123.47", "4372.19"]) {
      assert.ok(!negative.includes(amount), amount);
    }
  });

  it("never returns dates from the row itself", async () => {
    const serialised = JSON.stringify(await certifyEvents(adapterWith(spyHttp())));
    for (const rowDate of ["2031-03-17", "2031-03-16", "2031-04-19"]) {
      assert.ok(!serialised.includes(rowDate), rowDate);
    }
  });

  it("never returns credentials, headers or the raw row", async () => {
    const serialised = JSON.stringify(await certifyEvents(adapterWith(spyHttp())));
    for (const secret of [TOKEN, SECURITY_TOKEN, "Bearer", "Authorization", "headers"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("returns only the safe result keys", async () => {
    const row = (await certifyEvents(adapterWith(spyHttp()))).results[0];
    for (const forbidden of ["rows", "sample", "payload", "body", "raw", "data"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
    for (const expected of [
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

describe("the events outcome vocabulary", () => {
  it("is registered under the catalog's own source-object name", () => {
    // The Rakuten catalog already calls this object "events". A second name for the same endpoint
    // would make it answerable under two identifiers.
    assert.ok(listProbeSourceObjects("rakuten").includes("events"));
    assert.equal(getSourceObject("rakuten", "events")?.endpoint, "GET /events/1.0/transactions");
    assert.equal(getSourceObject("rakuten", "events")?.entityType, "conversion");
    assert.equal(getSourceObject("rakuten", "conversions"), null);
    assert.ok(!listProbeSourceObjects("rakuten").includes("conversions"));
  });

  it("names the real request contract in its endpointKey", async () => {
    const row = (await certifyEvents(adapterWith(spyHttp()))).results[0];
    assert.equal(
      row.endpointKey,
      "GET /events/1.0/transactions (process_date window, limit=1, page=1)",
    );
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "events");
    // A stable template: no rendered date may appear in the key.
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(row.endpointKey));
  });

  it("reports OK with a structural field dictionary when a row is parsed", async () => {
    const row = (await certifyEvents(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.ok(row.fieldCount > 0);
  });

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for an empty array", async () => {
    const row = (await certifyEvents(adapterWith(spyHttp([])))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
    assert.equal(row.windowPreset, "7d");
  });

  it("invents no account-state finding from an empty window", async () => {
    // An empty window on an API that retains only the last week or two means the window held
    // nothing. It is not evidence of an unsupported object, a missing partnership or a blocker.
    const serialised = JSON.stringify(await certifyEvents(adapterWith(spyHttp([]))));
    for (const invented of [
      "NEEDS_ACTIVE_PARTNERSHIP",
      "NO_JOINED_CAMPAIGNS",
      "accountStateBlocker",
      "NOT_SUPPORTED",
      "UNSUPPORTED",
      "AUTH",
    ]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("preserves an auth rejection safely", async () => {
    const error = new Error("zzupstreamauthmessagezz");
    error.response = { status: 401, data: { message: "zzupstreambodyzz" } };
    const row = (await certifyEvents(adapterWith(spyHttp(error)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.equal(row.supplierStatusCode, 401);

    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(TOKEN));
    assert.ok(!serialised.includes(SECURITY_TOKEN));
    assert.ok(!serialised.includes("zzupstreambodyzz"), "no supplier response body");
  });

  it("preserves a rejected request safely", async () => {
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: {} };
    const row = (await certifyEvents(adapterWith(spyHttp(error)))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
  });
});

describe("the sample is bounded to one row, twice and independently", () => {
  it("slices in the adapter", async () => {
    assert.equal(RAKUTEN_CERTIFICATION_MAX_ROWS, 1);
    assert.equal((await sampleEvents(adapterWith(spyHttp(TWO_ITEMS_ONE_ORDER)))).length, 1);
  });

  it("slices again in the service, independently of the adapter", async () => {
    const unbounded = {
      ...adapterWith(spyHttp(TWO_ITEMS_ONE_ORDER)),
      fetchCertificationSample: async () => TWO_ITEMS_ONE_ORDER,
    };
    assert.equal(TWO_ITEMS_ONE_ORDER.length, 2);
    assert.equal((await certifyEvents(unbounded)).results[0].sampleCount, 1);
  });

  it("never returns the second row's values", async () => {
    const serialised = JSON.stringify(
      await certifyEvents(adapterWith(spyHttp(TWO_ITEMS_ONE_ORDER))),
    );
    for (const secret of ["zzsecondetidzz", "zzsecondskuzz", "2222.22", "zzsharedorderidzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });
});

describe("read-only, and production behaviour unchanged", () => {
  it("performs no database read or write", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    assert.equal((await certifyEvents(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain that certifies this object", () => {
    const code = codeOf(SERVICE_SRC);
    const chain = code.slice(
      code.indexOf("async certifyRakutenSample("),
      code.indexOf("async certifyAwinCommissionGroups("),
    );
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("leaves the Rakuten sync job untouched by certification", () => {
    const sync = codeOf(readFileSync("src/jobs/rakutenSupplierSync.js", "utf8"));
    assert.ok(!sync.includes("fetchCertificationSample"));
    assert.ok(!sync.includes("Certification"));
    // The sync still reads conversions through production's own fetcher.
    assert.ok(sync.includes("fetchConversions"));
  });

  it("adds no backfill, persistence or reconciliation path", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const absent of [
      "backfill",
      "reconcile",
      "persistConversion",
      "saveTransaction",
      "fetchProducts",
    ]) {
      assert.ok(!code.includes(absent), absent);
    }
  });

  it("keeps the spec table and every entry frozen", () => {
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_SPECS));
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_SPECS.events));
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_SPECS.events.needs));
  });

  it("leaves every other Rakuten object sending its own request unchanged", async () => {
    const jsonSpy = spyHttp({ advertisers: [{ id: "zzadvzz" }] });
    await adapterWith(jsonSpy).fetchCertificationSample("advertisers", { window: WINDOW });
    assert.equal(jsonSpy.calls[0].path, "/v2/advertisers");
    assert.deepEqual(jsonSpy.calls[0].config.params, { limit: 1, page: 1 });

    const offerSpy = spyHttp({ offers: [{ id: "zzofferzz" }] });
    await adapterWith(offerSpy).fetchCertificationSample("offers", { window: WINDOW });
    assert.deepEqual(offerSpy.calls[0].config.params, {
      limit: 1,
      page: 1,
      offer_status: "available",
    });
  });
});
