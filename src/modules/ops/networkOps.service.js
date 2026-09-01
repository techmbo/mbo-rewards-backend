import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { SUPPLIER_CAPABILITY_CATALOG, listRegisteredSuppliers } from "../../adapters/registry.js";
import { getTrackingParamRule } from "../tracking/trackingParamRules.js";
import { getSyncStatus } from "../../jobs/syncState.js";
import { getSchedulerStatus } from "../../jobs/syncScheduler.js";
import { toNetworkDetailDto, toNetworkListDto } from "./networkOps.dto.js";
import { hasNetworkAccountSecret } from "../networkOps/networkAccount.contract.js";
import { SourceObjectSyncService } from "../networkOps/sourceObjectSync.service.js";
import {
  buildCapabilities,
  deriveConnectionStatus,
  deriveDataHealth,
  deriveIntegrationStatus,
  deriveMappingStatus,
  deriveSyncStatus,
  displayNameForKey,
  entitySourcesForSupplier,
  normalizeNetworkKey,
  platformsForSupplier,
  supplierKeyFromPlatform,
  CAPABILITY_STATE,
  DATA_HEALTH,
} from "./networkOps.contract.js";

function maxDate(dates) {
  const valid = dates
    .map((d) => (d ? new Date(d) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()));
  if (!valid.length) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

function sumCounts(map, keys) {
  let n = 0;
  let found = false;
  for (const k of keys) {
    if (map.has(k)) {
      found = true;
      n += map.get(k) || 0;
    }
  }
  return found ? n : 0;
}

function resourceCoverage({
  capabilityState,
  importedCount = null,
  promotedCount = null,
  linkedCount = null,
  lastSyncedAt = null,
  extraHealth = null,
}) {
  let health = null;
  if (capabilityState === CAPABILITY_STATE.UNAVAILABLE) health = "NOT_AVAILABLE";
  else if (capabilityState === CAPABILITY_STATE.NOT_CONFIGURED) health = "NOT_CONFIGURED";
  else if (extraHealth) health = extraHealth;
  else if (importedCount != null && importedCount > 0 && linkedCount === 0 && promotedCount === 0) {
    health = "NEEDS_REVIEW";
  } else if (importedCount != null && importedCount > 0) health = "PARTIAL";
  else if (capabilityState === CAPABILITY_STATE.PARTIAL) health = "PARTIAL";
  else if (capabilityState === CAPABILITY_STATE.AVAILABLE && (importedCount == null || importedCount === 0)) {
    health = lastSyncedAt ? "PARTIAL" : "NO_RECENT_DATA";
  } else if (capabilityState === CAPABILITY_STATE.AVAILABLE) health = "HEALTHY";

  return {
    supported: capabilityState !== CAPABILITY_STATE.UNAVAILABLE,
    configured: capabilityState !== CAPABILITY_STATE.NOT_CONFIGURED && capabilityState !== CAPABILITY_STATE.UNAVAILABLE,
    capabilityState,
    health,
    lastSyncedAt: lastSyncedAt ? new Date(lastSyncedAt).toISOString() : null,
    importedCount: importedCount == null ? null : importedCount,
    promotedCount: promotedCount == null ? null : promotedCount,
    linkedCount: linkedCount == null ? null : linkedCount,
  };
}

/**
 * Staff network / supplier-integration contract.
 * Reuses Supplier, MarketplaceAccount, Entity, SupplierCampaign, SyncJobLog — no parallel domain.
 */
const AGGREGATE_CACHE_TTL_MS = 5 * 60 * 1000;
let aggregateCache = null;
let aggregateCacheAt = 0;

export function invalidateNetworkOpsAggregateCache() {
  aggregateCache = null;
  aggregateCacheAt = 0;
}

export class NetworkOpsService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.getSyncStatusFn = deps.getSyncStatus ?? getSyncStatus;
    this.getSchedulerStatusFn = deps.getSchedulerStatus ?? getSchedulerStatus;
    this.sourceObjectSync = deps.sourceObjectSync ?? new SourceObjectSyncService({ prisma: this.db });
  }

  invalidateAggregateCache() {
    invalidateNetworkOpsAggregateCache();
  }

  async #loadAggregateMaps() {
    if (aggregateCache && Date.now() - aggregateCacheAt < AGGREGATE_CACHE_TTL_MS) {
      return aggregateCache;
    }

    const [
      suppliers,
      accounts,
      entityGroups,
      campaignGroups,
      activeCampaignGroups,
      linkedRows,
      merchantRows,
      mapperErrors,
      recentLogs,
    ] = await Promise.all([
      this.db.supplier.findMany(),
      this.db.marketplaceAccount.findMany({
        select: {
          id: true,
          platform: true,
          accountLabel: true,
          authType: true,
          accountExternalId: true,
          maskedApiKey: true,
          secretRef: true,
          environment: true,
          syncEnabled: true,
          financeSyncEnabled: true,
          credentialHealth: true,
          connectedAt: true,
          updatedAt: true,
          lastSuccessfulSync: true,
          lastCampaignSyncAt: true,
          lastCouponSyncAt: true,
          lastOrderSyncAt: true,
          lastPaymentSyncAt: true,
          syncFrequencyMinutes: true,
          lastAuthCheckAt: true,
          lastSyncError: true,
          tokenExpiresAt: true,
        },
      }),
      this.db.entity.groupBy({
        by: ["networkSource", "entityType"],
        _count: { _all: true },
      }),
      this.db.supplierCampaign.groupBy({
        by: ["supplier"],
        _count: { _all: true },
      }),
      this.db.supplierCampaign.groupBy({
        by: ["supplier"],
        where: { archivedAt: null },
        _count: { _all: true },
      }),
      this.db.$queryRaw`
        SELECT sc.supplier::text AS supplier, COUNT(DISTINCT sc.id)::int AS linked
        FROM supplier_campaigns sc
        INNER JOIN campaign_sources cs ON cs."supplierCampaignId" = sc.id AND cs."isActive" = true
        WHERE sc."archivedAt" IS NULL
        GROUP BY sc.supplier
      `.catch(() => []),
      this.db.$queryRaw`
        SELECT sc.supplier::text AS supplier, COUNT(DISTINCT sc."merchantId")::int AS merchants
        FROM supplier_campaigns sc
        WHERE sc."merchantId" IS NOT NULL
        GROUP BY sc.supplier
      `.catch(() => []),
      this.db.mapperError.groupBy({
        by: ["supplier"],
        where: { status: "OPEN" },
        _count: { _all: true },
      }).catch(() => []),
      this.db.syncJobLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 40,
        select: {
          jobName: true,
          status: true,
          message: true,
          metadata: true,
          createdAt: true,
        },
      }),
    ]);

    const entityCampaign = new Map();
    const entityCoupon = new Map();
    const entityPerformance = new Map();
    for (const row of entityGroups) {
      const ns = String(row.networkSource || "").toLowerCase();
      const type = String(row.entityType || "").toLowerCase();
      const count = row._count?._all ?? 0;
      if (type === "campaign") entityCampaign.set(ns, (entityCampaign.get(ns) || 0) + count);
      else if (type === "coupon") entityCoupon.set(ns, (entityCoupon.get(ns) || 0) + count);
      else if (type === "performance" || type === "report" || type === "reporting") {
        entityPerformance.set(ns, (entityPerformance.get(ns) || 0) + count);
      }
    }

    const promoted = new Map(campaignGroups.map((r) => [r.supplier, r._count._all]));
    const activePromoted = new Map(activeCampaignGroups.map((r) => [r.supplier, r._count._all]));
    const linked = new Map((linkedRows || []).map((r) => [String(r.supplier).toUpperCase(), r.linked]));
    const merchants = new Map((merchantRows || []).map((r) => [String(r.supplier).toUpperCase(), r.merchants]));
    const errors = new Map(
      (mapperErrors || []).map((r) => [r.supplier ? String(r.supplier).toUpperCase() : "UNKNOWN", r._count._all]),
    );

    aggregateCache = {
      suppliers,
      accounts,
      entityCampaign,
      entityCoupon,
      entityPerformance,
      promoted,
      activePromoted,
      linked,
      merchants,
      errors,
      recentLogs,
    };
    aggregateCacheAt = Date.now();
    return aggregateCache;
  }

  #accountsForSupplier(accounts, supplierKey) {
    return accounts.filter((a) => supplierKeyFromPlatform(a.platform) === supplierKey);
  }

  #hasCredentials(account) {
    return hasNetworkAccountSecret(account);
  }

  #isSyncingForSupplier(supplierKey, live) {
    if (!live || live.status !== "running") return false;
    const job = String(live.jobName || "").toLowerCase();
    if (job === "syncall" || job === "scheduledsyncall") return true;
    const platforms = platformsForSupplier(supplierKey);
    return platforms.some((p) => job.includes(p));
  }

  #lastLogForSupplier(logs, supplierKey) {
    const platforms = platformsForSupplier(supplierKey);
    const keyLower = supplierKey.toLowerCase();
    for (const log of logs) {
      const job = String(log.jobName || "").toLowerCase();
      const meta = log.metadata && typeof log.metadata === "object" ? log.metadata : null;
      if (job === "syncall" || job === "scheduledsyncall") {
        if (meta && meta[keyLower] != null) return log;
        // syncAll always touches all networks — use as global signal only when no per-network account logs
        continue;
      }
      if (platforms.some((p) => job.includes(p)) || job.includes(keyLower)) return log;
    }
    // Fall back to latest syncAll for networks that participated
    return logs.find((l) => {
      const job = String(l.jobName || "").toLowerCase();
      return job === "syncall" || job === "scheduledsyncall";
    }) || null;
  }

  #extractDurationMs(log, supplierKey) {
    const meta = log?.metadata;
    if (!meta || typeof meta !== "object") return null;
    const timings = meta.timings;
    if (!timings || typeof timings !== "object") return null;
    const keyMap = {
      BOOSTINY: "boostinyMs",
      OPTIMISE: "optimiseMs",
      TRACKIER: "trackierMs",
      PARTNERIZE: "partnerizeMs",
      IMPACT: "impactMs",
    };
    const field = keyMap[supplierKey];
    if (field && timings[field] != null) {
      const n = Number(timings[field]);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  #networkSkippedReason(log, supplierKey) {
    const meta = log?.metadata;
    if (!meta || typeof meta !== "object") return null;
    const key = supplierKey.toLowerCase();
    const block = meta[key];
    if (block && typeof block === "object" && block.skipped && block.reason) {
      return String(block.reason);
    }
    return null;
  }

  #assembleNetwork(key, agg, live, scheduler) {
    const seed = agg.suppliers.find((s) => s.key === key) || null;
    const accounts = this.#accountsForSupplier(agg.accounts, key);
    const credentialAccounts = accounts.filter((a) => this.#hasCredentials(a));
    const hasCredentials = credentialAccounts.length > 0;
    const sources = entitySourcesForSupplier(key);

    const importedCampaigns = sumCounts(agg.entityCampaign, sources);
    const importedCoupons = sumCounts(agg.entityCoupon, sources);
    const importedPerformance = sumCounts(agg.entityPerformance, sources);
    const promotedCampaigns = agg.promoted.get(key) ?? 0;
    const activePromotedCampaigns = agg.activePromoted.get(key) ?? 0;
    const linkedCampaigns = agg.linked.get(key) ?? 0;
    const merchants = agg.merchants.get(key) ?? 0;
    const openMapperErrors = agg.errors.get(key) ?? 0;

    const lastSuccessfulSync = maxDate(accounts.map((a) => a.lastSuccessfulSync));
    const lastCampaignSyncAt = maxDate(accounts.map((a) => a.lastCampaignSyncAt));
    const lastCouponSyncAt = maxDate(accounts.map((a) => a.lastCouponSyncAt));
    const lastOrderSyncAt = maxDate(accounts.map((a) => a.lastOrderSyncAt));
    const lastPaymentSyncAt = maxDate(accounts.map((a) => a.lastPaymentSyncAt));
    const syncFrequencyMinutes = accounts
      .map((a) => a.syncFrequencyMinutes)
      .find((v) => v != null && Number.isFinite(Number(v))) ?? null;
    const lastLog = this.#lastLogForSupplier(agg.recentLogs, key);
    const failedLog = agg.recentLogs.find((l) => {
      const st = String(l.status || "").toLowerCase();
      if (st !== "failed" && st !== "error") return false;
      const job = String(l.jobName || "").toLowerCase();
      return (
        job.includes(key.toLowerCase()) ||
        platformsForSupplier(key).some((p) => job.includes(p)) ||
        job === "syncall"
      );
    });

    const isSyncing = this.#isSyncingForSupplier(key, live);
    const connectionStatus = deriveConnectionStatus({
      seedStatus: seed?.status,
      hasCredentials,
    });
    const syncStatus = deriveSyncStatus({
      lastSuccessfulSync,
      isSyncing,
      lastLogStatus: lastLog?.status,
      hasCredentials,
    });
    const dataHealth = deriveDataHealth({
      hasCredentials,
      syncStatus,
      importedCampaigns,
      linkedCampaigns,
      activePromotedCampaigns,
      openMapperErrors,
      lastSuccessfulSync,
    });
    const mappingStatus = deriveMappingStatus({
      openMapperErrors,
      importedCampaigns,
      linkedCampaigns,
    });
    const integrationStatus = deriveIntegrationStatus({
      connectionStatus,
      syncStatus,
      dataHealth,
    });

    const capabilities = buildCapabilities(key, { hasCredentials });
    const catalog = SUPPLIER_CAPABILITY_CATALOG[key];
    const trackingRule = getTrackingParamRule(key);
    const syncPlatforms = platformsForSupplier(key);
    const manualSyncSupported = syncPlatforms.length > 0;

    const mappingIssues = [];
    if (importedCampaigns > 0 && promotedCampaigns === 0) {
      mappingIssues.push("Imported campaigns not promoted to normalized campaign store");
    }
    if (promotedCampaigns > 0 && linkedCampaigns === 0) {
      mappingIssues.push("Normalized campaigns not linked to catalog sources");
    }
    if (openMapperErrors > 0) {
      mappingIssues.push(`${openMapperErrors} open mapper error(s)`);
    }
    if ((trackingRule.verificationFlags || []).length) {
      mappingIssues.push(...trackingRule.verificationFlags);
    }

    const skippedReason = this.#networkSkippedReason(lastLog, key);

    return {
      id: seed?.id ?? null,
      key,
      name: displayNameForKey(key, seed?.displayName),
      seedStatus: seed?.status ?? null,
      integrationStatus,
      connectionStatus,
      syncStatus,
      dataHealth,
      lastSuccessfulSync,
      lastAttemptedSync: lastLog?.createdAt ?? null,
      lastCampaignSyncAt,
      lastCouponSyncAt,
      lastOrderSyncAt,
      lastPaymentSyncAt,
      syncFrequencyMinutes,
      credentialsConfigured: hasCredentials,
      accountCount: accounts.length,
      regions: [...new Set(accounts.map((a) => a.platform))],
      manualSyncSupported,
      syncPlatforms,
      capabilities,
      metrics: {
        importedCampaigns,
        importedCoupons,
        importedPerformance,
        promotedCampaigns,
        activePromotedCampaigns,
        linkedCampaigns,
        // Assignable requires JOINED+ACTIVE+channel+commission — not safely countable without full DTO pass.
        assignableCampaigns: null,
        merchants: merchants || null,
        openMapperErrors,
      },
      mapping: {
        status: mappingStatus,
        issues: mappingIssues,
      },
      catalogNotes: catalog?.notes ?? [],
      updatedAt: seed?.updatedAt ?? null,
      coverage: {
        campaigns: resourceCoverage({
          capabilityState: capabilities.campaigns,
          importedCount: importedCampaigns,
          promotedCount: promotedCampaigns,
          linkedCount: linkedCampaigns,
          lastSyncedAt: lastCampaignSyncAt || lastSuccessfulSync,
        }),
        brands: {
          supported: true,
          configured: hasCredentials,
          capabilityState: hasCredentials ? CAPABILITY_STATE.PARTIAL : CAPABILITY_STATE.NOT_CONFIGURED,
          health: merchants > 0 ? "PARTIAL" : importedCampaigns > 0 ? "NEEDS_REVIEW" : "NO_RECENT_DATA",
          lastSyncedAt: lastSuccessfulSync ? new Date(lastSuccessfulSync).toISOString() : null,
          importedCount: null,
          promotedCount: null,
          linkedCount: merchants || null,
        },
        coupons: resourceCoverage({
          capabilityState: capabilities.coupons,
          importedCount: importedCoupons,
          lastSyncedAt: lastCouponSyncAt || lastSuccessfulSync,
        }),
        tracking: resourceCoverage({
          capabilityState: capabilities.tracking,
          extraHealth:
            trackingRule.confirmation === "UNCONFIRMED"
              ? "UNVERIFIED"
              : (trackingRule.verificationFlags || []).length
                ? "PARTIAL"
                : null,
          lastSyncedAt: null,
        }),
        conversions: resourceCoverage({
          capabilityState: capabilities.conversions,
          // No Conversion rows keyed by supplier reliably without join — leave null when zero unproven
          importedCount: null,
          lastSyncedAt: lastSuccessfulSync,
        }),
        performance: resourceCoverage({
          capabilityState: capabilities.performance,
          importedCount: importedPerformance,
          lastSyncedAt: lastSuccessfulSync,
        }),
        orders: resourceCoverage({
          capabilityState: capabilities.orders,
          importedCount: null,
        }),
        payments: resourceCoverage({
          capabilityState: capabilities.payments,
          importedCount: null,
        }),
      },
      syncHealth: {
        lastSuccessfulSync,
        lastFailedSync: failedLog?.createdAt ?? null,
        lastSyncJobStatus: lastLog?.status ?? null,
        lastSyncMessage: skippedReason || lastLog?.message || null,
        durationMs: this.#extractDurationMs(lastLog, key),
        // SyncJobLog does not persist created/updated/rejected counts — do not invent 0.
        recordsProcessed: null,
        recordsCreated: null,
        recordsUpdated: null,
        recordsRejected: null,
        errorCount: openMapperErrors > 0 ? openMapperErrors : null,
        liveSync: isSyncing
          ? {
              status: live.status,
              jobName: live.jobName,
              startedAt: live.startedAt,
              percentComplete: live.percentComplete ?? null,
              currentStage: live.currentStage ?? null,
            }
          : null,
        scheduler: scheduler
          ? {
              enabled: Boolean(scheduler.enabled),
              intervalMinutes: scheduler.intervalMinutes ?? null,
              lastAttemptAt: scheduler.lastAttemptAt ?? null,
            }
          : null,
      },
      pipeline: [
        { stage: "connection", status: connectionStatus },
        {
          stage: "campaign_sync",
          status:
            importedCampaigns > 0
              ? "HEALTHY"
              : hasCredentials
                ? lastSuccessfulSync
                  ? "PARTIAL"
                  : "NO_RECENT_DATA"
                : "NOT_CONFIGURED",
        },
        {
          stage: "campaign_mapping",
          status:
            linkedCampaigns > 0
              ? "PARTIAL"
              : importedCampaigns > 0
                ? "NEEDS_REVIEW"
                : "UNAVAILABLE",
        },
        {
          stage: "tracking",
          status:
            capabilities.tracking === CAPABILITY_STATE.AVAILABLE
              ? "PARTIAL"
              : capabilities.tracking === CAPABILITY_STATE.PARTIAL
                ? "UNVERIFIED"
                : capabilities.tracking === CAPABILITY_STATE.NOT_CONFIGURED
                  ? "NOT_CONFIGURED"
                  : "NOT_AVAILABLE",
        },
        {
          stage: "performance",
          status:
            importedPerformance > 0
              ? "HEALTHY"
              : capabilities.performance === CAPABILITY_STATE.UNAVAILABLE
                ? "NOT_AVAILABLE"
                : hasCredentials
                  ? "NO_RECENT_DATA"
                  : "NOT_CONFIGURED",
        },
        {
          stage: "payments",
          status:
            capabilities.payments === CAPABILITY_STATE.UNAVAILABLE
              ? "NOT_AVAILABLE"
              : hasCredentials
                ? "PARTIAL"
                : "NOT_CONFIGURED",
        },
      ],
      tracking: {
        confirmation: trackingRule.confirmation,
        verificationFlags: trackingRule.verificationFlags || [],
        notes: trackingRule.notes || [],
        // Param names are operational config, not secrets
        clientIdParam: trackingRule.clientIdParam ?? null,
        assignmentIdParam: trackingRule.assignmentIdParam ?? null,
        clickIdParam: trackingRule.mboClickIdParam ?? null,
      },
      accounts: accounts.map((a) => ({
        ...a,
        credentialsConfigured: this.#hasCredentials(a),
      })),
    };
  }

  async listNetworks({
    q = null,
    integrationStatus = null,
    connectionStatus = null,
    dataHealth = null,
    mappingStatus = null,
    capability = null,
    capabilityState = null,
  } = {}) {
    const agg = await this.#loadAggregateMaps();
    const live = this.getSyncStatusFn();
    const scheduler = this.getSchedulerStatusFn();
    const keys = listRegisteredSuppliers();

    let items = keys.map((key) => toNetworkListDto(this.#assembleNetwork(key, agg, live, scheduler)));

    if (q) {
      const term = String(q).toLowerCase();
      items = items.filter(
        (i) => i.name.toLowerCase().includes(term) || i.key.toLowerCase().includes(term),
      );
    }
    if (integrationStatus) {
      items = items.filter((i) => i.integrationStatus === String(integrationStatus).toUpperCase());
    }
    if (connectionStatus) {
      items = items.filter((i) => i.connectionStatus === String(connectionStatus).toUpperCase());
    }
    if (dataHealth) {
      items = items.filter((i) => i.dataHealth === String(dataHealth).toUpperCase());
    }
    if (mappingStatus) {
      items = items.filter((i) => i.mapping?.status === String(mappingStatus).toUpperCase());
    }
    if (capability) {
      const cap = String(capability).toLowerCase();
      const want = capabilityState ? String(capabilityState).toUpperCase() : null;
      items = items.filter((i) => {
        const entry = i.capabilities?.[cap];
        if (!entry) return false;
        if (!want) {
          return (
            entry.state === CAPABILITY_STATE.AVAILABLE || entry.state === CAPABILITY_STATE.PARTIAL
          );
        }
        return entry.state === want;
      });
    }

    return {
      items,
      total: items.length,
      contract: "mbo-network-ops-v1",
      liveSync: live?.status === "running"
        ? { status: live.status, jobName: live.jobName, percentComplete: live.percentComplete ?? null }
        : { status: live?.status ?? "idle" },
      scheduler: {
        enabled: Boolean(scheduler?.enabled),
        intervalMinutes: scheduler?.intervalMinutes ?? null,
        lastAttemptAt: scheduler?.lastAttemptAt ?? null,
      },
    };
  }

  async getNetwork(keyOrId) {
    const agg = await this.#loadAggregateMaps();
    const live = this.getSyncStatusFn();
    const scheduler = this.getSchedulerStatusFn();

    let key = normalizeNetworkKey(keyOrId);
    if (!key) {
      const seed = agg.suppliers.find((s) => s.id === keyOrId);
      key = seed?.key ?? null;
    }
    if (!key || !listRegisteredSuppliers().includes(key)) {
      throw fail("Network not found.", 404);
    }

    const assembled = this.#assembleNetwork(key, agg, live, scheduler);
    assembled.sourceObjects = await this.sourceObjectSync.listForSupplier(key);
    return toNetworkDetailDto(assembled);
  }
}

export { DATA_HEALTH };
