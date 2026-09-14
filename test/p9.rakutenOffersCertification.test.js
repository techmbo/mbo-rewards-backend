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
 * One offer row in the real envelope shape.
 *
 * Field NAMES are plausible and are what the probe discovers; every VALUE is a distinctive marker
 * so a leak is unambiguous and cannot be confused with a path substring. That distinction is not
 * theoretical: a short value like "7.5" also occurs inside probedAt's ISO timestamp, which made a
 * sibling suite's leak assertion fail roughly one run in a hundred.
 *
 * A plausible shape, NOT a claim about Rakuten's real contract.
 */
const OFFER_PAYLOAD = {
  offers: [
    {
      goid: "zzgoidzz",
      offer_number: "zzoffernumberzz",
      name: "zzoffernamezz",
      offer_status: "zzstatusvaluezz",
      advertiser: { id: 665544, name: "zzadvnamezz", mid: "zzmidzz" },
      commission_type: "zzcommissiontypezz",
      commission_percentage: "zzpctvaluezz",
      commission_fixed: "zzfixedvaluezz",
      currency: "AED",
      start_date: "2026-02-01",
      end_date: "2026-11-30",
      effective_date: "2026-02-05",
      categories: [{ id: 4, name: "zzcategoryvaluezz" }],
      countries: ["zzcountryvaluezz"],
      product_conditions: { sku_group: "zzskugroupzz" },
      landing_page: "https://zzlandingzz.example/offer",
      tracking_url: "https://click.linksynergy.com/zztrackingzz",
      payouts: [
        { action: "zzactiononezz", percentage: "zzpayoutpctonezz", fixed: "zzpayoutfixedonezz" },
        { action: "zzactiontwozz", percentage: "zzpayoutpcttwozz", fixed: "zzpayoutfixedtwozz" },
      ],
    },
  ],
  _metadata: { page: 1, limit: 1, total: 1 },
};

/** The same envelope with no rows. */
const EMPTY_PAYLOAD = { offers: [], _metadata: { page: 1, limit: 1, total: 0 } };

function spyHttp(dataOrError = OFFER_PAYLOAD) {
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

async function certifyOffers(adapter) {
  return serviceWith(adapter).certify("rakuten", { sourceObjects: ["offers"] });
}

describe("offers is registered as a Rakuten source object", () => {
  it("completes the certified Rakuten object set", () => {
    assert.deepEqual(listProbeSourceObjects("rakuten").sort(), [
      "advertisers",
      "commissioning_lists",
      "coupons",
      "links",
      "offers",
      "partnerships",
    ]);
  });

  it("declares a read-only GET naming the pinned status and bounds", () => {
    assert.match(
      codeOf(SERVICE_SRC),
      /offers: \{\s*method: "GET",\s*endpointKey: "GET \/v1\/offers \(offer_status=available, limit=1, page=1\)"/,
    );
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.offers.method, "GET");
  });

  it("reports its own endpoint, method and object", async () => {
    const row = (await certifyOffers(adapterWith(spyHttp()))).results[0];
    assert.equal(row.endpointKey, "GET /v1/offers (offer_status=available, limit=1, page=1)");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "offers");
  });

  it("shares the one bounded chain rather than adding a fourth", () => {
    const code = codeOf(SERVICE_SRC);
    assert.equal(
      (code.match(/chain: "rakutenSample"/g) ?? []).length,
      listProbeSourceObjects("rakuten").length,
    );
    assert.equal((code.match(/async certifyRakutenSample\(/g) ?? []).length, 1);
  });

  it("is catalogued live and typed as an offer, distinct from the commission-rule source", () => {
    assert.equal(getSourceObject("rakuten", "offers")?.live, true);
    assert.equal(getSourceObject("rakuten", "offers")?.endpoint, "GET /v1/offers");
    assert.equal(getSourceObject("rakuten", "offers")?.entityType, "offer");
    assert.equal(getSourceObject("rakuten", "commissioning_lists")?.entityType, "commission_rule");
  });

  it("adds no probe for the objects this phase still defers", () => {
    for (const notYet of ["events", "advanced_reports", "payments", "products"]) {
      assert.ok(!listProbeSourceObjects("rakuten").includes(notYet), notYet);
      assert.ok(!Object.hasOwn(RAKUTEN_CERTIFICATION_SPECS, notYet), notYet);
    }
  });
});

describe("one request, where production makes three", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("offers", { timeoutMs: 5000 });
    assert.equal(spy.calls.length, 1);
  });

  it("pins offer_status=available, a value production itself sends", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("offers", {});
    assert.equal(spy.calls[0].config.params.offer_status, "available");
    // Not a guess: production's fetchOffers walks exactly these three statuses.
    assert.match(
      codeOf(ADAPTER_SRC),
      /const statuses = requestedStatus \? \[String\(requestedStatus\)\] : \["active", "upcoming", "available"\];/,
    );
  });

  it("does NOT walk the three statuses the way production does", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("offers", {});
    assert.equal(spy.calls.length, 1);
    const sent = spy.calls.map((c) => c.config.params.offer_status);
    assert.deepEqual(sent, ["available"]);
    assert.ok(!sent.includes("active"));
    assert.ok(!sent.includes("upcoming"));
  });

  it("makes exactly one request for a full offers run", async () => {
    const spy = spyHttp();
    await certifyOffers(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("stays one request per object when all four are certified together", async () => {
    const spy = spyHttp();
    const result = await serviceWith(adapterWith(spy)).certify("rakuten", {
      sourceObjects: ["advertisers", "partnerships", "commissioning_lists", "offers"],
    });
    assert.equal(spy.calls.length, 4);
    assert.deepEqual(spy.calls.map((c) => c.path).sort(), [
      "/v1/commissioninglists",
      "/v1/offers",
      "/v1/partnerships",
      "/v2/advertisers",
    ]);
    assert.equal(result.results.length, 4);
  });

  it("leaves production's three-status walk and dedupe untouched", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchOffers")[1]
      .split("async fetchCommissioningLists")[0];
    assert.match(production, /\["active", "upcoming", "available"\]/);
    assert.match(production, /seen\.has\(key\)/);
    assert.ok(production.includes("fetchPagedJson"));
  });
});

