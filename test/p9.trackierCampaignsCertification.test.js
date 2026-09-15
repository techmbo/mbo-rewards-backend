import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { createTrackierAdapter, TRACKIER_CAMPAIGNS_PATH, TRACKIER_PROFILE_PATH } = await import(
  "../src/adapters/trackier.adapter.js"
);
const {
  NetworkCertificationService,
  TRACKIER_CERTIFICATION_CAMPAIGN_PARAMS,
  listProbeSourceObjects,
} = await import("../src/modules/ops/networkCertification.service.js");
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/trackier.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/sync.job.js", "utf8");

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
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

const API_KEY = "zztrackierapikeyzz";

/**
 * One campaign row, carrying BOTH statuses the supplier can send.
 *
 * Field names plausible, every value a distinctive marker: a realistic campaign name is
 * indistinguishable by substring from a path named title.
 */
const CAMPAIGN = {
  id: "zzcampaignidzz",
  _id: "zzcampaignobjectidzz",
  title: "zzcampaignnamezz",
  advertiser: {
    id: "zzadvertiseridzz",
    name: "zzmerchantnamezz",
  },
  status: "zzcampaignstatuszz",
  applicationStatus: "zzapplicationstatuszz",
  publisherApproval: "zzapprovalmodezz",
  previewUrl: "https://zzpreviewzz.example/landing",
  trackingLink: "https://zztrackingzz.example/click",
  logo: "https://zzlogozz.example/logo.png",
  payouts: [
    { id: "zzpayoutidzz", revenue: 4372.19, payout: 8123.47, currency: "SGD" },
  ],
  categories: ["zzcategoryzz"],
  createdAt: "2031-03-17",
};

const SECOND_CAMPAIGN = {
  id: "zzsecondcampaignidzz",
  title: "zzsecondnamezz",
  status: "zzsecondstatuszz",
};

function spyHttp(pages = [{ campaigns: [CAMPAIGN] }]) {
  const calls = [];
  const sequence = Array.isArray(pages) ? pages : [pages];
  let index = 0;
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, config });
        const next = sequence[Math.min(index, sequence.length - 1)];
        index += 1;
        if (next instanceof Error) throw next;
        return { data: next };
      },
    },
  };
}

function adapterWith(spy) {
  return createTrackierAdapter({ apiKey: API_KEY, httpClient: spy.client });
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
    trackierCredentialResolver: async () => ({ apiKey: API_KEY }),
  });
}

async function certifyCampaigns(adapter) {
  return serviceWith(adapter).certify("trackier", { sourceObjects: ["campaigns"] });
}

