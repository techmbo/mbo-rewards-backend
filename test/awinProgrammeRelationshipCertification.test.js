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

const { createAwinAdapter, AWIN_PROGRAMME_RELATIONSHIPS } = await import(
  "../src/adapters/awin.adapter.js"
);
const { NetworkCertificationService } = await import(
  "../src/modules/ops/networkCertification.service.js"
);

/**
 * Phase 22 relationship-state certification.
 *
 * Certified live already: the commission_groups probe reached Awin with an advertiser taken from
 * MBO's own canonical estate, and Awin answered 401 "No relationship exists between publisherId
 * and advertiserId". The advertiser is real; it is simply not related to this publisher account.
 * /programmes defaults to relationship=joined, which is why discovery found nothing.
 *
 * The open question is therefore about THIS ACCOUNT, not about a schema: which of the five
 * relationship states Awin documents actually hold rows. This probe asks each of them once and
 * reports whether rows exist. It reports nothing else, and it does not interpret the answer —
 * a non-zero count in a state is not a statement that anything is commercially usable.
 *
 * READ-ONLY, in both directions: no supplier write, no database read or write, no sync, no offer
 * fetch, no mapping and no persistence.
 */

const TOKEN = "zzaccesstokenzz";
const PUBLISHER_ID = "zzpub9876zz";

/** A programme row is deliberately fully populated: nothing on it may reach the response. */
const PROGRAMME_ROW = Object.freeze({
  id: 778899,
  name: "zzadvertisernamezz",
  displayUrl: "https://zzadvertiserdomainzz.example",
  clickThroughUrl: "https://zzclickthroughzz.example/x",
  currencyCode: "GBP",
  primaryRegion: { name: "zzregionnamezz", countryCode: "GB" },
});

const SECRETS = [
  TOKEN,
  PUBLISHER_ID,
  "zzadvertisernamezz",
  "zzadvertiserdomainzz",
  "zzclickthroughzz",
  "zzregionnamezz",
  "778899",
];

/**
 * An http double that answers /programmes per relationship and records every call it receives.
 *
 * `rowsFor` maps a relationship to a row count; `failFor` maps a relationship to a thrown error.
 * Anything else is a hard failure, so an unexpected request cannot pass silently.
 */
function spyHttp({ rowsFor = {}, failFor = {} } = {}) {
  const calls = [];
  const writes = [];
  const forbid = (verb) => async (...args) => {
    writes.push({ verb, args });
    throw new Error(`certification attempted a ${verb}`);
  };
  return {
    calls,
    writes,
    programmeCalls: () => calls.filter((call) => call.path.includes("/programmes")),
    client: {
      get: async (path, config = {}) => {
        calls.push({ path, params: config.params, timeout: config.timeout });
        if (!path.includes("/programmes")) throw new Error(`unexpected path ${path}`);
        const relationship = config.params?.relationship;
        if (failFor[relationship]) throw failFor[relationship];
        const count = rowsFor[relationship] ?? 0;
        return { data: { programmes: Array.from({ length: count }, () => ({ ...PROGRAMME_ROW })) } };
      },
      post: forbid("POST"),
      put: forbid("PUT"),
      patch: forbid("PATCH"),
      delete: forbid("DELETE"),
    },
  };
}

/** A prisma double that records reads and refuses every write. */
function dbSpy() {
  const queries = [];
  const writes = [];
  const forbid = (name) => (...args) => {
    writes.push({ name, args });
    throw new Error(`write attempted: ${name}`);
  };
  const model = () => ({
    findMany: async (query) => {
      queries.push(query);
      return [];
    },
    findFirst: async (query) => {
      queries.push(query);
      return null;
    },
    create: forbid("create"),
    createMany: forbid("createMany"),
    update: forbid("update"),
    updateMany: forbid("updateMany"),
    upsert: forbid("upsert"),
    delete: forbid("delete"),
    deleteMany: forbid("deleteMany"),
  });
  return {
    queries,
    writes,
    client: {
      supplierCampaign: model(),
      supplierCoupon: model(),
      campaign: model(),
      coupon: model(),
      supplierCommissionRule: model(),
      $executeRaw: forbid("$executeRaw"),
      $executeRawUnsafe: forbid("$executeRawUnsafe"),
    },
  };
}

