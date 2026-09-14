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
  createRakutenAdapter,
  extractRakutenCollection,
  RAKUTEN_CERTIFICATION_MAX_ROWS,
  RAKUTEN_CERTIFICATION_PAGE_PARAMS,
  RAKUTEN_CERTIFICATION_SPECS,
} = await import("../src/adapters/rakuten.adapter.js");
const { NetworkCertificationService, listProbeNetworks, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/rakuten.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/rakutenSupplierSync.js", "utf8");
const CREDENTIALS_SRC = readFileSync("src/modules/integrations/rakutenCredentials.js", "utf8");

/**
 * Comments are prose; an assertion that matches one proves nothing about behaviour.
 *
 * A single pass tracking BOTH comment state and string state, because the naive regex version gets
 * this source wrong twice over:
 *
 *  - getCsv sends `Accept: "text/csv,text/plain,*\/*"`. That `/*` opens a comment span in a plain
 *    stripper and silently swallows everything to the next `*\/`, authenticate() included.
 *  - Masking strings first is no better: prose comments are full of apostrophes ("publisher's"),
 *    and a quote character inside a comment is not a string delimiter.
 *
 * Only one pass, in the order a parser would, gets both right. A test reading a mangled source
 * proves nothing at all, which is worse than having no test.
 */
function codeOf(source) {
  let out = "";
  let i = 0;
  let quote = null;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }

    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") quote = char;
    out += char;
    i += 1;
  }

  return out;
}

const TOKEN = "zzrakutentokenzz";
const SECURITY_TOKEN = "zzsecuritytokenzz";

/** One advertiser row in the real envelope shape: every value distinctive. */
const ADVERTISER_PAYLOAD = {
  advertisers: [
    {
      id: 665544,
      name: "zzadvnamezz",
      url: "https://zzadvmerchantzz.example",
      categories: [{ id: 3, name: "zzcategoryzz" }],
      network: 1,
      status: "active",
      contact: { email: "zzcontactzz@example.test", phone: "zzphonezz" },
      currency: "AED",
      features: { deep_linking: true },
      offer: { name: "zzoffernamezz", commission_terms: "12% of sale" },
    },
  ],
  _metadata: { page: 1, limit: 1, total: 1 },
};

/** The same envelope with no rows. */
const EMPTY_PAYLOAD = { advertisers: [], _metadata: { page: 1, limit: 1, total: 0 } };

function spyHttp(dataOrError = ADVERTISER_PAYLOAD) {
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
  return createRakutenAdapter({
    accessToken: TOKEN,
    securityToken: SECURITY_TOKEN,
    httpClient: spy.client,
  });
}

function serviceWith(adapter, credentials = { accessToken: TOKEN, securityToken: SECURITY_TOKEN }) {
  return new NetworkCertificationService({
    prisma: {
      rawPayload: {
        findMany: async () => {
          throw new Error("certification must not read RawPayload unless compareRaw is requested");
        },
      },
    },
    adapterFactory: () => adapter,
    rakutenCredentialResolver: async () => credentials,
  });
}

async function certifyAdvertisers(adapter, credentials) {
  return serviceWith(adapter, credentials).certify("rakuten", {
    sourceObjects: ["advertisers"],
  });
}