describe("the documented campaigns request contract", () => {
  it("addresses exactly GET /v2/publisher/campaigns", async () => {
    assert.equal(TRACKIER_CAMPAIGNS_PATH, "/v2/publisher/campaigns");
    // Singular "publisher" here, plural "publishers" on the profile — Trackier's own spelling.
    assert.notEqual(TRACKIER_CAMPAIGNS_PATH, TRACKIER_PROFILE_PATH);
    const spy = spyHttp();
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/v2/publisher/campaigns");
  });

  it("is a GET, and the endpointKey names the bounds", async () => {
    const row = (await certifyCampaigns(adapterWith(spyHttp()))).results[0];
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.endpointKey, "GET /v2/publisher/campaigns (limit=1, page=1)");
    assert.equal(row.sourceObject, "campaigns");
    assert.equal(row.network, "trackier");
  });

  it("sends limit=1 and page=1, and nothing else", async () => {
    const spy = spyHttp();
    await certifyCampaigns(adapterWith(spy));
    assert.deepEqual(spy.calls[0].config.params, { limit: 1, page: 1 });
    assert.deepEqual({ ...TRACKIER_CERTIFICATION_CAMPAIGN_PARAMS }, { limit: 1, page: 1 });
    assert.ok(Object.isFrozen(TRACKIER_CERTIFICATION_CAMPAIGN_PARAMS));
  });

  it("does not inherit production's page size", async () => {
    // fetchCampaigns defaults limit to TRACKIER_PAGE_LIMIT (100). The probe's own limit overrides
    // it, so the supplier is asked for one row rather than a hundred thrown away.
    const spy = spyHttp();
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls[0].config.params.limit, 1);
    assert.match(codeOf(ADAPTER_SRC), /const TRACKIER_PAGE_LIMIT = Number\(process\.env\.TRACKIER_PAGE_LIMIT \|\| 100\)/);
  });

  it("reuses the X-Api-Key auth, with no second header scheme", async () => {
    const spy = spyHttp();
    await certifyCampaigns(adapterWith(spy));
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /"X-Api-Key": String\(apiKey\)/);
    assert.ok(!code.includes("Authorization"));
    assert.ok(!code.includes("Bearer"));
    // The key is set once, on the shared client — never re-sent per request.
    assert.ok(!JSON.stringify(spy.calls[0].config).includes(API_KEY));
  });

  it("carries a bounded timeout", async () => {
    const spy = spyHttp();
    await certifyCampaigns(adapterWith(spy));
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
  });

  it("is catalogued under the existing source object, unchanged", () => {
    const entry = getSourceObject("trackier", "campaigns");
    assert.ok(entry);
    assert.equal(entry.endpoint, "GET /v2/publisher/campaigns");
    assert.equal(entry.live, true);
    assert.equal(entry.entityType, "campaign");
    assert.ok(listProbeSourceObjects("trackier").includes("campaigns"));
    for (const invented of ["campaign", "campaign_list", "offers"]) {
      assert.ok(!listProbeSourceObjects("trackier").includes(invented), invented);
    }
  });
});

describe("exactly one request, no retry, no pagination", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("stops even though a one-row page LOOKS full", async () => {
    // This is the whole reason singlePage exists. At limit=1, rowsCount >= pageSize is true, so
    // the pager's own stop condition never fires and it would ask for page 2, 3, 4...
    const spy = spyHttp([
      { campaigns: [CAMPAIGN] },
      { campaigns: [SECOND_CAMPAIGN] },
      { campaigns: [SECOND_CAMPAIGN] },
    ]);
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].config.params.page, 1);
  });

  it("proves the unbounded pager really would have walked on", async () => {
    // The counter-example: the same responses, through production's own call shape, keep going.
    const spy = spyHttp([
      { campaigns: [CAMPAIGN] },
      { campaigns: [SECOND_CAMPAIGN] },
      { campaigns: [] },
    ]);
    await adapterWith(spy).fetchCampaigns({ limit: 1, page: 1 });
    assert.ok(spy.calls.length > 1, "production pages; certification must not");
  });

  it("does not retry a failed request", async () => {
    // Production allows six attempts. Certification pins it to one.
    const spy = spyHttp([new Error("zzsupplierfailurezz")]);
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a retryable status either", async () => {
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp([error]);
    await certifyCampaigns(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("pins the bounds in the chain, and leaves production's defaults alone", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCampaigns")[1]
      .split("\n  }")[0];
    assert.match(chain, /singlePage: true/);
    assert.match(chain, /retries: 1/);
    assert.match(chain, /timeoutMs/);
    assert.match(codeOf(ADAPTER_SRC), /retries: 6, delayMs: 2000/);
    assert.match(codeOf(ADAPTER_SRC), /\{ singlePage = false, retries, timeoutMs \} = \{\}/);
  });
});

