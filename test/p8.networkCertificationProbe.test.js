import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const { categorise, collectPaths, comparePathSets, isCredentialKey, summarisePayloads } = await import(
  "../src/modules/ops/payloadShape.js"
);
const {
  DEFAULT_WINDOW_PRESET,
  NetworkCertificationService,
  WINDOW_PRESETS,
  COMMISSION_GROUP_CANDIDATE_LIMIT,
  MAX_SUPPLIER_REQUESTS_COMMISSION_GROUPS,
  MAX_SUPPLIER_REQUESTS_PER_SOURCE,
  MAX_SUPPLIER_REQUESTS_PRODUCTS,
  campaignDetailIdOf,
  commissionGroupCampaignIdOf,
  listProbeSourceObjects,
  statusCategory,
} = await import("../src/modules/ops/networkCertification.service.js");
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../src/auth/permissions.js");
const { parseRunBody, networkCertificationCatalogHandler, networkCertificationRunHandler } = await import(
  "../src/controllers/networkCertification.controller.js"
);
const routesSource = (await import("node:fs")).readFileSync("src/routes/index.js", "utf8");
const adapterSource = (await import("node:fs")).readFileSync("src/adapters/optimise.adapter.js", "utf8");
const certServiceSource = (await import("node:fs")).readFileSync(
  "src/modules/ops/networkCertification.service.js",
  "utf8",
);
const serviceSourceText = () => certServiceSource;
const { CertificationThrottledError, CertificationTimeoutError, createOptimiseAdapter, listCertificationSamples } =
  await import("../src/adapters/optimise.adapter.js");
const { ALLOWED_FEED_HOSTS, FeedItemSampleNotBoundedError, buildBoundedFeedUrl, parseFirstFeedRecord } =
  await import("../src/adapters/optimiseFeedSample.js");

/** A supplier payload carrying every kind of value the probe must never echo. */
const SECRET_VALUES = [
  "sk_live_51H8xQ2abcdefGHIJK",
  "Bearer abcdefghijklmnopqrstuvwxyz012345",
  "hunter2",
  "arn:aws:secretsmanager:eu-west-1:1234:secret/optimise",
  "?X-Amz-Signature=deadbeefcafe1234567890",
];

function supplierRecord(extra = {}) {
  return {
    id: 56577,
    name: "Ubuy SG",
    advertiserName: "Ubuy",
    status: "ACTIVE",
    currency: "USD",
    conversionDate: "2026-09-01T10:00:00Z",
    baseTrackingUrl: "https://track.optimise.test/click?PID=999",
    commissionCost: 5.5,
    isExclusive: true,
    vertical: { id: 4, name: "Retail" },
    markets: ["SG", "MY"],
    publishers: [{ campaignSubStatus: "JOINED", id: 12 }],
    emptyField: null,
    // Credential-shaped keys a supplier response might legitimately carry.
    apiKey: SECRET_VALUES[0],
    authorization: SECRET_VALUES[1],
    password: SECRET_VALUES[2],
    secretRef: SECRET_VALUES[3],
    signedUrl: `https://cdn.test/feed.csv${SECRET_VALUES[4]}`,
    nested: { token: SECRET_VALUES[0], access_token: SECRET_VALUES[1], safeValue: "plain" },
    ...extra,
  };
}

function serialise(value) {
  return JSON.stringify(value);
}

/** Module-scope service double, used by the compareRaw gating tests below. */
function makeServiceForRaw() {
  const calls = [];
  const writes = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];
  const model = (name) => {
    const target = {
      findMany: async () => {
        calls.push(`${name}.findMany`);
        return [];
      },
      findFirst: async () => {
        calls.push(`${name}.findFirst`);
        return null;
      },
      findUnique: async () => {
        calls.push(`${name}.findUnique`);
        return null;
      },
      count: async () => {
        calls.push(`${name}.count`);
        return 0;
      },
    };
    for (const w of writes) {
      target[w] = async () => {
        calls.push(`WRITE:${name}.${w}`);
        throw new Error(`forbidden write: ${name}.${w}`);
      };
    }
    return target;
  };
  const db = { calls, rawPayload: model("rawPayload"), marketplaceAccount: model("marketplaceAccount") };
  const service = new NetworkCertificationService({
    prisma: db,
    adapterFactory: () => ({
      fetchCertificationSample: async () => [supplierRecord()],
    }),
    credentialResolver: async () => ({
      apiKey: SECRET_VALUES[0],
      agencyId: "AG1",
      contactId: "C1",
      baseURL: "https://public.api.optimise.test/v1",
    }),
  });
  return { service, db };
}

describe("payload shape — values never escape", () => {
  it("emits paths and categories, never a supplier value", () => {
    const fields = summarisePayloads([supplierRecord()]);
    const text = serialise(fields);
    for (const secret of SECRET_VALUES) {
      assert.ok(!text.includes(secret), `secret leaked: ${secret.slice(0, 12)}…`);
    }
    // Ordinary values must not appear either — not just the secret ones.
    for (const value of ["Ubuy SG", "Ubuy", "56577", "track.optimise.test", "Retail", "JOINED", "5.5"]) {
      assert.ok(!text.includes(value), `value leaked: ${value}`);
    }
  });

  it("every emitted field carries only the declared structural keys", () => {
    const allowed = new Set([
      "path",
      "observedType",
      "exampleCategory",
      "nullableObserved",
      "arrayObserved",
      "objectObserved",
      "presentCount",
      "sampleCount",
    ]);
    for (const field of summarisePayloads([supplierRecord()])) {
      for (const key of Object.keys(field)) assert.ok(allowed.has(key), `unexpected key: ${key}`);
      assert.equal(typeof field.path, "string");
      assert.equal(typeof field.presentCount, "number");
    }
  });

  it("suppresses the category of credential-shaped keys", () => {
    const byPath = new Map(summarisePayloads([supplierRecord()]).map((f) => [f.path, f]));
    for (const path of ["apiKey", "authorization", "password", "secretRef", "nested.token", "nested.access_token"]) {
      assert.equal(byPath.get(path)?.exampleCategory, "REDACTED", path);
    }
    // A neighbouring ordinary field in the same object is still categorised normally.
    assert.equal(byPath.get("nested.safeValue")?.exampleCategory, "STRING");
  });

  it("recognises credential keys by name, in any common spelling", () => {
    for (const key of ["apiKey", "api_key", "APIKEY", "access_token", "refreshToken", "secret", "secretRef", "password", "Authorization", "signature", "sig", "hmac", "privateKey", "sessionId", "cookie"]) {
      assert.equal(isCredentialKey(key), true, key);
    }
    for (const key of ["campaignName", "status", "currency", "id", "title", "significantOther"]) {
      assert.equal(isCredentialKey(key), false, key);
    }
  });

  it("categorises values structurally", () => {
    assert.equal(categorise("https://x.test/a"), "URL");
    assert.equal(categorise("2026-09-01T10:00:00Z"), "ISO_DATE");
    assert.equal(categorise("2026-09-01"), "ISO_DATE");
    assert.equal(categorise("USD"), "CURRENCY_CODE");
    assert.equal(categorise("SKU-123"), "ID_LIKE");
    assert.equal(categorise("a plain sentence"), "STRING");
    assert.equal(categorise(12), "NUMBER");
    assert.equal(categorise(true), "BOOLEAN");
    assert.equal(categorise(null), "NULL");
    assert.equal(categorise([1]), "ARRAY");
    assert.equal(categorise({ a: 1 }), "OBJECT");
  });

  it("detects arrays and objects and collapses array indices", () => {
    const byPath = new Map(summarisePayloads([supplierRecord()]).map((f) => [f.path, f]));
    assert.equal(byPath.get("markets")?.arrayObserved, true);
    assert.equal(byPath.get("vertical")?.objectObserved, true);
    assert.ok(byPath.has("publishers[].campaignSubStatus"), "array indices collapse to []");
    assert.ok(![...byPath.keys()].some((p) => /\[\d+\]/.test(p)), "no numeric indices in paths");
  });

  it("counts nullability across a sample", () => {
    const fields = summarisePayloads([supplierRecord(), supplierRecord({ emptyField: "now set" }), { id: 3 }]);
    const byPath = new Map(fields.map((f) => [f.path, f]));
    assert.equal(byPath.get("id").presentCount, 3);
    assert.equal(byPath.get("id").sampleCount, 3);
    assert.equal(byPath.get("name").nullableObserved, true, "absent in the third record");
    assert.equal(byPath.get("emptyField").presentCount, 1, "null in one, set in another");
  });

  it("bounds depth and breadth so a pathological payload cannot hang the probe", () => {
    let deep = { leaf: 1 };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };
    const paths = collectPaths(deep, { maxDepth: 5 });
    assert.ok(paths.size <= 6, `depth not bounded: ${paths.size}`);
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i]));
    assert.ok(collectPaths(wide, { maxPaths: 100 }).size <= 100);
  });
});

describe("raw comparison", () => {
  it("classifies paths without exposing values", () => {
    const rows = comparePathSets(["a", "b"], ["b", "c"]);
    assert.deepEqual(rows, [
      { path: "a", state: "LIVE_ONLY" },
      { path: "b", state: "LIVE_AND_RAW" },
      { path: "c", state: "RAW_ONLY" },
    ]);
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["path", "state"]);
  });
});

