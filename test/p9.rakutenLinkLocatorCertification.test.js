import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
// Used to prove the operation survives real URL building, not just string equality.
import axios from "axios";

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
  RAKUTEN_TEXT_LINKS_REJECTED_PATHS,
  RAKUTEN_TEXT_LINKS_RESOURCE,
  buildRakutenTextLinksIsolationPath,
  rakutenLinkDateParam,
} = await import("../src/adapters/rakuten.adapter.js");
const {
  DEFAULT_WINDOW_PRESET,
  NetworkCertificationService,
  WINDOW_PRESETS,
  listProbeSourceObjects,
} = await import("../src/modules/ops/networkCertification.service.js");
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

/**
 * A bounded window in exactly the shape the service computes one: ISO YYYY-MM-DD, UTC, plus the
 * preset that produced it. Fixed dates rather than a live 7d window, so the expected MMDDYYYY
 * path is a literal a reader can check by eye instead of a second computation of the thing under
 * test.
 */
const WINDOW = Object.freeze({ from: "2026-09-08", to: "2026-09-15", preset: "7d" });

/** What WINDOW must produce. Written out, never derived from the builder. */
const WINDOW_PATH = "/linklocator/1.0/getTextLinks/-1/-1/09082026/09152026/-1/1";

/** Every links sample needs the window; the adapter refuses without one. */
async function sampleLinks(adapter, options = {}) {
  return adapter.fetchCertificationSample("links", { window: WINDOW, ...options });
}

/** The isolation shape, with the two date slots left free. */
function isolationSegments(path) {
  return path.split(`${RAKUTEN_TEXT_LINKS_RESOURCE}/`)[1]?.split("/") ?? [];
}

async function certifyLinks(adapter) {
  return serviceWith(adapter).certify("rakuten", { sourceObjects: ["links"] });
}

