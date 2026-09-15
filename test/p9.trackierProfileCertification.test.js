import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { createTrackierAdapter, TRACKIER_PROFILE_PATH } = await import(
  "../src/adapters/trackier.adapter.js"
);
const { NetworkCertificationService, listProbeNetworks, listProbeSourceObjects } = await import(
  "../src/modules/ops/networkCertification.service.js"
);
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");

const ADAPTER_SRC = readFileSync("src/adapters/trackier.adapter.js", "utf8");
const SERVICE_SRC = readFileSync("src/modules/ops/networkCertification.service.js", "utf8");
const CREDENTIALS_SRC = readFileSync("src/modules/integrations/trackierCredentials.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/sync.job.js", "utf8");

/**
 * Comments are prose; an assertion that matches one proves nothing about behaviour.
 * A single pass tracking both comment state and string state.
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

const API_KEY = "zztrackierapikeyzz";

/**
 * One publisher profile. Field NAMES plausible, every VALUE a distinctive marker — a realistic
 * publisher name is indistinguishable by substring from a path named name.
 */
const PROFILE = {
  id: "zzpublisheridzz",
  pubId: "zzpubidzz",
  name: "zzpublishernamezz",
  email: "zzpublisher@zzmailzz.example",
  phone: "zzphonenumberzz",
  address: {
    line1: "zzaddresslinezz",
    city: "zzcityzz",
    country: "zzcountryzz",
  },
  status: "zzstatuszz",
  currency: "SGD",
  createdAt: "2031-03-17",
};

function spyHttp(dataOrError = { profile: PROFILE }) {
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
  return createTrackierAdapter({ apiKey: API_KEY, httpClient: spy.client });
}

function serviceWith(adapter, { apiKey = API_KEY } = {}) {
  return new NetworkCertificationService({
    prisma: {
      rawPayload: {
        findMany: async () => {
          throw new Error("certification must not read RawPayload unless compareRaw is requested");
        },
      },
    },
    adapterFactory: () => adapter,
    trackierCredentialResolver: async () => (apiKey ? { apiKey } : null),
  });
}

async function certifyProfile(adapter, options = {}) {
  return serviceWith(adapter, options).certify("trackier", { sourceObjects: ["profile"] });
}

describe("Trackier is registered in the certification framework", () => {
  it("appears as a probe network", () => {
    assert.ok(listProbeNetworks().includes("trackier"));
  });

  it("exposes profile, and nothing else yet", () => {
    assert.deepEqual(listProbeSourceObjects("trackier"), ["profile"]);
  });

  it("adds no probe for the objects this phase defers", () => {
    for (const notYet of ["campaigns", "conversions", "tracking", "finance", "coupons"]) {
      assert.ok(!listProbeSourceObjects("trackier").includes(notYet), notYet);
    }
  });

  it("has an adapter builder registered under its own name", () => {
    assert.match(codeOf(SERVICE_SRC), /trackier: "buildTrackierAdapter"/);
  });

  it("keeps every previously registered network intact", () => {
    for (const network of ["optimise", "partnerize", "awin", "cj", "admitad", "rakuten"]) {
      assert.ok(listProbeNetworks().includes(network), network);
      assert.ok(listProbeSourceObjects(network).length > 0, network);
    }
  });

  it("is catalogued as a live publisher endpoint", () => {
    const entry = getSourceObject("trackier", "profile");
    assert.ok(entry);
    assert.equal(entry.endpoint, "GET /v2/publishers/profile");
    assert.equal(entry.live, true);
  });
});

