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
  createTrackierAdapter,
  TRACKIER_CAMPAIGN_DETAIL_PATH_PREFIX,
  TRACKIER_CAMPAIGNS_PATH,
} = await import("../src/adapters/trackier.adapter.js");
const {
  NetworkCertificationService,
  TRACKIER_RELATIONSHIP_EVIDENCE_PATHS,
  listProbeSourceObjects,
  trackierCampaignIdOf,
} = await import("../src/modules/ops/networkCertification.service.js");

const ADAPTER_SRC = readFileSync("src/adapters/trackier.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

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
const CAMPAIGN_ID = "zzdiscoveredcampaignidzz";

/** A list row shaped like the live one: app_id and app_name present, no relationship state. */
const LIST_ROW = {
  id: CAMPAIGN_ID,
  title: "zzlistcampaignnamezz",
  app_id: "zzappidzz",
  app_name: "zzappnamezz",
  model: "zzmodelzz",
  currency: "SGD",
};

/** The detail body, with the structures this phase is looking for — and still no relationship
 *  field, which is the live shape's open question. */
const DETAIL = {
  id: CAMPAIGN_ID,
  title: "zzdetailcampaignnamezz",
  app_id: "zzappidzz",
  app_name: "zzappnamezz",
  advertiser: { id: "zzadvertiseridzz", name: "zzmerchantnamezz" },
  model: "zzmodelzz",
  defaultGoal: { id: "zzgoalidzz", name: "zzgoalnamezz", revenue: 4372.19, payout: 8123.47 },
  payouts: [{ id: "zzpayoutidzz", payout: 8123.47, revenue: 4372.19, currency: "SGD" }],
  landing_pages: [{ id: "zzlandingidzz", title: "zzlandingtitlezz", url: "https://zzlandingzz.example/lp" }],
  tracking_link: "https://zztrackingzz.example/click",
  deepLinkEnabled: true,
  creatives: [{ id: "zzcreativeidzz", url: "https://zzcreativezz.example/banner.png" }],
  categories: ["zzcategoryzz"],
  countries: ["zzcountryzz"],
  devices: ["zzdevicezz"],
  kpi: "zzkpizz",
  currency: "SGD",
};

/** The same detail, but carrying a relationship field. */
const DETAIL_WITH_RELATIONSHIP = { ...DETAIL, applicationStatus: "zzapplicationstatuszz" };

/**
 * A spy that answers the campaigns path and the detail path independently, so a chain that skips
 * discovery or asks twice is visible in the call log.
 */
function spyHttp({ list = { campaigns: [LIST_ROW] }, detail = { data: DETAIL } } = {}) {
  const calls = [];
  return {
    calls,
    listCalls: () => calls.filter((c) => c.path === TRACKIER_CAMPAIGNS_PATH),
    detailCalls: () => calls.filter((c) => c.path.startsWith(TRACKIER_CAMPAIGN_DETAIL_PATH_PREFIX)),
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, config });
        const answer = path.startsWith(TRACKIER_CAMPAIGN_DETAIL_PATH_PREFIX) ? detail : list;
        if (answer instanceof Error) throw answer;
        return { data: answer };
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

async function certifyDetail(adapter) {
  return serviceWith(adapter).certify("trackier", { sourceObjects: ["campaign_detail"] });
}

describe("the two-request discovery chain", () => {
  it("asks the campaigns list first, bounded to one row on page one", async () => {
    const spy = spyHttp();
    await certifyDetail(adapterWith(spy));
    assert.equal(spy.calls[0].path, "/v2/publisher/campaigns");
    assert.deepEqual(spy.calls[0].config.params, { limit: 1, page: 1 });
  });

  it("then asks for the DISCOVERED campaign's detail", async () => {
    const spy = spyHttp();
    await certifyDetail(adapterWith(spy));
    assert.equal(spy.calls[1].path, `/v2/publisher/campaign/${CAMPAIGN_ID}`);
    assert.equal(TRACKIER_CAMPAIGN_DETAIL_PATH_PREFIX, "/v2/publisher/campaign/");
  });

  it("makes at most two supplier requests", async () => {
    const spy = spyHttp();
    await certifyDetail(adapterWith(spy));
    assert.equal(spy.calls.length, 2);
    assert.equal(spy.listCalls().length, 1);
    assert.equal(spy.detailCalls().length, 1);
  });

  it("reports how many requests each step made", async () => {
    const row = (await certifyDetail(adapterWith(spyHttp()))).results[0];
    assert.equal(row.discoveryRequestCount, 1);
    assert.equal(row.detailRequestCount, 1);
  });

  it("does not paginate the discovery step", async () => {
    // At limit=1 a one-row page is a FULL page, so the pager would walk on without singlePage.
    const spy = spyHttp();
    await certifyDetail(adapterWith(spy));
    assert.equal(spy.listCalls().length, 1);
    assert.equal(spy.listCalls()[0].config.params.page, 1);
  });

  it("retries neither step", async () => {
    const listFail = spyHttp({ list: new Error("zzlistfailurezz") });
    await certifyDetail(adapterWith(listFail));
    assert.equal(listFail.calls.length, 1, "one discovery attempt, and no detail");

    const detailFail = spyHttp({ detail: new Error("zzdetailfailurezz") });
    await certifyDetail(adapterWith(detailFail));
    assert.equal(detailFail.listCalls().length, 1);
    assert.equal(detailFail.detailCalls().length, 1);
  });

  it("does not retry a retryable status on either step", async () => {
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp({ detail: error });
    await certifyDetail(adapterWith(spy));
    assert.equal(spy.detailCalls().length, 1);
  });

  it("bounds both requests with the probe's own timeout", async () => {
    const spy = spyHttp();
    await certifyDetail(adapterWith(spy));
    for (const call of spy.calls) assert.ok(Number(call.config.timeout) > 0, call.path);
  });

  it("pins the bounds in the chain", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCampaignDetail")[1]
      .split("\n  }")[0];
    assert.match(chain, /singlePage: true/);
    assert.equal((chain.match(/retries: 1/g) ?? []).length, 2, "both steps pinned");
    assert.match(chain, /TRACKIER_CERTIFICATION_CAMPAIGN_PARAMS/);
  });

  it("is registered as its own source object on its own chain", async () => {
    assert.ok(listProbeSourceObjects("trackier").includes("campaign_detail"));
    assert.match(codeOf(SERVICE_SRC), /chain: "trackierCampaignDetail"/);

    const row = (await certifyDetail(adapterWith(spyHttp()))).results[0];
    assert.equal(row.endpointKey, "GET /v2/publisher/campaign/{discovered-id}");
    // A TEMPLATE, not a rendered path: the key must say the id was discovered, and must never be
    // the id itself — otherwise every run's key differs and the id leaks through it.
    assert.ok(row.endpointKey.includes("{discovered-id}"));
    assert.ok(!row.endpointKey.includes(CAMPAIGN_ID));
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.sourceObject, "campaign_detail");
  });
});

