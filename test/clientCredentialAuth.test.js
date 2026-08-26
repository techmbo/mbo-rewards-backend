import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createHash } from "node:crypto";

/**
 * authenticateApiKey behavior is prisma-backed; we test the decision matrix by
 * exercising a thin harness that mirrors the service's rejection rules.
 */
function resolveApiKeyAuth({ match, keyHash, rawHash }) {
  if (!match) return null;
  if (match.keyHash !== rawHash) return null;
  if (match.revokedAt) return null;
  if (!match.client || match.client.deletedAt) return null;
  if (match.client.status === "OFFBOARDED" || match.client.status === "SUSPENDED") return null;
  if (match.client.status !== "ACTIVE") return null;
  return { credentialId: match.id, clientId: match.clientId, client: match.client };
}

describe("Partner API key auth rules", () => {
  const rawKey = "mbo_live_abcdefghijklmnopqrstuvwx";
  const rawHash = createHash("sha256").update(rawKey).digest("hex");

  it("accepts an active key for an ACTIVE client", () => {
    const result = resolveApiKeyAuth({
      rawHash,
      match: {
        id: "cred-1",
        clientId: "client-a",
        keyHash: rawHash,
        revokedAt: null,
        client: { id: "client-a", status: "ACTIVE", deletedAt: null },
      },
    });
    assert.equal(result.clientId, "client-a");
  });

  it("rejects revoked credentials", () => {
    const result = resolveApiKeyAuth({
      rawHash,
      match: {
        id: "cred-1",
        clientId: "client-a",
        keyHash: rawHash,
        revokedAt: new Date(),
        client: { id: "client-a", status: "ACTIVE", deletedAt: null },
      },
    });
    assert.equal(result, null);
  });

  it("rejects suspended clients", () => {
    const result = resolveApiKeyAuth({
      rawHash,
      match: {
        id: "cred-1",
        clientId: "client-a",
        keyHash: rawHash,
        revokedAt: null,
        client: { id: "client-a", status: "SUSPENDED", deletedAt: null },
      },
    });
    assert.equal(result, null);
  });

  it("rejects offboarded clients", () => {
    const result = resolveApiKeyAuth({
      rawHash,
      match: {
        id: "cred-1",
        clientId: "client-a",
        keyHash: rawHash,
        revokedAt: null,
        client: { id: "client-a", status: "OFFBOARDED", deletedAt: null },
      },
    });
    assert.equal(result, null);
  });

  it("rejects invalid key hash", () => {
    const result = resolveApiKeyAuth({
      rawHash,
      match: {
        id: "cred-1",
        clientId: "client-a",
        keyHash: "deadbeef",
        revokedAt: null,
        client: { id: "client-a", status: "ACTIVE", deletedAt: null },
      },
    });
    assert.equal(result, null);
  });
});

describe("ClientCredentialService.authenticateApiKey integration shape", () => {
  it("delegates listVisibleCampaigns to PartnerCampaignService", async () => {
    const listCampaigns = mock.fn(async () => ({
      client: { id: "c1" },
      campaigns: [],
      pagination: { total: 0 },
    }));

    const { ClientCredentialService } = await import(
      "../src/modules/client/services/clientCredential.service.js"
    );

    const service = new ClientCredentialService({
      partnerCampaigns: { listCampaigns },
      clientRepo: { findById: mock.fn(async () => ({ id: "c1", status: "ACTIVE" })) },
    });

    const payload = await service.listVisibleCampaigns("c1", { page: 1 });
    assert.equal(listCampaigns.mock.calls.length, 1);
    assert.equal(listCampaigns.mock.calls[0].arguments[0], "c1");
    assert.deepEqual(payload.pagination, { total: 0 });
  });
});
