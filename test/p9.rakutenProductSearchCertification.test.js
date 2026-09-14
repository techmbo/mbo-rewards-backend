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
  buildRakutenProductSearchParams,
  createRakutenAdapter,
  extractRakutenProducts,
  RAKUTEN_CERTIFICATION_MAX_ROWS,
  RAKUTEN_CERTIFICATION_PAGE_PARAMS,
  RAKUTEN_CERTIFICATION_PRODUCT_PARAMS,
  RAKUTEN_CERTIFICATION_SPECS,
  RAKUTEN_PRODUCT_SEARCH_PARAMS,
  RAKUTEN_PRODUCT_SEARCH_PATH,
} = await import("../src/adapters/rakuten.adapter.js");
const { NetworkCertificationService, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");
const { tagBlocks, tagBlocksWithAttributes, tagText } = await import("../src/core/xml.js");

const ADAPTER_SRC = readFileSync("src/adapters/rakuten.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

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

/** The adapter minus its notes array: a `notes:` string is prose too, and an absence scan that
 *  matched one would be reading a sentence rather than the implementation. */
function implementationOf(source) {
  const code = codeOf(source);
  const start = code.indexOf("notes: [");
  if (start === -1) return code;
  const end = code.indexOf("],", start);
  return end === -1 ? code.slice(0, start) : code.slice(0, start) + code.slice(end + 2);
}

const TOKEN = "zzrakutentokenzz";
const SECURITY_TOKEN = "zzsecuritytokenzz";

/**
 * One product row inside the documented envelope.
 *
 * Field NAMES real, every VALUE a distinctive marker. A realistic SKU is indistinguishable by
 * substring from a path named sku. The prices are real decimals — they must be, to certify as
 * something — chosen so they cannot collide with a count or an ISO timestamp.
 */
const ONE_PRODUCT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <TotalMatches>zztotalmatcheszz</TotalMatches>
  <TotalPages>zztotalpageszz</TotalPages>
  <PageNumber>zzpagenumberzz</PageNumber>
  <item>
    <mid>zzmidvaluezz</mid>
    <merchantname>zzmerchantnamezz</merchantname>
    <linkid>zzlinkidzz</linkid>
    <createdon>2031-03-17</createdon>
    <sku>zzskuvaluezz</sku>
    <productname>zzproductnamezz</productname>
    <category>
      <primary>zzprimarycategoryzz</primary>
      <secondary>zzsecondarycategoryzz</secondary>
    </category>
    <price currency="SGD">8123.47</price>
    <saleprice currency="SGD">4372.19</saleprice>
    <upccode>zzupccodezz</upccode>
    <description>
      <short>zzshortdescriptionzz</short>
      <long>zzlongdescriptionzz</long>
    </description>
    <keywords>zzkeywordszz</keywords>
    <linkurl>https://zzlinkurlzz.example/product</linkurl>
    <imageurl>https://zzimageurlzz.example/product.png</imageurl>
  </item>
</result>`;

/** Two rows, to prove repeated items parse and that only one is kept. */
const TWO_PRODUCTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <TotalMatches>zztotalmatcheszz</TotalMatches>
  <item><mid>zzfirstmidzz</mid><sku>zzfirstskuzz</sku><price currency="SGD">1111.11</price></item>
  <item><mid>zzsecondmidzz</mid><sku>zzsecondskuzz</sku><price currency="SGD">2222.22</price></item>
</result>`;

/** A row with none of the optional containers or money elements. A complete row, not a broken one. */
const MINIMAL_PRODUCT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <item>
    <mid>zzminimalmidzz</mid>
    <productname>zzminimalproductzz</productname>
  </item>
</result>`;

/** The documented envelope with no items at all. */
const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <TotalMatches>zzzeromatcheszz</TotalMatches>
  <TotalPages>zzzeropageszz</TotalPages>
  <PageNumber>zzpagenumberzz</PageNumber>
</result>`;

function spyHttp(dataOrError = ONE_PRODUCT_XML) {
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

async function certifyProducts(adapter) {
  return serviceWith(adapter).certify("rakuten", { sourceObjects: ["products"] });
}

async function sampleProducts(adapter, options = {}) {
  return adapter.fetchCertificationSample("products", options);
}

describe("the documented Product Search request contract", () => {
  it("addresses exactly GET /productsearch/1.0", async () => {
    assert.equal(RAKUTEN_PRODUCT_SEARCH_PATH, "/productsearch/1.0");
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.products.path, RAKUTEN_PRODUCT_SEARCH_PATH);
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.products.method, "GET");

    const spy = spyHttp();
    await sampleProducts(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/productsearch/1.0");
  });

  it("sends max=1 and pagenumber=1, and nothing else", async () => {
    const spy = spyHttp();
    await sampleProducts(adapterWith(spy));
    assert.deepEqual(spy.calls[0].config.params, { max: 1, pagenumber: 1 });
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_PRODUCT_PARAMS }, { max: 1, pagenumber: 1 });
  });

  it("sends NO search filter of any kind", async () => {
    // Whether Rakuten accepts an unfiltered search is the one part of this contract the repo
    // cannot establish. The bounds alone are the shape that assumes nothing: a keyword would be a
    // search term nobody asked for, and a mid would point the probe at one advertiser taken from
    // another endpoint's row.
    const spy = spyHttp();
    await sampleProducts(adapterWith(spy));
    for (const filter of ["keyword", "exact", "one", "none", "cat", "mid", "sort", "sorttype", "language"]) {
      assert.ok(!Object.hasOwn(spy.calls[0].config.params, filter), filter);
    }
    assert.ok(!JSON.stringify(spy.calls[0].config.params).includes("keyword"));
  });

  it("does NOT send the limit/page pair the JSON objects share", async () => {
    // /productsearch/1.0 documents max and pagenumber. limit and page are parameters this endpoint
    // never published, and sending an undocumented bound is what the Awin coupons 500 punished.
    const spy = spyHttp();
    await sampleProducts(adapterWith(spy));
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.products.ownBounds, true);
    assert.ok(!Object.hasOwn(spy.calls[0].config.params, "limit"));
    assert.ok(!Object.hasOwn(spy.calls[0].config.params, "page"));
    assert.deepEqual({ ...RAKUTEN_CERTIFICATION_PAGE_PARAMS }, { limit: 1, page: 1 });
  });

  it("requests XML as text, with the Bearer only", async () => {
    const spy = spyHttp();
    const bearerOnly = createRakutenAdapter({ accessToken: TOKEN, httpClient: spy.client });
    assert.equal((await sampleProducts(bearerOnly)).length, 1);
    assert.equal(spy.calls[0].config.responseType, "text");
    assert.match(spy.calls[0].config.headers.Accept, /xml/);
    assert.ok(!JSON.stringify(spy.calls[0]).includes(SECURITY_TOKEN));
    assert.ok(!JSON.stringify(spy.calls[0]).includes("advancedreports"));
  });

  it("needs no window: this is a search, not a dated report", () => {
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.products.needs, undefined);
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.products.buildParams, undefined);
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_SPECS.products));
    assert.ok(Object.isFrozen(RAKUTEN_CERTIFICATION_SPECS.products.params));
  });
});

