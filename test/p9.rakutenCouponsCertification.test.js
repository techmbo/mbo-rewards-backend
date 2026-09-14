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
  buildRakutenCouponParams,
  createRakutenAdapter,
  extractRakutenCouponLinks,
  RAKUTEN_CERTIFICATION_COUPON_PARAMS,
  RAKUTEN_CERTIFICATION_MAX_ROWS,
  RAKUTEN_CERTIFICATION_PAGE_PARAMS,
  RAKUTEN_CERTIFICATION_SPECS,
  RAKUTEN_COUPON_DEFAULT_RESULTS_PER_PAGE,
  RAKUTEN_COUPON_MAX_RESULTS_PER_PAGE,
  RAKUTEN_COUPON_PATH,
} = await import("../src/adapters/rakuten.adapter.js");
const { NetworkCertificationService, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");
const { tagBlocks, tagBlocksWithAttributes, tagText } = await import("../src/core/xml.js");

const ADAPTER_SRC = readFileSync("src/adapters/rakuten.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const XML_SRC = readFileSync("src/core/xml.js", "utf8");
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

/**
 * One coupon row inside the documented envelope.
 *
 * Field NAMES are real and every VALUE is a distinctive marker. A realistic value would make the
 * leak tests worthless: "approved" as a VALUE is indistinguishable by substring from a PATH named
 * approved_date, and a short numeric marker can collide with the ISO timestamp every result
 * carries. The envelope counters are deliberately included — an envelope read as a row is exactly
 * the failure these tests exist to catch.
 */
const ONE_COUPON_XML = `<?xml version="1.0" encoding="UTF-8"?>
<couponfeed>
  <TotalMatches>zztotalmatcheszz</TotalMatches>
  <TotalPages>zztotalpageszz</TotalPages>
  <PageNumberRequested>zzpagerequestedzz</PageNumberRequested>
  <link type="TEXT">
    <categories>
      <category>zzcategoryonezz</category>
      <category>zzcategorytwozz</category>
    </categories>
    <promotiontypes>
      <promotiontype>zzpromotiontypezz</promotiontype>
    </promotiontypes>
    <offerdescription>zzofferdescriptionzz</offerdescription>
    <offerstartdate>2031-03-17</offerstartdate>
    <offerenddate>2031-04-19</offerenddate>
    <couponcode>zzcouponcodezz</couponcode>
    <couponrestriction>zzcouponrestrictionzz</couponrestriction>
    <imageurl>https://zzimagezz.example/banner.png</imageurl>
    <clickurl>https://zzclickzz.example/track</clickurl>
    <impressionpixel>https://zzpixelzz.example/impression</impressionpixel>
    <advertiserid>zzadvertiseridzz</advertiserid>
    <advertisername>zzadvertisernamezz</advertisername>
    <network>zznetworkvaluezz</network>
  </link>
</couponfeed>`;

/** Two rows, to prove repeated <link> elements parse and that only one is kept. The second is a
 *  BANNER with NO couponcode — the documented optional case. */
const TWO_COUPONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<couponfeed>
  <TotalMatches>zztotalmatcheszz</TotalMatches>
  <link type="TEXT"><clickurl>https://zzfirstzz.example/a</clickurl><couponcode>zzfirstcodezz</couponcode></link>
  <link type="BANNER"><clickurl>https://zzsecondzz.example/b</clickurl></link>
</couponfeed>`;

/** A row with none of the three optional fields. A complete row, not a truncated one. */
const NO_CODE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<couponfeed>
  <link type="BANNER">
    <promotiontypes><promotiontype>zzfreeshippingzz</promotiontype></promotiontypes>
    <offerdescription>zznocodeofferzz</offerdescription>
    <clickurl>https://zznocodezz.example/track</clickurl>
    <advertiserid>zzadvertiseridzz</advertiserid>
  </link>
</couponfeed>`;

/** The documented envelope with no rows at all. */
const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<couponfeed>
  <TotalMatches>zzzeromatcheszz</TotalMatches>
  <TotalPages>zzzeropageszz</TotalPages>
  <PageNumberRequested>zzpagerequestedzz</PageNumberRequested>
</couponfeed>`;

function spyHttp(dataOrError = ONE_COUPON_XML) {
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

async function certifyCoupons(adapter) {
  return serviceWith(adapter).certify("rakuten", { sourceObjects: ["coupons"] });
}

async function sampleCoupons(adapter, options = {}) {
  return adapter.fetchCertificationSample("coupons", options);
}

describe("the documented Coupon API request contract", () => {
  it("addresses exactly GET /coupon/1.0", async () => {
    assert.equal(RAKUTEN_COUPON_PATH, "/coupon/1.0");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.coupons.path, RAKUTEN_COUPON_PATH);
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.coupons.method, "GET");

    const spy = spyHttp();
    await sampleCoupons(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/coupon/1.0");
  });

  it("sends resultsperpage=1 and pagenumber=1, and nothing else", async () => {
    const spy = spyHttp();
    await sampleCoupons(adapterWith(spy));
    assert.deepEqual(spy.calls[0].config.params, { resultsperpage: 1, pagenumber: 1 });
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_COUPON_PARAMS }, { resultsperpage: 1, pagenumber: 1 });
  });

  it("does NOT send the limit/page pair the JSON objects share", async () => {
    // /coupon/1.0 documents resultsperpage and pagenumber. limit and page are parameters this
    // endpoint never published, and sending an undocumented bound is what the Awin coupons 500
    // punished. ownBounds is what suppresses them.
    const spy = spyHttp();
    await sampleCoupons(adapterWith(spy));
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.coupons.ownBounds, true);
    assert.ok(!Object.hasOwn(spy.calls[0].config.params, "limit"));
    assert.ok(!Object.hasOwn(spy.calls[0].config.params, "page"));
    // The shared pair still exists and is still applied to the JSON objects.
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_PAGE_PARAMS }, { limit: 1, page: 1 });
  });

  it("adds no category, network, MID or promotion filter", async () => {
    const spy = spyHttp();
    await sampleCoupons(adapterWith(spy));
    const serialised = JSON.stringify(spy.calls[0].config.params);
    for (const filter of ["cat", "category", "network", "mid", "promotiontype", "advertiser"]) {
      assert.ok(!serialised.includes(filter), filter);
    }
  });

  it("requests XML as text, with the Bearer only", async () => {
    const spy = spyHttp();
    const bearerOnly = createRakutenAdapter({ accessToken: TOKEN, httpClient: spy.client });
    assert.equal((await sampleCoupons(bearerOnly)).length, 1);
    assert.equal(spy.calls[0].config.responseType, "text");
    assert.match(spy.calls[0].config.headers.Accept, /xml/);
    // No web security token and no Advanced Reports surface: this probe must separate "the Bearer
    // works" from a credential it does not need.
    assert.ok(!JSON.stringify(spy.calls[0]).includes(SECURITY_TOKEN));
    assert.ok(!JSON.stringify(spy.calls[0]).includes("advancedreports"));
  });

  it("leaves every other Rakuten object sending its own request unchanged", async () => {
    const jsonSpy = spyHttp({ advertisers: [{ id: "zzadvzz" }] });
    await adapterWith(jsonSpy).fetchCertificationSample("advertisers", {});
    assert.equal(jsonSpy.calls[0].path, "/v2/advertisers");
    assert.deepEqual(jsonSpy.calls[0].config.params, { limit: 1, page: 1 });

    const offerSpy = spyHttp({ offers: [{ id: "zzofferzz" }] });
    await adapterWith(offerSpy).fetchCertificationSample("offers", {});
    assert.deepEqual(offerSpy.calls[0].config.params, {
      limit: 1,
      page: 1,
      offer_status: "available",
    });
  });

  it("declares bounds of its own, as only the endpoints that publish their own do", () => {
    // events joined later: its limit/page pair arrives inside production's own parameter builder,
    // so spreading the shared pair alongside would bypass that normalisation. Nothing else.
    for (const [name, spec] of Object.entries(RAKUTEN_CERTIFICATION_SPECS)) {
      if (name === "coupons" || name === "events") continue;
      assert.ok(!spec.ownBounds, `${name} must keep the shared bounds`);
    }
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.coupons.ownBounds, true);
    // coupons declares its bounds as a frozen literal; events builds them from the window.
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.coupons.buildParams, undefined);
  });
});

describe("exactly one request, no retry, no pagination", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await sampleCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a failed request", async () => {
    // getJson wraps requestWithRetry and would turn one read into up to four. The coupon path
    // deliberately does not use it.
    const spy = spyHttp(new Error("zzsupplierfailurezz"));
    await assert.rejects(() => sampleCoupons(adapterWith(spy)));
    assert.equal(spy.calls.length, 1);
  });

  it("does not walk pages, even when the envelope reports more", async () => {
    // TotalPages says there are more. One request is still one request.
    const spy = spyHttp(TWO_COUPONS_XML);
    await sampleCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].config.params.pagenumber, 1);
  });

  it("carries a bounded timeout rather than the shared client default", async () => {
    const spy = spyHttp();
    await sampleCoupons(adapterWith(spy), { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("makes one request through the whole certification chain too", async () => {
    const spy = spyHttp();
    await certifyCoupons(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });
});

describe("the couponfeed envelope is never mistaken for a coupon", () => {
  it("reads rows from <link>, not from <couponfeed>", () => {
    const rows = extractRakutenCouponLinks(ONE_COUPON_XML);
    assert.equal(rows.length, 1);
    for (const counter of ["TotalMatches", "TotalPages", "PageNumberRequested"]) {
      assert.ok(!Object.hasOwn(rows[0], counter), counter);
      assert.ok(!Object.hasOwn(rows[0], counter.toLowerCase()), counter);
    }
  });

  it("reports zero rows for an envelope that holds none", () => {
    assert.deepEqual(extractRakutenCouponLinks(EMPTY_XML), []);
  });

  it("yields no rows at all when the documented envelope is absent", () => {
    // A <link> outside a couponfeed is not a response this contract describes. Refusing it is the
    // point: reading it anyway would certify a shape the supplier never promised.
    const stray = `<?xml version="1.0"?><other><link type="TEXT"><clickurl>https://zzstrayzz.example/x</clickurl></link></other>`;
    assert.deepEqual(extractRakutenCouponLinks(stray), []);
  });

  it("survives an empty, malformed or missing body without throwing", () => {
    for (const body of ["", "<couponfeed>", "not xml at all", "<html><body>nope</body></html>"]) {
      assert.deepEqual(extractRakutenCouponLinks(body), [], JSON.stringify(body));
    }
  });
});