describe("Rakuten is registered in the certification framework", () => {
  it("appears as a probe network for the first time", () => {
    assert.ok(listProbeNetworks().includes("rakuten"));
  });

  it("exposes advertisers alongside the objects certified after it", () => {
    // This file remains the advertisers probe's own tests; the siblings joined the registry later.
    assert.deepEqual(listProbeSourceObjects("rakuten").sort(), [
      "advertisers",
      "commissioning_lists",
      "offers",
      "partnerships",
    ]);
  });

  it("adds no probe for the objects this phase defers", () => {
    for (const notYet of [
      "events",
      "advanced_reports",
      "payments",
      "coupons",
      "links",
      "products",
    ]) {
      assert.ok(!listProbeSourceObjects("rakuten").includes(notYet), notYet);
      assert.ok(!Object.hasOwn(RAKUTEN_CERTIFICATION_SPECS, notYet), notYet);
    }
  });

  it("declares a read-only GET with the bounds in its endpointKey", () => {
    assert.match(
      codeOf(SERVICE_SRC),
      /advertisers: \{\s*method: "GET",\s*endpointKey: "GET \/v2\/advertisers \(limit=1, page=1\)"/,
    );
  });

  it("has an adapter builder registered under its own name", () => {
    assert.match(codeOf(SERVICE_SRC), /rakuten: "buildRakutenAdapter"/);
  });

  it("keeps every previously registered network intact", () => {
    for (const network of ["optimise", "partnerize", "awin", "cj", "admitad"]) {
      assert.ok(listProbeNetworks().includes(network), network);
      assert.ok(listProbeSourceObjects(network).length > 0, network);
    }
  });

  it("leaves the Rakuten catalog exactly as it was", () => {
    assert.equal(getSourceObject("rakuten", "advertisers")?.live, true);
    assert.equal(getSourceObject("rakuten", "advertisers")?.endpoint, "GET /v2/advertisers");
    for (const untouched of ["partnerships", "offers", "commissioning_lists", "events"]) {
      assert.equal(getSourceObject("rakuten", untouched)?.live, true, untouched);
    }
    for (const gated of ["coupons", "products", "links"]) {
      assert.equal(getSourceObject("rakuten", gated)?.live, false, gated);
    }
  });
});

describe("the request is production's own bounded advertiser call", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("advertisers", { timeoutMs: 5000 });
    assert.equal(spy.calls.length, 1);
  });

  it("uses the production path", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("advertisers", {});
    assert.equal(spy.calls[0].path, "/v2/advertisers");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.advertisers.path, "/v2/advertisers");
  });

  it("sends limit=1 and page=1 and nothing else", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("advertisers", {});
    assert.deepEqual(spy.calls[0].config.params, { limit: 1, page: 1 });
    assert.deepEqual(Object.keys(spy.calls[0].config.params).sort(), ["limit", "page"]);
  });

  it("matches the request authenticate() already makes in production", () => {
    // The bounded form IS the evidenced form: nothing smaller or different is invented.
    const production = codeOf(ADAPTER_SRC)
      .split("async authenticate")[1]
      .split("async fetchCertificationSample")[0];
    assert.match(production, /"\/v2\/advertisers", \{ limit: 1, page: 1 \}/);
  });

  it("pins the bounds as a frozen constant the caller cannot mutate", () => {
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_PAGE_PARAMS }, { limit: 1, page: 1 });
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_PAGE_PARAMS));
  });

  it("copies the frozen bounds rather than handing them over by reference", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("advertisers", {});
    assert.notEqual(spy.calls[0].config.params, RAKUTEN_CERTIFICATION_PAGE_PARAMS);
  });

  it("applies the certification timeout", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("advertisers", { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("falls back to its own timeout ceiling when none is supplied", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("advertisers", {});
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
  });

  it("does not paginate even when the envelope reports far more rows", async () => {
    const spy = spyHttp({
      advertisers: ADVERTISER_PAYLOAD.advertisers,
      _metadata: { page: 1, limit: 1, total: 9999 },
    });
    await adapterWith(spy).fetchCertificationSample("advertisers", {});
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() => adapterWith(spy).fetchCertificationSample("advertisers", {}));
    assert.equal(spy.calls.length, 1);
  });

  it("does not route through the paginating or retrying helpers", () => {
    const code = codeOf(ADAPTER_SRC);
    const start = code.indexOf("async fetchCertificationSample(");
    const body = code.slice(start, code.indexOf("async fetchAdvertisers", start));
    assert.ok(!body.includes("fetchPagedJson"));
    assert.ok(!body.includes("requestWithRetry"));
    assert.ok(!body.includes("getCsv"));
    assert.ok(!/\bawait getJson\(/.test(body));
    assert.equal((body.match(/httpClient\.get\(/g) ?? []).length, 1);
    const afterRequest = body.slice(body.indexOf("httpClient.get("));
    assert.ok(!/for\s*\(|while\s*\(/.test(afterRequest));
  });

  it("makes exactly one request for a full certification run", async () => {
    const spy = spyHttp();
    await certifyAdvertisers(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("touches no Advanced Reports path and needs no security token", async () => {
    const spy = spyHttp();
    const bearerOnly = createRakutenAdapter({ accessToken: TOKEN, httpClient: spy.client });
    const rows = await bearerOnly.fetchCertificationSample("advertisers", {});
    assert.equal(rows.length, 1);
    assert.equal(spy.calls.length, 1);
    const serialised = JSON.stringify(spy.calls[0]);
    assert.ok(!serialised.includes("advancedreports"));
    assert.ok(!serialised.includes("token"));
  });
});

describe("the request table is the only thing that chooses a path", () => {
  it("refuses a source object it does not name, saying so", async () => {
    const spy = spyHttp();
    await assert.rejects(
      () => adapterWith(spy).fetchCertificationSample("events", {}),
      (error) => /No Rakuten certification sample is defined for "events"/.test(error.message),
    );
    assert.equal(spy.calls.length, 0);
  });

  it("cannot be steered down the prototype chain", async () => {
    const spy = spyHttp();
    for (const inherited of ["constructor", "__proto__", "toString", "valueOf"]) {
      await assert.rejects(
        () => adapterWith(spy).fetchCertificationSample(inherited, {}),
        (error) => /No Rakuten certification sample is defined/.test(error.message),
        inherited,
      );
    }
    assert.equal(spy.calls.length, 0);
  });

  it("accepts no path, page or token from a caller", () => {
    const code = codeOf(ADAPTER_SRC);
    const start = code.indexOf("async fetchCertificationSample(");
    const body = code.slice(start, code.indexOf("async fetchAdvertisers", start));
    for (const leak of ["params.path", "ctx.path", "options.path", "accessToken", "securityToken"]) {
      assert.ok(!body.includes(leak), leak);
    }
    assert.match(body, /httpClient\.get\(spec\.path,/);
  });

  it("keeps the spec table and every entry frozen", () => {
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_SPECS));
    for (const spec of Object.values(RAKUTEN_CERTIFICATION_SPECS)) {
      assert.ok(Object.isFrozen(spec));
      assert.equal(spec.method, "GET");
    }
  });

  it("names a probe for every declared spec", () => {
    for (const sourceObject of Object.keys(RAKUTEN_CERTIFICATION_SPECS)) {
      assert.ok(listProbeSourceObjects("rakuten").includes(sourceObject), sourceObject);
    }
  });
});

describe("the sample is bounded to one row, twice and independently", () => {
  it("pins the adapter's row ceiling at one", () => {
    assert.equal(RAKUTEN_CERTIFICATION_MAX_ROWS, 1);
  });

  it("slices in the adapter even when the supplier ignores limit=1", async () => {
    const many = { advertisers: [...Array(40)].map((_, i) => ({ id: i, name: `zz${i}zz` })) };
    const spy = spyHttp(many);
    assert.equal((await adapterWith(spy).fetchCertificationSample("advertisers", {})).length, 1);
  });

  it("slices again in the service when an adapter hands back more than one row", async () => {
    const result = await certifyAdvertisers({
      fetchCertificationSample: async () => [{ id: 1 }, { id: 2 }],
    });
    assert.equal(result.results[0].sampleCount, 1);
  });

  it("uses production's own collection extractor and container keys", async () => {
    const spy = spyHttp();
    const rows = await adapterWith(spy).fetchCertificationSample("advertisers", {});
    assert.deepEqual(rows, extractRakutenCollection(ADVERTISER_PAYLOAD, ["advertisers", "advertiser"]).slice(0, 1));
    assert.deepEqual([...RAKUTEN_CERTIFICATION_SPECS.advertisers.collectionKeys], [
      "advertisers",
      "advertiser",
    ]);
    assert.match(codeOf(ADAPTER_SRC), /fetchPagedJson\("\/v2\/advertisers", params, \["advertisers", "advertiser"\]/);
  });

  it("certifies a row and never the envelope", async () => {
    const paths = (await certifyAdvertisers(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(!paths.some((p) => String(p).startsWith("advertisers")));
    assert.ok(!paths.some((p) => String(p).startsWith("_metadata")));
    assert.ok(paths.includes("id"));
  });
});

describe("the advertisers outcome vocabulary", () => {
  it("reports OK with a field dictionary when one row comes back", async () => {
    const row = (await certifyAdvertisers(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.equal(row.schema, undefined);
  });

  it("reports OK_NO_ROWS with an unknown schema when the collection is empty", async () => {
    const row = (await certifyAdvertisers(adapterWith(spyHttp(EMPTY_PAYLOAD)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("does NOT claim no joined campaigns on an empty result", async () => {
    // The sync job calls /v2/advertisers completely unscoped and nothing in this repo proves
    // whether it is catalogue-wide or relationship-scoped. Claiming an approval state would
    // assert a scope the integration has never established.
    const result = await certifyAdvertisers(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    const row = result.results[0];
    assert.equal(row.accountStateBlocker, undefined);
    assert.notEqual(row.statusCategory, "UNKNOWN_NEEDS_JOINED_CAMPAIGN");
    assert.ok(!JSON.stringify(result).includes("NO_JOINED_CAMPAIGNS"));
    assert.ok(!JSON.stringify(result).includes("NOT_SUPPORTED"));
  });

  it("reports the endpoint, method and object on every outcome", async () => {
    for (const payload of [ADVERTISER_PAYLOAD, EMPTY_PAYLOAD]) {
      const row = (await certifyAdvertisers(adapterWith(spyHttp(payload)))).results[0];
      assert.equal(row.endpointKey, "GET /v2/advertisers (limit=1, page=1)");
      assert.equal(row.httpMethod, "GET");
      assert.equal(row.sourceObject, "advertisers");
    }
  });

  it("preserves a safe supplier status on an auth failure", async () => {
    const boom = Object.assign(new Error("unauthorized"), { response: { status: 401 } });
    const row = (await certifyAdvertisers(adapterWith(spyHttp(boom)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.equal(row.supplierStatusCode, 401);
    assert.notEqual(row.statusCategory, "OK_NO_ROWS");
  });

  it("distinguishes a rejected request from an auth failure", async () => {
    const rejected = Object.assign(new Error("bad request"), { response: { status: 400 } });
    const row = (await certifyAdvertisers(adapterWith(spyHttp(rejected)))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
  });

  it("carries no supplier status code on a successful empty result", async () => {
    const result = await certifyAdvertisers(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    assert.equal(result.results[0].supplierStatusCode, undefined);
  });
});

describe("no advertiser value reaches the result", () => {
  it("returns no ids, names, URLs, contacts or commission terms", async () => {
    const result = await certifyAdvertisers(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const secret of [
      "zzadvnamezz",
      "zzadvmerchantzz",
      "zzcategoryzz",
      "zzcontactzz",
      "zzphonezz",
      "zzoffernamezz",
      "665544",
      "12% of sale",
      "AED",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("reports the commission-term field PATH without its value", async () => {
    const result = await certifyAdvertisers(adapterWith(spyHttp()));
    const paths = result.results[0].fieldPaths.map((f) => f.path);
    assert.ok(paths.includes("offer.commission_terms"));
    assert.ok(!JSON.stringify(result.results[0].fieldPaths).includes("12% of sale"));
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
    const allowed = new Set([
      "ARRAY",
      "BOOLEAN",
      "CURRENCY_CODE",
      "ID_LIKE",
      "ISO_DATE",
      "MIXED",
      "NULL",
      "NUMBER",
      "OBJECT",
      "REDACTED",
      "STRING",
      "URL",
    ]);
    const fields = (await certifyAdvertisers(adapterWith(spyHttp()))).results[0].fieldPaths;
    assert.ok(fields.length > 0);
    for (const field of fields) {
      assert.ok(allowed.has(field.observedType), JSON.stringify(field));
      assert.deepEqual(
        Object.keys(field).sort(),
        [
          "arrayObserved",
          "exampleCategory",
          "nullableObserved",
          "objectObserved",
          "observedType",
          "path",
          "presentCount",
          "sampleCount",
        ],
        JSON.stringify(field),
      );
    }
  });

  it("never returns the raw payload", async () => {
    const row = (await certifyAdvertisers(adapterWith(spyHttp()))).results[0];
    for (const key of ["raw", "payload", "rows", "sample", "advertisers"]) {
      assert.equal(row[key], undefined, key);
    }
  });

  it("never returns either credential", async () => {
    const boom = Object.assign(new Error(`rejected ${TOKEN}`), {
      response: { status: 403, data: { error: `bad token ${TOKEN} ${SECURITY_TOKEN}` } },
    });
    const result = await certifyAdvertisers(adapterWith(spyHttp(boom)));
    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes(TOKEN));
    assert.ok(!serialised.includes(SECURITY_TOKEN));
  });
});

describe("credentials match production semantics", () => {
  it("resolves the Bearer from the same sources and order the sync job uses", () => {
    const code = codeOf(CREDENTIALS_SRC);
    const syncCode = codeOf(SYNC_SRC);
    for (const source of [
      "process.env.RAKUTEN_ACCESS_TOKEN",
      'getOAuthAccessToken("rakuten"',
      'getMarketplaceApiKey("rakuten"',
    ]) {
      assert.ok(code.includes(source), `certification: ${source}`);
      assert.ok(syncCode.includes(source), `sync: ${source}`);
    }
  });

  it("resolves the web security token from the same sources too", () => {
    const code = codeOf(CREDENTIALS_SRC);
    const syncCode = codeOf(SYNC_SRC);
    for (const source of [
      "process.env.RAKUTEN_WEB_SECURITY_TOKEN",
      'getMarketplaceRefreshToken("rakuten"',
    ]) {
      assert.ok(code.includes(source), `certification: ${source}`);
      assert.ok(syncCode.includes(source), `sync: ${source}`);
    }
  });

  it("treats the Bearer as required and the security token as optional, exactly as production does", async () => {
    const { resolveRakutenCertificationCredentials } = await import(
      "../src/modules/integrations/rakutenCredentials.js"
    );
    const previousToken = process.env.RAKUTEN_ACCESS_TOKEN;
    const previousSecurity = process.env.RAKUTEN_WEB_SECURITY_TOKEN;
    try {
      process.env.RAKUTEN_ACCESS_TOKEN = TOKEN;
      delete process.env.RAKUTEN_WEB_SECURITY_TOKEN;
      assert.deepEqual(await resolveRakutenCertificationCredentials("default"), {
        accessToken: TOKEN,
        securityToken: null,
      });

      delete process.env.RAKUTEN_ACCESS_TOKEN;
      assert.equal(await resolveRakutenCertificationCredentials("default"), null);
    } finally {
      if (previousToken === undefined) delete process.env.RAKUTEN_ACCESS_TOKEN;
      else process.env.RAKUTEN_ACCESS_TOKEN = previousToken;
      if (previousSecurity === undefined) delete process.env.RAKUTEN_WEB_SECURITY_TOKEN;
      else process.env.RAKUTEN_WEB_SECURITY_TOKEN = previousSecurity;
    }
    assert.match(codeOf(SYNC_SRC), /return accessToken \? \{ accessToken, securityToken \} : null;/);
  });

  it("refuses to build an adapter when no Bearer is configured", async () => {
    const service = serviceWith({}, null);
    await assert.rejects(
      () => service.certify("rakuten", { sourceObjects: ["advertisers"] }),
      (error) => Number(error?.statusCode ?? error?.status) === 424,
    );
  });

  it("names no credential detail in the refusal", async () => {
    const service = serviceWith({}, null);
    const error = await service
      .certify("rakuten", { sourceObjects: ["advertisers"] })
      .then(() => null, (e) => e);
    assert.ok(error);
    assert.ok(!String(error.message).includes(TOKEN));
    assert.match(String(error.message), /not configured/i);
  });

  it("certifies with a null security token, since this probe never needs one", async () => {
    const row = (
      await certifyAdvertisers(adapterWith(spyHttp()), { accessToken: TOKEN, securityToken: null })
    ).results[0];
    assert.equal(row.statusCategory, "OK");
  });

  it("registers both credentials for redaction when both are present", () => {
    const builder = codeOf(SERVICE_SRC)
      .split("async buildRakutenAdapter")[1]
      .split("async certifyRakutenSample")[0];
    assert.match(builder, /recordRedactionValues\(/);
    assert.match(builder, /\[credentials\.accessToken, credentials\.securityToken\]\.filter\(Boolean\)/);
  });

  it("invents no new Rakuten auth model", () => {
    const code = codeOf(CREDENTIALS_SRC);
    for (const invented of ["grant_type", "client_secret", "oauth/token", "Basic "]) {
      assert.ok(!code.includes(invented), invented);
    }
  });

  it("rejects a source object that has no probe", async () => {
    const service = serviceWith(adapterWith(spyHttp()));
    await assert.rejects(
      () => service.certify("rakuten", { sourceObjects: ["events"] }),
      (error) => Number(error?.statusCode ?? error?.status) === 400,
    );
  });
});

describe("certification stays read-only and changes no sync behaviour", () => {
  it("performs no database read or write", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    const row = (await certifyAdvertisers(adapterWith(spyHttp()))).results[0];
    assert.equal(row.statusCategory, "OK");
  });

  it("writes nothing and triggers no sync", () => {
    const code = codeOf(SERVICE_SRC);
    const chain = code.slice(
      code.indexOf("async certifyRakutenSample("),
      code.indexOf("async certifyAwinCommissionGroups("),
    );
    for (const write of ["upsert", "create", "update", "delete", "upsertManyRawEntities"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("leaves the production advertiser fetcher paginating", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchAdvertisers")[1]
      .split("async fetchCampaigns")[0];
    assert.ok(production.includes("fetchPagedJson"));
  });

  it("leaves every production sync source object untouched", () => {
    const code = codeOf(SYNC_SRC);
    for (const sourceObject of [
      "advertisers",
      "partnerships",
      "offers",
      "commissioning_lists",
      "events",
      "advanced_reports",
    ]) {
      assert.ok(code.includes(`sourceObject: "${sourceObject}"`), sourceObject);
    }
    assert.match(code, /adapter\.fetchAdvertisers\(\{\}, stats\)/);
  });

  it("adds no coupon, deeplink or product path to the adapter", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const absent of ["fetchCoupons", "fetchProducts", "buildDeepLink", "fetchLinks"]) {
      assert.ok(!code.includes(absent), absent);
    }
  });

  it("changes no declared Rakuten capability", async () => {
    const { SUPPLIER_CAPABILITY_CATALOG } = await import("../src/adapters/registry.js");
    const declared = adapterWith(spyHttp()).getCapabilities().capabilities;
    assert.deepEqual([...declared].sort(), [
      "CAMPAIGNS",
      "CONVERSIONS",
      "ORDER_ITEMS",
      "PAYMENTS",
      "REPORTING",
      "TRACKING_SUBID",
    ]);
    assert.deepEqual([...SUPPLIER_CAPABILITY_CATALOG.RAKUTEN.capabilities].sort(), [...declared].sort());
  });
});
