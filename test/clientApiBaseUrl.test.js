/**
 * The client API base URL a client is told to integrate against.
 *
 * `/portal/v1/settings` used to report a hardcoded host with the `/api` prefix and the `/client`
 * segment missing, while `/portal/v1/api-docs` reported the real mounted path — so the platform
 * told clients two different things and the settings one pointed nowhere. Both now derive from a
 * single constant, and these tests pin that they cannot drift apart again.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, before } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const { BACKEND_URL } = await import("../src/config/urls.js");
const { PortalDashboardService } = await import(
  "../src/modules/client/services/portalDashboard.service.js"
);

const CLIENT = {
  id: "client-a",
  name: "Client A",
  slug: "client-a",
  status: "ACTIVE",
  deletedAt: null,
  currency: "USD",
  portalPreferences: {},
  deliveryMethod: "API_AND_PORTAL",
  commercialModel: null,
  clientSharePercent: null,
  agreementStatus: null,
  paymentCycle: null,
  paymentTrigger: null,
};

/** Enough of prisma for getSettings; every delegate returns an empty result. */
const prismaStub = {
  clientBankAccount: { findUnique: async () => null },
  clientTaxProfile: { findUnique: async () => null },
  clientApiCredential: { findMany: async () => [] },
  user: { findMany: async () => [] },
  clientWithdrawal: { findMany: async () => [] },
  clientCampaignAssignment: { findMany: async () => [] },
  conversion: { findMany: async () => [] },
};

function makeService() {
  return new PortalDashboardService({
    prisma: prismaStub,
    partnerCampaigns: { assertPartnerClient: async () => CLIENT },
    financeConsumer: {
      getMode: () => "LEGACY",
      compareClientEarnings: async () => ({ finance: { net: 0 }, comparison: { status: "MATCH" } }),
      resolveDisplayCommission: () => ({ approvedCommission: 0, pendingCommission: 0 }),
      recordShadowDiscrepancy: async () => {},
    },
  });
}

let settings;
let apiDocs;

before(async () => {
  const service = makeService();
  settings = await service.getSettings("client-a");
  apiDocs = await service.getApiDocs("client-a");
});

describe("client API base URL — derived from configuration", () => {
  it("derives productionBaseUrl from BACKEND_URL", () => {
    assert.ok(
      settings.api.productionBaseUrl.startsWith(BACKEND_URL),
      `expected ${settings.api.productionBaseUrl} to start with the configured BACKEND_URL`,
    );
  });

  it("points at the mounted client API path", () => {
    assert.ok(
      settings.api.productionBaseUrl.endsWith("/api/v1/client"),
      `expected ${settings.api.productionBaseUrl} to end with /api/v1/client`,
    );
  });

  it("is exactly BACKEND_URL + the client API path", () => {
    assert.equal(settings.api.productionBaseUrl, `${BACKEND_URL}/api/v1/client`);
  });

  it("carries no duplicated or missing /api segment", () => {
    const path = settings.api.productionBaseUrl.slice(BACKEND_URL.length);
    assert.equal(path, "/api/v1/client");
    assert.equal(path.match(/\/api\//g)?.length, 1, "exactly one /api segment");
  });
});

describe("client API base URL — settings and api-docs agree", () => {
  it("settings reports the api-docs canonical path, host-absolute", () => {
    assert.equal(settings.api.productionBaseUrl, `${BACKEND_URL}${apiDocs.canonicalBaseUrl}`);
  });

  it("settings ends with the api-docs baseUrl", () => {
    assert.ok(settings.api.productionBaseUrl.endsWith(apiDocs.baseUrl));
  });

  it("api-docs still reports the path host-relative", () => {
    assert.equal(apiDocs.canonicalBaseUrl, "/api/v1/client");
    assert.equal(apiDocs.baseUrl, apiDocs.canonicalBaseUrl);
  });

  it("the documented campaigns endpoint sits under the reported base", () => {
    const campaigns = apiDocs.endpoints.find((e) => e.path === "/campaigns");
    assert.ok(campaigns, "the campaigns endpoint must be documented");
    assert.equal(campaigns.fullPath, `${apiDocs.baseUrl}/campaigns`);
    assert.equal(
      `${settings.api.productionBaseUrl}/campaigns`,
      `${BACKEND_URL}${campaigns.fullPath}`,
      "following the settings base URL must reach the documented endpoint",
    );
  });
});

describe("client API base URL — no invented sandbox host", () => {
  it("reports sandboxBaseUrl as null when no sandbox backend is configured", () => {
    assert.equal(settings.api.sandboxBaseUrl, null);
  });

  it("does not substitute a string placeholder", () => {
    assert.notEqual(typeof settings.api.sandboxBaseUrl, "string");
  });
});

describe("client API base URL — no legacy host survives", () => {
  const LEGACY = ["api.mbo-rewards.com", "sandbox-api.mbo-rewards.com"];

  it("neither client payload mentions a legacy host", () => {
    const blob = JSON.stringify({ settings, apiDocs });
    for (const host of LEGACY) {
      assert.ok(!blob.includes(host), `${host} must not reach a client`);
    }
  });

  it("the portal service source carries no legacy host", () => {
    const source = readFileSync(
      new URL("../src/modules/client/services/portalDashboard.service.js", import.meta.url),
      "utf8",
    );
    for (const host of LEGACY) {
      assert.ok(!source.includes(host), `${host} must not remain in the client delivery path`);
    }
  });
});
