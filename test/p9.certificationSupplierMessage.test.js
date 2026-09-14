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
  NetworkCertificationService,
  certificationFailure,
  statusCategory,
  supplierMessage,
  supplierStatusCode,
  redactionValuesFor,
  SUPPLIER_MESSAGE_MAX_LENGTH,
} = await import("../src/modules/ops/networkCertification.service.js");
const { createAwinAdapter } = await import("../src/adapters/awin.adapter.js");

const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

const TOKEN = "zzaccesstokenzz";
const PUBLISHER_ID = "zzpub9876zz";

const withBody = (status, data, extra = {}) =>
  Object.assign(new Error("Request failed with status code " + status), {
    response: { status, data, ...extra },
  });

function certifyAwinWith(error, { publisherId = PUBLISHER_ID } = {}) {
  const calls = [];
  const client = {
    get: async (path, config) => {
      calls.push({ path, config });
      throw error;
    },
    post: async (path, bodyArg, config) => {
      calls.push({ path, body: bodyArg, config });
      throw error;
    },
  };
  const service = new NetworkCertificationService({
    prisma: {},
    adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: client }),
    awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId }),
  });
  return service
    .certify("awin", { sourceObjects: ["conversions"] })
    .then((result) => ({ result, entry: result.results[0], calls }));
}

/* ------------------------------------------------------- the happy case */

describe("a safe supplier message is returned", () => {
  it("1 - a plain 400 explanation survives intact", () => {
    const entry = certificationFailure({}, withBody(400, { message: "startDate must not be after endDate" }));
    assert.equal(entry.supplierMessage, "startDate must not be after endDate");
    assert.equal(entry.statusCategory, "REQUEST_REJECTED");
    assert.equal(entry.supplierStatusCode, 400);
  });

  it("2 - every allowlisted key is read, and only strings", () => {
    const keys = [
      "message",
      "error_description",
      "errorDescription",
      "description",
      "detail",
      "title",
      "reason",
      "error",
    ];
    for (const key of keys) {
      assert.equal(
        supplierMessage(withBody(400, { [key]: "the window is not valid" })),
        "the window is not valid",
        key,
      );
    }
    // A non-allowlisted key is never read, however suggestive its name — and with nothing else to
    // fall back on, no message is returned at all.
    assert.equal(supplierMessage(withBody(400, { explanation: "secret sauce" })), null);
  });

  it("3 - a string body is accepted; an object under an allowlisted key is not serialised", () => {
    assert.equal(supplierMessage(withBody(400, "the request was malformed")), "the request was malformed");
    const nested = supplierMessage(withBody(400, { message: { inner: "zzdeepvaluezz", code: 12345 } }));
    assert.ok(!String(nested).includes("zzdeepvaluezz"), "a nested body was serialised");
    assert.ok(!String(nested).includes("inner"));
  });

  it("4 - statusText is the only fallback; error.message is NOT a source", () => {
    assert.equal(supplierMessage(withBody(400, {}, { statusText: "Bad Request" })), "Bad Request");
    // error.message carries our own internal text — axios' generic string, throttle and timeout
    // notices, and paths quoted without a query string. None of it is the supplier speaking, so a
    // failure with no response body reports no message rather than echoing an internal.
    assert.equal(supplierMessage(withBody(500, {})), null);
    assert.equal(supplierMessage(Object.assign(new Error("throttled for 900ms"), { certificationThrottled: true })), null);
    assert.equal(supplierMessage(new Error("failed GET /user/publisher/abc/campaign/def/voucher")), null);
  });

  it("4b - a bare path is redacted even with no query string", () => {
    const out = supplierMessage(
      withBody(400, { message: "failed at /user/publisher/abc/campaign/def/voucher here" }),
    );
    assert.ok(!out.includes("/user/publisher"), "a bare path leaked");
    assert.ok(!out.includes("abc"));
    assert.match(out, /failed at \[REDACTED_URL\] here/);
  });

  it("4c - credentials recorded at build time are redacted from a body message", async () => {
    const { recordRedactionValues } = await import("../src/modules/ops/networkCertification.service.js");
    const adapter = recordRedactionValues({ supplierKey: "AWIN", publisherId: PUBLISHER_ID }, [TOKEN, PUBLISHER_ID]);
    // Recorded non-enumerably, so attaching it can never itself become the leak.
    assert.ok(!JSON.stringify(adapter).includes(TOKEN));
    assert.ok(!Object.keys(adapter).some((k) => adapter[k] === TOKEN));
    const out = supplierMessage(withBody(401, { message: `credential ${TOKEN} was refused` }), {
      redactValues: redactionValuesFor(adapter),
    });
    assert.ok(!out.includes(TOKEN), "the token leaked");
    assert.match(out, /credential \[REDACTED\] was refused/);
  });
});

