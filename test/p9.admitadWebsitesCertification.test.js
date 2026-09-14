import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const {
  createAdmitadAdapter,
  extractAdmitadCollection,
  ADMITAD_CERTIFICATION_MAX_ROWS,
  ADMITAD_CERTIFICATION_WEBSITE_PARAMS,
} = await import("../src/adapters/admitad.adapter.js");
const { NetworkCertificationService, listProbeNetworks, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/admitad.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const CREDENTIALS_SRC = readFileSync("src/modules/integrations/admitadCredentials.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/admitadSupplierSync.js", "utf8");
const PROVIDER_SRC = readFileSync(
  "src/modules/integrations/admitadTokenProvider.js",
  "utf8",
);

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const TOKEN = "zzadmitadtokenzz";

/** One websites row inside the real envelope shape: every value distinctive. */
const WEBSITE_PAYLOAD = {
  results: [
    {
      id: 991122,
      name: "zzsitenamezz",
      site_url: "https://zzsitezz.example",
      status: "active",
      kind: "website",
      creation_date: "2023-04-05T06:07:08",
      verification_code: "zzverifyzz",
      is_old: false,
      atnd_visits: 1234,
      categories: [{ id: 7, name: "zzcategoryzz" }],
      regions: ["AE"],
    },
  ],
  _meta: { count: 1, limit: 1, offset: 0 },
};

/** The same envelope with no rows: a publisher that has registered no websites. */
const EMPTY_PAYLOAD = { results: [], _meta: { count: 0, limit: 1, offset: 0 } };

function spyHttp(dataOrError = WEBSITE_PAYLOAD) {
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
  return createAdmitadAdapter({ accessToken: TOKEN, httpClient: spy.client });
}

function serviceWith(adapter, credentials = { accessToken: TOKEN }) {
  return new NetworkCertificationService({
    prisma: {
      rawPayload: {
        findMany: async () => {
          throw new Error("certification must not read RawPayload unless compareRaw is requested");
        },
      },
    },
    adapterFactory: () => adapter,
    admitadCredentialResolver: async () => credentials,
  });
}

async function certifyWebsites(adapter, options = {}) {
  const service = serviceWith(adapter, options.credentials ?? { accessToken: TOKEN });
  return service.certify("admitad", { sourceObjects: ["websites"], ...options.certify });
}

describe("Admitad is registered in the certification framework", () => {
  it("appears as a probe network", () => {
    assert.ok(listProbeNetworks().includes("admitad"));
  });

  it("exposes websites and nothing else yet", () => {
    assert.deepEqual(listProbeSourceObjects("admitad"), ["websites"]);
  });

  it("does not add campaign, coupon or action probes", () => {
    for (const notYet of ["programs", "coupons", "actions", "campaigns", "product_feeds"]) {
      assert.ok(!listProbeSourceObjects("admitad").includes(notYet), notYet);
    }
  });

  it("keeps every previously registered network intact", () => {
    for (const network of ["optimise", "partnerize", "awin", "cj"]) {
      assert.ok(listProbeNetworks().includes(network), network);
      assert.ok(listProbeSourceObjects(network).length > 0, network);
    }
  });

  it("declares the probe read-only with a GET method", () => {
    assert.match(codeOf(SERVICE_SRC), /const ADMITAD_PROBES = Object\.freeze\(\{[\s\S]*?method: "GET"/);
  });

  it("names the exact endpoint and its bounds in the endpointKey", () => {
    assert.match(
      codeOf(SERVICE_SRC),
      /endpointKey: "GET \/websites\/v2\/ \(limit=1, offset=0\)"/,
    );
  });

  it("has an adapter builder registered under its own name", () => {
    assert.match(codeOf(SERVICE_SRC), /admitad: "buildAdmitadAdapter"/);
  });

  it("leaves programs, coupons and actions catalogued live and untouched", () => {
    for (const sourceObject of ["programs", "coupons", "actions"]) {
      assert.equal(getSourceObject("admitad", sourceObject)?.live, true, sourceObject);
    }
  });
});

describe("the Admitad websites request is exactly one bounded GET", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationWebsiteSample({ timeoutMs: 5000 });
    assert.equal(spy.calls.length, 1);
  });

  it("uses the production path verbatim", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationWebsiteSample({});
    assert.equal(spy.calls[0].path, "/websites/v2/");
  });

  it("sends limit=1 and offset=0", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationWebsiteSample({});
    assert.deepEqual(spy.calls[0].config.params, { limit: 1, offset: 0 });
  });

  it("pins the bounds as a frozen constant the caller cannot mutate", () => {
    assert.deepEqual({ ...ADMITAD_CERTIFICATION_WEBSITE_PARAMS }, { limit: 1, offset: 0 });
    assert.ok(Object.isFrozen(ADMITAD_CERTIFICATION_WEBSITE_PARAMS));
  });

  it("copies the frozen bounds rather than handing them to axios by reference", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationWebsiteSample({});
    assert.notEqual(spy.calls[0].config.params, ADMITAD_CERTIFICATION_WEBSITE_PARAMS);
  });

  it("sends no other request parameter at all", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationWebsiteSample({});
    assert.deepEqual(Object.keys(spy.calls[0].config.params).sort(), ["limit", "offset"]);
  });

  it("applies the certification timeout to the request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationWebsiteSample({ timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("falls back to its own timeout ceiling when none is supplied", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationWebsiteSample({});
    assert.ok(Number.isFinite(spy.calls[0].config.timeout));
    assert.ok(spy.calls[0].config.timeout > 0);
  });

  it("does not paginate even when the envelope reports more rows than it returned", async () => {
    const spy = spyHttp({
      results: WEBSITE_PAYLOAD.results,
      _meta: { count: 5000, limit: 1, offset: 0 },
    });
    await adapterWith(spy).fetchCertificationWebsiteSample({});
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() => adapterWith(spy).fetchCertificationWebsiteSample({}));
    assert.equal(spy.calls.length, 1);
  });

  it("does not route through the paginating or retrying helpers", () => {
    const sampler = codeOf(ADAPTER_SRC)
      .split("async fetchCertificationWebsiteSample")[1]
      .split("async fetchCampaigns")[0];
    assert.ok(!sampler.includes("fetchOffsetPaginated"));
    assert.ok(!sampler.includes("requestWithRetry"));
    assert.ok(!/\bawait get\(/.test(sampler));
    assert.ok(!/for\s*\(|while\s*\(/.test(sampler));
  });
});

describe("the sample is bounded to one row, twice and independently", () => {
  it("pins the adapter's row ceiling at one", () => {
    assert.equal(ADMITAD_CERTIFICATION_MAX_ROWS, 1);
  });

  it("slices in the adapter even when the supplier ignores limit=1", async () => {
    const many = { results: [...Array(25)].map((_, i) => ({ id: i, name: `zz${i}zz` })) };
    const spy = spyHttp(many);
    const rows = await adapterWith(spy).fetchCertificationWebsiteSample({});
    assert.equal(rows.length, 1);
  });

  it("slices again in the service when an adapter hands back more than one row", async () => {
    const result = await certifyWebsites({
      fetchCertificationWebsiteSample: async () => [
        { id: 1, name: "zzonezz" },
        { id: 2, name: "zztwozz" },
      ],
    });
    assert.equal(result.results[0].sampleCount, 1);
  });

  it("parses rows with production's own collection extractor", async () => {
    const spy = spyHttp();
    const rows = await adapterWith(spy).fetchCertificationWebsiteSample({});
    assert.deepEqual(rows, extractAdmitadCollection(WEBSITE_PAYLOAD).slice(0, 1));
  });

  it("certifies a row and never the {results, _meta} envelope", async () => {
    const spy = spyHttp();
    const result = await certifyWebsites(adapterWith(spy));
    const paths = result.results[0].fieldPaths.map((f) => f.path ?? f);
    assert.ok(!paths.some((p) => String(p).startsWith("results")));
    assert.ok(!paths.some((p) => String(p).startsWith("_meta")));
    assert.ok(paths.some((p) => String(p) === "id"));
  });
});

describe("the websites outcome vocabulary", () => {
  it("reports OK with a field dictionary when one row comes back", async () => {
    const result = await certifyWebsites(adapterWith(spyHttp()));
    const row = result.results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
  });

  it("reports OK_NO_ROWS with an unknown schema when the collection is empty", async () => {
    const result = await certifyWebsites(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    const row = result.results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("names no account-state blocker on an empty result", async () => {
    const result = await certifyWebsites(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    const row = result.results[0];
    assert.equal(row.accountStateBlocker, undefined);
    assert.notEqual(row.statusCategory, "UNKNOWN_NEEDS_JOINED_CAMPAIGN");
  });

  it("does not carry a supplier status code on a successful empty result", async () => {
    const result = await certifyWebsites(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    assert.equal(result.results[0].supplierStatusCode, undefined);
  });

  it("omits schema once a row has actually been sampled", async () => {
    const result = await certifyWebsites(adapterWith(spyHttp()));
    assert.equal(result.results[0].schema, undefined);
  });

  it("reports a supplier failure as a failure, not as an empty sample", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 401 } });
    const result = await certifyWebsites(adapterWith(spyHttp(boom)));
    const row = result.results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.notEqual(row.statusCategory, "OK_NO_ROWS");
  });

  it("carries the endpoint and method through on every outcome", async () => {
    for (const payload of [WEBSITE_PAYLOAD, EMPTY_PAYLOAD]) {
      const result = await certifyWebsites(adapterWith(spyHttp(payload)));
      assert.equal(result.results[0].sourceObject, "websites");
      assert.equal(result.results[0].httpMethod, "GET");
      assert.match(result.results[0].endpointKey, /^GET \/websites\/v2\//);
    }
  });
});

describe("no value from the supplier reaches the result", () => {
  it("returns structural paths only — no ids, names or URLs", async () => {
    const result = await certifyWebsites(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const secret of [
      "zzsitenamezz",
      "zzsitezz",
      "zzverifyzz",
      "zzcategoryzz",
      "991122",
      "1234",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the raw payload", async () => {
    const result = await certifyWebsites(adapterWith(spyHttp()));
    const row = result.results[0];
    assert.equal(row.raw, undefined);
    assert.equal(row.payload, undefined);
    assert.equal(row.rows, undefined);
    assert.equal(row.sample, undefined);
  });

  it("never returns the access token", async () => {
    const boom = Object.assign(new Error(`rejected ${TOKEN}`), {
      response: { status: 403, data: { error: `bad token ${TOKEN}` } },
    });
    const result = await certifyWebsites(adapterWith(spyHttp(boom)));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  it("reports every field path the row actually has", async () => {
    const result = await certifyWebsites(adapterWith(spyHttp()));
    const paths = result.results[0].fieldPaths.map((f) => f.path ?? f);
    for (const expected of ["id", "name", "site_url", "status"]) {
      assert.ok(paths.includes(expected), expected);
    }
  });
});

describe("credentials come from configuration and never from a caller", () => {
  it("refuses to build an adapter when no token is configured", async () => {
    const service = serviceWith({}, null);
    await assert.rejects(
      () => service.certify("admitad", { sourceObjects: ["websites"] }),
      (error) => Number(error?.statusCode ?? error?.status) === 424,
    );
  });

  it("names no credential detail in the refusal", async () => {
    const service = serviceWith({}, null);
    const error = await service
      .certify("admitad", { sourceObjects: ["websites"] })
      .then(() => null, (e) => e);
    assert.ok(error);
    assert.ok(!String(error.message).includes(TOKEN));
    assert.match(String(error.message), /not configured/i);
  });

  it("resolves the token through the one resolver the production sync job also uses", () => {
    // The resolution chain lives in admitadTokenProvider.js and both callers delegate to it, so
    // certification and sync cannot authenticate differently.
    assert.match(codeOf(CREDENTIALS_SRC), /resolveAdmitadAccessToken\(accountLabel\)/);
    assert.match(codeOf(SYNC_SRC), /resolveAdmitadAccessToken\(accountLabel\)/);
    const provider = codeOf(PROVIDER_SRC);
    assert.match(provider, /env\.ADMITAD_ACCESS_TOKEN/);
    assert.match(provider, /getOAuthAccessToken\("admitad"/);
    assert.match(provider, /getMarketplaceApiKey\("admitad"/);
  });

  it("keeps no second credential chain of its own", () => {
    const code = codeOf(CREDENTIALS_SRC);
    for (const duplicated of [
      "process.env.ADMITAD_ACCESS_TOKEN",
      'getOAuthAccessToken("admitad"',
      "grant_type",
      "client_secret",
      "Basic ",
    ]) {
      assert.ok(!code.includes(duplicated), duplicated);
    }
  });

  it("accepts no token, path or account identifier from a caller", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyAdmitadWebsites")[1]
      .split("async certifyAwinCommissionGroups")[0];
    for (const leak of ["req.body", "req.query", "ctx.accessToken", "options.path", "params.path"]) {
      assert.ok(!chain.includes(leak), leak);
    }
    assert.ok(!chain.includes("baseURL"));
  });

  it("builds the adapter with the resolved token and nothing else", () => {
    const builder = codeOf(SERVICE_SRC)
      .split("async buildAdmitadAdapter")[1]
      .split("async certifyAdmitadWebsites")[0];
    assert.match(builder, /factory\(\{ accessToken: credentials\.accessToken \}\)/);
    assert.ok(!builder.includes("baseURL"));
  });

  it("registers the token for redaction", () => {
    const builder = codeOf(SERVICE_SRC)
      .split("async buildAdmitadAdapter")[1]
      .split("async certifyAdmitadWebsites")[0];
    assert.match(builder, /recordRedactionValues\(/);
    assert.match(builder, /\[credentials\.accessToken\]/);
  });

  it("returns the configured token when one is set", async () => {
    const previous = process.env.ADMITAD_ACCESS_TOKEN;
    process.env.ADMITAD_ACCESS_TOKEN = TOKEN;
    try {
      const { resolveAdmitadCertificationCredentials } = await import(
        "../src/modules/integrations/admitadCredentials.js"
      );
      assert.deepEqual(await resolveAdmitadCertificationCredentials("default"), {
        accessToken: TOKEN,
      });
    } finally {
      if (previous === undefined) delete process.env.ADMITAD_ACCESS_TOKEN;
      else process.env.ADMITAD_ACCESS_TOKEN = previous;
    }
  });

  it("returns null rather than an empty credential when nothing is configured", async () => {
    const previous = process.env.ADMITAD_ACCESS_TOKEN;
    delete process.env.ADMITAD_ACCESS_TOKEN;
    try {
      const { resolveAdmitadCertificationCredentials } = await import(
        "../src/modules/integrations/admitadCredentials.js"
      );
      // The DB-backed lookups cannot resolve in this environment; the resolver must not turn that
      // into a credential-shaped object the builder would then accept.
      assert.equal(await resolveAdmitadCertificationCredentials("default"), null);
    } finally {
      if (previous !== undefined) process.env.ADMITAD_ACCESS_TOKEN = previous;
    }
  });

  it("rejects a source object that has no probe", async () => {
    const service = serviceWith(adapterWith(spyHttp()));
    await assert.rejects(
      () => service.certify("admitad", { sourceObjects: ["actions"] }),
      (error) => Number(error?.statusCode ?? error?.status) === 400,
    );
  });
});

describe("certification stays read-only", () => {
  it("performs no database read or write for a websites run", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    const result = await certifyWebsites(adapterWith(spyHttp()));
    assert.equal(result.results[0].statusCategory, "OK");
  });

  it("makes no supplier call beyond the single sample", async () => {
    const spy = spyHttp();
    await certifyWebsites(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("triggers no sync and writes no raw entity", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyAdmitadWebsites")[1]
      .split("async certifyAwinCommissionGroups")[0];
    for (const write of ["upsert", "create", "update", "delete", "upsertManyRawEntities"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("leaves the production websites fetcher paginating as before", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchWebsites")[1]
      .split("async fetchCertificationWebsiteSample")[0];
    assert.ok(production.includes("fetchOffsetPaginated"));
  });

  it("leaves the production conversions and campaign fetchers untouched", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /async fetchConversions[\s\S]*?buildAdmitadActionParams/);
    assert.match(code, /fetchOffsetPaginated\("\/statistics\/actions\/"/);
    assert.match(code, /fetchOffsetPaginated\(path, requestParams, stats\)/);
  });

  it("does not touch the declared DEEP_LINK capability", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /SUPPLIER_CAPABILITIES\.DEEP_LINK/);
    assert.ok(!code.includes("fetchDeepLink"));
    assert.ok(!code.includes("buildDeepLink"));
  });
});
