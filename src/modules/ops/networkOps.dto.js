/**
 * Network ops DTO — safe for admin UI. Never includes secrets or credential payloads.
 */

import { iso } from "./v15FieldContract.js";

const FORBIDDEN_KEYS = [
  "encryptedAccessToken",
  "encryptedRefreshToken",
  "apiKey",
  "apiSecret",
  "authToken",
  "password",
  "secret",
  "config",
  "publisherProfile",
  "email",
  "phone",
];

export function assertNoSecrets(dto) {
  const blob = JSON.stringify(dto);
  for (const key of FORBIDDEN_KEYS) {
    if (new RegExp(`"${key}"\\s*:`).test(blob)) {
      throw new Error(`Network DTO must not expose ${key}`);
    }
  }
  return dto;
}

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
    accounts: (row.accounts || []).map((a) => ({
      platform: a.platform,
      accountLabel: a.accountLabel,
      authType: a.authType,
      credentialsConfigured: Boolean(a.credentialsConfigured),
      maskedApiKey: a.maskedApiKey ?? null,
      connectedAt: iso(a.connectedAt),
      lastSuccessfulSync: iso(a.lastSuccessfulSync),
      lastCampaignSyncAt: iso(a.lastCampaignSyncAt),
      lastCouponSyncAt: iso(a.lastCouponSyncAt),
      lastOrderSyncAt: iso(a.lastOrderSyncAt),
      lastPaymentSyncAt: iso(a.lastPaymentSyncAt),
      syncFrequencyMinutes: a.syncFrequencyMinutes ?? null,
      lastAuthCheckAt: iso(a.lastAuthCheckAt),
      lastSyncError: a.lastSyncError ?? null,
      tokenExpiresAt: iso(a.tokenExpiresAt),
    })),
  });
}
