/**
 * Pointer 9 — Campaign capability vs linked-record sync state.
 * Capability signals live on Campaign; actual records stay separate.
 */

export const CAMPAIGN_CAPABILITY_STATE = Object.freeze({
  SUPPORTED: "SUPPORTED",
  SUPPORTED_DATA_NOT_SYNCED: "SUPPORTED_DATA_NOT_SYNCED",
  NOT_SUPPORTED: "NOT_SUPPORTED",
  UNKNOWN: "UNKNOWN",
});

export const CAMPAIGN_LINKED_RECORD_TYPE = Object.freeze({
  SUPPLIER_COMMISSION_RULE: "SupplierCommissionRule",
  COUPON_VOUCHER: "CouponVoucher",
  TRACKING_LINK: "TrackingLink",
  OFFER_PROMOTION: "OfferPromotion",
  PRODUCT: "Product",
  SOURCE_DATA: "SourceData",
});

const STATE_LABELS = Object.freeze({
  SUPPORTED: "Supported",
  SUPPORTED_DATA_NOT_SYNCED: "Supported — Data Not Synced",
  NOT_SUPPORTED: "Not Supported",
  UNKNOWN: "Unknown",
});

export function campaignCapabilityStateLabel(state) {
  const key = String(state || "").toUpperCase();
  return STATE_LABELS[key] || STATE_LABELS.UNKNOWN;
}

/**
 * @param {{ signal?: boolean|null, syncedCount?: number|null, explicitNotSupported?: boolean }} input
 */
export function resolveCampaignCapabilityState({
  signal = null,
  syncedCount = 0,
  explicitNotSupported = false,
} = {}) {
  if (explicitNotSupported) return CAMPAIGN_CAPABILITY_STATE.NOT_SUPPORTED;
  if (signal === false) return CAMPAIGN_CAPABILITY_STATE.NOT_SUPPORTED;
  const count = Number(syncedCount) || 0;
  if (signal === true) {
    return count > 0
      ? CAMPAIGN_CAPABILITY_STATE.SUPPORTED
      : CAMPAIGN_CAPABILITY_STATE.SUPPORTED_DATA_NOT_SYNCED;
  }
  if (count > 0) return CAMPAIGN_CAPABILITY_STATE.SUPPORTED;
  return CAMPAIGN_CAPABILITY_STATE.UNKNOWN;
}

/**
 * @param {object} params
 * @param {string} params.key
 * @param {string} params.label
 * @param {string} params.linkedRecordType
 * @param {boolean|null} params.signal
 * @param {number|null} params.syncedCount
 * @param {boolean} [params.explicitNotSupported]
 */
export function buildCampaignCapabilityEntry({
  key,
  label,
  linkedRecordType,
  signal,
  syncedCount = 0,
  explicitNotSupported = false,
}) {
  const state = resolveCampaignCapabilityState({ signal, syncedCount, explicitNotSupported });
  return {
    key,
    label,
    linkedRecordType,
    signal: signal === true,
    signalKnown: signal != null,
    syncedCount: Number(syncedCount) || 0,
    state,
    displayStatus: state,
  };
}

/**
 * Build structured campaign capabilities from network signals and synced child counts.
 */
export function buildCampaignCapabilities({
  linkSignal = null,
  linkSyncedCount = 0,
  linkExplicitNotSupported = false,
  couponSignal = null,
  couponSyncedCount = 0,
  couponExplicitNotSupported = false,
  deeplinkSignal = null,
  deeplinkSyncedCount = 0,
  deeplinkExplicitNotSupported = false,
  feedSignal = null,
  feedSyncedCount = 0,
  feedExplicitNotSupported = false,
  commissionSignal = null,
  commissionSyncedCount = 0,
  commissionExplicitNotSupported = false,
  offerSignal = null,
  offerSyncedCount = 0,
} = {}) {
  const trackingLink = buildCampaignCapabilityEntry({
    key: "trackingLink",
    label: "Tracking Link",
    linkedRecordType: CAMPAIGN_LINKED_RECORD_TYPE.TRACKING_LINK,
    signal: linkSignal,
    syncedCount: linkSyncedCount,
    explicitNotSupported: linkExplicitNotSupported,
  });
  const coupon = buildCampaignCapabilityEntry({
    key: "coupon",
    label: "Coupon / Voucher",
    linkedRecordType: CAMPAIGN_LINKED_RECORD_TYPE.COUPON_VOUCHER,
    signal: couponSignal,
    syncedCount: couponSyncedCount,
    explicitNotSupported: couponExplicitNotSupported,
  });
  const deeplink = buildCampaignCapabilityEntry({
    key: "deeplink",
    label: "Deeplink",
    linkedRecordType: CAMPAIGN_LINKED_RECORD_TYPE.TRACKING_LINK,
    signal: deeplinkSignal,
    syncedCount: deeplinkSyncedCount,
    explicitNotSupported: deeplinkExplicitNotSupported,
  });
  const productFeed = buildCampaignCapabilityEntry({
    key: "productFeed",
    label: "Product / Feed",
    linkedRecordType: CAMPAIGN_LINKED_RECORD_TYPE.PRODUCT,
    signal: feedSignal,
    syncedCount: feedSyncedCount,
    explicitNotSupported: feedExplicitNotSupported,
  });
  const commissionRules = buildCampaignCapabilityEntry({
    key: "commissionRules",
    label: "Supplier Commission Rules",
    linkedRecordType: CAMPAIGN_LINKED_RECORD_TYPE.SUPPLIER_COMMISSION_RULE,
    signal: commissionSignal,
    syncedCount: commissionSyncedCount,
    explicitNotSupported: commissionExplicitNotSupported,
  });
  const offer = buildCampaignCapabilityEntry({
    key: "offer",
    label: "Offer / Promotion",
    linkedRecordType: CAMPAIGN_LINKED_RECORD_TYPE.OFFER_PROMOTION,
    signal: offerSignal,
    syncedCount: offerSyncedCount,
  });

  return {
    trackingLink,
    coupon,
    deeplink,
    productFeed,
    commissionRules,
    offer,
    /** @deprecated Prefer capabilities.* — legacy flat keys for filters */
    link: trackingLink,
    feed: productFeed,
  };
}

export function formatCampaignCapabilitiesSummary(capabilities) {
  if (!capabilities || typeof capabilities !== "object") return null;
  const parts = [];
  for (const entry of Object.values(capabilities)) {
    if (!entry || typeof entry !== "object" || !entry.label) continue;
    if (entry.state === CAMPAIGN_CAPABILITY_STATE.SUPPORTED) {
      parts.push(entry.syncedCount > 0 ? `${entry.label} (${entry.syncedCount})` : entry.label);
    } else if (entry.state === CAMPAIGN_CAPABILITY_STATE.SUPPORTED_DATA_NOT_SYNCED) {
      parts.push(`${entry.label} · not synced`);
    }
  }
  return parts.length ? parts.join(" · ") : null;
}

/** Any capability channel signal (for assignable / channel type). */
export function hasCampaignChannelSignal(capabilities) {
  if (!capabilities) return false;
  return ["trackingLink", "coupon", "deeplink"].some((key) => capabilities[key]?.signal === true);
}

export function capabilitySignalBoolean(entry) {
  return entry?.signal === true;
}