describe("row parsing", () => {
  it("parses repeated <link> elements as separate rows", () => {
    const rows = extractRakutenCouponLinks(TWO_COUPONS_XML);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].type, "TEXT");
    assert.equal(rows[1].type, "BANNER");
    assert.notEqual(rows[0].clickurl, rows[1].clickurl);
  });

  it("reads the row-kind attribute off the <link> element itself", () => {
    // type is an ATTRIBUTE, not a child element. A reader that saw only inner content could not
    // tell a TEXT coupon link from a BANNER one.
    assert.equal(extractRakutenCouponLinks(ONE_COUPON_XML)[0].type, "TEXT");
  });

  it("reads the repeating containers as arrays, not as concatenated text", () => {
    const row = extractRakutenCouponLinks(ONE_COUPON_XML)[0];
    assert.deepEqual(row.categories, ["zzcategoryonezz", "zzcategorytwozz"]);
    assert.deepEqual(row.promotiontypes, ["zzpromotiontypezz"]);
    // The failure this avoids: <categories> read as text would glue every category together.
    assert.ok(Array.isArray(row.categories));
    assert.notEqual(row.categories, "zzcategoryonezzzzcategorytwozz");
  });

  it("reports an empty container as an empty array, not as a phantom entry", () => {
    const row = extractRakutenCouponLinks(
      `<couponfeed><link type="TEXT"><categories></categories></link></couponfeed>`,
    )[0];
    assert.deepEqual(row.categories, []);
  });

  it("drops empty and literal-null entries from a populated container", () => {
    // Suppliers use an empty element and the string "null" interchangeably with an absent value.
    // Keeping either would put a meaningless entry in the dictionary and inflate the array's
    // length — the same absence rule tagText applies to a single element applies here.
    const row = extractRakutenCouponLinks(
      `<couponfeed><link type="TEXT"><categories>` +
        `<category>zzrealcategoryzz</category><category></category><category>null</category>` +
        `<category>   </category></categories></link></couponfeed>`,
    )[0];
    assert.deepEqual(row.categories, ["zzrealcategoryzz"]);
  });

  it("reads an attribute whatever case the supplier spells it in", () => {
    // XML attribute names are case-sensitive to a parser but not to a supplier's house style.
    // Normalising to one spelling is what lets the extractor read attributes.type unconditionally.
    const row = extractRakutenCouponLinks(
      `<couponfeed><link Type="TEXT"><clickurl>https://zzcasezz.example/x</clickurl></link></couponfeed>`,
    )[0];
    assert.equal(row.type, "TEXT");
    assert.deepEqual(tagBlocksWithAttributes(`<link TYPE="BANNER"></link>`, "link")[0].attributes, {
      type: "BANNER",
    });
  });

  it("carries every documented scalar field", () => {
    const row = extractRakutenCouponLinks(ONE_COUPON_XML)[0];
    for (const field of [
      "advertiserid",
      "advertisername",
      "network",
      "offerdescription",
      "offerstartdate",
      "offerenddate",
      "couponcode",
      "couponrestriction",
      "imageurl",
      "clickurl",
      "impressionpixel",
    ]) {
      assert.ok(Object.hasOwn(row, field), field);
    }
  });
});