/* ------------------------------------------------------- redaction */

describe("nothing identifying survives", () => {
  const redactValues = [PUBLISHER_ID, TOKEN];

  it("5 - a bearer token is redacted", () => {
    const out = supplierMessage(
      withBody(401, { message: `invalid credential: Bearer ${TOKEN} rejected` }),
      { redactValues },
    );
    assert.ok(!out.includes(TOKEN), "the token leaked");
    assert.match(out, /REDACTED/);
    assert.match(out, /invalid credential/);
  });

  it("6 - a configured publisher id is redacted even though no pattern matches it", () => {
    // zzpub9876zz is short and mixed-case: exact-value redaction is what catches it.
    const out = supplierMessage(
      withBody(400, { message: `publisher ${PUBLISHER_ID} is not permitted` }),
      { redactValues },
    );
    assert.ok(!out.includes(PUBLISHER_ID), "the publisher id leaked");
    assert.match(out, /publisher \[REDACTED\] is not permitted/);
  });

  it("6b - the redaction list comes from the adapter, so a real run is covered", () => {
    const adapter = createAwinAdapter({ accessToken: TOKEN, publisherId: PUBLISHER_ID, httpClient: {} });
    assert.deepEqual(redactionValuesFor(adapter), [String(PUBLISHER_ID)]);
    assert.deepEqual(redactionValuesFor(null), []);
    assert.deepEqual(redactionValuesFor({ publisherId: "" }), []);
    // Two characters would shred ordinary words and is deliberately ignored.
    assert.equal(
      supplierMessage(withBody(400, { message: "an ordinary message" }), { redactValues: ["an"] }),
      "an ordinary message",
    );
  });

  it("7 - URLs and query strings are redacted", () => {
    const out = supplierMessage(
      withBody(400, {
        message:
          "see https://api.awin.com/publishers/12345/transactions/?startDate=2026-01-01 for detail",
      }),
      { redactValues },
    );
    assert.ok(!out.includes("api.awin.com"));
    assert.ok(!out.includes("startDate=2026-01-01"));
    assert.ok(!out.includes("12345"));
    assert.match(out, /see \[REDACTED_URL\] for detail/);
  });

  it("7b - a bare path with a query string is redacted too", () => {
    const out = supplierMessage(
      withBody(400, { message: "bad request at /publishers/99887766/transactions/?dateType=x" }),
    );
    assert.ok(!out.includes("99887766"));
    assert.ok(!out.includes("dateType=x"));
    assert.match(out, /bad request at/);
  });

  it("8 - email addresses are redacted", () => {
    const out = supplierMessage(
      withBody(400, { message: "contact support.person@merchant.example about this" }),
    );
    assert.ok(!out.includes("support.person@merchant.example"));
    assert.match(out, /contact \[REDACTED_EMAIL\] about this/);
  });

  it("9 - long numeric identifiers are redacted, short numbers are not", () => {
    const out = supplierMessage(
      withBody(400, { message: "advertiser 998877665 exceeded the 31 day window in 2026" }),
    );
    assert.ok(!out.includes("998877665"));
    assert.match(out, /31 day/, "a day count was destroyed");
    assert.match(out, /2026/, "a four-digit year was destroyed");
    assert.match(out, /\[REDACTED_ID\]/);
  });

  it("10 - long opaque runs are redacted as credential-shaped", () => {
    const out = supplierMessage(withBody(401, { message: "key AbCdEf0123456789XyZ was refused" }));
    assert.ok(!out.includes("AbCdEf0123456789XyZ"));
    assert.match(out, /was refused/);
  });

  it("11 - control characters are stripped, including newlines", () => {
    const raw = "line one\n\r\tline two  end";
    const out = supplierMessage(withBody(400, { message: raw }));
    assert.equal(out, "line one line two end");
    // No control character survives anywhere in the output.
    assert.ok(!/[ --]/.test(out), "a control character survived");
  });
});