describe("exactly one request, no retry, no pagination", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await sampleProducts(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a failed request", async () => {
    const spy = spyHttp(new Error("zzsupplierfailurezz"));
    await assert.rejects(() => sampleProducts(adapterWith(spy)));
    assert.equal(spy.calls.length, 1);
  });

  it("does not walk pages, even when the envelope reports more", async () => {
    const spy = spyHttp(TWO_PRODUCTS_XML);
    await sampleProducts(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].config.params.pagenumber, 1);
  });

  it("carries a bounded timeout rather than the shared client default", async () => {
    const spy = spyHttp();
    await sampleProducts(adapterWith(spy), { timeoutMs: 4321 });
    assert.equal(spy.calls[0].config.timeout, 4321);
  });

  it("makes one request through the whole certification chain too", async () => {
    const spy = spyHttp();
    await certifyProducts(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });
});

describe("the result envelope is never mistaken for a product", () => {
  it("reads rows from <item>, not from <result>", () => {
    const rows = extractRakutenProducts(ONE_PRODUCT_XML);
    assert.equal(rows.length, 1);
    for (const counter of ["TotalMatches", "TotalPages", "PageNumber"]) {
      assert.ok(!Object.hasOwn(rows[0], counter), counter);
      assert.ok(!Object.hasOwn(rows[0], counter.toLowerCase()), counter);
    }
  });

  it("reports zero rows for an envelope that holds none", () => {
    assert.deepEqual(extractRakutenProducts(EMPTY_XML), []);
  });

  it("yields no rows when the documented envelope is absent", () => {
    const stray = `<?xml version="1.0"?><other><item><mid>zzstraymidzz</mid></item></other>`;
    assert.deepEqual(extractRakutenProducts(stray), []);
  });

  it("survives an empty, malformed or missing body without throwing", () => {
    for (const body of ["", "<result>", "not xml at all", "<html><body>nope</body></html>"]) {
      assert.deepEqual(extractRakutenProducts(body), [], JSON.stringify(body));
    }
  });
});

