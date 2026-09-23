import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, beforeEach } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { SUPPORTED_PLATFORMS, buildMarketplaceAccountData } = await import(
  "../src/controllers/marketplaceAccounts.controller.js"
);
const { CLIENT_CREDENTIALS_AUTH_TYPE } = await import("../src/modules/integrations/oauth.service.js");
const { resetAdmitadTokenCache, resolveAdmitadAccessToken } = await import(
  "../src/modules/integrations/admitadTokenProvider.js"
);

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const OAUTH_SRC = codeOf(readFileSync("src/modules/integrations/oauth.service.js", "utf8"));
const SYNC_CONTROLLER_SRC = codeOf(readFileSync("src/controllers/sync.controller.js", "utf8"));
const WAVE_E_SRC = codeOf(readFileSync("src/jobs/waveESupplierSync.js", "utf8"));
const CJ_SYNC_SRC = codeOf(readFileSync("src/jobs/cjSupplierSync.js", "utf8"));
const CJ_CRED_SRC = codeOf(readFileSync("src/modules/integrations/cjCredentials.js", "utf8"));

describe("connect endpoint — every synced network is connectable", () => {
  it("accepts all nine networks (Optimise as three regional accounts)", () => {
    for (const platform of [
      "boostiny",
      "optimise_sea",
      "optimise_mena",
      "optimise_uk",
      "trackier",
      "partnerize",
      "impact",
      "awin",
      "admitad",
      "cj",
      "rakuten",
    ]) {
      assert.ok(SUPPORTED_PLATFORMS.has(platform), platform);
    }
  });

  it("rejects an unknown platform", () => {
    assert.match(buildMarketplaceAccountData("vcommission", { apiKey: "k" }).error, /Unsupported platform/);
  });
});

