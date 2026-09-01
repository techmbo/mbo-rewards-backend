/**
 * Global search — federated staff lookup.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GlobalSearchService } from "../src/modules/ops/globalSearch.service.js";
import { PERMISSIONS, getPermissionsForRole } from "../src/auth/permissions.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Global search service", () => {
  const service = new GlobalSearchService();

  it("returns empty results for short queries", async () => {
    const result = await service.search("a", { permissions: getPermissionsForRole("ADMIN") });
    assert.equal(result.total, 0);
    assert.equal(result.minQueryLength, 2);
  });

  it("searches clients for admin permissions", async () => {
    const result = await service.search("test", { permissions: getPermissionsForRole("ADMIN"), limit: 3 });
    assert.ok(Array.isArray(result.groups));
    assert.ok(Array.isArray(result.results));
    for (const item of result.results) {
      assert.ok(item.type);
      assert.ok(item.label);
      assert.ok(item.href?.startsWith("/"));
    }
  });

  it("respects permission gates — client role gets no staff results", async () => {
    const result = await service.search("campaign", { permissions: getPermissionsForRole("CLIENT"), limit: 3 });
    assert.equal(result.total, 0);
  });

  it("uses permissions array for category gates (not role name lookup)", async () => {
    const adminPerms = getPermissionsForRole("ADMIN");
    assert.ok(adminPerms.includes(PERMISSIONS.CLIENTS_READ));

    const blocked = await service.search("test", { permissions: [], limit: 3 });
    assert.equal(blocked.total, 0);
    assert.equal(blocked.groups.length, 0);

    const allowed = await service.search("test", { permissions: adminPerms, limit: 3 });
    assert.ok(Array.isArray(allowed.groups));
    assert.ok(Array.isArray(allowed.results));
  });
});

describe("GET /ops/global-search", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("returns 401 without auth", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/global-search?q=test",
    });
    assert.equal(status, 401);
  });
});
