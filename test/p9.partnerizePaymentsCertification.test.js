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
const { NetworkCertificationService, WINDOW_PRESETS, DEFAULT_WINDOW_PRESET, listProbeSourceObjects } =
  await import("../src/modules/ops/networkCertification.service.js");

const ADAPTER_SRC = readFileSync(new URL("../src/adapters/partnerize.adapter.js", import.meta.url), "utf8");
const SERVICE_SRC = readFileSync(
  new URL("../src/modules/ops/networkCertification.service.js", import.meta.url),
  "utf8",
);

const ENDPOINT = "/reporting/report_publisher/publisher/{publisherId}/payment.json";
const WINDOW = { from: "2026-09-07", to: "2026-09-14", preset: "7d" };

function makeAdapter({ payload = { payments: [] }, publisherId = "pub-1" } = {}) {
  const requests = [];
  const httpClient = {
    get: async (path, config) => {
      requests.push({ path, params: config?.params });
      return { data: payload };
    },
  };
  return {
    adapter: createPartnerizeAdapter({
      applicationKey: "zzappzz",
      userApiKey: "zzuserzz",
      publisherId,
      httpClient,
    }),
    requests,
  };
}

const certify = (adapter) =>
  new NetworkCertificationService().certifyPartnerizePayments({
    adapter,
    key: "PARTNERIZE",
    probe: { method: "GET", endpointKey: `GET ${ENDPOINT}` },
    window: WINDOW,
    budgetLeft: () => 5000,
  });

/* ------------------------------------------------------------- registration */

test("payments is a registered Partnerize source object and probe", () => {
  assert.ok(listPartnerizeCertificationSamples().includes("payments"));
  assert.ok(listProbeSourceObjects("partnerize").includes("payments"));
  assert.ok(SERVICE_SRC.includes(`endpointKey: "GET ${ENDPOINT}"`));
  assert.ok(SERVICE_SRC.includes('chain: "partnerizePayments"'));
});

/* ------------------------------------------------- exactly the right request */

test("EXACT ENDPOINT: one GET to the publisher-scoped payment report", async () => {
  const { adapter, requests } = makeAdapter();
  await adapter.fetchCertificationSample("payments", { timeoutMs: 5000, window: WINDOW });
  assert.equal(requests.length, 1, "exactly one supplier request");
  assert.equal(requests[0].path, "/reporting/report_publisher/publisher/pub-1/payment.json");
});

test("NO PAGINATION LOOP: exactly the two dates, nothing else", async () => {
  const { adapter, requests } = makeAdapter();
  await adapter.fetchCertificationSample("payments", { timeoutMs: 5000, window: WINDOW });
  assert.deepEqual(Object.keys(requests[0].params).sort(), ["end_date", "start_date"]);
  for (const banned of ["page", "offset", "limit", "cursor", "per_page", "page_size"]) {
    assert.equal(requests[0].params[banned], undefined, banned);
  }
});

test("the parameter names are the ones production already sends", () => {
  // waveESupplierSync builds { start_date, end_date } and passes it to fetchPayments. Neither the
  // path nor the parameter names are invented for certification.
  const sync = readFileSync(new URL("../src/jobs/waveESupplierSync.js", import.meta.url), "utf8");
  assert.ok(sync.includes("start_date: partnerizeFrom.toISOString().slice(0, 10)"));
  assert.ok(sync.includes("adapter.fetchPayments(partnerizeDateParams, stats)"));
  assert.ok(ADAPTER_SRC.includes("/payment.json"));
});

test("the certification spec does not pass a caller's params through", () => {
  // Production's fetchPayments hands its params object straight to get(). The spec must not.
  const spec = ADAPTER_SRC.slice(
    ADAPTER_SRC.indexOf("  payments: {"),
    ADAPTER_SRC.indexOf("  vouchers: {"),
  );
  assert.ok(spec.includes("start_date: resolved.window.from"));
  assert.ok(spec.includes("end_date: resolved.window.to"));
  assert.ok(!spec.includes("...params"));
  assert.ok(!spec.includes("ctx."), "the spec reads resolved values only");
});

test("fetchPayments has no paginated path to fall back to", () => {
  const fetcher = ADAPTER_SRC.slice(
    ADAPTER_SRC.indexOf("async fetchPayments("),
    ADAPTER_SRC.indexOf("async fetchPayments(") + 700,
  );
  assert.ok(!fetcher.includes("fetchPaginated"), "no pagination anywhere in the payments fetcher");
  assert.equal((fetcher.match(/payment\.json/g) || []).length, 1, "one payments path only");
});

/* ----------------------------------------------------- bounded date window */

