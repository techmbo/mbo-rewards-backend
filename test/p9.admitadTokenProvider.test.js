import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, beforeEach } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const {
  ADMITAD_TOKEN_URL_DEFAULT,
  ADMITAD_TOKEN_EXPIRY_MARGIN_MS,
  ADMITAD_TOKEN_FALLBACK_TTL_MS,
  acquireAdmitadClientCredentialsToken,
  hasAdmitadClientCredentials,
  readAdmitadOAuthConfig,
  resetAdmitadTokenCache,
  resolveAdmitadAccessToken,
} = await import("../src/modules/integrations/admitadTokenProvider.js");
const { resolveAdmitadCertificationCredentials } = await import(
  "../src/modules/integrations/admitadCredentials.js"
);

const PROVIDER_SRC = readFileSync("src/modules/integrations/admitadTokenProvider.js", "utf8");
const CREDENTIALS_SRC = readFileSync("src/modules/integrations/admitadCredentials.js", "utf8");
const SYNC_SRC = readFileSync("src/jobs/admitadSupplierSync.js", "utf8");
const ADAPTER_SRC = readFileSync("src/adapters/admitad.adapter.js", "utf8");

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const CLIENT_ID = "zzclientidzz";
const CLIENT_SECRET = "zzclientsecretzz";
const SCOPE = "zzscopezz";
const MINTED = "zzmintedtokenzz";
const OVERRIDE = "zzoverridetokenzz";

const EXPECTED_BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;

function env(extra = {}) {
  return {
    ADMITAD_CLIENT_ID: CLIENT_ID,
    ADMITAD_CLIENT_SECRET: CLIENT_SECRET,
    ADMITAD_OAUTH_SCOPE: SCOPE,
    ...extra,
  };
}

/** One call recorder standing in for axios.post. */
function spyPost(responseOrError = { data: { access_token: MINTED, expires_in: 3600 } }) {
  const calls = [];
  return {
    calls,
    post: async (url, body, config) => {
      calls.push({ url, body, config });
      if (responseOrError instanceof Error) throw responseOrError;
      return typeof responseOrError === "function" ? responseOrError(calls.length) : responseOrError;
    },
  };
}

/** A clock the test drives, so expiry is proven rather than waited for. */
function clock(start = 1_000_000) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms) => (state.t += ms), state };
}

beforeEach(() => resetAdmitadTokenCache());

describe("configuration is read from the documented env vars", () => {
  it("defaults the token URL to the documented endpoint", () => {
    assert.equal(ADMITAD_TOKEN_URL_DEFAULT, "https://api.admitad.com/token/");
    assert.equal(readAdmitadOAuthConfig(env()).tokenUrl, "https://api.admitad.com/token/");
  });

  it("lets ADMITAD_OAUTH_TOKEN_URL override the default", () => {
    const config = readAdmitadOAuthConfig(env({ ADMITAD_OAUTH_TOKEN_URL: "https://alt.test/t/" }));
    assert.equal(config.tokenUrl, "https://alt.test/t/");
  });

  it("reads id, secret and scope from their own variables", () => {
    const config = readAdmitadOAuthConfig(env());
    assert.equal(config.clientId, CLIENT_ID);
    assert.equal(config.clientSecret, CLIENT_SECRET);
    assert.equal(config.scope, SCOPE);
  });

  it("treats id and secret together as the exchange precondition, scope separately", () => {
    assert.equal(hasAdmitadClientCredentials(readAdmitadOAuthConfig(env())), true);
    assert.equal(
      hasAdmitadClientCredentials(readAdmitadOAuthConfig(env({ ADMITAD_OAUTH_SCOPE: "" }))),
      true,
    );
    assert.equal(
      hasAdmitadClientCredentials(readAdmitadOAuthConfig(env({ ADMITAD_CLIENT_SECRET: "" }))),
      false,
    );
  });

  it("configures no separate Base64 header variable", () => {
    const code = codeOf(PROVIDER_SRC);
    assert.ok(!code.includes("ADMITAD_BASIC"));
    assert.ok(!code.includes("ADMITAD_AUTHORIZATION"));
    assert.ok(!code.includes("ADMITAD_BASE64"));
  });
});

