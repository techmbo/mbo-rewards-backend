import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.AWIN_MIN_INTERVAL_MS = "1";
process.env.LOG_LEVEL = "silent";

const { createAwinAdapter } = await import("../src/adapters/awin.adapter.js");
const { NetworkCertificationService, listProbeSourceObjects, awinAdvertiserIdOf } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { SOURCE_OBJECT_AVAILABILITY, getSourceObject } = await import(
  "../src/modules/networkOps/sourceObjects.catalog.js"
);

const ADAPTER_SRC = readFileSync("src/adapters/awin.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");

const TOKEN = "zzaccesstokenzz";
const PUBLISHER_ID = "zzpub9876zz";
const ADVERTISER_ID = "778899";

/** A programme row carrying the evidenced advertiser identifier. */
const PROGRAMME_ROW = {
  id: ADVERTISER_ID,
  name: "zzadvertisernamezz",
  clickThroughUrl: "https://www.awin1.com/cread.php?zzcreadzz",
  currencyCode: "GBP",
};

/** A commission-group row: names, rates, currencies — none may be reported. */
const GROUP_ROW = {
  groupId: 4455,
  groupCode: "zzgroupcodezz",
  groupName: "zzgroupnamezz",
  description: "zzgroupdescriptionzz",
  percentage: 7.25,
  amount: 3.5,
  currency: "GBP",
  type: "percentage",
  conditions: [{ conditionType: "zzconditiontypezz", value: "zzconditionvaluezz" }],
};

function spyHttp({ programmes = [PROGRAMME_ROW], groups = [GROUP_ROW], error = null } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, params: config.params, timeout: config.timeout, config });
        if (error && path.includes("commissiongroups")) throw error;
        if (path.includes("commissiongroups")) return { data: { commissionGroups: groups } };
        if (path.includes("/programmes")) return { data: { programmes } };
        throw new Error(`unexpected path ${path}`);
      },
      post: async () => ({ data: { data: [] } }),
    },
  };
}

function serviceWith(options) {
  const spy = spyHttp(options);
  return {
    spy,
    service: new NetworkCertificationService({
      prisma: {},
      adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: spy.client }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    }),
  };
}

const certify = async (options, runOptions = {}) => {
  const { service, spy } = serviceWith(options);
  const result = await service.certify("awin", {
    sourceObjects: ["commission_groups"],
    ...runOptions,
  });
  return { result, spy, entry: result.results[0] };
};

const groupCall = (spy) => spy.calls.find((c) => c.path.includes("commissiongroups"));

/* ------------------------------------------------------- registration */

describe("awin commission_groups is registered", () => {
  it("1 - it is a probeable awin source object", () => {
    assert.ok(listProbeSourceObjects("awin").includes("commission_groups"));
  });

  it("2 - the other three probes are untouched", () => {
    for (const kept of ["campaigns", "coupons", "conversions"]) {
      assert.ok(listProbeSourceObjects("awin").includes(kept), kept);
    }
  });

  it("3 - the catalog records it as implemented but NOT ingested", () => {
    const entry = getSourceObject("awin", "commission_groups");
    assert.ok(entry, "no catalog entry exists");
    assert.equal(entry.live, false, "it must not be marked live before certification succeeds");
    assert.equal(entry.availability, "IMPLEMENTED_NOT_INGESTED");
    assert.equal(entry.availability, SOURCE_OBJECT_AVAILABILITY.IMPLEMENTED_NOT_INGESTED);
    assert.equal(entry.entityType, "commission_rule");
    assert.match(entry.notes, /not wired into sync/);
    assert.match(entry.notes, /UNKNOWN_NEEDS_LIVE_DATA/);
  });

  it("4 - that state is distinct from every other availability state", () => {
    const entry = getSourceObject("awin", "commission_groups");
    for (const other of ["LIVE", "DECLARED", "UNAVAILABLE", "NO_ENDPOINT", "MANUAL"]) {
      assert.notEqual(entry.availability, SOURCE_OBJECT_AVAILABILITY[other], other);
    }
  });
});

/* ------------------------------------------------------- discovery */

