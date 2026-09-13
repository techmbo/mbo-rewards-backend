import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS = "1";

const {
  PartnerizeNoCampaignIdError,
  PartnerizeNoPublisherIdError,
  createPartnerizeAdapter,
  isPathSafePartnerizeId,
  listPartnerizeCertificationSamples,
} = await import("../src/adapters/partnerize.adapter.js");
const {
  MAX_SUPPLIER_REQUESTS_PARTNERIZE_CAMPAIGNS,
  MAX_SUPPLIER_REQUESTS_PARTNERIZE_VOUCHERS,
  NetworkCertificationService,
  listProbeSourceObjects,
} = await import("../src/modules/ops/networkCertification.service.js");

const adapterSource = readFileSync("src/adapters/partnerize.adapter.js", "utf8");
const serviceSource = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const controllerSource = readFileSync("src/controllers/networkCertification.controller.js", "utf8");
const routesSource = readFileSync("src/routes/index.js", "utf8");

/** Distinctive credential values: any of these in the output is a leak. */
const CREDENTIALS = {
  applicationKey: "zzappkeyzz",
  userApiKey: "zzuserapikeyzz",
};
const PUBLISHER_ID = "zzpub1234zz";
const CAMPAIGN_ID = "zzcamp5678zz";

/** A voucher payload whose every value is distinctive — none may reach the result. */
const VOUCHER_ROW = {
  voucher_code: "zzcodezz",
  voucher_code_id: "zzcodeidzz",
  description: "zzdescriptionzz",
  start_date_time: "2026-01-01T00:00:00Z",
  active: "y",
};

/** Records every request. Never reached by anything that should be skipped. */
function spyHttp(response = { data: { voucher_codes: [VOUCHER_ROW] } }) {
  const calls = [];
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, params: config.params, timeout: config.timeout });
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
}

/**
 * `undefined` here must mean "configured as undefined", not "use the default" — otherwise the
 * absent-identifier cases silently receive the real value and prove nothing.
 */
function adapterWith(options = {}) {
  const spy = options.http ?? spyHttp();
  const publisherId = "publisherId" in options ? options.publisherId : PUBLISHER_ID;
  const campaignId = "campaignId" in options ? options.campaignId : CAMPAIGN_ID;
  return {
    spy,
    adapter: createPartnerizeAdapter({
      ...CREDENTIALS,
      publisherId,
      certificationCampaignId: campaignId,
      httpClient: spy.client,
    }),
  };
}

/** The service, driven by an injected adapter so no credential resolution or network happens. */
function serviceWith(adapter, credentials = {}) {
  return new NetworkCertificationService({
    prisma: {},
    adapterFactory: () => adapter,
    partnerizeCredentialResolver: async () => ({
      applicationKey: CREDENTIALS.applicationKey,
      userApiKey: CREDENTIALS.userApiKey,
      publisherId: PUBLISHER_ID,
      certificationCampaignId: CAMPAIGN_ID,
      // Spread last so an explicit undefined overrides rather than being ignored.
      ...credentials,
    }),
  });
}

