import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { listPartnerizeCertificationSamples, createPartnerizeAdapter } = await import(
  "../src/adapters/partnerize.adapter.js"
);
const { NetworkCertificationService, WINDOW_PRESETS, DEFAULT_WINDOW_PRESET } = await import(
  "../src/modules/ops/networkCertification.service.js"
);

const ADAPTER_SRC = readFileSync(new URL("../src/adapters/partnerize.adapter.js", import.meta.url), "utf8");
const SERVICE_SRC = readFileSync(
  new URL("../src/modules/ops/networkCertification.service.js", import.meta.url),
  "utf8",
);

const ENDPOINT = "/reporting/report_publisher/publisher/{publisherId}/conversion.json";

/** Captures every request the adapter would make, and answers with a canned payload. */
function makeAdapter({ payload = { conversions: [] }, publisherId = "pub-1" } = {}) {
  const requests = [];
  const httpClient = {
    get: async (path, config) => {
      requests.push({ path, params: config?.params, timeout: config?.timeout });
      return { data: payload };
    },
  };
  const adapter = createPartnerizeAdapter({
    applicationKey: "zzappzz",
    userApiKey: "zzuserzz",
    publisherId,
    httpClient,
  });
  return { adapter, requests };
}

/* ------------------------------------------------------------- registration */

test("conversions is a registered Partnerize certification source object", () => {
  assert.ok(listPartnerizeCertificationSamples().includes("conversions"));
});

test("the probe declares the publisher-scoped reporting endpoint and GET", () => {
  assert.ok(SERVICE_SRC.includes(`endpointKey: "GET ${ENDPOINT}"`));
  const block = SERVICE_SRC.slice(
    SERVICE_SRC.indexOf("  conversions: {\n    method: \"GET\",\n    endpointKey: \"GET /reporting"),
  ).slice(0, 320);
  assert.ok(block.includes('method: "GET"'));
  assert.ok(block.includes('chain: "partnerizeConversions"'));
});

/* ------------------------------------------------- exactly the right request */

test("EXACT ENDPOINT: one GET to the publisher-scoped reporting path", async () => {
  const { adapter, requests } = makeAdapter();
  await adapter.fetchCertificationSample("conversions", {
    timeoutMs: 5000,
    window: { from: "2026-09-07", to: "2026-09-14" },
  });
  assert.equal(requests.length, 1, "exactly one supplier request");
  assert.equal(requests[0].path, "/reporting/report_publisher/publisher/pub-1/conversion.json");
});

test("ONE REQUEST MAXIMUM: the paginated fallback is never reached", async () => {
  const { adapter, requests } = makeAdapter();
  await adapter.fetchCertificationSample("conversions", {
    timeoutMs: 5000,
    window: { from: "2026-09-07", to: "2026-09-14" },
  });
  assert.equal(requests.length, 1);
  for (const request of requests) {
    assert.ok(!request.path.includes("/v3/partner/conversions"), "the fetchPaginated fallback");
  }
});

test("NO PAGINATION LOOP: no page, offset, limit or cursor parameter is sent", async () => {
  const { adapter, requests } = makeAdapter();
  await adapter.fetchCertificationSample("conversions", {
    timeoutMs: 5000,
    window: { from: "2026-09-07", to: "2026-09-14" },
  });
  const params = requests[0].params;
  assert.deepEqual(Object.keys(params).sort(), ["end_date", "start_date"]);
  for (const banned of ["page", "offset", "limit", "cursor", "per_page", "page_size"]) {
    assert.equal(params[banned], undefined, banned);
  }
});

test("the certification sample does not spread caller params like production fetchConversions", () => {
  // Production's fetchConversions spreads `...params` into the query. The certification spec must
  // not, or a caller could add a filter or an identifier to the supplier request.
  const spec = ADAPTER_SRC.slice(
    ADAPTER_SRC.indexOf("  conversions: {"),
    ADAPTER_SRC.indexOf("  vouchers: {"),
  );
  assert.ok(spec.includes("start_date: resolved.window.from"));
  assert.ok(spec.includes("end_date: resolved.window.to"));
  assert.ok(!spec.includes("...params"), "no caller spread");
  assert.ok(!spec.includes("ctx."), "the spec reads resolved values only");
});

/* ----------------------------------------------------- bounded date window */

test("WINDOW: dates come from the preset and a caller cannot supply them", async () => {
  const { adapter, requests } = makeAdapter();
  await adapter.fetchCertificationSample("conversions", {
    timeoutMs: 5000,
    window: { from: "2026-06-16", to: "2026-09-14" },
    // A caller attempting to smuggle dates in: the spec reads `resolved`, never ctx.
    start_date: "1999-01-01",
    end_date: "2099-01-01",
  });
  assert.equal(requests[0].params.start_date, "2026-06-16");
  assert.equal(requests[0].params.end_date, "2026-09-14");
});