/* ------------------------------------------------------- bounds */

describe("length and emptiness", () => {
  it("12 - a long message is capped at 200 characters", () => {
    const long = `the supplier explained at length ${"detail ".repeat(80)}`;
    const out = supplierMessage(withBody(400, { message: long }));
    assert.ok(out.length <= SUPPLIER_MESSAGE_MAX_LENGTH, `${out.length} characters`);
    assert.equal(SUPPLIER_MESSAGE_MAX_LENGTH, 200);
    assert.ok(out.endsWith("…"), "truncation is not marked");
    assert.match(out, /^the supplier explained at length/);
  });

  it("13 - a message that redacts down to placeholders is omitted", () => {
    const useless = [
      "https://api.awin.com/publishers/12345/transactions/",
      "998877665",
      "   ",
      "!!! ??? ...",
    ];
    for (const message of useless) {
      const error = withBody(400, { message }, { statusText: "" });
      error.message = "";
      const entry = certificationFailure({ network: "awin" }, error);
      assert.ok(!("supplierMessage" in entry), `${message} produced a message`);
    }
  });

  it("14 - a transport error with no message at all omits the field", () => {
    const entry = certificationFailure(
      { network: "awin" },
      Object.assign(new Error(""), { code: "ECONNRESET" }),
    );
    assert.equal(entry.statusCategory, "NETWORK_ERROR");
    assert.ok(!("supplierMessage" in entry));
    assert.ok(!("supplierStatusCode" in entry));
    assert.deepEqual(Object.keys(entry).sort(), ["network", "ok", "statusCategory"]);
  });

  it("15 - null, undefined and a non-object error are handled", () => {
    for (const error of [null, undefined, 42, "boom"]) {
      assert.equal(supplierMessage(error), null, String(error));
    }
  });
});

/* ------------------------------------------------------- never returned */

describe("the body itself is never returned", () => {
  it("16 - a rich error body yields at most its message field", () => {
    const error = withBody(
      400,
      {
        message: "the window is not valid",
        token: TOKEN,
        publisherId: PUBLISHER_ID,
        orderRef: "zzorderrefzz",
        amount: 125.99,
        currency: "GBP",
        trace: "zztracezz",
        customer: { email: "buyer@example.com", country: "GB" },
      },
      {
        statusText: "zzstatustextzz",
        headers: { authorization: `Bearer ${TOKEN}`, "x-request-id": "zzrequestidzz" },
        config: { url: `/publishers/${PUBLISHER_ID}/transactions/`, params: { startDate: "2026-01-01" } },
      },
    );
    const entry = certificationFailure({ network: "awin" }, error, {}, [PUBLISHER_ID, TOKEN]);
    assert.equal(entry.supplierMessage, "the window is not valid");
    const serialised = JSON.stringify(entry);
    const banned = [
      TOKEN,
      PUBLISHER_ID,
      "zzorderrefzz",
      "125.99",
      "GBP",
      "zztracezz",
      "buyer@example.com",
      "zzrequestidzz",
      "zzstatustextzz",
      "2026-01-01",
      "transactions",
    ];
    for (const value of banned) {
      assert.ok(!serialised.includes(value), `${value} leaked`);
    }
    assert.deepEqual(Object.keys(entry).sort(), [
      "network",
      "ok",
      "statusCategory",
      "supplierMessage",
      "supplierStatusCode",
    ]);
  });

  it("17 - no stack trace, headers, config or raw body key is ever emitted", () => {
    const entry = certificationFailure({}, withBody(500, { message: "internal error" }));
    for (const forbidden of ["stack", "response", "config", "headers", "data", "body", "request"]) {
      assert.ok(!(forbidden in entry), forbidden);
    }
  });

  it("18 - the helper reads an allowlist of keys, never the body wholesale", () => {
    // supplierMessage's own body, comments stripped: an explanatory comment mentioning
    // JSON.stringify is not the code doing it, and matching prose is not a test.
    const start = SERVICE_SRC.indexOf("export function supplierMessage(");
    const helper = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n}\n", start))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(start > -1);
    assert.ok(!/JSON\.stringify/.test(helper), "the body is serialised");
    assert.ok(helper.includes("SUPPLIER_MESSAGE_KEYS"));
    assert.ok(helper.includes('typeof body[key] === "string"'), "non-string values could be read");
    assert.ok(!/candidates\.push\(error\.message\)/.test(helper), "error.message became a source again");
  });
});

