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

/**
 * One coupon row inside the real envelope shape.
 *
 * Every value is distinctive so a leak is detectable, and the row deliberately carries the shapes
 * this probe must NOT emit: a coupon code, the parent programme id, names, URLs, a discount, and
 * dates.
 */
const COUPON_PAYLOAD = {
  results: [
    {
      id: 445566,
      name: "zzcouponnamezz",
      promocode: "ZZPROMOCODEZZ",
      discount: "15%",
      description: "zzcoupondescriptionzz",
      campaign: 778899,
      campaign_name: "zzprogramnamezz",
      advcampaign_id: 778899,
      goto_link: "https://ad.admitad.com/g/zzgotolinkzz/",
      short_name: "zzshortnamezz",
      status: "active",
      exclusive: false,
      date_start: "2026-01-01T00:00:00",
      date_end: "2026-12-31T23:59:59",
      regions: ["AE"],
      categories: [{ id: 11, name: "zzcategoryzz" }],
      types: [{ id: 3, name: "zztypenamezz" }],
      rating: "4.5",
      currency: "AED",
    },
  ],
  _meta: { count: 1, limit: 1, offset: 0 },
};

/** The same envelope with no rows. */
const EMPTY_PAYLOAD = { results: [], _meta: { count: 0, limit: 1, offset: 0 } };

function spyHttp(dataOrError = COUPON_PAYLOAD) {
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

async function certifyCoupons(adapter) {
  return serviceWith(adapter).certify("admitad", { sourceObjects: ["coupons"] });
}

describe("coupons is registered as an Admitad source object", () => {
  it("is listed alongside websites, programs and actions", () => {
    assert.deepEqual(listProbeSourceObjects("admitad").sort(), [
      "actions",
      "coupons",
      "programs",
      "websites",
    ]);
  });

  it("declares a read-only GET on the production path", () => {
    assert.match(
      codeOf(SERVICE_SRC),
      /coupons: \{\s*method: "GET",\s*endpointKey: "GET \/coupons\/ \(limit=1, offset=0\)"/,
    );
  });

  it("reports the endpoint, method and object on the result", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    assert.equal(row.endpointKey, "GET /coupons/ (limit=1, offset=0)");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "coupons");
  });

  it("is catalogued live and stays that way", () => {
    assert.equal(getSourceObject("admitad", "coupons")?.live, true);
    assert.equal(getSourceObject("admitad", "coupons")?.endpoint, "GET /coupons/");
  });

  it("leaves the already certified objects catalogued live too", () => {
    for (const sourceObject of ["programs", "actions"]) {
      assert.equal(getSourceObject("admitad", sourceObject)?.live, true, sourceObject);
    }
  });

  it("adds no product-feed, payment or invoice probe", () => {
    for (const notYet of ["product_feeds", "products", "payments", "invoices", "campaigns"]) {
      assert.ok(!listProbeSourceObjects("admitad").includes(notYet), notYet);
      assert.ok(!Object.hasOwn(ADMITAD_CERTIFICATION_SPECS, notYet), notYet);
    }
  });
});

