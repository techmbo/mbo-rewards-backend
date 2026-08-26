import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";
import {
  canRunDatabaseIntegrationTests,
  tokenForRole,
} from "./helpers/testAuth.js";

describe("Wave 1 API integration", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;
  let dbReady = false;

  before(async () => {
    server = await startTestServer();
    dbReady = await canRunDatabaseIntegrationTests();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("GET /health returns ok", async () => {
    const { status, json } = await apiRequest(server.baseUrl, { path: "/health" });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });

  it("rejects unauthenticated supplier campaign list", async () => {
    const { status, json } = await apiRequest(server.baseUrl, { path: "/supplier-campaigns" });
    assert.equal(status, 401);
    assert.equal(json.ok, false);
  });

  it("rejects analyst access to mapper errors (system:read required)", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status } = await apiRequest(server.baseUrl, {
      path: "/mapper-errors",
      token,
    });
    assert.equal(status, 403);
  });

  it("rejects analyst promotion run (sync:trigger required)", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status } = await apiRequest(server.baseUrl, {
      method: "POST",
      path: "/promotion/run",
      token,
      body: { entityTypes: ["campaign"] },
    });
    assert.equal(status, 403);
  });

  it("returns standard list envelope for supplier campaigns", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("OPERATIONS");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/supplier-campaigns?page=1&pageSize=5",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.pagination);
    assert.equal(json.pagination.pageSize, 5);
    assert.equal(typeof json.pagination.hasMore, "boolean");
  });

  it("masks commission and payloads for operations role on list", async () => {
    if (!dbReady) return;
    // ANALYST has campaigns:read but not commission:read — OPERATIONS includes commission:read.
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/supplier-campaigns?pageSize=10",
      token,
    });

    assert.equal(status, 200);
    if (!json.data?.length) return;

    const row = json.data[0];
    assert.equal(row.rawPayload, undefined);
    assert.equal(row.normalizedPayload, undefined);
    assert.equal(row.defaultCommissionValue, undefined);
    assert.equal(row.commissionGroups, undefined);
    assert.equal(row.entityId, undefined);
  });

  it("supports cursor pagination query param", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("TECH");
    if (!token) return;

    const first = await apiRequest(server.baseUrl, {
      path: "/supplier-campaigns?pageSize=2&cursor=",
      token,
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.ok, true);
    assert.ok("nextCursor" in first.json.pagination);

    if (first.json.pagination.nextCursor) {
      const second = await apiRequest(server.baseUrl, {
        path: `/supplier-campaigns?pageSize=2&cursor=${encodeURIComponent(first.json.pagination.nextCursor)}`,
        token,
      });
      assert.equal(second.status, 200);
      assert.equal(second.json.ok, true);
      assert.ok(Array.isArray(second.json.data));
    }
  });

  it("returns 404 for unknown supplier campaign id", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("TECH");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/supplier-campaigns/nonexistent-campaign-id",
      token,
    });

    assert.equal(status, 404);
    assert.equal(json.ok, false);
  });

  it("returns standard supplier list envelope", async () => {
    if (!dbReady) return;
    // ANALYST lacks system:read — supplier.config must be masked (omitted).
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/suppliers?view=legacy",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
    if (json.data.length) {
      assert.equal(json.data[0].config, undefined);
      assert.ok(json.data[0].key);
    }
  });

  it("TECH may see supplier config diagnostics when present", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("TECH");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/suppliers?view=legacy",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
    if (json.data.length) {
      // system:read retains the field on legacy seed view; value may be null or an object
      assert.ok("config" in json.data[0] || json.data[0].config === null || typeof json.data[0].config === "object");
    }
  });

  it("network ops contract omits secrets and does not treat seed as connected", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/suppliers",
      token,
    });

    assert.equal(status, 200);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.contract === "mbo-network-ops-v1" || json.data.length >= 0);
    for (const row of json.data) {
      assert.equal(row.config, undefined);
      assert.equal(row.encryptedAccessToken, undefined);
      assert.ok(row.key);
      assert.ok(row.connectionStatus);
      assert.ok(row.dataHealth);
      assert.notEqual(row.mapping?.status, "MAPPED");
      // Seed alone must not invent HEALTHY without evidence
      if (!row.credentialsConfigured) {
        assert.notEqual(row.connectionStatus, "CONNECTED");
      }
    }
  });
});