describe("the advertiser id is discovered, never supplied", () => {
  it("5 - it is read only from evidenced programme fields", () => {
    assert.equal(awinAdvertiserIdOf({ advertiserId: "111" }), "111");
    assert.equal(awinAdvertiserIdOf({ advertiser_id: "222" }), "222");
    assert.equal(awinAdvertiserIdOf({ id: "333" }), "333");
    // advertiserId wins when both are present.
    assert.equal(awinAdvertiserIdOf({ advertiserId: "111", id: "333" }), "111");
    // Nothing else is tried.
    assert.equal(awinAdvertiserIdOf({ programmeId: "444", campaignId: "555" }), null);
    assert.equal(awinAdvertiserIdOf({}), null);
  });

  it("6 - a value carrying path or query syntax is refused", () => {
    for (const unsafe of ["1/../2", "a?b", "a#b", "a b", "../etc"]) {
      assert.equal(awinAdvertiserIdOf({ id: unsafe }), null, unsafe);
    }
  });

  it("7 - a caller-supplied advertiserId never reaches the request", async () => {
    const { service, spy } = serviceWith({});
    await service.certify("awin", {
      sourceObjects: ["commission_groups"],
      advertiserId: "zzattackerzz",
      advertiser_id: "zzattackerzz",
      campaignId: "zzattackerzz",
    });
    assert.equal(groupCall(spy).params.advertiserId, ADVERTISER_ID);
    assert.ok(!JSON.stringify(spy.calls).includes("zzattackerzz"), "a caller value reached a request");
  });

  it("8 - the sampler takes advertiserId as a NAMED argument, not out of ctx", () => {
    assert.match(
      ADAPTER_SRC,
      /async fetchCertificationCommissionGroupSample\(\{ advertiserId, timeoutMs \} = \{\}\)/,
    );
    // fetchCertificationSample's ctx surface is unchanged by this addition.
    const start = ADAPTER_SRC.indexOf("async fetchCertificationSample(");
    const body = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n    },", start));
    assert.deepEqual(
      [...new Set([...body.matchAll(/ctx\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort(),
      ["timeoutMs", "window"],
    );
  });

  it("9 - the sampler refuses an unsafe id before requesting", async () => {
    const spy = spyHttp({});
    const adapter = createAwinAdapter({ accessToken: TOKEN, publisherId: PUBLISHER_ID, httpClient: spy.client });
    for (const unsafe of ["", "  ", "1/../2", "a?b", "a b", null, undefined]) {
      await assert.rejects(
        () => adapter.fetchCertificationCommissionGroupSample({ advertiserId: unsafe }),
        /requires a safe advertiserId/,
        JSON.stringify(unsafe),
      );
    }
    assert.equal(spy.calls.length, 0, "an unsafe id reached the supplier");
  });
});

/* ------------------------------------------------------- the skip path */

describe("no advertiser id means no second request", () => {
  it("10 - zero campaign rows yields SKIPPED_NO_ADVERTISER_ID", async () => {
    const { entry, spy } = await certify({ programmes: [] });
    assert.equal(entry.statusCategory, "SKIPPED_NO_ADVERTISER_ID");
    assert.equal(entry.ok, false);
    assert.equal(entry.advertiserIdResolved, false);
    assert.equal(entry.campaignsInspectedCount, 0);
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(entry.sampleCount, 0);
    assert.deepEqual(entry.fieldPaths, []);
  });

  it("11 - the skip costs EXACTLY one supplier request", async () => {
    const { spy } = await certify({ programmes: [] });
    assert.equal(spy.calls.length, 1, "a commission-group request was made without an id");
    assert.ok(spy.calls[0].path.includes("/programmes"));
    assert.equal(groupCall(spy), undefined);
  });

  it("12 - a campaign row with no usable id also skips, and is counted", async () => {
    const { entry, spy } = await certify({ programmes: [{ name: "zzadvertisernamezz" }] });
    assert.equal(entry.statusCategory, "SKIPPED_NO_ADVERTISER_ID");
    assert.equal(entry.campaignsInspectedCount, 1, "the inspected row was not counted");
    assert.equal(spy.calls.length, 1);
  });

  it("13 - the skip is not reported as a supplier failure", async () => {
    const { entry } = await certify({ programmes: [] });
    assert.ok(!("supplierStatusCode" in entry));
    assert.ok(!("supplierMessage" in entry));
    assert.match(entry.note, /no commission-group request was made/i);
  });
});

/* ------------------------------------------------------- the resolved path */

describe("with an advertiser id, exactly two requests", () => {
  it("14 - two requests, in order, and no more", async () => {
    const { spy } = await certify({});
    assert.equal(spy.calls.length, 2, "the request budget was exceeded");
    assert.ok(spy.calls[0].path.includes("/programmes"));
    assert.equal(spy.calls[1].path, `/publishers/${PUBLISHER_ID}/commissiongroups`);
  });

  it("15 - extraConditionsDetails is true and effectiveDate is omitted", async () => {
    const { spy } = await certify({});
    const params = groupCall(spy).params;
    assert.equal(params.extraConditionsDetails, true);
    assert.equal(params.effectiveDate, undefined, "effectiveDate was sent");
    assert.deepEqual(Object.keys(params).sort(), ["advertiserId", "extraConditionsDetails"]);
  });

  it("16 - the path matches the one production fetchCommissionGroups builds", async () => {
    const { spy } = await certify({});
    assert.equal(groupCall(spy).path, `/publishers/${PUBLISHER_ID}/commissiongroups`);
    assert.match(ADAPTER_SRC, /`\/publishers\/\$\{pubId\}\/commissiongroups`/);
  });

  it("17 - one row is kept and reported structurally", async () => {
    const { entry } = await certify({});
    assert.equal(entry.ok, true);
    assert.equal(entry.statusCategory, "OK");
    assert.equal(entry.advertiserIdResolved, true);
    assert.equal(entry.campaignsInspectedCount, 1);
    assert.equal(entry.sampleCount, 1);
    assert.equal(entry.fieldCount, entry.fieldPaths.length);
    const paths = entry.fieldPaths.map((f) => f.path);
    assert.ok(paths.includes("conditions[].conditionType"));
    assert.ok(paths.includes("percentage"));
  });

  it("18 - a full page still yields one row and no extra request", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...GROUP_ROW, groupId: 5000 + i }));
    const { entry, spy } = await certify({ groups: many });
    assert.equal(entry.sampleCount, 1);
    assert.equal(spy.calls.length, 2);
  });

  it("19 - zero commission groups is OK_NO_ROWS with the schema unknown", async () => {
    const { entry, spy } = await certify({ groups: [] });
    assert.equal(entry.ok, true);
    assert.equal(entry.statusCategory, "OK_NO_ROWS");
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.equal(entry.advertiserIdResolved, true, "the id resolved even though no group returned");
    assert.equal(entry.sampleCount, 0);
    assert.deepEqual(entry.fieldPaths, []);
    assert.equal(spy.calls.length, 2);
  });

  it("20 - both evidenced collection keys are read", async () => {
    const spy = spyHttp({});
    const adapter = createAwinAdapter({ accessToken: TOKEN, publisherId: PUBLISHER_ID, httpClient: spy.client });
    assert.match(ADAPTER_SRC, /extractCollection\(response\?\.data, \["commissionGroups", "data"\]\)/);
    assert.match(ADAPTER_SRC, /extractCollection\(data, \["commissionGroups", "data"\]\)/);
    const rows = await adapter.fetchCertificationCommissionGroupSample({ advertiserId: ADVERTISER_ID });
    assert.equal(rows.length, 1);
  });
});