async function certify({ rowsFor, failFor, sourceObjects = ["programme_relationships"] } = {}) {
  const spy = spyHttp({ rowsFor, failFor });
  const db = dbSpy();
  const service = new NetworkCertificationService({
    prisma: db.client,
    adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: spy.client }),
    awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
  });
  const result = await service.certify("awin", { sourceObjects });
  return { result, entry: result.results[0], spy, db };
}

const httpError = (status, message) =>
  Object.assign(new Error(message), { response: { status, data: { message } } });

const ADAPTER_SRC = readFileSync("src/adapters/awin.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const ROUTES_SRC = readFileSync("src/routes/index.js", "utf8");

describe("A — every documented relationship state is asked for, exactly as requested", () => {
  it("A1. the five values are the ones Awin documents on the same call production makes", () => {
    assert.deepEqual([...AWIN_PROGRAMME_RELATIONSHIPS], [
      "joined",
      "pending",
      "suspended",
      "rejected",
      "notjoined",
    ]);
    // Evidenced, not invented: the set is copied from the parameter list documented on the
    // fetchCampaigns the sync itself uses.
    assert.match(
      ADAPTER_SRC,
      /relationship = joined \| pending \| suspended \| rejected \| notjoined/,
      "the relationship set is not the one documented on fetchCampaigns",
    );
  });

  it("A2. each value is sent verbatim, on the path and parameter fetchCampaigns builds", async () => {
    const { spy } = await certify({ rowsFor: { joined: 0 } });
    const sent = spy.programmeCalls();

    assert.deepEqual(
      sent.map((call) => call.params.relationship),
      [...AWIN_PROGRAMME_RELATIONSHIPS],
      "a relationship was reordered, skipped or renamed on the wire",
    );
    for (const call of sent) {
      assert.equal(call.path, `/publishers/${PUBLISHER_ID}/programmes`, "not the programmes path");
      // No extra steering: the relationship is the whole query.
      assert.deepEqual(Object.keys(call.params), ["relationship"], "an extra parameter was sent");
    }
    // The same path and parameter name production builds, so the probe cannot certify a request
    // production could not make.
    assert.match(ADAPTER_SRC, /`\/publishers\/\$\{pubId\}\/programmes`/);
  });

  it("A3. a relationship outside the evidenced set is refused before any request", async () => {
    const spy = spyHttp();
    const adapter = createAwinAdapter({
      accessToken: TOKEN,
      publisherId: PUBLISHER_ID,
      httpClient: spy.client,
    });
    for (const bad of ["", null, undefined, "all", "JOINED", "joined; drop", 7]) {
      await assert.rejects(
        () => adapter.fetchCertificationProgrammeRelationshipSample({ relationship: bad }),
        /evidenced relationship/,
        `accepted ${String(bad)}`,
      );
    }
    assert.deepEqual(spy.calls, [], "a rejected relationship still reached the supplier");
  });
});

describe("B — the adapter default is untouched", () => {
  it("B1. fetchCampaigns still defaults to joined and is not routed through the probe", () => {
    assert.match(
      ADAPTER_SRC,
      /relationship: params\.relationship \?\? "joined",/,
      "the production default changed",
    );
    assert.equal(
      (ADAPTER_SRC.match(/params\.relationship \?\? "joined"/g) || []).length,
      1,
      "the production default is stated in more than one place",
    );
  });

  it("B2. no probed relationship is left to a default — every request states one", async () => {
    const { spy } = await certify({ rowsFor: { notjoined: 3 } });
    for (const call of spy.programmeCalls()) {
      assert.ok(
        AWIN_PROGRAMME_RELATIONSHIPS.includes(call.params.relationship),
        `a request fell back to a default: ${JSON.stringify(call.params)}`,
      );
    }
    // Including "joined": it is probed because it was asked for, not because it is the default.
    assert.equal(
      spy.programmeCalls().filter((call) => call.params.relationship === "joined").length,
      1,
    );
  });
});

describe("C/D — the request budget", () => {
  it("C1. exactly one supplier request per relationship, and no retry", async () => {
    const { entry, spy } = await certify({ rowsFor: { joined: 1, notjoined: 2 } });
    const perRelationship = new Map();
    for (const call of spy.programmeCalls()) {
      const key = call.params.relationship;
      perRelationship.set(key, (perRelationship.get(key) ?? 0) + 1);
    }
    for (const relationship of AWIN_PROGRAMME_RELATIONSHIPS) {
      assert.equal(perRelationship.get(relationship), 1, `${relationship} was requested twice`);
    }
    assert.equal(entry.relationshipsProbed, AWIN_PROGRAMME_RELATIONSHIPS.length);
  });

  it("C2. a failure is not retried either, and is still counted as a request made", async () => {
    const { entry, spy } = await certify({
      failFor: { suspended: httpError(500, "zzupstreamzz") },
    });
    assert.equal(
      spy.programmeCalls().filter((call) => call.params.relationship === "suspended").length,
      1,
      "a failed relationship was retried",
    );
    assert.equal(entry.supplierRequestCount, 5, "a failed request was not counted");
  });

  it("C3. certification bypasses requestWithRetry, which is what makes C2 structural", () => {
    const probe = ADAPTER_SRC.slice(
      ADAPTER_SRC.indexOf("async fetchCertificationProgrammeRelationshipSample"),
      ADAPTER_SRC.indexOf("async fetchAll(options = {})"),
    );
    assert.ok(probe.length > 0, "the sampler moved");
    assert.ok(probe.includes("httpClient.get("), "the sampler does not call the http client directly");
    assert.ok(!probe.includes("requestWithRetry"), "the sampler inherited the retrying fetcher");
    assert.ok(!probe.includes("fetchCampaigns"), "the sampler went through the sync fetcher");
  });

  it("D1. five requests in total, in the worst case where every relationship fails", async () => {
    const failFor = Object.fromEntries(
      AWIN_PROGRAMME_RELATIONSHIPS.map((r) => [r, httpError(503, "zzunavailablezz")]),
    );
    const { entry, spy } = await certify({ failFor });
    assert.equal(spy.calls.length, 5, "more than five supplier requests were made");
    assert.equal(entry.supplierRequestCount, 5);
  });

  it("D2. five requests in total on the all-succeed path too", async () => {
    const rowsFor = Object.fromEntries(AWIN_PROGRAMME_RELATIONSHIPS.map((r) => [r, 4]));
    const { entry, spy } = await certify({ rowsFor });
    assert.equal(spy.calls.length, 5);
    assert.equal(entry.supplierRequestCount, 5);
  });
});

describe("E/F — the response carries counts and booleans, and nothing else", () => {
  it("E1. a relationship entry has only the evidenced keys", async () => {
    const { entry } = await certify({ rowsFor: { notjoined: 6 } });
    assert.deepEqual(
      Object.keys(entry.relationships).sort(),
      [...AWIN_PROGRAMME_RELATIONSHIPS].sort(),
    );
    assert.deepEqual(Object.keys(entry.relationships.notjoined).sort(), [
      "hasRows",
      "ok",
      "relationship",
      "sampleCount",
      "statusCategory",
    ]);
    assert.equal(entry.relationships.notjoined.sampleCount, 6);
    assert.equal(entry.relationships.notjoined.hasRows, true);
    assert.equal(entry.relationships.notjoined.statusCategory, "OK");
  });

  it("E2. every reported value is a number, a boolean or a known string token", async () => {
    const { entry } = await certify({ rowsFor: { joined: 0, notjoined: 6 } });
    for (const [relationship, value] of Object.entries(entry.relationships)) {
      assert.equal(typeof value.sampleCount, "number", relationship);
      assert.equal(typeof value.hasRows, "boolean", relationship);
      assert.equal(typeof value.ok, "boolean", relationship);
      assert.ok(
        ["OK", "OK_NO_ROWS"].includes(value.statusCategory),
        `${relationship} reported ${value.statusCategory}`,
      );
      assert.equal(value.relationship, relationship);
    }
    // No shape is claimed: this probe reads no row, so it can certify no schema.
    assert.equal(entry.schema, "UNKNOWN_NEEDS_LIVE_DATA");
    assert.deepEqual(entry.fieldPaths, [], "a field path was derived from a row");
    assert.equal(entry.sampleCount, 0, "a row was reported as a certification sample");
  });

  it("F1. no programme row, advertiser id, name, url, publisher id or token appears anywhere", async () => {
    const rowsFor = Object.fromEntries(AWIN_PROGRAMME_RELATIONSHIPS.map((r) => [r, 3]));
    const { result } = await certify({ rowsFor });
    const serialized = JSON.stringify(result);
    for (const secret of SECRETS) {
      assert.ok(!serialized.includes(secret), `the response leaked ${secret.slice(0, 6)}…`);
    }
    for (const key of ["displayUrl", "clickThroughUrl", "currencyCode", "primaryRegion"]) {
      assert.ok(!serialized.includes(key), `a raw programme field survived: ${key}`);
    }
  });

  it("F2. the adapter itself drops the rows — the caller is never handed one", async () => {
    const spy = spyHttp({ rowsFor: { joined: 3 } });
    const adapter = createAwinAdapter({
      accessToken: TOKEN,
      publisherId: PUBLISHER_ID,
      httpClient: spy.client,
    });
    const sample = await adapter.fetchCertificationProgrammeRelationshipSample({
      relationship: "joined",
    });
    assert.deepEqual(Object.keys(sample).sort(), ["observedRowCount", "relationship"]);
    assert.equal(sample.observedRowCount, 3);
    assert.ok(!JSON.stringify(sample).includes("zzadvertisernamezz"));
  });

  it("F3. a supplier error message is redacted through the shared failure builder", async () => {
    // Awin's own 401 names both ids. The message must survive only if nothing identifying does.
    const message = `No relationship exists between publisherId ${PUBLISHER_ID} and advertiserId 778899`;
    const failFor = Object.fromEntries(
      AWIN_PROGRAMME_RELATIONSHIPS.map((r) => [r, httpError(401, message)]),
    );
    const { result, entry } = await certify({ failFor });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(PUBLISHER_ID), "the publisher id survived redaction");
    assert.ok(!serialized.includes(TOKEN), "the access token survived redaction");
    assert.equal(entry.relationships.joined.supplierStatusCode, 401);
    // The shared builder, not a hand-rolled entry, so redaction cannot drift per probe.
    const chain = SERVICE_SRC.slice(
      SERVICE_SRC.indexOf("async certifyAwinProgrammeRelationships("),
      SERVICE_SRC.indexOf("async certifyAwinCommissionGroups("),
    );
    assert.ok(chain.length > 0, "the chain moved");
    assert.match(chain, /certificationFailure\(entryBase, error, \{\}, redactionValuesFor\(adapter\)\)/);
  });
});