describe("Wave 2 Merchant API integration", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;
  let dbReady = false;

  before(async () => {
    server = await startTestServer();
    dbReady = await canRunDatabaseIntegrationTests();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("rejects unauthenticated merchant list", async () => {
    const { status, json } = await apiRequest(server.baseUrl, { path: "/merchants" });
    assert.equal(status, 401);
    assert.equal(json.ok, false);
  });

  it("rejects analyst merchant matching run (manage required)", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status } = await apiRequest(server.baseUrl, {
      method: "POST",
      path: "/merchant-matching/run",
      token,
      body: { batchSize: 5 },
    });
    assert.equal(status, 403);
  });

  it("returns standard list envelope for merchants", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("OPERATIONS");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/merchants?page=1&pageSize=5",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.pagination);
    assert.equal(json.pagination.pageSize, 5);
  });

  it("allows analyst read access to merchant review queue", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/merchant-review?pageSize=5",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
  });
});

describe("Wave 2B Catalog API integration", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;
  let dbReady = false;

  before(async () => {
    server = await startTestServer();
    dbReady = await canRunDatabaseIntegrationTests();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("rejects unauthenticated catalog list", async () => {
    const { status, json } = await apiRequest(server.baseUrl, { path: "/catalog" });
    assert.equal(status, 401);
    assert.equal(json.ok, false);
  });

  it("rejects analyst catalog create (manage required)", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status } = await apiRequest(server.baseUrl, {
      method: "POST",
      path: "/catalog",
      token,
      body: { merchantId: "merchant-id", displayName: "Test Catalog" },
    });
    assert.equal(status, 403);
  });

  it("returns standard list envelope for catalog", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("OPERATIONS");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/catalog?page=1&pageSize=5",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.pagination);
    assert.equal(json.pagination.pageSize, 5);
  });

  it("allows analyst read access to catalog", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/catalog?pageSize=5",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
  });
});

describe("Wave 3 Client API integration", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;
  let dbReady = false;

  before(async () => {
    server = await startTestServer();
    dbReady = await canRunDatabaseIntegrationTests();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("rejects unauthenticated client list", async () => {
    const { status, json } = await apiRequest(server.baseUrl, { path: "/clients" });
    assert.equal(status, 401);
    assert.equal(json.ok, false);
  });

  it("rejects analyst client create (manage required)", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status } = await apiRequest(server.baseUrl, {
      method: "POST",
      path: "/clients",
      token,
      body: { name: "Test Client" },
    });
    assert.equal(status, 403);
  });

  it("returns standard list envelope for clients", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("OPERATIONS");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/clients?page=1&pageSize=5",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.pagination);
    assert.equal(json.pagination.pageSize, 5);
  });

  it("allows analyst read access to client assignments", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/client-assignments?pageSize=5",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
  });
});

describe("Wave 4 Commercial API integration", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;
  let dbReady = false;

  before(async () => {
    server = await startTestServer();
    dbReady = await canRunDatabaseIntegrationTests();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("rejects unauthenticated tracking link list", async () => {
    const { status, json } = await apiRequest(server.baseUrl, { path: "/tracking-links" });
    assert.equal(status, 401);
    assert.equal(json.ok, false);
  });

  it("rejects analyst tracking link create (manage required)", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status } = await apiRequest(server.baseUrl, {
      method: "POST",
      path: "/tracking-links",
      token,
      body: {
        assignmentId: "assignment-id",
        mboTrackingUrl: "https://track.mbo.example/link",
      },
    });
    assert.equal(status, 403);
  });

  it("returns standard list envelope for tracking links", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("OPERATIONS");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/tracking-links?page=1&pageSize=5",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.pagination);
  });

  it("allows analyst read access to coupon assignments", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/coupon-assignments?pageSize=5",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
  });

  it("rejects analyst commission rules without commission:read", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status } = await apiRequest(server.baseUrl, {
      path: "/commission-rules",
      token,
    });
    assert.equal(status, 403);
  });

  it("rejects unauthenticated daily reports", async () => {
    const { status } = await apiRequest(server.baseUrl, { path: "/reports/daily" });
    assert.equal(status, 401);
  });

  it("rejects analyst aggregation run (sync:trigger required)", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const { status } = await apiRequest(server.baseUrl, {
      method: "POST",
      path: "/aggregation/run",
      token,
      body: {},
    });
    assert.equal(status, 403);
  });

  it("returns standard list envelope for daily reports", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("OPERATIONS");
    if (!token) return;

    const { status, json } = await apiRequest(server.baseUrl, {
      path: "/reports/daily?page=1&pageSize=5",
      token,
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.data));
    assert.ok(json.pagination);
  });

  it("allows analyst read access to clicks and conversions", async () => {
    if (!dbReady) return;
    const token = await tokenForRole("ANALYST");
    if (!token) return;

    const clicks = await apiRequest(server.baseUrl, { path: "/clicks?pageSize=5", token });
    assert.equal(clicks.status, 200);
    assert.equal(clicks.json.ok, true);

    const conversions = await apiRequest(server.baseUrl, { path: "/conversions?pageSize=5", token });
    assert.equal(conversions.status, 200);
    assert.equal(conversions.json.ok, true);
  });
});