test("WINDOW: only 7d / 30d / 90d exist and 7d is the default", () => {
  assert.deepEqual(Object.keys(WINDOW_PRESETS).sort(), ["30d", "7d", "90d"]);
  assert.equal(DEFAULT_WINDOW_PRESET, "7d");
});

test("a missing window is a hard error, never an undefined date", async () => {
  const { adapter, requests } = makeAdapter();
  await assert.rejects(
    () => adapter.fetchCertificationSample("conversions", { timeoutMs: 5000 }),
    /requires window/,
  );
  assert.equal(requests.length, 0, "no request may be sent without a window");
});

test("a missing publisher id is a hard error before any request", async () => {
  const { adapter, requests } = makeAdapter({ publisherId: null });
  await assert.rejects(() =>
    adapter.fetchCertificationSample("conversions", {
      timeoutMs: 5000,
      window: { from: "2026-09-07", to: "2026-09-14" },
    }),
  );
  assert.equal(requests.length, 0);
});

/* ------------------------------------------------------------ zero rows */

test("ZERO ROWS: reported as OK_NO_ROWS with the schema still unknown", async () => {
  const { adapter, requests } = makeAdapter({ payload: { conversions: [] } });
  const service = new NetworkCertificationService();
  const result = await service.certifyPartnerizeConversions({
    adapter,
    key: "PARTNERIZE",
    probe: { method: "GET", endpointKey: `GET ${ENDPOINT}` },
    window: { from: "2026-09-07", to: "2026-09-14", preset: "7d" },
    budgetLeft: () => 5000,
  });
  assert.equal(result.statusCategory, "OK_NO_ROWS");
  assert.equal(result.ok, true);
  assert.equal(result.sampleCount, 0);
  assert.equal(result.fieldCount, 0);
  assert.equal(result.schema, "UNKNOWN_NEEDS_LIVE_DATA");
  assert.equal(result.windowPreset, "7d");
  assert.equal(requests.length, 1, "still exactly one request");
});

test("zero rows is NOT reported as plain OK", async () => {
  const { adapter } = makeAdapter({ payload: { conversions: [] } });
  const service = new NetworkCertificationService();
  const result = await service.certifyPartnerizeConversions({
    adapter,
    key: "PARTNERIZE",
    probe: { method: "GET", endpointKey: `GET ${ENDPOINT}` },
    window: { from: "2026-09-07", to: "2026-09-14", preset: "7d" },
    budgetLeft: () => 5000,
  });
  assert.notEqual(result.statusCategory, "OK", "an empty window must be distinguishable");
});

/* ------------------------------------------------------- one row, no values */

test("ONE ROW: a field dictionary is produced and NO value is reported", async () => {
  const row = {
    conversion_id: "CONV-123456",
    campaign_id: "1011l6400",
    publisher_reference: "order-abc-789",
    publisher_commission: "12.3400",
    conversion_value: "199.9900",
    currency: "EUR",
    conversion_time: "2026-09-12T10:00:00Z",
    conversion_status: "approved",
    customer_email: "shopper@example.com",
    adref: "client-9",
    pubref: "assignment-7",
    clickref: "click-42",
  };
  const { adapter } = makeAdapter({ payload: { conversions: [{ conversion: row }] } });
  const service = new NetworkCertificationService();
  const result = await service.certifyPartnerizeConversions({
    adapter,
    key: "PARTNERIZE",
    probe: { method: "GET", endpointKey: `GET ${ENDPOINT}` },
    window: { from: "2026-09-07", to: "2026-09-14", preset: "7d" },
    budgetLeft: () => 5000,
  });

  assert.equal(result.statusCategory, "OK");
  assert.equal(result.sampleCount, 1);
  assert.ok(result.fieldCount > 0);

  const paths = result.fieldPaths.map((f) => f.path);
  for (const expected of ["conversion_id", "publisher_commission", "conversion_value", "currency"]) {
    assert.ok(paths.includes(expected), `${expected} missing from the dictionary`);
  }

  // NO financial, order or customer VALUE may appear anywhere in the result.
  const serialised = JSON.stringify(result);
  for (const value of [
    "CONV-123456", "order-abc-789", "12.3400", "199.9900",
    "shopper@example.com", "client-9", "assignment-7", "click-42", "1011l6400",
  ]) {
    assert.ok(!serialised.includes(value), `value leaked: ${value}`);
  }
});