describe("probe dispatch", () => {
  const OPTIMISE_OBJECTS = [
    "campaigns",
    "voucher_codes",
    "conversions",
    "payment_overview",
    "invoices",
    "products",
    "reporting",
    "invoiceReporting",
    "commission_groups",
    "campaign_detail",
    "basket_items",
  ];

  function makeDb() {
    const calls = [];
    const writes = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];
    const model = (name) => {
      const target = {
        findMany: async () => {
          calls.push(`${name}.findMany`);
          return [];
        },
        findFirst: async () => {
          calls.push(`${name}.findFirst`);
          return null;
        },
        findUnique: async () => {
          calls.push(`${name}.findUnique`);
          return null;
        },
        count: async () => {
          calls.push(`${name}.count`);
          return 0;
        },
      };
      for (const w of writes) {
        target[w] = async () => {
          calls.push(`WRITE:${name}.${w}`);
          throw new Error(`forbidden write: ${name}.${w}`);
        };
      }
      return target;
    };
    return { calls, rawPayload: model("rawPayload"), marketplaceAccount: model("marketplaceAccount") };
  }

  /** One bounded row per source object, as the real sampler returns. */
  const SAMPLE_ROWS = Object.freeze({
    // A real Optimise row carries both namespaces; these are the live-certified values.
    campaigns: [supplierRecord({ campaignId: "7340528", productId: "57316" })],
    voucher_codes: [{ voucherCodeId: 1, voucherCode: "SAVE10" }],
    conversions: [{ conversionId: 9, currency: "USD" }],
    payment_overview: [{ paymentId: 3 }],
    invoices: [{ invoiceId: 4 }],
    products: [{ FeedID: 7, PID: 999 }],
    campaign_candidates: [supplierRecord({ campaignId: "7340528", productId: "57316" })],
    commission_groups: [{ commission_group_id: 5 }],
    campaign_detail: [{ id: 56577, name: "Ubuy SG" }],
  });

  /**
   * Records every adapter method the probe invokes, so mutations can be asserted absent.
   *
   * The sync fetchers are present deliberately: if the service ever regressed to calling one, it
   * would be recorded here and the read-only assertions would name it, rather than the double
   * failing with "not a function" and hiding which call was made.
   */
  function makeAdapter() {
    const called = [];
    const record = (name, value) => {
      called.push(name);
      return value;
    };
    const syncFetcher = (name) => async () => record(name, []);
    return {
      called,
      fetchCampaigns: syncFetcher("fetchCampaigns"),
      fetchVoucherCodes: syncFetcher("fetchVoucherCodes"),
      fetchConversions: syncFetcher("fetchConversions"),
      fetchPayments: syncFetcher("fetchPayments"),
      fetchInvoices: syncFetcher("fetchInvoices"),
      fetchProductFeeds: syncFetcher("fetchProductFeeds"),
      fetchReporting: syncFetcher("fetchReporting"),
      fetchInvoiceReporting: syncFetcher("fetchInvoiceReporting"),
      fetchCommissionGroups: syncFetcher("fetchCommissionGroups"),
      fetchCampaignDetail: syncFetcher("fetchCampaignDetail"),
      // The only methods the service is allowed to call.
      fetchCertificationSample: async (sourceObject) =>
        record(`fetchCertificationSample:${sourceObject}`, SAMPLE_ROWS[sourceObject] ?? []),
      fetchCertificationCommissionGroupSample: async () =>
        record("fetchCertificationCommissionGroupSample", {
          rows: SAMPLE_ROWS.commission_groups,
          envelopeKind: "array",
        }),
    };
  }

  function makeService(db = makeDb(), adapter = makeAdapter()) {
    return {
      db,
      adapter,
      service: new NetworkCertificationService({
        prisma: db,
        adapterFactory: () => adapter,
        credentialResolver: async () => ({
          apiKey: SECRET_VALUES[0],
          agencyId: "AG1",
          contactId: "C1",
          baseURL: "https://public.api.optimise.test/v1",
        }),
      }),
    };
  }

  it("exposes exactly the Optimise source objects the phase asked for", () => {
    assert.deepEqual(listProbeSourceObjects("optimise").sort(), [...OPTIMISE_OBJECTS].sort());
  });

  it("reports basket_items as unsupported rather than omitting it", async () => {
    const { service } = makeService();
    const out = await service.certify("optimise", { sourceObjects: ["basket_items"], compareRaw: false });
    assert.equal(out.results[0].statusCategory, "UNSUPPORTED");
    assert.match(out.results[0].note, /no basket-item endpoint/i);
  });

  it("calls only read methods on the adapter", async () => {
    const { service, adapter } = makeService();
    await service.certify("optimise", { compareRaw: false });
    for (const name of adapter.called) {
      assert.ok(/^fetch[A-Za-z]*(:|$)/.test(name), `non-read adapter call: ${name}`);
      assert.ok(!/join|leave|create|update|approve|reject|upload|delete|post[A-Z]/i.test(name), name);
    }
  });

  it("performs no database write", async () => {
    const { service, db } = makeService();
    await service.certify("optimise", {});
    assert.equal(db.calls.some((c) => c.startsWith("WRITE:")), false, db.calls.join(", "));
  });

  it("honours a one-record sample", async () => {
    const { service } = makeService();
    const out = await service.certify("optimise", { sourceObjects: ["campaigns"], compareRaw: false });
    assert.equal(out.results[0].sampleCount, 1);
  });

  it("never serialises the credential anywhere in the response", async () => {
    const { service } = makeService();
    const text = serialise(await service.certify("optimise", {}));
    for (const secret of SECRET_VALUES) assert.ok(!text.includes(secret), secret.slice(0, 12));
    for (const value of ["AG1", "C1", "SAVE10", "Ubuy SG", "7340528", "57316"]) {
      assert.ok(!text.includes(value), `value leaked: ${value}`);
    }
  });

  it("takes the campaign id from a sample, not from the caller", async () => {
    const { service, adapter } = makeService();
    const out = await service.certify("optimise", { sourceObjects: ["campaign_detail"], compareRaw: false });
    assert.ok(
      adapter.called.includes("fetchCertificationSample:campaigns"),
      "campaigns sampled to obtain the id",
    );
    assert.equal(adapter.called.includes("fetchCampaigns"), false, "never the sync fetcher");
    assert.equal(out.results[0].statusCategory, "OK");
  });

  it("commission groups take their ids from their own bounded campaign list", async () => {
    const { service, adapter } = makeService();
    const out = await service.certify("optimise", { sourceObjects: ["commission_groups"], compareRaw: false });
    assert.ok(adapter.called.includes("fetchCertificationSample:campaign_candidates"));
    assert.equal(adapter.called.includes("fetchCampaigns"), false, "never the sync fetcher");
    assert.equal(out.results[0].statusCategory, "OK");
  });

  it("skips campaign-scoped probes when no campaign sample is available", async () => {
    const adapter = makeAdapter();
    adapter.fetchCertificationSample = async () => [];
    const { service } = makeService(makeDb(), adapter);
    const out = await service.certify("optimise", { sourceObjects: ["campaign_detail"], compareRaw: false });
    assert.equal(out.results[0].statusCategory, "SKIPPED_NO_CAMPAIGN_DETAIL_ID");
  });

  it("reduces a supplier failure to a status category with no error text", async () => {
    const adapter = makeAdapter();
    adapter.fetchCertificationSample = async () => {
      const error = new Error("Invalid `prisma.x.findMany()` — apikey sk_live_51H8xQ2abcdefGHIJK rejected");
      error.response = { status: 401 };
      throw error;
    };
    const { service } = makeService(makeDb(), adapter);
    const out = await service.certify("optimise", { sourceObjects: ["campaigns"], compareRaw: false });
    assert.equal(out.results[0].statusCategory, "AUTH_FAILED");
    const text = serialise(out);
    assert.ok(!text.includes("prisma"));
    assert.ok(!text.includes(SECRET_VALUES[0]));
  });

  it("maps HTTP statuses to categories", () => {
    assert.equal(statusCategory({ response: { status: 403 } }), "AUTH_FAILED");
    assert.equal(statusCategory({ response: { status: 404 } }), "NOT_FOUND");
    assert.equal(statusCategory({ response: { status: 429 } }), "RATE_LIMITED");
    assert.equal(statusCategory({ response: { status: 503 } }), "UPSTREAM_ERROR");
    assert.equal(statusCategory({ response: { status: 400 } }), "REQUEST_REJECTED");
    assert.equal(statusCategory(new Error("socket")), "NETWORK_ERROR");
  });

  it("rejects an unknown network and unknown source objects", async () => {
    const { service } = makeService();
    await assert.rejects(() => service.certify("nosuchnetwork", {}), /no certification probe/i);
    await assert.rejects(
      () => service.certify("optimise", { sourceObjects: ["definitely_not_real"] }),
      /unknown source objects/i,
    );
  });

  it("reports missing credentials without describing them", async () => {
    const service = new NetworkCertificationService({
      prisma: makeDb(),
      adapterFactory: () => makeAdapter(),
      credentialResolver: async () => ({ apiKey: null, agencyId: null, contactId: null }),
    });
    await assert.rejects(() => service.certify("optimise", {}), (error) => {
      assert.match(error.message, /credentials are not configured/i);
      assert.ok(!/sk_live|Bearer|hunter2/.test(error.message));
      return true;
    });
  });
});

describe("RBAC", () => {
  // The route is gated on integrations:manage; assert the role split the phase requires.
  const required = PERMISSIONS.INTEGRATIONS_MANAGE;

  it("ADMIN is allowed", () => {
    assert.ok(ROLE_PERMISSIONS.ADMIN.includes(required));
  });

  it("SUPPORT and CLIENT are denied", () => {
    assert.equal(ROLE_PERMISSIONS.SUPPORT.includes(required), false);
    assert.equal(ROLE_PERMISSIONS.CLIENT.includes(required), false);
  });

  it("the probe is not reachable through a broad read permission", () => {
    // Anyone with plain ops:read or products:read must not reach a credential-using endpoint.
    for (const role of ["SUPPORT", "CLIENT"]) {
      assert.equal(ROLE_PERMISSIONS[role].includes(required), false, role);
    }
    assert.notEqual(required, PERMISSIONS.OPS_READ);
    assert.notEqual(required, PERMISSIONS.PRODUCTS_READ);
  });
});

