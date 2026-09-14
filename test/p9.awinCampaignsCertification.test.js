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

const { createAwinAdapter, listAwinCertificationSamples, AWIN_CERTIFICATION_MAX_ROWS } = await import(
  "../src/adapters/awin.adapter.js"
);
const { NetworkCertificationService, listProbeNetworks, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);

const ADAPTER_SRC = readFileSync("src/adapters/awin.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

const TOKEN = "zzaccesstokenzz";
const PUBLISHER_ID = "zzpub9876zz";

/** Every value distinctive: any of them in the result is a leak. */
const PROGRAMME_ROW = {
  id: 111222,
  name: "zzadvertisernamezz",
  displayUrl: "https://zzmerchantzz.example/shop",
  clickThroughUrl: "https://www.awin1.com/cread.php?zzcreadzz",
  logoUrl: "https://zzlogozz.example/logo.png",
  description: "zzdescriptionzz",
  currencyCode: "GBP",
  validDomains: [{ domain: "zzdomainzz.example" }],
  commissionRange: [{ min: 1.5, max: 12.75, type: "percentage" }],
  primaryRegion: { name: "zzregionzz", countryCode: "GB" },
  validDomainsCount: 1,
};

function envelope(rows) {
  return { data: rows };
}

function spyHttp(response) {
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

/** The REAL adapter, with only its transport replaced — path, params and row bound are its own. */
function adapterWith(response, { publisherId = PUBLISHER_ID } = {}) {
  const spy = spyHttp(response);
  return {
    spy,
    adapter: createAwinAdapter({ accessToken: TOKEN, publisherId, httpClient: spy.client }),
  };
}

/** The real service driving the real adapter. No sampler is reimplemented anywhere in this file. */
function serviceWith({ response, publisherId = PUBLISHER_ID, credentials } = {}) {
  const spy = spyHttp(response);
  return {
    spy,
    service: new NetworkCertificationService({
      prisma: {},
      adapterFactory: (config) => {
        // Prove the service passes RESOLVED credentials through, not caller input.
        assert.equal(config.accessToken, TOKEN);
        assert.equal(String(config.publisherId), String(publisherId));
        return createAwinAdapter({ ...config, httpClient: spy.client });
      },
      awinCredentialResolver: async () =>
        credentials === null ? null : { accessToken: TOKEN, publisherId, ...credentials },
    }),
  };
}

const certify = async (opts) => {
  const { service, spy } = serviceWith(opts);
  const result = await service.certify("awin", { sourceObjects: ["campaigns"] });
  return { result, spy, entry: result.results.find((r) => r.sourceObject === "campaigns") };
};

/* ------------------------------------------------------- registration */

describe("awin is registered in the certification framework", () => {
  it("1 — awin appears as a probeable network with campaigns", () => {
    assert.ok(listProbeNetworks().includes("awin"));
    assert.deepEqual(listProbeSourceObjects("awin"), ["campaigns"]);
    assert.deepEqual(listAwinCertificationSamples(), ["campaigns"]);
  });

  it("1b — the caller-facing catalog is derived from the registry, not a second list", () => {
    const controller = readFileSync("src/controllers/networkCertification.controller.js", "utf8");
    assert.ok(controller.includes("listProbeNetworks()"));
    assert.ok(!/\["optimise", "partnerize"\]/.test(controller), "a hard-coded network list remains");
  });

  it("1c — only campaigns is registered: no transactions, commission groups or tracking links", () => {
    for (const absent of ["transactions", "commission_groups", "offers", "payments", "invoices", "product_feeds"]) {
      assert.ok(!listProbeSourceObjects("awin").includes(absent), absent);
    }
  });

  it("1d — an unresolved credential is a configuration outcome, and makes no request", async () => {
    const { service, spy } = serviceWith({ response: envelope([PROGRAMME_ROW]), credentials: null });
    await assert.rejects(() => service.certify("awin", { sourceObjects: ["campaigns"] }), /not configured/i);
    assert.equal(spy.calls.length, 0, "a request was made without credentials");
  });
});

/* ------------------------------------------------------- endpoint pinning */

describe("awin campaigns — the endpoint is pinned to production's", () => {
  it("2 — the probe path is exactly the one fetchCampaigns builds", async () => {
    const { spy } = await certify({ response: envelope([PROGRAMME_ROW]) });
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, `/publishers/${PUBLISHER_ID}/programmes`);
  });

  it("2b — production sync still builds that same path, so the probe cannot drift", () => {
    assert.match(ADAPTER_SRC, /`\/publishers\/\$\{pubId\}\/programmes`/);
    // And the certification spec builds it from resolved values, not a caller's ctx.
    assert.match(ADAPTER_SRC, /path: \(resolved\) => `\/publishers\/\$\{resolved\.publisherId\}\/programmes`/);
  });

  it("2c — only the evidenced parameter is sent: no limit, page, offset or cursor", async () => {
    const { spy } = await certify({ response: envelope([PROGRAMME_ROW]) });
    assert.deepEqual(spy.calls[0].params, { relationship: "joined" });
    // fetchCampaigns defaults to the same relationship.
    assert.match(ADAPTER_SRC, /relationship: params\.relationship \?\? "joined",/);
    assert.match(ADAPTER_SRC, /params: \(\) => \(\{ relationship: "joined" \}\)/);
  });

  it("2d — no new endpoint was invented: the adapter still builds exactly five paths", () => {
    const code = ADAPTER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const paths = [...code.matchAll(/[`"'](\/[A-Za-z0-9_/{}$().:-]+)[`"']/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(paths)].sort(), [
      "/publisher/${pubId}/promotions",
      "/publishers/${pubId}/accounts",
      "/publishers/${pubId}/commissiongroups",
      "/publishers/${pubId}/programmes",
      "/publishers/${pubId}/transactions/",
      "/publishers/${resolved.publisherId}/programmes",
    ]);
  });
});

describe("awin campaigns — the adapter sampler itself", () => {
  it("2e — fetchCertificationSample issues the one request and keeps one row", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...PROGRAMME_ROW, id: 900000 + i }));
    const { adapter, spy } = adapterWith(envelope(many));
    const rows = await adapter.fetchCertificationSample("campaigns", { timeoutMs: 3000 });

    assert.equal(rows.length, 1, "more than one row was kept");
    assert.equal(spy.calls.length, 1, "more than one request");
    assert.equal(spy.calls[0].path, `/publishers/${PUBLISHER_ID}/programmes`);
    assert.deepEqual(spy.calls[0].params, { relationship: "joined" });
    assert.equal(spy.calls[0].timeout, 3000);
  });

  it("2f — it reads the same collection keys production reads", async () => {
    for (const payload of [
      { programmes: [PROGRAMME_ROW] },
      { data: [PROGRAMME_ROW] },
      [PROGRAMME_ROW],
    ]) {
      const { adapter } = adapterWith({ data: payload });
      assert.equal((await adapter.fetchCertificationSample("campaigns")).length, 1);
    }
  });

  it("2g — an unknown source object is refused before any request", async () => {
    const { adapter, spy } = adapterWith(envelope([PROGRAMME_ROW]));
    await assert.rejects(
      () => adapter.fetchCertificationSample("transactions"),
      /No Awin certification sample is defined/,
    );
    assert.equal(spy.calls.length, 0, "a request was made for an unregistered source object");
  });

  it("2h — the publisher id in the path is the adapter's own, url-encoded", async () => {
    const { spy } = (() => {
      const s = spyHttp(envelope([PROGRAMME_ROW]));
      const a = createAwinAdapter({ accessToken: TOKEN, publisherId: "a b/c", httpClient: s.client });
      return { adapter: a, spy: s, run: a.fetchCertificationSample("campaigns") };
    })();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(spy.calls[0].path, "/publishers/a%20b%2Fc/programmes");
  });
});