describe("G — one failing relationship does not stop the others", () => {
  it("G1. the remaining four are still asked, and the four answers are still reported", async () => {
    const { entry, spy } = await certify({
      rowsFor: { joined: 0, pending: 2, rejected: 0, notjoined: 5 },
      failFor: { suspended: httpError(500, "zzdownstreamzz") },
    });

    assert.deepEqual(
      spy.programmeCalls().map((call) => call.params.relationship),
      [...AWIN_PROGRAMME_RELATIONSHIPS],
      "a failure stopped a later relationship being asked",
    );
    assert.equal(entry.relationships.suspended.ok, false);
    assert.equal(entry.relationships.suspended.hasRows, false);
    assert.equal(entry.relationships.suspended.statusCategory, "UPSTREAM_ERROR");
    for (const survivor of ["joined", "pending", "rejected", "notjoined"]) {
      assert.equal(entry.relationships[survivor].ok, true, survivor);
    }
    assert.equal(entry.relationships.notjoined.sampleCount, 5);
    assert.equal(entry.ok, true, "a partial answer is still an answer");
  });

  it("G2. the four distinguishable outcomes are each reported as themselves", async () => {
    // valid empty / permission failure / upstream failure / rows present — the whole point of
    // probing the states separately.
    const { entry } = await certify({
      rowsFor: { joined: 0, notjoined: 9 },
      failFor: {
        pending: httpError(401, "zzunauthorisedzz"),
        suspended: httpError(503, "zzunavailablezz"),
      },
    });
    assert.equal(entry.relationships.joined.statusCategory, "OK_NO_ROWS");
    assert.equal(entry.relationships.joined.ok, true, "an empty answer is not a failure");
    assert.equal(entry.relationships.pending.statusCategory, "AUTH_FAILED");
    assert.equal(entry.relationships.suspended.statusCategory, "UPSTREAM_ERROR");
    assert.equal(entry.relationships.notjoined.statusCategory, "OK");
    assert.equal(entry.relationships.notjoined.hasRows, true);
  });

  it("G3. when every relationship fails, nothing is reported as empty", async () => {
    const failFor = Object.fromEntries(
      AWIN_PROGRAMME_RELATIONSHIPS.map((r) => [r, httpError(503, "zzunavailablezz")]),
    );
    const { entry } = await certify({ failFor });
    assert.equal(entry.ok, false);
    assert.equal(entry.statusCategory, "SUPPLIER_ERROR");
    for (const relationship of AWIN_PROGRAMME_RELATIONSHIPS) {
      assert.equal(entry.relationships[relationship].hasRows, false, relationship);
      assert.equal(entry.relationships[relationship].ok, false, relationship);
    }
  });
});

