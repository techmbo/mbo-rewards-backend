import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.AWIN_MIN_INTERVAL_MS = "1";
process.env.LOG_LEVEL = "silent";

const { createAwinAdapter, listAwinCertificationSamples } = await import(
  "../src/adapters/awin.adapter.js"
);
const { NetworkCertificationService, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);

const ADAPTER_SRC = readFileSync("src/adapters/awin.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

const TOKEN = "zzaccesstokenzz";
const PUBLISHER_ID = "zzpub9876zz";

const TRANSACTION_ROW = {
  id: 778899,
  orderRef: "zzorderrefzz",
  saleAmount: { amount: 125.99, currency: "GBP" },
  basketProducts: [{ productId: "zzskuzz", quantity: 2 }],
};

const envelope = (rows) => ({ data: { transactions: rows } });

function spyHttp(response) {
  const calls = [];
  const handler = async (method, path, a, b) => {
    const config = method === "post" ? b : a;
    calls.push({ method, path, body: method === "post" ? a : undefined, config: config ?? {}, params: config?.params });
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    calls,
    client: {
      get: (path, config) => handler("get", path, config),
      post: (path, body, config) => handler("post", path, body, config),
    },
  };
}

function serviceWith(response) {
  const spy = spyHttp(response);
  return {
    spy,
    service: new NetworkCertificationService({
      prisma: {},
      adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: spy.client }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    }),
  };
}

/** All three probes in ONE run, so they share a resolved window and compare directly. */
async function bothRequests(response = envelope([TRANSACTION_ROW])) {
  const { service, spy } = serviceWith(response);
  const result = await service.certify("awin", {
    sourceObjects: ["conversions", "conversions_enddate_iso", "conversions_both_dates_iso"],
  });
  const baseline = spy.calls[0];
  const variant = spy.calls[1];
  const bothDates = spy.calls[2];
  return { result, spy, baseline, variant, bothDates };
}

/* ------------------------------------------------------- registration */