describe("the offers request is bounded and evidenced", () => {
  it("uses the production path", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("offers", {});
    assert.equal(spy.calls[0].path, "/v1/offers");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.offers.path, "/v1/offers");
  });

  it("sends limit=1, page=1 and the pinned status, and nothing else", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("offers", {});
    assert.deepEqual(spy.calls[0].config.params, {
      limit: 1,
      page: 1,
      offer_status: "available",
    });
  });

  it("stays inside production's own offer limit", () => {
    // fetchOffers pages this endpoint under MAX_OFFER_LIMIT; the probe's bound sits well inside.
    assert.match(codeOf(ADAPTER_SRC), /const MAX_OFFER_LIMIT = 200;/);
    assert.ok(RAKUTEN_CERTIFICATION_PAGE_PARAMS.limit <= 200);
  });

  it("keeps the spec's params frozen and separate from the page bounds", () => {
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_SPECS.offers.params));
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_SPECS.offers.params }, {
      offer_status: "available",
    });
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_PAGE_PARAMS }, { limit: 1, page: 1 });
  });

  it("is the only spec that declares a FILTER", () => {
    // coupons also carries params, but they are its own documented BOUNDS (resultsperpage,
    // pagenumber) rather than a filter narrowing what the supplier returns. Nothing else has any.
    for (const [name, spec] of Object.entries(RAKUTEN_CERTIFICATION_SPECS)) {
      if (name === "offers" || name === "coupons") continue;
      assert.equal(spec.params, undefined, name);
    }
    assert.ok(!RAKUTEN_CERTIFICATION_SPECS.offers.ownBounds, "offers keeps the shared bounds");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.coupons.ownBounds, true);
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_SPECS.coupons.params }, {
      resultsperpage: 1,
      pagenumber: 1,
    });
  });

  it("copies the frozen bounds rather than handing them over by reference", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("offers", {});
    assert.notEqual(spy.calls[0].config.params, RAKUTEN_CERTIFICATION_PAGE_PARAMS);
    assert.notEqual(spy.calls[0].config.params, RAKUTEN_CERTIFICATION_SPECS.offers.params);
  });

  it("applies the certification timeout", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("offers", { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("does not paginate even when the envelope reports far more rows", async () => {
    const spy = spyHttp({
      offers: OFFER_PAYLOAD.offers,
      _metadata: { page: 1, limit: 1, total: 9999 },
    });
    await adapterWith(spy).fetchCertificationSample("offers", {});
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() => adapterWith(spy).fetchCertificationSample("offers", {}));
    assert.equal(spy.calls.length, 1);
  });

  it("needs no web security token", async () => {
    const spy = spyHttp();
    const bearerOnly = createRakutenAdapter({ accessToken: TOKEN, httpClient: spy.client });
    assert.equal((await bearerOnly.fetchCertificationSample("offers", {})).length, 1);
    assert.ok(!JSON.stringify(spy.calls[0]).includes(SECURITY_TOKEN));
  });
});