test("SAMPLE BOUND: only one row is held even when the response carries many", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ conversion: { conversion_id: `C-${i}` } }));
  const { adapter } = makeAdapter({ payload: { conversions: rows } });
  const service = new NetworkCertificationService();
  const result = await service.certifyPartnerizeConversions({
    adapter,
    key: "PARTNERIZE",
    probe: { method: "GET", endpointKey: `GET ${ENDPOINT}` },
    window: { from: "2026-09-07", to: "2026-09-14", preset: "7d" },
    budgetLeft: () => 5000,
  });
  assert.equal(result.sampleCount, 1);
  assert.ok(!JSON.stringify(result).includes("C-7"));
});

/* ---------------------------------------------------------- safety, no writes */

test("NO WRITES: the handler touches no repository or prisma client", () => {
  const handler = SERVICE_SRC.slice(
    SERVICE_SRC.indexOf("async certifyPartnerizeConversions("),
    SERVICE_SRC.indexOf("async certifyPartnerizeVouchers("),
  );
  for (const banned of ["prisma", "create(", "update(", "upsert(", "delete(", "$execute", "runSync"]) {
    assert.ok(!handler.includes(banned), banned);
  }
});

test("NO CREDENTIAL LEAKAGE: no key or token appears in the result", async () => {
  const { adapter } = makeAdapter({ payload: { conversions: [{ conversion: { conversion_id: "X" } }] } });
  const service = new NetworkCertificationService();
  const result = await service.certifyPartnerizeConversions({
    adapter,
    key: "PARTNERIZE",
    probe: { method: "GET", endpointKey: `GET ${ENDPOINT}` },
    window: { from: "2026-09-07", to: "2026-09-14", preset: "7d" },
    budgetLeft: () => 5000,
  });
  const serialised = JSON.stringify(result).toLowerCase();
  for (const banned of ["zzappzz", "zzuserzz", "applicationkey", "userapikey", "authorization", "pub-1"]) {
    assert.ok(!serialised.includes(banned), banned);
  }
});

test("the endpoint key names no identifier value", () => {
  assert.ok(ENDPOINT.includes("{publisherId}"), "placeholder, not a real id");
  assert.ok(!/pub-1|\d{4,}/.test(ENDPOINT));
});

/* ------------------------------------------- existing certification unchanged */

test("existing Partnerize source objects are unchanged", () => {
  assert.deepEqual(listPartnerizeCertificationSamples().sort(), [
    "authenticate",
    "campaigns",
    "conversions",
    "publishers",
    "vouchers",
  ]);
  // The four already-certified specs keep their exact endpoints.
  assert.ok(ADAPTER_SRC.includes('path: () => "/user"'));
  assert.ok(ADAPTER_SRC.includes('path: () => "/user/publisher"'));
  assert.ok(ADAPTER_SRC.includes("/campaign/a`"));
  assert.ok(ADAPTER_SRC.includes("/voucher`"));
});

test("no new supplier endpoint was invented", () => {
  // Every conversions path in the adapter existed before this change.
  assert.ok(ADAPTER_SRC.includes("/conversion.json"));
  assert.ok(ADAPTER_SRC.includes("/v3/partner/conversions"));
  const certSpec = ADAPTER_SRC.slice(
    ADAPTER_SRC.indexOf("  conversions: {"),
    ADAPTER_SRC.indexOf("  vouchers: {"),
  );
  assert.ok(certSpec.includes("/conversion.json"), "certification uses the evidenced path");
  assert.ok(!certSpec.includes("/v3/partner/conversions"), "never the paginated fallback");
});

test("production sync fetchConversions is untouched", () => {
  const fetcher = ADAPTER_SRC.slice(
    ADAPTER_SRC.indexOf("async fetchConversions("),
    ADAPTER_SRC.indexOf("async fetchPayments("),
  );
  // Still both paths, still the spread, still fetchPaginated — certification changed none of it.
  assert.ok(fetcher.includes("/conversion.json"));
  assert.ok(fetcher.includes('fetchPaginated("/v3/partner/conversions"'));
  assert.ok(fetcher.includes("...params"));
});

test("SAMPLE BOUND: the handler holds one row even if the adapter returns more", async () => {
  // Defence in depth: sampleOnce already clamps to one row, so this exercises the handler's own
  // bound directly with a stub that ignores that clamp.
  const stub = {
    fetchCertificationSample: async () =>
      Array.from({ length: 25 }, (_, i) => ({ conversion_id: `C-${i}`, publisher_commission: "9.99" })),
  };
  const service = new NetworkCertificationService();
  const result = await service.certifyPartnerizeConversions({
    adapter: stub,
    key: "PARTNERIZE",
    probe: { method: "GET", endpointKey: `GET ${ENDPOINT}` },
    window: { from: "2026-09-07", to: "2026-09-14", preset: "7d" },
    budgetLeft: () => 5000,
  });
  assert.equal(result.sampleCount, 1, "only one row may reach the field dictionary");
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes("C-24"), "no row beyond the first is summarised");
  assert.ok(!serialised.includes("9.99"), "no commission value leaks");
});
