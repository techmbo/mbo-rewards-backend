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
  createCjAdapter,
  extractCjAdvertisers,
  CJ_CERTIFICATION_MAX_ROWS,
  CJ_ADVERTISER_RELATIONSHIP_SCOPES,
} = await import("../src/adapters/cj.adapter.js");
const { NetworkCertificationService, listProbeSourceObjects, statusCategory } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/cj.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/cjSupplierSync.js", "utf8");

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const TOKEN = "zzcjtokenzz";
const CID = "zzcidzz";
const WEBSITE_ID = "zzwebsitezz";

/** One <advertiser> block in the real envelope, carrying a NOT-JOINED relationship. */
const AVAILABLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cj-api>
  <advertisers total-matched="1" records-returned="1" page-number="1">
    <advertiser>
      <advertiser-id>zzavailidzz</advertiser-id>
      <advertiser-name>zzavailnamezz</advertiser-name>
      <account-status>Active</account-status>
      <program-url>https://zzavailmerchantzz.example/program</program-url>
      <relationship-status>notjoined</relationship-status>
      <language>en</language>
      <seven-day-epc>98.76</seven-day-epc>
      <three-month-epc>54.32</three-month-epc>
      <mobile-tracking-certified>true</mobile-tracking-certified>
      <network-rank>7</network-rank>
      <performance-incentives>false</performance-incentives>
      <primary-category><parent>zzavailparentzz</parent><child>zzavailchildzz</child></primary-category>
      <actions>
        <action><id>zzactionidzz</id><name>zzactionnamezz</name><type>sale</type>
          <commission><default>12.5%</default></commission></action>
      </actions>
    </advertiser>
  </advertisers>
</cj-api>`;

/** The same envelope with no advertiser blocks. */
const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cj-api>
  <advertisers total-matched="0" records-returned="0" page-number="1"></advertisers>
</cj-api>`;

function spyHttp(xmlOrError = AVAILABLE_XML) {
  const calls = [];
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, ...config });
        if (xmlOrError instanceof Error) throw xmlOrError;
        return { data: xmlOrError };
      },
    },
  };
}

function adapterWith(spy) {
  return createCjAdapter({
    accessToken: TOKEN,
    requestorCid: CID,
    websiteId: WEBSITE_ID,
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
    cjCredentialResolver: async () => ({
      accessToken: TOKEN,
      requestorCid: CID,
      websiteId: WEBSITE_ID,
    }),
  });
}

async function certifyAvailable(adapter) {
  return serviceWith(adapter).certify("cj", { sourceObjects: ["available_advertisers"] });
}

