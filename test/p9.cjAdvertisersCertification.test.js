import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { createCjAdapter, extractCjAdvertisers, CJ_CERTIFICATION_MAX_ROWS } = await import(
  "../src/adapters/cj.adapter.js"
);
const { NetworkCertificationService, listProbeNetworks, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/cj.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/cjSupplierSync.js", "utf8");

const TOKEN = "zzcjtokenzz";
const CID = "zzcidzz";
const WEBSITE_ID = "zzwebsitezz";

/** One <advertiser> block inside the real envelope shape: every value distinctive. */
const ADVERTISER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cj-api>
  <advertisers total-matched="1" records-returned="1" page-number="1">
    <advertiser>
      <advertiser-id>zzadvidzz</advertiser-id>
      <advertiser-name>zzadvnamezz</advertiser-name>
      <account-status>Active</account-status>
      <program-url>https://zzmerchantzz.example/program</program-url>
      <relationship-status>joined</relationship-status>
      <language>en</language>
      <seven-day-epc>12.34</seven-day-epc>
      <three-month-epc>56.78</three-month-epc>
      <mobile-tracking-certified>true</mobile-tracking-certified>
      <network-rank>42</network-rank>
      <performance-incentives>false</performance-incentives>
      <primary-category><parent>zzparentcatzz</parent><child>zzchildcatzz</child></primary-category>
    </advertiser>
  </advertisers>
</cj-api>`;

/** The same envelope with no advertiser blocks: the no-joined-campaigns account state. */
const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cj-api>
  <advertisers total-matched="0" records-returned="0" page-number="1"></advertisers>
</cj-api>`;

function spyHttp(xmlOrError = ADVERTISER_XML) {
  const calls = [];
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, params: config.params, responseType: config.responseType, timeout: config.timeout, config });
        if (xmlOrError instanceof Error) throw xmlOrError;
        return { data: xmlOrError };
      },
    },
  };
}

function adapterWith(xmlOrError, { requestorCid = CID } = {}) {
  const spy = spyHttp(xmlOrError);
  return {
    spy,
    adapter: createCjAdapter({
      accessToken: TOKEN,
      requestorCid,
      websiteId: WEBSITE_ID,
      httpClient: spy.client,
    }),
  };
}

function serviceWith(xmlOrError, { credentials } = {}) {
  const spy = spyHttp(xmlOrError);
  return {
    spy,
    service: new NetworkCertificationService({
      prisma: {},
      adapterFactory: (config) => {
        // The service passes RESOLVED credentials through, not caller input.
        assert.equal(config.accessToken, TOKEN);
        assert.equal(config.requestorCid, CID);
        return createCjAdapter({ ...config, httpClient: spy.client });
      },
      cjCredentialResolver: async () =>
        credentials === null
          ? null
          : { accessToken: TOKEN, requestorCid: CID, websiteId: WEBSITE_ID, ...credentials },
    }),
  };
}

const certify = async (xmlOrError, runOptions = {}) => {
  const { service, spy } = serviceWith(xmlOrError);
  const result = await service.certify("cj", { sourceObjects: ["advertisers"], ...runOptions });
  return { result, spy, entry: result.results[0] };
};

/* ------------------------------------------------------- registration */

describe("cj is registered in the certification framework", () => {
  it("1 - cj is a probeable network with advertisers", () => {
    assert.ok(listProbeNetworks().includes("cj"));
    assert.deepEqual(listProbeSourceObjects("cj"), ["advertisers"]);
  });

  it("2 - only advertisers is registered: the GraphQL-gated objects stay out", () => {
    for (const absent of ["links", "coupons", "program_terms", "products", "commission_detail"]) {
      assert.ok(!listProbeSourceObjects("cj").includes(absent), absent);
    }
  });

  it("3 - the caller-facing catalog picks cj up from the registry", () => {
    const controller = readFileSync("src/controllers/networkCertification.controller.js", "utf8");
    assert.ok(controller.includes("listProbeNetworks()"));
    assert.ok(!/\["optimise", "partnerize"\]/.test(controller));
  });

  it("4 - the source-object catalog already carries advertisers as live", () => {
    const entry = getSourceObject("cj", "advertisers");
    assert.ok(entry);
    assert.equal(entry.live, true);
    assert.match(entry.notes, /not payable commission truth/);
  });

  it("5 - an unresolved credential is a configuration outcome, and makes no request", async () => {
    const { service, spy } = serviceWith(ADVERTISER_XML, { credentials: null });
    await assert.rejects(
      () => service.certify("cj", { sourceObjects: ["advertisers"] }),
      /not configured/i,
    );
    assert.equal(spy.calls.length, 0, "a request was made without credentials");
  });
});

