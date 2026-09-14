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
 * One partnership row in the real envelope shape.
 *
 * Every value is distinctive so a leak is detectable. The row deliberately carries the shapes this
 * probe exists to DISCOVER — a relationship/approval state and an advertiser reference — as well
 * as the shapes it must never emit: names, URLs and commission terms.
 *
 * This fixture is a plausible shape, NOT a claim about Rakuten's real contract. What the live row
 * actually contains is precisely the open question; nothing here maps any of it.
 */
const PARTNERSHIP_PAYLOAD = {
  partnerships: [
    {
      id: 445566,
      advertiser_id: 665544,
      advertiser_name: "zzadvnamezz",
      status: "zzstatusvaluezz",
      partnership_status: "zzpartnerstatevaluezz",
      offer_id: 778899,
      applied_date: "2026-01-15",
      approved_date: "2026-01-20",
      relationship: "zzrelationshipvaluezz",
      terms: { commission: "10% of sale", currency: "AED" },
      url: "https://zzpartnermerchantzz.example",
    },
  ],
  _metadata: { page: 1, limit: 1, total: 1 },
};

/** The same envelope with no rows: an account that has joined nothing. */
const EMPTY_PAYLOAD = { partnerships: [], _metadata: { page: 1, limit: 1, total: 0 } };