describe("partnerize vouchers — the endpoint is pinned", () => {
  it("1 — the path is exactly the one production sync builds, with no query parameters", async () => {
    const { adapter, spy } = adapterWith();
    await adapter.fetchCertificationVoucherSample({ timeoutMs: 3000 });

    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, `/user/publisher/${PUBLISHER_ID}/campaign/${CAMPAIGN_ID}/voucher`);
    // fetchCoupons calls get(path, {}, stats): no limit, offset, page or cursor is evidenced,
    // so none is sent. Inventing one is what got the Optimise conversions probe rejected.
    assert.deepEqual(spy.calls[0].params, {});
  });

  it("1b — production sync still builds that same path, so the probe cannot drift from it", () => {
    assert.match(
      adapterSource,
      /const path = `\/user\/publisher\/\$\{encodeURIComponent\(pubId\)\}\/campaign\/\$\{encodeURIComponent\(campaignId\)\}\/voucher`;/,
    );
    // And the sync fetcher still sends no parameters either.
    assert.match(adapterSource, /const data = await get\(path, \{\}, stats\);/);
  });

  it("1c — the source object is registered under the agreed name on Partnerize only", () => {
    assert.deepEqual(listProbeSourceObjects("partnerize"), [
      "authenticate",
      "publishers",
      "campaigns",
      "vouchers",
      "commission_structure",
    ]);
    // commission_structure is derived from the campaign response, so it has no adapter sample.
    assert.deepEqual(listPartnerizeCertificationSamples(), [
      "authenticate",
      "publishers",
      "campaigns",
      "vouchers",
    ]);
    assert.ok(!listProbeSourceObjects("optimise").includes("vouchers"), "leaked onto Optimise");
  });

  it("1d — it is a GET, and the endpoint key names both identifiers as placeholders", () => {
    const start = serviceSource.indexOf("  vouchers: {");
    const block = serviceSource.slice(start, serviceSource.indexOf("},", start));
    assert.match(block, /method: "GET"/);
    assert.match(block, /endpointKey: "GET \/user\/publisher\/\{publisherId\}\/campaign\/\{campaignId\}\/voucher"/);
    // No real identifier is baked into the registry.
    assert.ok(!block.includes(PUBLISHER_ID) && !block.includes(CAMPAIGN_ID));
  });
});

describe("partnerize vouchers — bounded", () => {
  it("2 — at most one supplier request, declared and observed", async () => {
    assert.equal(MAX_SUPPLIER_REQUESTS_PARTNERIZE_VOUCHERS, 1);
    const { adapter, spy } = adapterWith();
    const service = serviceWith(adapter);
    const result = await service.certify("partnerize", { sourceObjects: ["vouchers"] });

    assert.equal(spy.calls.length, 1, "more than one request was made");
    assert.equal(result.results[0].sourceObject, "vouchers");
    assert.equal(result.results[0].statusCategory, "OK");
    assert.equal(result.results[0].sampleCount, 1);
    // Strictly fewer than the campaign chain, which is the only probe allowed a second call.
    assert.ok(MAX_SUPPLIER_REQUESTS_PARTNERIZE_VOUCHERS < MAX_SUPPLIER_REQUESTS_PARTNERIZE_CAMPAIGNS);
  });

  it("2b — a failure is not retried", async () => {
    const failure = Object.assign(new Error("boom"), { response: { status: 500 } });
    const { adapter, spy } = adapterWith({ http: spyHttp(failure) });
    const service = serviceWith(adapter);
    const result = await service.certify("partnerize", { sourceObjects: ["vouchers"] });

    assert.equal(spy.calls.length, 1, "the request was retried");
    assert.equal(result.results[0].ok, false);
    assert.ok(result.results[0].statusCategory !== "OK");
  });

  it("2c — no pagination: one row is taken and no follow-up page is fetched", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...VOUCHER_ROW, voucher_code: `zzcodezz${i}` }));
    const { adapter, spy } = adapterWith({ http: spyHttp({ data: { voucher_codes: many } }) });
    const rows = await adapter.fetchCertificationVoucherSample({ timeoutMs: 3000 });

    assert.equal(rows.length, 1, "more than one row was kept");
    assert.equal(spy.calls.length, 1, "a second page was fetched");
    // The chain declares no follow-up.
    const start = serviceSource.indexOf("async certifyPartnerizeVouchers");
    const body = serviceSource.slice(start, serviceSource.indexOf("\n  }\n", start));
    assert.equal(body.split("fetchCertification").length - 1, 1, "more than one sampler call");
    assert.ok(!/for \(|while \(/.test(body), "the voucher chain loops");
  });

  it("2d — it goes through the shared certification limiter and the source budget", () => {
    const start = adapterSource.indexOf("async function sampleOnce");
    const body = adapterSource.slice(start, adapterSource.indexOf("\n  }", start));
    assert.match(body, /certLimiter\.acquireSlot\(\)/);
    assert.match(body, /PartnerizeCertificationThrottledError/);
    // The voucher sampler uses that primitive rather than its own request path.
    const voucher = adapterSource.slice(
      adapterSource.indexOf("async fetchCertificationVoucherSample"),
      adapterSource.indexOf("\n    },", adapterSource.indexOf("async fetchCertificationVoucherSample")),
    );
    assert.match(voucher, /return sampleOnce\(\s*"vouchers"/);
    assert.ok(!voucher.includes("httpClient"), "the voucher sampler bypasses sampleOnce");
    // And the service hands it the source budget, like every other chain.
    assert.match(serviceSource, /const rows = asRows\(await adapter\.fetchCertificationVoucherSample\(\{ timeoutMs \}\)\)/);
  });
});

