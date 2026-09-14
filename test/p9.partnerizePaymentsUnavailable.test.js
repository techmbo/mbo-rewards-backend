import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const {
  PartnerizePaymentsUnavailableError,
  partnerizePaymentSkipRecord,
  createPartnerizeAdapter,
} = await import("../src/adapters/partnerize.adapter.js");

const { SOURCE_OBJECT_AVAILABILITY, getSourceObject } = await import(
  "../src/modules/networkOps/sourceObjects.catalog.js"
);
const { listProbeSourceObjects } = await import("../src/modules/ops/networkCertification.service.js");

const ADAPTER_SRC = readFileSync(new URL("../src/adapters/partnerize.adapter.js", import.meta.url), "utf8");
const SYNC_SRC = readFileSync(new URL("../src/jobs/waveESupplierSync.js", import.meta.url), "utf8");
const HTTP_SRC = readFileSync(new URL("../src/core/httpClient.js", import.meta.url), "utf8");

/** An adapter whose payment request fails with the given status, like the live account does. */
function makeAdapter({ status = 404, publisherId = "pub-1" } = {}) {
  const requests = [];
  const httpClient = {
    get: async (path) => {
      requests.push(path);
      if (path.includes("/payment.json")) {
        const error = new Error("Request failed with status code 404");
        error.response = { status, data: { message: "not found", account: "zzsecretzz" } };
        throw error;
      }
      return { data: { conversions: [] } };
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

/* ------------------------------------------------------- catalog truth */

test("CATALOG: payments is no longer claimed live", () => {
  const entry = getSourceObject("partnerize", "payment_information");
  assert.equal(entry.live, false, "must not claim a working ingest");
  assert.equal(entry.availability, "NOT_SUPPORTED_OR_UNAVAILABLE_FOR_CURRENT_ACCOUNT");
  assert.equal(entry.availability, SOURCE_OBJECT_AVAILABILITY.UNAVAILABLE);
});

test("CATALOG: unavailable is distinct from declared-and-never-built", () => {
  const entry = getSourceObject("partnerize", "payment_information");
  assert.notEqual(entry.availability, SOURCE_OBJECT_AVAILABILITY.DECLARED);
  assert.notEqual(entry.availability, SOURCE_OBJECT_AVAILABILITY.LIVE);
  // The live evidence is recorded, not asserted from code shape.
  assert.match(entry.liveEvidence, /404/);
  assert.match(entry.notes, /404/);
  assert.match(entry.notes, /UNKNOWN_NO_ACCESSIBLE_SOURCE/);
});

test("CATALOG: payments is not described as merely empty", () => {
  const entry = getSourceObject("partnerize", "payment_information");
  const text = `${entry.notes} ${entry.liveEvidence}`.toLowerCase();
  assert.ok(!/\bno rows\b|\bzero rows\b|\bempty\b/.test(text.replace("not merely empty", "")));
});

test("CATALOG: conversions keeps its own, different status", () => {
  const conversions = getSourceObject("partnerize", "conversions");
  assert.equal(conversions.live, true, "the conversions endpoint works; only its rows are unknown");
  assert.equal(conversions.availability, SOURCE_OBJECT_AVAILABILITY.LIVE);
});

test("CATALOG: campaigns unaffected", () => {
  const campaigns = getSourceObject("partnerize", "campaigns");
  assert.equal(campaigns.live, true);
  assert.equal(campaigns.availability, SOURCE_OBJECT_AVAILABILITY.LIVE);
});

/* ------------------------------------------------------- skip surfacing */

test("SURFACED: a 404 produces a structured, safe skip record", async () => {
  const { adapter } = makeAdapter({ status: 404 });
  const stats = {};
  const rows = await adapter.fetchPayments({ start_date: "2026-09-07", end_date: "2026-09-14" }, stats);

  assert.deepEqual(rows, [], "still non-blocking: returns an empty array");
  const skip = stats.paymentFetchSkipped;
  assert.equal(skip.sourceObject, "payment_information");
  assert.equal(skip.status, "unavailable");
  assert.equal(skip.supplierStatusCode, 404);
  assert.equal(skip.reasonCategory, "NOT_FOUND");
  assert.ok(Date.parse(skip.at) > 0, "carries a timestamp");
});

test("SURFACED: the skip record leaks no body, URL or credential", async () => {
  const { adapter } = makeAdapter({ status: 404 });
  const stats = {};
  await adapter.fetchPayments({}, stats);
  const serialised = JSON.stringify(stats.paymentFetchSkipped).toLowerCase();
  for (const banned of ["zzsecretzz", "zzappzz", "zzuserzz", "pub-1", "payment.json", "http", "not found"]) {
    assert.ok(!serialised.includes(banned), banned);
  }
  assert.deepEqual(Object.keys(stats.paymentFetchSkipped).sort(), [
    "at",
    "reasonCategory",
    "sourceObject",
    "status",
    "supplierStatusCode",
  ]);
});

test("SURFACED: the sync re-raises the skip so it is not recorded as zero payments", () => {
  // sourceObjectSync catches an execute() throw, persists a FAILED run with the error code, and
  // RETURNS the run rather than rethrowing — so this surfaces without blocking.
  assert.ok(SYNC_SRC.includes("const skip = stats?.paymentFetchSkipped;"));
  assert.ok(SYNC_SRC.includes('if (skip?.status === "unavailable")'));
  assert.ok(SYNC_SRC.includes("throw new PartnerizePaymentsUnavailableError(skip.supplierStatusCode)"));
});

test("SURFACED: the error carries a safe code and category only", () => {
  const error = new PartnerizePaymentsUnavailableError(404);
  assert.equal(error.code, "SUPPLIER_SOURCE_OBJECT_UNAVAILABLE");
  assert.equal(error.supplierStatusCode, 404);
  assert.equal(error.reasonCategory, "NOT_FOUND");
  assert.equal(error.partnerizePaymentsUnavailable, true);
  const serialised = `${error.message} ${error.code} ${JSON.stringify({ ...error })}`.toLowerCase();
  for (const banned of ["zzappzz", "zzuserzz", "payment.json", "publisher/", "authorization"]) {
    assert.ok(!serialised.includes(banned), banned);
  }
});

test("a non-404 failure is categorised as UNAVAILABLE, not NOT_FOUND", () => {
  assert.equal(partnerizePaymentSkipRecord(503).reasonCategory, "UNAVAILABLE");
  assert.equal(partnerizePaymentSkipRecord(null).supplierStatusCode, null);
  assert.equal(new PartnerizePaymentsUnavailableError(503).reasonCategory, "UNAVAILABLE");
});

/* --------------------------------------------------- non-blocking, no retry */

test("NON-BLOCKING: fetchPayments still resolves with an empty array", async () => {
  const { adapter } = makeAdapter({ status: 404 });
  await assert.doesNotReject(() => adapter.fetchPayments({}, {}));
  assert.deepEqual(await adapter.fetchPayments({}, {}), []);
});

test("NON-BLOCKING: the throw happens at the call site, not inside the fetcher", () => {
  const fetcher = ADAPTER_SRC.slice(
    ADAPTER_SRC.indexOf("async fetchPayments("),
    ADAPTER_SRC.indexOf("Voucher codes for a campaign"),
  );
  assert.ok(fetcher.includes("return [];"), "the fetcher still swallows and returns []");
  assert.ok(!fetcher.includes("throw"), "the fetcher must not become blocking");
});

test("NO RETRY: 404 is still non-retryable", async () => {
  // requestWithRetry breaks immediately on any status outside 429/5xx.
  assert.ok(HTTP_SRC.includes("if (status && ![429, 500, 502, 503, 504].includes(status)) {"));
  const { adapter, requests } = makeAdapter({ status: 404 });
  await adapter.fetchPayments({}, {});
  const paymentCalls = requests.filter((p) => p.includes("/payment.json"));
  assert.equal(paymentCalls.length, 1, "exactly one attempt, no retry");
});

/* ------------------------------------------------ nothing invented */

test("no payment, settlement or invoice endpoint was added", () => {
  const paths = [...ADAPTER_SRC.matchAll(/[`"'](\/[A-Za-z0-9_/{}$().:-]+)[`"']/g)].map((m) => m[1]);
  const payish = [...new Set(paths.filter((p) => /pay|settle|invoice|billing/i.test(p)))];
  // Only payment.json, and only the two occurrences that already existed.
  assert.ok(payish.every((p) => p.includes("/payment.json")), payish.join(", "));
  assert.equal((ADAPTER_SRC.match(/invoice/gi) || []).length, 0, "still no invoice path");
});

test("invoices are declared absent, and cost no supplier request", () => {
  assert.ok(listProbeSourceObjects("partnerize").includes("invoices"));
  const service = readFileSync(
    new URL("../src/modules/ops/networkCertification.service.js", import.meta.url),
    "utf8",
  );
  // Scoped to PARTNERIZE_PROBES: Optimise also has an `invoices` entry and appears first.
  const registry = service.indexOf("const PARTNERIZE_PROBES");
  assert.ok(registry > -1);
  const start = service.indexOf("  invoices: {", registry);
  assert.ok(start > registry, "invoices must be declared on Partnerize");
  const block = service.slice(start, service.indexOf("\n  },", start));
  assert.ok(block.includes("NO_ENDPOINT_IN_INTEGRATION"));
  assert.ok(block.includes("unsupported:"), "short-circuits before any request");
  assert.ok(!block.includes("chain:"), "an unsupported probe must declare no chain");
});

test("no payments mapping fields were invented", () => {
  const files = readdirSync(new URL("../src/network-mappings/partnerize/", import.meta.url));
  assert.ok(!files.includes("payments.mapping.json"));
  assert.ok(!files.includes("invoices.mapping.json"));
});