describe("H/I — the answer is reported, never interpreted", () => {
  it("H1. joined=0 with notjoined>0 is reported exactly, with no eligibility claim", async () => {
    // The live-evidenced shape: nothing joined, and a large notjoined estate.
    const { entry } = await certify({
      rowsFor: { joined: 0, pending: 0, suspended: 0, rejected: 0, notjoined: 1418 },
    });
    assert.equal(entry.relationships.joined.sampleCount, 0);
    assert.equal(entry.relationships.joined.hasRows, false);
    assert.equal(entry.relationships.joined.statusCategory, "OK_NO_ROWS");
    assert.equal(entry.relationships.notjoined.sampleCount, 1418);
    assert.equal(entry.relationships.notjoined.hasRows, true);
    assert.equal(entry.statusCategory, "OK", "rows exist somewhere, so the run is OK");

    // A count is a count. Nothing in the result claims the account may trade, earn, or be paid.
    const serialized = JSON.stringify(entry);
    for (const word of ["eligible", "eligibility", "usable", "payable", "commissionable", "approved"]) {
      assert.ok(!serialized.toLowerCase().includes(word), `the probe interpreted: ${word}`);
    }
    assert.ok(!("recommendation" in entry) && !("conclusion" in entry));
  });

  it("I1. zero rows in all five states is an answer, not a failure", async () => {
    const { entry } = await certify({
      rowsFor: Object.fromEntries(AWIN_PROGRAMME_RELATIONSHIPS.map((r) => [r, 0])),
    });
    assert.equal(entry.ok, true, "five successful empty answers were reported as a failure");
    assert.equal(entry.statusCategory, "OK_NO_ROWS");
    for (const relationship of AWIN_PROGRAMME_RELATIONSHIPS) {
      const value = entry.relationships[relationship];
      assert.equal(value.ok, true, relationship);
      assert.equal(value.sampleCount, 0, relationship);
      assert.equal(value.hasRows, false, relationship);
      assert.equal(value.statusCategory, "OK_NO_ROWS", relationship);
    }
    // Distinguishable from G3, which is the same zero with a different cause.
    assert.notEqual(entry.statusCategory, "SUPPLIER_ERROR");
  });
});