describe("partnerize vouchers — identifiers are server-side only", () => {
  it("3 — a missing publisher id skips with its own category and sends nothing", async () => {
    for (const publisherId of [null, "", undefined]) {
      const { adapter, spy } = adapterWith({ publisherId, campaignId: CAMPAIGN_ID });
      const service = serviceWith(adapter, { publisherId });
      const result = await service.certify("partnerize", { sourceObjects: ["vouchers"] });
      assert.equal(result.results[0].statusCategory, "SKIPPED_NO_PUBLISHER_ID");
      assert.equal(spy.calls.length, 0, "a request was made without a publisher id");
    }
  });

  it("3b — a missing campaign id skips with a DIFFERENT category and sends nothing", async () => {
    for (const campaignId of [null, "", undefined]) {
      const { adapter, spy } = adapterWith({ publisherId: PUBLISHER_ID, campaignId });
      const service = serviceWith(adapter, { certificationCampaignId: campaignId });
      const result = await service.certify("partnerize", { sourceObjects: ["vouchers"] });
      assert.equal(result.results[0].statusCategory, "SKIPPED_NO_CERTIFICATION_CAMPAIGN_ID");
      assert.equal(spy.calls.length, 0, "a request was made without a campaign id");
    }
  });

  it("3c — an identifier carrying path or query syntax is refused, not encoded and sent", async () => {
    for (const nasty of ["../../admin", "a/b", "a?x=1", "a#f", "a b", "\\x", "  "]) {
      assert.equal(isPathSafePartnerizeId(nasty), false, `${nasty} was accepted`);

      const byPublisher = adapterWith({ publisherId: nasty });
      await assert.rejects(
        byPublisher.adapter.fetchCertificationVoucherSample({ timeoutMs: 1000 }),
        (e) => e instanceof PartnerizeNoPublisherIdError,
      );
      assert.equal(byPublisher.spy.calls.length, 0);

      const byCampaign = adapterWith({ campaignId: nasty });
      await assert.rejects(
        byCampaign.adapter.fetchCertificationVoucherSample({ timeoutMs: 1000 }),
        (e) => e instanceof PartnerizeNoCampaignIdError,
      );
      assert.equal(byCampaign.spy.calls.length, 0);
    }
  });

  it("4 — no caller-controlled path or identifier can reach the supplier", async () => {
    // The run body accepts five keys and none of them is an id, a path or an endpoint.
    assert.match(controllerSource, /const allowed = new Set\(\["sourceObjects", "region", "accountLabel", "compareRaw", "windowPreset"\]\);/);
    const { parseRunBody } = await import("../src/controllers/networkCertification.controller.js");
    for (const body of [
      { campaignId: "999" },
      { campaign_id: "999" },
      { publisherId: "999" },
      { path: "/user/publisher/999/campaign/999/voucher" },
      { endpoint: "x" },
      { voucherCampaignId: "999" },
    ]) {
      assert.throws(() => parseRunBody(body), /Unsupported field/);
    }
    // sourceObjects selects by NAME from the frozen registry; an unknown name cannot become a path.
    const { adapter, spy } = adapterWith();
    const service = serviceWith(adapter);
    for (const name of ["../../etc/passwd", "voucher", "vouchers/../campaign", "VOUCHERS"]) {
      await assert.rejects(
        service.certify("partnerize", { sourceObjects: [name] }),
        /Unknown source objects/,
        `${name} was not refused`,
      );
    }
    assert.equal(spy.calls.length, 0, "an unknown source object reached the supplier");
  });

  it("4b — the sampler reads only the adapter's configured values", () => {
    const start = adapterSource.indexOf("async fetchCertificationVoucherSample");
    const body = adapterSource.slice(start, adapterSource.indexOf("\n    },", start));
    // ctx supplies a timeout and nothing else: no ctx-supplied identifier reaches the path.
    assert.ok(!/ctx\.(publisherId|campaignId|campaign_id|path|endpoint)/.test(body));
    assert.match(body, /ctx\.timeoutMs/);
    assert.match(body, /publisherId: String\(publisherId\)/);
    assert.match(body, /campaignId: String\(certificationCampaignId\)/);
    // No discovery: the voucher sampler makes no publishers call.
    assert.ok(!body.includes('sampleOnce("publishers"'), "the voucher chain discovers a publisher");
    assert.ok(!body.includes("resolvePublisherId"), "the voucher chain resolves by request");
  });

  it("4c — the campaign id comes from the environment, never a request or a DB row", () => {
    const credentialsSource = readFileSync("src/modules/integrations/partnerizeCredentials.js", "utf8");
    assert.match(credentialsSource, /process\.env\.PARTNERIZE_CERTIFICATION_CAMPAIGN_ID \|\| null;/);
    const start = credentialsSource.indexOf("const certificationCampaignId");
    const line = credentialsSource.slice(start, credentialsSource.indexOf(";", start));
    assert.ok(!line.includes("await"), "the campaign id is fetched rather than configured");
    assert.ok(!line.includes("getMarketplace"), "the campaign id comes from a DB row");
  });
});

