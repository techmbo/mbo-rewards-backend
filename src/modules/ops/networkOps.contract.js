/**
 * Network (supplier integration) contract helpers.
 * Statuses are evidence-based — a Supplier row alone never implies CONNECTED/HEALTHY/MAPPED.
 */

import { SUPPLIER_CAPABILITY_CATALOG } from "../../adapters/registry.js";
import { SUPPLIER_CAPABILITIES } from "../../adapters/contract.js";
import { getTrackingParamRule, TRACKING_PARAM_CONFIRMATION } from "../tracking/trackingParamRules.js";

/** MarketplaceAccount.platform values that map to a SupplierKey. */
export const NETWORK_PLATFORM_MAP = Object.freeze({
  boostiny: "BOOSTINY",
  optimise_sea: "OPTIMISE",
  optimise_mena: "OPTIMISE",
  optimise_uk: "OPTIMISE",
  trackier: "TRACKIER",
  partnerize: "PARTNERIZE",
  impact: "IMPACT",
  awin: "AWIN",
});

/** Platforms accepted by POST /sync/:platform (manual sync). */
export const MANUAL_SYNC_PLATFORMS = Object.freeze({
  BOOSTINY: ["boostiny"],
  OPTIMISE: ["optimise_sea", "optimise_mena", "optimise_uk"],
  TRACKIER: ["trackier"],
  PARTNERIZE: ["partnerize"],
  IMPACT: ["impact"],
  AWIN: ["awin"],
});

/** Entity.networkSource values that roll up to a SupplierKey. */
export const ENTITY_NETWORK_SOURCES = Object.freeze({
  BOOSTINY: ["boostiny"],
  OPTIMISE: ["optimise_sea", "optimise_mena", "optimise_uk", "optimise"],
  TRACKIER: ["trackier", "vcommission"],
  PARTNERIZE: ["partnerize"],
  IMPACT: ["impact"],
  AWIN: ["awin"],
});

export const CAPABILITY_STATE = Object.freeze({
  AVAILABLE: "AVAILABLE",
  PARTIAL: "PARTIAL",
  UNAVAILABLE: "UNAVAILABLE",
  NOT_CONFIGURED: "NOT_CONFIGURED",
});

export const CONNECTION_STATUS = Object.freeze({
  CONNECTED: "CONNECTED",
  NOT_CONFIGURED: "NOT_CONFIGURED",
  PLANNED: "PLANNED",
});

export const SYNC_STATUS = Object.freeze({
  SYNCING: "SYNCING",
  SYNCED: "SYNCED",
  PARTIAL: "PARTIAL",
  ERROR: "ERROR",
  NEVER: "NEVER",
  IDLE: "IDLE",
});

export const DATA_HEALTH = Object.freeze({
  HEALTHY: "HEALTHY",
  PARTIAL: "PARTIAL",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  ERROR: "ERROR",
  NO_RECENT_DATA: "NO_RECENT_DATA",
  NOT_CONFIGURED: "NOT_CONFIGURED",
});

export const MAPPING_STATUS = Object.freeze({
  NEEDS_REVIEW: "NEEDS_REVIEW",
  ERROR: "ERROR",
  UNAVAILABLE: "UNAVAILABLE",
});

const UI_RESOURCES = [
  "campaigns",
  "coupons",
  "tracking",
  "conversions",
  "performance",
  "orders",
  "payments",
];

const RESOURCE_TO_CAPS = {
  campaigns: [SUPPLIER_CAPABILITIES.CAMPAIGNS],
  coupons: [SUPPLIER_CAPABILITIES.COUPONS],
  tracking: [SUPPLIER_CAPABILITIES.TRACKING_SUBID, SUPPLIER_CAPABILITIES.DEEP_LINK],
  conversions: [SUPPLIER_CAPABILITIES.CONVERSIONS],
  performance: [SUPPLIER_CAPABILITIES.REPORTING],
  orders: [SUPPLIER_CAPABILITIES.ORDER_ITEMS, SUPPLIER_CAPABILITIES.CONVERSIONS],
  payments: [SUPPLIER_CAPABILITIES.PAYMENTS, SUPPLIER_CAPABILITIES.INVOICES],
};