describe("the documented profile request contract", () => {
  it("addresses exactly GET /v2/publishers/profile", async () => {
    assert.equal(TRACKIER_PROFILE_PATH, "/v2/publishers/profile");
    const spy = spyHttp();
    await adapterWith(spy).fetchProfile();
    assert.equal(spy.calls[0].path, "/v2/publishers/profile");
  });

  it("is a GET, and the endpointKey names it", async () => {
    const row = (await certifyProfile(adapterWith(spyHttp()))).results[0];
    assert.equal(row.httpMethod, "GET");
    assert.equal(row.endpointKey, "GET /v2/publishers/profile");
    assert.equal(row.sourceObject, "profile");
  });

  it("authenticates with X-Api-Key and nothing else", () => {
    // The header is set once, at adapter construction, from the resolved credential.
    const code = codeOf(ADAPTER_SRC);
    assert.match(code, /"X-Api-Key": String\(apiKey\)/);
    assert.ok(!code.includes("Authorization"));
    assert.ok(!code.includes("Bearer"));
  });

  it("sends no query parameters: a profile is one object, with nothing to bound", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchProfile();
    assert.equal(spy.calls[0].config.params, undefined);
    const serialised = JSON.stringify(spy.calls[0].config);
    for (const bound of ["limit", "page", "offset", "max"]) {
      assert.ok(!serialised.includes(bound), bound);
    }
  });

  it("carries a bounded timeout through the certification chain", async () => {
    const spy = spyHttp();
    await certifyProfile(adapterWith(spy));
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
  });

  it("resolves the API key the way the sync job does", () => {
    const code = codeOf(CREDENTIALS_SRC);
    const sync = codeOf(SYNC_SRC);
    for (const source of [
      'getMarketplaceApiKey("trackier"',
      'getOAuthAccessToken("trackier"',
      "process.env.VCOMMISSION_API_KEY",
    ]) {
      assert.ok(code.includes(source), `certification: ${source}`);
      assert.ok(sync.includes(source), `sync: ${source}`);
    }
  });

  it("accepts no key, host or path from a caller", () => {
    const builder = codeOf(SERVICE_SRC)
      .split("async buildTrackierAdapter")[1]
      .split("\n  }")[0];
    for (const leak of ["options.apiKey", "params.apiKey", "baseURL", "req.body", "req.query"]) {
      assert.ok(!builder.includes(leak), leak);
    }
    assert.match(builder, /this\.trackierCredentialResolver\(accountLabel\)/);
  });

  it("refuses to build an adapter when no key is configured, without saying anything about it", async () => {
    const spy = spyHttp();
    await assert.rejects(
      () => certifyProfile(adapterWith(spy), { apiKey: null }),
      (error) => Number(error?.statusCode ?? error?.status) === 424,
    );
    assert.equal(spy.calls.length, 0, "the refusal costs no supplier call");
  });
});