describe("the existing fetcher is reused, not duplicated", () => {
  it("calls production's own fetchCampaigns", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCampaigns")[1]
      .split("\n  }")[0];
    assert.match(chain, /adapter\.fetchCampaigns\(/);
    assert.ok(!chain.includes("createHttpClient"));
    assert.ok(!chain.includes("httpClient.get"));
    assert.ok(!chain.includes("/v2/publisher"));
    assert.ok(!chain.includes("axios"));
  });

  it("keeps the path, rate limiter and row extraction in the adapter's one place", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/"\/v2\/publisher\/campaigns"/g) ?? []).length, 1);
    const pager = code.split("async function fetchCampaignPages")[1].split("\n}")[0];
    assert.match(pager, /requestWithRateLimit\(/);
    assert.match(pager, /extractRows\(response\.data, \["campaigns"\]\)/);
    assert.equal((pager.match(/httpClient\.get\(/g) ?? []).length, 1);
  });

  it("adds no second campaigns fetcher", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/fetchCampaigns\(/g) ?? []).length, 1);
    assert.equal((code.match(/async function fetchCampaignPages\(/g) ?? []).length, 1);
    for (const invented of ["fetchCertificationCampaigns", "fetchCampaignsBounded"]) {
      assert.ok(!code.includes(invented), invented);
    }
  });

  it("extracts the campaigns envelope the way production does", async () => {
    // Same extractor, so an envelope shape production reads, certification reads.
    for (const body of [{ campaigns: [CAMPAIGN] }, { data: { campaigns: [CAMPAIGN] } }, [CAMPAIGN]]) {
      const spy = spyHttp([body]);
      const row = (await certifyCampaigns(adapterWith(spy))).results[0];
      assert.equal(row.sampleCount, 1, JSON.stringify(Object.keys(body)));
    }
  });
});

describe("production behaviour is unchanged", () => {
  it("leaves fetchCampaigns() with no arguments paginating exactly as before", async () => {
    // count drives hasMoreCampaignPages at production's page size: 1 * 100 < 250, so it walks on.
    const spy = spyHttp([
      { campaigns: [CAMPAIGN], count: 250 },
      { campaigns: [SECOND_CAMPAIGN], count: 250 },
      { campaigns: [] },
    ]);
    const rows = await adapterWith(spy).fetchCampaigns();
    assert.ok(spy.calls.length > 1, "still pages");
    assert.equal(spy.calls[0].config.params.limit, 100, "still production's page size");
    assert.equal(spy.calls[0].config.params.page, 1);
    assert.equal(spy.calls[1].config.params.page, 2, "and asks for the next page");
    assert.equal(spy.calls[0].config.timeout, undefined, "no timeout imposed");
    assert.equal(rows.length, 2);
    // And the sync job still calls it with no arguments at all.
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchCampaigns\(\)/);
  });

  it("leaves fetchCampaignDetail unchanged", async () => {
    const spy = spyHttp([{ data: CAMPAIGN }]);
    const detail = await adapterWith(spy).fetchCampaignDetail("zzidzz");
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, "/v2/publisher/campaign/zzidzz");
    assert.equal(detail.id, "zzcampaignidzz");
  });

  it("leaves fetchCampaignsCount unchanged", async () => {
    const spy = spyHttp([{ data: { count: 7 } }]);
    const count = await adapterWith(spy).fetchCampaignsCount("zzpubidzz");
    assert.equal(spy.calls[0].path, "/v2/publishers/zzpubidzz/campaignsCount");
    assert.equal(count.count, 7);
    // The guard throws synchronously, so it is asserted as a throw rather than a rejection.
    assert.throws(
      () => adapterWith(spyHttp()).fetchCampaignsCount(null),
      /requires publisher id from profile/,
    );
  });

  it("leaves the profile probe unchanged", async () => {
    const spy = spyHttp([{ profile: { id: "zzprofileidzz" } }]);
    const row = (
      await serviceWith(adapterWith(spy)).certify("trackier", { sourceObjects: ["profile"] })
    ).results[0];
    assert.equal(spy.calls[0].path, "/v2/publishers/profile");
    assert.equal(spy.calls[0].config.params, undefined, "the profile still sends no parameters");
    assert.equal(row.endpointKey, "GET /v2/publishers/profile");
    assert.equal(row.statusCategory, "OK");
  });

  it("changes no sync source object or fetcher", () => {
    const sync = codeOf(SYNC_SRC);
    assert.ok(!sync.includes("singlePage"));
    assert.ok(!sync.includes("NetworkCertificationService"));
    assert.match(sync, /sourceObject: "campaigns"/);
  });
});