describe("available_advertisers is its own source object", () => {
  it("is registered alongside advertisers, not instead of it", () => {
    assert.deepEqual(listProbeSourceObjects("cj").sort(), ["advertisers", "available_advertisers"]);
  });

  it("declares a read-only GET naming the notjoined scope", () => {
    assert.match(
      codeOf(SERVICE_SRC),
      /available_advertisers: \{\s*method: "GET",\s*endpointKey: "GET \/v2\/advertiser-lookup \(advertiser-ids=notjoined\)"/,
    );
  });

  it("reports its own endpoint, method and object", async () => {
    const row = (await certifyAvailable(adapterWith(spyHttp()))).results[0];
    assert.equal(row.endpointKey, "GET /v2/advertiser-lookup (advertiser-ids=notjoined)");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "available_advertisers");
  });

  it("runs on a chain of its own, not the joined one", () => {
    const code = codeOf(SERVICE_SRC);
    assert.match(code, /chain: "cjAvailableAdvertisers"/);
    assert.equal((code.match(/async certifyCjAvailableAdvertisers\(/g) ?? []).length, 1);
    assert.equal((code.match(/async certifyCjAdvertisers\(/g) ?? []).length, 1);
  });

  it("maps each source object to exactly one relationship scope", () => {
    assert.deepEqual({ ...CJ_ADVERTISER_RELATIONSHIP_SCOPES }, {
      advertisers: "joined",
      available_advertisers: "notjoined",
    });
    assert.ok(Object.isFrozen(CJ_ADVERTISER_RELATIONSHIP_SCOPES));
  });

  it("adds no catalog entry claiming it is live", () => {
    // The catalog is not part of this phase. available_advertisers is certified, not catalogued.
    assert.ok(!getSourceObject("cj", "available_advertisers"));
    // The joined object keeps its own catalog entry untouched.
    assert.equal(getSourceObject("cj", "advertisers")?.live, true);
  });
});

describe("the request is the official contract, one parameter apart from joined", () => {
  it("uses the Advertiser Lookup path", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({});
    assert.equal(spy.calls[0].path, "/v2/advertiser-lookup");
  });

  it("sends advertiser-ids=notjoined", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({});
    assert.equal(spy.calls[0].params["advertiser-ids"], "notjoined");
  });

  it("sends the configured requestor CID and page 1 at the evidenced page size", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({});
    assert.deepEqual(spy.calls[0].params, {
      "requestor-cid": CID,
      "advertiser-ids": "notjoined",
      "records-per-page": 100,
      "page-number": 1,
    });
  });

  it("stays at or under CJ's documented records-per-page maximum of 100", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({});
    const perPage = spy.calls[0].params["records-per-page"];
    assert.ok(perPage <= 100, `${perPage} exceeds the documented maximum`);
    assert.ok(perPage >= 25, `${perPage} is below the documented default, which production never sends`);
  });

  it("sends no website-id — that parameter belongs to Link Search", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({});
    const serialised = JSON.stringify(spy.calls[0]);
    assert.ok(!serialised.includes("website-id"));
    assert.ok(!serialised.includes(WEBSITE_ID));
  });

  it("differs from the joined request in the relationship scope and nothing else", async () => {
    const joinedSpy = spyHttp();
    await adapterWith(joinedSpy).fetchCertificationAdvertiserSample({});
    const availableSpy = spyHttp();
    await adapterWith(availableSpy).fetchCertificationAvailableAdvertiserSample({});

    assert.equal(joinedSpy.calls[0].path, availableSpy.calls[0].path);
    assert.equal(joinedSpy.calls[0].responseType, availableSpy.calls[0].responseType);

    const joined = { ...joinedSpy.calls[0].params };
    const available = { ...availableSpy.calls[0].params };
    assert.equal(joined["advertiser-ids"], "joined");
    assert.equal(available["advertiser-ids"], "notjoined");
    delete joined["advertiser-ids"];
    delete available["advertiser-ids"];
    assert.deepEqual(joined, available);
  });

  it("requests the XML as text, as the joined probe does", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({});
    assert.equal(spy.calls[0].responseType, "text");
  });

  it("applies the certification timeout", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({ timeoutMs: 4321 });
    assert.equal(spy.calls[0].timeout, 4321);
  });

  it("refuses to build the request with no configured CID", async () => {
    const spy = spyHttp();
    const adapter = createCjAdapter({
      accessToken: TOKEN,
      websiteId: WEBSITE_ID,
      httpClient: spy.client,
    });
    await assert.rejects(
      () => adapter.fetchCertificationAvailableAdvertiserSample({}),
      (error) => /requestor-cid/.test(error.message),
    );
    assert.equal(spy.calls.length, 0);
  });

  it("accepts no CID, advertiser id, page or scope from a caller", () => {
    const helper = codeOf(ADAPTER_SRC).slice(
      codeOf(ADAPTER_SRC).indexOf("async function advertiserLookupSample("),
    );
    const body = helper.slice(0, helper.indexOf("\n  }"));
    for (const leak of ["params[", "params.", "ctx.", "options.", "req."]) {
      assert.ok(!body.includes(leak), leak);
    }
    assert.match(body, /"requestor-cid": requestorCid,/);
  });
});