describe("execution is a POST action, not a GET", () => {
  it("registers POST /:network/run", () => {
    assert.match(routesSource, /router\.post\(\s*"\/ops\/admin\/network-certification\/:network\/run"/);
  });

  it("no longer registers a GET execution route", () => {
    assert.equal(
      /router\.get\(\s*"\/ops\/admin\/network-certification\/:network"/.test(routesSource),
      false,
      "the GET execution route must be gone",
    );
  });

  it("keeps the catalog on GET", () => {
    assert.match(routesSource, /router\.get\(\s*"\/ops\/admin\/network-certification"/);
  });

  it("guards the run route with the limiter, the audit hook and integrations:manage", () => {
    const block = routesSource.slice(routesSource.indexOf("/ops/admin/network-certification/:network/run"));
    const head = block.slice(0, 500);
    assert.match(head, /certificationRateLimiter/);
    assert.match(head, /auditAction\("network\.certification\.run"/);
    assert.match(head, /PERMISSIONS\.INTEGRATIONS_MANAGE/);
  });
});

describe("request schema", () => {
  it("defaults compareRaw to false", () => {
    assert.equal(parseRunBody({}).compareRaw, false);
    assert.equal(parseRunBody({ compareRaw: true }).compareRaw, true);
    assert.equal(parseRunBody({ compareRaw: false }).compareRaw, false);
  });

  it("defaults scope and selects all source objects", () => {
    const parsed = parseRunBody({});
    assert.equal(parsed.region, "sea");
    assert.equal(parsed.accountLabel, "default");
    assert.equal(parsed.sourceObjects, null, "null means the full registry");
  });

  it("rejects any field that is not one of the four", () => {
    for (const body of [
      { endpoint: "https://evil.test/steal" },
      { path: "/campaigns" },
      { url: "https://evil.test" },
      { query: { limit: 1000 } },
      { body: { mutation: "join" } },
      { method: "DELETE" },
      { baseURL: "https://evil.test" },
    ]) {
      assert.throws(() => parseRunBody(body), /Unsupported field/i, JSON.stringify(body));
    }
  });

  it("rejects malformed values", () => {
    assert.throws(() => parseRunBody({ sourceObjects: "campaigns" }), /array of strings/i);
    assert.throws(() => parseRunBody({ sourceObjects: [1] }), /array of strings/i);
    assert.throws(() => parseRunBody({ region: "../../etc/passwd" }), /short alphanumeric/i);
    assert.throws(() => parseRunBody({ accountLabel: "a b" }), /short alphanumeric/i);
    assert.throws(() => parseRunBody({ compareRaw: "yes" }), /must be a boolean/i);
  });
});

describe("cache behaviour", () => {
  function fakeRes() {
    const headers = {};
    return { headers, setHeader: (k, v) => { headers[k] = v; }, json: () => {} };
  }

  it("sends Cache-Control no-store on the catalog", async () => {
    const res = fakeRes();
    await networkCertificationCatalogHandler({}, res, () => {});
    assert.equal(res.headers["Cache-Control"], "no-store");
  });

  it("sends Cache-Control no-store on a run", async () => {
    const res = fakeRes();
    // An unknown network rejects, but the header must already be set by then.
    await networkCertificationRunHandler({ params: { network: "nope" }, body: {} }, res, () => {});
    assert.equal(res.headers["Cache-Control"], "no-store");
  });
});

describe("catalog is inert", () => {
  it("resolves no credential and calls no supplier", async () => {
    let resolverCalls = 0;
    const originalEnv = process.env.NODE_ENV;
    const res = { setHeader: () => {}, json: () => {} };
    // The catalog handler holds no service dependency it could call; assert it completes without
    // touching the resolver used everywhere else.
    await networkCertificationCatalogHandler({}, res, () => {});
    assert.equal(resolverCalls, 0);
    process.env.NODE_ENV = originalEnv;
  });

  it("lists the execution route so a caller does not guess a GET", async () => {
    let body = null;
    await networkCertificationCatalogHandler({}, { setHeader: () => {}, json: (v) => { body = v; } }, () => {});
    assert.equal(body.data.execution.method, "POST");
    assert.match(body.data.execution.path, /\/run$/);
  });
});

describe("rate limit configuration", () => {
  it("is keyed on network, region and account label", async () => {
    const security = (await import("node:fs")).readFileSync("src/platform/security/index.js", "utf8");
    const block = security.slice(security.indexOf("certificationRateLimiter"));
    assert.match(block, /keyGenerator/);
    assert.match(block, /params\?\.network/);
    assert.match(block, /body\?\.region/);
    assert.match(block, /body\?\.accountLabel/);
  });

  it("defaults to one run per five minutes and returns controlled text", async () => {
    const security = (await import("node:fs")).readFileSync("src/platform/security/index.js", "utf8");
    const block = security.slice(security.indexOf("certificationRateLimiter"));
    assert.match(block, /300_000/);
    assert.match(block, /CERTIFICATION_RATE_LIMIT_MAX \|\| 1/);
    const message = block.slice(block.indexOf("message:"), block.indexOf("message:") + 220);
    assert.match(message, /Try again shortly/);
    // The 429 body must not carry supplier or internal detail.
    assert.ok(!/prisma|sql|stack|apikey|optimise/i.test(message), message);
  });
});

describe("compareRaw gating", () => {
  it("makes no RawPayload query when compareRaw is false", async () => {
    const { service, db } = makeServiceForRaw();
    await service.certify("optimise", { sourceObjects: ["campaigns"], compareRaw: false });
    assert.equal(db.calls.some((c) => c.includes("rawPayload")), false, db.calls.join(", "));
  });

  it("queries RawPayload only when compareRaw is true", async () => {
    const { service, db } = makeServiceForRaw();
    const out = await service.certify("optimise", { sourceObjects: ["campaigns"], compareRaw: true });
    assert.ok(db.calls.some((c) => c.includes("rawPayload.findMany")), db.calls.join(", "));
    assert.ok(Array.isArray(out.results[0].rawComparison));
    for (const row of out.results[0].rawComparison) {
      assert.deepEqual(Object.keys(row).sort(), ["path", "state"]);
    }
  });

  it("defaults to no RawPayload query when the option is omitted", async () => {
    const { service, db } = makeServiceForRaw();
    await service.certify("optimise", { sourceObjects: ["campaigns"] });
    assert.equal(db.calls.some((c) => c.includes("rawPayload")), false, db.calls.join(", "));
  });
});

describe("bounded sampling — the 300s hang", () => {
  /**
   * Reproduces the live failure at the layer that caused it.
   *
   * fetchOffsetPaginated stops when `pageRows.length < limit`. With limit=1 a full page is exactly
   * 1 row, so `1 < 1` is false and it walks the whole collection one row per request, each behind
   * a 12.5s throttle. The sampler must not go anywhere near that code.
   */
  function recordingHttpClient({ rowsPerPage = 1, delayMs = 0, fail = null } = {}) {
    const requests = [];
    return {
      requests,
      get: async (path, config = {}) => {
        requests.push({ path, params: config.params, timeout: config.timeout });
        if (fail) throw fail;
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return { data: Array.from({ length: rowsPerPage }, (_, i) => ({ id: i + 1, name: "Ubuy SG" })) };
      },
      post: async () => {
        throw new Error("certification must never POST to a sampling endpoint");
      },
    };
  }

  /** Admits immediately. The interval itself is not under test here; the request shape is. */
  const openLimiter = { acquireSlot: async () => {}, resetAfterRateLimit: () => {} };

  /** Never admits, so a throttle budget can be shown to expire deterministically. */
  const closedLimiter = { acquireSlot: () => new Promise(() => {}), resetAfterRateLimit: () => {} };

  function probeAdapter(httpClient, certificationRateLimiter = openLimiter) {
    return createOptimiseAdapter({
      apiKey: "k",
      agencyId: "AG1",
      contactId: "C1",
      httpClient,
      certificationRateLimiter,
    });
  }

  it("makes exactly one supplier request for campaigns", async () => {
    const httpClient = recordingHttpClient({ rowsPerPage: 1 });
    const rows = await probeAdapter(httpClient).fetchCertificationSample("campaigns", {});
    assert.equal(httpClient.requests.length, 1, "one request only");
    assert.equal(rows.length, 1);
  });

  it("uses offset 0 and limit 1", async () => {
    const httpClient = recordingHttpClient();
    await probeAdapter(httpClient).fetchCertificationSample("campaigns", {});
    assert.equal(httpClient.requests[0].params.offset, 0);
    assert.equal(httpClient.requests[0].params.limit, 1);
  });

  it("does not loop even when the page is full — the exact 300s condition", async () => {
    // rowsPerPage === limit is what made the sync paginator continue forever.
    const httpClient = recordingHttpClient({ rowsPerPage: 1 });
    await probeAdapter(httpClient).fetchCertificationSample("campaigns", {});
    assert.equal(httpClient.requests.length, 1, "a full page must not trigger a second request");
  });

  it("returns at most one row however many the supplier sends", async () => {
    const httpClient = recordingHttpClient({ rowsPerPage: 50 });
    const rows = await probeAdapter(httpClient).fetchCertificationSample("campaigns", {});
    assert.equal(rows.length, 1);
    assert.equal(httpClient.requests.length, 1);
  });

  it("sends a per-request timeout", async () => {
    const httpClient = recordingHttpClient();
    await probeAdapter(httpClient).fetchCertificationSample("campaigns", { timeoutMs: 10000 });
    assert.equal(httpClient.requests[0].timeout, 10000);
  });

  it("gives up on a slow supplier well inside the runtime limit", async () => {
    const httpClient = recordingHttpClient({ delayMs: 5000 });
    const started = Date.now();
    await assert.rejects(
      () => probeAdapter(httpClient).fetchCertificationSample("campaigns", { timeoutMs: 300 }),
      (error) => {
        assert.equal(error instanceof CertificationTimeoutError, true);
        assert.equal(statusCategory(error), "SUPPLIER_TIMEOUT");
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `took ${elapsed}ms — must not approach a runtime timeout`);
  });

  it("does not retry", async () => {
    const error = new Error("boom");
    error.response = { status: 503 };
    const httpClient = recordingHttpClient({ fail: error });
    await assert.rejects(() => probeAdapter(httpClient).fetchCertificationSample("campaigns", {}));
    assert.equal(httpClient.requests.length, 1, "a 503 must not be retried by the probe");
  });

  it("reports a throttled probe instead of queueing for minutes", async () => {
    const httpClient = recordingHttpClient();
    // The throttle never admits, so the budget expires and the request must not be sent at all.
    await assert.rejects(
      () =>
        probeAdapter(httpClient, closedLimiter).fetchCertificationSample("campaigns", {
          throttleBudgetMs: 20,
        }),
      (error) => {
        assert.equal(error instanceof CertificationThrottledError, true);
        assert.equal(statusCategory(error), "SUPPLIER_RATE_LIMITED");
        return true;
      },
    );
    assert.equal(httpClient.requests.length, 0, "no request is sent when the throttle cannot admit it");
  });

  it("never routes certification through the paginator or the retry wrapper", () => {
    const start = adapterSource.indexOf("async fetchCertificationSample");
    const end = adapterSource.indexOf("fetchCampaigns(params = {})", start);
    const body = adapterSource.slice(start, end);
    assert.ok(!body.includes("fetchOffsetPaginated"), "must not use the paginator");
    assert.ok(!body.includes("requestWithOptimiseLimits"), "must not use the retry wrapper");
    assert.ok(!body.includes("fetchAll"), "must not use a fetch-all helper");
  });

  it("the certification service never calls a sync fetcher", async () => {
    const serviceSource = (await import("node:fs")).readFileSync(
      "src/modules/ops/networkCertification.service.js",
      "utf8",
    );
    for (const sync of ["fetchVoucherCodes(", "fetchPayments(", "fetchInvoices(", "fetchProductFeeds(", "fetchAll("]) {
      assert.ok(!serviceSource.includes(sync), `service must not call ${sync}`);
    }
    assert.ok(serviceSource.includes("fetchCertificationSample"));

    // fetchCampaigns is the one exception, and only because Trackier's probe reuses production's
    // fetcher rather than adding a parallel client. The rule it must still obey is the one the
    // blanket ban stood for: certification never runs an UNBOUNDED production fetcher. Every call
    // the service makes therefore carries all three bounds.
    const campaignCalls = serviceSource.split("adapter.fetchCampaigns(").slice(1);
    assert.equal(campaignCalls.length, 3, "the Trackier campaigns chain, its detail discovery, and the Boostiny campaigns chain");
    for (const raw of campaignCalls) {
      const call = raw.slice(0, raw.indexOf("),\n"));
      for (const bound of ["singlePage: true", "retries: 1", "timeoutMs"]) {
        assert.ok(call.includes(bound), bound);
      }
      assert.ok(
        call.includes("TRACKIER_CERTIFICATION_CAMPAIGN_PARAMS") || call.includes("BOOSTINY_CERTIFICATION_CAMPAIGN_PARAMS"),
        "and the supplier bounds",
      );
    }
    assert.equal(campaignCalls.filter((c) => c.includes("BOOSTINY_CERTIFICATION_CAMPAIGN_PARAMS")).length, 1);
    // The detail fetcher is campaign-scoped, so it is bounded the same way.
    const detailCalls = serviceSource.split("adapter.fetchCampaignDetail(").slice(1);
    assert.equal(detailCalls.length, 1, "one detail call site");
    const detailCall = detailCalls[0].slice(0, detailCalls[0].indexOf("});"));
    for (const bound of ["retries: 1", "timeoutMs"]) {
      assert.ok(detailCall.includes(bound), bound);
    }
    // fetchConversions is the dated one: besides page and retry it must also be pinned to a
    // single date chunk, or the production chunker could fan one window out into many requests.
    const conversionCalls = serviceSource.split("adapter.fetchConversions(").slice(1);
    assert.equal(conversionCalls.length, 1, "one conversions call site: the Trackier chain");
    const conversionCall = conversionCalls[0].slice(0, conversionCalls[0].indexOf("),\n"));
    for (const bound of ["singleChunk: true", "singlePage: true", "retries: 1", "timeoutMs"]) {
      assert.ok(conversionCall.includes(bound), bound);
    }
    assert.ok(conversionCall.includes("TRACKIER_CERTIFICATION_CONVERSION_PARAMS"), "and the supplier bounds");
    const chainStart = serviceSource.indexOf("async certifyTrackierConversions");
    assert.ok(chainStart >= 0 && serviceSource.indexOf("adapter.fetchConversions(") > chainStart, "inside the Trackier chain");
    // fetchReportsKpi takes no parameters, so retry and timeout are its only bounds.
    const kpiCalls = serviceSource.split("adapter.fetchReportsKpi(").slice(1);
    assert.equal(kpiCalls.length, 2, "the reports-kpi chain, and the reports chain's KPI discovery");
    for (const raw of kpiCalls) {
      const kpiCall = raw.slice(0, raw.indexOf("});"));
      for (const bound of ["retries: 1", "timeoutMs", "preserveShape: true"]) {
        assert.ok(kpiCall.includes(bound), bound);
      }
    }
    // fetchReports is dated and paged like fetchConversions, and bounded the same four ways.
    const reportCalls = serviceSource.split("adapter.fetchReports(").slice(1);
    assert.equal(reportCalls.length, 1, "one reports call site: the Trackier chain");
    const reportCall = reportCalls[0].slice(0, reportCalls[0].indexOf("),\n"));
    for (const bound of ["singleChunk: true", "singlePage: true", "retries: 1", "timeoutMs"]) {
      assert.ok(reportCall.includes(bound), bound);
    }
    assert.ok(reportCall.includes("TRACKIER_CERTIFICATION_REPORT_PARAMS"), "and the supplier bounds");
  });

  it("covers every sampleable Optimise source object", () => {
    assert.deepEqual(listCertificationSamples().sort(), [
      "campaign_detail",
      "campaigns",
      "commission_groups",
      "conversions",
      "invoices",
      "payment_overview",
      "products",
      "voucher_codes",
    ]);
  });

  it("refuses a source object that is not in the sample table", async () => {
    const adapter = probeAdapter(recordingHttpClient());
    await assert.rejects(() => adapter.fetchCertificationSample("anything_else", {}), /No certification sample/i);
  });

  it("refuses a campaign-scoped sample without an id", async () => {
    const adapter = probeAdapter(recordingHttpClient());
    await assert.rejects(
      () => adapter.fetchCertificationSample("commission_groups", {}),
      /requires commissionGroupCampaignId/i,
    );
  });
});

describe("normal sync behaviour is unchanged", () => {
  it("the paginator still loops until a short page", () => {
    const start = adapterSource.indexOf("async function fetchOffsetPaginated");
    const body = adapterSource.slice(start, adapterSource.indexOf("}", adapterSource.indexOf("return rows;", start)));
    assert.match(body, /if \(pageRows\.length < limit\)/, "termination test intact");
    assert.match(body, /offset \+= limit/, "offset advance intact");
    assert.match(body, /requestWithOptimiseLimits/, "sync still uses the retry wrapper");
  });

  it("the sync retry policy is untouched", () => {
    assert.match(adapterSource, /requestWithRetry\(fn, \{ retries: 6, delayMs: 2000 \}\)/);
  });

  it("the shared throttle interval is untouched", () => {
    assert.match(adapterSource, /OPTIMISE_MIN_INTERVAL_MS \|\| 12500/);
  });

  it("the sync fetchers still call the paginator", () => {
    const start = adapterSource.indexOf("fetchCampaigns(params = {})");
    const body = adapterSource.slice(start, start + 300);
    assert.match(body, /fetchOffsetPaginated/);
  });

  it("the sync throttle is still the one the sync path waits on", () => {
    const start = adapterSource.indexOf("async function requestWithOptimiseLimits");
    const body = adapterSource.slice(start, adapterSource.indexOf("\n}", start));
    assert.match(body, /optimiseRateLimiter\.acquireSlot\(\)/, "sync still queues on the 12.5s limiter");
  });

  it("certification does not queue on the sync throttle", () => {
    const start = adapterSource.indexOf("async fetchCertificationSample");
    const body = adapterSource.slice(start, adapterSource.indexOf("fetchCampaigns(params = {})", start));
    assert.ok(
      !body.includes("optimiseRateLimiter"),
      "a probe must not wait on the interval built for a fetch-all loop",
    );
    assert.match(adapterSource, /CERTIFICATION_MIN_INTERVAL_MS \|\| 1000/, "probes are still paced, separately");
  });
});

describe("run budget — the route always returns", () => {
  function slowAdapter(perCallMs) {
    return {
      fetchCertificationSample: async () => {
        await new Promise((r) => setTimeout(r, perCallMs));
        return [{ id: 1 }];
      },
    };
  }

  function makeDbForBudget() {
    return { rawPayload: { findMany: async () => [] } };
  }

  it("reports unattempted source objects rather than overrunning", async () => {
    const original = process.env.CERTIFICATION_RUN_BUDGET_MS;
    process.env.CERTIFICATION_RUN_BUDGET_MS = "40";
    const { NetworkCertificationService: Scoped } = await import(
      `../src/modules/ops/networkCertification.service.js?budget=${Date.now()}`
    );
    const service = new Scoped({
      prisma: makeDbForBudget(),
      adapterFactory: () => slowAdapter(30),
      credentialResolver: async () => ({ apiKey: "k", agencyId: "AG1", contactId: "C1" }),
    });
    const out = await service.certify("optimise", {
      sourceObjects: ["campaigns", "voucher_codes", "conversions", "invoices"],
      compareRaw: false,
    });
    const exhausted = out.results.filter((r) => r.statusCategory === "RUN_BUDGET_EXHAUSTED");
    assert.ok(exhausted.length > 0, "later source objects must be reported, not attempted");
    assert.equal(out.results.length, 4, "every requested source object is still accounted for");
    for (const row of exhausted) {
      assert.equal(row.ok, false);
      assert.equal(row.sampleCount, 0);
      assert.deepEqual(row.fieldPaths, []);
    }
    process.env.CERTIFICATION_RUN_BUDGET_MS = original;
  });

  it("the configured budgets keep a full sweep well inside the 300s runtime limit", async () => {
    const source = (await import("node:fs")).readFileSync(
      "src/modules/ops/networkCertification.service.js",
      "utf8",
    );
    const runBudget = Number(/CERTIFICATION_RUN_BUDGET_MS \|\| (\d+)/.exec(source)?.[1]);
    const sourceBudget = Number(/CERTIFICATION_SOURCE_BUDGET_MS \|\| (\d+)/.exec(source)?.[1]);
    assert.ok(Number.isFinite(runBudget) && Number.isFinite(sourceBudget));
    // The last source object can start just under the run budget and then take its own budget.
    assert.ok(
      runBudget + sourceBudget < 300000,
      `worst case ${runBudget + sourceBudget}ms must stay under the 300s runtime limit`,
    );
  });
});

/**
 * Products is the only two-step chain in certification. These tests hold it to the same bound as
 * every single-step probe: a fixed number of requests, no pagination, no retry, no caller
 * influence over what is fetched, and no supplier value in the output.
 */
describe("product certification — bounded two-step chain", () => {
  const FEED_ROW = Object.freeze({
    feedId: 8812,
    feedName: "Ubuy SG Catalog",
    feedUrl: "https://product-feeds.optimisemedia.com/feeds/8812?AID=999&Format=xml",
    itemCount: 412553,
    lastImportedDate: "2026-09-11T02:00:00Z",
  });

  const CSV_BODY =
    "ProductSKU,ProductName,ProductPrice,StockAvailability,Brand\r\n" +
    '"SKU-1","Wireless Kettle",49.99,"in stock","Ubuy"\r\n' +
    '"SKU-2","Toaster",29.50,"in stock","Ubuy"\r\n';

  /**
   * Counts every outbound call of either kind, so the chain's total is checkable, and returns what
   * the real adapter returns — the item sample goes through the real parser, not a hand-built shape.
   */
  function chainAdapter({ itemBody = CSV_BODY, itemError = null, feedRow = FEED_ROW } = {}) {
    const calls = [];
    return {
      calls,
      fetchCertificationSample: async (sourceObject) => {
        calls.push({ kind: "api", sourceObject });
        return feedRow ? [feedRow] : [];
      },
      fetchCertificationFeedItemSample: async (row) => {
        calls.push({ kind: "feed", url: row?.feedUrl ?? null });
        if (itemError) throw itemError;
        const parsed = parseFirstFeedRecord(itemBody, { truncated: false });
        return { rows: [parsed.record], feedFormat: parsed.feedFormat, truncated: false };
      },
    };
  }

  function serviceFor(adapter) {
    return new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => adapter,
      credentialResolver: async () => ({ apiKey: SECRET_VALUES[0], agencyId: "AG1", contactId: "C1" }),
    });
  }

  it("1 — makes at most two supplier requests", async () => {
    const adapter = chainAdapter();
    await serviceFor(adapter).certify("optimise", { sourceObjects: ["products"], compareRaw: false });
    assert.equal(adapter.calls.length, 2, JSON.stringify(adapter.calls));
    assert.deepEqual(adapter.calls.map((c) => c.kind), ["api", "feed"]);
  });

  it("2 — the first request samples exactly one feed", async () => {
    const adapter = chainAdapter();
    const out = await serviceFor(adapter).certify("optimise", { sourceObjects: ["products"], compareRaw: false });
    const feeds = out.results.find((r) => r.sourceObject === "product_feeds");
    assert.equal(feeds.sampleCount, 1);
    assert.equal(adapter.calls.filter((c) => c.kind === "api").length, 1);
  });

  it("3 — a caller cannot inject a feed URL, id or path", async () => {
    const hostile = {
      sourceObjects: ["products"],
      feedUrl: "https://attacker.test/all.csv",
      feedId: 1,
      path: "/etc/passwd",
    };
    assert.throws(() => parseRunBody(hostile), /Unsupported field\(s\)/);
    // And the accepted body has no field that could name one.
    assert.deepEqual(Object.keys(parseRunBody({ sourceObjects: ["products"] })).sort(), [
      "accountLabel",
      "compareRaw",
      "region",
      "sourceObjects",
      "windowPreset",
    ]);
  });

  it("4 — the second request derives only from the sampled feed", async () => {
    const adapter = chainAdapter();
    await serviceFor(adapter).certify("optimise", { sourceObjects: ["products"], compareRaw: false });
    const feedCall = adapter.calls.find((c) => c.kind === "feed");
    assert.equal(feedCall.url, FEED_ROW.feedUrl, "the URL came from the sampled feed row");
  });

  it("4b — a feed URL off the allowed host is refused, not fetched", () => {
    assert.throws(
      () => buildBoundedFeedUrl({ feedUrl: "https://attacker.test/all.csv" }, { aid: "C1" }),
      (error) => {
        assert.equal(error instanceof FeedItemSampleNotBoundedError, true);
        assert.equal(error.reason, "DISALLOWED_HOST");
        return true;
      },
    );
    assert.deepEqual(ALLOWED_FEED_HOSTS, ["product-feeds.optimisemedia.com"]);
  });

  it("4c — http and redirect-shaped hosts are refused too", () => {
    for (const url of [
      "http://product-feeds.optimisemedia.com/feeds/1",
      "https://product-feeds.optimisemedia.com.attacker.test/feeds/1",
      "https://attacker.test/?x=product-feeds.optimisemedia.com",
    ]) {
      assert.throws(() => buildBoundedFeedUrl({ feedUrl: url }, { aid: "C1" }), /bounded single product-item/i);
    }
  });

  it("5 — no fetch-all or full-feed path is reachable from the chain", () => {
    const adapterStart = adapterSource.indexOf("async fetchCertificationFeedItemSample");
    const body = adapterSource.slice(adapterStart, adapterSource.indexOf("\n    },", adapterStart));
    assert.ok(!body.includes("fetchProductFeedItems"), "must not call the sync feed downloader");
    assert.ok(!body.includes("fetchOffsetPaginated"), "must not paginate");
    assert.ok(!body.includes("fetchAll"), "must not use a fetch-all helper");
    assert.match(body, /maxBytes/, "the request is byte-bounded");
    assert.match(body, /Range/, "a byte range is requested");
  });

  it("6 — the chain does not paginate: one URL, no candidate loop", () => {
    const adapterStart = adapterSource.indexOf("async fetchCertificationFeedItemSample");
    const body = adapterSource.slice(adapterStart, adapterSource.indexOf("\n    },", adapterStart));
    assert.ok(!/for \(/.test(body), "no loop over candidate URLs or pages");
    assert.ok(!/offset|cursor|page/i.test(body), "no pagination parameter");
  });

  it("7 — the chain does not retry", () => {
    const adapterStart = adapterSource.indexOf("async fetchCertificationFeedItemSample");
    const body = adapterSource.slice(adapterStart, adapterSource.indexOf("\n    },", adapterStart));
    assert.ok(!body.includes("requestWithRetry"), "no retry wrapper");
    assert.ok(!body.includes("requestWithOptimiseLimits"), "no retrying request path");
  });

  it("8 — no raw supplier value appears in the response", async () => {
    const adapter = chainAdapter();
    const out = await serviceFor(adapter).certify("optimise", { sourceObjects: ["products"], compareRaw: false });
    const text = serialise(out);
    for (const value of [
      "Wireless Kettle",
      "SKU-1",
      "49.99",
      "Ubuy SG Catalog",
      "412553",
      "in stock",
      "AID=999",
      SECRET_VALUES[0],
    ]) {
      assert.ok(!text.includes(value), `value leaked: ${value}`);
    }
  });

  it("8b — but the supplier's own FIELD NAMES are reported, which is the point", async () => {
    const adapter = chainAdapter();
    const out = await serviceFor(adapter).certify("optimise", { sourceObjects: ["products"], compareRaw: false });
    const items = out.results.find((r) => r.sourceObject === "product_items");
    const paths = items.fieldPaths.map((f) => f.path).sort();
    assert.deepEqual(paths, ["Brand", "ProductName", "ProductPrice", "ProductSKU", "StockAvailability"]);
  });

  it("9 — the item request is still bounded by a timeout", () => {
    const adapterStart = adapterSource.indexOf("async fetchCertificationFeedItemSample");
    const body = adapterSource.slice(adapterStart, adapterSource.indexOf("\n    },", adapterStart));
    assert.match(body, /timeoutMs/, "a timeout is passed");
    assert.match(body, /CertificationTimeoutError/, "and enforced by the probe's own deadline");
  });

  it("10 — production product sync is unchanged", async () => {
    const start = adapterSource.indexOf("async fetchProductFeedItems");
    const body = adapterSource.slice(start, adapterSource.indexOf("async fetchAll", start));
    assert.match(body, /safeCandidates\.slice\(0, 3\)/, "sync still tries up to three candidate URLs");
    assert.match(body, /parseOptimiseFeedCsv\(text, maxRows\)/, "sync still parses up to maxRows");
    assert.match(body, /maxBytes = Math\.min\(8_000_000/, "sync keeps its own byte ceiling");
    // The sync job still calls the sync downloader, not the sampler.
    const jobSource = (await import("node:fs")).readFileSync("src/jobs/optimiseProductFeedSync.js", "utf8");
    assert.match(jobSource, /adapter\.fetchProductFeedItems\(/);
    assert.ok(!jobSource.includes("fetchCertificationFeedItemSample"));
  });

  it("reports the two vocabularies as separate rows, never merged", async () => {
    const adapter = chainAdapter();
    const out = await serviceFor(adapter).certify("optimise", { sourceObjects: ["products"], compareRaw: false });
    const names = out.results.map((r) => r.sourceObject);
    assert.deepEqual(names, ["product_feeds", "product_items"]);
    const feedPaths = out.results[0].fieldPaths.map((f) => f.path);
    const itemPaths = out.results[1].fieldPaths.map((f) => f.path);
    assert.ok(feedPaths.includes("feedId"), "feed row carries feed metadata");
    assert.equal(itemPaths.includes("feedId"), false, "item row must not carry feed metadata");
    assert.equal(feedPaths.includes("ProductSKU"), false, "feed row must not carry item fields");
  });

  it("reports PRODUCT_ITEM_SAMPLE_NOT_BOUNDED rather than widening the window", async () => {
    const error = new FeedItemSampleNotBoundedError("NO_COMPLETE_RECORD_IN_WINDOW");
    const adapter = chainAdapter({ itemError: error });
    const out = await serviceFor(adapter).certify("optimise", { sourceObjects: ["products"], compareRaw: false });
    const items = out.results.find((r) => r.sourceObject === "product_items");
    assert.equal(items.statusCategory, "PRODUCT_ITEM_SAMPLE_NOT_BOUNDED");
    assert.equal(items.reason, "NO_COMPLETE_RECORD_IN_WINDOW");
    assert.equal(items.sampleCount, 0);
    assert.deepEqual(items.fieldPaths, []);
    assert.match(items.note, /does not widen the window/i);
  });

  it("skips the item step when no feed was sampled", async () => {
    const adapter = chainAdapter({ feedRow: null });
    const out = await serviceFor(adapter).certify("optimise", { sourceObjects: ["products"], compareRaw: false });
    const items = out.results.find((r) => r.sourceObject === "product_items");
    assert.equal(items.statusCategory, "SKIPPED_NO_FEED_SAMPLE");
    assert.equal(adapter.calls.filter((c) => c.kind === "feed").length, 0, "no second request");
  });
});

describe("bounded feed parsing — shape preserving and truncation safe", () => {
  it("drops a partial trailing CSV line rather than under-reporting fields", () => {
    const body = "sku,name,price\r\nA1,Kettle,49.99\r\nA2,Toas";
    const whole = parseFirstFeedRecord(body, { truncated: true });
    assert.deepEqual(Object.keys(whole.record), ["sku", "name", "price"]);
    assert.equal(whole.feedFormat, "CSV");
  });

  it("reports the feed's own headers, not our canonical product names", () => {
    const body = "merchant_sku,titel,prijs\r\nA1,Waterkoker,49.99\r\n";
    const { record } = parseFirstFeedRecord(body, { truncated: false });
    assert.deepEqual(Object.keys(record), ["merchant_sku", "titel", "prijs"]);
  });

  it("reports the feed's own XML tags, including namespace prefixes", () => {
    const body =
      '<?xml version="1.0"?><rss><channel><item><g:id>A1</g:id><title>Kettle</title>' +
      "<g:price>49.99 SGD</g:price></item><item><g:id>A2</g:id></item></channel></rss>";
    const { record, feedFormat } = parseFirstFeedRecord(body, { truncated: false });
    assert.equal(feedFormat, "XML");
    assert.deepEqual(Object.keys(record).sort(), ["g:id", "g:price", "title"]);
  });

  it("ignores an XML record cut off by the byte window", () => {
    const body = '<?xml version="1.0"?><rss><channel><item><g:id>A1</g:id><title>Ket';
    assert.throws(() => parseFirstFeedRecord(body, { truncated: true }), /bounded single product-item/i);
  });

  it("refuses a header-only window instead of inventing a record", () => {
    assert.throws(
      () => parseFirstFeedRecord("sku,name,price\r\n", { truncated: true }),
      (error) => {
        assert.equal(error.reason, "NO_COMPLETE_RECORD_IN_WINDOW");
        return true;
      },
    );
  });

  it("never copies a parsed value into the reported dictionary", () => {
    const { record } = parseFirstFeedRecord("sku,name\r\nA1,Secret Kettle\r\n", { truncated: false });
    const text = serialise(summarisePayloads([record]));
    assert.ok(!text.includes("Secret Kettle"));
    assert.ok(!text.includes("A1"));
    assert.ok(text.includes("name"), "the field name is still reported");
  });
});

/**
 * The conversions probe was rejected live because certification invented its own date vocabulary.
 * Optimise uses three across one API, and only the sync fetchers are evidence for which is which.
 * These tests pin each sample to the parameters its endpoint actually takes.
 */
describe("dated samples use each endpoint's own proven parameters", () => {
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  function recorder() {
    const requests = [];
    return {
      requests,
      get: async (path, config = {}) => {
        requests.push({ path, params: config.params });
        return { data: [{ id: 1 }] };
      },
      post: async () => {
        throw new Error("certification must never POST to a sampling endpoint");
      },
    };
  }

  const openLimiter = { acquireSlot: async () => {}, resetAfterRateLimit: () => {} };

  function probe(httpClient) {
    return createOptimiseAdapter({
      apiKey: "k",
      agencyId: "AG1",
      contactId: "C1",
      httpClient,
      certificationRateLimiter: openLimiter,
    });
  }

  const WINDOW = { window: { from: "2026-09-05", to: "2026-09-12" } };

  async function paramsFor(sourceObject) {
    const httpClient = recorder();
    await probe(httpClient).fetchCertificationSample(sourceObject, WINDOW);
    assert.equal(httpClient.requests.length, 1, "exactly one supplier request");
    return httpClient.requests[0];
  }

  it("1 — conversions sends exactly the keys GET /conversions takes", async () => {
    const { path, params } = await paramsFor("conversions");
    assert.equal(path, "/conversions");
    assert.deepEqual(Object.keys(params).sort(), [
      "agencyId",
      "contactId",
      "conversionType",
      "dateField",
      "fromDate",
      "limit",
      "offset",
      "targetCurrencyCode",
      "toDate",
    ]);
  });

  it("2 — conversions sends no date alias the endpoint does not take", async () => {
    const { params } = await paramsFor("conversions");
    for (const alias of ["startDate", "endDate", "dateFrom", "dateTo", "date_from", "date_to"]) {
      assert.equal(alias in params, false, `stale alias sent: ${alias}`);
    }
  });

  it("3 — conversions dates are ISO YYYY-MM-DD, not the reporting endpoint's DD/MM/YYYY", async () => {
    const { params } = await paramsFor("conversions");
    assert.match(params.fromDate, ISO_DATE);
    assert.match(params.toDate, ISO_DATE);
    assert.equal(params.fromDate, "2026-09-05");
    assert.equal(params.toDate, "2026-09-12");
    // The reporting endpoint's format must not leak into this one.
    assert.ok(!String(params.fromDate).includes("/"), "must not be DD/MM/YYYY");
  });

  it("3b — conversions carries the same non-date defaults as production sync", async () => {
    const { params } = await paramsFor("conversions");
    assert.equal(params.dateField, "conversion");
    assert.equal(params.targetCurrencyCode, "USD");
    assert.equal(params.conversionType, "conversions");
  });

  it("4 — offset is 0", async () => {
    for (const source of ["conversions", "payment_overview", "invoices", "campaigns"]) {
      assert.equal((await paramsFor(source)).params.offset, 0, source);
    }
  });

  it("5 — limit is 1", async () => {
    for (const source of ["conversions", "payment_overview", "invoices", "campaigns"]) {
      assert.equal((await paramsFor(source)).params.limit, 1, source);
    }
  });

  it("6 — exactly one supplier request per dated sample", async () => {
    for (const source of ["conversions", "payment_overview", "invoices"]) {
      const httpClient = recorder();
      await probe(httpClient).fetchCertificationSample(source, WINDOW);
      assert.equal(httpClient.requests.length, 1, source);
    }
  });

  it("7 — a rejected dated sample is not retried", async () => {
    const error = new Error("rejected");
    error.response = { status: 400 };
    let calls = 0;
    const httpClient = {
      get: async () => {
        calls += 1;
        throw error;
      },
    };
    await assert.rejects(() => probe(httpClient).fetchCertificationSample("conversions", WINDOW));
    assert.equal(calls, 1, "a 400 must not be retried");
  });

  it("8 — a dated sample does not paginate", async () => {
    // A full page is exactly one row at limit 1; the sync paginator would loop here.
    const httpClient = recorder();
    await probe(httpClient).fetchCertificationSample("conversions", WINDOW);
    assert.equal(httpClient.requests.length, 1, "a full page must not trigger a second request");
  });

  it("payments and invoices use startDate/endDate, which is their own contract", async () => {
    for (const source of ["payment_overview", "invoices"]) {
      const { params } = await paramsFor(source);
      assert.equal(params.startDate, "2026-09-05", source);
      assert.equal(params.endDate, "2026-09-12", source);
      assert.equal("fromDate" in params, false, `${source} must not send fromDate`);
      assert.equal("dateFrom" in params, false, `${source} must not send dateFrom`);
    }
  });

  it("the window itself is endpoint-neutral, so no alias can be spread by accident", async () => {
    const serviceSource = (await import("node:fs")).readFileSync(
      "src/modules/ops/networkCertification.service.js",
      "utf8",
    );
    const start = serviceSource.indexOf("function defaultDateWindow");
    const body = serviceSource.slice(start, serviceSource.indexOf("\n}", start));
    assert.deepEqual(Object.keys({ from: 1, to: 1 }).sort(), ["from", "to"]);
    for (const alias of ["startDate", "endDate", "dateFrom", "dateTo", "fromDate", "toDate"]) {
      assert.ok(!body.includes(alias), `the shared window must not name ${alias}`);
    }
  });

  it("9 — production conversion sync is unchanged", () => {
    const start = adapterSource.indexOf("fetchConversions(params = {})");
    const body = adapterSource.slice(start, adapterSource.indexOf("fetchPayments(params = {})", start));
    assert.match(body, /if \(!fromDate \|\| !toDate\)/, "sync still requires fromDate/toDate");
    assert.match(body, /dateField = "conversion"/, "sync default dateField intact");
    assert.match(body, /targetCurrencyCode = "USD"/, "sync default currency intact");
    assert.match(body, /conversionType = "conversions"/, "sync default type intact");
    assert.match(body, /fetchOffsetPaginated\(httpClient, "\/conversions"/, "sync still paginates");
    // And the reporting endpoint keeps its different date format.
    assert.match(adapterSource, /return `\$\{day\}\/\$\{month\}\/\$\{year\}`/, "reporting stays DD/MM/YYYY");
  });

  it("10 — a supplier 4xx still reduces to REQUEST_REJECTED with no body", async () => {
    const error = new Error("Optimise said: invalid parameter 'dateFrom' for apikey sk_live_LEAKME");
    error.response = { status: 400, data: { errors: [{ message: "invalid parameter dateFrom" }] } };
    const adapter = {
      fetchCertificationSample: async () => {
        throw error;
      },
    };
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => adapter,
      credentialResolver: async () => ({ apiKey: SECRET_VALUES[0], agencyId: "AG1", contactId: "C1" }),
    });
    const out = await service.certify("optimise", { sourceObjects: ["conversions"], compareRaw: false });
    assert.equal(out.results[0].statusCategory, "REQUEST_REJECTED");
    assert.equal(out.results[0].ok, false);
    const text = serialise(out);
    for (const leak of ["sk_live_LEAKME", "invalid parameter", "Optimise said", "dateFrom"]) {
      assert.ok(!text.includes(leak), `leaked: ${leak}`);
    }
  });
});

/**
 * Widening the lookback must not become a way to shape the supplier request.
 *
 * The conversions query contract is pinned; the only thing a caller may vary is WHICH named
 * lookback the service computes dates for. A preset token cannot express a date, a day count, or a
 * parameter name, so there is nothing to smuggle.
 */
describe("certification window presets", () => {
  const DAY_MS = 86400000;

  /** Captures the params the adapter is asked to send, and the days the service computed. */
  function capturingService() {
    const seen = [];
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => ({
        fetchCertificationSample: async (sourceObject, ctx) => {
          seen.push({ sourceObject, window: ctx.window });
          return [{ conversionId: 1 }];
        },
      }),
      credentialResolver: async () => ({ apiKey: SECRET_VALUES[0], agencyId: "AG1", contactId: "C1" }),
    });
    return { service, seen };
  }

  function spanDays(window) {
    return Math.round((Date.parse(window.to) - Date.parse(window.from)) / DAY_MS);
  }

  it("1 — the default is 7d when no preset is given", async () => {
    assert.equal(DEFAULT_WINDOW_PRESET, "7d");
    assert.equal(parseRunBody({}).windowPreset, "7d");
    const { service, seen } = capturingService();
    const out = await service.certify("optimise", { sourceObjects: ["conversions"] });
    assert.equal(spanDays(seen[0].window), 7);
    assert.equal(out.windowPreset, "7d");
  });

  it("2 — 30d is accepted and widens the window to 30 days", async () => {
    assert.equal(parseRunBody({ windowPreset: "30d" }).windowPreset, "30d");
    const { service, seen } = capturingService();
    const out = await service.certify("optimise", { sourceObjects: ["conversions"], windowPreset: "30d" });
    assert.equal(spanDays(seen[0].window), 30);
    assert.equal(out.windowPreset, "30d");
  });

  it("3 — 90d is accepted and is the maximum", async () => {
    assert.equal(parseRunBody({ windowPreset: "90d" }).windowPreset, "90d");
    const { service, seen } = capturingService();
    const out = await service.certify("optimise", { sourceObjects: ["conversions"], windowPreset: "90d" });
    assert.equal(spanDays(seen[0].window), 90);
    assert.equal(out.windowPreset, "90d");
    assert.equal(Math.max(...Object.values(WINDOW_PRESETS)), 90, "90 days is the ceiling");
  });

  it("3c — the response describes the lookback once, by preset only", async () => {
    // Two representations of one state drift. The token is the representation; the day count it
    // resolves to is an implementation detail of computing the dates.
    for (const preset of ["7d", "30d", "90d"]) {
      const { service } = capturingService();
      const out = await service.certify("optimise", { sourceObjects: ["conversions"], windowPreset: preset });
      assert.equal(out.windowPreset, preset);
      assert.equal("windowDays" in out, false, `windowDays exposed at ${preset}`);
      for (const key of Object.keys(out)) {
        assert.ok(!/days|fromDate|toDate|startDate|endDate/i.test(key), `response exposes ${key}`);
      }
      // Nor anywhere deeper in the payload.
      assert.ok(!serialise(out).includes("windowDays"), "windowDays appears somewhere in the response");
    }
  });

  it("3b — the preset set is exactly the three approved tokens", () => {
    assert.deepEqual(Object.keys(WINDOW_PRESETS), ["7d", "30d", "90d"]);
  });

  it("4 — an arbitrary preset is a 400", () => {
    for (const bad of ["365d", "1d", "180d", "7D", "7", 7, "", null, "all", "7d "]) {
      assert.throws(
        () => parseRunBody({ windowPreset: bad }),
        (error) => {
          assert.equal(error.statusCode ?? error.status, 400, JSON.stringify(bad));
          assert.match(error.message, /windowPreset must be one of/);
          return true;
        },
        `accepted a bad preset: ${JSON.stringify(bad)}`,
      );
    }
  });

  it("5 — arbitrary dates and day counts are rejected as unknown keys", () => {
    for (const key of [
      "fromDate",
      "toDate",
      "startDate",
      "endDate",
      "dateFrom",
      "dateTo",
      "days",
      "daysBack",
      "windowDays",
      "lookbackDays",
    ]) {
      assert.throws(
        () => parseRunBody({ sourceObjects: ["conversions"], [key]: "2020-01-01" }),
        (error) => {
          assert.equal(error.statusCode ?? error.status, 400, key);
          assert.match(error.message, /Unsupported field\(s\)/);
          return true;
        },
        `accepted a date-shaped key: ${key}`,
      );
    }
  });

  it("6 — the service computes the dates; the caller supplies only a token", async () => {
    const { service, seen } = capturingService();
    await service.certify("optimise", { sourceObjects: ["conversions"], windowPreset: "30d" });
    const { from, to } = seen[0].window;
    assert.match(from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(to, /^\d{4}-\d{2}-\d{2}$/);
    // `to` is today, computed here rather than supplied.
    assert.equal(to, new Date().toISOString().slice(0, 10));
    // parseRunBody hands the service a token, never a date.
    const parsed = parseRunBody({ windowPreset: "30d" });
    assert.equal(parsed.windowPreset, "30d");
    for (const key of Object.keys(parsed)) {
      assert.ok(!/date|from|to$|days/i.test(key), `parsed body carries a date-ish key: ${key}`);
    }
  });

  it("6b — an unknown preset reaching the service falls back rather than producing a bad window", async () => {
    // Unreachable through the route, which rejects it with a 400. Belt and braces.
    const { service, seen } = capturingService();
    const out = await service.certify("optimise", { sourceObjects: ["conversions"], windowPreset: "999d" });
    assert.equal(spanDays(seen[0].window), 7);
    assert.equal(out.windowPreset, "7d");
  });

  it("7 — conversions still emits exactly the proven query keys at every preset", async () => {
    for (const preset of ["7d", "30d", "90d"]) {
      const requests = [];
      const adapter = createOptimiseAdapter({
        apiKey: "k",
        agencyId: "AG1",
        contactId: "C1",
        httpClient: {
          get: async (path, config = {}) => {
            requests.push({ path, params: config.params });
            return { data: [{ id: 1 }] };
          },
        },
        certificationRateLimiter: { acquireSlot: async () => {}, resetAfterRateLimit: () => {} },
      });
      const days = WINDOW_PRESETS[preset];
      const to = new Date();
      const from = new Date(to.getTime() - days * DAY_MS);
      const iso = (d) => d.toISOString().slice(0, 10);
      await adapter.fetchCertificationSample("conversions", { window: { from: iso(from), to: iso(to) } });

      assert.deepEqual(
        Object.keys(requests[0].params).sort(),
        [
          "agencyId",
          "contactId",
          "conversionType",
          "dateField",
          "fromDate",
          "limit",
          "offset",
          "targetCurrencyCode",
          "toDate",
        ],
        preset,
      );
      for (const stale of ["startDate", "endDate", "dateFrom", "dateTo"]) {
        assert.equal(stale in requests[0].params, false, `${preset} sent ${stale}`);
      }
    }
  });

  it("8 — one supplier request whatever the preset", async () => {
    for (const preset of ["7d", "30d", "90d"]) {
      const { service, seen } = capturingService();
      await service.certify("optimise", { sourceObjects: ["conversions"], windowPreset: preset });
      assert.equal(seen.length, 1, preset);
    }
  });

  it("9 — a wider window changes no retry, pagination or timeout behaviour", () => {
    const start = adapterSource.indexOf("async fetchCertificationSample");
    const body = adapterSource.slice(start, adapterSource.indexOf("\n    },", start));
    assert.ok(!body.includes("requestWithRetry"), "still no retry");
    assert.ok(!body.includes("fetchOffsetPaginated"), "still no paginator");
    assert.match(body, /CERTIFICATION_SAMPLE_TIMEOUT_MS/, "still the same timeout source");
    assert.match(body, /\.slice\(0, 1\)/, "still one row");
    // The preset only reaches the window; it cannot reach any of the bounds above.
    const serviceStart = adapterSource.indexOf("const CERTIFICATION_SAMPLES");
    const table = adapterSource.slice(serviceStart, adapterSource.indexOf("export function listCertificationSamples"));
    assert.ok(!table.includes("windowPreset"), "the sample table never sees a preset token");
  });

  it("10 — normal Optimise sync is unaffected by the preset", async () => {
    const syncSource = (await import("node:fs")).readFileSync("src/jobs/sync.job.js", "utf8");
    assert.ok(!syncSource.includes("windowPreset"), "sync must not read the certification preset");
    assert.match(syncSource, /OPTIMISE_CONVERSIONS_DAYS_BACK/, "sync keeps its own lookback setting");
    const start = adapterSource.indexOf("fetchConversions(params = {})");
    const body = adapterSource.slice(start, adapterSource.indexOf("fetchPayments(params = {})", start));
    assert.ok(!body.includes("windowPreset"), "the sync fetcher never sees a preset");
    assert.match(body, /if \(!fromDate \|\| !toDate\)/, "sync date guard intact");
  });

  it("payments and invoices keep their own contract at a widened preset", async () => {
    const requests = [];
    const adapter = createOptimiseAdapter({
      apiKey: "k",
      agencyId: "AG1",
      contactId: "C1",
      httpClient: {
        get: async (path, config = {}) => {
          requests.push({ path, params: config.params });
          return { data: [{ id: 1 }] };
        },
      },
      certificationRateLimiter: { acquireSlot: async () => {}, resetAfterRateLimit: () => {} },
    });
    await adapter.fetchCertificationSample("invoices", { window: { from: "2026-06-14", to: "2026-09-12" } });
    assert.equal(requests[0].params.startDate, "2026-06-14");
    assert.equal(requests[0].params.endDate, "2026-09-12");
    assert.equal("fromDate" in requests[0].params, false);
  });
});

/**
 * Optimise campaign rows carry two identifier namespaces, and the two campaign-scoped endpoints
 * take different ones. Sending the wrong one addresses somebody else's campaign, which the supplier
 * answers 403 — the observed campaign_detail AUTH_FAILED. These tests hold the two apart.
 *
 *   GET /campaigns/{productId}                     campaign detail
 *   GET /campaigns/{campaignId}/commission-groups  commission groups
 */
describe("campaign identifier namespaces stay separate", () => {
  // The live-certified row: one campaign, both identifiers, deliberately different values.
  const LIVE_ROW = Object.freeze({ id: "99999", campaignId: "7340528", productId: "57316", name: "Ubuy SG" });

  function pathRecorder() {
    const requests = [];
    return {
      requests,
      get: async (path, config = {}) => {
        requests.push({ path, params: config.params });
        return { data: [{ ok: 1 }] };
      },
    };
  }

  function probeAdapterFor(httpClient) {
    return createOptimiseAdapter({
      apiKey: "k",
      agencyId: "AG1",
      contactId: "C1",
      httpClient,
      certificationRateLimiter: { acquireSlot: async () => {}, resetAfterRateLimit: () => {} },
    });
  }

  /** A service whose campaigns sample is `row`, recording every dependent request path. */
  function serviceSampling(row) {
    const calls = [];
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => ({
        fetchCertificationSample: async (sourceObject, ctx) => {
          calls.push({ sourceObject, ctx });
          if (sourceObject === "campaigns" || sourceObject === "campaign_candidates") {
            return row ? [row] : [];
          }
          return [{ sampled: true }];
        },
        fetchCertificationCommissionGroupSample: async (campaignId) => {
          calls.push({ sourceObject: "commission_groups", campaignId });
          return { rows: [{ commissionGroupId: 5, rate: "3.5" }], envelopeKind: "array" };
        },
      }),
      credentialResolver: async () => ({ apiKey: SECRET_VALUES[0], agencyId: "AG1", contactId: "C1" }),
    });
    return { service, calls };
  }

  it("1 — campaign_detail uses productId only", async () => {
    const httpClient = pathRecorder();
    await probeAdapterFor(httpClient).fetchCertificationSample("campaign_detail", { campaignDetailId: "57316" });
    assert.equal(httpClient.requests[0].path, "/campaigns/57316");
  });

  it("2 — commission_groups uses campaignId", () => {
    assert.equal(commissionGroupCampaignIdOf(LIVE_ROW), "7340528");
  });

  it("2b — commission_groups builds the campaignId path", async () => {
    const httpClient = pathRecorder();
    await probeAdapterFor(httpClient).fetchCertificationSample("commission_groups", {
      commissionGroupCampaignId: "7340528",
    });
    assert.equal(httpClient.requests[0].path, "/campaigns/7340528/commission-groups");
  });

  it("3 — commission_groups accepts the campaign_id alias", () => {
    assert.equal(commissionGroupCampaignIdOf({ campaign_id: "7340528", productId: "57316" }), "7340528");
    assert.equal(commissionGroupCampaignIdOf({ campaignId: "", campaign_id: "7340528" }), "7340528");
  });

  it("3b — campaign_detail accepts the product_id alias", () => {
    assert.equal(campaignDetailIdOf({ product_id: "57316" }), "57316");
  });

  it("4 — `id` is never used for either endpoint", () => {
    // A row carrying ONLY id must yield nothing for both.
    assert.equal(campaignDetailIdOf({ id: "99999" }), null);
    assert.equal(commissionGroupCampaignIdOf({ id: "99999" }), null);
    // And with id present alongside the real identifiers, id never wins.
    assert.equal(campaignDetailIdOf(LIVE_ROW), "57316");
    assert.equal(commissionGroupCampaignIdOf(LIVE_ROW), "7340528");
  });

  it("4b — the service no longer reads `id` as an identifier at all", async () => {
    const source = (await import("node:fs")).readFileSync(
      "src/modules/ops/networkCertification.service.js",
      "utf8",
    );
    assert.ok(!source.includes("first.id"), "the removed fallback must not return");
    assert.ok(!/ctx\.campaignId\b/.test(source), "no shared campaignId context remains");
  });

  it("5 — productId is never used for commission_groups", async () => {
    assert.equal(commissionGroupCampaignIdOf({ productId: "57316", product_id: "57316" }), null);
    const { service, calls } = serviceSampling({ productId: "57316" });
    const out = await service.certify("optimise", { sourceObjects: ["commission_groups"], compareRaw: false });
    assert.equal(out.results[0].statusCategory, "SKIPPED_NO_COMMISSION_GROUP_CAMPAIGN_ID");
    assert.equal(calls.filter((c) => c.sourceObject === "commission_groups").length, 0, "no request made");
  });

  it("6 — campaignId is never used for campaign_detail", async () => {
    assert.equal(campaignDetailIdOf({ campaignId: "7340528", campaign_id: "7340528" }), null);
    const { service, calls } = serviceSampling({ campaignId: "7340528" });
    const out = await service.certify("optimise", { sourceObjects: ["campaign_detail"], compareRaw: false });
    assert.equal(out.results[0].statusCategory, "SKIPPED_NO_CAMPAIGN_DETAIL_ID");
    assert.equal(calls.filter((c) => c.sourceObject === "campaign_detail").length, 0, "no request made");
  });

  it("7 — a missing productId skips safely with zero dependent calls", async () => {
    const { service, calls } = serviceSampling({ id: "99999", campaignId: "7340528" });
    const out = await service.certify("optimise", { sourceObjects: ["campaign_detail"], compareRaw: false });
    const row = out.results[0];
    assert.equal(row.statusCategory, "SKIPPED_NO_CAMPAIGN_DETAIL_ID");
    assert.equal(row.ok, false);
    assert.equal(row.sampleCount, 0);
    assert.deepEqual(row.fieldPaths, []);
    assert.deepEqual(calls.map((c) => c.sourceObject), ["campaigns"], "only the bootstrap sample");
  });

  it("8 — a missing campaignId skips safely with zero dependent calls", async () => {
    const { service, calls } = serviceSampling({ id: "99999", productId: "57316" });
    const out = await service.certify("optimise", { sourceObjects: ["commission_groups"], compareRaw: false });
    const row = out.results[0];
    assert.equal(row.statusCategory, "SKIPPED_NO_COMMISSION_GROUP_CAMPAIGN_ID");
    assert.equal(row.sampleCount, 0);
    assert.deepEqual(calls.map((c) => c.sourceObject), ["campaign_candidates"], "only the list request");
  });

  it("9 — a caller cannot inject either identifier", () => {
    for (const key of [
      "campaignId",
      "campaign_id",
      "productId",
      "product_id",
      "campaignDetailId",
      "commissionGroupCampaignId",
      "id",
    ]) {
      assert.throws(
        () => parseRunBody({ sourceObjects: ["campaign_detail"], [key]: "57316" }),
        (error) => {
          assert.equal(error.statusCode ?? error.status, 400, key);
          assert.match(error.message, /Unsupported field\(s\)/);
          return true;
        },
        `accepted an identifier key: ${key}`,
      );
    }
  });

  it("9b — an identifier carrying path or query syntax is refused, not interpolated", () => {
    for (const hostile of ["7340528/../../admin", "7340528?x=1", "7340528#f", "73 40528", "7340528\\\\x"]) {
      assert.equal(commissionGroupCampaignIdOf({ campaignId: hostile }), null, hostile);
      assert.equal(campaignDetailIdOf({ productId: hostile }), null, hostile);
    }
  });

  it("10 — campaigns, products and conversions certification are unchanged", async () => {
    const { service, calls } = serviceSampling(LIVE_ROW);
    // None of these declares `needs`, so none triggers the campaign bootstrap.
    const out = await service.certify("optimise", {
      sourceObjects: ["campaigns", "conversions", "voucher_codes"],
      compareRaw: false,
    });
    assert.deepEqual(out.results.map((r) => r.statusCategory), ["OK", "OK", "OK"]);
    assert.deepEqual(calls.map((c) => c.sourceObject), ["campaigns", "conversions", "voucher_codes"]);
  });

  it("11 — each campaign-scoped probe makes exactly the bounded expected calls", async () => {
    const { service, calls } = serviceSampling(LIVE_ROW);
    const out = await service.certify("optimise", {
      sourceObjects: ["campaign_detail", "commission_groups"],
      compareRaw: false,
    });
    assert.deepEqual(out.results.map((r) => r.statusCategory), ["OK", "OK"]);
    // campaign_detail: one bootstrap sample plus its own request.
    // commission_groups: its own bounded campaign list plus one dependent request.
    assert.deepEqual(calls.map((c) => c.sourceObject), [
      "campaigns",
      "campaign_detail",
      "campaign_candidates",
      "commission_groups",
    ]);
    const detail = calls.find((c) => c.sourceObject === "campaign_detail");
    const groups = calls.find((c) => c.sourceObject === "commission_groups");
    assert.equal(detail.ctx.campaignDetailId, "57316", "detail reads productId");
    assert.equal(groups.campaignId, "7340528", "groups read campaignId");
  });

  it("11b — the bootstrap runs once even when both dependent endpoints are requested", async () => {
    const { service, calls } = serviceSampling(LIVE_ROW);
    await service.certify("optimise", {
      sourceObjects: ["campaign_detail", "commission_groups"],
      compareRaw: false,
    });
    assert.equal(calls.filter((c) => c.sourceObject === "campaigns").length, 1);
    assert.equal(calls.filter((c) => c.sourceObject === "campaign_candidates").length, 1);
  });

  it("12 — a supplier error on a campaign-scoped probe stays sanitized", async () => {
    const error = new Error("403 for campaign 57316 with apikey sk_live_LEAKME — not your advertiser");
    error.response = { status: 403, data: { message: "forbidden: campaign 57316" } };
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => ({
        fetchCertificationSample: async (sourceObject) => {
          if (sourceObject === "campaigns") return [LIVE_ROW];
          throw error;
        },
      }),
      credentialResolver: async () => ({ apiKey: SECRET_VALUES[0], agencyId: "AG1", contactId: "C1" }),
    });
    const out = await service.certify("optimise", { sourceObjects: ["campaign_detail"], compareRaw: false });
    assert.equal(out.results[0].statusCategory, "AUTH_FAILED");
    const text = serialise(out);
    // The supplier's own explanation is now surfaced, redacted — but nothing else is. The API key
    // and the internal error text live in error.message, which is NOT a message source, and the
    // campaign id is a long numeric identifier, which redaction removes.
    for (const leak of ["sk_live_LEAKME", "not your advertiser", "57316", "7340528"]) {
      assert.ok(!text.includes(leak), `leaked: ${leak}`);
    }
    assert.equal(out.results[0].supplierMessage, "forbidden: campaign [REDACTED_ID]");
    assert.equal(out.results[0].supplierStatusCode, 403);
  });
});