describe("exactly one request, no retry, no pagination", () => {
  it("issues exactly one supplier request", async () => {
    const spy = spyHttp();
    await certifyProfile(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a failed request", async () => {
    // Production allows six attempts. Certification pins it to one.
    const spy = spyHttp(new Error("zzsupplierfailurezz"));
    await certifyProfile(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("does not retry a retryable status either", async () => {
    // 503 is on requestWithRetry's retry list, so this is the case a retries seam must actually
    // suppress rather than merely appear to.
    const error = new Error("zzupstreamzz");
    error.response = { status: 503, data: {} };
    const spy = spyHttp(error);
    await certifyProfile(adapterWith(spy));
    assert.equal(spy.calls.length, 1);
  });

  it("pins the attempt count in the chain, and leaves production's alone", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierProfile")[1]
      .split("\n  }")[0];
    assert.match(chain, /retries: 1/);
    // Production's own default is untouched, and fetchProfile() with no argument still gets it.
    assert.match(codeOf(ADAPTER_SRC), /retries: 6, delayMs: 2000/);
    assert.match(codeOf(SYNC_SRC), /adapter\.fetchProfile\(\)/);
  });

  it("walks no pages", () => {
    const adapter = codeOf(ADAPTER_SRC)
      .split("fetchProfile({ retries, timeoutMs } = {})")[1]
      .split("fetchCategories")[0];
    assert.ok(!/for\s*\(|while\s*\(/.test(adapter));
    assert.ok(!adapter.includes("fetchCampaignPages"));
    assert.equal((adapter.match(/httpClient\.get\(/g) ?? []).length, 1);
  });
});

describe("the existing adapter and fetcher are reused", () => {
  it("calls production's own fetchProfile", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierProfile")[1]
      .split("\n  }")[0];
    assert.match(chain, /adapter\.fetchProfile\(/);
    // No parallel client and no second path literal.
    assert.ok(!chain.includes("createHttpClient"));
    assert.ok(!chain.includes("httpClient.get"));
    assert.ok(!chain.includes("/v2/publishers"));
  });

  it("builds the adapter with production's own factory", () => {
    const builder = codeOf(SERVICE_SRC)
      .split("async buildTrackierAdapter")[1]
      .split("\n  }")[0];
    assert.match(builder, /createTrackierAdapter/);
    assert.match(codeOf(SERVICE_SRC), /import \{ createTrackierAdapter \} from "\.\.\/\.\.\/adapters\/trackier\.adapter\.js"/);
  });

  it("keeps the header, rate limiter and profile unwrapping in the adapter's one place", () => {
    const fetchProfile = codeOf(ADAPTER_SRC)
      .split("fetchProfile({ retries, timeoutMs } = {})")[1]
      .split("fetchCategories")[0];
    assert.match(fetchProfile, /requestWithRateLimit\(/);
    assert.match(fetchProfile, /unwrapProfile\(res\.data\)/);
    assert.match(fetchProfile, /TRACKIER_PROFILE_PATH/);
  });

  it("leaves fetchProfile() with no argument behaving exactly as before", async () => {
    const spy = spyHttp();
    await adapterWith(spy).fetchProfile();
    // No timeout and no retry override: production's defaults, unchanged.
    assert.deepEqual(spy.calls[0].config, {});
  });

  it("unwraps the profile envelope, and reads a bare body too", async () => {
    const wrapped = spyHttp({ profile: PROFILE });
    assert.equal((await adapterWith(wrapped).fetchProfile()).id, "zzpublisheridzz");
    const bare = spyHttp({ data: PROFILE });
    assert.equal((await adapterWith(bare).fetchProfile()).id, "zzpublisheridzz");
  });
});

describe("the profile outcome vocabulary", () => {
  it("reports OK with a structural field dictionary", async () => {
    const row = (await certifyProfile(adapterWith(spyHttp()))).results[0];
    assert.equal(row.ok, true);
    assert.equal(row.statusCategory, "OK");
    assert.equal(row.sampleCount, 1);
    assert.ok(row.fieldCount > 0);
    assert.equal(row.fieldCount, row.fieldPaths.length);

    const paths = row.fieldPaths.map((f) => f.path);
    for (const expected of ["id", "name", "email", "address", "address.city", "currency"]) {
      assert.ok(paths.includes(expected), expected);
    }
  });

  it("describes each path structurally and carries no key that could hold a value", async () => {
    const row = (await certifyProfile(adapterWith(spyHttp()))).results[0];
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

  it("treats a profile as ONE object, never a collection", async () => {
    const row = (await certifyProfile(adapterWith(spyHttp()))).results[0];
    assert.equal(row.sampleCount, 1);
    // Nested address is an object; nothing is reported as an array.
    const byPath = Object.fromEntries(row.fieldPaths.map((f) => [f.path, f]));
    assert.equal(byPath.address.observedType, "OBJECT");
    for (const field of row.fieldPaths) assert.equal(field.arrayObserved, false, field.path);
  });

  it("reports OK_NO_ROWS with UNKNOWN_NEEDS_LIVE_DATA for an empty profile", async () => {
    for (const empty of [{ profile: {} }, {}, null]) {
      const row = (await certifyProfile(adapterWith(spyHttp(empty)))).results[0];
      assert.equal(row.ok, true, JSON.stringify(empty));
      assert.equal(row.statusCategory, "OK_NO_ROWS", JSON.stringify(empty));
      assert.equal(row.schema, "UNKNOWN_NEEDS_LIVE_DATA", JSON.stringify(empty));
      assert.equal(row.sampleCount, 0);
      assert.equal(row.fieldCount, 0);
      assert.deepEqual(row.fieldPaths, []);
    }
  });

  it("invents no account-state finding from an empty profile", async () => {
    const serialised = JSON.stringify(await certifyProfile(adapterWith(spyHttp({ profile: {} }))));
    for (const invented of ["NOT_SUPPORTED", "UNSUPPORTED", "accountStateBlocker", "NO_JOINED"]) {
      assert.ok(!serialised.includes(invented), invented);
    }
  });

  it("preserves an auth rejection safely", async () => {
    const error = new Error("zzupstreamauthmessagezz");
    error.response = { status: 401, data: { message: "zzupstreambodyzz" } };
    const row = (await certifyProfile(adapterWith(spyHttp(error)))).results[0];
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
    const row = (await certifyProfile(adapterWith(spyHttp(error)))).results[0];
    assert.equal(row.statusCategory, "REQUEST_REJECTED");
    assert.equal(row.supplierStatusCode, 400);
  });
});

describe("nothing identifying can leak", () => {
  it("never returns the publisher id or name", async () => {
    const serialised = JSON.stringify(await certifyProfile(adapterWith(spyHttp())));
    for (const secret of ["zzpublisheridzz", "zzpubidzz", "zzpublishernamezz"]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the email, phone or address", async () => {
    const serialised = JSON.stringify(await certifyProfile(adapterWith(spyHttp())));
    for (const secret of [
      "zzpublisher@zzmailzz.example",
      "zzmailzz",
      "zzphonenumberzz",
      "zzaddresslinezz",
      "zzcityzz",
      "zzcountryzz",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("never returns the API key or the raw supplier response", async () => {
    const serialised = JSON.stringify(await certifyProfile(adapterWith(spyHttp())));
    for (const secret of [
      API_KEY,
      "X-Api-Key",
      "zzstatuszz",
      "SGD",
      "2031-03-17",
      "profile\":{",
    ]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("returns only the safe result keys", async () => {
    const row = (await certifyProfile(adapterWith(spyHttp()))).results[0];
    for (const forbidden of ["rows", "profile", "body", "raw", "data", "sample", "headers"]) {
      assert.ok(!Object.hasOwn(row, forbidden), forbidden);
    }
    for (const expected of [
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

  it("registers the API key for redaction at construction", () => {
    const builder = codeOf(SERVICE_SRC)
      .split("async buildTrackierAdapter")[1]
      .split("\n  }")[0];
    assert.match(builder, /recordRedactionValues\(/);
    assert.match(builder, /\[credentials\.apiKey\]/);
  });
});

describe("read-only, and no sync behaviour changed", () => {
  it("performs no database read or write", async () => {
    // The injected prisma throws on any rawPayload access; reaching OK proves none happened.
    assert.equal((await certifyProfile(adapterWith(spyHttp()))).results[0].statusCategory, "OK");
  });

  it("writes nothing in the chain that certifies this object", () => {
    const chain = codeOf(SERVICE_SRC)
      .split("async certifyTrackierProfile")[1]
      .split("\n  }")[0];
    for (const write of ["prisma.", "upsert", "create", "update", "delete"]) {
      assert.ok(!chain.includes(write), write);
    }
  });

  it("changes no sync source object or fetcher", () => {
    const sync = codeOf(SYNC_SRC);
    assert.ok(!sync.includes("fetchCertificationSample"));
    assert.ok(!sync.includes("NetworkCertificationService"));
    // The sync still reads the profile through production's own zero-argument call.
    assert.match(sync, /adapter\.fetchProfile\(\)/);
  });

  it("adds no second Trackier fetcher", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.equal((code.match(/fetchProfile\(/g) ?? []).length, 1);
    assert.equal((code.match(/\/v2\/publishers\/profile/g) ?? []).length, 1);
  });

  it("leaves every other Trackier capability declaration unchanged", () => {
    const caps = adapterWith(spyHttp()).getCapabilities();
    assert.deepEqual([...caps.capabilities].sort(), [
      "CAMPAIGNS",
      "CONVERSIONS",
      "COUPONS",
      "REPORTING",
      "TRACKING_SUBID",
    ]);
    assert.ok(caps.notes.some((note) => note.includes("vCommission")));
  });
});