describe("J — read-only, in both directions", () => {
  it("J1. no database call at all, read or write", async () => {
    const { db } = await certify({ rowsFor: { notjoined: 2 } });
    assert.deepEqual(db.queries, [], "the relationship probe read the database");
    assert.deepEqual(db.writes, [], "the relationship probe wrote to the database");
  });

  it("J2. no supplier write verb, on the success or the failure path", async () => {
    const ok = await certify({ rowsFor: { notjoined: 2 } });
    assert.deepEqual(ok.spy.writes, []);
    const failed = await certify({
      failFor: Object.fromEntries(
        AWIN_PROGRAMME_RELATIONSHIPS.map((r) => [r, httpError(500, "zzdownstreamzz")]),
      ),
    });
    assert.deepEqual(failed.spy.writes, []);
    for (const call of ok.spy.calls) {
      assert.ok(call.path.includes("/programmes"), `an unrelated endpoint was called: ${call.path}`);
    }
  });

  it("J3. the chain persists nothing and fetches no offers", () => {
    const chain = SERVICE_SRC.slice(
      SERVICE_SRC.indexOf("async certifyAwinProgrammeRelationships("),
      SERVICE_SRC.indexOf("async certifyAwinCommissionGroups("),
    );
    for (const forbidden of [
      "prisma",
      "this.db",
      "create(",
      "update(",
      "upsert(",
      "deleteMany(",
      "fetchOffers",
      "fetchCoupons",
      "fetchAll",
      "SupplierCommissionRule",
    ]) {
      assert.ok(!chain.includes(forbidden), `the chain reaches for ${forbidden}`);
    }
    // Exactly one supplier call site, inside the loop.
    assert.equal(
      (chain.match(/await adapter\./g) || []).length,
      1,
      "the chain has more than one supplier call site",
    );
  });
});

