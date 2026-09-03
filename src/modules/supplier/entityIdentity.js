/**
 * Parse Phase 1 Entity identity into Wave 1 supplier dimensions.
 * @see PHASE2_MBO_CANONICAL_SCHEMA.md §6
 */

export function parseSourceAccountLabel(externalId) {
  const value = String(externalId ?? "");
  const colonIndex = value.indexOf(":");
  if (colonIndex > 0) {
    return {
      sourceAccountLabel: value.slice(0, colonIndex),
      localExternalId: value.slice(colonIndex + 1),
    };
  }
  return { sourceAccountLabel: "default", localExternalId: value };
}

export function parseNetworkSource(networkSource) {
  const source = String(networkSource ?? "").toLowerCase();

  if (source === "boostiny") {
    return { supplier: "BOOSTINY", supplierRegion: "GLOBAL" };
  }
  if (source === "trackier" || source === "vcommission") {
    return { supplier: "TRACKIER", supplierRegion: "GLOBAL" };
  }
  if (source === "partnerize") {
    return { supplier: "PARTNERIZE", supplierRegion: "GLOBAL" };
  }
  if (source === "impact" || source === "impact_com" || source === "mediapartner") {
    return { supplier: "IMPACT", supplierRegion: "GLOBAL" };
  }
  if (source === "awin") {
    return { supplier: "AWIN", supplierRegion: "GLOBAL" };
  }
  if (source === "admitad") {
    return { supplier: "ADMITAD", supplierRegion: "GLOBAL" };
  }
  if (source === "cj") {
    return { supplier: "CJ", supplierRegion: "GLOBAL" };
  }
  if (source === "rakuten") {
    return { supplier: "RAKUTEN", supplierRegion: "GLOBAL" };
  }
  if (source.startsWith("optimise_")) {
    const regionToken = source.replace("optimise_", "").toUpperCase();
    const regionMap = { SEA: "SEA", MENA: "MENA", UK: "UK", GLOBAL: "GLOBAL" };
    return {
      supplier: "OPTIMISE",
      supplierRegion: regionMap[regionToken] || "UNKNOWN",
    };
  }
  if (source.startsWith("optimise")) {
    return { supplier: "OPTIMISE", supplierRegion: "UNKNOWN" };
  }

  return { supplier: "UNKNOWN", supplierRegion: "UNKNOWN" };
}

const CAMPAIGN_PREFIX_PATTERNS = [
  /^[\w]+-campaign-(.+)$/,
  /^boostiny-campaign-(.+)$/,
  /^trackier-campaign-(.+)$/,
];

const COUPON_PREFIX_PATTERNS = [
  /^[\w]+-coupon-(.+)$/,
  /^[\w]+-voucher-(.+)$/,
  /^boostiny-coupon-(.+)$/,
  /^trackier-coupon-(.+)$/,
];

function stripPrefix(localExternalId, patterns) {
  for (const pattern of patterns) {
    const match = String(localExternalId).match(pattern);
    if (match?.[1]) return match[1];
  }
  return String(localExternalId);
}

export function extractSupplierCampaignId(networkSource, externalId) {
  const { localExternalId } = parseSourceAccountLabel(externalId);
  const prefixed = `${networkSource}-campaign-`;
  if (localExternalId.startsWith(prefixed)) {
    return localExternalId.slice(prefixed.length);
  }
  return stripPrefix(localExternalId, CAMPAIGN_PREFIX_PATTERNS);
}

export function extractSupplierCouponId(networkSource, externalId) {
  const { localExternalId } = parseSourceAccountLabel(externalId);
  const couponPrefix = `${networkSource}-coupon-`;
  const voucherPrefix = `${networkSource}-voucher-`;
  if (localExternalId.startsWith(couponPrefix)) {
    return localExternalId.slice(couponPrefix.length);
  }
  if (localExternalId.startsWith(voucherPrefix)) {
    return localExternalId.slice(voucherPrefix.length);
  }
  return stripPrefix(localExternalId, COUPON_PREFIX_PATTERNS);
}

export function resolveCampaignIdFromCouponRaw(rawData) {
  const value =
    rawData?.campaign_id ??
    rawData?.campaignId ??
    rawData?.productId ??
    rawData?.campaign?.id ??
    rawData?.campaign?.campaign_id ??
    null;
  return value != null && value !== "" ? String(value) : null;
}