describe("the isolation probe is registered alongside the original", () => {
  it("1 - all three conversions probes exist, and the original is untouched", () => {
    const objects = listProbeSourceObjects("awin");
    assert.ok(objects.includes("conversions"), "the original probe was replaced");
    assert.ok(objects.includes("conversions_enddate_iso"));
    assert.ok(objects.includes("conversions_both_dates_iso"));
    assert.deepEqual([...objects].sort(), [...listAwinCertificationSamples()].sort());
  });

  it("2 - the variant DERIVES from the conversions spec rather than restating it", () => {
    // Structural, not a claim: everything but params is the same object.
    assert.match(ADAPTER_SRC, /^  conversions: AWIN_CONVERSIONS_SPEC,$/m);
    assert.match(ADAPTER_SRC, /\.\.\.AWIN_CONVERSIONS_SPEC,/);
    assert.match(ADAPTER_SRC, /const base = AWIN_CONVERSIONS_SPEC\.params\(resolved\);/);
    assert.match(ADAPTER_SRC, /return \{ \.\.\.base, endDate: `\$\{base\.endDate\}T00:00:00` \};/);
  });

  it("3 - each endpointKey says what it is, and the original's is unchanged", () => {
    assert.match(SERVICE_SRC, /endpointKey: "GET \/publishers\/\{publisherId\}\/transactions\/",/);
    assert.match(
      SERVICE_SRC,
      /endpointKey: "GET \/publishers\/\{publisherId\}\/transactions\/ \(endDate as ISO datetime\)",/,
    );
    assert.match(
      SERVICE_SRC,
      /endpointKey: "GET \/publishers\/\{publisherId\}\/transactions\/ \(both dates as ISO datetime\)",/,
    );
  });

  it("3b - the both-dates variant also DERIVES rather than restating", () => {
    assert.match(ADAPTER_SRC, /conversions_both_dates_iso: Object\.freeze\(\{\s*\.\.\.AWIN_CONVERSIONS_SPEC,/);
    const start = ADAPTER_SRC.indexOf("  conversions_both_dates_iso:");
    const spec = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n  }),", start));
    assert.match(spec, /const base = AWIN_CONVERSIONS_SPEC\.params\(resolved\);/);
    assert.ok(!/resolved\.window\./.test(spec), "the variant reads the window directly");
    // It overrides exactly the two date keys and nothing else.
    assert.deepEqual(
      [...new Set([...spec.matchAll(/^\s+([A-Za-z]+): `/gm)].map((m) => m[1]))].sort(),
      ["endDate", "startDate"],
    );
  });
});

/* ------------------------------------------------------- the isolation itself */

describe("endDate is the ONLY request-level difference", () => {
  it("4 - the two requests differ in exactly one query key", async () => {
    const { baseline, variant } = await bothRequests();

    assert.deepEqual(
      Object.keys(baseline.params).sort(),
      Object.keys(variant.params).sort(),
      "the variant added or dropped a parameter",
    );

    const differing = Object.keys(baseline.params).filter(
      (key) => baseline.params[key] !== variant.params[key],
    );
    assert.deepEqual(differing, ["endDate"], "something other than endDate differs");
  });

  it("5 - path, method, body and config are identical", async () => {
    const { baseline, variant } = await bothRequests();
    assert.equal(variant.path, baseline.path);
    assert.equal(variant.path, `/publishers/${PUBLISHER_ID}/transactions/`);
    assert.equal(variant.method, "get");
    assert.equal(variant.method, baseline.method);
    assert.equal(variant.body, undefined);
    assert.equal(baseline.body, undefined);
    assert.deepEqual(Object.keys(variant.config).sort(), Object.keys(baseline.config).sort());
    assert.deepEqual(Object.keys(variant.config).sort(), ["params", "timeout"]);
  });

  it("6 - every other parameter keeps production's value", async () => {
    const { baseline, variant } = await bothRequests();
    assert.equal(variant.params.startDate, baseline.params.startDate);
    assert.match(variant.params.startDate, /^\d{4}-\d{2}-\d{2}$/, "startDate is no longer date-only");
    assert.equal(variant.params.dateType, "transaction");
    assert.equal(variant.params.showBasketProducts, true);
    assert.equal(variant.params.status, undefined, "a status filter appeared");
    assert.equal(variant.params.timezone, undefined, "timezone changed during the isolation");
  });

  it("7 - endDate is the same calendar day, serialised as an ISO datetime", async () => {
    const { baseline, variant } = await bothRequests();
    assert.match(variant.params.endDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.equal(variant.params.endDate, `${baseline.params.endDate}T00:00:00`);
    // Midnight, not end-of-day: the same instant the date-only value denoted, so the window is not
    // a second variable. No offset and no "Z" — the repo evidences neither.
    assert.ok(variant.params.endDate.endsWith("T00:00:00"));
    assert.ok(!/Z|[+-]\d{2}:\d{2}$/.test(variant.params.endDate), "a timezone offset was introduced");
  });

  it("8 - the window is still 7d, and still the service's own", async () => {
    const { baseline, variant, result } = await bothRequests();
    const entry = result.results.find((r) => r.sourceObject === "conversions_enddate_iso");
    assert.equal(entry.windowPreset, "7d");
    const days =
      (Date.parse(variant.params.endDate) - Date.parse(variant.params.startDate)) / 86400000;
    assert.equal(Math.round(days), 7);
    assert.equal(baseline.params.startDate, variant.params.startDate);
  });
});

describe("the both-dates variant differs from base in exactly the two dates", () => {
  it("B1 - the key sets are identical and exactly two values differ", async () => {
    const { baseline, bothDates } = await bothRequests();
    assert.deepEqual(
      Object.keys(baseline.params).sort(),
      Object.keys(bothDates.params).sort(),
      "the variant added or dropped a parameter",
    );
    const differing = Object.keys(baseline.params)
      .filter((key) => baseline.params[key] !== bothDates.params[key])
      .sort();
    assert.deepEqual(differing, ["endDate", "startDate"]);
  });

  it("B2 - both dates are ISO datetimes at midnight, same calendar days as the base", async () => {
    const { baseline, bothDates } = await bothRequests();
    assert.equal(bothDates.params.startDate, `${baseline.params.startDate}T00:00:00`);
    assert.equal(bothDates.params.endDate, `${baseline.params.endDate}T00:00:00`);
    for (const value of [bothDates.params.startDate, bothDates.params.endDate]) {
      assert.match(value, /^\d{4}-\d{2}-\d{2}T00:00:00$/);
      assert.ok(!/Z|[+-]\d{2}:\d{2}$/.test(value), "a timezone offset was introduced");
    }
  });

  it("B3 - it differs from the endDate-only variant in startDate alone", async () => {
    const { variant, bothDates } = await bothRequests();
    const differing = Object.keys(variant.params)
      .filter((key) => variant.params[key] !== bothDates.params[key])
      .sort();
    assert.deepEqual(differing, ["startDate"], "the two variants differ in more than startDate");
    assert.equal(bothDates.params.endDate, variant.params.endDate);
  });

  it("B4 - every other parameter keeps production's value", async () => {
    const { bothDates } = await bothRequests();
    assert.equal(bothDates.params.dateType, "transaction");
    assert.equal(bothDates.params.showBasketProducts, true);
    assert.equal(bothDates.params.status, undefined, "a status filter appeared");
    assert.equal(bothDates.params.timezone, undefined, "timezone changed during the isolation");
    assert.equal(bothDates.path, `/publishers/${PUBLISHER_ID}/transactions/`);
    assert.equal(bothDates.method, "get");
    assert.equal(bothDates.body, undefined);
    assert.deepEqual(Object.keys(bothDates.config).sort(), ["params", "timeout"]);
  });

  it("B5 - the window is still exactly 7 days wide", async () => {
    const { bothDates, result } = await bothRequests();
    const days =
      (Date.parse(bothDates.params.endDate) - Date.parse(bothDates.params.startDate)) / 86400000;
    assert.equal(Math.round(days), 7);
    const entry = result.results.find((r) => r.sourceObject === "conversions_both_dates_iso");
    assert.equal(entry.windowPreset, "7d");
  });

  it("B6 - it behaves like the others on rows, zero rows and failure", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ ...TRANSACTION_ROW, id: 960000 + i }));
    const { service: full } = serviceWith(envelope(many));
    const okRun = await full.certify("awin", { sourceObjects: ["conversions_both_dates_iso"] });
    assert.equal(okRun.results[0].sampleCount, 1);
    assert.equal(okRun.results[0].orderItems.present, true);

    const { service: none } = serviceWith(envelope([]));
    const emptyRun = await none.certify("awin", { sourceObjects: ["conversions_both_dates_iso"] });
    assert.equal(emptyRun.results[0].statusCategory, "OK_NO_ROWS");
    assert.equal(emptyRun.results[0].schema, "UNKNOWN_NEEDS_LIVE_DATA");

    const failure = Object.assign(new Error("400"), {
      response: { status: 400, data: { message: "Wrong data type for parameter 'startDate'" } },
    });
    const { service: bad, spy } = serviceWith(failure);
    const badRun = await bad.certify("awin", { sourceObjects: ["conversions_both_dates_iso"] });
    assert.equal(spy.calls.length, 1, "the failing request was retried");
    assert.equal(badRun.results[0].supplierStatusCode, 400);
    assert.equal(badRun.results[0].supplierMessage, "Wrong data type for parameter 'startDate'");
  });
});

/* ------------------------------------------------------- bounds unchanged */

describe("nothing about the probe's limits changed", () => {
  it("9 - one request per probe, and no retry", async () => {
    const { spy } = await bothRequests();
    assert.equal(spy.calls.length, 3, "a probe made more than one request");

    const failure = Object.assign(new Error("boom"), {
      response: { status: 400, data: { message: "Wrong data type for parameter 'endDate'" } },
    });
    const { service, spy: failSpy } = serviceWith(failure);
    const result = await service.certify("awin", { sourceObjects: ["conversions_enddate_iso"] });
    assert.equal(failSpy.calls.length, 1, "the failing request was retried");
    assert.equal(result.results[0].statusCategory, "REQUEST_REJECTED");
    assert.equal(result.results[0].supplierStatusCode, 400);
    // The supplier's own words survive, which is how the next outcome gets read.
    assert.equal(result.results[0].supplierMessage, "Wrong data type for parameter 'endDate'");
  });

  it("10 - one row is kept, and zero rows stays honest", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...TRANSACTION_ROW, id: 950000 + i }));
    const { service } = serviceWith(envelope(many));
    const full = await service.certify("awin", { sourceObjects: ["conversions_enddate_iso"] });
    assert.equal(full.results[0].sampleCount, 1);

    const { service: empty } = serviceWith(envelope([]));
    const none = await empty.certify("awin", { sourceObjects: ["conversions_enddate_iso"] });
    assert.equal(none.results[0].statusCategory, "OK_NO_ROWS");
    assert.equal(none.results[0].schema, "UNKNOWN_NEEDS_LIVE_DATA");
  });

  it("11 - it reports order items exactly as the original does", async () => {
    const { result } = await bothRequests();
    const baseline = result.results.find((r) => r.sourceObject === "conversions");
    const variant = result.results.find((r) => r.sourceObject === "conversions_enddate_iso");
    assert.deepEqual(
      variant.orderItems.itemFieldPaths.map((f) => f.path).sort(),
      baseline.orderItems.itemFieldPaths.map((f) => f.path).sort(),
    );
    assert.equal(variant.orderItems.present, true);
    assert.equal(variant.orderItems.observedType, "ARRAY");
  });

  it("12 - read-only: no write reaches the chain", () => {
    const start = SERVICE_SRC.indexOf("async certifyAwinConversions(");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.ok(!/this\.db\.|prisma\.|\.create\(|\.update\(|\.upsert\(/.test(body), "the chain writes");
    assert.ok(!/for \(|while \(/.test(body), "the chain loops");
  });

  it("13 - redaction still holds on the variant", async () => {
    const leaky = Object.assign(new Error("400"), {
      response: { status: 400, data: { message: `publisher ${PUBLISHER_ID} sent a bad endDate`, token: TOKEN } },
    });
    const { service } = serviceWith(leaky);
    const result = await service.certify("awin", { sourceObjects: ["conversions_enddate_iso"] });
    const serialised = JSON.stringify(result);
    for (const banned of [TOKEN, PUBLISHER_ID]) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
    assert.match(result.results[0].supplierMessage, /sent a bad endDate/);
  });

  it("14 - no value from a sampled row escapes either", async () => {
    const { result } = await bothRequests();
    const serialised = JSON.stringify(result);
    for (const banned of ["zzorderrefzz", "zzskuzz", "125.99", "GBP", "778899", TOKEN, PUBLISHER_ID]) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
  });
});

/* ------------------------------------------------------- production untouched */

describe("production is untouched", () => {
  it("15 - fetchConversions still sends both dates date-only", () => {
    const sync = readFileSync("src/jobs/waveESupplierSync.js", "utf8");
    assert.match(sync, /startDate: awinFrom\.toISOString\(\)\.slice\(0, 10\),/);
    assert.match(sync, /endDate: awinTo\.toISOString\(\)\.slice\(0, 10\),/);
    assert.ok(!/T00:00:00/.test(sync), "production gained a datetime");
    assert.match(ADAPTER_SRC, /async fetchConversions\(params = \{\}, stats = null\) \{/);
  });

  it("16 - the T00:00:00 suffix exists in exactly one place, the variant", () => {
    const occurrences = (ADAPTER_SRC.match(/T00:00:00/g) || []).length;
    // Once in the spec, and once in the comment that explains the choice.
    assert.ok(occurrences <= 6, `${occurrences} occurrences`);
    const code = ADAPTER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Three in code: endDate in variant 1, and startDate + endDate in variant 2. Nowhere else.
    assert.equal((code.match(/T00:00:00/g) || []).length, 3, "a datetime appeared outside the variants");
    const fetcher = ADAPTER_SRC.slice(
      ADAPTER_SRC.indexOf("async fetchConversions("),
      ADAPTER_SRC.indexOf("async fetchPayments("),
    );
    assert.ok(!fetcher.includes("T00:00:00"), "the production fetcher gained a datetime");
  });

  it("17 - campaigns and coupons probes are unchanged", () => {
    assert.match(ADAPTER_SRC, /params: \(\) => \(\{ relationship: "joined" \}\)/);
    assert.match(ADAPTER_SRC, /body: \(\) => \(\{ filters: \{\}, pagination: \{ page: 1, pageSize: 200 \} \}\)/);
  });
});
