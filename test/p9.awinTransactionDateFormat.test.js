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

const {
  createAwinAdapter,
  awinTransactionDateParam,
  listAwinCertificationSamples,
  AWIN_MAX_TRANSACTION_WINDOW_DAYS,
} = await import("../src/adapters/awin.adapter.js");
const { NetworkCertificationService, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);

const ADAPTER_SRC = readFileSync("src/adapters/awin.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/waveESupplierSync.js", "utf8");

const TOKEN = "zzaccesstokenzz";
const PUBLISHER_ID = "zzpub9876zz";
const DATETIME = /^\d{4}-\d{2}-\d{2}T00:00:00$/;

const envelope = (rows) => ({ data: { transactions: rows } });

function spyHttp(response = envelope([])) {
  const calls = [];
  const handler = async (method, path, a, b) => {
    const config = method === "post" ? b : a;
    calls.push({ method, path, params: config?.params, config: config ?? {} });
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

function adapterWith(response) {
  const spy = spyHttp(response);
  return { spy, adapter: createAwinAdapter({ accessToken: TOKEN, publisherId: PUBLISHER_ID, httpClient: spy.client }) };
}

async function certifyConversions(response = envelope([])) {
  const spy = spyHttp(response);
  const service = new NetworkCertificationService({
    prisma: {},
    adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: spy.client }),
    awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
  });
  const result = await service.certify("awin", { sourceObjects: ["conversions"] });
  return { result, spy, call: spy.calls[0] };
}

/* ------------------------------------------------------- the serializer */

describe("the confirmed transaction date format", () => {
  it("1 - a bare date becomes an ISO datetime at midnight", () => {
    assert.equal(awinTransactionDateParam("2026-09-14"), "2026-09-14T00:00:00");
    assert.equal(awinTransactionDateParam("2026-01-01"), "2026-01-01T00:00:00");
    assert.match(awinTransactionDateParam("2026-09-14"), DATETIME);
  });

  it("2 - a value that is already a datetime passes through untouched", () => {
    // Appending twice would produce exactly the malformed parameter this fixes.
    assert.equal(awinTransactionDateParam("2026-09-14T00:00:00"), "2026-09-14T00:00:00");
    assert.equal(awinTransactionDateParam("2026-09-14T13:45:01"), "2026-09-14T13:45:01");
    assert.ok(!awinTransactionDateParam("2026-09-14T00:00:00").includes("T00:00:00T"));
  });

  it("3 - anything that is not a bare date is left alone", () => {
    for (const value of ["", "not a date", "2026-09", "20260914", "2026-9-4"]) {
      assert.equal(awinTransactionDateParam(value), value, JSON.stringify(value));
    }
    assert.equal(awinTransactionDateParam(null), "");
    assert.equal(awinTransactionDateParam(undefined), "");
  });

  it("4 - no Z and no offset: the live-accepted form exactly", () => {
    const out = awinTransactionDateParam("2026-09-14");
    assert.ok(!/Z$/.test(out), "a Z suffix was introduced");
    assert.ok(!/[+-]\d{2}:\d{2}$/.test(out), "a timezone offset was introduced");
    assert.ok(!/\.\d{3}/.test(out), "milliseconds were introduced");
  });
});

/* ------------------------------------------------------- production */