describe("row parsing", () => {
  it("parses repeated <item> elements as separate rows", () => {
    const rows = extractRakutenProducts(TWO_PRODUCTS_XML);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].mid, rows[1].mid);
    assert.notEqual(rows[0].sku, rows[1].sku);
  });

  it("preserves the nested category levels structurally", () => {
    const row = extractRakutenProducts(ONE_PRODUCT_XML)[0];
    assert.deepEqual(Object.keys(row.category).sort(), ["primary", "secondary"]);
    // Flattening would lose which level a value came from; reading the container as text would
    // concatenate both into one meaningless string.
    assert.notEqual(row.category, "zzprimarycategoryzzzzsecondarycategoryzz");
    assert.equal(typeof row.category, "object");
  });

  it("preserves the nested description levels structurally", () => {
    const row = extractRakutenProducts(ONE_PRODUCT_XML)[0];
    assert.deepEqual(Object.keys(row.description).sort(), ["long", "short"]);
    assert.equal(typeof row.description, "object");
  });

  it("preserves the currency ATTRIBUTE on price and saleprice", () => {
    // The currency lives ON the element, not beside it. A reader seeing only inner content would
    // report an amount with no idea what it is denominated in.
    const row = extractRakutenProducts(ONE_PRODUCT_XML)[0];
    for (const money of ["price", "saleprice"]) {
      assert.deepEqual(Object.keys(row[money]).sort(), ["amount", "currency"], money);
      assert.equal(row[money].currency, "SGD", money);
    }
    assert.notEqual(row.price.amount, row.saleprice.amount);
  });

  it("carries every documented scalar field", () => {
    const row = extractRakutenProducts(ONE_PRODUCT_XML)[0];
    for (const field of [
      "mid",
      "merchantname",
      "linkid",
      "createdon",
      "sku",
      "productname",
      "upccode",
      "keywords",
      "linkurl",
      "imageurl",
    ]) {
      assert.ok(Object.hasOwn(row, field), field);
    }
  });

  it("treats every optional field as optional", () => {
    const row = extractRakutenProducts(MINIMAL_PRODUCT_XML)[0];
    assert.equal(row.mid, "zzminimalmidzz", "the row is kept, not discarded");
    assert.equal(row.category, null);
    assert.equal(row.description, null);
    assert.equal(row.price, null);
    assert.equal(row.saleprice, null);
    assert.equal(row.sku, null);
    assert.equal(row.upccode, null);
  });

  it("keeps the currency when the amount itself is empty", () => {
    const row = extractRakutenProducts(
      `<result><item><price currency="SGD"></price></item></result>`,
    )[0];
    assert.deepEqual(row.price, { currency: "SGD", amount: null });
  });

  it("reads the attribute whatever case the supplier spells it in", () => {
    const row = extractRakutenProducts(
      `<result><item><price CURRENCY="SGD">1.00</price></item></result>`,
    )[0];
    assert.equal(row.price.currency, "SGD");
  });
});

describe("the shared XML utility is reused", () => {
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
    const result = tagBlocks(ONE_PRODUCT_XML, "result")[0];
    const items = tagBlocks(result, "item");
    assert.equal(items.length, 1);
    assert.equal(tagText(items[0], "sku"), "zzskuvaluezz");
    assert.equal(tagBlocksWithAttributes(items[0], "price")[0].attributes.currency, "SGD");
    assert.equal(extractRakutenProducts(ONE_PRODUCT_XML)[0].sku, "zzskuvaluezz");
  });
});