export function normalizeNetworkKey(value) {
  if (!value) return null;
  const key = String(value).trim().toUpperCase();
  if (key === "VCOMMISSION") return "TRACKIER";
  if (key === "MEDIAPARTNER" || key === "IMPACT_COM") return "IMPACT";
  if (SUPPLIER_CAPABILITY_CATALOG[key]) return key;
  return null;
}

export function supplierKeyFromPlatform(platform) {
  if (!platform) return null;
  return NETWORK_PLATFORM_MAP[String(platform).trim().toLowerCase()] ?? null;
}

export function entitySourcesForSupplier(supplierKey) {
  return ENTITY_NETWORK_SOURCES[supplierKey] || [];
}

export function platformsForSupplier(supplierKey) {
  return MANUAL_SYNC_PLATFORMS[supplierKey] || [];
}

/**
 * Capability badge state for a UI resource.
 * @param {string} supplierKey
 * @param {string} resource
 * @param {{ hasCredentials: boolean }} ctx
 */
export function resolveCapabilityState(supplierKey, resource, { hasCredentials = false } = {}) {
  const catalog = SUPPLIER_CAPABILITY_CATALOG[supplierKey];
  if (!catalog) return CAPABILITY_STATE.UNAVAILABLE;
  const caps = catalog.capabilities || [];
  const needed = RESOURCE_TO_CAPS[resource] || [];
  const supported = needed.some((c) => caps.includes(c));

  if (!supported) {
    // Performance may still arrive via CONVERSIONS for networks without REPORTING.
    if (resource === "performance" && caps.includes(SUPPLIER_CAPABILITIES.CONVERSIONS)) {
      return hasCredentials ? CAPABILITY_STATE.PARTIAL : CAPABILITY_STATE.NOT_CONFIGURED;
    }
    if (resource === "tracking") {
      const rule = getTrackingParamRule(supplierKey);
      if (rule.confirmation === TRACKING_PARAM_CONFIRMATION.DISABLED) {
        return CAPABILITY_STATE.UNAVAILABLE;
      }
      if (!hasCredentials) return CAPABILITY_STATE.NOT_CONFIGURED;
      if (rule.confirmation === TRACKING_PARAM_CONFIRMATION.UNCONFIRMED) {
        return CAPABILITY_STATE.PARTIAL;
      }
      // Confirmed params but not in adapter capability list still count as partial tracking support.
      return CAPABILITY_STATE.PARTIAL;
    }
    return CAPABILITY_STATE.UNAVAILABLE;
  }

  if (!hasCredentials) return CAPABILITY_STATE.NOT_CONFIGURED;

  if (resource === "tracking") {
    const rule = getTrackingParamRule(supplierKey);
    if (rule.confirmation !== TRACKING_PARAM_CONFIRMATION.CONFIRMED) {
      return CAPABILITY_STATE.PARTIAL;
    }
    if ((rule.verificationFlags || []).length > 0) {
      return CAPABILITY_STATE.PARTIAL;
    }
  }

  return CAPABILITY_STATE.AVAILABLE;
}

export function buildCapabilities(supplierKey, { hasCredentials = false } = {}) {
  const out = {};
  for (const resource of UI_RESOURCES) {
    out[resource] = resolveCapabilityState(supplierKey, resource, { hasCredentials });
  }
  return out;
}

/**
 * Connection from credentials evidence only — never from Supplier.status alone.
 */
export function deriveConnectionStatus({ seedStatus, hasCredentials }) {
  if (hasCredentials) return CONNECTION_STATUS.CONNECTED;
  if (String(seedStatus || "").toUpperCase() === "PLANNED") return CONNECTION_STATUS.PLANNED;
  return CONNECTION_STATUS.NOT_CONFIGURED;
}

/**
 * Sync status from account timestamps + live job + recent log.
 */
export function deriveSyncStatus({
  lastSuccessfulSync,
  isSyncing = false,
  lastLogStatus = null,
  hasCredentials = false,
} = {}) {
  if (isSyncing) return SYNC_STATUS.SYNCING;
  if (!hasCredentials) return SYNC_STATUS.NEVER;
  const log = String(lastLogStatus || "").toLowerCase();
  if (log === "failed" || log === "error") return SYNC_STATUS.ERROR;
  if (log === "partial") return SYNC_STATUS.PARTIAL;
  if (lastSuccessfulSync) return SYNC_STATUS.SYNCED;
  return SYNC_STATUS.NEVER;
}