function spyHttp(dataOrError = PARTNERSHIP_PAYLOAD) {
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

async function certifyPartnerships(adapter) {
  return serviceWith(adapter).certify("rakuten", { sourceObjects: ["partnerships"] });
}

describe("partnerships is registered as a Rakuten source object", () => {
  it("is listed alongside advertisers and commissioning_lists", () => {
    assert.deepEqual(listProbeSourceObjects("rakuten").sort(), [
      "advertisers",
      "commissioning_lists",
      "coupons",
      "links",
      "offers",
      "partnerships",
    ]);
  });

  it("declares a read-only GET with its bounds in the endpointKey", () => {
    assert.match(
      codeOf(SERVICE_SRC),
      /partnerships: \{\s*method: "GET",\s*endpointKey: "GET \/v1\/partnerships \(limit=1, page=1\)"/,
    );
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.partnerships.method, "GET");
  });

  it("reports its own endpoint, method and object", async () => {
    const row = (await certifyPartnerships(adapterWith(spyHttp()))).results[0];
    assert.equal(row.endpointKey, "GET /v1/partnerships (limit=1, page=1)");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "partnerships");
  });

  it("shares the one bounded chain rather than adding a second", () => {
    const code = codeOf(SERVICE_SRC);
    assert.equal(
      (code.match(/chain: "rakutenSample"/g) ?? []).length,
      listProbeSourceObjects("rakuten").length,
    );
    assert.equal((code.match(/async certifyRakutenSample\(/g) ?? []).length, 1);
  });

  it("is catalogued live and stays that way", () => {
    assert.equal(getSourceObject("rakuten", "partnerships")?.live, true);
    assert.equal(getSourceObject("rakuten", "partnerships")?.endpoint, "GET /v1/partnerships");
  });

  it("adds no probe for the objects this phase still defers", () => {
    for (const notYet of ["events", "advanced_reports", "payments", "products"]) {
      assert.ok(!listProbeSourceObjects("rakuten").includes(notYet), notYet);
      assert.ok(!Object.hasOwn(RAKUTEN_CERTIFICATION_SPECS, notYet), notYet);
    }
  });
});

describe("the partnerships request is exactly one bounded GET", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("partnerships", { timeoutMs: 5000 });
    assert.equal(spy.calls.length, 1);
  });

  it("uses the production path", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("partnerships", {});
    assert.equal(spy.calls[0].path, "/v1/partnerships");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.partnerships.path, "/v1/partnerships");
  });

  it("matches the only path production's fetchPartnerships builds", () => {
    assert.match(
      codeOf(ADAPTER_SRC),
      /fetchPagedJson\("\/v1\/partnerships", params, \["partnerships", "partnership"\]/,
    );
  });

  it("sends limit=1 and page=1 and nothing else", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("partnerships", {});
    assert.deepEqual(spy.calls[0].config.params, { limit: 1, page: 1 });
    assert.deepEqual(Object.keys(spy.calls[0].config.params).sort(), ["limit", "page"]);
  });

  it("uses the same parameter vocabulary production's pager sends on this path", () => {
    // limit=1 page=1 is NOT itself a request production has been observed making here — unlike
    // advertisers, where authenticate() issues exactly that. What is evidenced is the parameter
    // vocabulary and that the bounds sit inside production's own maxLimit.
    const production = codeOf(ADAPTER_SRC).split("async function fetchPagedJson")[1];
    assert.match(production, /params\?\.limit/);
    assert.match(production, /params\?\.page/);
    assert.match(
      codeOf(ADAPTER_SRC),
      /fetchPagedJson\("\/v1\/partnerships", params, \["partnerships", "partnership"\], stats, \{ maxLimit: 200 \}\)/,
    );
    assert.ok(RAKUTEN_CERTIFICATION_PAGE_PARAMS.limit <= 200);
  });

  it("shares the frozen page bounds with the advertisers probe", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("partnerships", {});
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_PAGE_PARAMS }, { limit: 1, page: 1 });
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_PAGE_PARAMS));
    assert.notEqual(spy.calls[0].config.params, RAKUTEN_CERTIFICATION_PAGE_PARAMS);
  });

  it("applies the certification timeout", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("partnerships", { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("does not paginate even when the envelope reports far more rows", async () => {
    const spy = spyHttp({
      partnerships: PARTNERSHIP_PAYLOAD.partnerships,
      _metadata: { page: 1, limit: 1, total: 9999 },
    });
    await adapterWith(spy).fetchCertificationSample("partnerships", {});
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() => adapterWith(spy).fetchCertificationSample("partnerships", {}));
    assert.equal(spy.calls.length, 1);
  });

  it("makes exactly one request for a full partnerships run", async () => {
    const spy = spyHttp();
    await certifyPartnerships(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("makes one request per object when both are certified together", async () => {
    const spy = spyHttp();
    const result = await serviceWith(adapterWith(spy)).certify("rakuten", {
      sourceObjects: ["advertisers", "partnerships"],
    });
    assert.equal(spy.calls.length, 2);
    assert.deepEqual(spy.calls.map((c) => c.path).sort(), ["/v1/partnerships", "/v2/advertisers"]);
    assert.equal(result.results.length, 2);
  });

  it("needs no web security token and touches no Advanced Reports path", async () => {
    const spy = spyHttp();
    const bearerOnly = createRakutenAdapter({ accessToken: TOKEN, httpClient: spy.client });
    const rows = await bearerOnly.fetchCertificationSample("partnerships", {});
    assert.equal(rows.length, 1);
    const serialised = JSON.stringify(spy.calls[0]);
    assert.ok(!serialised.includes("advancedreports"));
    assert.ok(!serialised.includes(SECURITY_TOKEN));
  });
});

describe("the sample is bounded to one partnership row, twice and independently", () => {
  it("slices in the adapter even when the supplier ignores limit=1", async () => {
    const many = { partnerships: [...Array(40)].map((_, i) => ({ id: i, status: `zz${i}zz` })) };
    const spy = spyHttp(many);
    assert.equal((await adapterWith(spy).fetchCertificationSample("partnerships", {})).length, 1);
    assert.equal(RAKUTEN_CERTIFICATION_MAX_ROWS, 1);
  });

  it("slices again in the service when an adapter hands back more than one row", async () => {
    const result = await certifyPartnerships({
      fetchCertificationSample: async () => [{ id: 1 }, { id: 2 }],
    });
    assert.equal(result.results[0].sampleCount, 1);
  });

  it("uses production's own extractor and container keys", async () => {
    const spy = spyHttp();
    const rows = await adapterWith(spy).fetchCertificationSample("partnerships", {});
    assert.deepEqual(
      rows,
      extractRakutenCollection(PARTNERSHIP_PAYLOAD, ["partnerships", "partnership"]).slice(0, 1),
    );
    assert.deepEqual([...RAKUTEN_CERTIFICATION_SPECS.partnerships.collectionKeys], [
      "partnerships",
      "partnership",
    ]);
  });

  it("certifies a row and never the envelope", async () => {
    const paths = (await certifyPartnerships(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(!paths.some((p) => String(p).startsWith("partnerships")));
    assert.ok(!paths.some((p) => String(p).startsWith("_metadata")));
    assert.ok(paths.includes("id"));
  });
});

describe("the partnerships outcome vocabulary", () => {
  it("reports OK with a field dictionary when one row comes back", async () => {
    const row = (await certifyPartnerships(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.equal(row.schema, undefined);
  });

  it("reports OK_NO_ROWS with an unknown schema when the account has joined nothing", async () => {
    const row = (await certifyPartnerships(adapterWith(spyHttp(EMPTY_PAYLOAD)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("claims neither unsupported nor an API defect on an empty result", async () => {
    // No partnerships is the expected shape of an account with no joined campaigns. Reading
    // "unsupported" or "broken endpoint" out of that absence would be inventing a finding.
    const result = await certifyPartnerships(adapterWith(spyHttp(EMPTY_PAYLOAD)));
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

  it("preserves a safe supplier status on an auth failure", async () => {
    const boom = Object.assign(new Error("unauthorized"), { response: { status: 401 } });
    const row = (await certifyPartnerships(adapterWith(spyHttp(boom)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.equal(row.supplierStatusCode, 401);
  });

  it("reports a supplier failure as a failure, not as an empty account", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const row = (await certifyPartnerships(adapterWith(spyHttp(boom)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "UPSTREAM_ERROR");
    assert.notEqual(row.statusCategory, "OK_NO_ROWS");
  });

  it("carries no supplier status code on a successful empty result", async () => {
    const result = await certifyPartnerships(adapterWith(spyHttp(EMPTY_PAYLOAD)));
    assert.equal(result.results[0].supplierStatusCode, undefined);
  });

  it("reaches the same verdicts as advertisers for the same responses", async () => {
    for (const [payload, expected] of [
      [PARTNERSHIP_PAYLOAD, "OK"],
      [EMPTY_PAYLOAD, "OK_NO_ROWS"],
    ]) {
      const both = await serviceWith(adapterWith(spyHttp(payload))).certify("rakuten", {
        sourceObjects: ["advertisers", "partnerships"],
      });
      for (const row of both.results) {
        assert.equal(row.statusCategory, expected, `${row.sourceObject} ${expected}`);
        assert.equal(row.accountStateBlocker, undefined, row.sourceObject);
      }
    }
  });
});

describe("relationship state is DISCOVERED as paths, never as values", () => {
  it("reports the relationship, approval and advertiser-reference field PATHS", async () => {
    // This is what the probe exists for: learning whether Rakuten exposes join state at all.
    const paths = (await certifyPartnerships(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const expected of [
      "status",
      "partnership_status",
      "relationship",
      "advertiser_id",
      "applied_date",
      "approved_date",
    ]) {
      assert.ok(paths.includes(expected), expected);
    }
  });

  it("returns no status VALUE, no id and no name", async () => {
    const result = await certifyPartnerships(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const secret of [
      // Distinctive markers, not realistic words: "approved" as a VALUE is indistinguishable from
      // "approved_date" as a PATH by substring, and the path is one this probe must report.
      "zzstatusvaluezz",
      "zzpartnerstatevaluezz",
      "zzrelationshipvaluezz",
      "zzadvnamezz",
      "zzpartnermerchantzz",
      "445566",
      "665544",
      "778899",
      "10% of sale",
      "AED",
      "2026-01-15",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("maps nothing to a canonical relationship vocabulary", async () => {
    // Discovery only. No JOINED/PENDING/NOT_JOINED mapping is invented from a field name.
    const result = await certifyPartnerships(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const canonical of ["JOINED", "PENDING", "NOT_JOINED", "REJECTED", "SUSPENDED"]) {
      assert.ok(!serialised.includes(canonical), canonical);
    }
    const chain = codeOf(SERVICE_SRC).slice(
      codeOf(SERVICE_SRC).indexOf("async certifyRakutenSample("),
    );
    const body = chain.slice(0, chain.indexOf("\n  }"));
    for (const mapping of ["relationshipStatus", "mapRelationship", "JOINED"]) {
      assert.ok(!body.includes(mapping), mapping);
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
    const fields = (await certifyPartnerships(adapterWith(spyHttp()))).results[0].fieldPaths;
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

  it("reports the nested commission-term PATH without its value", async () => {
    const result = await certifyPartnerships(adapterWith(spyHttp()));
    const paths = result.results[0].fieldPaths.map((f) => f.path);
    assert.ok(paths.includes("terms.commission"));
    assert.ok(!JSON.stringify(result.results[0].fieldPaths).includes("10% of sale"));
  });

  it("never returns the raw payload or either credential", async () => {
    const row = (await certifyPartnerships(adapterWith(spyHttp()))).results[0];
    for (const key of ["raw", "payload", "rows", "sample", "partnerships"]) {
      assert.equal(row[key], undefined, key);
    }
    const boom = Object.assign(new Error(`rejected ${TOKEN}`), {
      response: { status: 403, data: { error: `bad ${TOKEN} ${SECURITY_TOKEN}` } },
    });
    const failed = JSON.stringify(await certifyPartnerships(adapterWith(spyHttp(boom))));
    assert.ok(!failed.includes(TOKEN));
    assert.ok(!failed.includes(SECURITY_TOKEN));
  });
});

describe("certification stays read-only and changes no sync behaviour", () => {
  it("performs no database read or write", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    const row = (await certifyPartnerships(adapterWith(spyHttp()))).results[0];
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

  it("leaves the production partnerships fetcher paginating", () => {
    const production = codeOf(ADAPTER_SRC)
      .split("async fetchPartnerships")[1]
      .split("async fetchOffers")[0];
    assert.ok(production.includes("fetchPagedJson"));
  });

  it("leaves the sync job's partnerships run untouched", () => {
    const code = codeOf(SYNC_SRC);
    assert.match(code, /sourceObject: "partnerships"/);
    assert.match(code, /adapter\.fetchPartnerships\(\{\}, stats\)/);
  });

  it("adds no offers, events, payment or asset path", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const absent of ["fetchProducts", "buildDeepLink", "fetchLinks"]) {
      assert.ok(!code.includes(absent), absent);
    }
    // The deferred fetchers still exist untouched; they simply have no probe.
    for (const present of ["fetchOffers", "fetchCommissioningLists", "fetchPayments", "fetchCoupons"]) {
      assert.ok(code.includes(present), present);
      // The METHOD name is never a source object name; probes are named by object.
      assert.ok(!listProbeSourceObjects("rakuten").includes(present), present);
    }
  });
});