describe("the general read method is bounded and unfilterable beyond the documented set", () => {
  it("reads GET /productsearch/1.0 with the bounded defaults", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchProducts();
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, "/productsearch/1.0");
    assert.deepEqual(spy.calls[0].config.params, { max: 1, pagenumber: 1 });
  });

  it("is an ALLOWLIST over the documented query capabilities", async () => {
    assert.deepEqual([...RAKUTEN_PRODUCT_SEARCH_PARAMS].sort(), [
      "cat",
      "exact",
      "keyword",
      "language",
      "max",
      "mid",
      "none",
      "one",
      "pagenumber",
      "sort",
      "sorttype",
    ]);
    const spy = spyHttp();
    await adapterWith(spy).fetchProducts({
      keyword: "zzallowedzz",
      max: 5,
      pagenumber: 2,
      token: "zzfilteredzz",
      reportid: "zzfilteredzz",
      bogus: "zzfilteredzz",
    });
    assert.deepEqual(spy.calls[0].config.params, { keyword: "zzallowedzz", max: 5, pagenumber: 2 });
    assert.ok(!JSON.stringify(spy.calls[0].config.params).includes("zzfilteredzz"));
  });

  it("falls back to the bounded defaults for absent or nonsense bounds", () => {
    for (const bad of [{}, { max: 0 }, { max: -3 }, { max: "nope" }]) {
      assert.equal(buildRakutenProductSearchParams(bad).max, 1, JSON.stringify(bad));
    }
    for (const bad of [{ pagenumber: 0 }, { pagenumber: -1 }, { pagenumber: "nope" }]) {
      assert.equal(buildRakutenProductSearchParams(bad).pagenumber, 1, JSON.stringify(bad));
    }
  });

  it("makes one request and does not retry or walk pages", async () => {
    const failing = spyHttp(new Error("zzfailzz"));
    await assert.rejects(() => adapterWith(failing).fetchProducts());
    assert.equal(failing.calls.length, 1);

    const multi = spyHttp(TWO_PRODUCTS_XML);
    const rows = await adapterWith(multi).fetchProducts();
    assert.equal(multi.calls.length, 1);
    // The general method returns what one page held; only certification caps rows at one.
    assert.equal(rows.length, 2);
  });

  it("asks for XML as text, because Product Search answers in XML", async () => {
    // Asking for JSON on an XML-only surface is how a supplier ends up returning something the
    // parser cannot read, or refusing the request outright.
    const spy = spyHttp();
    await adapterWith(spy).fetchProducts();
    assert.match(spy.calls[0].config.headers.Accept, /xml/);
    assert.ok(!spy.calls[0].config.headers.Accept.includes("json"));
    assert.equal(spy.calls[0].config.responseType, "text");
  });

  it("counts its request in the stats the sync framework reads", async () => {
    const spy = spyHttp();
    const stats = {};
    await adapterWith(spy).fetchProducts({}, stats);
    assert.equal(stats.requestCount, 1);
  });
});

