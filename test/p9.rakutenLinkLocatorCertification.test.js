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
  extractRakutenTextLinks,
  RAKUTEN_CERTIFICATION_MAX_ROWS,
  RAKUTEN_CERTIFICATION_PAGE_PARAMS,
  RAKUTEN_CERTIFICATION_SPECS,
  RAKUTEN_TEXT_LINKS_PATH,
} = await import("../src/adapters/rakuten.adapter.js");
const { NetworkCertificationService, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");
const { decodeXml, tagBlocks, tagText } = await import("../src/core/xml.js");

const ADAPTER_SRC = readFileSync("src/adapters/rakuten.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const CJ_SRC = readFileSync("src/adapters/cj.adapter.js", "utf8");

/**
 * Comments are prose; an assertion that matches one proves nothing about behaviour.
 *
 * A single pass tracking BOTH comment state and string state. This adapter needs it: getCsv sends
 * `Accept: "text/csv,text/plain,*\/*"`, whose `/*` opens a comment span in a naive regex stripper
 * and swallows everything to the next `*\/`.
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

/** One <return> row inside the documented envelope. Field NAMES real, every VALUE distinctive. */
const ONE_LINK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<getTextLinksResponse>
  <return>
    <campaignID>zzcampaignidzz</campaignID>
    <categoryID>zzcategoryidzz</categoryID>
    <categoryName>zzcategorynamezz</categoryName>
    <linkID>zzlinkidzz</linkID>
    <linkName>zzlinknamezz</linkName>
    <mid>zzmidvaluezz</mid>
    <nid>zznidvaluezz</nid>
    <clickURL>https://click.linksynergy.com/zzclickzz</clickURL>
    <endDate>2026-12-31</endDate>
    <landURL>https://zzlandzz.example/page</landURL>
    <showURL>https://zzshowzz.example/impression</showURL>
    <startDate>2026-01-01</startDate>
    <textDisplay>zztextdisplayzz</textDisplay>
  </return>
</getTextLinksResponse>`;

/** Two <return> rows, to prove repeated rows parse and that only one is kept. */
const TWO_LINKS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<getTextLinksResponse>
  <return><linkID>zzfirstlinkzz</linkID><clickURL>https://click.example/zzfirstzz</clickURL></return>
  <return><linkID>zzsecondlinkzz</linkID><clickURL>https://click.example/zzsecondzz</clickURL></return>
</getTextLinksResponse>`;

/** The documented envelope with no rows at all. */
const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<getTextLinksResponse></getTextLinksResponse>`;

function spyHttp(dataOrError = ONE_LINK_XML) {
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

async function certifyLinks(adapter) {
  return serviceWith(adapter).certify("rakuten", { sourceObjects: ["links"] });
}

describe("the documented Link Locator path is used exactly", () => {
  it("is the documented getTextLinks operation at its documented defaults", () => {
    assert.equal(RAKUTEN_TEXT_LINKS_PATH, "/linklocator/1.0/getTextLinks/-1/-1///-1/1");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.links.path, RAKUTEN_TEXT_LINKS_PATH);
  });

  it("carries the six documented segments in order, with both date slots BLANK", () => {
    const segments = RAKUTEN_TEXT_LINKS_PATH.split("/getTextLinks/")[1].split("/");
    assert.deepEqual(segments, ["-1", "-1", "", "", "-1", "1"]);

    const [advertiserId, categoryId, startDate, endDate, deprecatedCampaignId, page] = segments;
    assert.equal(advertiserId, "-1", "advertiser-id");
    assert.equal(categoryId, "-1", "category-id");
    assert.equal(startDate, "", "link-start-date must be blank");
    assert.equal(endDate, "", "link-end-date must be blank");
    assert.equal(deprecatedCampaignId, "-1", "DEPRECATED-campaign-id");
    assert.equal(page, "1", "page");
  });

  it("keeps the adjacent separators that the two blank slots produce", () => {
    // Collapsing "///" would shift every later segment: the deprecated campaign id would land in
    // the start-date slot and the page in the end-date slot.
    assert.ok(RAKUTEN_TEXT_LINKS_PATH.includes("/-1/-1///-1/1"));
    assert.equal(RAKUTEN_TEXT_LINKS_PATH.split("/getTextLinks/")[1].split("/").length, 6);
  });

  it("sends that path verbatim", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("links", {});
    assert.equal(spy.calls[0].path, "/linklocator/1.0/getTextLinks/-1/-1///-1/1");
  });

  it("sends NO query parameters at all", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("links", {});
    assert.deepEqual(spy.calls[0].config.params, {});
  });

  it("invents no results-per-page bound, because Rakuten documents none", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("links", {});
    const serialised = JSON.stringify(spy.calls[0].config.params);
    for (const invented of ["limit", "page", "results", "per_page", "records"]) {
      assert.ok(!serialised.includes(invented), invented);
    }
    // The JSON objects' page bounds exist but are deliberately not applied here.
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_PAGE_PARAMS }, { limit: 1, page: 1 });
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.links.pathBounded, true);
  });

  it("requests XML as text", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("links", {});
    assert.equal(spy.calls[0].config.responseType, "text");
    assert.match(spy.calls[0].config.headers.Accept, /xml/);
  });

  it("leaves the JSON objects sending their page bounds and JSON Accept", async () => {
    const spy = spyHttp({ advertisers: [{ id: 1 }] });
    await adapterWith(spy).fetchCertificationSample("advertisers", {});
    assert.deepEqual(spy.calls[0].config.params, { limit: 1, page: 1 });
    assert.equal(spy.calls[0].config.headers.Accept, "application/json");
    assert.equal(spy.calls[0].config.responseType, undefined);
  });

  it("uses the Bearer only — no web security token", async () => {
    const spy = spyHttp();
    const bearerOnly = createRakutenAdapter({ accessToken: TOKEN, httpClient: spy.client });
    assert.equal((await bearerOnly.fetchCertificationSample("links", {})).length, 1);
    assert.ok(!JSON.stringify(spy.calls[0]).includes(SECURITY_TOKEN));
    assert.ok(!JSON.stringify(spy.calls[0]).includes("advancedreports"));
  });
});

describe("exactly one request, no retry, no pagination", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("links", { timeoutMs: 5000 });
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() => adapterWith(spy).fetchCertificationSample("links", {}));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request a second page even when the response is full", async () => {
    const many = `<getTextLinksResponse>${"<return><linkID>zzxzz</linkID></return>".repeat(50)}</getTextLinksResponse>`;
    const spy = spyHttp(many);
    await adapterWith(spy).fetchCertificationSample("links", {});
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, RAKUTEN_TEXT_LINKS_PATH);
  });

  it("makes exactly one request for a full certification run", async () => {
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("applies the certification timeout", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCertificationSample("links", { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("does not route through the retrying or paginating helpers", () => {
    const code = codeOf(ADAPTER_SRC);
    const start = code.indexOf("async fetchCertificationSample(");
    const body = code.slice(start, code.indexOf("async fetchAdvertisers", start));
    assert.ok(!body.includes("requestWithRetry"));
    assert.ok(!body.includes("fetchPagedJson"));
    assert.equal((body.match(/httpClient\.get\(/g) ?? []).length, 1);
  });
});

describe("the envelope is never mistaken for a row", () => {
  it("parses one <return> block as one row", () => {
    const rows = extractRakutenTextLinks(ONE_LINK_XML);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].linkID, "zzlinkidzz");
  });

  it("parses repeated <return> rows correctly", () => {
    const rows = extractRakutenTextLinks(TWO_LINKS_XML);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].linkID, "zzfirstlinkzz");
    assert.equal(rows[1].linkID, "zzsecondlinkzz");
  });

  it("yields NO rows from an envelope with no <return>", () => {
    assert.deepEqual(extractRakutenTextLinks(EMPTY_XML), []);
    // Not one empty row: an absent row and a blank row are different findings.
    assert.equal(extractRakutenTextLinks(EMPTY_XML).length, 0);
  });

  it("never reports a getTextLinksResponse path", async () => {
    const paths = (await certifyLinks(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(!paths.some((p) => String(p).includes("getTextLinksResponse")));
    assert.ok(!paths.some((p) => String(p).startsWith("return")));
    assert.ok(paths.includes("linkID"));
  });

  it("reports the documented row fields as paths", async () => {
    const paths = (await certifyLinks(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const field of [
      "campaignID",
      "categoryID",
      "categoryName",
      "linkID",
      "linkName",
      "mid",
      "nid",
      "clickURL",
      "endDate",
      "landURL",
      "showURL",
      "startDate",
      "textDisplay",
    ]) {
      assert.ok(paths.includes(field), field);
    }
  });
});

describe("the local one-row bound", () => {
  it("keeps one row when the supplier returns two", async () => {
    const spy = spyHttp(TWO_LINKS_XML);
    const rows = await adapterWith(spy).fetchCertificationSample("links", {});
    assert.equal(rows.length, 1);
    assert.equal(RAKUTEN_CERTIFICATION_MAX_ROWS, 1);
  });

  it("keeps one row when the supplier returns fifty", async () => {
    const many = `<getTextLinksResponse>${"<return><linkID>zzxzz</linkID></return>".repeat(50)}</getTextLinksResponse>`;
    const spy = spyHttp(many);
    assert.equal((await adapterWith(spy).fetchCertificationSample("links", {})).length, 1);
  });

  it("bounds again in the service when an adapter hands back more than one row", async () => {
    const result = await certifyLinks({
      fetchCertificationSample: async () => [{ linkID: "a" }, { linkID: "b" }],
    });
    assert.equal(result.results[0].sampleCount, 1);
  });

  it("bounds ROWS KEPT, never rows requested", () => {
    // The request carries no bound at all; the cap is entirely local.
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.links.pathBounded, true);
    assert.ok(!RAKUTEN_TEXT_LINKS_PATH.includes("limit"));
  });
});

describe("a discovered link asset is NOT a usable tracking link", () => {
  it("never returns the clickURL, landURL or showURL value", async () => {
    const serialised = JSON.stringify(await certifyLinks(adapterWith(spyHttp())));
    for (const secret of [
      "zzclickzz",
      "zzlandzz",
      "zzshowzz",
      "click.linksynergy.com",
      "https://",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns link, advertiser or creative values", async () => {
    const serialised = JSON.stringify(await certifyLinks(adapterWith(spyHttp())));
    for (const secret of [
      "zzlinkidzz",
      "zzlinknamezz",
      "zzmidvaluezz",
      "zznidvaluezz",
      "zzcampaignidzz",
      "zzcategoryidzz",
      "zzcategorynamezz",
      "zztextdisplayzz",
      "2026-01-01",
      "2026-12-31",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("does not classify a row as a usable tracking link", async () => {
    const serialised = JSON.stringify(await certifyLinks(adapterWith(spyHttp())));
    for (const claim of [
      "TRACKING_LINK_USABLE",
      "trackingLink",
      "TrackingLink",
      "usableTrackingLink",
      "deepLink",
    ]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });

  it("persists no canonical tracking link and fabricates no URL", () => {
    const code = codeOf(SERVICE_SRC);
    const chain = code.slice(
      code.indexOf("async certifyRakutenSample("),
      code.indexOf("async certifyAwinCommissionGroups("),
    );
    for (const forbidden of ["TrackingLink", "upsert", "delete", "clickURL"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
    // A fabricated URL specifically — not the bare substring "http", which legitimately occurs in
    // the httpMethod field every certification result carries.
    assert.ok(!/https?:\/\//.test(chain));
    const adapterCode = codeOf(ADAPTER_SRC);
    for (const forbidden of ["buildDeepLink", "generateDeepLink", "createTrackingLink"]) {
      assert.ok(!adapterCode.includes(forbidden), forbidden);
    }
  });

  it("leaves the links catalog entry NOT live: a read path is not a link capability", () => {
    // Network support is not implementation support. Discovery does not make a link usable.
    assert.equal(getSourceObject("rakuten", "links")?.live, false);
    assert.equal(getSourceObject("rakuten", "links")?.endpoint, "Link Locator / Deep Link");
  });

  it("declares no DEEP_LINK capability for Rakuten", async () => {
    const { SUPPLIER_CAPABILITY_CATALOG } = await import("../src/adapters/registry.js");
    const declared = adapterWith(spyHttp()).getCapabilities().capabilities;
    assert.ok(!declared.includes("DEEP_LINK"));
    assert.ok(!SUPPLIER_CAPABILITY_CATALOG.RAKUTEN.capabilities.includes("DEEP_LINK"));
  });
});

describe("the links outcome vocabulary", () => {
  it("is registered with its own endpointKey", async () => {
    assert.ok(listProbeSourceObjects("rakuten").includes("links"));
    const row = (await certifyLinks(adapterWith(spyHttp()))).results[0];
    assert.equal(row.endpointKey, "GET /linklocator/1.0/getTextLinks/-1/-1///-1/1");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "links");
  });

  it("reports OK with a field dictionary when a row is parsed", async () => {
    const row = (await certifyLinks(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
    assert.equal(row.schema, undefined);
  });

  it("reports OK_NO_ROWS with an unknown schema when the envelope is empty", async () => {
    const row = (await certifyLinks(adapterWith(spyHttp(EMPTY_XML)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.sampleCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("does NOT invent a partnership blocker from an empty result", async () => {
    // Rakuten does block link USE until a partnership is active, but nothing in this repo
    // establishes WHICH response proves that. Emptiness is not that proof.
    const result = await certifyLinks(adapterWith(spyHttp(EMPTY_XML)));
    const serialised = JSON.stringify(result);
    for (const invented of [
      "NEEDS_ACTIVE_PARTNERSHIP",
      "accountStateBlocker",
      "NO_JOINED_CAMPAIGNS",
      "UNKNOWN_NEEDS_JOINED_CAMPAIGN",
    ]) {
      assert.ok(!serialised.includes(invented), invented);
    }
    assert.equal(result.results[0].accountStateBlocker, undefined);
  });

  it("does not classify unsupported on an empty result", async () => {
    const serialised = JSON.stringify(await certifyLinks(adapterWith(spyHttp(EMPTY_XML))));
    for (const wrong of ["NOT_SUPPORTED", "UNAVAILABLE", "NO_ENDPOINT", "UPSTREAM_ERROR"]) {
      assert.ok(!serialised.includes(wrong), wrong);
    }
  });

  it("preserves a safe supplier status on failure", async () => {
    for (const [status, category] of [
      [401, "AUTH_FAILED"],
      [403, "AUTH_FAILED"],
      [400, "REQUEST_REJECTED"],
      [500, "UPSTREAM_ERROR"],
    ]) {
      const boom = Object.assign(new Error("failed"), { response: { status } });
      const row = (await certifyLinks(adapterWith(spyHttp(boom)))).results[0];
      assert.equal(row.ok, false, String(status));
      assert.equal(row.statusCategory, category, String(status));
      assert.equal(row.supplierStatusCode, status, String(status));
    }
  });

  it("never returns raw XML or either credential", async () => {
    const ok = JSON.stringify(await certifyLinks(adapterWith(spyHttp())));
    assert.ok(!ok.includes("<return>"));
    assert.ok(!ok.includes("getTextLinksResponse"));
    assert.ok(!ok.includes("<?xml"));

    const boom = Object.assign(new Error(`rejected ${TOKEN}`), {
      response: { status: 403, data: `<error>${TOKEN} ${SECURITY_TOKEN}</error>` },
    });
    const failed = JSON.stringify(await certifyLinks(adapterWith(spyHttp(boom))));
    assert.ok(!failed.includes(TOKEN));
    assert.ok(!failed.includes(SECURITY_TOKEN));
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
    const fields = (await certifyLinks(adapterWith(spyHttp()))).results[0].fieldPaths;
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
});

describe("the shared XML utility, and CJ unchanged by the move", () => {
  it("exists as one shared module rather than a second ad-hoc parser", () => {
    assert.equal(typeof decodeXml, "function");
    assert.equal(typeof tagBlocks, "function");
    assert.equal(typeof tagText, "function");
  });

  it("is imported by both XML adapters, and defined in neither", () => {
    for (const [label, src] of [["cj", CJ_SRC], ["rakuten", ADAPTER_SRC]]) {
      assert.match(codeOf(src), /from "\.\.\/core\/xml\.js"/, label);
      assert.ok(!codeOf(src).includes("function tagBlocks("), `${label} redefines tagBlocks`);
      assert.ok(!codeOf(src).includes("function tagText("), `${label} redefines tagText`);
      assert.ok(!codeOf(src).includes("function decodeXml("), `${label} redefines decodeXml`);
    }
  });

  it("decodes entities and CDATA exactly as CJ always did", () => {
    assert.equal(decodeXml("<![CDATA[raw & text]]>"), "raw & text");
    assert.equal(decodeXml("&lt;b&gt;"), "<b>");
    assert.equal(decodeXml("&quot;q&quot; &apos;a&apos;"), `"q" 'a'`);
    // &amp; is decoded LAST, so an escaped entity survives as literal text.
    assert.equal(decodeXml("&amp;lt;"), "&lt;");
  });

  it("treats an empty element and the literal null as absent, as CJ always did", () => {
    assert.equal(tagText("<a></a>", "a"), null);
    assert.equal(tagText("<a>null</a>", "a"), null);
    assert.equal(tagText("<a>NULL</a>", "a"), null);
    assert.equal(tagText("<a> spaced </a>", "a"), "spaced");
    assert.equal(tagText("<a>x</a>", "missing"), null);
  });

  it("reads attributes-bearing tags and every repeated block, as CJ always did", () => {
    assert.equal(tagText('<a id="1">v</a>', "a"), "v");
    assert.deepEqual(tagBlocks("<r>1</r><r>2</r>", "r"), ["1", "2"]);
    assert.deepEqual(tagBlocks("", "r"), []);
  });

  it("escapes the tag name rather than treating it as a pattern", () => {
    assert.equal(tagText("<a.b>v</a.b>", "a.b"), "v");
    assert.equal(tagText("<axb>v</axb>", "a.b"), null);
  });

  it("still parses CJ advertiser rows through the shared primitives", async () => {
    const { extractCjAdvertisers } = await import("../src/adapters/cj.adapter.js");
    const xml = `<cj-api><advertisers><advertiser>
        <advertiser-id>zzcjidzz</advertiser-id>
        <advertiser-name>zzcjnamezz</advertiser-name>
        <relationship-status>joined</relationship-status>
      </advertiser></advertisers></cj-api>`;
    const rows = extractCjAdvertisers(xml);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].advertiser_id, "zzcjidzz");
    assert.equal(rows[0].advertiser_name, "zzcjnamezz");
    assert.equal(rows[0].relationship_status, "joined");
    assert.equal(rows[0].record_source, "cj_advertiser_lookup");
  });

  it("keeps CJ dropping rows with no advertiser id, as before", async () => {
    const { extractCjAdvertisers } = await import("../src/adapters/cj.adapter.js");
    const xml = `<cj-api><advertisers>
        <advertiser><advertiser-name>zznoidzz</advertiser-name></advertiser>
        <advertiser><advertiser-id>zzkeptzz</advertiser-id></advertiser>
      </advertisers></cj-api>`;
    const rows = extractCjAdvertisers(xml);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].advertiser_id, "zzkeptzz");
  });
});

describe("nothing beyond text links is implemented", () => {
  it("adds no banner, DRM, deep-link POST, coupon or product path", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const absent of [
      "getBannerLinks",
      "getDRMLinks",
      "createDeepLink",
      "fetchCoupons",
      "fetchProducts",
      "fetchLinks",
    ]) {
      assert.ok(!code.includes(absent), absent);
    }
  });

  it("declares exactly one Link Locator operation", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/linklocator/g) ?? []).length, 1);
    assert.equal((code.match(/getTextLinks/g) ?? []).length, 1);
  });

  it("adds no probe for the objects still deferred", () => {
    for (const notYet of ["events", "advanced_reports", "payments", "coupons", "products"]) {
      assert.ok(!listProbeSourceObjects("rakuten").includes(notYet), notYet);
      assert.ok(!Object.hasOwn(RAKUTEN_CERTIFICATION_SPECS, notYet), notYet);
    }
  });

  it("performs no database read or write", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    assert.equal((await certifyLinks(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("leaves every other Rakuten object sending its own request unchanged", async () => {
    const spy = spyHttp();
    const jsonSpy = spyHttp({ advertisers: [{ id: 1 }] });
    await adapterWith(spy).fetchCertificationSample("links", {});
    await adapterWith(jsonSpy).fetchCertificationSample("advertisers", {});
    assert.equal(spy.calls[0].path, RAKUTEN_TEXT_LINKS_PATH);
    assert.equal(jsonSpy.calls[0].path, "/v2/advertisers");
  });
});