describe("COUPON_ASSET_AVAILABLE != COUPON_CODE_PRESENT", () => {
  it("treats a row with no couponcode as a complete row", () => {
    const rows = extractRakutenCouponLinks(NO_CODE_XML);
    assert.equal(rows.length, 1, "the row is kept, not discarded");
    assert.equal(rows[0].couponcode, null);
    assert.equal(rows[0].couponrestriction, null);
    assert.equal(rows[0].imageurl, null);
    // The rest of the row is still there.
    assert.equal(rows[0].type, "BANNER");
    assert.deepEqual(rows[0].promotiontypes, ["zzfreeshippingzz"]);
  });

  it("certifies a code-less row as OK, reporting couponcode as a nullable path", async () => {
    const result = await certifyCoupons(adapterWith(spyHttp(NO_CODE_XML)));
    const row = result.results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);

    const couponcode = row.fieldPaths.find((f) => f.path === "couponcode");
    assert.ok(couponcode, "the path is still reported");
    assert.equal(couponcode.observedType, "NULL");
    assert.equal(couponcode.nullableObserved, true);
    assert.equal(couponcode.presentCount, 0);
  });

  it("does not classify a code-less row as unsupported or as a failure", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp(NO_CODE_XML))));
    for (const claim of [
      "NOT_SUPPORTED",
      "UNSUPPORTED",
      "COUPON_CODE_REQUIRED",
      "NEEDS_ACTIVE_PARTNERSHIP",
    ]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });
});