describe("the token request matches the documented contract", () => {
  it("POSTs to the configured token endpoint", async () => {
    const spy = spyPost();
    await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post });
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].url, "https://api.admitad.com/token/");
  });

  it("POSTs to an overridden endpoint when one is configured", async () => {
    const spy = spyPost();
    await acquireAdmitadClientCredentialsToken({
      env: env({ ADMITAD_OAUTH_TOKEN_URL: "https://alt.test/token/" }),
      transport: spy.post,
    });
    assert.equal(spy.calls[0].url, "https://alt.test/token/");
  });

  it("derives the Basic header internally from id and secret", async () => {
    const spy = spyPost();
    await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post });
    assert.equal(spy.calls[0].config.headers.Authorization, EXPECTED_BASIC);
  });

  it("sends the secret only inside the Basic header, never in the body", async () => {
    const spy = spyPost();
    await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post });
    assert.ok(!String(spy.calls[0].body).includes(CLIENT_SECRET));
  });

  it("sends a form-encoded body with grant_type, client_id and scope", async () => {
    const spy = spyPost();
    await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post });
    assert.equal(spy.calls[0].config.headers["Content-Type"], "application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(spy.calls[0].body));
    assert.equal(body.get("grant_type"), "client_credentials");
    assert.equal(body.get("client_id"), CLIENT_ID);
    assert.equal(body.get("scope"), SCOPE);
  });

  it("sends no authorization_code fields", async () => {
    const spy = spyPost();
    await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post });
    const body = new URLSearchParams(String(spy.calls[0].body));
    assert.equal(body.get("code"), null);
    assert.equal(body.get("redirect_uri"), null);
    assert.equal(body.get("client_secret"), null);
  });

  it("bounds the token request with a timeout", async () => {
    const spy = spyPost();
    await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post });
    assert.ok(Number(spy.calls[0].config.timeout) > 0);
  });

  it("returns the minted access token", async () => {
    const spy = spyPost();
    const token = await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post });
    assert.equal(token, MINTED);
  });
});

describe("the token is cached until expiry, with a safety margin", () => {
  it("makes one request for repeated calls inside the token's life", async () => {
    const spy = spyPost();
    const time = clock();
    const options = { env: env(), transport: spy.post, now: time.now };
    assert.equal(await acquireAdmitadClientCredentialsToken(options), MINTED);
    assert.equal(await acquireAdmitadClientCredentialsToken(options), MINTED);
    assert.equal(await acquireAdmitadClientCredentialsToken(options), MINTED);
    assert.equal(spy.calls.length, 1);
  });

  it("re-mints once the cached token has expired", async () => {
    let minted = 0;
    const spy = spyPost(() => ({ data: { access_token: `${MINTED}${++minted}`, expires_in: 3600 } }));
    const time = clock();
    const options = { env: env(), transport: spy.post, now: time.now };

    assert.equal(await acquireAdmitadClientCredentialsToken(options), `${MINTED}1`);
    time.advance(3600 * 1000 + 1);
    assert.equal(await acquireAdmitadClientCredentialsToken(options), `${MINTED}2`);
    assert.equal(spy.calls.length, 2);
  });

  it("re-mints inside the safety margin, before the token actually dies", async () => {
    const spy = spyPost();
    const time = clock();
    const options = { env: env(), transport: spy.post, now: time.now };

    await acquireAdmitadClientCredentialsToken(options);
    // One millisecond past the margin boundary: still a live token upstream, already re-minted here.
    time.advance(3600 * 1000 - ADMITAD_TOKEN_EXPIRY_MARGIN_MS + 1);
    await acquireAdmitadClientCredentialsToken(options);
    assert.equal(spy.calls.length, 2);
  });

  it("still serves the cache one millisecond before the margin boundary", async () => {
    const spy = spyPost();
    const time = clock();
    const options = { env: env(), transport: spy.post, now: time.now };

    await acquireAdmitadClientCredentialsToken(options);
    time.advance(3600 * 1000 - ADMITAD_TOKEN_EXPIRY_MARGIN_MS - 1);
    await acquireAdmitadClientCredentialsToken(options);
    assert.equal(spy.calls.length, 1);
  });

  it("applies a bounded fallback lifetime when expires_in is absent", async () => {
    const spy = spyPost({ data: { access_token: MINTED } });
    const time = clock();
    const options = { env: env(), transport: spy.post, now: time.now };

    await acquireAdmitadClientCredentialsToken(options);
    time.advance(ADMITAD_TOKEN_FALLBACK_TTL_MS - ADMITAD_TOKEN_EXPIRY_MARGIN_MS - 1);
    await acquireAdmitadClientCredentialsToken(options);
    assert.equal(spy.calls.length, 1);

    time.advance(2);
    await acquireAdmitadClientCredentialsToken(options);
    assert.equal(spy.calls.length, 2);
  });

  it("does not cache a token whose life is shorter than the safety margin", async () => {
    const spy = spyPost({ data: { access_token: MINTED, expires_in: 1 } });
    const time = clock();
    const options = { env: env(), transport: spy.post, now: time.now };

    await acquireAdmitadClientCredentialsToken(options);
    await acquireAdmitadClientCredentialsToken(options);
    assert.equal(spy.calls.length, 2);
  });

  it("does not serve a token minted under a different scope", async () => {
    const spy = spyPost();
    const time = clock();
    await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post, now: time.now });
    await acquireAdmitadClientCredentialsToken({
      env: env({ ADMITAD_OAUTH_SCOPE: "zzotherscopezz" }),
      transport: spy.post,
      now: time.now,
    });
    assert.equal(spy.calls.length, 2);
  });

  it("does not serve a token minted under a different client id or endpoint", async () => {
    const time = clock();
    const spy = spyPost();
    await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post, now: time.now });
    await acquireAdmitadClientCredentialsToken({
      env: env({ ADMITAD_CLIENT_ID: "zzotheridzz" }),
      transport: spy.post,
      now: time.now,
    });
    await acquireAdmitadClientCredentialsToken({
      env: env({ ADMITAD_OAUTH_TOKEN_URL: "https://alt.test/token/" }),
      transport: spy.post,
      now: time.now,
    });
    assert.equal(spy.calls.length, 3);
  });

  it("keeps the cache in memory only", () => {
    const code = codeOf(PROVIDER_SRC);
    for (const persisted of ["prisma", "localStorage", "writeFile", "redis", "upsert"]) {
      assert.ok(!code.includes(persisted), persisted);
    }
  });
});