/**
 * A campaign with no commission groups is common, so certifying from one campaign is a coin flip.
 * The chain looks at a few campaigns and stops at the first that has any — while staying bounded in
 * requests and in time, and failing closed on anything that is not a genuinely empty answer.
 */
describe("commission groups — bounded multi-campaign sampler", () => {
  const GROUP_ROW = { commissionGroupId: 5, name: "Default", rate: "3.5", currency: "SGD" };

  function row(id, extra = {}) {
    return { id: `internal-${id}`, campaignId: String(id), productId: `p-${id}`, ...extra };
  }

  /**
   * `outcomes` is consulted per campaign id: an array of rows, or an Error to throw.
   * Every supplier interaction is recorded so the request count and order can be asserted.
   */
  function chainService({ campaigns = [], outcomes = {}, listError = null, groupDelayMs = 0 } = {}) {
    const calls = [];
    const service = new NetworkCertificationService({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => ({
        fetchCertificationSample: async (sourceObject, ctx) => {
          calls.push({ kind: sourceObject, timeoutMs: ctx?.timeoutMs });
          if (sourceObject === "campaign_candidates") {
            if (listError) throw listError;
            return campaigns;
          }
          return [{ sampled: true }];
        },
        fetchCertificationCommissionGroupSample: async (campaignId, ctx) => {
          calls.push({ kind: "groups", campaignId, timeoutMs: ctx?.timeoutMs });
          if (groupDelayMs) await new Promise((r) => setTimeout(r, groupDelayMs));
          const outcome = outcomes[campaignId] ?? [];
          if (outcome instanceof Error) throw outcome;
          return { rows: outcome, envelopeKind: outcome.length ? "array" : "empty" };
        },
      }),
      credentialResolver: async () => ({ apiKey: SECRET_VALUES[0], agencyId: "AG1", contactId: "C1" }),
    });
    return { service, calls };
  }

  const run = (service) =>
    service.certify("optimise", { sourceObjects: ["commission_groups"], compareRaw: false });

  const groupCalls = (calls) => calls.filter((c) => c.kind === "groups");

  it("1 — the campaign list request is bounded to five rows", () => {
    assert.equal(COMMISSION_GROUP_CANDIDATE_LIMIT, 5);
    const start = adapterSource.indexOf("campaign_candidates: {");
    const spec = adapterSource.slice(start, adapterSource.indexOf("},", start));
    assert.match(spec, /offset: 0, limit: COMMISSION_GROUP_CANDIDATE_LIMIT/);
    assert.match(adapterSource, /COMMISSION_GROUP_CANDIDATE_LIMIT = 5/);
  });

  it("1b — never more than five campaign rows are considered, however many are returned", async () => {
    const campaigns = Array.from({ length: 20 }, (_, i) => row(i + 1));
    const { service, calls } = chainService({ campaigns });
    await run(service);
    assert.equal(groupCalls(calls).length, 5, "five dependent requests at most");
  });

  it("2 — campaign ids come only from campaignId/campaign_id", async () => {
    const { service, calls } = chainService({
      campaigns: [{ campaign_id: "888" }],
      outcomes: { 888: [GROUP_ROW] },
    });
    const out = await run(service);
    assert.equal(groupCalls(calls)[0].campaignId, "888");
    assert.equal(out.results[0].statusCategory, "OK");
  });

  it("3 — `id` is ignored as a campaign identifier", async () => {
    const { service, calls } = chainService({ campaigns: [{ id: "99999" }] });
    const out = await run(service);
    assert.equal(out.results[0].statusCategory, "SKIPPED_NO_COMMISSION_GROUP_CAMPAIGN_ID");
    assert.equal(groupCalls(calls).length, 0);
  });

  it("4 — productId and product_id are ignored", async () => {
    const { service, calls } = chainService({
      campaigns: [{ productId: "57316" }, { product_id: "57317" }],
    });
    const out = await run(service);
    assert.equal(out.results[0].statusCategory, "SKIPPED_NO_COMMISSION_GROUP_CAMPAIGN_ID");
    assert.equal(groupCalls(calls).length, 0);
  });

  it("5 — rows without a campaignId are skipped, valid ones still tried", async () => {
    const { service, calls } = chainService({
      campaigns: [{ id: "a" }, { productId: "b" }, row(3), { campaignId: "  " }],
      outcomes: { 3: [GROUP_ROW] },
    });
    const out = await run(service);
    assert.deepEqual(groupCalls(calls).map((c) => c.campaignId), ["3"]);
    assert.equal(out.results[0].statusCategory, "OK");
  });

  it("6 — an empty first campaign moves on to the second", async () => {
    const { service, calls } = chainService({
      campaigns: [row(1), row(2)],
      outcomes: { 1: [], 2: [GROUP_ROW] },
    });
    const out = await run(service);
    assert.deepEqual(groupCalls(calls).map((c) => c.campaignId), ["1", "2"]);
    assert.equal(out.results[0].sampleCount, 1);
  });

  it("7 — two empty then a hit stops at the third", async () => {
    const { service, calls } = chainService({
      campaigns: [row(1), row(2), row(3), row(4), row(5)],
      outcomes: { 1: [], 2: [], 3: [GROUP_ROW], 4: [GROUP_ROW], 5: [GROUP_ROW] },
    });
    const out = await run(service);
    assert.deepEqual(groupCalls(calls).map((c) => c.campaignId), ["1", "2", "3"]);
    assert.equal(out.results[0].statusCategory, "OK");
    assert.equal(out.results[0].sampleCount, 1);
  });

  it("8 — once a non-empty response is found no further supplier request occurs", async () => {
    const { service, calls } = chainService({
      campaigns: [row(1), row(2), row(3)],
      outcomes: { 1: [GROUP_ROW], 2: [GROUP_ROW], 3: [GROUP_ROW] },
    });
    await run(service);
    assert.equal(groupCalls(calls).length, 1);
    assert.equal(calls.length, 2, "one list request plus one dependent request");
  });

  it("9 — all five empty gives a normal OK with sampleCount 0", async () => {
    const { service, calls } = chainService({
      campaigns: [row(1), row(2), row(3), row(4), row(5)],
      outcomes: {},
    });
    const out = await run(service);
    const result = out.results[0];
    assert.equal(result.ok, true);
    assert.equal(result.statusCategory, "OK");
    assert.equal(result.sampleCount, 0);
    assert.equal(result.fieldCount, 0);
    assert.deepEqual(result.fieldPaths, []);
    assert.equal(result.campaignsChecked, 5);
    assert.match(result.note, /does not mean the network has none/i);
    assert.equal(groupCalls(calls).length, 5);
  });

  it("10 — never more than five dependent requests, and six supplier requests in total", async () => {
    assert.equal(MAX_SUPPLIER_REQUESTS_COMMISSION_GROUPS, 6);
    const { service, calls } = chainService({
      campaigns: Array.from({ length: 5 }, (_, i) => row(i + 1)),
    });
    await run(service);
    assert.equal(groupCalls(calls).length, 5);
    assert.equal(calls.length, MAX_SUPPLIER_REQUESTS_COMMISSION_GROUPS);
  });

  it("11 — no pagination to exhaustion anywhere in the chain", () => {
    const source = serviceSourceText();
    const start = source.indexOf("async certifyCommissionGroups");
    const body = source.slice(start, source.indexOf("\n  /**", start));
    assert.ok(!body.includes("fetchOffsetPaginated"), "no paginator");
    assert.ok(!/offset/i.test(body), "the chain never advances an offset");
    assert.ok(!/while\s*\(/.test(body), "no unbounded loop");
    assert.match(body, /slice\(0, COMMISSION_GROUP_CANDIDATE_LIMIT\)/, "candidate list is capped");
  });

  it("12 — a caller cannot inject campaign identifiers or paging controls", () => {
    for (const key of [
      "campaignId",
      "campaign_id",
      "productId",
      "campaignIds",
      "campaigns",
      "offset",
      "limit",
      "page",
      "pageSize",
      "perPage",
      "maxCampaigns",
    ]) {
      assert.throws(
        () => parseRunBody({ sourceObjects: ["commission_groups"], [key]: 5 }),
        (error) => {
          assert.equal(error.statusCode ?? error.status, 400, key);
          assert.match(error.message, /Unsupported field\(s\)/);
          return true;
        },
        `accepted ${key}`,
      );
    }
  });

  it("13 — AUTH_FAILED on the second campaign stops immediately", async () => {
    const authError = new Error("nope");
    authError.response = { status: 401 };
    const { service, calls } = chainService({
      campaigns: [row(1), row(2), row(3)],
      outcomes: { 1: [], 2: authError, 3: [GROUP_ROW] },
    });
    const out = await run(service);
    assert.equal(out.results[0].statusCategory, "AUTH_FAILED");
    assert.equal(out.results[0].ok, false);
    assert.deepEqual(groupCalls(calls).map((c) => c.campaignId), ["1", "2"], "campaign 3 never tried");
  });

  it("14 — RATE_LIMITED stops immediately", async () => {
    const rateError = new Error("slow down");
    rateError.response = { status: 429 };
    const { service, calls } = chainService({
      campaigns: [row(1), row(2)],
      outcomes: { 1: rateError, 2: [GROUP_ROW] },
    });
    const out = await run(service);
    assert.equal(out.results[0].statusCategory, "RATE_LIMITED");
    assert.equal(groupCalls(calls).length, 1);
  });

  it("14b — every other supplier failure also stops the chain", async () => {
    const cases = [
      [{ response: { status: 400 } }, "REQUEST_REJECTED"],
      [{ response: { status: 503 } }, "UPSTREAM_ERROR"],
      [{ certificationTimeout: true }, "SUPPLIER_TIMEOUT"],
      [{}, "NETWORK_ERROR"],
    ];
    for (const [shape, expected] of cases) {
      const error = Object.assign(new Error("boom"), shape);
      const { service, calls } = chainService({
        campaigns: [row(1), row(2)],
        outcomes: { 1: error, 2: [GROUP_ROW] },
      });
      const out = await run(service);
      assert.equal(out.results[0].statusCategory, expected);
      assert.equal(groupCalls(calls).length, 1, `${expected} continued to campaign 2`);
    }
  });

  it("15 — budget exhaustion stops safely partway through", async () => {
    const original = process.env.CERTIFICATION_SOURCE_BUDGET_MS;
    process.env.CERTIFICATION_SOURCE_BUDGET_MS = "3000";
    const { NetworkCertificationService: Scoped } = await import(
      `../src/modules/ops/networkCertification.service.js?budget=${Date.now()}`
    );
    const calls = [];
    const service = new Scoped({
      prisma: { rawPayload: { findMany: async () => [] } },
      adapterFactory: () => ({
        fetchCertificationSample: async () => Array.from({ length: 5 }, (_, i) => row(i + 1)),
        fetchCertificationCommissionGroupSample: async (campaignId) => {
          calls.push(campaignId);
          await new Promise((r) => setTimeout(r, 400));
          return { rows: [], envelopeKind: "empty" };
        },
      }),
      credentialResolver: async () => ({ apiKey: "k", agencyId: "AG1", contactId: "C1" }),
    });
    const out = await service.certify("optimise", {
      sourceObjects: ["commission_groups"],
      compareRaw: false,
    });
    const result = out.results[0];
    assert.ok(
      ["SOURCE_BUDGET_EXHAUSTED", "OK"].includes(result.statusCategory),
      `unexpected: ${result.statusCategory}`,
    );
    assert.ok(calls.length <= 5, "never exceeds the candidate cap");
    assert.equal(result.sampleCount, 0);
    process.env.CERTIFICATION_SOURCE_BUDGET_MS = original;
  });

  it("15b — each attempt is timed against the remaining source budget", () => {
    const source = serviceSourceText();
    const start = source.indexOf("async certifyCommissionGroups");
    const body = source.slice(start, source.indexOf("\n  /**", start));
    assert.match(body, /const deadline = Date\.now\(\) \+ Math\.max\(0, Math\.min\(SOURCE_BUDGET_MS, budgetLeft\(\)\)\)/);
    assert.match(body, /attemptTimeout\(\)/, "each request gets a computed timeout");
    assert.match(body, /timeLeft\(\) < MIN_ATTEMPT_MS/, "stops when too little time remains");
    // Five full-length timeouts must not be possible inside one source budget.
    assert.match(body, /Math\.min\(SOURCE_BUDGET_MS \/ 2, timeLeft\(\)\)/);
  });

  it("16 — an unrecognised non-empty envelope fails safely, never as zero groups", async () => {
    const envelopeError = new Error("Optimise commission-groups response is not JSON");
    envelopeError.code = "optimise_commission_groups_unrecognised_envelope";
    const { service, calls } = chainService({
      campaigns: [row(1), row(2)],
      outcomes: { 1: envelopeError, 2: [GROUP_ROW] },
    });
    const out = await run(service);
    assert.notEqual(out.results[0].statusCategory, "OK", "must not be reported as a clean empty result");
    assert.equal(out.results[0].ok, false);
    assert.equal(groupCalls(calls).length, 1, "must not move on to another campaign");
    // The strict reader is what produces this; the chain must not substitute a lenient one.
    const chainStart = adapterSource.indexOf("async fetchCertificationCommissionGroupSample");
    const chainBody = adapterSource.slice(chainStart, adapterSource.indexOf("\n    },", chainStart));
    assert.match(chainBody, /extractCommissionGroupRows/);
    assert.ok(!chainBody.includes("extractRows("), "must not use the lenient extractor");
  });

  it("17 — only the first group row is summarised", async () => {
    const { service } = chainService({
      campaigns: [row(1)],
      outcomes: { 1: [GROUP_ROW, { commissionGroupId: 6, extraOnlyOnSecond: "x" }] },
    });
    const out = await run(service);
    assert.equal(out.results[0].sampleCount, 1);
    const paths = out.results[0].fieldPaths.map((f) => f.path);
    assert.ok(paths.includes("commissionGroupId"));
    assert.ok(!paths.includes("extraOnlyOnSecond"), "the second row must not be summarised");
  });

  it("18 — the output carries no campaign identifier, index or raw value", async () => {
    const { service } = chainService({
      campaigns: [row(1), row(2), row(7340528)],
      outcomes: { 7340528: [GROUP_ROW] },
    });
    const out = await run(service);
    const text = serialise(out);
    for (const leak of ["7340528", "internal-", "p-1", "Default", "3.5", "SGD", SECRET_VALUES[0]]) {
      assert.ok(!text.includes(leak), `leaked: ${leak}`);
    }
    // A hit must not disclose how many campaigns were tried — that is a campaign index.
    assert.equal("campaignsChecked" in out.results[0], false);
    assert.ok(serialise(out.results[0].fieldPaths).includes("commissionGroupId"), "schema still reported");
  });

  it("19 — other source objects keep their existing request limits", async () => {
    assert.equal(MAX_SUPPLIER_REQUESTS_PER_SOURCE, 1);
    const { service, calls } = chainService({ campaigns: [row(1)] });
    await service.certify("optimise", {
      sourceObjects: ["campaigns", "conversions", "voucher_codes", "invoices"],
      compareRaw: false,
    });
    assert.equal(calls.length, 4, "one request each, no chain triggered");
    assert.equal(groupCalls(calls).length, 0);
  });

  it("20 — the product two-request exception is unchanged", () => {
    assert.equal(MAX_SUPPLIER_REQUESTS_PRODUCTS, 2);
    const source = serviceSourceText();
    assert.match(source, /export const MAX_SUPPLIER_REQUESTS_PRODUCTS = 2;/);
    const start = source.indexOf("async certifyProductChain");
    const body = source.slice(start, source.indexOf("\n  /**", start));
    assert.match(body, /fetchCertificationFeedItemSample/, "still one feed then one item");
    assert.ok(!body.includes("COMMISSION_GROUP_CANDIDATE_LIMIT"), "products borrow nothing from the new chain");
  });

  it("the internal candidate list is not a requestable source object", async () => {
    assert.equal(listProbeSourceObjects("optimise").includes("campaign_candidates"), false);
    assert.equal(listCertificationSamples().includes("campaign_candidates"), false);
    const { service } = chainService({ campaigns: [row(1)] });
    await assert.rejects(
      () => service.certify("optimise", { sourceObjects: ["campaign_candidates"] }),
      /unknown source objects/i,
    );
  });
});