describe("COUPON_ROW_AVAILABLE != TRACKING_LINK_USABLE", () => {
  it("never returns the clickurl, impressionpixel or imageurl value", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp())));
    for (const secret of ["zzclickzz", "zzpixelzz", "zzimagezz", "https://", "http://"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the coupon code, restriction, description or advertiser identity", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp())));
    for (const secret of [
      "zzcouponcodezz",
      "zzcouponrestrictionzz",
      "zzofferdescriptionzz",
      "zzadvertiseridzz",
      "zzadvertisernamezz",
      "zznetworkvaluezz",
      "zzcategoryonezz",
      "zzcategorytwozz",
      "zzpromotiontypezz",
      "2031-03-17",
      "2031-04-19",
      "TEXT",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns credentials or the raw XML", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp())));
    for (const secret of [
      TOKEN,
      SECURITY_TOKEN,
      "Bearer",
      "couponfeed",
      "<link",
      "zztotalmatcheszz",
      "zztotalpageszz",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("promotes no clickurl into a canonical TrackingLink", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const forbidden of [
      "TrackingLink",
      "buildDeepLink",
      "generateDeepLink",
      "createTrackingLink",
      "normalizeRakutenCoupon",
      "mapRakutenCoupon",
    ]) {
      assert.ok(!code.includes(forbidden), forbidden);
    }
  });

  it("makes no claim of a usable link or a persisted coupon in the result", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp())));
    for (const claim of [
      "TRACKING_LINK_USABLE",
      "trackingLink",
      "TrackingLink",
      "CouponCodeMaster",
      "couponPersisted",
      "deepLink",
    ]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });
});