describe("connect endpoint — per-network validation and storage", () => {
  it("Boostiny and Trackier store the API key only", () => {
    for (const platform of ["boostiny", "trackier"]) {
      const data = buildMarketplaceAccountData(platform, { apiKey: "  secret-key-123  " });
      assert.equal(data.error, undefined);
      assert.equal(data.primarySecret, "secret-key-123");
      assert.equal(data.secondarySecret, null);
      assert.equal(data.authType, "api_key");
      assert.equal(buildMarketplaceAccountData(platform, {}).error, "Missing apiKey");
    }
  });

  it("Optimise keeps its existing contract (agency + contact required, messages unchanged)", () => {
    const data = buildMarketplaceAccountData("optimise_mena", { apiKey: "k-123456789", agencyId: "172", contactId: "9" });
    assert.equal(data.agencyId, "172");
    assert.equal(data.contactId, "9");
    assert.equal(data.primarySecret, "k-123456789");
    assert.equal(
      buildMarketplaceAccountData("optimise_uk", { apiKey: "k" }).error,
      "Missing optimise agencyId/contactId for optimise_uk",
    );
    assert.equal(buildMarketplaceAccountData("optimise_sea", { agencyId: "118", contactId: "1" }).error, "Missing apiKey");
  });

  it("Partnerize takes both keys (or the older a:b form) and an optional publisher id", () => {
    const split = buildMarketplaceAccountData("partnerize", { applicationKey: "app", userApiKey: "user", publisherId: "p1" });
    assert.deepEqual([split.primarySecret, split.secondarySecret, split.accountExternalId], ["app", "user", "p1"]);
    const legacy = buildMarketplaceAccountData("partnerize", { apiKey: "app:user" });
    assert.deepEqual([legacy.primarySecret, legacy.secondarySecret, legacy.accountExternalId], ["app", "user", null]);
    assert.match(buildMarketplaceAccountData("partnerize", { applicationKey: "app" }).error, /requires both/);
  });

  it("Impact stores the Account SID and the Auth Token as two secrets", () => {
    const data = buildMarketplaceAccountData("impact", { accountSid: "IRabc123", authToken: "tok-987654321" });
    assert.equal(data.primarySecret, "IRabc123");
    assert.equal(data.secondarySecret, "tok-987654321");
    assert.equal(data.accountExternalId, "IRabc123");
    const legacy = buildMarketplaceAccountData("impact", { apiKey: "IRabc123:tok-987654321" });
    assert.deepEqual([legacy.primarySecret, legacy.secondarySecret], ["IRabc123", "tok-987654321"]);
    assert.match(buildMarketplaceAccountData("impact", { apiKey: "only-a-sid" }).error, /Account SID and Auth Token/);
  });

  it("Awin needs the token and a numeric Publisher ID", () => {
    const data = buildMarketplaceAccountData("awin", { apiKey: "awin-token-abcdef", publisherId: "123456" });
    assert.equal(data.primarySecret, "awin-token-abcdef");
    assert.equal(data.accountExternalId, "123456");
    assert.match(buildMarketplaceAccountData("awin", { apiKey: "t" }).error, /Publisher ID/);
    assert.match(buildMarketplaceAccountData("awin", { publisherId: "1" }).error, /API token/);
    assert.match(buildMarketplaceAccountData("awin", { apiKey: "t", publisherId: "12a" }).error, /numeric/);
    assert.equal(buildMarketplaceAccountData("awin", { apiKey: "t-123456789", publisherId: 123456 }).accountExternalId, "123456");
  });

  it("Admitad stores client credentials under their own auth type, or an issued token", () => {
    const creds = buildMarketplaceAccountData("admitad", { clientId: "cid", clientSecret: "csecret-1234", scope: "advcampaigns coupons" });
    assert.equal(creds.authType, CLIENT_CREDENTIALS_AUTH_TYPE);
    assert.equal(creds.accountExternalId, "cid");
    assert.equal(creds.primarySecret, "csecret-1234");
    assert.equal(creds.scope, "advcampaigns coupons");
    const token = buildMarketplaceAccountData("admitad", { apiKey: "issued-token-123" });
    assert.equal(token.authType, "api_key");
    assert.equal(token.primarySecret, "issued-token-123");
    assert.match(buildMarketplaceAccountData("admitad", { clientId: "cid" }).error, /Client ID and Client Secret/);
    assert.match(buildMarketplaceAccountData("admitad", {}).error, /Client ID and Client Secret/);
  });

  it("CJ needs the token, the company CID and the website PID (both numeric)", () => {
    const data = buildMarketplaceAccountData("cj", { apiKey: "cj-pat-123456", companyId: "7654321", websiteId: "100200" });
    assert.equal(data.primarySecret, "cj-pat-123456");
    assert.equal(data.accountExternalId, "7654321");
    assert.equal(data.contactId, "100200");
    assert.match(buildMarketplaceAccountData("cj", { apiKey: "t", companyId: "1" }).error, /Website ID/);
    assert.match(buildMarketplaceAccountData("cj", { companyId: "1", websiteId: "2" }).error, /Personal Access Token/);
    assert.match(buildMarketplaceAccountData("cj", { apiKey: "t", companyId: "x1", websiteId: "2" }).error, /numeric/);
  });

  it("Rakuten needs the access token; security token and SID are optional", () => {
    const full = buildMarketplaceAccountData("rakuten", { apiKey: "rk-token-1234", securityToken: "sec-token-5678", publisherId: "3456789" });
    assert.deepEqual([full.primarySecret, full.secondarySecret, full.accountExternalId], ["rk-token-1234", "sec-token-5678", "3456789"]);
    const minimal = buildMarketplaceAccountData("rakuten", { apiKey: "rk-token-1234" });
    assert.deepEqual([minimal.secondarySecret, minimal.accountExternalId], [null, null]);
    assert.match(buildMarketplaceAccountData("rakuten", {}).error, /access token/);
  });

  it("never puts a raw secret in the masked value", () => {
    const cases = [
      ["awin", { apiKey: "awin-secret-token-value", publisherId: "1" }, ["awin-secret-token-value"]],
      ["impact", { accountSid: "IRsidvalue123", authToken: "impact-auth-token-value" }, ["impact-auth-token-value"]],
      ["admitad", { clientId: "cid", clientSecret: "admitad-client-secret" }, ["admitad-client-secret"]],
      ["rakuten", { apiKey: "rakuten-access-token", securityToken: "rakuten-security-token" }, ["rakuten-access-token", "rakuten-security-token"]],
    ];
    for (const [platform, body, secrets] of cases) {
      const { maskedKey } = buildMarketplaceAccountData(platform, body);
      for (const secret of secrets) assert.ok(!maskedKey.includes(secret), `${platform} leaks in ${maskedKey}`);
    }
  });

  it("rejects over-long identifiers", () => {
    assert.match(buildMarketplaceAccountData("cj", { apiKey: "t", companyId: "1".repeat(21), websiteId: "2" }).error, /numeric|too long/);
    assert.match(buildMarketplaceAccountData("partnerize", { apiKey: "a:b", publisherId: "p".repeat(200) }).error, /too long/);
  });
});

