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
const { NetworkCertificationService, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/rakuten.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/rakutenSupplierSync.js", "utf8");

/**
 * Comments are prose; an assertion that matches one proves nothing about behaviour.
 *
 * A single pass tracking BOTH comment state and string state. This adapter needs it: getCsv sends
 * `Accept: "text/csv,text/plain,*\/*"`, whose `/*` opens a comment span in a naive regex stripper
 * and swallows everything to the next `*\/`. Masking strings first is no better — prose comments
 * are full of apostrophes, and a quote inside a comment is not a string delimiter.
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

/**
 * One commissioning-list row in the real envelope shape.
 *
 * Field NAMES are plausible and are what the probe discovers; every VALUE is a distinctive marker
 * so a leak is unambiguous and cannot be confused with a path substring.
 *
 * The row deliberately carries MULTIPLE payout outcomes under one rule, because whether a single
 * row can hold several is the structural question this probe exists to answer. Each will later
 * become its own SupplierCommissionRule, so nothing here may merge or average them.
 *
 * This fixture is a plausible shape, NOT a claim about Rakuten's real contract.
 */
const COMMISSIONING_PAYLOAD = {
  commissioninglists: [
    {
      id: 991177,
      name: "zzrulenamezz",
      advertiser_id: 665544,
      advertiser_name: "zzadvnamezz",
      mid: "zzmidzz",
      status: "zzstatusvaluezz",
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      effective_date: "2026-01-05",
      currency: "AED",
      country: "zzcountryvaluezz",
      category: "zzcategoryvaluezz",
      product_conditions: { sku_group: "zzskugroupzz" },
      // Several distinct payout outcomes on ONE rule. Never to be merged or averaged.
      commissions: [
        {
          action_type: "zzsalezz",
          event_type: "zzeventonezz",
          percentage: "zzpctonezz",
          fixed_amount: "zzfixedonezz",
          currency: "AED",
        },
        {
          action_type: "zzleadzz",
          event_type: "zzeventtwozz",
          percentage: "zzpcttwozz",
          fixed_amount: "zzfixedtwozz",
          currency: "AED",
        },
      ],
    },
  ],
  _metadata: { page: 1, limit: 1, total: 1 },
};

/** The same envelope with no rows. */
const EMPTY_PAYLOAD = { commissioninglists: [], _metadata: { page: 1, limit: 1, total: 0 } };

function spyHttp(dataOrError = COMMISSIONING_PAYLOAD) {
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
    rakutenCredentialResolver: async () => ({
      accessToken: TOKEN,
      securityToken: SECURITY_TOKEN,
    }),
  });
}

async function certifyLists(adapter) {
  return serviceWith(adapter).certify("rakuten", { sourceObjects: ["commissioning_lists"] });
}