test("WINDOW: dates come from the preset; a caller cannot supply them", async () => {
  const { adapter, requests } = makeAdapter();
  await adapter.fetchCertificationSample("payments", {
    timeoutMs: 5000,
    window: { from: "2026-06-16", to: "2026-09-14" },
    start_date: "1999-01-01",
    end_date: "2099-01-01",
  });
  assert.equal(requests[0].params.start_date, "2026-06-16");
  assert.equal(requests[0].params.end_date, "2026-09-14");
});

test("WINDOW: only 7d / 30d / 90d, default 7d", () => {
  assert.deepEqual(Object.keys(WINDOW_PRESETS).sort(), ["30d", "7d", "90d"]);
  assert.equal(DEFAULT_WINDOW_PRESET, "7d");
});

test("a missing window is a hard error before any request", async () => {
  const { adapter, requests } = makeAdapter();
  await assert.rejects(
    () => adapter.fetchCertificationSample("payments", { timeoutMs: 5000 }),
    /requires window/,
  );
  assert.equal(requests.length, 0);
});

test("a missing publisher id is a hard error before any request", async () => {
  const { adapter, requests } = makeAdapter({ publisherId: null });
  await assert.rejects(() =>
    adapter.fetchCertificationSample("payments", { timeoutMs: 5000, window: WINDOW }),
  );
  assert.equal(requests.length, 0);
});

/* ------------------------------------------------------------ zero rows */

test("ZERO ROWS: OK_NO_ROWS with the schema still unknown", async () => {
  const { adapter, requests } = makeAdapter({ payload: { payments: [] } });
  const result = await certify(adapter);
  assert.equal(result.statusCategory, "OK_NO_ROWS");
  assert.equal(result.ok, true);
  assert.equal(result.sampleCount, 0);
  assert.equal(result.fieldCount, 0);
  assert.equal(result.schema, "UNKNOWN_NEEDS_LIVE_DATA");
  assert.equal(result.windowPreset, "7d");
  assert.equal(result.sourceObject, "payments");
  assert.equal(requests.length, 1);
});

test("an empty payments envelope is not echoed back as one row", async () => {
  // extractRows recognises `payments`, so an empty one is ZERO rows — not the envelope reported
  // as a single row of envelope keys.
  const { adapter } = makeAdapter({ payload: { payments: [] } });
  const result = await certify(adapter);
  assert.notEqual(result.statusCategory, "OK");
  assert.equal(result.fieldCount, 0);
});

/* ------------------------------------------ one row, no monetary values */

test("ONE ROW: a field dictionary is produced and NO value is reported", async () => {
  const row = {
    payment_id: "PAY-99881",
    invoice_id: "INV-4471",
    publisher_id: "pub-1",
    payment_status: "paid",
    payment_date: "2026-09-10",
    currency: "EUR",
    payment_value: "1450.7700",
    total_commission: "1450.7700",
    bank_reference: "DE89370400440532013000",
    account_name: "MBO International Ltd",
  };
  const { adapter } = makeAdapter({ payload: { payments: [{ payment: row }] } });
  const result = await certify(adapter);

  assert.equal(result.statusCategory, "OK");
  assert.equal(result.sampleCount, 1);
  assert.ok(result.fieldCount > 0);

  const paths = result.fieldPaths.map((f) => f.path);
  for (const expected of ["payment_id", "invoice_id", "payment_status", "currency"]) {
    assert.ok(paths.includes(expected), `${expected} missing from the dictionary`);
  }

  const serialised = JSON.stringify(result);
  for (const value of [
    "PAY-99881", "INV-4471", "paid", "2026-09-10", "EUR",
    "1450.7700", "DE89370400440532013000", "MBO International Ltd", "pub-1",
  ]) {
    assert.ok(!serialised.includes(value), `value leaked: ${value}`);
  }
});

test("SAMPLE BOUND: the handler holds one row even if the adapter returns more", async () => {
  const stub = {
    fetchCertificationSample: async () =>
      Array.from({ length: 25 }, (_, i) => ({ payment_id: `P-${i}`, payment_value: "999.99" })),
  };
  const result = await certify(stub);
  assert.equal(result.sampleCount, 1);
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes("P-24"));
  assert.ok(!serialised.includes("999.99"), "no monetary value leaks");
});

/* ---------------------------------------------------------- safety, no writes */

test("NO WRITES: the shared dated sampler touches no repository", () => {
  const handler = SERVICE_SRC.slice(
    SERVICE_SRC.indexOf("async certifyPartnerizeDatedSample("),
    SERVICE_SRC.indexOf("async certifyPartnerizeVouchers("),
  );
  for (const banned of ["prisma", "create(", "update(", "upsert(", "delete(", "$execute", "runSync"]) {
    assert.ok(!handler.includes(banned), banned);
  }
});

