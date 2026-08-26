/**
 * Network ops contract — truthful connection/sync/capability/health.
 * A Supplier seed row alone must NOT imply connected/healthy/synced/mapped.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  buildCapabilities,
  deriveConnectionStatus,
  deriveDataHealth,
  deriveIntegrationStatus,
  deriveMappingStatus,
  deriveSyncStatus,
  resolveCapabilityState,
  CAPABILITY_STATE,
  CONNECTION_STATUS,
  DATA_HEALTH,
  MAPPING_STATUS,
  SYNC_STATUS,
} from "../src/modules/ops/networkOps.contract.js";
import { toNetworkListDto, toNetworkDetailDto, assertNoSecrets } from "../src/modules/ops/networkOps.dto.js";
import { NetworkOpsService } from "../src/modules/ops/networkOps.service.js";

describe("network ops — status honesty", () => {
  it("seed ENABLED without credentials is NOT_CONFIGURED, not CONNECTED", () => {
    assert.equal(
      deriveConnectionStatus({ seedStatus: "ENABLED", hasCredentials: false }),
      CONNECTION_STATUS.NOT_CONFIGURED,
    );
    assert.equal(
      deriveConnectionStatus({ seedStatus: "ENABLED", hasCredentials: true }),
      CONNECTION_STATUS.CONNECTED,
    );
    assert.equal(
      deriveConnectionStatus({ seedStatus: "PLANNED", hasCredentials: false }),
      CONNECTION_STATUS.PLANNED,
    );
  });

  it("sync NEVER when no credentials even if Supplier exists", () => {
    assert.equal(
      deriveSyncStatus({ hasCredentials: false, lastSuccessfulSync: null }),
      SYNC_STATUS.NEVER,
    );
  });

  it("imported without linked is NEEDS_REVIEW, not HEALTHY", () => {
    assert.equal(
      deriveDataHealth({
        hasCredentials: true,
        syncStatus: SYNC_STATUS.SYNCED,
        importedCampaigns: 411,
        linkedCampaigns: 0,
        openMapperErrors: 0,
        lastSuccessfulSync: new Date(),
      }),
      DATA_HEALTH.NEEDS_REVIEW,
    );
  });

  it("fully linked active catalog is HEALTHY when raw imports include archived retired rows", () => {
    assert.equal(
      deriveDataHealth({
        hasCredentials: true,
        syncStatus: SYNC_STATUS.SYNCED,
        importedCampaigns: 499,
        linkedCampaigns: 486,
        activePromotedCampaigns: 486,
        lastSuccessfulSync: new Date(),
      }),
      DATA_HEALTH.HEALTHY,
    );
    assert.equal(
      deriveIntegrationStatus({
        connectionStatus: CONNECTION_STATUS.CONNECTED,
        syncStatus: SYNC_STATUS.SYNCED,
        dataHealth: DATA_HEALTH.HEALTHY,
      }),
      "SYNCED",
    );
  });

  it("mapping never invents MAPPED", () => {
    assert.equal(
      deriveMappingStatus({ importedCampaigns: 100, linkedCampaigns: 50 }),
      MAPPING_STATUS.NEEDS_REVIEW,
    );
    assert.equal(deriveMappingStatus({}), MAPPING_STATUS.UNAVAILABLE);
    assert.notEqual(deriveMappingStatus({ importedCampaigns: 1 }), "MAPPED");
  });

  it("integration status does not become SYNCED from seed alone", () => {
    assert.equal(
      deriveIntegrationStatus({
        connectionStatus: CONNECTION_STATUS.NOT_CONFIGURED,
        syncStatus: SYNC_STATUS.NEVER,
        dataHealth: DATA_HEALTH.NOT_CONFIGURED,
      }),
      "NOT_CONFIGURED",
    );
  });
});

describe("network ops — capabilities", () => {
  it("marks Boostiny tracking as PARTIAL (unverified)", () => {
    assert.equal(
      resolveCapabilityState("BOOSTINY", "tracking", { hasCredentials: true }),
      CAPABILITY_STATE.PARTIAL,
    );
  });

  it("marks Trackier campaigns AVAILABLE when credentials present", () => {
    assert.equal(
      resolveCapabilityState("TRACKIER", "campaigns", { hasCredentials: true }),
      CAPABILITY_STATE.AVAILABLE,
    );
    assert.equal(
      resolveCapabilityState("TRACKIER", "campaigns", { hasCredentials: false }),
      CAPABILITY_STATE.NOT_CONFIGURED,
    );
  });

  it("marks Partnerize coupons AVAILABLE when credentials present (voucher API)", () => {
    assert.equal(
      resolveCapabilityState("PARTNERIZE", "coupons", { hasCredentials: true }),
      CAPABILITY_STATE.AVAILABLE,
    );
  });

  it("marks Impact coupons UNAVAILABLE (promotions are deal content, not voucher codes)", () => {
    assert.equal(
      resolveCapabilityState("IMPACT", "coupons", { hasCredentials: true }),
      CAPABILITY_STATE.UNAVAILABLE,
    );
  });

  it("buildCapabilities returns all UI resources", () => {
    const caps = buildCapabilities("OPTIMISE", { hasCredentials: true });
    assert.ok(caps.campaigns);
    assert.ok(caps.payments);
    assert.ok(caps.tracking);
  });
});

describe("network ops — DTO secrecy", () => {
  it("list DTO has no config/secrets and uses null not fake zeros for missing sync counts", () => {
    const dto = toNetworkListDto({
      key: "OPTIMISE",
      name: "Optimise",
      integrationStatus: "PARTIAL",
      connectionStatus: "CONNECTED",
      syncStatus: "SYNCED",
      dataHealth: "NEEDS_REVIEW",
      lastSuccessfulSync: new Date("2026-08-14T21:55:00Z"),
      credentialsConfigured: true,
      accountCount: 1,
      capabilities: buildCapabilities("OPTIMISE", { hasCredentials: true }),
      metrics: {
        importedCampaigns: 321,
        linkedCampaigns: 0,
        assignableCampaigns: null,
        openMapperErrors: 0,
      },
      mapping: { status: "NEEDS_REVIEW", issues: ["Imported campaigns not promoted"] },
    });
    assert.equal("config" in dto, false);
    assert.equal("encryptedAccessToken" in dto, false);
    assert.equal(dto.metrics.importedCampaigns, 321);
    assert.equal(dto.metrics.linkedCampaigns, 0);
    assert.equal(dto.metrics.assignableCampaigns, null);
    assert.equal(dto.connectionStatus, "CONNECTED");
    assertNoSecrets(dto);
  });

  it("detail sync health uses null for unavailable record counters", () => {
    const dto = toNetworkDetailDto({
      key: "TRACKIER",
      name: "Trackier",
      credentialsConfigured: true,
      capabilities: buildCapabilities("TRACKIER", { hasCredentials: true }),
      metrics: { importedCampaigns: 74, linkedCampaigns: 0 },
      mapping: { status: "NEEDS_REVIEW", issues: [] },
      syncHealth: {
        lastSuccessfulSync: new Date(),
        recordsProcessed: null,
        recordsCreated: null,
        recordsUpdated: null,
        recordsRejected: null,
        errorCount: null,
        durationMs: 16478,
      },
      accounts: [
        {
          platform: "trackier",
          accountLabel: "default",
          authType: "api_key",
          credentialsConfigured: true,
          maskedApiKey: "6a39***1f81",
          connectedAt: new Date(),
          lastSuccessfulSync: new Date(),
        },
      ],
      pipeline: [],
      coverage: {},
    });
    assert.equal(dto.syncHealth.recordsCreated, null);
    assert.equal(dto.syncHealth.recordsProcessed, null);
    assert.ok(dto.accounts[0].maskedApiKey);
    assert.equal(JSON.stringify(dto).includes("SECRET"), false);
    assert.equal(JSON.stringify(dto).includes("encryptedAccessToken"), false);
  });
});

describe("network ops — service assembly", () => {
  it("lists registered networks; seed-only Partnerize is not CONNECTED/HEALTHY", async () => {
    const db = {
      supplier: {
        findMany: mock.fn(async () => [
          { id: "1", key: "BOOSTINY", displayName: "Boostiny", status: "ENABLED", updatedAt: new Date() },
          { id: "2", key: "OPTIMISE", displayName: "Optimise", status: "ENABLED", updatedAt: new Date() },
          { id: "3", key: "TRACKIER", displayName: "Trackier", status: "ENABLED", updatedAt: new Date() },
          { id: "4", key: "PARTNERIZE", displayName: "Partnerize", status: "PLANNED", updatedAt: new Date() },
          { id: "5", key: "IMPACT", displayName: "Impact", status: "PLANNED", updatedAt: new Date() },
        ]),
      },
      marketplaceAccount: {
        findMany: mock.fn(async () => [
          {
            platform: "optimise_sea",
            accountLabel: "default",
            authType: "api_key",
            maskedApiKey: "abc***xyz",
            encryptedAccessToken: "SECRET_SHOULD_NOT_LEAK",
            connectedAt: new Date(),
            lastSuccessfulSync: new Date("2026-08-14T21:55:00Z"),
            lastCampaignSyncAt: new Date("2026-08-14T21:31:00Z"),
            lastCouponSyncAt: new Date("2026-08-14T21:31:00Z"),
          },
        ]),
      },
      entity: {
        groupBy: mock.fn(async () => [
          { networkSource: "optimise_sea", entityType: "campaign", _count: { _all: 321 } },
          { networkSource: "optimise_sea", entityType: "performance", _count: { _all: 45 } },
        ]),
      },
      supplierCampaign: {
        groupBy: mock.fn(async () => []),
      },
      mapperError: {
        groupBy: mock.fn(async () => []),
      },
      syncJobLog: {
        findMany: mock.fn(async () => [
          { jobName: "syncAll", status: "success", message: "Sync completed", metadata: {}, createdAt: new Date() },
        ]),
      },
      $queryRaw: mock.fn(async () => []),
    };

    const svc = new NetworkOpsService({
      prisma: db,
      getSyncStatus: () => ({ status: "idle" }),
      getSchedulerStatus: () => ({ enabled: true, intervalMinutes: 360, lastAttemptAt: null }),
    });

    const out = await svc.listNetworks();
    assert.ok(out.items.length >= 5);

    const partnerize = out.items.find((i) => i.key === "PARTNERIZE");
    assert.ok(partnerize);
    assert.equal(partnerize.connectionStatus, "PLANNED");
    assert.notEqual(partnerize.connectionStatus, "CONNECTED");
    assert.notEqual(partnerize.dataHealth, "HEALTHY");
    assert.notEqual(partnerize.mapping.status, "MAPPED");

    const optimise = out.items.find((i) => i.key === "OPTIMISE");
    assert.equal(optimise.connectionStatus, "CONNECTED");
    assert.equal(optimise.metrics.importedCampaigns, 321);
    assert.equal(optimise.metrics.linkedCampaigns, 0);
    assert.equal(optimise.dataHealth, "NEEDS_REVIEW");
    assert.equal(optimise.credentialsConfigured, true);
    assert.equal(JSON.stringify(optimise).includes("SECRET_SHOULD_NOT_LEAK"), false);

    const detail = await svc.getNetwork("OPTIMISE");
    assert.equal(detail.coverage.campaigns.importedCount, 321);
    assert.equal(detail.coverage.campaigns.linkedCount, 0);
    assert.equal(detail.syncHealth.recordsCreated, null);
  });

  it("filters by data health and capability on real assembled fields", async () => {
    const db = {
      supplier: { findMany: mock.fn(async () => []) },
      marketplaceAccount: { findMany: mock.fn(async () => []) },
      entity: { groupBy: mock.fn(async () => []) },
      supplierCampaign: { groupBy: mock.fn(async () => []) },
      mapperError: { groupBy: mock.fn(async () => []) },
      syncJobLog: { findMany: mock.fn(async () => []) },
      $queryRaw: mock.fn(async () => []),
    };
    const svc = new NetworkOpsService({
      prisma: db,
      getSyncStatus: () => ({ status: "idle" }),
      getSchedulerStatus: () => ({ enabled: false }),
    });
    const filtered = await svc.listNetworks({
      capability: "campaigns",
      capabilityState: "NOT_CONFIGURED",
    });
    assert.ok(filtered.items.every((i) => i.capabilities.campaigns.state === "NOT_CONFIGURED"));
  });
});