describe("commissioning_lists is registered as a Rakuten source object", () => {
  it("is listed alongside advertisers and partnerships", () => {
    assert.deepEqual(listProbeSourceObjects("rakuten").sort(), [
      "advertisers",
      "commissioning_lists",
      "partnerships",
    ]);
  });

  it("declares a read-only GET with its bounds in the endpointKey", () => {
    assert.match(
      codeOf(SERVICE_SRC),
      /commissioning_lists: \{\s*method: "GET",\s*endpointKey: "GET \/v1\/commissioninglists \(limit=1, page=1\)"/,
    );
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.commissioning_lists.method, "GET");
  });

  it("reports its own endpoint, method and object", async () => {
    const row = (await certifyLists(adapterWith(spyHttp()))).results[0];
    assert.equal(row.endpointKey, "GET /v1/commissioninglists (limit=1, page=1)");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "commissioning_lists");
  });

  it("shares the one bounded chain rather than adding a third", () => {
    const code = codeOf(SERVICE_SRC);
    assert.equal(
      (code.match(/chain: "rakutenSample"/g) ?? []).length,
      listProbeSourceObjects("rakuten").length,
    );
    assert.equal((code.match(/async certifyRakutenSample\(/g) ?? []).length, 1);
  });

  it("is catalogued live and already typed as a commission rule", () => {
    const entry = getSourceObject("rakuten", "commissioning_lists");
    assert.equal(entry?.live, true);
    assert.equal(entry?.endpoint, "GET /v1/commissioninglists");
    // The repo's own classification: rules here, promotional assets under offers.
    assert.equal(entry?.entityType, "commission_rule");
    assert.equal(getSourceObject("rakuten", "offers")?.entityType, "offer");
  });

  it("adds no probe for the objects this phase still defers", () => {
    for (const notYet of [
      "offers",
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
});

describe("the commissioning-lists request is exactly one bounded GET", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("commissioning_lists", { timeoutMs: 5000 });
    assert.equal(spy.calls.length, 1);
  });

  it("uses the production path", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("commissioning_lists", {});
    assert.equal(spy.calls[0].path, "/v1/commissioninglists");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.commissioning_lists.path, "/v1/commissioninglists");
  });

  it("matches the only path production's fetchCommissioningLists builds", () => {
    assert.match(
      codeOf(ADAPTER_SRC),
      /fetchPagedJson\("\/v1\/commissioninglists", params, \["commissioninglists", "commissioning_lists"\], stats, \{ maxLimit: 200 \}\)/,
    );
  });

  it("sends limit=1 and page=1 and nothing else", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("commissioning_lists", {});
    assert.deepEqual(spy.calls[0].config.params, { limit: 1, page: 1 });
    assert.deepEqual(Object.keys(spy.calls[0].config.params).sort(), ["limit", "page"]);
  });

  it("stays inside production's own maxLimit for this path", () => {
    assert.ok(RAKUTEN_CERTIFICATION_PAGE_PARAMS.limit <= 200);
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_PAGE_PARAMS }, { limit: 1, page: 1 });
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_PAGE_PARAMS));
  });

  it("copies the frozen bounds rather than handing them over by reference", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("commissioning_lists", {});
    assert.notEqual(spy.calls[0].config.params, RAKUTEN_CERTIFICATION_PAGE_PARAMS);
  });

  it("sends no advertiser, rule or date filter", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("commissioning_lists", {});
    for (const forbidden of ["advertiser", "mid", "start_date", "end_date", "status", "category"]) {
      assert.ok(!Object.hasOwn(spy.calls[0].config.params, forbidden), forbidden);
    }
  });

  it("applies the certification timeout", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("commissioning_lists", { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("does not paginate even when the envelope reports far more rows", async () => {
    const spy = spyHttp({
      commissioninglists: COMMISSIONING_PAYLOAD.commissioninglists,
      _metadata: { page: 1, limit: 1, total: 9999 },
    });
    await adapterWith(spy).fetchCertificationSample("commissioning_lists", {});
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() =>
      adapterWith(spy).fetchCertificationSample("commissioning_lists", {}),
    );
    assert.equal(spy.calls.length, 1);
  });

  it("makes exactly one request for a full run", async () => {
    const spy = spyHttp();
    await certifyLists(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("makes one request per object when all three are certified together", async () => {
    const spy = spyHttp();
    const result = await serviceWith(adapterWith(spy)).certify("rakuten", {
      sourceObjects: ["advertisers", "partnerships", "commissioning_lists"],
    });
    assert.equal(spy.calls.length, 3);
    assert.deepEqual(spy.calls.map((c) => c.path).sort(), [
      "/v1/commissioninglists",
      "/v1/partnerships",
      "/v2/advertisers",
    ]);
    assert.equal(result.results.length, 3);
  });

  it("needs no web security token", async () => {
    const spy = spyHttp();
    const bearerOnly = createRakutenAdapter({ accessToken: TOKEN, httpClient: spy.client });
    const rows = await bearerOnly.fetchCertificationSample("commissioning_lists", {});
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(spy.calls[0]).includes(SECURITY_TOKEN));
  });
});

describe("the sample is bounded to one row, twice and independently", () => {
  it("slices in the adapter even when the supplier ignores limit=1", async () => {
    const many = { commissioninglists: [...Array(40)].map((_, i) => ({ id: i })) };
    const spy = spyHttp(many);
    assert.equal(
      (await adapterWith(spy).fetchCertificationSample("commissioning_lists", {})).length,
      1,
    );
    assert.equal(RAKUTEN_CERTIFICATION_MAX_ROWS, 1);
  });

  it("slices again in the service when an adapter hands back more than one row", async () => {
    const result = await certifyLists({
      fetchCertificationSample: async () => [{ id: 1 }, { id: 2 }],
    });
    assert.equal(result.results[0].sampleCount, 1);
  });

  it("uses production's own extractor and container keys", async () => {
    const spy = spyHttp();
    const rows = await adapterWith(spy).fetchCertificationSample("commissioning_lists", {});
    assert.deepEqual(
      rows,
      extractRakutenCollection(COMMISSIONING_PAYLOAD, [
        "commissioninglists",
        "commissioning_lists",
      ]).slice(0, 1),
    );
    assert.deepEqual([...RAKUTEN_CERTIFICATION_SPECS.commissioning_lists.collectionKeys], [
      "commissioninglists",
      "commissioning_lists",
    ]);
  });

  it("certifies a row and never the envelope", async () => {
    const paths = (await certifyLists(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(!paths.some((p) => String(p).startsWith("commissioninglists")));
    assert.ok(!paths.some((p) => String(p).startsWith("_metadata")));
    assert.ok(paths.includes("id"));
  });

  it("bounding to one ROW does not discard the outcomes inside that row", async () => {
    // One row, several payout outcomes. The row bound must not become an outcome bound.
    const paths = (await certifyLists(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(paths.includes("commissions"));
    assert.ok(paths.includes("commissions[].action_type"));
  });
});

describe("the commission-rule shape is DISCOVERED as paths", () => {
  it("reports an advertiser or programme reference path", async () => {
    const paths = (await certifyLists(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const expected of ["advertiser_id", "mid"]) {
      assert.ok(paths.includes(expected), expected);
    }
  });

  it("reports a rule identity path", async () => {
    const paths = (await certifyLists(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(paths.includes("id"));
    assert.ok(paths.includes("name"));
  });

  it("reports action and event type paths inside the outcome array", async () => {
    const paths = (await certifyLists(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(paths.includes("commissions[].action_type"));
    assert.ok(paths.includes("commissions[].event_type"));
  });

  it("reports percentage AND fixed payout paths separately, never merged", async () => {
    const paths = (await certifyLists(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(paths.includes("commissions[].percentage"));
    assert.ok(paths.includes("commissions[].fixed_amount"));
    // No invented composite: a rate and an amount are different facts.
    assert.ok(!paths.some((p) => /effective(Rate|Commission)|blended|average/i.test(String(p))));
  });

  it("reports currency, condition and date paths", async () => {
    const paths = (await certifyLists(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const expected of [
      "currency",
      "country",
      "category",
      "product_conditions.sku_group",
      "start_date",
      "end_date",
      "effective_date",
      "status",
    ]) {
      assert.ok(paths.includes(expected), expected);
    }
  });

  it("reports the outcome array as an ARRAY, so multiplicity is visible", async () => {
    const fields = (await certifyLists(adapterWith(spyHttp()))).results[0].fieldPaths;
    const commissions = fields.find((f) => f.path === "commissions");
    assert.ok(commissions);
    assert.equal(commissions.observedType, "ARRAY");
    assert.equal(commissions.arrayObserved, true);
  });
});

describe("nothing is mapped, averaged or collapsed", () => {
  it("returns no commission rate, amount or currency VALUE", async () => {
    const result = await certifyLists(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const secret of [
      "zzpctonezz",
      "zzpcttwozz",
      "zzfixedonezz",
      "zzfixedtwozz",
      "AED",
      "zzsalezz",
      "zzleadzz",
      "zzeventonezz",
      "zzeventtwozz",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("returns no advertiser or rule identity VALUE", async () => {
    const result = await certifyLists(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const secret of [
      "zzrulenamezz",
      "zzadvnamezz",
      "zzmidzz",
      "zzstatusvaluezz",
      "zzcountryvaluezz",
      "zzcategoryvaluezz",
      "zzskugroupzz",
      "991177",
      "665544",
      "2026-01-01",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("builds no canonical commission rule", async () => {
    const result = await certifyLists(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const canonical of ["SupplierCommissionRule", "commissionRate", "payoutType", "CPS", "CPA"]) {
      assert.ok(!serialised.includes(canonical), canonical);
    }
    const code = codeOf(SERVICE_SRC);
    const chain = code.slice(
      code.indexOf("async certifyRakutenSample("),
      code.indexOf("async certifyAwinCommissionGroups("),
    );
    for (const mapping of ["SupplierCommissionRule", "commissionRate", "average", "reduce("]) {
      assert.ok(!chain.includes(mapping), mapping);
    }
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
    const fields = (await certifyLists(adapterWith(spyHttp()))).results[0].fieldPaths;
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

  it("never returns the raw payload or either credential", async () => {
    const row = (await certifyLists(adapterWith(spyHttp()))).results[0];
    for (const key of ["raw", "payload", "rows", "sample", "commissioninglists"]) {
      assert.equal(row[key], undefined, key);
    }
    const boom = Object.assign(new Error(`rejected ${TOKEN}`), {
      response: { status: 403, data: { error: `bad ${TOKEN} ${SECURITY_TOKEN}` } },
    });
    const failed = JSON.stringify(await certifyLists(adapterWith(spyHttp(boom))));
    assert.ok(!failed.includes(TOKEN));
    assert.ok(!failed.includes(SECURITY_TOKEN));
  });
});

describe("the commissioning-lists outcome vocabulary", () => {
  it("reports OK with a field dictionary when one row comes back", async () => {
    const row = (await certifyLists(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.equal(row.schema, undefined);
  });

  it("reports OK_NO_ROWS with an unknown schema when the collection is empty", async () => {
    const row = (await certifyLists(adapterWith(spyHttp(EMPTY_PAYLOAD)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("does not classify unsupported just because the account has joined nothing", async () => {
    const result = await certifyLists(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    const serialised = JSON.stringify(result);
    for (const wrong of [
      "NOT_SUPPORTED",
      "UNAVAILABLE",
      "NO_ENDPOINT",
      "UPSTREAM_ERROR",
      "REQUEST_REJECTED",
      "NO_JOINED_CAMPAIGNS",
      "UNKNOWN_NEEDS_JOINED_CAMPAIGN",
    ]) {
      assert.ok(!serialised.includes(wrong), wrong);
    }
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[0].accountStateBlocker, undefined);
  });

  it("preserves a safe supplier status on failure", async () => {
    for (const [status, category] of [
      [401, "AUTH_FAILED"],
      [400, "REQUEST_REJECTED"],
      [500, "UPSTREAM_ERROR"],
    ]) {
      const boom = Object.assign(new Error("failed"), { response: { status } });
      const row = (await certifyLists(adapterWith(spyHttp(boom)))).results[0];
      assert.equal(row.ok, false, String(status));
      assert.equal(row.statusCategory, category, String(status));
      assert.equal(row.supplierStatusCode, status, String(status));
    }
  });

  it("carries no supplier status code on a successful empty result", async () => {
    const result = await certifyLists(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    assert.equal(result.results[0].supplierStatusCode, undefined);
  });
});

describe("certification stays read-only and changes no sync behaviour", () => {
  it("performs no database read or write", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    const row = (await certifyLists(adapterWith(spyHttp()))).results[0];
    assert.equal(row.statusCategory, "OK");
  });

  it("writes nothing and triggers no sync", () => {
    const code = codeOf(SERVICE_SRC);
    const chain = code.slice(
      code.indexOf("async certifyRakutenSample("),
      code.indexOf("async certifyAwinCommissionGroups("),
    );
    for (const write of ["upsert", "delete", "upsertManyRawEntities"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("leaves the production commissioning-lists fetcher paginating", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchCommissioningLists")[1]
      .split("async fetchConversions")[0];
    assert.ok(production.includes("fetchPagedJson"));
  });

  it("leaves the sync job's commissioning-lists run untouched", () => {
    const code = codeOf(SYNC_SRC);
    assert.match(code, /sourceObject: "commissioning_lists"/);
    assert.match(code, /adapter\.fetchCommissioningLists\(\{\}, stats\)/);
  });

  it("adds no offers, events, payment or asset path", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const absent of ["fetchCoupons", "fetchProducts", "buildDeepLink", "fetchLinks"]) {
      assert.ok(!code.includes(absent), absent);
    }
    for (const present of ["fetchOffers", "fetchConversions", "fetchPayments"]) {
      assert.ok(code.includes(present), present);
    }
  });
});