describe("production sends the confirmed format", () => {
  it("5 - fetchConversions serialises both dates as datetimes", async () => {
    const { adapter, spy } = adapterWith();
    await adapter.fetchConversions({ startDate: "2026-09-01", endDate: "2026-09-08" });

    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].params.startDate, "2026-09-01T00:00:00");
    assert.equal(spy.calls[0].params.endDate, "2026-09-08T00:00:00");
    assert.match(spy.calls[0].params.startDate, DATETIME);
    assert.match(spy.calls[0].params.endDate, DATETIME);
  });

  it("6 - everything else about the production request is unchanged", async () => {
    const { adapter, spy } = adapterWith();
    await adapter.fetchConversions({ startDate: "2026-09-01", endDate: "2026-09-08" });
    const { params, path, method } = spy.calls[0];

    assert.equal(method, "get");
    assert.equal(path, `/publishers/${PUBLISHER_ID}/transactions/`);
    assert.equal(params.dateType, "transaction");
    assert.equal(params.showBasketProducts, true);
    assert.equal(params.status, undefined, "a status filter appeared");
    assert.equal(params.timezone, undefined, "timezone was added in this task");
  });

  it("7 - an explicitly supplied status or timezone still passes through", async () => {
    const { adapter, spy } = adapterWith();
    await adapter.fetchConversions({
      startDate: "2026-09-01",
      endDate: "2026-09-08",
      status: "approved",
      timezone: "UTC",
      dateType: "validation",
    });
    assert.equal(spy.calls[0].params.status, "approved");
    assert.equal(spy.calls[0].params.timezone, "UTC");
    assert.equal(spy.calls[0].params.dateType, "validation");
  });

  it("8 - a caller that already passes datetimes is not double-suffixed", async () => {
    const { adapter, spy } = adapterWith();
    await adapter.fetchConversions({ startDate: "2026-09-01T00:00:00", endDate: "2026-09-08T00:00:00" });
    assert.equal(spy.calls[0].params.startDate, "2026-09-01T00:00:00");
    assert.equal(spy.calls[0].params.endDate, "2026-09-08T00:00:00");
  });

  it("9 - the sync job still builds bare dates, and the adapter normalises them", () => {
    // The serialization lives in ONE place, so every caller gets it regardless of what it passes.
    assert.match(SYNC_SRC, /startDate: awinFrom\.toISOString\(\)\.slice\(0, 10\),/);
    assert.match(SYNC_SRC, /endDate: awinTo\.toISOString\(\)\.slice\(0, 10\),/);
    assert.match(ADAPTER_SRC, /startDate: awinTransactionDateParam\(startDate\),/);
    assert.match(ADAPTER_SRC, /endDate: awinTransactionDateParam\(endDate\),/);
  });
});

/* ------------------------------------------------------- alignment */

describe("production and certification serialise identically", () => {
  it("10 - both go through the one function", () => {
    const uses = (ADAPTER_SRC.match(/awinTransactionDateParam\(/g) || []).length;
    // One definition, two in the production fetcher, two in the certification spec.
    assert.equal(uses, 5, `${uses} references`);
    assert.match(ADAPTER_SRC, /startDate: awinTransactionDateParam\(resolved\.window\.from\),/);
    assert.match(ADAPTER_SRC, /endDate: awinTransactionDateParam\(resolved\.window\.to\),/);
  });

  it("11 - the two requests are byte-identical for a matching window", async () => {
    const { call } = await certifyConversions();
    const certParams = call.params;

    const { adapter, spy } = adapterWith();
    await adapter.fetchConversions({
      startDate: certParams.startDate.slice(0, 10),
      endDate: certParams.endDate.slice(0, 10),
    });
    const prodParams = spy.calls[0].params;

    assert.deepEqual(prodParams, certParams, "production and certification diverged");
    assert.equal(spy.calls[0].path, call.path);
  });

  it("12 - the certification probe sends datetimes too", async () => {
    const { call } = await certifyConversions();
    assert.match(call.params.startDate, DATETIME);
    assert.match(call.params.endDate, DATETIME);
    assert.equal(call.params.dateType, "transaction");
    assert.equal(call.params.showBasketProducts, true);
  });

  it("13 - NO date-only transaction request remains anywhere", async () => {
    const { call } = await certifyConversions();
    const { adapter, spy } = adapterWith();
    await adapter.fetchConversions({ startDate: "2026-09-01", endDate: "2026-09-08" });

    for (const params of [call.params, spy.calls[0].params]) {
      for (const key of ["startDate", "endDate"]) {
        assert.ok(!/^\d{4}-\d{2}-\d{2}$/.test(params[key]), `${key} is still date-only`);
        assert.match(params[key], DATETIME, key);
      }
    }
  });
});

/* ------------------------------------------------------- limits kept */

describe("the 31-day ceiling still holds", () => {
  it("14 - production refuses a wider window before requesting", async () => {
    const { adapter, spy } = adapterWith();
    await assert.rejects(
      () => adapter.fetchConversions({ startDate: "2026-01-01", endDate: "2026-06-01" }),
      /Awin transaction window cannot exceed 31 days/,
    );
    assert.equal(spy.calls.length, 0, "an over-wide window reached the supplier");
  });

  it("15 - exactly 31 days is still accepted, and still serialised", async () => {
    const { adapter, spy } = adapterWith();
    await adapter.fetchConversions({ startDate: "2026-01-01", endDate: "2026-02-01" });
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].params.startDate, "2026-01-01T00:00:00");
    assert.equal(spy.calls[0].params.endDate, "2026-02-01T00:00:00");
  });

  it("16 - missing dates are still refused", async () => {
    const { adapter, spy } = adapterWith();
    await assert.rejects(
      () => adapter.fetchConversions({ startDate: "2026-09-01" }),
      /require startDate and endDate/,
    );
    assert.equal(spy.calls.length, 0);
  });

  it("17 - certification still refuses a 90d preset with no request", async () => {
    const spy = spyHttp();
    const service = new NetworkCertificationService({
      prisma: {},
      adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: spy.client }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    });
    const result = await service.certify("awin", {
      sourceObjects: ["conversions"],
      windowPreset: "90d",
    });
    assert.equal(spy.calls.length, 0);
    assert.equal(result.results[0].statusCategory, "WINDOW_EXCEEDS_SUPPLIER_LIMIT");
    assert.equal(AWIN_MAX_TRANSACTION_WINDOW_DAYS, 31);
  });
});