/* ------------------------------------------------------- bounds */

describe("bounds and safety", () => {
  it("21 - no pagination anywhere in the chain or the sampler", () => {
    const start = SERVICE_SRC.indexOf("async certifyAwinCommissionGroups(");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.ok(start > -1);
    assert.ok(!/for \(|while \(|hasMore|page\+\+|offset/.test(body), "the chain loops");

    // Code only, and parameter-shaped only: "rateLimiter" and the comment explaining the pacing
    // both contain "limit", and matching my own prose is not a test.
    const samplerStart = ADAPTER_SRC.indexOf("async fetchCertificationCommissionGroupSample(");
    const sampler = ADAPTER_SRC.slice(samplerStart, ADAPTER_SRC.indexOf("\n    },", samplerStart))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/\b(page|pageSize|limit|offset|cursor)\s*:/i.test(sampler), "the sampler paginates");
    assert.ok(!/rateLimiter/.test(sampler.replace(/awinRateLimiter/g, "")), "an unexpected limiter");
  });

  it("22 - the sampler does not retry", () => {
    const samplerStart = ADAPTER_SRC.indexOf("async fetchCertificationCommissionGroupSample(");
    const sampler = ADAPTER_SRC.slice(samplerStart, ADAPTER_SRC.indexOf("\n    },", samplerStart));
    assert.ok(!sampler.includes("requestWithRetry"), "the probe inherited sync's retries");
    assert.ok(!sampler.includes("await get("), "the probe went through the retrying helper");
    assert.ok(sampler.includes("awinRateLimiter.acquireSlot()"), "the probe skips the shared limiter");
  });

  it("23 - a failing commission-group request is one attempt, categorised", async () => {
    const failure = Object.assign(new Error("boom"), {
      response: { status: 403, data: { message: "not entitled to commission groups" } },
    });
    const { entry, spy } = await certify({ error: failure });
    assert.equal(spy.calls.length, 2, "the failing request was retried");
    assert.equal(entry.ok, false);
    assert.equal(entry.statusCategory, "AUTH_FAILED");
    assert.equal(entry.supplierStatusCode, 403);
    assert.equal(entry.supplierMessage, "not entitled to commission groups");
    assert.equal(entry.advertiserIdResolved, true);
    assert.equal(entry.campaignsInspectedCount, 1);
  });

  it("23b - the SERVICE bounds both samples, independently of the adapter", async () => {
    // Defence in depth: each layer slices to one row, so removing either is invisible unless the
    // other is bypassed. This drives an adapter that deliberately returns full pages.
    const manyProgrammes = Array.from({ length: 40 }, (_, i) => ({ ...PROGRAMME_ROW, id: `90000${i}` }));
    const manyGroups = Array.from({ length: 40 }, (_, i) => ({ ...GROUP_ROW, groupId: 6000 + i }));
    let askedFor = null;
    const service = new NetworkCertificationService({
      prisma: {},
      adapterFactory: () => ({
        supplierKey: "AWIN",
        fetchCertificationSample: async () => manyProgrammes,
        fetchCertificationCommissionGroupSample: async ({ advertiserId }) => {
          askedFor = advertiserId;
          return manyGroups;
        },
      }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    });
    const result = await service.certify("awin", { sourceObjects: ["commission_groups"] });
    const entry = result.results[0];

    assert.equal(entry.campaignsInspectedCount, 1, "the service kept more than one campaign row");
    assert.equal(entry.sampleCount, 1, "the service kept more than one group row");
    assert.equal(entry.fieldPaths[0].sampleCount, 1);
    // And the id came from the FIRST campaign row only.
    assert.equal(askedFor, "900000");
  });

  it("23c - the ADAPTER bounds its own sample, independently of the service", async () => {
    const manyGroups = Array.from({ length: 40 }, (_, i) => ({ ...GROUP_ROW, groupId: 7000 + i }));
    const spy = spyHttp({ groups: manyGroups });
    const adapter = createAwinAdapter({ accessToken: TOKEN, publisherId: PUBLISHER_ID, httpClient: spy.client });
    const rows = await adapter.fetchCertificationCommissionGroupSample({ advertiserId: ADVERTISER_ID });
    assert.equal(rows.length, 1, "the adapter kept more than one row");
    assert.equal(spy.calls.length, 1);
  });

  it("23d - the chain takes no caller input at all", () => {
    const signature = SERVICE_SRC.slice(
      SERVICE_SRC.indexOf("async certifyAwinCommissionGroups("),
      SERVICE_SRC.indexOf(") {", SERVICE_SRC.indexOf("async certifyAwinCommissionGroups(")) + 1,
    );
    // Exactly these four, none of which carries request input.
    assert.equal(signature, "async certifyAwinCommissionGroups({ adapter, key, probe, budgetLeft })");

    const start = SERVICE_SRC.indexOf("async certifyAwinCommissionGroups(");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["ctx.", "options.", "req.", "probe.advertiserId", "body."]) {
      assert.ok(!body.includes(forbidden), forbidden);
    }
    // The id has exactly one origin: the campaign row this chain read itself.
    assert.match(body, /awinAdvertiserIdOf\(campaignRows\[0\]\)/);
    assert.equal((body.match(/advertiserId =/g) || []).length, 1, "the id is assigned more than once");
  });

  it("24 - read-only: the chain writes nothing", () => {
    const start = SERVICE_SRC.indexOf("async certifyAwinCommissionGroups(");
    const body = SERVICE_SRC.slice(start, SERVICE_SRC.indexOf("\n  }\n", start));
    assert.ok(!/this\.db\.|prisma\.|\.create\(|\.update\(|\.upsert\(/.test(body), "the chain writes");
  });

  it("25 - no mapper and no SupplierCommissionRule write was added", async () => {
    const mappers = readFileSync("src/modules/supplier/mappers/index.js", "utf8");
    assert.ok(!/mapAwinCommissionGroup/.test(mappers));
    const awinMapper = readFileSync("src/modules/supplier/mappers/awin.mapper.js", "utf8");
    assert.ok(!/[Cc]ommissionGroup/.test(awinMapper), "an awin commission-group mapper appeared");
    const sync = readFileSync("src/jobs/waveESupplierSync.js", "utf8");
    assert.ok(!/commission/i.test(sync), "a commission step was added to the awin sync");
  });
});

/* ------------------------------------------------------- leakage */

describe("nothing but structure leaves", () => {
  const BANNED = [
    ADVERTISER_ID,
    "zzadvertisernamezz",
    "zzgroupcodezz",
    "zzgroupnamezz",
    "zzgroupdescriptionzz",
    "zzconditiontypezz",
    "zzconditionvaluezz",
    "zzcreadzz",
    "4455",
    "7.25",
    "3.5",
    "GBP",
    "https://",
    "awin1.com",
    TOKEN,
    PUBLISHER_ID,
  ];

  it("26 - no advertiser id, group name, rate, amount or currency appears", async () => {
    const { result } = await certify({});
    const serialised = JSON.stringify(result);
    for (const banned of BANNED) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
  });

  it("27 - the discovered advertiser id is used and discarded", async () => {
    const { result, entry } = await certify({});
    assert.equal(entry.advertiserIdResolved, true, "resolution is reported as a boolean");
    assert.ok(!JSON.stringify(result).includes(ADVERTISER_ID), "the discovered id was reported");
    assert.equal(entry.advertiserId, undefined);
  });

  it("28 - every reported field is structure only, no raw payload", async () => {
    const { entry } = await certify({});
    for (const field of entry.fieldPaths) {
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
    assert.equal(entry.rows, undefined);
    assert.equal(entry.rawPayload, undefined);
    // Money is a typed path, never an amount.
    const byPath = Object.fromEntries(entry.fieldPaths.map((f) => [f.path, f]));
    assert.equal(byPath.percentage.observedType, "NUMBER");
    assert.equal(byPath.currency.observedType, "CURRENCY_CODE");
  });

  it("29 - a supplier error quoting the token and the advertiser id is scrubbed", async () => {
    const leaky = Object.assign(new Error("403"), {
      response: {
        status: 403,
        data: { message: `advertiser ${ADVERTISER_ID} refused for ${TOKEN}`, secret: TOKEN },
      },
    });
    const { result } = await certify({ error: leaky });
    const serialised = JSON.stringify(result);
    for (const banned of [TOKEN, PUBLISHER_ID, ADVERTISER_ID]) {
      assert.ok(!serialised.includes(banned), `${banned} leaked`);
    }
    assert.match(result.results[0].supplierMessage, /refused/);
  });
});

/* ------------------------------------------------------- unchanged */

describe("the other awin probes are unchanged", () => {
  it("30 - campaigns, coupons and conversions keep their contracts", async () => {
    assert.match(ADAPTER_SRC, /params: \(\) => \(\{ relationship: "joined" \}\)/);
    assert.match(ADAPTER_SRC, /body: \(\) => \(\{ filters: \{\}, pagination: \{ page: 1, pageSize: 200 \} \}\)/);
    assert.match(ADAPTER_SRC, /startDate: awinTransactionDateParam\(resolved\.window\.from\),/);
    assert.match(ADAPTER_SRC, /showBasketProducts: true,/);
  });

  it("31 - production fetchCommissionGroups is untouched and still uncalled", () => {
    assert.match(
      ADAPTER_SRC,
      /async fetchCommissionGroups\(\{ advertiserId, effectiveDate, extraConditionsDetails = true \} = \{\}, stats = null\) \{/,
    );
    assert.match(ADAPTER_SRC, /if \(!advertiserId\) throw new Error\("Awin commission groups require advertiserId"\)/);
    const samplerStart = ADAPTER_SRC.indexOf("async fetchCertificationCommissionGroupSample(");
    const sampler = ADAPTER_SRC.slice(samplerStart, ADAPTER_SRC.indexOf("\n    },", samplerStart));
    assert.ok(!sampler.includes("fetchCommissionGroups"), "certification reuses the sync fetcher");
  });
});