describe("K — the probe rides the existing gated route, and adds none", () => {
  it("K1. no new route was added; execution is still the POST run endpoint", () => {
    assert.equal(
      (ROUTES_SRC.match(/network-certification/g) || []).length,
      2,
      "a route was added or removed",
    );
    assert.ok(!ROUTES_SRC.includes("programme-relationship"), "an ad hoc route was added");
    assert.ok(!ROUTES_SRC.includes("relationship-state"), "an ad hoc route was added");
  });

  it("K2. the run endpoint is still admin-authenticated and INTEGRATIONS_MANAGE gated", () => {
    const block = ROUTES_SRC.slice(
      ROUTES_SRC.indexOf('router.post(\n  "/ops/admin/network-certification/:network/run"'),
    ).slice(0, 900);
    assert.ok(block.length > 0, "the run route moved");
    assert.match(block, /authenticate,/);
    assert.match(block, /requirePermission\(PERMISSIONS\.INTEGRATIONS_MANAGE\)/);
    assert.match(block, /noStoreHeaders,/);
    assert.match(block, /certificationRateLimiter,/);
  });

  it("K3. it is reachable only as a named source object, never by default", async () => {
    const spy = spyHttp({ rowsFor: { notjoined: 1 } });
    const db = dbSpy();
    const service = new NetworkCertificationService({
      prisma: db.client,
      adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: spy.client }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    });
    const result = await service.certify("awin", { sourceObjects: ["campaigns"] });
    assert.ok(
      !result.results.some((row) => row.sourceObject === "programme_relationships"),
      "the relationship probe ran without being asked for",
    );
    assert.ok(
      spy.programmeCalls().every((call) => call.params?.relationship !== "notjoined"),
      "a non-joined relationship was requested by a campaigns run",
    );
  });
});

describe("L — existing certification behaviour is unchanged", () => {
  it("L1. a campaigns run makes exactly the request it made before", async () => {
    const spy = spyHttp({ rowsFor: { joined: 1 } });
    const db = dbSpy();
    const service = new NetworkCertificationService({
      prisma: db.client,
      adapterFactory: (config) => createAwinAdapter({ ...config, httpClient: spy.client }),
      awinCredentialResolver: async () => ({ accessToken: TOKEN, publisherId: PUBLISHER_ID }),
    });
    await service.certify("awin", { sourceObjects: ["campaigns"] });
    assert.equal(spy.calls.length, 1, "the campaigns probe changed its request count");
    assert.equal(spy.calls[0].path, `/publishers/${PUBLISHER_ID}/programmes`);
    assert.equal(spy.calls[0].params.relationship, "joined");
  });

  it("L2. the sync path is untouched — fetchCampaigns still asks joined by default", async () => {
    const spy = spyHttp({ rowsFor: { joined: 2 } });
    const adapter = createAwinAdapter({
      accessToken: TOKEN,
      publisherId: PUBLISHER_ID,
      httpClient: spy.client,
    });
    const rows = await adapter.fetchCampaigns();
    assert.equal(rows.length, 2, "the sync fetcher's own shape changed");
    assert.equal(spy.calls[0].params.relationship, "joined");
  });

  it("L3. the new probe is declared diagnostic and is not an ingestion source", () => {
    const catalog = readFileSync("src/modules/networkOps/sourceObjects.catalog.js", "utf8");
    const anchor = catalog.indexOf('sourceObject: "programme_relationships"');
    assert.notEqual(anchor, -1, "the catalog entry is missing");
    const block = catalog.slice(anchor, anchor + 700);
    assert.match(block, /live: false/, "the entry claims a live ingestion");
    assert.match(block, /IMPLEMENTED_NOT_INGESTED/, "the entry claims an ingested availability");
    assert.match(block, /entityType: null/, "the entry claims a canonical entity");
  });

  it("L4. nothing in the commission or campaign mapping changed alongside it", () => {
    // The endpoints and bodies the other Awin probes pin, re-asserted here so this phase cannot
    // quietly move one while adding a relationship probe.
    assert.match(ADAPTER_SRC, /path: \(resolved\) => `\/publishers\/\$\{resolved\.publisherId\}\/transactions\/`/);
    assert.match(ADAPTER_SRC, /body: \(\) => \(\{ filters: \{\}, pagination: \{ page: 1, pageSize: 200 \} \}\)/);
    assert.ok(
      SERVICE_SRC.includes("advertiserIdSource"),
      "the commission_groups advertiser resolution was removed",
    );
    assert.match(SERVICE_SRC, /supplier: "AWIN", archivedAt: null/);
  });
});