describe("partnerize vouchers — nothing leaks and nothing is written", () => {
  it("5 — no credential and no voucher value appears in the result", async () => {
    const { adapter } = adapterWith();
    const service = serviceWith(adapter);
    const result = await service.certify("partnerize", { sourceObjects: ["vouchers"] });

    const serialised = JSON.stringify(result);
    for (const [name, value] of Object.entries(CREDENTIALS)) {
      assert.ok(!serialised.includes(value), `${name} leaked`);
    }
    for (const [key, value] of Object.entries(VOUCHER_ROW)) {
      if (typeof value === "string" && value.startsWith("zz")) {
        assert.ok(!serialised.includes(value), `voucher value for ${key} leaked`);
      }
    }
    assert.ok(!serialised.includes(PUBLISHER_ID), "the publisher id leaked");
    assert.ok(!serialised.includes(CAMPAIGN_ID), "the campaign id leaked");
    // Field PATHS are what it reports. The generic extractRows does not know the `voucher_codes`
    // envelope — only fetchCoupons does — so the whole body is summarised and the envelope key
    // shows up in the dictionary. That is left alone deliberately: extractRows has nine callers,
    // including the fetchPaginated loop that drives hasMore/offset for every other Partnerize
    // endpoint, so teaching it a new key to tidy one probe's output would change production
    // pagination. Reporting the envelope is also strictly more information, and still no values.
    const entry = result.results.find((r) => r.sourceObject === "vouchers");
    assert.deepEqual(entry.fieldPaths.map((f) => f.path).sort(), [
      "voucher_codes",
      "voucher_codes[]",
      "voucher_codes[].active",
      "voucher_codes[].description",
      "voucher_codes[].start_date_time",
      "voucher_codes[].voucher_code",
      "voucher_codes[].voucher_code_id",
    ]);
    for (const field of entry.fieldPaths) {
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

  it("5b — a supplier error quoting the URL is reduced to a category", async () => {
    const leaky = Object.assign(
      new Error(`failed GET /user/publisher/${PUBLISHER_ID}/campaign/${CAMPAIGN_ID}/voucher`),
      { response: { status: 403, data: { key: CREDENTIALS.userApiKey } } },
    );
    const { adapter } = adapterWith({ http: spyHttp(leaky) });
    const service = serviceWith(adapter);
    const result = await service.certify("partnerize", { sourceObjects: ["vouchers"] });

    const serialised = JSON.stringify(result);
    for (const secret of [CREDENTIALS.userApiKey, CREDENTIALS.applicationKey, PUBLISHER_ID, CAMPAIGN_ID]) {
      assert.ok(!serialised.includes(secret), "an error leaked an identifier or credential");
    }
    assert.equal(result.results[0].statusCategory, "AUTH_FAILED");
  });

  it("6 — the voucher chain performs no database write", () => {
    const start = serviceSource.indexOf("async certifyPartnerizeVouchers");
    const body = serviceSource.slice(start, serviceSource.indexOf("\n  }\n", start));
    for (const forbidden of [
      "this.db",
      "prisma",
      ".create(",
      ".update(",
      ".upsert(",
      ".delete(",
      "persistRawPayload",
      "promote",
      "runSync",
      "sync(",
    ]) {
      assert.ok(!body.includes(forbidden), `the voucher chain does ${forbidden}`);
    }
  });

  it("7 — the route still carries no-store and no-cache, unchanged", () => {
    const start = routesSource.indexOf('"/ops/admin/network-certification/:network/run"');
    const block = routesSource.slice(start, routesSource.indexOf(");", start));
    assert.match(block, /authenticate,/);
    assert.match(block, /requirePermission\(PERMISSIONS\.INTEGRATIONS_MANAGE\),/);
    assert.match(block, /noStoreHeaders,/);
    assert.match(block, /certificationRateLimiter,/);
    assert.match(controllerSource, /"Cache-Control", "no-store"/);
    assert.match(controllerSource, /"Pragma", "no-cache"/);
  });
});

describe("partnerize vouchers — existing behaviour unchanged", () => {
  it("8 — the three certified source objects keep their exact contracts", async () => {
    const cases = [
      ["authenticate", "/user", {}],
      ["publishers", "/user/publisher", { limit: 1, offset: 0 }],
      ["campaigns", `/user/publisher/${PUBLISHER_ID}/campaign/a`, { limit: 1, offset: 0 }],
    ];
    for (const [sourceObject, path, params] of cases) {
      const { adapter, spy } = adapterWith({ http: spyHttp({ data: { data: [{ a: 1 }] } }) });
      const service = serviceWith(adapter);
      await service.certify("partnerize", { sourceObjects: [sourceObject] });
      assert.equal(spy.calls.length, 1, `${sourceObject} changed its request count`);
      assert.equal(spy.calls[0].path, path, `${sourceObject} changed its path`);
      assert.deepEqual(spy.calls[0].params, params, `${sourceObject} changed its parameters`);
    }
  });

  it("8b — the campaign chain still discovers a publisher id when one is not configured", async () => {
    const spy = spyHttp();
    spy.client.get = async (path, config = {}) => {
      spy.calls.push({ path, params: config.params });
      if (path === "/user/publisher") return { data: { publishers: [{ publisher_id: "DISCOVERED" }] } };
      return { data: { campaigns: [{ campaign_id: "c1" }] } };
    };
    const { adapter } = adapterWith({ publisherId: null, http: spy });
    const service = serviceWith(adapter, { publisherId: null });
    const result = await service.certify("partnerize", { sourceObjects: ["campaigns"] });

    assert.equal(result.results[0].statusCategory, "OK");
    assert.deepEqual(
      spy.calls.map((c) => c.path),
      ["/user/publisher", "/user/publisher/DISCOVERED/campaign/a"],
      "the campaign discovery chain changed",
    );
  });

  it("8c — the Optimise registry is untouched", () => {
    assert.deepEqual(listProbeSourceObjects("optimise"), [
      "campaigns",
      "voucher_codes",
      "conversions",
      "payment_overview",
      "invoices",
      "products",
      "reporting",
      "invoiceReporting",
      "commission_groups",
      "campaign_detail",
      "basket_items",
    ]);
  });

  it("8d — production sync fetchers are unchanged", () => {
    // The voucher probe shares no code with fetchCoupons: it does not call it, and fetchCoupons
    // still loops campaigns and still collects errors into stats.
    assert.match(adapterSource, /async fetchCoupons\(params = \{\}, stats = null\) \{/);
    assert.match(adapterSource, /for \(const campaignId of campaignIds\) \{/);
    assert.match(adapterSource, /stats\.voucherFetchErrors = stats\.voucherFetchErrors \|\| \[\];/);
    const start = adapterSource.indexOf("async fetchCertificationVoucherSample");
    const body = adapterSource.slice(start, adapterSource.indexOf("\n    },", start));
    assert.ok(!body.includes("fetchCoupons"), "certification reuses the sync fetcher");
  });
});