describe("the coupons outcome vocabulary", () => {
  it("is registered with an endpointKey naming the real request contract", async () => {
    assert.ok(listProbeSourceObjects("rakuten").includes("coupons"));
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    assert.equal(row.endpointKey, "GET /coupon/1.0 (resultsperpage=1, pagenumber=1)");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "coupons");
  });

  it("reports OK with a structural field dictionary when a row is parsed", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);

    const paths = row.fieldPaths.map((f) => f.path);
    for (const expected of ["clickurl", "couponcode", "categories", "categories[]", "type"]) {
      assert.ok(paths.includes(expected), expected);
    }
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    for (const field of row.fieldPaths) {
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
      for (const key of ["value", "example", "sample", "raw", "preview"]) {
        assert.ok(!Object.hasOwn(field, key), key);
      }
    }
  });

  it("categorises structurally, without quoting the value", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp()))).results[0];
    const byPath = Object.fromEntries(row.fieldPaths.map((f) => [f.path, f]));
    assert.equal(byPath.clickurl.observedType, "URL");
    assert.equal(byPath.offerstartdate.observedType, "ISO_DATE");
    assert.equal(byPath.categories.observedType, "ARRAY");
    assert.equal(byPath.categories.arrayObserved, true);
    assert.equal(byPath["categories[]"].observedType, "STRING");
  });
});

