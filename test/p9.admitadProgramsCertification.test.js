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
  ADMITAD_CERTIFICATION_PAGE_PARAMS,
  ADMITAD_CERTIFICATION_SPECS,
} = await import("../src/adapters/admitad.adapter.js");
const { NetworkCertificationService, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/admitad.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/admitadSupplierSync.js", "utf8");

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const TOKEN = "zzadmitadtokenzz";

/** One programme row inside the real envelope shape: every value distinctive. */
const PROGRAM_PAYLOAD = {
  results: [
    {
      id: 778899,
      name: "zzprogramnamezz",
      site_url: "https://zzmerchantzz.example",
      gotolink: "https://ad.admitad.com/g/zzgotolinkzz/",
      status: "active",
      connection_status: "pending",
      currency: "AED",
      exclusive: false,
      rating: "4.5",
      actions: [
        { id: 5, name: "zzactionnamezz", type: "sale", payment_size: "7.00", hold_time: 30 },
      ],
      categories: [{ id: 11, name: "zzcategoryzz" }],
      regions: ["AE"],
      max_hold_time: 45,
      avg_money_transfer_time: 12,
    },
  ],
  _meta: { count: 1, limit: 1, offset: 0 },
};

/** The same envelope with no rows. */
const EMPTY_PAYLOAD = { results: [], _meta: { count: 0, limit: 1, offset: 0 } };

function spyHttp(dataOrError = PROGRAM_PAYLOAD) {
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

function serviceWith(adapter) {
  return new NetworkCertificationService({
    prisma: {
      rawPayload: {
        findMany: async () => {
          throw new Error("certification must not read RawPayload unless compareRaw is requested");
        },
      },
    },
    adapterFactory: () => adapter,
    admitadCredentialResolver: async () => ({ accessToken: TOKEN }),
  });
}

async function certifyPrograms(adapter, certifyOptions = {}) {
  return serviceWith(adapter).certify("admitad", {
    sourceObjects: ["programs"],
    ...certifyOptions,
  });
}

describe("programs is registered as an Admitad source object", () => {
  it("is listed alongside websites", () => {
    assert.ok(listProbeSourceObjects("admitad").includes("programs"));
    assert.ok(listProbeSourceObjects("admitad").includes("websites"));
  });

  it("declares a read-only GET", () => {
    assert.match(
      codeOf(SERVICE_SRC),
      /programs: \{\s*method: "GET",\s*endpointKey: "GET \/advcampaigns\/ \(limit=1, offset=0\)"/,
    );
  });

  it("names the unscoped path and its bounds in the endpointKey", async () => {
    const result = await certifyPrograms(adapterWith(spyHttp()));
    assert.equal(result.results[0].endpointKey, "GET /advcampaigns/ (limit=1, offset=0)");
    assert.equal(result.results[0].httpMethod, "GET");
    assert.equal(result.results[0].sourceObject, "programs");
  });

  it("is catalogued live and stays that way", () => {
    assert.equal(getSourceObject("admitad", "programs")?.live, true);
    assert.equal(getSourceObject("admitad", "programs")?.endpoint, "GET /advcampaigns/");
  });

  it("shares one bounded sample chain rather than duplicating it per object", () => {
    const code = codeOf(SERVICE_SRC);
    // Every Admitad probe routes through the same chain, and the chain exists exactly once.
    assert.equal(
      (code.match(/chain: "admitadSample"/g) ?? []).length,
      listProbeSourceObjects("admitad").length,
    );
    assert.equal((code.match(/async certifyAdmitadSample\(/g) ?? []).length, 1);
  });
});

describe("the programs request is exactly one bounded GET on the production path", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("programs", { timeoutMs: 5000 });
    assert.equal(spy.calls.length, 1);
  });

  it("uses the unscoped /advcampaigns/ path", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("programs", {});
    assert.equal(spy.calls[0].path, "/advcampaigns/");
  });

  it("never takes the website-scoped branch", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("programs", {});
    assert.ok(!spy.calls[0].path.includes("website"));
    assert.equal(ADMITAD_CERTIFICATION_SPECS.programs.path, "/advcampaigns/");
  });

  it("matches the path the production sync job actually runs", () => {
    // The sync job calls fetchCampaigns({}) — no websiteId — so production takes the unscoped
    // branch too. Certification must probe what production runs, not the other branch.
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchCampaigns\(\{\}, stats\)/);
    const production = codeOf(ADAPTER_SRC).split("async fetchCampaigns")[1];
    assert.match(production, /: "\/advcampaigns\/"/);
  });

  it("sends limit=1 and offset=0 and nothing else", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("programs", {});
    assert.deepEqual(spy.calls[0].config.params, { limit: 1, offset: 0 });
    assert.deepEqual(Object.keys(spy.calls[0].config.params).sort(), ["limit", "offset"]);
  });

  it("shares the frozen page bounds with every other Admitad probe", () => {
    assert.deepEqual({ ...ADMITAD_CERTIFICATION_PAGE_PARAMS }, { limit: 1, offset: 0 });
    assert.ok(Object.isFrozen(ADMITAD_CERTIFICATION_PAGE_PARAMS));
  });

  it("copies the frozen bounds rather than handing them over by reference", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("programs", {});
    assert.notEqual(spy.calls[0].config.params, ADMITAD_CERTIFICATION_PAGE_PARAMS);
  });

  it("applies the certification timeout", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("programs", { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("does not paginate even when the envelope reports far more rows", async () => {
    const spy = spyHttp({
      results: PROGRAM_PAYLOAD.results,
      _meta: { count: 9999, limit: 1, offset: 0 },
    });
    await adapterWith(spy).fetchCertificationSample("programs", {});
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() => adapterWith(spy).fetchCertificationSample("programs", {}));
    assert.equal(spy.calls.length, 1);
  });

  it("makes no supplier call beyond the single sample for a full run", async () => {
    const spy = spyHttp();
    await certifyPrograms(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("still makes only one request per object when both are certified together", async () => {
    const spy = spyHttp();
    const result = await serviceWith(adapterWith(spy)).certify("admitad", {
      sourceObjects: ["websites", "programs"],
    });
    assert.equal(spy.calls.length, 2);
    assert.deepEqual(spy.calls.map((c) => c.path).sort(), ["/advcampaigns/", "/websites/v2/"]);
    assert.equal(result.results.length, 2);
  });
});

describe("the request table is the only thing that chooses a path", () => {
  it("refuses a source object it does not name, saying so", async () => {
    const spy = spyHttp();
    await assert.rejects(
      () => adapterWith(spy).fetchCertificationSample("product_feeds", {}),
      // A named refusal, not a TypeError from dereferencing a missing spec: an operator reading
      // this must learn which object has no probe, not that something was null.
      (error) =>
        /No Admitad certification sample is defined for "product_feeds"/.test(error.message),
    );
    assert.equal(spy.calls.length, 0);
  });

  it("cannot be steered down the prototype chain", async () => {
    const spy = spyHttp();
    for (const inherited of ["constructor", "__proto__", "toString", "valueOf"]) {
      await assert.rejects(
        () => adapterWith(spy).fetchCertificationSample(inherited, {}),
        (error) => /No Admitad certification sample is defined/.test(error.message),
        inherited,
      );
    }
    assert.equal(spy.calls.length, 0);
  });

  it("accepts no path, website id or token from a caller", () => {
    const sampler = codeOf(ADAPTER_SRC)
      .split("async fetchCertificationSample")[1]
      .split("async fetchCampaigns")[0];
    for (const leak of ["params.path", "ctx.path", "options.path", "websiteId", "accessToken"]) {
      assert.ok(!sampler.includes(leak), leak);
    }
    assert.match(sampler, /httpClient\.get\(spec\.path,/);
  });

  it("keeps every declared spec frozen", () => {
    assert.ok(Object.isFrozen(ADMITAD_CERTIFICATION_SPECS));
    for (const spec of Object.values(ADMITAD_CERTIFICATION_SPECS)) {
      assert.ok(Object.isFrozen(spec));
      assert.equal(spec.method, "GET");
    }
  });

  it("declares no spec for an object that has no probe", () => {
    for (const notYet of ["product_feeds", "products", "payments", "invoices"]) {
      assert.ok(!Object.hasOwn(ADMITAD_CERTIFICATION_SPECS, notYet), notYet);
    }
  });

  it("names a probe for every declared spec", () => {
    for (const sourceObject of Object.keys(ADMITAD_CERTIFICATION_SPECS)) {
      assert.ok(listProbeSourceObjects("admitad").includes(sourceObject), sourceObject);
    }
  });
});

describe("the sample is bounded to one programme row, twice and independently", () => {
  it("slices in the adapter even when the supplier ignores limit=1", async () => {
    const many = { results: [...Array(40)].map((_, i) => ({ id: i, name: `zz${i}zz` })) };
    const spy = spyHttp(many);
    assert.equal((await adapterWith(spy).fetchCertificationSample("programs", {})).length, 1);
    assert.equal(ADMITAD_CERTIFICATION_MAX_ROWS, 1);
  });

  it("slices again in the service when an adapter hands back more than one row", async () => {
    const result = await certifyPrograms({
      fetchCertificationSample: async () => [
        { id: 1, name: "zzonezz" },
        { id: 2, name: "zztwozz" },
      ],
    });
    assert.equal(result.results[0].sampleCount, 1);
  });

  it("parses rows with production's own collection extractor", async () => {
    const spy = spyHttp();
    const rows = await adapterWith(spy).fetchCertificationSample("programs", {});
    assert.deepEqual(rows, extractAdmitadCollection(PROGRAM_PAYLOAD).slice(0, 1));
  });

  it("certifies a row and never the {results, _meta} envelope", async () => {
    const result = await certifyPrograms(adapterWith(spyHttp()));
    const paths = result.results[0].fieldPaths.map((f) => f.path ?? f);
    assert.ok(!paths.some((p) => String(p).startsWith("results")));
    assert.ok(!paths.some((p) => String(p).startsWith("_meta")));
    assert.ok(paths.some((p) => String(p) === "id"));
  });
});

describe("the programs outcome vocabulary", () => {
  it("reports OK with a field dictionary when one row comes back", async () => {
    const result = await certifyPrograms(adapterWith(spyHttp()));
    const row = result.results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.equal(row.schema, undefined);
  });

  it("reports OK_NO_ROWS with an unknown schema when the collection is empty", async () => {
    const result = await certifyPrograms(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    const row = result.results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("does NOT claim no joined campaigns on an empty programmes result", async () => {
    // The unscoped /advcampaigns/ may return catalogue-wide programmes, so emptiness cannot be
    // read as an account-approval state the way CJ's advertiser-ids=joined query can.
    const result = await certifyPrograms(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    const row = result.results[0];
    assert.equal(row.accountStateBlocker, undefined);
    assert.notEqual(row.statusCategory, "UNKNOWN_NEEDS_JOINED_CAMPAIGN");
    assert.notEqual(row.statusCategory, "BLOCKED_BY_ACCOUNT_STATE");
    assert.ok(!JSON.stringify(result).includes("NO_JOINED_CAMPAIGNS"));
  });

  it("carries no supplier status code on a successful empty result", async () => {
    const result = await certifyPrograms(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    assert.equal(result.results[0].supplierStatusCode, undefined);
  });

  it("reports a supplier failure as a failure, not as an empty sample", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 401 } });
    const result = await certifyPrograms(adapterWith(spyHttp(boom)));
    const row = result.results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.notEqual(row.statusCategory, "OK_NO_ROWS");
  });

  it("reaches the same verdicts as websites for the same responses", async () => {
    for (const [payload, expected] of [
      [PROGRAM_PAYLOAD, "OK"],
      [EMPTY_PAYLOAD, "OK_NO_ROWS"],
    ]) {
      const both = await serviceWith(adapterWith(spyHttp(payload))).certify("admitad", {
        sourceObjects: ["websites", "programs"],
      });
      for (const row of both.results) {
        assert.equal(row.statusCategory, expected, `${row.sourceObject} ${expected}`);
        assert.equal(row.accountStateBlocker, undefined, row.sourceObject);
      }
    }
  });
});

describe("no programme value reaches the result", () => {
  it("returns structural paths only — no ids, names, URLs or commission values", async () => {
    const result = await certifyPrograms(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const secret of [
      "zzprogramnamezz",
      "zzmerchantzz",
      "zzgotolinkzz",
      "zzactionnamezz",
      "zzcategoryzz",
      "778899",
      "7.00",
      "4.5",
      "AED",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("returns the commission field PATHS without their values", async () => {
    const result = await certifyPrograms(adapterWith(spyHttp()));
    const paths = result.results[0].fieldPaths.map((f) => f.path);
    assert.ok(paths.some((p) => String(p).includes("actions")));
    assert.ok(!JSON.stringify(result.results[0].fieldPaths).includes("7.00"));
  });

  it("reports a structural category for each path and never a value", async () => {
    const result = await certifyPrograms(adapterWith(spyHttp()));
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
    const fields = result.results[0].fieldPaths;
    assert.ok(fields.length > 0);
    for (const field of fields) {
      assert.ok(allowed.has(field.observedType), JSON.stringify(field));
      assert.ok(allowed.has(field.exampleCategory), JSON.stringify(field));
      // The entry describes the path and nothing on it: no key carries an example value.
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
    // Nested commission structure is described structurally, right down to the leaf.
    const paths = fields.map((f) => f.path);
    assert.ok(paths.includes("actions[].payment_size"));
  });

  it("never returns the raw payload", async () => {
    const row = (await certifyPrograms(adapterWith(spyHttp()))).results[0];
    for (const key of ["raw", "payload", "rows", "sample", "results"]) {
      assert.equal(row[key], undefined, key);
    }
  });

  it("never returns the access token", async () => {
    const boom = Object.assign(new Error(`rejected ${TOKEN}`), {
      response: { status: 403, data: { error: `bad token ${TOKEN}` } },
    });
    const result = await certifyPrograms(adapterWith(spyHttp(boom)));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
});

describe("certification stays read-only and changes no sync behaviour", () => {
  it("performs no database read or write for a programs run", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    const result = await certifyPrograms(adapterWith(spyHttp()));
    assert.equal(result.results[0].statusCategory, "OK");
  });

  it("writes nothing and triggers no sync", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyAdmitadSample")[1]
      .split("async certifyAwinCommissionGroups")[0];
    for (const write of ["upsert", "create", "update", "delete", "upsertManyRawEntities"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("leaves the production campaign fetcher paginating and website-scopable", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchCampaigns")[1]
      .split("async fetchCoupons")[0];
    assert.ok(production.includes("fetchOffsetPaginated"));
    assert.match(production, /advcampaigns\/website\//);
  });

  it("leaves the sync job's programs run untouched", () => {
    const code = codeOf(SYNC_SRC);
    assert.match(code, /sourceObject: "programs"/);
    assert.match(code, /adapter\.fetchCampaigns\(\{\}, stats\)/);
  });
});