describe("exactly one bounded request, one row", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({});
    assert.equal(spy.calls.length, 1);
  });

  it("does not paginate even when the envelope reports far more rows", async () => {
    const many = AVAILABLE_XML.replace('total-matched="1"', 'total-matched="9999"');
    const spy = spyHttp(many);
    await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({});
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() =>
      adapterWith(spy).fetchCertificationAvailableAdvertiserSample({}),
    );
    assert.equal(spy.calls.length, 1);
  });

  it("does not route through the paginating or retrying helpers", () => {
    const code = codeOf(ADAPTER_SRC);
    const start = code.indexOf("async function advertiserLookupSample(");
    const body = code.slice(start, code.indexOf("\n  }", start));
    assert.ok(!body.includes("fetchPaged"));
    assert.ok(!body.includes("getXml"));
    assert.ok(!body.includes("requestWithRetry"));
    assert.ok(!/for\s*\(|while\s*\(/.test(body));
  });

  it("slices in the adapter even when the supplier returns a full page", async () => {
    const block = AVAILABLE_XML.slice(
      AVAILABLE_XML.indexOf("<advertiser>"),
      AVAILABLE_XML.indexOf("</advertiser>") + "</advertiser>".length,
    );
    const many = AVAILABLE_XML.replace(block, block.repeat(30));
    const spy = spyHttp(many);
    const rows = await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({});
    assert.equal(rows.length, 1);
    assert.equal(CJ_CERTIFICATION_MAX_ROWS, 1);
  });

  it("slices again in the service when an adapter hands back more than one row", async () => {
    const result = await certifyAvailable({
      fetchCertificationAvailableAdvertiserSample: async () => [
        { advertiser_id: "a" },
        { advertiser_id: "b" },
      ],
    });
    assert.equal(result.results[0].sampleCount, 1);
  });

  it("parses rows with production's own extractor, never the XML envelope", async () => {
    const spy = spyHttp();
    const rows = await adapterWith(spy).fetchCertificationAvailableAdvertiserSample({});
    assert.deepEqual(rows, extractCjAdvertisers(AVAILABLE_XML).slice(0, 1));

    const paths = (await certifyAvailable(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(!paths.some((p) => String(p).startsWith("cj-api")));
    assert.ok(!paths.some((p) => String(p).startsWith("advertisers")));
    assert.ok(paths.includes("advertiser_id"));
  });
});

describe("the available-advertisers outcome vocabulary", () => {
  it("reports OK with a field dictionary when one row comes back", async () => {
    const row = (await certifyAvailable(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.equal(row.schema, undefined);
  });

  it("reports OK_NO_ROWS when the catalogue comes back empty", async () => {
    const row = (await certifyAvailable(adapterWith(spyHttp(EMPTY_XML)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("names NO account-state blocker on an empty notjoined result", async () => {
    // This is the OPPOSITE judgement from the joined probe, on the same endpoint. An empty
    // notjoined result says the catalogue offered nothing outstanding — not that approvals are
    // missing.
    const result = await certifyAvailable(adapterWith(spyHttp(EMPTY_XML)));
    assert.equal(result.results[0].accountStateBlocker, undefined);
    assert.notEqual(result.results[0].statusCategory, "UNKNOWN_NEEDS_JOINED_CAMPAIGN");
    assert.ok(!JSON.stringify(result).includes("NO_JOINED_CAMPAIGNS"));
  });

  it("reports a 400 CID rejection as REQUEST_REJECTED, never as an account state", async () => {
    const rejected = Object.assign(new Error("bad request"), {
      response: {
        status: 400,
        data: { message: "User is not authorized to access this API on behalf of this CID" },
      },
    });
    const row = (await certifyAvailable(adapterWith(spyHttp(rejected)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(statusCategory(rejected), "REQUEST_REJECTED");
    // A broken credential must not be dressed up as an empty catalogue.
    assert.notEqual(row.statusCategory, "OK_NO_ROWS");
    assert.notEqual(row.statusCategory, "UNKNOWN_NEEDS_JOINED_CAMPAIGN");
    assert.equal(row.accountStateBlocker, undefined);
  });

  it("preserves the supplier status code on a rejection", async () => {
    const rejected = Object.assign(new Error("bad request"), { response: { status: 400 } });
    const row = (await certifyAvailable(adapterWith(spyHttp(rejected)))).results[0];
    assert.equal(row.supplierStatusCode, 400);
  });

  it("carries a safe supplier message without the CID in it", async () => {
    const rejected = Object.assign(new Error("bad request"), {
      response: {
        status: 400,
        data: { message: `User is not authorized to access this API on behalf of ${CID}` },
      },
    });
    const row = (await certifyAvailable(adapterWith(spyHttp(rejected)))).results[0];
    if (row.supplierMessage !== undefined) {
      assert.ok(!row.supplierMessage.includes(CID));
      assert.ok(row.supplierMessage.length <= 200);
    }
  });

  it("classifies an auth failure as AUTH_FAILED, distinct from a CID rejection", async () => {
    const boom = Object.assign(new Error("unauthorized"), { response: { status: 401 } });
    const row = (await certifyAvailable(adapterWith(spyHttp(boom)))).results[0];
    assert.equal(row.statusCategory, "AUTH_FAILED");
  });

  it("carries no supplier status code on a successful empty result", async () => {
    const result = await certifyAvailable(adapterWith(spyHttp(EMPTY_XML)));
    assert.equal(result.results[0].supplierStatusCode, undefined);
  });
});

describe("joined and not-joined stay separate", () => {
  it("certifies both in one run with one request each, keeping results apart", async () => {
    const spy = spyHttp();
    const result = await serviceWith(adapterWith(spy)).certify("cj", {
      sourceObjects: ["advertisers", "available_advertisers"],
    });
    assert.equal(spy.calls.length, 2);
    assert.deepEqual(
      spy.calls.map((c) => c.params["advertiser-ids"]).sort(),
      ["joined", "notjoined"],
    );
    assert.deepEqual(
      result.results.map((r) => r.sourceObject).sort(),
      ["advertisers", "available_advertisers"],
    );
  });

  it("gives the two OPPOSITE empty-result verdicts on the same response", async () => {
    const result = await serviceWith(adapterWith(spyHttp(EMPTY_XML))).certify("cj", {
      sourceObjects: ["advertisers", "available_advertisers"],
    });
    const joined = result.results.find((r) => r.sourceObject === "advertisers");
    const available = result.results.find((r) => r.sourceObject === "available_advertisers");

    assert.equal(joined.statusCategory, "UNKNOWN_NEEDS_JOINED_CAMPAIGN");
    assert.equal(joined.accountStateBlocker, "NO_JOINED_CAMPAIGNS");
    assert.equal(available.statusCategory, "OK_NO_ROWS");
    assert.equal(available.accountStateBlocker, undefined);
  });

  it("leaves the joined probe scoped to joined, unchanged", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationAdvertiserSample({});
    assert.equal(spy.calls[0].params["advertiser-ids"], "joined");
    assert.match(codeOf(ADAPTER_SRC), /async fetchCertificationAdvertiserSample\(\{ timeoutMs \} = \{\}\)/);
  });

  it("leaves production sync scoped to joined on all three of its objects", () => {
    const code = codeOf(SYNC_SRC);
    assert.equal((code.match(/"advertiser-ids": "joined"/g) ?? []).length, 3);
    assert.ok(!code.includes("notjoined"));
  });

  it("introduces notjoined nowhere in production sync or the joined chain", () => {
    const joinedChain = codeOf(SERVICE_SRC).slice(
      codeOf(SERVICE_SRC).indexOf("async certifyCjAdvertisers("),
      codeOf(SERVICE_SRC).indexOf("async certifyCjAvailableAdvertisers("),
    );
    assert.ok(!joinedChain.includes("notjoined"));
    assert.ok(!joinedChain.includes("available_advertisers"));
  });
});

describe("no advertiser value reaches the result", () => {
  it("returns no ids, names, URLs, categories, EPCs or commission values", async () => {
    const result = await certifyAvailable(adapterWith(spyHttp()));
    const serialised = JSON.stringify(result);
    for (const secret of [
      "zzavailidzz",
      "zzavailnamezz",
      "zzavailmerchantzz",
      "zzavailparentzz",
      "zzavailchildzz",
      "zzactionidzz",
      "zzactionnamezz",
      "98.76",
      "54.32",
      "12.5%",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("reports the relationship-status field PATH without its value", async () => {
    const result = await certifyAvailable(adapterWith(spyHttp()));
    const paths = result.results[0].fieldPaths.map((f) => f.path);
    assert.ok(paths.includes("relationship_status"));
    assert.ok(!JSON.stringify(result.results[0].fieldPaths).includes("notjoined"));
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
    const fields = (await certifyAvailable(adapterWith(spyHttp()))).results[0].fieldPaths;
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

  it("never returns raw XML or the access token", async () => {
    const boom = Object.assign(new Error(`rejected ${TOKEN}`), {
      response: { status: 403, data: { error: `bad token ${TOKEN}` } },
    });
    const failed = JSON.stringify(await certifyAvailable(adapterWith(spyHttp(boom))));
    assert.ok(!failed.includes(TOKEN));

    const ok = JSON.stringify(await certifyAvailable(adapterWith(spyHttp())));
    assert.ok(!ok.includes("<advertiser"));
    assert.ok(!ok.includes("cj-api"));
  });

  it("never returns the raw payload", async () => {
    const row = (await certifyAvailable(adapterWith(spyHttp()))).results[0];
    for (const key of ["raw", "payload", "rows", "sample", "xml"]) {
      assert.equal(row[key], undefined, key);
    }
  });
});

describe("certification stays read-only and touches nothing else", () => {
  it("performs no database read or write", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    const row = (await certifyAvailable(adapterWith(spyHttp()))).results[0];
    assert.equal(row.statusCategory, "OK");
  });

  it("writes nothing and triggers no sync", () => {
    const code = codeOf(SERVICE_SRC);
    const chain = code.slice(
      code.indexOf("async certifyCjAvailableAdvertisers("),
      code.indexOf("async certifyAwinCommissionGroups("),
    );
    for (const write of ["upsert", "create", "update", "delete", "upsertManyRawEntities"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("adds no probe for links, coupons or the GraphQL-gated objects", () => {
    for (const absent of ["links", "coupons", "program_terms", "products", "commission_detail"]) {
      assert.ok(!listProbeSourceObjects("cj").includes(absent), absent);
    }
  });

  it("changes no link, coupon or deeplink behaviour", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /path: "\/v2\/link-search"/);
    assert.match(code, /"promotion-type": params\["promotion-type"\] \?\? "coupon"/);
    assert.ok(!code.includes("buildDeepLink"));
  });

  it("leaves other suppliers' probe sets alone", () => {
    for (const network of ["optimise", "partnerize", "awin", "admitad"]) {
      assert.ok(listProbeSourceObjects(network).length > 0, network);
      assert.ok(!listProbeSourceObjects(network).includes("available_advertisers"), network);
    }
  });
});