describe("campaign status is not publisher application status", () => {
  it("reports both statuses as separate paths", async () => {
    const paths = (await certifyCampaigns(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    assert.ok(paths.includes("status"), "supplier campaign status");
    assert.ok(paths.includes("applicationStatus"), "publisher application status");
    assert.ok(paths.includes("publisherApproval"));
    // Three distinct paths, not one collapsed field.
    assert.equal(new Set(["status", "applicationStatus", "publisherApproval"]).size, 3);
  });

  it("invents no joined, approved, available or rejected value", async () => {
    const serialised = JSON.stringify(await certifyCampaigns(adapterWith(spyHttp())));
    for (const invented of [
      "JOINED",
      "APPROVED",
      "AVAILABLE",
      "REJECTED",
      "CAMPAIGN_JOINED",
      "CAMPAIGN_AVAILABLE",
      "relationshipStatus",
      "canonicalStatus",
    ]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("maps no relationship state anywhere in the chain", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCampaigns")[1]
      .split("\n  }")[0];
    for (const forbidden of ["joined", "approved", "rejected", "applicationStatus", "status ==="]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });

  it("preserves the supplier's own field names", async () => {
    const paths = (await certifyCampaigns(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const supplierName of ["id", "_id", "title", "advertiser", "payouts", "createdAt"]) {
      assert.ok(paths.includes(supplierName), supplierName);
    }
    for (const mboName of ["campaign_id", "campaignName", "merchantName", "commissionRate"]) {
      assert.ok(!paths.includes(mboName), mboName);
    }
  });

  it("preserves nested and array structure", async () => {
    const byPath = Object.fromEntries(
      (await certifyCampaigns(adapterWith(spyHttp()))).results[0].fieldPaths.map((f) => [f.path, f]),
    );
    assert.equal(byPath.advertiser.observedType, "OBJECT");
    assert.equal(byPath.advertiser.objectObserved, true);
    assert.ok(byPath["advertiser.name"], "nested leaves are reported");
    assert.equal(byPath.payouts.observedType, "ARRAY");
    assert.equal(byPath.payouts.arrayObserved, true);
    assert.ok(byPath["payouts[].currency"], "array element leaves are reported");
    assert.equal(byPath.categories.observedType, "ARRAY");
  });
});

describe("the campaigns outcome vocabulary", () => {
  it("reports OK with a structural field dictionary", async () => {
    const row = (await certifyCampaigns(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
    const row = (await certifyCampaigns(adapterWith(spyHttp()))).results[0];
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

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for an empty list", async () => {
    for (const empty of [{ campaigns: [] }, { data: { campaigns: [] } }, {}]) {
      const row = (await certifyCampaigns(adapterWith(spyHttp([empty])))).results[0];
      assert.equal(row.ok, true, JSON.stringify(empty));
      assert.equal(row.statusCategory, "OK_NO_ROWS", JSON.stringify(empty));
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA", JSON.stringify(empty));
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
      assert.deepEqual(row.fieldPaths, []);
    }
  });

  it("invents no account-state blocker from zero campaigns", async () => {
    const serialised = JSON.stringify(await certifyCampaigns(adapterWith(spyHttp([{ campaigns: [] }]))));
    for (const invented of [
      "NOT_SUPPORTED",
      "UNSUPPORTED",
      "accountStateBlocker",
      "NO_JOINED_CAMPAIGNS",
      "NEEDS_ACTIVE_PARTNERSHIP",
    ]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("preserves an auth rejection safely", async () => {
    const error = new Error("zzupstreamauthmessagezz");
    error.response = { status: 401, data: { message: "zzupstreambodyzz" } };
    const row = (await certifyCampaigns(adapterWith(spyHttp([error])))).results[0];
    assert.equal(row.ok, false);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.equal(row.supplierStatusCode, 401);
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(API_KEY));
    assert.ok(!serialised.includes("zzupstreambodyzz"), "no supplier response body");
  });

  it("preserves a supplier validation failure safely", async () => {
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: {} };
    const row = (await certifyCampaigns(adapterWith(spyHttp([error])))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
  });
});

describe("the sample is bounded to one row", () => {
  it("keeps one row even when the supplier ignores limit=1", async () => {
    const spy = spyHttp([{ campaigns: [CAMPAIGN, SECOND_CAMPAIGN] }]);
    const row = (await certifyCampaigns(adapterWith(spy))).results[0];
    assert.equal(spy.calls.length, 1);
    assert.equal(row.sampleCount, 1);
  });

  it("never returns the second row's values", async () => {
    const serialised = JSON.stringify(
      await certifyCampaigns(adapterWith(spyHttp([{ campaigns: [CAMPAIGN, SECOND_CAMPAIGN] }]))),
    );
    for (const secret of ["zzsecondcampaignidzz", "zzsecondnamezz", "zzsecondstatuszz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });
});

describe("nothing identifying or monetary can leak", () => {
  it("never returns the campaign id or name", async () => {
    const serialised = JSON.stringify(await certifyCampaigns(adapterWith(spyHttp())));
    for (const secret of ["zzcampaignidzz", "zzcampaignobjectidzz", "zzcampaignnamezz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the advertiser or merchant identity", async () => {
    const serialised = JSON.stringify(await certifyCampaigns(adapterWith(spyHttp())));
    for (const secret of ["zzadvertiseridzz", "zzmerchantnamezz", "zzcategoryzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns tracking, landing or logo URLs", async () => {
    const serialised = JSON.stringify(await certifyCampaigns(adapterWith(spyHttp())));
    for (const secret of ["zztrackingzz", "zzpreviewzz", "zzlogozz", "https://"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns commission values or application identifiers", async () => {
    const serialised = JSON.stringify(await certifyCampaigns(adapterWith(spyHttp())));
    for (const secret of [
      "4372.19",
      "8123.47",
      "SGD",
      "zzpayoutidzz",
      "zzapplicationstatuszz",
      "zzcampaignstatuszz",
      "zzapprovalmodezz",
      "2031-03-17",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the API key or the raw supplier row", async () => {
    const serialised = JSON.stringify(await certifyCampaigns(adapterWith(spyHttp())));
    for (const secret of [API_KEY, "X-Api-Key", "campaigns\":[", "previewUrl\":\""]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("returns only the safe result keys", async () => {
    const row = (await certifyCampaigns(adapterWith(spyHttp()))).results[0];
    for (const forbidden of ["rows", "campaigns", "body", "raw", "data", "sample", "headers"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
    for (const expected of [
      "network",
      "sourceObject",
      "endpointKey",
      "httpMethod",
      "sampleCount",
      "fieldCount",
      "fieldPaths",
      "statusCategory",
    ]) {
      assert.ok(Object.hasOwn(row, expected), expected);
    }
  });
});

describe("read-only, and nothing beyond a bounded read is implemented", () => {
  it("performs no database read or write", async () => {
    assert.equal((await certifyCampaigns(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain that certifies this object", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCampaigns")[1]
      .split("\n  }")[0];
    for (const write of ["prisma.", "upsert", "create", "update", "delete"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("adds no detail, count, coupon, tracking-link or assignment path", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCampaigns")[1]
      .split("\n  }")[0];
    for (const forbidden of [
      "fetchCampaignDetail",
      "fetchCampaignsCount",
      "fetchCoupons",
      "TrackingLink",
      "ClientCampaignAssignment",
    ]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
    // campaign_detail and coupons became their own probes later, each on its own chain. What
    // matters here is that the LIST chain still makes neither request of its own.
    for (const notYet of ["campaignsCount", "conversions", "tracking"]) {
      assert.ok(!listProbeSourceObjects("trackier").includes(notYet), notYet);
    }
  });
});