describe("the coupons request is exactly one bounded GET", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("coupons", { timeoutMs: 5000 });
    assert.equal(spy.calls.length, 1);
  });

  it("uses the production /coupons/ path", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("coupons", {});
    assert.equal(spy.calls[0].path, "/coupons/");
    assert.equal(ADMITAD_CERTIFICATION_SPECS.coupons.path, "/coupons/");
  });

  it("matches the only path production's fetchCoupons builds", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchCoupons")[1]
      .split("async fetchConversions")[0];
    assert.match(production, /fetchOffsetPaginated\("\/coupons\/"/);
    // Production takes no scope on this endpoint either, so the certified request is production's
    // whole request rather than a narrowed version of it.
    assert.ok(!production.includes("campaign"));
    assert.ok(!production.includes("website"));
  });

  it("sends limit=1 and offset=0 and nothing else", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("coupons", {});
    assert.deepEqual(spy.calls[0].config.params, { limit: 1, offset: 0 });
    assert.deepEqual(Object.keys(spy.calls[0].config.params).sort(), ["limit", "offset"]);
  });

  it("sends no campaign, programme or website scope", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("coupons", {});
    const serialised = JSON.stringify(spy.calls[0]);
    for (const scope of ["campaign", "advcampaign", "website", "w_id", "program"]) {
      assert.ok(!serialised.includes(scope), scope);
    }
  });

  it("copies the shared frozen bounds rather than passing them by reference", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("coupons", {});
    assert.notEqual(spy.calls[0].config.params, ADMITAD_CERTIFICATION_PAGE_PARAMS);
    assert.deepEqual({ ...ADMITAD_CERTIFICATION_PAGE_PARAMS }, { limit: 1, offset: 0 });
  });

  it("applies the certification timeout", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("coupons", { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("does not paginate even when the envelope reports far more rows", async () => {
    const spy = spyHttp({
      results: COUPON_PAYLOAD.results,
      _meta: { count: 9999, limit: 1, offset: 0 },
    });
    await adapterWith(spy).fetchCertificationSample("coupons", {});
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() => adapterWith(spy).fetchCertificationSample("coupons", {}));
    assert.equal(spy.calls.length, 1);
  });

  it("makes exactly one request for a full coupons run", async () => {
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("makes one request per object when all three are certified together", async () => {
    const spy = spyHttp();
    const result = await serviceWith(adapterWith(spy)).certify("admitad", {
      sourceObjects: ["websites", "programs", "coupons"],
    });
    assert.equal(spy.calls.length, 3);
    assert.deepEqual(spy.calls.map((c) => c.path).sort(), [
      "/advcampaigns/",
      "/coupons/",
      "/websites/v2/",
    ]);
    assert.equal(result.results.length, 3);
  });
});

describe("the sample is bounded to one coupon row, twice and independently", () => {
  it("slices in the adapter even when the supplier ignores limit=1", async () => {
    const many = { results: [...Array(50)].map((_, i) => ({ id: i, promocode: `ZZ${i}ZZ` })) };
    const spy = spyHttp(many);
    assert.equal((await adapterWith(spy).fetchCertificationSample("coupons", {})).length, 1);
    assert.equal(ADMITAD_CERTIFICATION_MAX_ROWS, 1);
  });

  it("slices again in the service when an adapter hands back more than one row", async () => {
    const result = await certifyCoupons({
      fetchCertificationSample: async () => [
        { id: 1, promocode: "ZZONEZZ" },
        { id: 2, promocode: "ZZTWOZZ" },
      ],
    });
    assert.equal(result.results[0].sampleCount, 1);
  });

  it("parses rows with production's own collection extractor", async () => {
    const spy = spyHttp();
    const rows = await adapterWith(spy).fetchCertificationSample("coupons", {});
    assert.deepEqual(rows, extractAdmitadCollection(COUPON_PAYLOAD).slice(0, 1));
  });

  it("certifies a row and never the {results, _meta} envelope", async () => {
    const paths = (await certifyCoupons(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(!paths.some((p) => String(p).startsWith("results")));
    assert.ok(!paths.some((p) => String(p).startsWith("_meta")));
    assert.ok(paths.includes("id"));
  });
});

describe("the coupons outcome vocabulary", () => {
  it("reports OK with a field dictionary when one row comes back", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.equal(row.schema, undefined);
  });

  it("reports OK_NO_ROWS with an unknown schema when the collection is empty", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp(EMPTY_PAYLOAD)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("claims no account-state blocker on an empty coupons result", async () => {
    const result = await certifyCoupons(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    const row = result.results[0];
    assert.equal(row.accountStateBlocker, undefined);
    assert.notEqual(row.statusCategory, "UNKNOWN_NEEDS_JOINED_CAMPAIGN");
    assert.ok(!JSON.stringify(result).includes("NO_JOINED_CAMPAIGNS"));
  });

  it("carries no supplier status code on a successful empty result", async () => {
    const result = await certifyCoupons(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    assert.equal(result.results[0].supplierStatusCode, undefined);
  });

  it("reports a supplier failure as a failure, not as an empty sample", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 401 } });
    const row = (await certifyCoupons(adapterWith(spyHttp(boom)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.notEqual(row.statusCategory, "OK_NO_ROWS");
  });

  it("reaches the same verdicts as the other two objects for the same responses", async () => {
    for (const [payload, expected] of [
      [COUPON_PAYLOAD, "OK"],
      [EMPTY_PAYLOAD, "OK_NO_ROWS"],
    ]) {
      const all = await serviceWith(adapterWith(spyHttp(payload))).certify("admitad", {
        sourceObjects: ["websites", "programs", "coupons"],
      });
      for (const row of all.results) {
        assert.equal(row.statusCategory, expected, `${row.sourceObject} ${expected}`);
        assert.equal(row.accountStateBlocker, undefined, row.sourceObject);
      }
    }
  });
});

describe("no coupon value reaches the result", () => {
  it("returns no coupon code, programme id, name, URL, discount or date", async () => {
    const result = await certifyCoupons(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const secret of [
      "ZZPROMOCODEZZ",
      "zzcouponnamezz",
      "zzcoupondescriptionzz",
      "zzshortnamezz",
      "zzprogramnamezz",
      "zzgotolinkzz",
      "zzcategoryzz",
      "zztypenamezz",
      "445566",
      "778899",
      "15%",
      "2026-01-01",
      "AED",
      "4.5",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("reports the coupon-code and programme-link field PATHS without their values", async () => {
    const result = await certifyCoupons(adapterWith(spyHttp()));
    const paths = result.results[0].fieldPaths.map((f) => f.path);
    for (const expected of ["promocode", "campaign", "goto_link", "discount", "date_end"]) {
      assert.ok(paths.includes(expected), expected);
    }
    assert.ok(!JSON.stringify(result.results[0].fieldPaths).includes("ZZPROMOCODEZZ"));
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
    const fields = (await certifyCoupons(adapterWith(spyHttp()))).results[0].fieldPaths;
    assert.ok(fields.length > 0);
    for (const field of fields) {
      assert.ok(allowed.has(field.observedType), JSON.stringify(field));
      assert.ok(allowed.has(field.exampleCategory), JSON.stringify(field));
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
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    for (const key of ["raw", "payload", "rows", "sample", "results"]) {
      assert.equal(row[key], undefined, key);
    }
  });

  it("never returns the access token", async () => {
    const boom = Object.assign(new Error(`rejected ${TOKEN}`), {
      response: { status: 403, data: { error: `bad token ${TOKEN}` } },
    });
    const result = await certifyCoupons(adapterWith(spyHttp(boom)));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });
});

describe("nothing here maps commission truth or changes tracking", () => {
  it("adds no commission mapping for Admitad", () => {
    // Scoped to the Admitad chain and adapter. The wider service legitimately names
    // SupplierCommissionRule for Optimise, which this phase neither touches nor inherits.
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyAdmitadSample")[1]
      .split("async certifyAwinCommissionGroups")[0];
    const adapter = codeOf(ADAPTER_SRC);
    for (const mapping of [
      "SupplierCommissionRule",
      "commissionRate",
      "payment_size",
      "commission",
    ]) {
      assert.ok(!chain.includes(mapping), `chain: ${mapping}`);
      assert.ok(!adapter.includes(mapping), `adapter: ${mapping}`);
    }
  });

  it("treats a coupon's programme association as a field path, never as a rate", async () => {
    const fields = (await certifyCoupons(adapterWith(spyHttp()))).results[0].fieldPaths;
    const campaign = fields.find((f) => f.path === "campaign");
    assert.ok(campaign);
    // A path and a structural category. No value, and nothing that resolves it to a programme.
    assert.ok(!Object.hasOwn(campaign, "value"));
    assert.ok(!Object.hasOwn(campaign, "example"));
  });

  it("changes no tracking-link behaviour", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.ok(!code.includes("buildDeepLink"));
    assert.ok(!code.includes("fetchDeepLink"));
    assert.ok(!code.includes("trackingUrl"));
    // DEEP_LINK is no longer declared: it was removed as unimplemented in the capability-truth
    // cleanup. Nothing in this phase re-adds it or builds the deeplink it used to claim.
    assert.ok(!code.includes("SUPPLIER_CAPABILITIES.DEEP_LINK"));
  });

  it("adds no product-feed path", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.ok(!code.includes("fetchProducts"));
    assert.ok(!code.includes("product_feed"));
  });
});

describe("certification stays read-only and changes no sync behaviour", () => {
  it("performs no database read or write for a coupons run", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    assert.equal(row.statusCategory, "OK");
  });

  it("writes nothing and triggers no sync", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyAdmitadSample")[1]
      .split("async certifyAwinCommissionGroups")[0];
    for (const write of ["upsert", "create", "update", "delete", "upsertManyRawEntities"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("leaves the production coupon fetcher paginating", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchCoupons")[1]
      .split("async fetchConversions")[0];
    assert.ok(production.includes("fetchOffsetPaginated"));
  });

  it("leaves the sync job's coupons run untouched", () => {
    const code = codeOf(SYNC_SRC);
    assert.match(code, /sourceObject: "coupons"/);
    assert.match(code, /adapter\.fetchCoupons\(\{\}, stats\)/);
  });
});