/* ------------------------------------------------------- endpoint */

describe("the endpoint is pinned to production's", () => {
  it("6 - exactly the advertiser-lookup path, and only that path", async () => {
    const { spy } = await certify();
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, "/v2/advertiser-lookup");
    assert.match(ADAPTER_SRC, /path: "\/v2\/advertiser-lookup",/);
    // The link-search path is never touched by this probe.
    assert.ok(!spy.calls.some((c) => c.path.includes("link-search")));
  });

  it("7 - advertiser-ids=joined is pinned, exactly as production defaults it", async () => {
    const { spy } = await certify();
    assert.equal(spy.calls[0].params["advertiser-ids"], "joined");
    assert.match(ADAPTER_SRC, /"advertiser-ids": params\["advertiser-ids"\] \?\? params\.advertiserIds \?\? "joined",/);
    assert.match(ADAPTER_SRC, /"advertiser-ids": "joined",/);
    // And the sync job asks for the same thing.
    assert.match(SYNC_SRC, /adapter\.fetchCampaigns\(\{ "advertiser-ids": "joined" \}, stats\)/);
  });

  it("8 - the requestor-cid comes from configuration and the page is production's", async () => {
    const { spy } = await certify();
    const params = spy.calls[0].params;
    assert.equal(params["requestor-cid"], CID);
    assert.equal(params["records-per-page"], 100, "a page size production never asks for");
    assert.equal(params["page-number"], 1);
    assert.deepEqual(Object.keys(params).sort(), [
      "advertiser-ids",
      "page-number",
      "records-per-page",
      "requestor-cid",
    ]);
  });

  it("9 - it asks for XML text, as production does", async () => {
    const { spy } = await certify();
    assert.equal(spy.calls[0].responseType, "text");
    assert.match(ADAPTER_SRC, /responseType: "text"/);
  });
});

/* ------------------------------------------------------- no caller input */

