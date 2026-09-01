/**
 * Network ops DTO — safe for admin UI. Never includes secrets or credential payloads.
 */

import { iso } from "./v15FieldContract.js";
import { assertNoSecrets, toNetworkAccountDto } from "../networkOps/networkAccount.contract.js";
import { toSyncRunDto } from "../networkOps/syncRun.contract.js";

export { assertNoSecrets, toNetworkAccountDto };

function capabilityEntry(state) {
  return { state: state ?? null };
}

/**
 * @param {object} row — assembled by NetworkOpsService
 */
export function toNetworkListDto(row) {
  const dto = {
    id: row.id ?? null,
    key: row.key,
    name: row.name,
    integrationStatus: row.integrationStatus ?? null,
    connectionStatus: row.connectionStatus ?? null,
    syncStatus: row.syncStatus ?? null,
    dataHealth: row.dataHealth ?? null,
    lastSuccessfulSync: iso(row.lastSuccessfulSync),
    lastAttemptedSync: iso(row.lastAttemptedSync),
    lastCampaignSyncAt: iso(row.lastCampaignSyncAt),
    lastCouponSyncAt: iso(row.lastCouponSyncAt),
    lastOrderSyncAt: iso(row.lastOrderSyncAt),
    lastPaymentSyncAt: iso(row.lastPaymentSyncAt),
    syncFrequencyMinutes: row.syncFrequencyMinutes ?? null,
    openErrors: row.metrics?.openMapperErrors ?? null,
    credentialsConfigured: Boolean(row.credentialsConfigured),
    accountCount: row.accountCount ?? 0,
    regions: row.regions ?? [],
    manualSyncSupported: Boolean(row.manualSyncSupported),
    syncPlatforms: row.syncPlatforms ?? [],
    capabilities: {
      campaigns: capabilityEntry(row.capabilities?.campaigns),
      coupons: capabilityEntry(row.capabilities?.coupons),
      tracking: capabilityEntry(row.capabilities?.tracking),
      conversions: capabilityEntry(row.capabilities?.conversions),
      performance: capabilityEntry(row.capabilities?.performance),
      orders: capabilityEntry(row.capabilities?.orders),
      payments: capabilityEntry(row.capabilities?.payments),
    },
    metrics: {
      importedCampaigns: row.metrics?.importedCampaigns ?? null,
      importedCoupons: row.metrics?.importedCoupons ?? null,
      importedPerformance: row.metrics?.importedPerformance ?? null,
      promotedCampaigns: row.metrics?.promotedCampaigns ?? null,
      linkedCampaigns: row.metrics?.linkedCampaigns ?? null,
      assignableCampaigns: row.metrics?.assignableCampaigns ?? null,
      merchants: row.metrics?.merchants ?? null,
      openMapperErrors: row.metrics?.openMapperErrors ?? null,
    },
    mapping: {
      status: row.mapping?.status ?? null,
      issues: row.mapping?.issues ?? [],
    },
    seedStatus: row.seedStatus ?? null,
    catalogNotes: row.catalogNotes ?? [],
    updatedAt: iso(row.updatedAt),
  };
  return assertNoSecrets(dto);
}

export function toNetworkDetailDto(row) {
  const list = toNetworkListDto(row);
  return assertNoSecrets({
    ...list,
    coverage: row.coverage ?? null,
    syncHealth: {
      lastSuccessfulSync: iso(row.syncHealth?.lastSuccessfulSync),
      lastFailedSync: iso(row.syncHealth?.lastFailedSync),
      lastSyncJobStatus: row.syncHealth?.lastSyncJobStatus ?? null,
      lastSyncMessage: row.syncHealth?.lastSyncMessage ?? null,
      durationMs: row.syncHealth?.durationMs ?? null,
      recordsProcessed: row.syncHealth?.recordsProcessed ?? null,
      recordsCreated: row.syncHealth?.recordsCreated ?? null,
      recordsUpdated: row.syncHealth?.recordsUpdated ?? null,
      recordsRejected: row.syncHealth?.recordsRejected ?? null,
      errorCount: row.syncHealth?.errorCount ?? null,
      liveSync: row.syncHealth?.liveSync ?? null,
      scheduler: row.syncHealth?.scheduler ?? null,
    },
    pipeline: row.pipeline ?? [],
    tracking: row.tracking ?? null,
    accounts: (row.accounts || []).map((a) => toNetworkAccountDto(a)).filter(Boolean),
    sourceObjects: (row.sourceObjects || []).map((item) => ({
      sourceObject: item.sourceObject ?? null,
      label: item.label ?? null,
      endpoint: item.endpoint ?? null,
      live: Boolean(item.live),
      availability: item.availability ?? null,
      entityType: item.entityType ?? null,
      notes: item.notes ?? null,
      lastRun: item.lastRun
        ? toSyncRunDto({
            id: item.lastRun.syncRunId ?? item.lastRun.id,
            network: item.lastRun.network,
            networkAccountId: item.lastRun.networkAccountId,
            sourceObject: item.lastRun.sourceObject,
            endpoint: item.lastRun.endpoint,
            status: item.lastRun.status,
            recordCount: item.lastRun.recordCount,
            errorCode: item.lastRun.errorCode,
            errorMessage: item.lastRun.errorMessage,
            startedAt: item.lastRun.startedAt,
            finishedAt: item.lastRun.finishedAt,
            availability: item.lastRun.availability,
            label: item.lastRun.label,
          })
        : null,
    })),
  });
}