/* ------------------------------------------------------- the real builders */

describe("every builder records its own credentials", () => {
  /** The REAL builder, with no adapterFactory: this is the path a live run takes. */
  const realService = (deps) => new NetworkCertificationService({ prisma: {}, ...deps });

  it("R1 - buildAwinAdapter records the access token AND the publisher id", async () => {
    const service = realService({
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    });
    const adapter = await service.buildAwinAdapter({ accountLabel: "default" });
    const values = redactionValuesFor(adapter);
    assert.ok(values.includes(TOKEN), "the access token is not redactable");
    assert.ok(values.includes(String(PUBLISHER_ID)), "the publisher id is not redactable");

    // A supplier message quoting the token is scrubbed on the path a live run actually uses.
    const out = supplierMessage(withBody(401, { message: `token ${TOKEN} refused` }), {
      redactValues: values,
    });
    assert.ok(!out.includes(TOKEN), "the token leaked through the real builder");
  });

  it("R2 - buildPartnerizeAdapter records both keys, the publisher and the campaign id", async () => {
    const service = realService({
      partnerizeCredentialResolver: async () => ({
        applicationKey: "zzappkeyzz",
        userApiKey: "zzuserkeyzz",
        publisherId: "zzptzpubzz",
        certificationCampaignId: "zzcampidzz",
      }),
    });
    const adapter = await service.buildPartnerizeAdapter({ accountLabel: "default" });
    const values = redactionValuesFor(adapter);
    for (const secret of ["zzappkeyzz", "zzuserkeyzz", "zzptzpubzz", "zzcampidzz"]) {
      assert.ok(values.includes(secret), `${secret} is not redactable`);
    }
  });

  it("R3 - buildOptimiseAdapter records its api key and account identifiers", async () => {
    const service = realService({
      credentialResolver: async () => ({
        apiKey: "zzoptkeyzz",
        agencyId: "zzagencyzz",
        contactId: "zzcontactzz",
        baseURL: "https://optimise.test",
      }),
    });
    const adapter = await service.buildOptimiseAdapter({ region: "sea", accountLabel: "default" });
    const values = redactionValuesFor(adapter);
    for (const secret of ["zzoptkeyzz", "zzagencyzz", "zzcontactzz"]) {
      assert.ok(values.includes(secret), `${secret} is not redactable`);
    }
  });

  it("R4 - the record is NON-ENUMERABLE, so it can never itself be serialised", async () => {
    const service = realService({
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    });
    const adapter = await service.buildAwinAdapter({ accountLabel: "default" });

    assert.ok(!JSON.stringify(adapter).includes(TOKEN), "the token is serialisable from the adapter");
    assert.ok(!Object.keys(adapter).some((k) => String(adapter[k]) === TOKEN));
    assert.ok(!Object.values(adapter).some((v) => String(v) === TOKEN));

    const symbols = Object.getOwnPropertySymbols(adapter);
    const recorded = symbols.filter((sym) => Array.isArray(adapter[sym]));
    assert.equal(recorded.length, 1, "the record is missing or duplicated");
    const descriptor = Object.getOwnPropertyDescriptor(adapter, recorded[0]);
    assert.equal(descriptor.enumerable, false, "the record is enumerable");
    assert.equal(descriptor.writable, false, "the record is writable");
    assert.ok(Object.isFrozen(descriptor.value), "the record is mutable");
  });
});