describe("the campaign id is discovered, never supplied", () => {
  it("reads the campaign id from the row, not the app id", () => {
    // app_id and app_name identify the advertiser's APP, not the campaign — and neither is
    // relationship state.
    assert.equal(trackierCampaignIdOf(LIST_ROW), CAMPAIGN_ID);
    assert.equal(trackierCampaignIdOf({ app_id: "zzappidzz", app_name: "zzappnamezz" }), null);
    assert.match(codeOf(SERVICE_SRC), /firstUsableId\(row, \["id", "_id", "campaignId", "campaign_id"\]\)/);
    const reader = codeOf(SERVICE_SRC)
      .split("export function trackierCampaignIdOf")[1]
      .split("\n}")[0];
    for (const wrong of ["app_id", "app_name", "advertiser"]) {
      assert.ok(!reader.includes(wrong), wrong);
    }
  });

  it("accepts no id, app id or advertiser id from a caller", async () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCampaignDetail")[1]
      .split("\n  }")[0];
    for (const leak of [
      "options.campaignId",
      "params.campaignId",
      "probe.campaignId",
      "req.body",
      "req.query",
      "app_id",
      "advertiserId",
    ]) {
      assert.ok(!chain.includes(leak), leak);
    }
    assert.match(chain, /trackierCampaignIdOf\(campaignRows\[0\]\)/);

    // And certify() takes no campaign argument at all: an extra option changes nothing.
    const spy = spyHttp();
    await serviceWith(adapterWith(spy)).certify("trackier", {
      sourceObjects: ["campaign_detail"],
      campaignId: "zzinjectedzz",
      appId: "zzinjectedzz",
    });
    assert.equal(spy.detailCalls()[0].path, `/v2/publisher/campaign/${CAMPAIGN_ID}`);
    assert.ok(!JSON.stringify(spy.calls).includes("zzinjectedzz"));
  });

  it("refuses an id carrying path or query syntax", () => {
    // The id is interpolated into a path segment, so a value with a slash or a question mark would
    // escape it and address a different resource.
    for (const hostile of ["../../admin", "a/b", "a?b=1", "a#b", "a b"]) {
      assert.equal(trackierCampaignIdOf({ id: hostile }), null, hostile);
    }
  });

  it("prefers id, then _id, then the camel and snake spellings", () => {
    assert.equal(trackierCampaignIdOf({ id: "zzazz", _id: "zzbzz" }), "zzazz");
    assert.equal(trackierCampaignIdOf({ _id: "zzbzz" }), "zzbzz");
    assert.equal(trackierCampaignIdOf({ campaignId: "zzczz" }), "zzczz");
    assert.equal(trackierCampaignIdOf({ campaign_id: "zzdzz" }), "zzdzz");
    assert.equal(trackierCampaignIdOf({}), null);
  });
});