describe("configuration failures happen before any supplier call", () => {
  it("fails clearly when the scope is missing, without a request", async () => {
    const spy = spyPost();
    await assert.rejects(
      () =>
        acquireAdmitadClientCredentialsToken({
          env: env({ ADMITAD_OAUTH_SCOPE: "" }),
          transport: spy.post,
        }),
      (error) => /ADMITAD_OAUTH_SCOPE/.test(error.message) && Number(error.statusCode) === 424,
    );
    assert.equal(spy.calls.length, 0);
  });

  it("fails without a request when the client credentials are missing", async () => {
    const spy = spyPost();
    await assert.rejects(
      () =>
        acquireAdmitadClientCredentialsToken({
          env: { ADMITAD_OAUTH_SCOPE: SCOPE },
          transport: spy.post,
        }),
      (error) => Number(error.statusCode) === 424,
    );
    assert.equal(spy.calls.length, 0);
  });

  it("does not cache anything after a configuration failure", async () => {
    const spy = spyPost();
    await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post });
    await assert.rejects(() =>
      acquireAdmitadClientCredentialsToken({
        env: env({ ADMITAD_OAUTH_SCOPE: "" }),
        transport: spy.post,
      }),
    );
    assert.equal(spy.calls.length, 1);
  });
});

describe("a bad token response fails safely", () => {
  it("rejects a response with no access_token", async () => {
    const spy = spyPost({ data: { token_type: "Bearer", expires_in: 3600 } });
    await assert.rejects(
      () => acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post }),
      (error) => /access_token/.test(error.message) && Number(error.statusCode) === 424,
    );
  });

  it("rejects a non-string or blank access_token", async () => {
    for (const bad of [{ access_token: 12345 }, { access_token: "   " }, {}, null]) {
      const spy = spyPost({ data: bad });
      await assert.rejects(() =>
        acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post }),
      );
    }
  });

  it("caches nothing after a malformed response", async () => {
    const spy = spyPost({ data: {} });
    await assert.rejects(() =>
      acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post }),
    );
    await assert.rejects(() =>
      acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post }),
    );
    assert.equal(spy.calls.length, 2);
  });

  it("carries the HTTP status forward so a rejection stays classifiable", async () => {
    const rejected = Object.assign(new Error("token rejected"), {
      response: { status: 401, data: { error: "invalid_client" } },
    });
    const spy = spyPost(rejected);
    const error = await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post })
      .then(() => null, (e) => e);
    assert.ok(error);
    assert.equal(error.response.status, 401);
    assert.equal(error.admitadTokenRequestFailed, true);
  });

  it("drops the token endpoint's own response body", async () => {
    const rejected = Object.assign(new Error(`rejected ${CLIENT_SECRET}`), {
      response: {
        status: 401,
        data: { error_description: `bad secret ${CLIENT_SECRET}` },
        headers: { "www-authenticate": `Basic realm=${CLIENT_ID}` },
      },
      config: { headers: { Authorization: EXPECTED_BASIC } },
    });
    const spy = spyPost(rejected);
    const error = await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post })
      .then(() => null, (e) => e);
    assert.ok(error);
    assert.equal(error.response.data, undefined);
    assert.equal(error.response.headers, undefined);
    assert.equal(error.config, undefined);
  });
});