describe("zero rows is not an account-state finding", () => {
  it("reports OK_NO_ROWS with schema UNKNOWN_NEEDS_LIVE_DATA for an empty feed", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp(EMPTY_XML)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("invents no partnership blocker from emptiness", async () => {
    // The docs say this API returns partner-advertiser data, which makes "no joined campaigns" a
    // plausible READING of an empty feed. A plausible reading is not evidence.
    const row = (await certifyCoupons(adapterWith(spyHttp(EMPTY_XML)))).results[0];
    assert.ok(!Object.hasOwn(row, "accountStateBlocker"));

    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp(EMPTY_XML))));
    for (const invented of [
      "NEEDS_ACTIVE_PARTNERSHIP",
      "NO_JOINED_CAMPAIGNS",
      "accountStateBlocker",
      "NOT_SUPPORTED",
      "UNSUPPORTED",
    ]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("does not report zero rows as an error", async () => {
    const row = (await certifyCoupons(adapterWith(spyHttp(EMPTY_XML)))).results[0];
    assert.equal(row.ok, true);
    assert.ok(!Object.hasOwn(row, "supplierStatusCode") || row.supplierStatusCode == null);
  });
});

describe("supplier rejection is preserved safely", () => {
  it("maps an auth rejection to AUTH_FAILED without leaking the credential", async () => {
    const error = new Error("zzupstreamauthmessagezz");
    error.response = { status: 401, data: { message: "zzupstreambodyzz" } };
    const row = (await certifyCoupons(adapterWith(spyHttp(error)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");

    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(TOKEN));
    assert.ok(!serialised.includes(SECURITY_TOKEN));
    assert.ok(!serialised.includes("zzupstreambodyzz"), "no supplier response body");
  });

  it("preserves the supplier status for a rejected request", async () => {
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: {} };
    const row = (await certifyCoupons(adapterWith(spyHttp(error)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
  });
});

describe("the sample is bounded to one row, twice and independently", () => {
  it("slices in the adapter", async () => {
    assert.equal(RAKUTEN_CERTIFICATION_MAX_ROWS, 1);
    const rows = await sampleCoupons(adapterWith(spyHttp(TWO_COUPONS_XML)));
    assert.equal(rows.length, 1);
  });

  it("slices again in the service, independently of the adapter", async () => {
    // An adapter that forgot to slice must still not produce a two-row dictionary.
    const unbounded = {
      ...adapterWith(spyHttp(TWO_COUPONS_XML)),
      fetchCertificationSample: async () => extractRakutenCouponLinks(TWO_COUPONS_XML),
    };
    assert.equal(extractRakutenCouponLinks(TWO_COUPONS_XML).length, 2);
    const row = (await certifyCoupons(unbounded)).results[0];
    assert.equal(row.sampleCount, 1);
  });

  it("never returns the second row's values", async () => {
    const serialised = JSON.stringify(await certifyCoupons(adapterWith(spyHttp(TWO_COUPONS_XML))));
    for (const secret of ["zzfirstzz", "zzsecondzz", "zzfirstcodezz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });
});

describe("the general read method is bounded and unfilterable", () => {
  it("reads GET /coupon/1.0 with the documented defaults", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCoupons();
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, "/coupon/1.0");
    assert.deepEqual(spy.calls[0].config.params, { resultsperpage: 500, pagenumber: 1 });
    assert.equal(RAKUTEN_COUPON_DEFAULT_RESULTS_PER_PAGE, 500);
  });

  it("asks for XML as text, because the Coupon API answers in XML", async () => {
    // Asking for JSON on an XML-only surface is how a supplier ends up returning something the
    // parser cannot read, or refusing the request outright.
    const spy = spyHttp();
    await adapterWith(spy).fetchCoupons();
    assert.match(spy.calls[0].config.headers.Accept, /xml/);
    assert.ok(!spy.calls[0].config.headers.Accept.includes("json"));
    assert.equal(spy.calls[0].config.responseType, "text");
  });

  it("clamps resultsperpage to the documented maximum of 500", () => {
    assert.equal(RAKUTEN_COUPON_MAX_RESULTS_PER_PAGE, 500);
    assert.equal(buildRakutenCouponParams({ resultsperpage: 9000 }).resultsperpage, 500);
    assert.equal(buildRakutenCouponParams({ resultsperpage: 25 }).resultsperpage, 25);
  });

  it("falls back to the documented defaults for absent or nonsense bounds", () => {
    for (const bad of [{}, { resultsperpage: 0 }, { resultsperpage: -3 }, { resultsperpage: "nope" }]) {
      assert.deepEqual(buildRakutenCouponParams(bad), { resultsperpage: 500, pagenumber: 1 });
    }
    for (const bad of [{ pagenumber: 0 }, { pagenumber: -1 }, { pagenumber: "nope" }]) {
      assert.equal(buildRakutenCouponParams(bad).pagenumber, 1);
    }
  });

  it("is an ALLOWLIST: no caller key other than the two documented ones reaches the supplier", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchCoupons({
      resultsperpage: 5,
      pagenumber: 2,
      cat: "zzfilterzz",
      category: "zzfilterzz",
      network: "zzfilterzz",
      mid: "zzfilterzz",
      promotiontype: "zzfilterzz",
      token: "zzfilterzz",
    });
    assert.deepEqual(spy.calls[0].config.params, { resultsperpage: 5, pagenumber: 2 });
    assert.ok(!JSON.stringify(spy.calls[0].config.params).includes("zzfilterzz"));
    assert.deepEqual(Object.keys(buildRakutenCouponParams({})).sort(), [
      "pagenumber",
      "resultsperpage",
    ]);
  });

  it("makes one request and does not retry or walk pages", async () => {
    const failing = spyHttp(new Error("zzfailzz"));
    await assert.rejects(() => adapterWith(failing).fetchCoupons());
    assert.equal(failing.calls.length, 1);

    const multi = spyHttp(TWO_COUPONS_XML);
    const rows = await adapterWith(multi).fetchCoupons();
    assert.equal(multi.calls.length, 1);
    // The general method returns what one page held; only certification caps rows at one.
    assert.equal(rows.length, 2);
  });

  it("counts its request in the stats the sync framework reads", async () => {
    const spy = spyHttp();
    const stats = {};
    await adapterWith(spy).fetchCoupons({}, stats);
    assert.equal(stats.requestCount, 1);
  });
});

describe("the shared XML utility is reused, and CJ is unchanged", () => {
  it("defines no XML parser of its own", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const redefined of [
      "function decodeXml",
      "function tagText",
      "function tagBlocks",
      "function tagBlocksWithAttributes",
      "DOMParser",
      "xml2js",
      "fast-xml-parser",
    ]) {
      assert.ok(!code.includes(redefined), redefined);
    }
    assert.match(code, /import \{[^}]*tagBlocksWithAttributes[^}]*\} from "\.\.\/core\/xml\.js"/);
  });

  it("reads rows with the shared primitives, not with a private regex", () => {
    // Same input, same result: the extractor is a thin layer over the shared functions.
    const feed = tagBlocks(ONE_COUPON_XML, "couponfeed")[0];
    const blocks = tagBlocksWithAttributes(feed, "link");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].attributes.type, "TEXT");
    assert.equal(tagText(blocks[0].content, "couponcode"), "zzcouponcodezz");
    assert.equal(extractRakutenCouponLinks(ONE_COUPON_XML)[0].couponcode, "zzcouponcodezz");
  });

  it("leaves tagBlocks, tagText and decodeXml untouched", () => {
    // The new primitive was ADDED alongside them; CJ and Link Locator read through the old ones.
    const xml = `<a><b attr="x">one</b><b>two</b></a>`;
    assert.deepEqual(tagBlocks(xml, "b"), ["one", "two"]);
    assert.equal(tagText(xml, "b"), "one");
    assert.equal(codeOf(XML_SRC).includes("export function tagBlocks(xml, tag)"), true);
  });

  it("leaves CJ using the shared module with no parser of its own", () => {
    const cj = codeOf(CJ_SRC);
    for (const redefined of ["function decodeXml", "function tagText", "function tagBlocks"]) {
      assert.ok(!cj.includes(redefined), redefined);
    }
    assert.match(cj, /from "\.\.\/core\/xml\.js"/);
  });

  it("reads attributes from the opening tag only, and never guesses", () => {
    const blocks = tagBlocksWithAttributes(
      `<link type="TEXT" other='single'><inner attr="ignored">x</inner></link>`,
      "link",
    );
    assert.deepEqual(blocks[0].attributes, { type: "TEXT", other: "single" });
    assert.ok(!Object.hasOwn(blocks[0].attributes, "attr"), "inner attributes are not hoisted");
    // An unquoted attribute is not reported rather than guessed at.
    assert.deepEqual(tagBlocksWithAttributes(`<link type=TEXT></link>`, "link")[0].attributes, {});
  });
});

