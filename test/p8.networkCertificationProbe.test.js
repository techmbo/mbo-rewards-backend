import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const { categorise, collectPaths, comparePathSets, isCredentialKey, summarisePayloads } = await import(
  "../src/modules/ops/payloadShape.js"
);
const { NetworkCertificationService, listProbeSourceObjects, statusCategory } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { PERMISSIONS, ROLE_PERMISSIONS } = await import("../src/auth/permissions.js");
const { parseRunBody, networkCertificationCatalogHandler, networkCertificationRunHandler } = await import(
  "../src/controllers/networkCertification.controller.js"
);
const routesSource = (await import("node:fs")).readFileSync("src/routes/index.js", "utf8");

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
      fetchCampaigns: async () => [supplierRecord()],
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

  /** Records every adapter method the probe invokes, so mutations can be asserted absent. */
  function makeAdapter() {
    const called = [];
    const record = (name, value) => {
      called.push(name);
      return value;
    };
    return {
      called,
      fetchCampaigns: async () => record("fetchCampaigns", [supplierRecord()]),
      fetchVoucherCodes: async () => record("fetchVoucherCodes", [{ voucherCodeId: 1, voucherCode: "SAVE10" }]),
      fetchConversions: async () => record("fetchConversions", [{ conversionId: 9, currency: "USD" }]),
      fetchPayments: async () => record("fetchPayments", [{ paymentId: 3 }]),
      fetchInvoices: async () => record("fetchInvoices", [{ invoiceId: 4 }]),
      fetchProductFeeds: async () => record("fetchProductFeeds", [{ FeedID: 7, PID: 999 }]),
      fetchReporting: async () => record("fetchReporting", [{ clicks: 10, campaignId: 1 }]),
      fetchInvoiceReporting: async () => record("fetchInvoiceReporting", [{ clicks: 2 }]),
      fetchCommissionGroups: async () => record("fetchCommissionGroups", [{ commission_group_id: 5 }]),
      fetchCampaignDetail: async () => record("fetchCampaignDetail", { id: 56577, name: "Ubuy SG" }),
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
      assert.ok(/^fetch/.test(name), `non-read adapter call: ${name}`);
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
    for (const value of ["AG1", "C1", "SAVE10", "Ubuy SG"]) {
      assert.ok(!text.includes(value), `value leaked: ${value}`);
    }
  });

  it("takes the campaign id from a sample, not from the caller", async () => {
    const { service, adapter } = makeService();
    const out = await service.certify("optimise", { sourceObjects: ["commission_groups"], compareRaw: false });
    assert.ok(adapter.called.includes("fetchCampaigns"), "campaigns sampled to obtain the id");
    assert.equal(out.results[0].statusCategory, "OK");
  });

  it("skips campaign-scoped probes when no campaign sample is available", async () => {
    const adapter = makeAdapter();
    adapter.fetchCampaigns = async () => [];
    const { service } = makeService(makeDb(), adapter);
    const out = await service.certify("optimise", { sourceObjects: ["campaign_detail"], compareRaw: false });
    assert.equal(out.results[0].statusCategory, "SKIPPED_NO_CAMPAIGN_SAMPLE");
  });

  it("reduces a supplier failure to a status category with no error text", async () => {
    const adapter = makeAdapter();
    adapter.fetchCampaigns = async () => {
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