/* ------------------------------------------------------- bounds */

describe("awin campaigns — one request, one row, no pagination", () => {
  it("3 — exactly one supplier request", async () => {
    const { spy } = await certify({ response: envelope([PROGRAMME_ROW]) });
    assert.equal(spy.calls.length, 1);
  });

  it("3b — a 50-row page yields one row and no follow-up request", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...PROGRAMME_ROW, id: 900000 + i }));
    const { entry, spy } = await certify({ response: envelope(many) });
    assert.equal(entry.sampleCount, 1, "more than one row was kept");
    assert.equal(spy.calls.length, 1, "a second page was fetched");
    assert.equal(AWIN_CERTIFICATION_MAX_ROWS, 1);
  });

  it("3c — the chain declares no loop and no second sampler call", () => {
    const start = SERVICE_SRC.indexOf("async certifyAwinCampaigns");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.ok(start > -1);
    assert.equal(body.split("fetchCertification").length - 1, 1, "more than one sampler call");
    assert.ok(!/for \(|while \(|hasMore|offset|page\+\+/.test(body), "the chain loops");
  });

  it("3d — the sampler does not retry, so one rejection stays one", () => {
    const start = ADAPTER_SRC.indexOf("async fetchCertificationSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.ok(!body.includes("requestWithRetry"), "the probe inherited sync's three retries");
    assert.ok(body.includes("awinRateLimiter.acquireSlot()"), "the probe skips the shared limiter");
    assert.ok(!body.includes("await get("), "the probe went through the retrying helper");
  });

  it("3e — a supplier failure is one attempt reduced to a category", async () => {
    const failure = Object.assign(new Error("boom"), { response: { status: 500 } });
    const { entry, spy } = await certify({ response: failure });
    assert.equal(spy.calls.length, 1, "the request was retried");
    assert.equal(entry.ok, false);
    assert.ok(entry.statusCategory !== "OK" && entry.statusCategory !== "OK_NO_ROWS");
    assert.equal(entry.sampleCount, 0);
  });
});

/* ------------------------------------------------------- publisher id */

describe("awin campaigns — the publisher id is never caller-controlled", () => {
  it("4 — a caller-supplied publisherId does not reach the path", async () => {
    const { service, spy } = serviceWith({ response: envelope([PROGRAMME_ROW]) });
    await service.certify("awin", {
      sourceObjects: ["campaigns"],
      publisherId: "zzattackerzz",
      publisher_id: "zzattackerzz",
      path: "/publishers/zzattackerzz/programmes",
    });
    assert.equal(spy.calls[0].path, `/publishers/${PUBLISHER_ID}/programmes`);
    assert.ok(!JSON.stringify(spy.calls).includes("zzattackerzz"), "a caller value reached the request");
  });

  it("4a2 — the ADAPTER ignores a publisherId handed to the sampler in ctx", async () => {
    // Defence in depth: the service does not forward caller options into ctx today, so this pins
    // the adapter's own behaviour rather than relying on that remaining true.
    const { adapter, spy } = adapterWith(envelope([PROGRAMME_ROW]));
    await adapter.fetchCertificationSample("campaigns", {
      publisherId: "zzattackerzz",
      path: "/publishers/zzattackerzz/programmes",
      params: { relationship: "notjoined" },
    });
    assert.equal(spy.calls[0].path, `/publishers/${PUBLISHER_ID}/programmes`);
    assert.deepEqual(spy.calls[0].params, { relationship: "joined" });
    assert.ok(!JSON.stringify(spy.calls).includes("zzattackerzz"));
  });

  it("4a3 — the sampler reads only timeoutMs out of ctx", () => {
    const start = ADAPTER_SRC.indexOf("async fetchCertificationSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.deepEqual([...new Set([...body.matchAll(/ctx\.([A-Za-z_]+)/g)].map((m) => m[1]))], ["timeoutMs"]);
  });

  it("4b — the id comes from the resolver, and the resolver reads configuration only", () => {
    const resolver = readFileSync("src/modules/integrations/awinCredentials.js", "utf8");
    assert.match(resolver, /process\.env\.AWIN_PUBLISHER_ID/);
    assert.match(resolver, /getMarketplaceExternalId\("awin", accountLabel\)/);
    // Nothing accepts an id argument, and nothing discovers one with a request.
    assert.match(resolver, /export async function resolveAwinCertificationCredentials\(accountLabel = "default"\)/);
    assert.ok(!/httpClient|axios|fetch\(/.test(resolver), "the resolver makes a request");
  });

  it("4b2 — the resolver returns a credential only when BOTH halves are present", async (t) => {
    const { resolveAwinCertificationCredentials } = await import(
      "../src/modules/integrations/awinCredentials.js"
    );
    const saved = { token: process.env.AWIN_ACCESS_TOKEN, pub: process.env.AWIN_PUBLISHER_ID };
    t.after(() => {
      if (saved.token === undefined) delete process.env.AWIN_ACCESS_TOKEN;
      else process.env.AWIN_ACCESS_TOKEN = saved.token;
      if (saved.pub === undefined) delete process.env.AWIN_PUBLISHER_ID;
      else process.env.AWIN_PUBLISHER_ID = saved.pub;
    });

    process.env.AWIN_ACCESS_TOKEN = TOKEN;
    delete process.env.AWIN_PUBLISHER_ID;
    assert.equal(await resolveAwinCertificationCredentials("nope"), null, "token without publisher id");

    delete process.env.AWIN_ACCESS_TOKEN;
    process.env.AWIN_PUBLISHER_ID = PUBLISHER_ID;
    assert.equal(await resolveAwinCertificationCredentials("nope"), null, "publisher id without token");

    process.env.AWIN_ACCESS_TOKEN = TOKEN;
    assert.deepEqual(await resolveAwinCertificationCredentials("nope"), {
      accessToken: TOKEN,
      publisherId: PUBLISHER_ID,
    });
  });

  it("4c — the service builder passes resolved credentials only", () => {
    const start = SERVICE_SRC.indexOf("async buildAwinAdapter(");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.match(body, /credentials\.publisherId/);
    assert.ok(!/ctx\.|options\.|req\./.test(body), "caller input reaches the builder");
  });
});

/* ------------------------------------------------------- outcomes */

describe("awin campaigns — honest outcomes", () => {
  it("5 — one row yields a structural field dictionary", async () => {
    const { entry } = await certify({ response: envelope([PROGRAMME_ROW]) });
    assert.equal(entry.ok, true);
    assert.equal(entry.statusCategory, "OK");
    assert.equal(entry.sampleCount, 1);
    assert.equal(entry.endpointKey, "GET /publishers/{publisherId}/programmes");
    assert.equal(entry.httpMethod, "GET");
    assert.ok(entry.fieldCount > 5);
    assert.equal(entry.fieldCount, entry.fieldPaths.length);
    const paths = entry.fieldPaths.map((f) => f.path);
    assert.ok(paths.includes("commissionRange[].type"));
    assert.ok(paths.includes("primaryRegion.countryCode"));
  });

  it("6 — zero rows is OK_NO_ROWS with the schema still unknown", async () => {
    const { entry, spy } = await certify({ response: envelope([]) });
    assert.equal(entry.ok, true, "the endpoint answered; it is not a failure");
    assert.equal(entry.statusCategory, "OK_NO_ROWS");
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(entry.sampleCount, 0);
    assert.equal(entry.fieldCount, 0);
    assert.deepEqual(entry.fieldPaths, []);
    assert.equal(spy.calls.length, 1);
  });

  it("6b — OK_NO_ROWS is not plain OK, and a sampled row is not marked unknown", async () => {
    const empty = await certify({ response: envelope([]) });
    const sampled = await certify({ response: envelope([PROGRAMME_ROW]) });
    assert.notEqual(empty.entry.statusCategory, sampled.entry.statusCategory);
    assert.equal(sampled.entry.schema, undefined);
  });

  it("7 — the run is declared read-only and writes nothing", async () => {
    const { result } = await certify({ response: envelope([PROGRAMME_ROW]) });
    assert.equal(result.readOnly, true);
    assert.equal(result.network, "awin");
    const start = SERVICE_SRC.indexOf("async certifyAwinCampaigns");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.ok(!/this\.db\.|prisma\.|\.create\(|\.update\(|\.upsert\(/.test(body), "the chain writes");
  });
});

/* ------------------------------------------------------- leakage */

describe("awin campaigns — nothing but structure leaves", () => {
  it("8 — no id, name, URL, description, currency or commission value appears", async () => {
    const { result } = await certify({ response: envelope([PROGRAMME_ROW]) });
    const serialised = JSON.stringify(result);
    for (const banned of [
      "zzadvertisernamezz",
      "zzmerchantzz",
      "zzcreadzz",
      "zzlogozz",
      "zzdescriptionzz",
      "zzdomainzz",
      "zzregionzz",
      "111222",
      "12.75",
      "GBP",
      "awin1.com",
      "https://",
      TOKEN,
      PUBLISHER_ID,
    ]) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
  });

  it("8b — every reported field is structure only", async () => {
    const { entry } = await certify({ response: envelope([PROGRAMME_ROW]) });
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
    assert.equal(entry.rows, undefined, "raw rows were returned");
    assert.equal(entry.rawPayload, undefined);
  });

  it("8c — a supplier error quoting the token is reduced to a category", async () => {
    const leaky = Object.assign(new Error(`401 for Bearer ${TOKEN}`), {
      response: { status: 401, data: { token: TOKEN, publisher: PUBLISHER_ID } },
    });
    const { result } = await certify({ response: leaky });
    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes(TOKEN));
    assert.ok(!serialised.includes(PUBLISHER_ID));
    assert.equal(result.results[0].statusCategory, "AUTH_FAILED");
  });
});

/* ------------------------------------------------------- no collateral change */

describe("nothing else changed", () => {
  it("9 — Optimise and Partnerize registries are untouched", () => {
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
    assert.deepEqual(listProbeSourceObjects("partnerize"), [
      "authenticate",
      "publishers",
      "campaigns",
      "vouchers",
      "conversions",
      "invoices",
      "payments",
      "commission_structure",
    ]);
  });

  it("9b — awin has its own chain, so the generic branch is unchanged", () => {
    assert.ok(SERVICE_SRC.includes('if (probe.chain === "awinCampaigns")'));
    // The generic branch still reports plain OK for zero rows, as Optimise relies on.
    const generic = SERVICE_SRC.slice(SERVICE_SRC.indexOf("// Exactly one bounded supplier request. Never a sync fetcher."));
    assert.ok(generic.includes('statusCategory: "OK",'));
    assert.ok(!generic.includes("OK_NO_ROWS"), "the generic branch gained zero-row handling");
  });

  it("9c — production AWIN sync fetchers are unchanged", () => {
    assert.match(ADAPTER_SRC, /async fetchCampaigns\(params = \{\}, stats = null\) \{/);
    assert.match(ADAPTER_SRC, /relationship: params\.relationship \?\? "joined",/);
    assert.match(ADAPTER_SRC, /async fetchConversions\(params = \{\}, stats = null\) \{/);
    assert.match(ADAPTER_SRC, /showBasketProducts: params\.showBasketProducts !== false,/);
    const start = ADAPTER_SRC.indexOf("async fetchCertificationSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.ok(!body.includes("fetchCampaigns"), "certification reuses the sync fetcher");
  });

  it("9d — no tracking-link, commission-group or transaction certification was added", () => {
    for (const absent of ["awinTransactions", "awinCommissionGroups", "awinTrackingLinks"]) {
      assert.ok(!SERVICE_SRC.includes(absent), absent);
    }
  });
});