/* ------------------------------------------------------- probes removed */

describe("the isolation probes are gone", () => {
  it("18 - neither variant is registered any more", () => {
    const objects = listProbeSourceObjects("awin");
    // commission_groups was added after this phase and is probed by a dedicated sampler, so it has
    // a probe and no adapter sample spec. Neither isolation variant appears in either list.
    assert.deepEqual([...objects].sort(), ["campaigns", "commission_groups", "conversions", "coupons"]);
    assert.deepEqual([...listAwinCertificationSamples()].sort(), ["campaigns", "conversions", "coupons"]);
  });

  it("19 - no trace of them remains in the adapter or the service", () => {
    for (const name of ["conversions_enddate_iso", "conversions_both_dates_iso", "ISOLATION PROBE"]) {
      assert.ok(!ADAPTER_SRC.includes(name), `${name} remains in the adapter`);
      assert.ok(!SERVICE_SRC.includes(name), `${name} remains in the service`);
    }
  });

  it("20 - their test file is gone, and the base probe keeps its own endpointKey", async () => {
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync("test/p9.awinEndDateIsolation.test.js"));
    assert.match(SERVICE_SRC, /endpointKey: "GET \/publishers\/\{publisherId\}\/transactions\/",/);
    assert.ok(!/\(endDate as ISO datetime\)|\(both dates as ISO datetime\)/.test(SERVICE_SRC));
  });
});

/* ------------------------------------------------------- untouched */

describe("campaigns and coupons are untouched", () => {
  it("21 - neither probe gained a date parameter", () => {
    assert.match(ADAPTER_SRC, /params: \(\) => \(\{ relationship: "joined" \}\)/);
    assert.match(ADAPTER_SRC, /body: \(\) => \(\{ filters: \{\}, pagination: \{ page: 1, pageSize: 200 \} \}\)/);
  });

  it("22 - production fetchCampaigns and fetchCoupons are unchanged", () => {
    assert.match(ADAPTER_SRC, /relationship: params\.relationship \?\? "joined",/);
    assert.match(ADAPTER_SRC, /pagination: params\.pagination \?\? \{ page: 1, pageSize: 200 \}/);
    assert.match(ADAPTER_SRC, /await post\(`\/publisher\/\$\{pubId\}\/promotions`, body, stats\)/);
    // The date serializer touches transactions only.
    const coupons = ADAPTER_SRC.slice(
      ADAPTER_SRC.indexOf("async fetchCoupons("),
      ADAPTER_SRC.indexOf("async fetchConversions("),
    );
    assert.ok(!coupons.includes("awinTransactionDateParam"));
  });

  it("23 - retry behaviour is unchanged: production retries, the probe does not", () => {
    assert.match(ADAPTER_SRC, /requestWithRetry\(\s*\(\) => httpClient\.get\(path, \{ params \}\),\s*\{ retries: 3, delayMs: 1000 \},?\s*\)/);
    const sampler = ADAPTER_SRC.slice(
      ADAPTER_SRC.indexOf("async fetchCertificationSample("),
      ADAPTER_SRC.indexOf("\n    },", ADAPTER_SRC.indexOf("async fetchCertificationSample(")),
    );
    assert.ok(!sampler.includes("requestWithRetry"), "the probe gained retries");
  });
});