describe("the explicit-date isolation URL contract", () => {
  it("uses the official slash path form, with the operation as a path segment", () => {
    assert.equal(RAKUTEN_TEXT_LINKS_RESOURCE, "/linklocator/1.0/getTextLinks");
    assert.ok(buildRakutenTextLinksIsolationPath(WINDOW).startsWith("/linklocator/1.0/getTextLinks/"));
  });

  it("builds the path from the window and nothing else", () => {
    assert.equal(buildRakutenTextLinksIsolationPath(WINDOW), WINDOW_PATH);
    // No static path on the spec at all: there is nothing to send if no window arrives.
    assert.equal(RAKUTEN_CERTIFICATION_SPECS.links.path, undefined);
    assert.equal(
      RAKUTEN_CERTIFICATION_SPECS.links.buildPath,
      buildRakutenTextLinksIsolationPath,
    );
  });

  it("carries the six documented segments in order, with both dates EXPLICIT", () => {
    const segments = isolationSegments(buildRakutenTextLinksIsolationPath(WINDOW));
    assert.deepEqual(segments, ["-1", "-1", "09082026", "09152026", "-1", "1"]);

    const [advertiserId, categoryId, startDate, endDate, deprecatedCampaignId, page] = segments;
    assert.equal(advertiserId, "-1", "advertiser-id");
    assert.equal(categoryId, "-1", "category-id");
    assert.match(startDate, /^[0-9]{8}$/, "link-start-date must be an explicit MMDDYYYY");
    assert.match(endDate, /^[0-9]{8}$/, "link-end-date must be an explicit MMDDYYYY");
    assert.equal(deprecatedCampaignId, "-1", "DEPRECATED-campaign-id");
    assert.equal(page, "1", "page");
  });

  it("leaves NO empty segment anywhere in the path", () => {
    // The whole hypothesis: an empty path segment is what a router may collapse before Rakuten's
    // dispatch sees it, shifting every later segment into the wrong slot.
    const path = buildRakutenTextLinksIsolationPath(WINDOW);
    assert.ok(!path.includes("//"), "adjacent separators are what this probe exists to remove");
    for (const segment of path.split("/").slice(1)) {
      assert.notEqual(segment, "", "every slot carries a value");
    }
  });

  it("changes exactly ONE variable against the two rejected probes", () => {
    // If more than the dates moved, neither outcome would settle anything.
    const isolation = isolationSegments(buildRakutenTextLinksIsolationPath(WINDOW));
    const rejectedSlashSegments = RAKUTEN_TEXT_LINKS_REJECTED_PATHS[0]
      .split("/linklocator/1.0/getTextLinks/")[1]
      .split("/");

    assert.equal(isolation.length, rejectedSlashSegments.length, "same arity");
    const movedSlots = isolation
      .map((value, index) => (value === rejectedSlashSegments[index] ? null : index))
      .filter((index) => index !== null);
    assert.deepEqual(movedSlots, [2, 3], "only the two date slots differ");
  });

  it("does NOT reuse either shape Rakuten answered 500 to", () => {
    assert.deepEqual(RAKUTEN_TEXT_LINKS_REJECTED_PATHS, [
      "/linklocator/1.0/getTextLinks/-1/-1///-1/1",
      "/linklocator/1.0?getTextLinks/-1/-1///-1/1",
    ]);
    const path = buildRakutenTextLinksIsolationPath(WINDOW);
    for (const rejected of RAKUTEN_TEXT_LINKS_REJECTED_PATHS) {
      assert.notEqual(path, rejected);
    }
    // The query-operation shape specifically: no "?" survives anywhere.
    assert.ok(!path.includes("?"), "the operation is a path segment again, not a query string");
  });

  it("renders MMDDYYYY, not ISO and not DDMMYYYY", () => {
    assert.equal(rakutenLinkDateParam("2026-09-08"), "09082026");
    assert.equal(rakutenLinkDateParam("2026-12-31"), "12312026");
    // 08 vs 09 in the leading pair is what separates MMDD from DDMM, so this pair is the test.
    assert.notEqual(rakutenLinkDateParam("2026-09-08"), "08092026");
    assert.ok(!rakutenLinkDateParam("2026-09-08").includes("-"));
    assert.equal(rakutenLinkDateParam("2026-09-08").length, 8);
  });

  it("pads single-digit months and days", () => {
    assert.equal(rakutenLinkDateParam("2026-01-02"), "01022026");
  });

  it("reads the window in UTC, so the day cannot shift by one", () => {
    assert.equal(rakutenLinkDateParam("2026-09-08T23:59:59.999Z"), "09082026");
    assert.equal(rakutenLinkDateParam("2026-09-08T00:00:00.000Z"), "09082026");
  });

  it("still reads UTC when the process runs in a negative-offset zone", () => {
    // Asserting this in-process proves nothing: the test container IS UTC, so local and UTC
    // accessors agree and a local-time renderer would pass. So run it where they disagree.
    //
    // The window's from/to are bare "YYYY-MM-DD" strings, which parse as UTC MIDNIGHT — the worst
    // possible instant for a local reader. In America/Los_Angeles that midnight is 17:00 the
    // PREVIOUS day, so a local-time renderer emits 09072026 and this probe silently asks Rakuten
    // for a different window than the one the run reports.
    const script = `
      process.env.BACKEND_URL = "https://backend.test";
      process.env.FRONTEND_URL = "https://frontend.test";
      process.env.JWT_SECRET = "test-jwt-secret-value-only";
      process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
      const m = await import("./src/adapters/rakuten.adapter.js");
      process.stdout.write(
        JSON.stringify({
          tzOffsetMinutes: new Date("2026-09-08").getTimezoneOffset(),
          rendered: m.rakutenLinkDateParam("2026-09-08"),
          path: m.buildRakutenTextLinksIsolationPath({ from: "2026-09-08", to: "2026-09-15" }),
        }),
      );
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: "America/Los_Angeles" },
      encoding: "utf8",
    });
    const result = JSON.parse(out);

    // Guard the guard: if the child were somehow still UTC, this test would prove nothing.
    assert.ok(result.tzOffsetMinutes > 0, "the child must actually run behind UTC");
    assert.equal(result.rendered, "09082026");
    assert.notEqual(result.rendered, "09072026", "a local-time read would land on the day before");
    assert.equal(result.path, WINDOW_PATH);
  });

  it("refuses to build a path when a date cannot be rendered", () => {
    // Otherwise the probe would send "null" into a date slot and certify the wrong thing.
    for (const broken of [{}, { from: "2026-09-08" }, { to: "2026-09-15" }, { from: "nope", to: "nope" }]) {
      assert.throws(() => buildRakutenTextLinksIsolationPath(broken), /bounded window/);
    }
    assert.equal(rakutenLinkDateParam("not-a-date"), null);
  });

  it("refuses to sample links at all without a window, and makes NO supplier request", async () => {
    const spy = spyHttp();
    await assert.rejects(
      () => adapterWith(spy).fetchCertificationSample("links", {}),
      /requires window/,
    );
    assert.equal(spy.calls.length, 0, "the refusal costs no supplier call");
    assert.deepEqual([...RAKUTEN_CERTIFICATION_SPECS.links.needs], ["window"]);
  });

  it("sends that URL verbatim", async () => {
    const spy = spyHttp();
    await sampleLinks(adapterWith(spy));
    assert.equal(spy.calls[0].path, WINDOW_PATH);
  });

  it("survives axios URL building without the operation being altered", async () => {
    const spy = spyHttp();
    await sampleLinks(adapterWith(spy));
    const built = axios.getUri({ url: spy.calls[0].path, params: spy.calls[0].config.params });
    assert.equal(built, WINDOW_PATH);
    assert.ok(!built.includes("?"), "no query string is introduced");
    assert.ok(!built.includes("&"));
  });

  it("would gain a query string from any parameter, which is why none is sent", () => {
    // pathBounded stays load-bearing: Link Locator takes its bounds in the path, so a params
    // object would append a query string the operation never documented.
    const corrupted = axios.getUri({ url: WINDOW_PATH, params: { limit: 1, page: 1 } });
    assert.equal(corrupted, `${WINDOW_PATH}?limit=1&page=1`);
    assert.ok(corrupted.includes("limit="), "this is the shape the probe must never send");
  });

  it("sends NO query parameters at all", async () => {
    const spy = spyHttp();
    await sampleLinks(adapterWith(spy));
    assert.deepEqual(spy.calls[0].config.params, {});
  });

  it("invents no results-per-page bound, because Rakuten documents none", async () => {
    const spy = spyHttp();
    await sampleLinks(adapterWith(spy));
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
    await sampleLinks(adapterWith(spy));
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

  it("leaves the undated objects needing no window and taking no dates", async () => {
    // Only links is dated. A window reaching advertisers or offers would be a silent scope change.
    for (const [name, spec] of Object.entries(RAKUTEN_CERTIFICATION_SPECS)) {
      if (name === "links") continue;
      assert.equal(spec.needs, undefined, `${name} must not need a window`);
      assert.equal(spec.buildPath, undefined, `${name} must keep its static path`);
    }
    const spy = spyHttp({ advertisers: [{ id: 1 }] });
    await adapterWith(spy).fetchCertificationSample("advertisers", { window: WINDOW });
    assert.equal(spy.calls[0].path, "/v2/advertisers");
    assert.deepEqual(spy.calls[0].config.params, { limit: 1, page: 1 });
  });

  it("uses the Bearer only — no web security token", async () => {
    const spy = spyHttp();
    const bearerOnly = createRakutenAdapter({ accessToken: TOKEN, httpClient: spy.client });
    assert.equal((await sampleLinks(bearerOnly)).length, 1);
    assert.ok(!JSON.stringify(spy.calls[0]).includes(SECURITY_TOKEN));
    assert.ok(!JSON.stringify(spy.calls[0]).includes("advancedreports"));
  });
});

describe("the window is the service's, and it is required", () => {
  /** Days between the two MMDDYYYY slots of whatever path actually went out. */
  function windowDays(path) {
    const [start, end] = isolationSegments(path).slice(2, 4);
    const asUtc = (d) =>
      Date.UTC(Number(d.slice(4)), Number(d.slice(0, 2)) - 1, Number(d.slice(2, 4)));
    return (asUtc(end) - asUtc(start)) / 86400000;
  }

  it("defaults to the existing 7d preset", async () => {
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy));
    assert.equal(DEFAULT_WINDOW_PRESET, "7d");
    assert.equal(WINDOW_PRESETS["7d"], 7);
    assert.equal(windowDays(spy.calls[0].path), 7);
  });

  it("honours a wider preset when one is selected", async () => {
    const spy = spyHttp();
    await serviceWith(adapterWith(spy)).certify("rakuten", {
      sourceObjects: ["links"],
      windowPreset: "30d",
    });
    assert.equal(windowDays(spy.calls[0].path), 30);
  });

  it("falls back to the default rather than honouring an arbitrary preset", async () => {
    const spy = spyHttp();
    await serviceWith(adapterWith(spy)).certify("rakuten", {
      sourceObjects: ["links"],
      windowPreset: "9999d",
    });
    assert.equal(windowDays(spy.calls[0].path), 7);
  });

  it("accepts no caller-supplied dates", () => {
    // A caller picks a PRESET TOKEN. It never supplies a date, and a date is what lands in the URL
    // path here — so a caller-reachable date would be a caller-reachable path segment.
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyRakutenSample")[1]
      .split("async certifyAwinCommissionGroups")[0];
    for (const leak of ["req.body", "req.query", "options.from", "params.from", "ctx.from"]) {
      assert.ok(!chain.includes(leak), leak);
    }
    assert.match(codeOf(SERVICE_SRC), /window: \{ \.\.\.ctx\.window, preset: resolvedWindowPreset \}/);
  });

  it("refuses a half-open window, and makes NO supplier request", async () => {
    for (const partial of [{ from: "2026-09-08" }, { to: "2026-09-15" }, {}]) {
      const spy = spyHttp();
      await assert.rejects(
        () => adapterWith(spy).fetchCertificationSample("links", { window: partial }),
        (error) => /requires/.test(error.message),
        JSON.stringify(partial),
      );
      assert.equal(spy.calls.length, 0, JSON.stringify(partial));
    }
  });

  it("refuses an unparseable date rather than sending it", async () => {
    const spy = spyHttp();
    await assert.rejects(
      () => adapterWith(spy).fetchCertificationSample("links", { window: { from: "nope", to: "nope" } }),
      /bounded window/,
    );
    assert.equal(spy.calls.length, 0);
  });
});

describe("exactly one request, no retry, no pagination", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await sampleLinks(adapterWith(spy), { timeoutMs: 5000 });
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a supplier rejection", async () => {
    const boom = Object.assign(new Error("upstream"), { response: { status: 500 } });
    const spy = spyHttp(boom);
    await assert.rejects(() => sampleLinks(adapterWith(spy)));
    assert.equal(spy.calls.length, 1);
  });

  it("does not request a second page even when the response is full", async () => {
    const many = `<getTextLinksResponse>${"<return><linkID>zzxzz</linkID></return>".repeat(50)}</getTextLinksResponse>`;
    const spy = spyHttp(many);
    await sampleLinks(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, WINDOW_PATH);
  });

  it("makes exactly one request for a full certification run", async () => {
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("applies the certification timeout", async () => {
    const spy = spyHttp();
    await sampleLinks(adapterWith(spy), { timeoutMs: 4321 });
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
    const rows = await sampleLinks(adapterWith(spy));
    assert.equal(rows.length, 1);
    assert.equal(RAKUTEN_CERTIFICATION_MAX_ROWS, 1);
  });

  it("keeps one row when the supplier returns fifty", async () => {
    const many = `<getTextLinksResponse>${"<return><linkID>zzxzz</linkID></return>".repeat(50)}</getTextLinksResponse>`;
    const spy = spyHttp(many);
    assert.equal((await sampleLinks(adapterWith(spy))).length, 1);
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
    assert.ok(!WINDOW_PATH.includes("limit"));
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
  it("is registered with an endpointKey naming the REAL request contract", async () => {
    assert.ok(listProbeSourceObjects("rakuten").includes("links"));
    const row = (await certifyLinks(adapterWith(spyHttp()))).results[0];
    assert.equal(
      row.endpointKey,
      "GET /linklocator/1.0/getTextLinks/-1/-1/{MMDDYYYY-start}/{MMDDYYYY-end}/-1/1 (explicit-date isolation)",
    );
    // Says WHAT this probe is, so a reader cannot mistake it for the settled contract.
    assert.ok(row.endpointKey.includes("explicit-date isolation"));
    // Carries no date VALUE: the key is a stable template, the same across every run.
    assert.ok(!/\/[0-9]{8}\//.test(row.endpointKey), "no rendered date may appear in the key");
    // Neither rejected shape: no blank slots, no query-string operation.
    assert.ok(!row.endpointKey.includes("///"));
    assert.ok(!row.endpointKey.includes("1.0?getTextLinks"));
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "links");
  });

  it("reports the window preset the dates came from, and only for this dated object", async () => {
    const row = (await certifyLinks(adapterWith(spyHttp()))).results[0];
    assert.equal(row.windowPreset, "7d");

    // The REPORTED preset must follow the selected one, or a 30d probe would file its findings
    // under 7d and an operator could not tell which window a result belongs to.
    const wider = (
      await serviceWith(adapterWith(spyHttp())).certify("rakuten", {
        sourceObjects: ["links"],
        windowPreset: "30d",
      })
    ).results[0];
    assert.equal(wider.windowPreset, "30d");

    // advertisers carries no dates, so claiming a window bounded it would be a false statement.
    const jsonSpy = spyHttp({ advertisers: [{ id: 1 }] });
    const other = (
      await serviceWith(adapterWith(jsonSpy)).certify("rakuten", { sourceObjects: ["advertisers"] })
    ).results[0];
    assert.ok(!Object.hasOwn(other, "windowPreset"));
  });

  it("sends a real derived window through the service, not the test fixture", async () => {
    // certify() computes its own window from the frozen preset. Proving the SHAPE that reaches the
    // supplier is what matters: two explicit eight-digit dates, seven days apart, no empty slot.
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy));
    const segments = isolationSegments(spy.calls[0].path);
    assert.equal(segments.length, 6);
    assert.deepEqual([segments[0], segments[1], segments[4], segments[5]], ["-1", "-1", "-1", "1"]);
    assert.match(segments[2], /^[0-9]{8}$/);
    assert.match(segments[3], /^[0-9]{8}$/);
    assert.ok(!spy.calls[0].path.includes("//"));

    const asDate = (mmddyyyy) =>
      Date.UTC(Number(mmddyyyy.slice(4)), Number(mmddyyyy.slice(0, 2)) - 1, Number(mmddyyyy.slice(2, 4)));
    assert.equal((asDate(segments[3]) - asDate(segments[2])) / 86400000, 7, "the 7d preset");
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
    for (const absent of ["getBannerLinks", "getDRMLinks", "createDeepLink", "fetchProducts", "fetchLinks"]) {
      assert.ok(!code.includes(absent), absent);
    }
    // fetchCoupons was built later, against a different API. It is not a Link Locator operation.
    assert.ok(!code.includes("linklocator/1.0/getCoupons"));
  });

  it("declares exactly one Link Locator operation", () => {
    const code = codeOf(ADAPTER_SRC);
    // Every linklocator string is accounted for: the one live resource, plus the rejected shapes
    // kept as evidence. One operation, however many strings name it.
    const expected = 1 + RAKUTEN_TEXT_LINKS_REJECTED_PATHS.length;
    assert.equal((code.match(/linklocator/g) ?? []).length, expected);
    assert.equal((code.match(/getTextLinks/g) ?? []).length, expected);
    // And no SECOND Link Locator operation has crept in alongside it.
    for (const other of [
      "getBannerLinks",
      "getTextLinksVersion",
      "getAdvertiserNames",
      "getCreativeCategories",
      "getDRMLinks",
    ]) {
      assert.ok(!code.includes(other), other);
    }
  });

  it("keeps the rejected shapes as evidence only, never as something sent", async () => {
    const spy = spyHttp();
    await certifyLinks(adapterWith(spy));
    for (const rejected of RAKUTEN_TEXT_LINKS_REJECTED_PATHS) {
      assert.notEqual(spy.calls[0].path, rejected);
    }
    // Frozen, so no code path can edit the record of what Rakuten refused.
    assert.ok(Object.isFrozen(RAKUTEN_TEXT_LINKS_REJECTED_PATHS));
  });

  it("adds no probe for the objects still deferred", () => {
    for (const notYet of ["events", "advanced_reports", "payments", "products"]) {
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
    await sampleLinks(adapterWith(spy));
    await adapterWith(jsonSpy).fetchCertificationSample("advertisers", {});
    assert.equal(spy.calls[0].path, WINDOW_PATH);
    assert.equal(jsonSpy.calls[0].path, "/v2/advertisers");
  });
});