test("NO CREDENTIAL LEAKAGE", async () => {
  const { adapter } = makeAdapter({ payload: { payments: [{ payment: { payment_id: "X" } }] } });
  const result = await certify(adapter);
  const serialised = JSON.stringify(result).toLowerCase();
  for (const banned of ["zzappzz", "zzuserzz", "applicationkey", "userapikey", "authorization", "pub-1"]) {
    assert.ok(!serialised.includes(banned), banned);
  }
});

test("the endpoint key names no identifier value", () => {
  assert.ok(ENDPOINT.includes("{publisherId}"));
  assert.ok(!/pub-1|\d{4,}/.test(ENDPOINT));
});

/* ------------------------------------------------------ no invented endpoint */

test("no invoice endpoint was invented — the adapter has none", () => {
  assert.equal((ADAPTER_SRC.match(/invoice/gi) || []).length, 0, "the adapter has no invoice path");
  const spec = ADAPTER_SRC.slice(
    ADAPTER_SRC.indexOf("  payments: {"),
    ADAPTER_SRC.indexOf("  vouchers: {"),
  );
  assert.ok(spec.includes("/payment.json"));
  assert.ok(!spec.includes("invoice"));
});

test("invoices are declared absent and are never executable", () => {
  // Superseded by the accuracy pass: invoices are now NAMED as absent rather than left unstated.
  // What must stay true is that naming them costs no supplier request — an `unsupported` probe
  // short-circuits, and no certification SAMPLE exists for them.
  assert.ok(listProbeSourceObjects("partnerize").includes("invoices"));
  assert.ok(
    !listPartnerizeCertificationSamples().includes("invoices"),
    "no adapter sample means no request can be made",
  );
  assert.ok(SERVICE_SRC.includes("NO_ENDPOINT_IN_INTEGRATION"));
});

/* ------------------------------------------- existing certification unchanged */

test("the other Partnerize probes are unchanged", () => {
  assert.deepEqual(listPartnerizeCertificationSamples(), [
    "authenticate",
    "publishers",
    "campaigns",
    "conversions",
    "payments",
    "vouchers",
  ]);
  assert.ok(ADAPTER_SRC.includes('path: () => "/user"'));
  assert.ok(ADAPTER_SRC.includes('path: () => "/user/publisher"'));
  assert.ok(ADAPTER_SRC.includes("/campaign/a`"));
  assert.ok(ADAPTER_SRC.includes("/voucher`"));
  assert.ok(ADAPTER_SRC.includes("/conversion.json"));
});

test("conversions and payments share one dated sampler and cannot drift", () => {
  assert.ok(SERVICE_SRC.includes("certifyPartnerizeDatedSample({ ...args, sourceObject: \"conversions\" })"));
  assert.ok(SERVICE_SRC.includes("certifyPartnerizeDatedSample({ ...args, sourceObject: \"payments\" })"));
  // Exactly one implementation of the DATED control flow. Counting OK_NO_ROWS across the whole
  // service is not that claim: the voucher chain is a separate probe that reports it too, on its
  // own empty collection. The claim is scoped to the shared sampler's own body.
  const start = SERVICE_SRC.indexOf("async certifyPartnerizeDatedSample(");
  const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
  assert.ok(start > -1);
  assert.equal((body.match(/statusCategory: "OK_NO_ROWS"/g) || []).length, 1);
  assert.equal((body.match(/windowPreset:/g) || []).length, 2, "both outcomes report the window");
  // And neither conversions nor payments has a second, private implementation.
  for (const name of ["certifyPartnerizeConversions", "certifyPartnerizePayments"]) {
    const own = SERVICE_SRC.slice(SERVICE_SRC.indexOf(`async ${name}(`), SERVICE_SRC.indexOf(`async ${name}(`) + 200);
    assert.ok(!own.includes("OK_NO_ROWS"), `${name} implements its own control flow`);
  }
});

test("production sync fetchPayments keeps its endpoint and non-blocking contract", () => {
  // The accuracy pass changed only WHAT the skip records — the endpoint, the params pass-through
  // and the empty-array return are unchanged, which is what keeps the 404 non-blocking.
  const fetcher = ADAPTER_SRC.slice(
    ADAPTER_SRC.indexOf("async fetchPayments("),
    ADAPTER_SRC.indexOf("Voucher codes for a campaign"),
  );
  assert.ok(fetcher.includes("resolvePublisherId"));
  assert.ok(fetcher.includes("get(path, params, stats)"), "still passes its params through");
  assert.ok(fetcher.includes("partnerizePaymentSkipRecord"), "the skip is now structured");
  assert.ok(fetcher.includes("return [];"), "still non-blocking");
  assert.ok(!fetcher.includes("throw"), "the fetcher itself must not become blocking");
});