describe("nothing secret leaks out of the provider", () => {
  it("leaks no credential through a rejected token request", async () => {
    const rejected = Object.assign(new Error(`rejected ${CLIENT_SECRET} ${EXPECTED_BASIC}`), {
      response: { status: 401, data: { detail: `${CLIENT_ID}:${CLIENT_SECRET}` } },
    });
    const spy = spyPost(rejected);
    const error = await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post })
      .then(() => null, (e) => e);

    const serialised = `${error.message}|${JSON.stringify(error)}|${JSON.stringify({ ...error })}`;
    for (const secret of [CLIENT_SECRET, EXPECTED_BASIC, EXPECTED_BASIC.slice(6)]) {
      assert.ok(!serialised.includes(secret), secret);
    }
  });

  it("names no credential in a configuration failure", async () => {
    const error = await acquireAdmitadClientCredentialsToken({
      env: env({ ADMITAD_OAUTH_SCOPE: "" }),
      transport: spyPost().post,
    }).then(() => null, (e) => e);
    assert.ok(!error.message.includes(CLIENT_SECRET));
    assert.ok(!error.message.includes(CLIENT_ID));
  });

  it("logs nothing at all", () => {
    const code = codeOf(PROVIDER_SRC);
    for (const logger of ["console.", "logger.", "log(", "process.stdout", "process.stderr"]) {
      assert.ok(!code.includes(logger), logger);
    }
  });

  it("never returns the derived Basic header to a caller", () => {
    const code = codeOf(PROVIDER_SRC);
    assert.match(code, /function basicAuthorizationHeader\(/);
    // Declared as a module-private function: not exported, so no caller can obtain the header.
    assert.ok(!/export\s+function basicAuthorizationHeader/.test(code));
    assert.equal(
      // eslint-disable-next-line no-undef
      typeof (globalThis.basicAuthorizationHeader),
      "undefined",
    );
  });

  it("does not export the cache or any way to read it", async () => {
    const module = await import("../src/modules/integrations/admitadTokenProvider.js");
    assert.equal(module.cache, undefined);
    // resetAdmitadTokenCache is a mutator seam, not a getter: it hands nothing back.
    assert.equal(module.resetAdmitadTokenCache(), undefined);
    // No export names a credential, and no export IS one.
    assert.ok(!Object.keys(module).some((key) => /secret|basic/i.test(key)));
    const spy = spyPost();
    await acquireAdmitadClientCredentialsToken({ env: env(), transport: spy.post });
    for (const [name, value] of Object.entries(module)) {
      if (typeof value === "function") continue;
      assert.ok(!String(value).includes(MINTED), name);
      assert.ok(!String(value).includes(CLIENT_SECRET), name);
    }
  });
});