describe("the sample is bounded to one row, twice and independently", () => {
  it("slices in the adapter even when the supplier ignores limit=1", async () => {
    const many = { offers: [...Array(40)].map((_, i) => ({ goid: `zz${i}zz` })) };
    const spy = spyHttp(many);
    assert.equal((await adapterWith(spy).fetchCertificationSample("offers", {})).length, 1);
    assert.equal(RAKUTEN_CERTIFICATION_MAX_ROWS, 1);
  });

  it("slices again in the service when an adapter hands back more than one row", async () => {
    const result = await certifyOffers({
      fetchCertificationSample: async () => [{ goid: "a" }, { goid: "b" }],
    });
    assert.equal(result.results[0].sampleCount, 1);
  });

  it("uses production's own extractor and container keys", async () => {
    const spy = spyHttp();
    const rows = await adapterWith(spy).fetchCertificationSample("offers", {});
    assert.deepEqual(rows, extractRakutenCollection(OFFER_PAYLOAD, ["offers", "offer"]).slice(0, 1));
    assert.deepEqual([...RAKUTEN_CERTIFICATION_SPECS.offers.collectionKeys], ["offers", "offer"]);
  });

  it("certifies a row and never the envelope", async () => {
    const paths = (await certifyOffers(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(!paths.some((p) => String(p).startsWith("offers")));
    assert.ok(!paths.some((p) => String(p).startsWith("_metadata")));
    assert.ok(paths.includes("goid"));
  });

  it("bounding to one ROW does not discard the payouts inside that row", async () => {
    const paths = (await certifyOffers(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(paths.includes("payouts"));
    assert.ok(paths.includes("payouts[].action"));
  });
});

describe("the commercial shape is DISCOVERED as paths", () => {
  let paths;

  const load = async () => {
    if (!paths) {
      paths = (await certifyOffers(adapterWith(spyHttp()))).results[0].fieldPaths.map((f) => f.path);
    }
    return paths;
  };

  it("reports the advertiser reference", async () => {
    const p = await load();
    for (const expected of ["advertiser.id", "advertiser.mid"]) {
      assert.ok(p.includes(expected), expected);
    }
  });

  it("reports offer identity — GOID and offer number", async () => {
    const p = await load();
    for (const expected of ["goid", "offer_number", "name"]) {
      assert.ok(p.includes(expected), expected);
    }
  });

  it("reports the offer status path", async () => {
    assert.ok((await load()).includes("offer_status"));
  });

  it("reports fixed and percentage payout paths SEPARATELY", async () => {
    const p = await load();
    for (const expected of [
      "commission_type",
      "commission_percentage",
      "commission_fixed",
      "payouts[].percentage",
      "payouts[].fixed",
    ]) {
      assert.ok(p.includes(expected), expected);
    }
    // No invented composite: a rate and an amount are different facts.
    assert.ok(!p.some((x) => /effective(Rate|Commission)|blended|average/i.test(String(x))));
  });

  it("reports currency, date and condition paths", async () => {
    const p = await load();
    for (const expected of [
      "currency",
      "start_date",
      "end_date",
      "effective_date",
      "categories[].name",
      "countries",
      "product_conditions.sku_group",
    ]) {
      assert.ok(p.includes(expected), expected);
    }
  });

  it("reports landing and tracking link paths", async () => {
    const p = await load();
    for (const expected of ["landing_page", "tracking_url"]) {
      assert.ok(p.includes(expected), expected);
    }
  });

  it("reports the payout array as an ARRAY, so multiplicity is visible", async () => {
    const fields = (await certifyOffers(adapterWith(spyHttp()))).results[0].fieldPaths;
    const payouts = fields.find((f) => f.path === "payouts");
    assert.ok(payouts);
    assert.equal(payouts.observedType, "ARRAY");
    assert.equal(payouts.arrayObserved, true);
  });
});

describe("nothing is mapped, averaged, merged or persisted", () => {
  it("returns no commission, payout or currency VALUE", async () => {
    const serialised = JSON.stringify(await certifyOffers(adapterWith(spyHttp())));
    for (const secret of [
      "zzcommissiontypezz",
      "zzpctvaluezz",
      "zzfixedvaluezz",
      "zzpayoutpctonezz",
      "zzpayoutpcttwozz",
      "zzpayoutfixedonezz",
      "zzpayoutfixedtwozz",
      "zzactiononezz",
      "zzactiontwozz",
      "AED",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("returns no identity, condition, date or URL VALUE", async () => {
    const serialised = JSON.stringify(await certifyOffers(adapterWith(spyHttp())));
    for (const secret of [
      "zzgoidzz",
      "zzoffernumberzz",
      "zzoffernamezz",
      "zzstatusvaluezz",
      "zzadvnamezz",
      "zzmidzz",
      "zzcategoryvaluezz",
      "zzcountryvaluezz",
      "zzskugroupzz",
      "zzlandingzz",
      "zztrackingzz",
      "665544",
      "2026-02-01",
      "linksynergy.com",
      "https://",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("builds no canonical commission rule and persists nothing", async () => {
    const serialised = JSON.stringify(await certifyOffers(adapterWith(spyHttp())));
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
    const fields = (await certifyOffers(adapterWith(spyHttp()))).results[0].fieldPaths;
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
    const row = (await certifyOffers(adapterWith(spyHttp()))).results[0];
    for (const key of ["raw", "payload", "rows", "sample", "offers"]) {
      assert.equal(row[key], undefined, key);
    }
    const boom = Object.assign(new Error(`rejected ${TOKEN}`), {
      response: { status: 403, data: { error: `bad ${TOKEN} ${SECURITY_TOKEN}` } },
    });
    const failed = JSON.stringify(await certifyOffers(adapterWith(spyHttp(boom))));
    assert.ok(!failed.includes(TOKEN));
    assert.ok(!failed.includes(SECURITY_TOKEN));
  });
});

describe("the offers outcome vocabulary", () => {
  it("reports OK with a field dictionary when one row comes back", async () => {
    const row = (await certifyOffers(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.equal(row.schema, undefined);
  });

  it("reports OK_NO_ROWS with an unknown schema when the catalogue is empty", async () => {
    const row = (await certifyOffers(adapterWith(spyHttp(EMPTY_PAYLOAD)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("does not classify unsupported on an empty result", async () => {
    const result = await certifyOffers(adapterWith(spyHttp(EMPTY_PAYLOAD)));
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
      const row = (await certifyOffers(adapterWith(spyHttp(boom)))).results[0];
      assert.equal(row.ok, false, String(status));
      assert.equal(row.statusCategory, category, String(status));
      assert.equal(row.supplierStatusCode, status, String(status));
    }
  });

  it("carries no supplier status code on a successful empty result", async () => {
    const result = await certifyOffers(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    assert.equal(result.results[0].supplierStatusCode, undefined);
  });
});

describe("certification stays read-only and changes no sync behaviour", () => {
  it("performs no database read or write", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    const row = (await certifyOffers(adapterWith(spyHttp()))).results[0];
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

  it("leaves the sync job's offers run untouched", () => {
    const code = codeOf(SYNC_SRC);
    assert.match(code, /sourceObject: "offers"/);
    assert.match(code, /adapter\.fetchOffers\(\{\}, stats\)/);
  });

  it("touches neither commissioning_lists nor partnerships", async () => {
    const spy = spyHttp();
    await certifyOffers(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, "/v1/offers");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.commissioning_lists.path, "/v1/commissioninglists");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.partnerships.path, "/v1/partnerships");
  });

  it("adds no events, payment, coupon, deeplink or product path", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const absent of ["fetchProducts", "buildDeepLink", "fetchLinks"]) {
      assert.ok(!code.includes(absent), absent);
    }
    for (const present of ["fetchConversions", "fetchPayments", "fetchAdvancedReport", "fetchCoupons"]) {
      assert.ok(code.includes(present), present);
    }
  });
});