describe("syncs read what the connect endpoint saves", () => {
  it("a client secret is never handed out as a bearer API key", () => {
    assert.match(OAUTH_SRC, /authType === CLIENT_CREDENTIALS_AUTH_TYPE\) return null/);
  });

  it("Impact reads the saved Auth Token (second secret)", () => {
    assert.match(WAVE_E_SRC, /getMarketplaceRefreshToken\("impact", accountLabel\)/);
  });

  it("CJ sync and certification fall back to the saved company CID and website ID", () => {
    for (const src of [CJ_SYNC_SRC, CJ_CRED_SRC]) {
      assert.match(src, /getMarketplaceAccountIdentifiers\("cj", accountLabel\)/);
      assert.match(src, /ids\?\.accountExternalId/);
      assert.match(src, /ids\?\.contactId/);
    }
  });

  it("a saved Admitad / CJ / Rakuten account rolls up to its network on Network Accounts", async () => {
    const { supplierKeyFromPlatform, platformsForSupplier, entitySourcesForSupplier } = await import(
      "../src/modules/ops/networkOps.contract.js"
    );
    for (const [platform, key] of [["admitad", "ADMITAD"], ["cj", "CJ"], ["rakuten", "RAKUTEN"], ["awin", "AWIN"]]) {
      assert.equal(supplierKeyFromPlatform(platform), key);
      assert.deepEqual(platformsForSupplier(key), [platform]);
      assert.deepEqual(entitySourcesForSupplier(key), [platform]);
    }
  });

  it("manual sync accepts Admitad, CJ and Rakuten", () => {
    for (const platform of ["admitad", "cj", "rakuten"]) {
      assert.match(SYNC_CONTROLLER_SRC, new RegExp(`"${platform}",`));
    }
  });
});

describe("Admitad — saved client credentials are exchanged for a token", () => {
  beforeEach(() => resetAdmitadTokenCache());

  function spyPost() {
    const calls = [];
    return {
      calls,
      post: async (url, body, config) => {
        calls.push({ url, body, config });
        return { data: { access_token: "zzmintedzz", expires_in: 3600 } };
      },
    };
  }

  it("uses the saved client id + secret and the saved scope", async () => {
    const spy = spyPost();
    const token = await resolveAdmitadAccessToken("default", {
      env: {},
      transport: spy.post,
      readStoredClientCredentials: async () => ({ clientId: "savedid", clientSecret: "savedsecret", scope: "savedscope" }),
    });
    assert.equal(token, "zzmintedzz");
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0].config.headers.Authorization, `Basic ${Buffer.from("savedid:savedsecret").toString("base64")}`);
    const body = new URLSearchParams(spy.calls[0].body);
    assert.equal(body.get("client_id"), "savedid");
    assert.equal(body.get("scope"), "savedscope");
  });

  it("falls back to the deployment scope when the account saved none", async () => {
    const spy = spyPost();
    await resolveAdmitadAccessToken("default", {
      env: { ADMITAD_OAUTH_SCOPE: "envscope" },
      transport: spy.post,
      readStoredClientCredentials: async () => ({ clientId: "savedid", clientSecret: "savedsecret", scope: null }),
    });
    assert.equal(new URLSearchParams(spy.calls[0].body).get("scope"), "envscope");
  });

  it("an explicit ADMITAD_ACCESS_TOKEN still wins over saved credentials", async () => {
    const spy = spyPost();
    const token = await resolveAdmitadAccessToken("default", {
      env: { ADMITAD_ACCESS_TOKEN: "override" },
      transport: spy.post,
      readStoredClientCredentials: async () => ({ clientId: "savedid", clientSecret: "savedsecret", scope: "s" }),
    });
    assert.equal(token, "override");
    assert.equal(spy.calls.length, 0);
  });

  it("returns null when nothing is saved or configured", async () => {
    const token = await resolveAdmitadAccessToken("default", {
      env: {},
      transport: spyPost().post,
      readStoredClientCredentials: async () => null,
    });
    assert.equal(token, null);
  });
});