/* ------------------------------------------------------- end to end */

describe("a real run", () => {
  it("19 - the AWIN conversions 400 now carries a redacted explanation", async () => {
    const { entry, calls } = await certifyAwinWith(
      withBody(400, { message: `publisher ${PUBLISHER_ID} sent an invalid startDate` }),
    );
    assert.equal(entry.sourceObject, "conversions");
    assert.equal(entry.statusCategory, "REQUEST_REJECTED");
    assert.equal(entry.supplierStatusCode, 400);
    assert.match(entry.supplierMessage, /sent an invalid startDate/);
    assert.ok(!entry.supplierMessage.includes(PUBLISHER_ID), "the publisher id leaked in a real run");
    assert.equal(calls.length, 1, "retry behaviour changed");
  });

  it("20 - the whole run response leaks nothing", async () => {
    const { result } = await certifyAwinWith(
      withBody(400, { message: "bad request", token: TOKEN, publisher: PUBLISHER_ID }),
    );
    const serialised = JSON.stringify(result);
    for (const value of [TOKEN, PUBLISHER_ID]) {
      assert.ok(!serialised.includes(value), `${value} leaked`);
    }
  });

  it("21 - a success carries no supplierMessage", async () => {
    const client = {
      get: async () => ({ data: { transactions: [{ id: 1, basketProducts: [] }] } }),
      post: async () => ({ data: { data: [{ promotionId: 1 }] } }),
    };
    const service = new NetworkCertificationService({
      prisma: {},
      adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: client }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    });
    const result = await service.certify("awin", {
      sourceObjects: ["campaigns", "coupons", "conversions"],
    });
    for (const entry of result.results) {
      assert.ok(!("supplierMessage" in entry), `${entry.sourceObject} reported a message on success`);
      assert.ok(!("supplierStatusCode" in entry), entry.sourceObject);
    }
  });
});

/* ------------------------------------------------------- unchanged */

describe("existing behaviour is unchanged", () => {
  it("22 - statusCategory and supplierStatusCode are exactly as before", () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 504]) {
      const error = withBody(status, { message: "something happened" });
      const entry = certificationFailure({}, error);
      assert.equal(entry.statusCategory, statusCategory(error), String(status));
      assert.equal(entry.supplierStatusCode, supplierStatusCode(error), String(status));
    }
    assert.equal(statusCategory(withBody(400, {})), "REQUEST_REJECTED");
    assert.equal(statusCategory(new Error("x")), "NETWORK_ERROR");
  });

  it("23 - the message is applied generically, at every failure site", () => {
    // One definition plus one call per site, each passing the run's redaction values.
    assert.equal((SERVICE_SRC.match(/certificationFailure\(/g) || []).length, 11);
    assert.equal((SERVICE_SRC.match(/redactionValuesFor\(adapter\)/g) || []).length, 11);
  });

  it("24 - no AWIN endpoint, query or body was touched", () => {
    const adapter = readFileSync("src/adapters/awin.adapter.js", "utf8");
    assert.match(adapter, /path: \(resolved\) => `\/publishers\/\$\{resolved\.publisherId\}\/transactions\/`/);
    assert.match(adapter, /body: \(\) => \(\{ filters: \{\}, pagination: \{ page: 1, pageSize: 200 \} \}\)/);
    assert.match(adapter, /showBasketProducts: true,/);
    assert.match(adapter, /dateType: "transaction",/);
  });
});