describe("no campaign scope means no second request", () => {
  it("skips the detail request when the list returns no row", async () => {
    const spy = spyHttp({ list: { campaigns: [] } });
    const row = (await certifyDetail(adapterWith(spy))).results[0];
    assert.equal(spy.calls.length, 1, "discovery only");
    assert.equal(spy.detailCalls().length, 0);
    assert.equal(row.statusCategory, "SKIPPED_NO_CAMPAIGN_SCOPE");
    assert.equal(row.ok, false);
    assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(row.discoveryRequestCount, 1);
    assert.equal(row.detailRequestCount, 0);
    assert.equal(row.fieldCount, 0);
    assert.deepEqual(row.fieldPaths, []);
    assert.match(row.note, /no row/i);
  });

  it("skips it when a row carries no usable campaign id", async () => {
    const spy = spyHttp({ list: { campaigns: [{ app_id: "zzappidzz", title: "zztitlezz" }] } });
    const row = (await certifyDetail(adapterWith(spy))).results[0];
    assert.equal(spy.detailCalls().length, 0);
    assert.equal(row.statusCategory, "SKIPPED_NO_CAMPAIGN_SCOPE");
    assert.equal(row.detailRequestCount, 0);
    assert.match(row.note, /no usable campaign id/i);
  });

  it("invents no account-state blocker when scope is missing", async () => {
    const serialised = JSON.stringify(await certifyDetail(adapterWith(spyHttp({ list: { campaigns: [] } }))));
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
});

describe("relationship state is reported, never decided", () => {
  it("reports UNKNOWN_FROM_CURRENT_API_SHAPE when the detail carries no relationship field", async () => {
    // The live list showed 53 fields and no relationship state. If detail does not carry one
    // either, that is the finding — not an inference that nothing is joined.
    const row = (await certifyDetail(adapterWith(spyHttp()))).results[0];
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.relationshipState, "UNKNOWN_FROM_CURRENT_API_SHAPE");
    assert.deepEqual(row.relationshipEvidencePaths, []);
  });

  it("reports PRESENT_NEEDS_MAPPING when it does, and still maps nothing", async () => {
    const row = (
      await certifyDetail(adapterWith(spyHttp({ detail: { data: DETAIL_WITH_RELATIONSHIP } })))
    ).results[0];
    assert.equal(row.relationshipState, "PRESENT_NEEDS_MAPPING");
    assert.deepEqual(row.relationshipEvidencePaths, ["applicationStatus"]);
    // The path is named; the value never is.
    assert.ok(!JSON.stringify(row).includes("zzapplicationstatuszz"));
  });

  it("never classifies joined, available, pending or rejected", async () => {
    for (const detail of [{ data: DETAIL }, { data: DETAIL_WITH_RELATIONSHIP }]) {
      const serialised = JSON.stringify(await certifyDetail(adapterWith(spyHttp({ detail }))));
      for (const invented of [
        "JOINED",
        "AVAILABLE",
        "PENDING",
        "REJECTED",
        "APPROVED",
        "CAMPAIGN_JOINED",
        "canonicalStatus",
        "relationshipStatus\":\"",
      ]) {
        assert.ok(!serialised.includes(invented), invented);
      }
    }
  });

  it("treats app_id and app_name as neither campaign status nor relationship state", async () => {
    const row = (await certifyDetail(adapterWith(spyHttp()))).results[0];
    const paths = row.fieldPaths.map((f) => f.path);
    // They are reported as PATHS like any other field...
    assert.ok(paths.includes("app_id"));
    assert.ok(paths.includes("app_name"));
    // ...and they are not in the relationship search list, so they cannot satisfy it.
    assert.ok(!TRACKIER_RELATIONSHIP_EVIDENCE_PATHS.includes("app_id"));
    assert.ok(!TRACKIER_RELATIONSHIP_EVIDENCE_PATHS.includes("app_name"));
    assert.deepEqual(row.relationshipEvidencePaths, []);
    assert.equal(row.relationshipState, "UNKNOWN_FROM_CURRENT_API_SHAPE");
  });

  it("keeps the evidence list a frozen SEARCH list, not a mapping", () => {
    assert.ok(Object.isFrozen(TRACKIER_RELATIONSHIP_EVIDENCE_PATHS));
    assert.ok(TRACKIER_RELATIONSHIP_EVIDENCE_PATHS.includes("applicationStatus"));
    assert.ok(TRACKIER_RELATIONSHIP_EVIDENCE_PATHS.includes("status"));
    // Nothing in the chain turns a matched path into a value.
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCampaignDetail")[1]
      .split("\n  }")[0];
    for (const forbidden of ["JOINED", "APPROVED", "PENDING", "REJECTED", "toUpperCase("]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });
});

describe("the detail shape is captured structurally", () => {
  it("reports OK with a field dictionary for the detail object", async () => {
    const row = (await certifyDetail(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);
  });

  it("captures the payout, goal, landing-page, tracking and restriction structures", async () => {
    const paths = (await certifyDetail(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const expected of [
      "defaultGoal",
      "defaultGoal.payout",
      "payouts",
      "payouts[].currency",
      "landing_pages",
      "landing_pages[].url",
      "tracking_link",
      "deepLinkEnabled",
      "creatives[].url",
      "categories",
      "countries",
      "devices",
      "kpi",
      "model",
    ]) {
      assert.ok(paths.includes(expected), expected);
    }
  });

  it("preserves the supplier's own field names, inventing no aliases", async () => {
    const paths = (await certifyDetail(adapterWith(spyHttp()))).results[0].fieldPaths.map(
      (f) => f.path,
    );
    for (const supplierName of ["app_id", "app_name", "landing_pages", "tracking_link", "defaultGoal"]) {
      assert.ok(paths.includes(supplierName), supplierName);
    }
    for (const alias of ["appId", "landingPages", "trackingLink", "campaign_status", "merchantName"]) {
      assert.ok(!paths.includes(alias), alias);
    }
  });

  it("marks nested and array structure", async () => {
    const byPath = Object.fromEntries(
      (await certifyDetail(adapterWith(spyHttp()))).results[0].fieldPaths.map((f) => [f.path, f]),
    );
    assert.equal(byPath.defaultGoal.observedType, "OBJECT");
    assert.equal(byPath.defaultGoal.objectObserved, true);
    assert.equal(byPath.payouts.observedType, "ARRAY");
    assert.equal(byPath.payouts.arrayObserved, true);
    assert.equal(byPath.deepLinkEnabled.observedType, "BOOLEAN");
    assert.equal(byPath.tracking_link.observedType, "URL");
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
    const row = (await certifyDetail(adapterWith(spyHttp()))).results[0];
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

  it("keeps ONE row even when the detail body arrives as a list", async () => {
    // getResponseBody hands back whatever the envelope holds, so an array body would otherwise
    // certify two rows and merge two campaigns' shapes into one dictionary.
    const spy = spyHttp({ detail: { data: [DETAIL, { ...DETAIL, id: "zzsecondidzz", extraOnly: 1 }] } });
    const row = (await certifyDetail(adapterWith(spy))).results[0];
    assert.equal(row.sampleCount, 1);
    assert.ok(!row.fieldPaths.some((f) => f.path === "extraOnly"), "the second row is not merged in");
    assert.ok(!JSON.stringify(row).includes("zzsecondidzz"));
  });

  it("reads the detail envelope the way production does", async () => {
    for (const body of [{ data: DETAIL }, DETAIL]) {
      const row = (await certifyDetail(adapterWith(spyHttp({ detail: body })))).results[0];
      assert.equal(row.sampleCount, 1, JSON.stringify(Object.keys(body).slice(0, 2)));
    }
  });

  it("reports OK_NO_ROWS for an empty detail body", async () => {
    for (const empty of [{ data: {} }, {}]) {
      const row = (await certifyDetail(adapterWith(spyHttp({ detail: empty })))).results[0];
      assert.equal(row.statusCategory, "OK_NO_ROWS", JSON.stringify(empty));
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA");
      assert.equal(row.relationshipState, "UNKNOWN_FROM_CURRENT_API_SHAPE");
      assert.equal(row.detailRequestCount, 1);
    }
  });
});

describe("supplier failures are preserved safely", () => {
  it("maps a 401 on discovery to AUTH_FAILED, with no detail request", async () => {
    const error = new Error("zzupstreamauthmessagezz");
    error.response = { status: 401, data: { message: "zzupstreambodyzz" } };
    const spy = spyHttp({ list: error });
    const row = (await certifyDetail(adapterWith(spy))).results[0];
    assert.equal(spy.detailCalls().length, 0);
    assert.equal(row.statusCategory, "AUTH_FAILED");
    assert.equal(row.supplierStatusCode, 401);
    assert.equal(row.discoveryRequestCount, 1);
    assert.equal(row.detailRequestCount, 0);
    const serialised = JSON.stringify(row);
    assert.ok(!serialised.includes(API_KEY));
    assert.ok(!serialised.includes("zzupstreambodyzz"));
  });

  it("preserves a 404 on the detail step", async () => {
    const error = new Error("zznotfoundzz");
    error.response = { status: 404, data: {} };
    const row = (await certifyDetail(adapterWith(spyHttp({ detail: error })))).results[0];
    assert.equal(row.statusCategory, "NOT_FOUND");
    assert.equal(row.supplierStatusCode, 404);
    assert.equal(row.discoveryRequestCount, 1);
    assert.equal(row.detailRequestCount, 1);
  });

  it("preserves a 400 on the detail step", async () => {
    const error = new Error("zzrejectedzz");
    error.response = { status: 400, data: {} };
    const row = (await certifyDetail(adapterWith(spyHttp({ detail: error })))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
  });
});

describe("nothing identifying or monetary can leak", () => {
  it("never returns the discovered campaign id", async () => {
    const serialised = JSON.stringify(await certifyDetail(adapterWith(spyHttp())));
    assert.ok(!serialised.includes(CAMPAIGN_ID), "the discovered id is used and discarded");
  });

  it("never returns campaign, advertiser or app names", async () => {
    const serialised = JSON.stringify(await certifyDetail(adapterWith(spyHttp())));
    for (const secret of [
      "zzdetailcampaignnamezz",
      "zzlistcampaignnamezz",
      "zzmerchantnamezz",
      "zzadvertiseridzz",
      "zzappidzz",
      "zzappnamezz",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns tracking, landing or creative URLs", async () => {
    const serialised = JSON.stringify(await certifyDetail(adapterWith(spyHttp())));
    for (const secret of ["zztrackingzz", "zzlandingzz", "zzcreativezz", "https://"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns payout, revenue or goal values", async () => {
    const serialised = JSON.stringify(await certifyDetail(adapterWith(spyHttp())));
    for (const secret of ["8123.47", "4372.19", "SGD", "zzgoalidzz", "zzgoalnamezz", "zzpayoutidzz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the API key or the raw rows", async () => {
    const serialised = JSON.stringify(await certifyDetail(adapterWith(spyHttp())));
    for (const secret of [API_KEY, "X-Api-Key", "zzcategoryzz", "zzcountryzz", "zzdevicezz", "zzkpizz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("returns only the safe result keys", async () => {
    const row = (await certifyDetail(adapterWith(spyHttp()))).results[0];
    for (const forbidden of ["rows", "detail", "campaign", "body", "raw", "data", "sample"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
    for (const expected of [
      "endpointKey",
      "httpMethod",
      "sampleCount",
      "fieldCount",
      "fieldPaths",
      "statusCategory",
      "discoveryRequestCount",
      "detailRequestCount",
    ]) {
      assert.ok(Object.hasOwn(row, expected), expected);
    }
    assert.ok(!row.endpointKey.includes(CAMPAIGN_ID), "the endpointKey is a template");
  });
});

describe("read-only, and the other probes unchanged", () => {
  it("performs no database read or write", async () => {
    assert.equal((await certifyDetail(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCampaignDetail")[1]
      .split("\n  }")[0];
    for (const write of ["prisma.", "upsert", "createMany", "updateMany", "deleteMany"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("persists no commission, tracking link or assignment", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierCampaignDetail")[1]
      .split("\n  }")[0];
    for (const forbidden of [
      "TrackingLink",
      "ClientCampaignAssignment",
      "SupplierCommissionRule",
      "fetchCoupons",
      "fetchConversions",
    ]) {
      assert.ok(!chain.includes(forbidden), forbidden);
    }
  });

  it("leaves the campaigns list probe making exactly one request", async () => {
    const spy = spyHttp();
    const row = (
      await serviceWith(adapterWith(spy)).certify("trackier", { sourceObjects: ["campaigns"] })
    ).results[0];
    assert.equal(spy.calls.length, 1, "the list probe still asks once, and never for detail");
    assert.equal(spy.detailCalls().length, 0);
    assert.equal(row.endpointKey, "GET /v2/publisher/campaigns (limit=1, page=1)");
    assert.equal(row.statusCategory, "OK");
    assert.ok(!Object.hasOwn(row, "discoveryRequestCount"));
  });

  it("leaves production's fetchCampaignDetail unchanged", async () => {
    const spy = spyHttp();
    const detail = await adapterWith(spy).fetchCampaignDetail(CAMPAIGN_ID);
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].path, `/v2/publisher/campaign/${CAMPAIGN_ID}`);
    assert.deepEqual(spy.calls[0].config, {}, "no timeout or retry override imposed");
    assert.equal(detail.id, CAMPAIGN_ID);
    assert.match(codeOf(ADAPTER_SRC), /retries: 6, delayMs: 2000/);
  });

  it("adds no second detail fetcher", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/fetchCampaignDetail\(/g) ?? []).length, 1);
    assert.equal((code.match(/TRACKIER_CAMPAIGN_DETAIL_PATH_PREFIX/g) ?? []).length, 2);
  });
});