describe("a product search row is not a canonical product, a link or a feed", () => {
  it("never returns the mid, merchant name, link id, SKU or UPC", async () => {
    const serialised = JSON.stringify(await certifyProducts(adapterWith(spyHttp())));
    for (const secret of [
      "zzmidvaluezz",
      "zzmerchantnamezz",
      "zzlinkidzz",
      "zzskuvaluezz",
      "zzupccodezz",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the product name, descriptions or keywords", async () => {
    const serialised = JSON.stringify(await certifyProducts(adapterWith(spyHttp())));
    for (const secret of [
      "zzproductnamezz",
      "zzshortdescriptionzz",
      "zzlongdescriptionzz",
      "zzkeywordszz",
      "zzprimarycategoryzz",
      "zzsecondarycategoryzz",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns prices, currency values or URLs", async () => {
    const serialised = JSON.stringify(await certifyProducts(adapterWith(spyHttp())));
    for (const secret of [
      "8123.47",
      "4372.19",
      "SGD",
      "zzlinkurlzz",
      "zzimageurlzz",
      "https://",
      "2031-03-17",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns credentials or the raw XML", async () => {
    const serialised = JSON.stringify(await certifyProducts(adapterWith(spyHttp())));
    for (const secret of [
      TOKEN,
      SECURITY_TOKEN,
      "Bearer",
      "<item",
      "<result",
      "zztotalmatcheszz",
      "zzpagenumberzz",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("persists nothing and promotes no link", () => {
    const code = implementationOf(ADAPTER_SRC);
    const service = implementationOf(SERVICE_SRC);
    for (const forbidden of [
      "ProductFeedItem",
      "ProductFeed",
      "ProductSource",
      "TrackingLink",
      "ClientCampaignAssignment",
      "persistProduct",
      "saveProduct",
      "buildDeepLink",
    ]) {
      assert.ok(!code.includes(forbidden), `adapter: ${forbidden}`);
      assert.ok(!service.includes(forbidden), `service: ${forbidden}`);
    }
  });

  it("makes no canonical, tracking-link or feed claim in the result", async () => {
    const serialised = JSON.stringify(await certifyProducts(adapterWith(spyHttp())));
    for (const claim of [
      "CANONICAL_PRODUCT",
      "TRACKING_LINK_USABLE",
      "PRODUCT_FEED_AVAILABLE",
      "trackingLink",
      "productFeed",
      "deepLink",
    ]) {
      assert.ok(!serialised.includes(claim), claim);
    }
  });

  it("declares no PRODUCTS capability, because no ingestion exists", () => {
    const caps = adapterWith(spyHttp()).getCapabilities();
    assert.ok(!caps.capabilities.includes("PRODUCTS"));
    assert.ok(caps.notes.some((note) => note.includes("/productsearch/1.0")));
    assert.ok(caps.notes.some((note) => note.includes("not evidence that a bulk product feed")));
  });

  it("is called by no sync job", () => {
    // Impact's sync calls adapter.fetchProducts for its own catalogs object. Rakuten's does not,
    // so adding the method starts no ingestion — proved here rather than assumed.
    const rakutenSync = codeOf(readFileSync("src/jobs/rakutenSupplierSync.js", "utf8"));
    assert.ok(!rakutenSync.includes("fetchProducts"));
    assert.ok(!rakutenSync.includes("product"));
  });
});

describe("the products outcome vocabulary", () => {
  it("is registered under the catalog's own source-object name", () => {
    assert.ok(listProbeSourceObjects("rakuten").includes("products"));
    assert.equal(getSourceObject("rakuten", "products")?.entityType, "product");
    for (const invented of ["product_search", "productsearch", "product_feeds"]) {
      assert.ok(!listProbeSourceObjects("rakuten").includes(invented), invented);
      assert.equal(getSourceObject("rakuten", invented), null, invented);
    }
  });

  it("names the real request contract in its endpointKey", async () => {
    const row = (await certifyProducts(adapterWith(spyHttp()))).results[0];
    assert.equal(row.endpointKey, "GET /productsearch/1.0 (max=1, pagenumber=1, no filter)");
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "products");
  });

  it("reports OK with a structural field dictionary when a row is parsed", async () => {
    const row = (await certifyProducts(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);

    const paths = row.fieldPaths.map((f) => f.path);
    for (const expected of [
      "mid",
      "sku",
      "category",
      "category.primary",
      "category.secondary",
      "description.short",
      "description.long",
      "price",
      "price.currency",
      "price.amount",
      "saleprice.currency",
    ]) {
      assert.ok(paths.includes(expected), expected);
    }
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
    const row = (await certifyProducts(adapterWith(spyHttp()))).results[0];
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
    }
  });

  it("marks the nested containers and the currency attribute structurally", async () => {
    const byPath = Object.fromEntries(
      (await certifyProducts(adapterWith(spyHttp()))).results[0].fieldPaths.map((f) => [f.path, f]),
    );
    assert.equal(byPath.category.observedType, "OBJECT");
    assert.equal(byPath.category.objectObserved, true);
    assert.equal(byPath.price.observedType, "OBJECT");
    assert.equal(byPath["price.currency"].observedType, "CURRENCY_CODE");
    assert.equal(byPath.linkurl.observedType, "URL");
  });

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for an empty result", async () => {
    const row = (await certifyProducts(adapterWith(spyHttp(EMPTY_XML)))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK_NO_ROWS");
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
  });

  it("invents no partnership or unsupported finding from emptiness", async () => {
    // Product Search searches PARTNER-advertisers, which makes "no joined campaigns" a plausible
    // READING of an empty result. A plausible reading is not evidence.
    const row = (await certifyProducts(adapterWith(spyHttp(EMPTY_XML)))).results[0];
    assert.ok(!Object.hasOwn(row, "accountStateBlocker"));
    const serialised = JSON.stringify(await certifyProducts(adapterWith(spyHttp(EMPTY_XML))));
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

  it("preserves an auth rejection safely", async () => {
    const error = new Error("zzupstreamauthmessagezz");
    error.response = { status: 401, data: { message: "zzupstreambodyzz" } };
    const row = (await certifyProducts(adapterWith(spyHttp(error)))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.equal(row.supplierStatusCode, 401);
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(TOKEN));
    assert.ok(!serialised.includes("zzupstreambodyzz"));
  });

  it("preserves a supplier validation failure safely", async () => {
    // This is the answer that would tell us a filter is required.
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: {} };
    const row = (await certifyProducts(adapterWith(spyHttp(error)))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
  });
});

describe("the sample is bounded to one row, twice and independently", () => {
  it("slices in the adapter", async () => {
    assert.equal(RAKUTEN_CERTIFICATION_MAX_ROWS, 1);
    assert.equal((await sampleProducts(adapterWith(spyHttp(TWO_PRODUCTS_XML)))).length, 1);
  });

  it("slices again in the service, independently of the adapter", async () => {
    const unbounded = {
      ...adapterWith(spyHttp(TWO_PRODUCTS_XML)),
      fetchCertificationSample: async () => extractRakutenProducts(TWO_PRODUCTS_XML),
    };
    assert.equal(extractRakutenProducts(TWO_PRODUCTS_XML).length, 2);
    assert.equal((await certifyProducts(unbounded)).results[0].sampleCount, 1);
  });

  it("never returns the second row's values", async () => {
    const serialised = JSON.stringify(await certifyProducts(adapterWith(spyHttp(TWO_PRODUCTS_XML))));
    for (const secret of ["zzsecondmidzz", "zzsecondskuzz", "2222.22", "zzfirstmidzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });
});

describe("read-only, and every other Rakuten object unchanged", () => {
  it("performs no database read or write", async () => {
    assert.equal((await certifyProducts(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain that certifies this object", () => {
    const code = codeOf(SERVICE_SRC);
    const chain = code.slice(
      code.indexOf("async certifyRakutenSample("),
      code.indexOf("async certifyRakutenAdvancedReport("),
    );
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("is catalogued live as a read path, claiming no ingestion or feed", () => {
    const entry = getSourceObject("rakuten", "products");
    assert.equal(entry.endpoint, "GET /productsearch/1.0");
    assert.equal(entry.live, true);
    assert.match(entry.notes, /nothing is persisted/i);
    assert.match(entry.notes, /not a product feed/i);
    assert.match(entry.notes, /unfiltered search is not yet established/i);
  });

  it("leaves Link Locator declared, since it has no general read method", () => {
    assert.equal(getSourceObject("rakuten", "links").live, false);
  });

  it("leaves every other Rakuten object sending its own request unchanged", async () => {
    const jsonSpy = spyHttp({ advertisers: [{ id: "zzadvzz" }] });
    await adapterWith(jsonSpy).fetchCertificationSample("advertisers", {});
    assert.equal(jsonSpy.calls[0].path, "/v2/advertisers");
    assert.deepEqual(jsonSpy.calls[0].config.params, { limit: 1, page: 1 });

    const couponSpy = spyHttp("<couponfeed></couponfeed>");
    await adapterWith(couponSpy).fetchCertificationSample("coupons", {});
    assert.equal(couponSpy.calls[0].path, "/coupon/1.0");
    assert.deepEqual(couponSpy.calls[0].config.params, { resultsperpage: 1, pagenumber: 1 });

    const eventSpy = spyHttp([]);
    await adapterWith(eventSpy).fetchCertificationSample("events", {
      window: { from: "2026-09-08", to: "2026-09-15", preset: "7d" },
    });
    assert.equal(eventSpy.calls[0].path, "/events/1.0/transactions");
    assert.equal(eventSpy.calls[0].config.params.limit, 1);
  });

  it("names a probe for every declared spec", () => {
    for (const sourceObject of Object.keys(RAKUTEN_CERTIFICATION_SPECS)) {
      assert.ok(listProbeSourceObjects("rakuten").includes(sourceObject), sourceObject);
    }
  });
});