describe("nothing is caller-controlled", () => {
  it("10 - a caller-supplied CID or advertiser id never reaches the request", async () => {
    const { service, spy } = serviceWith(ADVERTISER_XML);
    await service.certify("cj", {
      sourceObjects: ["advertisers"],
      requestorCid: "zzattackerzz",
      "requestor-cid": "zzattackerzz",
      advertiserIds: "zzattackerzz",
      "advertiser-ids": "zzattackerzz",
      websiteId: "zzattackerzz",
    });
    assert.equal(spy.calls[0].params["requestor-cid"], CID);
    assert.equal(spy.calls[0].params["advertiser-ids"], "joined");
    assert.ok(!JSON.stringify(spy.calls).includes("zzattackerzz"), "a caller value reached the request");
  });

  it("11 - the sampler takes no identifiers at all, only a timeout", () => {
    assert.match(ADAPTER_SRC, /async fetchCertificationAdvertiserSample\(\{ timeoutMs \} = \{\}\)/);
    const start = ADAPTER_SRC.indexOf("async fetchCertificationAdvertiserSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    for (const forbidden of ["params[", "params.", "ctx.", "options."]) {
      assert.ok(!body.includes(forbidden), forbidden);
    }
    // The CID it uses is the adapter's own closure value.
    assert.match(body, /"requestor-cid": requestorCid,/);
  });

  it("12 - the chain takes no caller input either", () => {
    const signature = SERVICE_SRC.slice(
      SERVICE_SRC.indexOf("async certifyCjAdvertisers("),
      SERVICE_SRC.indexOf(") {", SERVICE_SRC.indexOf("async certifyCjAdvertisers(")) + 1,
    );
    assert.equal(signature, "async certifyCjAdvertisers({ adapter, key, probe, budgetLeft })");
  });

  it("13 - the resolver reads configuration only, in production's order", () => {
    const resolver = readFileSync("src/modules/integrations/cjCredentials.js", "utf8");
    assert.match(resolver, /process\.env\.CJ_ACCESS_TOKEN/);
    assert.match(resolver, /getOAuthAccessToken\("cj", accountLabel\)/);
    assert.match(resolver, /getMarketplaceApiKey\("cj", accountLabel\)/);
    assert.match(resolver, /process\.env\.CJ_PUBLISHER_CID \|\| process\.env\.CJ_REQUESTOR_CID/);
    assert.match(resolver, /process\.env\.CJ_WEBSITE_ID \|\| process\.env\.CJ_PID/);
    assert.ok(!/httpClient|axios|fetch\(/.test(resolver), "the resolver makes a request");
    // The same order the sync job uses.
    assert.match(SYNC_SRC, /process\.env\.CJ_PUBLISHER_CID \|\| process\.env\.CJ_REQUESTOR_CID/);
  });

  it("13b - the resolver returns a credential only when ALL THREE parts are present", async (t) => {
    const { resolveCjCertificationCredentials } = await import(
      "../src/modules/integrations/cjCredentials.js"
    );
    const saved = {
      token: process.env.CJ_ACCESS_TOKEN,
      cid: process.env.CJ_PUBLISHER_CID,
      alias: process.env.CJ_REQUESTOR_CID,
      site: process.env.CJ_WEBSITE_ID,
      pid: process.env.CJ_PID,
    };
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    t.after(() => {
      restore("CJ_ACCESS_TOKEN", saved.token);
      restore("CJ_PUBLISHER_CID", saved.cid);
      restore("CJ_REQUESTOR_CID", saved.alias);
      restore("CJ_WEBSITE_ID", saved.site);
      restore("CJ_PID", saved.pid);
    });

    for (const key of ["CJ_ACCESS_TOKEN", "CJ_PUBLISHER_CID", "CJ_REQUESTOR_CID", "CJ_WEBSITE_ID", "CJ_PID"]) {
      delete process.env[key];
    }
    assert.equal(await resolveCjCertificationCredentials("nope"), null, "nothing configured");

    process.env.CJ_ACCESS_TOKEN = TOKEN;
    assert.equal(await resolveCjCertificationCredentials("nope"), null, "token alone");

    process.env.CJ_PUBLISHER_CID = CID;
    assert.equal(await resolveCjCertificationCredentials("nope"), null, "token and cid, no website");

    process.env.CJ_WEBSITE_ID = WEBSITE_ID;
    assert.deepEqual(await resolveCjCertificationCredentials("nope"), {
      accessToken: TOKEN,
      requestorCid: CID,
      websiteId: WEBSITE_ID,
    });

    // The production aliases work too.
    delete process.env.CJ_PUBLISHER_CID;
    delete process.env.CJ_WEBSITE_ID;
    process.env.CJ_REQUESTOR_CID = CID;
    process.env.CJ_PID = WEBSITE_ID;
    assert.deepEqual(await resolveCjCertificationCredentials("nope"), {
      accessToken: TOKEN,
      requestorCid: CID,
      websiteId: WEBSITE_ID,
    });
  });

  it("14 - no new auth model: still a Bearer personal access token", () => {
    assert.match(ADAPTER_SRC, /const authorization = `Bearer \$\{accessToken\}`;/);
    const resolver = readFileSync("src/modules/integrations/cjCredentials.js", "utf8");
    assert.ok(!/oauth2|client_secret|signature|hmac/i.test(resolver.replace(/getOAuthAccessToken/g, "")));
  });
});

/* ------------------------------------------------------- bounds */

describe("one request, one row, no pagination", () => {
  it("15 - exactly one supplier request", async () => {
    const { spy } = await certify();
    assert.equal(spy.calls.length, 1);
  });

  it("16 - a full page of advertisers yields one row and no follow-up page", async () => {
    const blocks = Array.from(
      { length: 60 },
      (_, i) => `<advertiser><advertiser-id>id${i}</advertiser-id><advertiser-name>n${i}</advertiser-name></advertiser>`,
    ).join("");
    const xml = `<cj-api><advertisers total-matched="600" records-returned="60" page-number="1">${blocks}</advertisers></cj-api>`;
    const { entry, spy } = await certify(xml);
    assert.equal(entry.sampleCount, 1, "more than one row was kept");
    assert.equal(spy.calls.length, 1, "a second page was fetched");
    assert.equal(CJ_CERTIFICATION_MAX_ROWS, 1);
  });

  it("17 - the sampler bypasses fetchPaged, which is the thing that loops", () => {
    const start = ADAPTER_SRC.indexOf("async fetchCertificationAdvertiserSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.ok(!body.includes("fetchPaged"), "the probe went through the paging helper");
    assert.ok(!/for \(|while \(|page \+= 1/.test(body), "the sampler loops");
    // fetchPaged still exists for production and still loops.
    assert.match(ADAPTER_SRC, /for \(let i = 0; i < MAX_PAGE_COUNT; i \+= 1\)/);
  });

  it("18 - the sampler does not retry", () => {
    const start = ADAPTER_SRC.indexOf("async fetchCertificationAdvertiserSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.ok(!body.includes("requestWithRetry"), "the probe inherited sync's three retries");
    assert.ok(!body.includes("getXml("), "the probe went through the retrying helper");
    // Production still retries.
    assert.match(ADAPTER_SRC, /\{ retries: 3, delayMs: 1000 \},/);
  });

  it("19 - a failing request is one attempt, reduced to a category", async () => {
    const failure = Object.assign(new Error("boom"), {
      response: { status: 401, data: "<error>bad token</error>" },
    });
    const { entry, spy } = await certify(failure);
    assert.equal(spy.calls.length, 1, "the failing request was retried");
    assert.equal(entry.ok, false);
    assert.equal(entry.statusCategory, "AUTH_FAILED");
    assert.equal(entry.supplierStatusCode, 401);
  });

  it("20 - the chain writes nothing", () => {
    const start = SERVICE_SRC.indexOf("async certifyCjAdvertisers(");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.ok(!/this\.db\.|prisma\.|\.create\(|\.update\(|\.upsert\(/.test(body), "the chain writes");
    assert.ok(!/for \(|while \(/.test(body), "the chain loops");
  });

  it("16b - the ADAPTER bounds its own sample, independently of the service", async () => {
    // Defence in depth: both layers slice, so removing either is invisible unless the other is
    // bypassed. This calls the sampler directly.
    const blocks = Array.from(
      { length: 45 },
      (_, i) => `<advertiser><advertiser-id>id${i}</advertiser-id></advertiser>`,
    ).join("");
    const { adapter, spy } = adapterWith(
      `<cj-api><advertisers records-returned="45">${blocks}</advertisers></cj-api>`,
    );
    const rows = await adapter.fetchCertificationAdvertiserSample({ timeoutMs: 3000 });
    assert.equal(rows.length, 1, "the adapter kept more than one row");
    assert.equal(spy.calls.length, 1);
  });

  it("16c - the sampler refuses to request without a configured CID", async () => {
    const { adapter, spy } = adapterWith(ADVERTISER_XML, { requestorCid: null });
    await assert.rejects(
      () => adapter.fetchCertificationAdvertiserSample({}),
      /requires requestor-cid/,
    );
    assert.equal(spy.calls.length, 0, "a request was made with no CID");
  });

  it("20b - the SERVICE bounds the row too, independently of the adapter", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ advertiser_id: `id${i}`, advertiser_name: `n${i}` }));
    const service = new NetworkCertificationService({
      prisma: {},
      adapterFactory: () => ({
        supplierKey: "CJ",
        fetchCertificationAdvertiserSample: async () => many,
      }),
      cjCredentialResolver: async () => ({ accessToken: TOKEN, requestorCid: CID, websiteId: WEBSITE_ID }),
    });
    const result = await service.certify("cj", { sourceObjects: ["advertisers"] });
    assert.equal(result.results[0].sampleCount, 1, "the service kept more than one row");
    assert.equal(result.results[0].fieldPaths[0].sampleCount, 1);
  });
});

/* ------------------------------------------------------- XML row, not envelope */

describe("a parsed ROW is certified, never the XML envelope", () => {
  it("21 - the field paths are the advertiser's own", async () => {
    const { entry } = await certify();
    assert.equal(entry.statusCategory, "OK");
    assert.equal(entry.sampleCount, 1);
    const paths = entry.fieldPaths.map((f) => f.path).sort();
    assert.ok(paths.includes("advertiser_id"));
    assert.ok(paths.includes("primary_category.parent"));
    assert.ok(paths.includes("seven_day_epc"));
  });

  it("22 - no envelope element becomes a field", async () => {
    const { entry } = await certify();
    const paths = entry.fieldPaths.map((f) => f.path);
    for (const envelopeName of ["cj-api", "advertisers", "total-matched", "records-returned", "page-number"]) {
      assert.ok(
        !paths.some((p) => p === envelopeName || p.startsWith(`${envelopeName}.`) || p.startsWith(`${envelopeName}[`)),
        `${envelopeName} was certified as a row field`,
      );
    }
  });

  it("23 - it reuses production's extractor, which reads <advertiser> blocks", () => {
    assert.match(ADAPTER_SRC, /extractCjAdvertisers\(String\(response\?\.data \?\? ""\)\)/);
    assert.match(ADAPTER_SRC, /export function extractCjAdvertisers\(xml\) \{\s*return tagBlocks\(xml, "advertiser"\)/);
    // The same extractor production's fetchCampaigns passes to fetchPaged.
    assert.match(ADAPTER_SRC, /extractor: extractCjAdvertisers,/);
    assert.equal(extractCjAdvertisers(ADVERTISER_XML).length, 1);
    assert.equal(extractCjAdvertisers(EMPTY_XML).length, 0);
  });

  it("24 - a raw XML string never reaches the result", async () => {
    const { result } = await certify();
    const serialised = JSON.stringify(result);
    for (const marker of ["<advertiser", "cj-api", "<?xml", "</", "total-matched"]) {
      assert.ok(!serialised.includes(marker), `${marker} leaked`);
    }
  });
});

/* ------------------------------------------------------- account state */

describe("zero joined advertisers is an ACCOUNT STATE, not an unsupported object", () => {
  it("25 - an empty collection reports UNKNOWN_NEEDS_JOINED_CAMPAIGN", async () => {
    const { entry, spy } = await certify(EMPTY_XML);
    assert.equal(entry.statusCategory, "UNKNOWN_NEEDS_JOINED_CAMPAIGN");
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(entry.accountStateBlocker, "NO_JOINED_CAMPAIGNS");
    assert.equal(entry.sampleCount, 0);
    assert.equal(entry.fieldCount, 0);
    assert.deepEqual(entry.fieldPaths, []);
    assert.equal(spy.calls.length, 1, "the endpoint was still asked");
  });

  it("26 - it is NOT reported as OK_NO_ROWS, because the query itself is scoped to joined", async () => {
    const { entry } = await certify(EMPTY_XML);
    assert.notEqual(entry.statusCategory, "OK_NO_ROWS");
    assert.notEqual(entry.statusCategory, "OK");
    assert.match(entry.note, /advertiser-ids=joined/);
    assert.match(entry.note, /Not a supplier or integration failure/);
  });

  it("27 - it is not a supplier failure either: no status code, no message", async () => {
    const { entry } = await certify(EMPTY_XML);
    assert.ok(!("supplierStatusCode" in entry));
    assert.ok(!("supplierMessage" in entry));
    for (const failureCategory of ["NOT_FOUND", "UNAVAILABLE", "REQUEST_REJECTED", "NETWORK_ERROR"]) {
      assert.notEqual(entry.statusCategory, failureCategory);
    }
  });

  it("28 - a row present means no account-state blocker is reported", async () => {
    const { entry } = await certify();
    assert.equal(entry.statusCategory, "OK");
    assert.equal(entry.accountStateBlocker, undefined);
    assert.equal(entry.schema, undefined);
  });
});

/* ------------------------------------------------------- leakage */

describe("nothing but structure leaves", () => {
  const BANNED = [
    "zzadvidzz",
    "zzadvnamezz",
    "zzmerchantzz",
    "zzparentcatzz",
    "zzchildcatzz",
    "12.34",
    "56.78",
    "https://",
    TOKEN,
    CID,
    WEBSITE_ID,
  ];

  it("29 - no advertiser id, name, URL, category or EPC appears", async () => {
    const { result } = await certify();
    const serialised = JSON.stringify(result);
    for (const banned of BANNED) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
  });

  it("30 - every reported field is structure only", async () => {
    const { entry } = await certify();
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
    assert.equal(entry.rows, undefined);
    assert.equal(entry.rawPayload, undefined);
    assert.equal(entry.xml, undefined);
  });

  it("31 - a supplier error quoting the token and the CID is scrubbed", async () => {
    const leaky = Object.assign(new Error("401"), {
      response: { status: 401, data: { message: `cid ${CID} rejected token ${TOKEN}` } },
    });
    const { result } = await certify(leaky);
    const serialised = JSON.stringify(result);
    for (const banned of [TOKEN, CID, WEBSITE_ID]) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
    // "token <value>" is consumed WHOLE by the credential rule — the trigger word goes with the
    // secret, which is the safer behaviour and why "rejected token" does not survive.
    assert.match(result.results[0].supplierMessage, /^cid \[REDACTED\] rejected/);
    assert.match(result.results[0].supplierMessage, /REDACTED_CREDENTIAL/);
  });

  it("31b - an explanation carrying no secret survives intact and is still useful", async () => {
    const plain = Object.assign(new Error("401"), {
      response: { status: 401, data: { message: "publisher is not authorised for advertiser lookup" } },
    });
    const { result } = await certify(plain);
    assert.equal(
      result.results[0].supplierMessage,
      "publisher is not authorised for advertiser lookup",
    );
    assert.equal(result.results[0].supplierStatusCode, 401);
  });
});

/* ------------------------------------------------------- unchanged */

describe("the other networks are unchanged", () => {
  it("32 - optimise, partnerize and awin registries are untouched", () => {
    assert.equal(listProbeSourceObjects("optimise").length, 11);
    assert.equal(listProbeSourceObjects("partnerize").length, 8);
    assert.deepEqual([...listProbeSourceObjects("awin")].sort(), [
      "campaigns",
      "commission_groups",
      "conversions",
      "coupons",
    ]);
  });

  it("33 - production CJ fetchers and the sync job are unchanged", () => {
    assert.match(ADAPTER_SRC, /async fetchCampaigns\(params = \{\}, stats = null\) \{/);
    assert.match(ADAPTER_SRC, /async fetchLinks\(params = \{\}, stats = null\) \{/);
    assert.match(ADAPTER_SRC, /async fetchCoupons\(params = \{\}, stats = null\) \{/);
    assert.match(SYNC_SRC, /sourceObject: "advertisers",/);
    const start = ADAPTER_SRC.indexOf("async fetchCertificationAdvertiserSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.ok(!body.includes("fetchCampaigns"), "certification reuses the sync fetcher");
  });

  it("34 - no CJ mapping directory or new endpoint was invented", async () => {
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync("src/network-mappings/cj"));
    const code = ADAPTER_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const paths = [...code.matchAll(/["'](\/v\d[A-Za-z0-9_/-]*)["']/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(paths)].sort(), ["/v2/advertiser-lookup", "/v2/link-search"]);
  });
});