describe("read-only, and nothing beyond a bounded read is implemented", () => {
  it("performs no database read or write", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    assert.equal((await certifyCoupons(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain that certifies this object", () => {
    const code = codeOf(SERVICE_SRC);
    const chain = code.slice(
      code.indexOf("async certifyRakutenSample("),
      code.indexOf("async certifyAwinCommissionGroups("),
    );
    for (const forbidden of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany"]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });

  it("adds no coupon persistence, product search or deep link", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const absent of [
      "fetchProducts",
      "productsearch",
      "ProductSearch",
      "persistCoupon",
      "saveCoupon",
      "assignClient",
    ]) {
      assert.ok(!code.includes(absent), absent);
    }
  });

  it("is called by no sync job", () => {
    // Several sync paths call adapter.fetchCoupons behind a typeof guard. None of them is
    // Rakuten's, so adding the method starts no ingestion — proved here rather than assumed.
    const rakutenSync = codeOf(readFileSync("src/jobs/rakutenSupplierSync.js", "utf8"));
    assert.ok(!rakutenSync.includes("fetchCoupons"));
    assert.ok(!rakutenSync.includes("coupon"));
  });

  it("declares no COUPONS capability, because no ingestion exists", async () => {
    // Implementation truth is that a read path exists. The capability is a supplier-wide claim
    // consumed by ops surfaces, and nothing ingests Rakuten coupons yet.
    const caps = adapterWith(spyHttp()).getCapabilities();
    assert.ok(!caps.capabilities.includes("COUPONS"));
    assert.ok(caps.notes.some((note) => note.includes("/coupon/1.0")));
  });
});

describe("catalog truth", () => {
  it("records the real endpoint and marks the fetch as existing", () => {
    const entry = getSourceObject("rakuten", "coupons");
    assert.ok(entry);
    assert.equal(entry.endpoint, "GET /coupon/1.0");
    assert.equal(entry.live, true);
    assert.equal(entry.entityType, "coupon");
  });

  it("does not claim ingestion, persistence or observed rows", () => {
    const entry = getSourceObject("rakuten", "coupons");
    assert.match(entry.notes, /no canonical Coupon is persisted/i);
    assert.match(entry.notes, /not yet been observed live/i);
  });

  it("leaves the still-gated XML objects alone", () => {
    // Network support is not implementation support: Product Search and Link Locator have no
    // general read method, so neither is upgraded by this phase.
    for (const stillDeclared of ["products", "links"]) {
      assert.equal(getSourceObject("rakuten", stillDeclared).live, false, stillDeclared);
    }
  });

  it("names a probe for every declared spec, and a spec for this probe", () => {
    for (const sourceObject of Object.keys(RAKUTEN_CERTIFICATION_SPECS)) {
      assert.ok(listProbeSourceObjects("rakuten").includes(sourceObject), sourceObject);
    }
    assert.ok(Object.hasOwn(RAKUTEN_CERTIFICATION_SPECS, "coupons"));
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_SPECS.coupons));
  });
});