describe("resolution order: the static override wins", () => {
  it("returns ADMITAD_ACCESS_TOKEN without minting anything", async () => {
    const spy = spyPost();
    const token = await resolveAdmitadAccessToken("default", {
      env: env({ ADMITAD_ACCESS_TOKEN: OVERRIDE }),
      transport: spy.post,
    });
    assert.equal(token, OVERRIDE);
    assert.equal(spy.calls.length, 0);
  });

  it("runs the client-credentials exchange when the static token is absent", async () => {
    const spy = spyPost();
    const token = await resolveAdmitadAccessToken("default", { env: env(), transport: spy.post });
    assert.equal(token, MINTED);
    assert.equal(spy.calls.length, 1);
  });

  it("masks the exchange entirely while the static token remains set", async () => {
    const spy = spyPost();
    await resolveAdmitadAccessToken("default", {
      env: env({ ADMITAD_ACCESS_TOKEN: OVERRIDE }),
      transport: spy.post,
    });
    await resolveAdmitadAccessToken("default", {
      env: env({ ADMITAD_ACCESS_TOKEN: OVERRIDE }),
      transport: spy.post,
    });
    assert.equal(spy.calls.length, 0);
  });

  it("returns null when neither a static token nor client credentials are configured", async () => {
    const spy = spyPost();
    const token = await resolveAdmitadAccessToken("default", { env: {}, transport: spy.post });
    assert.equal(token, null);
    assert.equal(spy.calls.length, 0);
  });

  it("keeps the static override supported rather than removed", () => {
    assert.match(codeOf(PROVIDER_SRC), /env\.ADMITAD_ACCESS_TOKEN/);
  });
});

describe("certification and production sync use the same provider", () => {
  it("both import resolveAdmitadAccessToken from the provider module", () => {
    assert.match(
      codeOf(CREDENTIALS_SRC),
      /import \{ resolveAdmitadAccessToken \} from "\.\/admitadTokenProvider\.js"/,
    );
    assert.match(
      codeOf(SYNC_SRC),
      /import \{ resolveAdmitadAccessToken \} from "\.\.\/modules\/integrations\/admitadTokenProvider\.js"/,
    );
  });

  it("neither keeps its own credential resolution chain", () => {
    for (const [label, source] of [["certification", CREDENTIALS_SRC], ["sync", SYNC_SRC]]) {
      const code = codeOf(source);
      assert.ok(!code.includes("process.env.ADMITAD_ACCESS_TOKEN"), label);
      assert.ok(!code.includes('getOAuthAccessToken("admitad"'), label);
      assert.ok(!code.includes('getMarketplaceApiKey("admitad"'), label);
    }
  });

  it("both delegate to the shared resolver", () => {
    assert.match(codeOf(CREDENTIALS_SRC), /resolveAdmitadAccessToken\(accountLabel\)/);
    assert.match(codeOf(SYNC_SRC), /resolveAdmitadAccessToken\(accountLabel\)/);
  });

  it("certification wraps the resolved token in the adapter's credential shape", async () => {
    const previous = process.env.ADMITAD_ACCESS_TOKEN;
    process.env.ADMITAD_ACCESS_TOKEN = OVERRIDE;
    try {
      assert.deepEqual(await resolveAdmitadCertificationCredentials("default"), {
        accessToken: OVERRIDE,
      });
    } finally {
      if (previous === undefined) delete process.env.ADMITAD_ACCESS_TOKEN;
      else process.env.ADMITAD_ACCESS_TOKEN = previous;
    }
  });

  it("certification reports nothing configured as null, not as a partial credential", async () => {
    const previous = process.env.ADMITAD_ACCESS_TOKEN;
    delete process.env.ADMITAD_ACCESS_TOKEN;
    try {
      assert.equal(await resolveAdmitadCertificationCredentials("default"), null);
    } finally {
      if (previous !== undefined) process.env.ADMITAD_ACCESS_TOKEN = previous;
    }
  });
});

describe("the Admitad data endpoints are untouched", () => {
  it("still presents the token as a Bearer on the data client", () => {
    assert.match(codeOf(ADAPTER_SRC), /apiKey: `Bearer \$\{accessToken\}`/);
  });

  it("keeps every data path exactly as it was", () => {
    const code = codeOf(ADAPTER_SRC);
    for (const path of [
      '"/websites/v2/"',
      '"/advcampaigns/"',
      '"/coupons/"',
      '"/statistics/actions/"',
    ]) {
      assert.ok(code.includes(path), path);
    }
  });

  it("does not make the adapter aware of the token exchange", () => {
    const code = codeOf(ADAPTER_SRC);
    assert.ok(!code.includes("client_credentials"));
    assert.ok(!code.includes("ADMITAD_CLIENT_SECRET"));
    assert.ok(!code.includes("admitadTokenProvider"));
  });
});