/**
 * Conservative data health — imported-without-linked is never fully HEALTHY.
 * When activePromotedCampaigns is provided, linkage is judged against active catalog
 * rows only (archived/retired imports do not block SYNCED).
 */
export function deriveDataHealth({
  hasCredentials,
  syncStatus,
  importedCampaigns = 0,
  linkedCampaigns = 0,
  activePromotedCampaigns = null,
  openMapperErrors = 0,
  lastSuccessfulSync = null,
} = {}) {
  if (!hasCredentials) return DATA_HEALTH.NOT_CONFIGURED;
  if (syncStatus === SYNC_STATUS.ERROR || openMapperErrors > 0) {
    return openMapperErrors > 0 && syncStatus !== SYNC_STATUS.ERROR
      ? DATA_HEALTH.NEEDS_REVIEW
      : DATA_HEALTH.ERROR;
  }
  if (!lastSuccessfulSync && importedCampaigns === 0) return DATA_HEALTH.NO_RECENT_DATA;

  const staleMs = 7 * 24 * 60 * 60 * 1000;
  if (lastSuccessfulSync) {
    const t = new Date(lastSuccessfulSync).getTime();
    if (Number.isFinite(t) && Date.now() - t > staleMs && importedCampaigns === 0) {
      return DATA_HEALTH.NO_RECENT_DATA;
    }
  }

  const catalogCampaigns =
    activePromotedCampaigns != null &&
    Number.isFinite(Number(activePromotedCampaigns)) &&
    Number(activePromotedCampaigns) > 0
      ? Number(activePromotedCampaigns)
      : importedCampaigns;

  if (catalogCampaigns > 0 && linkedCampaigns === 0) return DATA_HEALTH.NEEDS_REVIEW;
  if (catalogCampaigns > 0 && linkedCampaigns > 0 && linkedCampaigns < catalogCampaigns) {
    return DATA_HEALTH.PARTIAL;
  }
  if (catalogCampaigns > 0 && linkedCampaigns >= catalogCampaigns) return DATA_HEALTH.HEALTHY;
  if (lastSuccessfulSync) return DATA_HEALTH.PARTIAL;
  return DATA_HEALTH.NO_RECENT_DATA;
}

/**
 * Mapping honesty — never invent MAPPED.
 */
export function deriveMappingStatus({ openMapperErrors = 0, importedCampaigns = 0, linkedCampaigns = 0 } = {}) {
  if (openMapperErrors > 0) return MAPPING_STATUS.ERROR;
  if (importedCampaigns > 0 || linkedCampaigns > 0) return MAPPING_STATUS.NEEDS_REVIEW;
  return MAPPING_STATUS.UNAVAILABLE;
}

export function deriveIntegrationStatus({
  connectionStatus,
  syncStatus,
  dataHealth,
} = {}) {
  if (syncStatus === SYNC_STATUS.SYNCING) return "SYNCING";
  if (syncStatus === SYNC_STATUS.ERROR || dataHealth === DATA_HEALTH.ERROR) return "ERROR";
  if (connectionStatus === CONNECTION_STATUS.PLANNED) return "PLANNED";
  if (connectionStatus === CONNECTION_STATUS.NOT_CONFIGURED) return "NOT_CONFIGURED";
  if (dataHealth === DATA_HEALTH.NEEDS_REVIEW || dataHealth === DATA_HEALTH.PARTIAL) return "PARTIAL";
  if (syncStatus === SYNC_STATUS.SYNCED) return "SYNCED";
  if (connectionStatus === CONNECTION_STATUS.CONNECTED) return "CONNECTED";
  return "NOT_CONFIGURED";
}

export function displayNameForKey(key, seedName) {
  if (seedName) return seedName;
  const names = {
    BOOSTINY: "Boostiny",
    OPTIMISE: "Optimise",
    TRACKIER: "Trackier / vCommission",
    PARTNERIZE: "Partnerize",
    IMPACT: "Impact",
  };
  return names[key] || key;
}

export { UI_RESOURCES, SUPPLIER_CAPABILITIES };
