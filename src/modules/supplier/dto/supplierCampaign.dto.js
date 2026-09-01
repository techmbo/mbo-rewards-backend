import { resolveBoostinyDefaultCommission } from "../mappers/boostiny.mapper.js";

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Extract a brand name from a campaign name when merchantNameRaw is unavailable.
 * Handles patterns like:
 *   "DAZN FRANCE Partners (RETIRED)" → "DAZN"
 *   "Passware | Password Recovery Software" → "Passware"
 *   "MindManager | Mind Mapping Software" → "MindManager"
 */
function extractBrandFromCampaignName(campaignName) {
  if (!campaignName || typeof campaignName !== "string") return null;
  const name = campaignName.trim();
  // Pattern: "Brand | Description"
  const pipePart = name.split("|")[0].trim();
  if (pipePart && pipePart !== name) return pipePart;
  // Pattern: "Brand Partners ..." or "Brand Affiliates ..."
  const keywordMatch = name.match(/^(.+?)\s+(?:Partners?|Affiliates?|Programme|Program|Network)\b/i);
  if (keywordMatch) return keywordMatch[1].trim();
  return null;
}

/**
 * Derive a website URL from merchantNameRaw if it looks like a domain.
 */
function deriveBrandWebsite(merchantNameRaw) {
  if (!merchantNameRaw || typeof merchantNameRaw !== "string") return null;
  const raw = merchantNameRaw.trim();
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]+[.][a-zA-Z]{2,}$/.test(raw)) {
    return "https://" + raw.toLowerCase();
  }
  return null;
}

function decimalToString(value) {
  return value?.toString?.() ?? value ?? null;
}

function resolveRecordGrossCommission(source, record) {
  if (source?.grossCommission != null && String(source.grossCommission).trim() !== "") {
    return decimalToString(source.grossCommission);
  }
  if (record?.defaultCommissionValue != null && String(record.defaultCommissionValue).trim() !== "") {
    return decimalToString(record.defaultCommissionValue);
  }
  if (String(record?.supplier || "").toUpperCase() === "BOOSTINY") {
    return resolveBoostinyDefaultCommission({ commissionGroups: record.commissionGroups });
  }
  return null;
}

function recordHasCommission(source, record) {
  const gross = resolveRecordGrossCommission(source, record);
  return gross != null && String(gross).trim() !== "";
}

function pickPrimaryCoupon(coupons = []) {
  if (!Array.isArray(coupons) || !coupons.length) return null;
  return coupons.find((c) => c.couponCode) || coupons[0];
}

function parseDiscountPercent(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function normalizeRelationship(raw) {
  if (raw == null || raw === "") return null;
  const v = String(raw).toUpperCase().trim();
  if (v === "JOINED" || v === "APPROVED") return v === "APPROVED" ? "APPROVED" : "JOINED";
  if (v === "NOT_JOINED" || v === "NOT_APPLIED") return "NOT_JOINED";
  if (v === "PENDING" || v === "REQUIRES_APPROVAL") return v;
  if (v === "REJECTED" || v === "SUSPENDED" || v === "UNKNOWN") return v;
  return "UNKNOWN";
}

function sourceSupportsDeeplink(source, record) {
  const channels = Array.isArray(source?.channelSupport) ? source.channelSupport : [];
  if (channels.some((c) => String(c).toUpperCase().includes("DEEP"))) return true;
  return Boolean(record?.deepLinkingEnabled);
}

function sourceHasCommission(source, record) {
  return recordHasCommission(source, record);
}

function deriveSourceAssignable(source, record) {
  const campaignStatus = String(record?.campaignStatus || "").toUpperCase();
  const relationshipStatus = normalizeRelationship(source?.relationshipStatus);
  const supportsLink = Boolean(source?.supportsLink) || Boolean(record?.trackingUrl);
  const supportsCoupon = Boolean(source?.supportsCoupon);
  const supportsDeeplink = sourceSupportsDeeplink(source, record);
  const commissionAvailable = sourceHasCommission(source, record);
  const hasCampaignSource = Boolean(source?.id);
  const statusOk = campaignStatus === "ACTIVE";
  const relOk = relationshipStatus === "JOINED" || relationshipStatus === "APPROVED";
  const channelOk = supportsLink || supportsCoupon || supportsDeeplink;
  const blockers = [];
  if (!hasCampaignSource) blockers.push("No campaign source");
  if (!statusOk) blockers.push("Campaign not ACTIVE");
  if (!relOk) blockers.push("Relationship not JOINED/APPROVED");
  if (!channelOk) blockers.push("No link/coupon/deeplink support");
  if (!commissionAvailable) blockers.push("No commission rule");
  return {
    isAssignable: hasCampaignSource && statusOk && relOk && channelOk && commissionAvailable,
    relationshipStatus: relationshipStatus || source?.relationshipStatus || null,
    supportsLink,
    supportsCoupon,
    supportsDeeplink,
    commissionAvailable,
    blockers,
  };
}

function mapCampaignSources(record) {
  const supplier = record.supplier;
  return (record.campaignSources ?? []).map((source) => {
    const eligibility = deriveSourceAssignable(source, record);
    return {
      id: source.id,
      canonicalCampaignId: source.canonicalCampaignId,
      supplierCampaignId: source.supplierCampaignId,
      priority: source.priority,
      isPrimary: source.isPrimary,
      relationshipStatus: eligibility.relationshipStatus || source.relationshipStatus,
      supportsLink: eligibility.supportsLink,
      supportsCoupon: eligibility.supportsCoupon,
      supportsDeeplink: eligibility.supportsDeeplink,
      commissionAvailable: eligibility.commissionAvailable,
      isAssignable: eligibility.isAssignable,
      assignabilityBlockers: eligibility.blockers,
      grossCommission: resolveRecordGrossCommission(source, record),
      channelSupport: source.channelSupport ?? [],
      isActive: source.isActive,
      status: source.status,
      networkSource: source.supplierCampaign?.supplier || supplier,
      supplier: source.supplierCampaign?.supplier || supplier,
      campaignName: record.campaignName ?? null,
      campaignStatus: record.campaignStatus ?? null,
      brandName:
        record.merchant?.displayName ||
        record.merchantNameRaw ||
        extractBrandFromCampaignName(record.campaignName) ||
        null,
      brandLogoUrl: record.merchant?.logoUrl || record.campaignLogoUrl || null,
    };
  });
}

export function toNetworkBrandDto(row) {
  if (!row) return null;
  const networkSources = Array.isArray(row.networkSources)
    ? row.networkSources
    : row.networkSources
      ? [row.networkSources]
      : [];
  return {
    id: row.id,
    merchantId: row.merchantId ?? null,
    displayName: row.displayName,
    logoUrl: row.logoUrl ?? null,
    website: row.website ?? null,
    category: row.category ?? null,
    primaryCategory: row.category ?? null,
    country: row.country ?? null,
    primaryCountry: row.country ?? null,
    status: row.status ?? "NETWORK",
    isVerified: Boolean(row.isVerified),
    networkSources,
    networks: networkSources.length,
    campaignCount: Number(row.campaignCount ?? 0),
    networkCampaignCount: Number(row.campaignCount ?? 0),
    masterCampaignCount: Number(row.masterCampaignCount ?? 0),
    couponCampaignCount: Number(row.couponCampaignCount ?? 0),
    linkCampaignCount: Number(row.linkCampaignCount ?? 0),
    productCampaignCount: Number(row.productCampaignCount ?? 0),
    activeCampaignCount: Number(row.activeCampaignCount ?? 0),
    lastSyncedAt: toIso(row.lastSyncedAt),
    lastUpdated: toIso(row.lastSyncedAt),
  };
}

export function toMasterSupplierCampaignDto(record) {
  const base = toSupplierCampaignDto(record);
  if (!base) return null;

  const merchant = record.merchant ?? null;
  const primaryCoupon = pickPrimaryCoupon(record.coupons);
  const sources = mapCampaignSources(record);
  const primarySource = sources.find((s) => s.isPrimary) || sources[0] || null;
  const bestSource =
    sources.find((s) => s.isAssignable && s.isPrimary) ||
    sources.find((s) => s.isAssignable) ||
    primarySource;
  const isAssignable = Boolean(bestSource?.isAssignable);
  const assignedCount = (record.campaignSources ?? []).reduce(
    (sum, source) => sum + Number(source._count?.assignments ?? 0),
    0,
  );
  const hasProducts = (record.campaignSources ?? []).some(
    (source) =>
      Number(source._count?.products ?? 0) > 0 || Number(source._count?.productFeeds ?? 0) > 0,
  );
  const commissionValue =
    base.defaultCommissionValue ??
    bestSource?.grossCommission ??
    primarySource?.grossCommission ??
    null;
  const commissionUnit = base.commissionUnit || "PERCENT";
  const commissionDisplay =
    commissionValue != null
      ? `${commissionValue}${commissionUnit === "PERCENT" || !commissionUnit ? "%" : ` ${commissionUnit}`}`
      : null;

  return {
    ...base,
    networkSource: record.supplier,
    isAssignable,
    relationshipStatus: bestSource?.relationshipStatus ?? null,
    supportsLink: bestSource?.supportsLink ?? Boolean(record.trackingUrl),
    supportsCoupon: bestSource?.supportsCoupon ?? false,
    supportsDeeplink: bestSource?.supportsDeeplink ?? Boolean(record.deepLinkingEnabled),
    commissionAvailable: bestSource?.commissionAvailable ?? recordHasCommission(bestSource, record),
    assignabilityBlockers: isAssignable ? [] : bestSource?.assignabilityBlockers || ["No campaign source"],
    brandName:
      merchant?.displayName ||
      record.merchantNameRaw ||
      extractBrandFromCampaignName(record.campaignName) ||
      null,
    brandLogoLink: merchant?.logoUrl || record.campaignLogoUrl || null,
    brandLogoUrl: merchant?.logoUrl || record.campaignLogoUrl || null,
    brandWebsite:
      merchant?.website ||
      deriveBrandWebsite(record.merchantNameRaw) ||
      null,
    countries: record.countryCodes ?? [],
    country: record.countryCodes ?? [],
    primaryCategory: merchant?.category || record.categoryName || null,
    couponCode: primaryCoupon?.couponCode ?? null,
    couponExpiry:
      toIso(primaryCoupon?.couponEndDate) ||
      record.normalizedPayload?.campaignEndDate ||
      null,
    campaignEndDate: record.normalizedPayload?.campaignEndDate ?? null,
    discountPercent: parseDiscountPercent(primaryCoupon?.discountValue),
    customerOffer:
      primaryCoupon?.couponDescription ||
      primaryCoupon?.discountValue ||
      record.campaignDescription ||
      null,
    campaignDescription: record.campaignDescription || primaryCoupon?.couponDescription || null,
    campaignTermsAndCondition:
      record.normalizedPayload?.termsAndConditions ||
      record.campaignDescription ||
      null,
    termsAndConditions:
      record.normalizedPayload?.termsAndConditions ||
      record.campaignDescription ||
      null,
    campaignChannelType: record.campaignType || null,
    catalogStatus: record.campaignStatus,
    sources,
    primaryCampaignSourceId: primarySource?.id ?? null,
    campaignSourceId: primarySource?.id ?? null,
    masterCampaignId: primarySource?.canonicalCampaignId || record.id,
    primarySourceId: record.supplierCampaignId || null,
    alternateSources: Math.max(0, sources.length - 1),
    commissionDisplay,
    hasCoupon: Boolean(primaryCoupon?.couponCode || bestSource?.supportsCoupon),
    hasLink: Boolean(
      bestSource?.supportsLink ||
        bestSource?.supportsDeeplink ||
        record.trackingUrl ||
        record.destinationUrl,
    ),
    hasProducts,
    assignedCount,
    merchant: merchant
      ? {
          id: merchant.id,
          displayName: merchant.displayName,
          logoUrl: merchant.logoUrl,
          website: merchant.website,
          category: merchant.category,
          country: merchant.country,
          status: merchant.status,
          isVerified: merchant.isVerified,
        }
      : undefined,
  };
}

export function toSupplierCampaignDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    supplier: record.supplier,
    supplierRegion: record.supplierRegion,
    supplierCampaignId: record.supplierCampaignId,
    sourceAccountLabel: record.sourceAccountLabel,
    campaignName: record.campaignName,
    campaignDescription: record.campaignDescription,
    campaignLogoUrl: record.campaignLogoUrl,
    merchantId: record.merchantId,
    matchedAt: toIso(record.matchedAt),
    matchedBy: record.matchedBy,
    matchConfidence: decimalToString(record.matchConfidence),
    merchantNameRaw: record.merchantNameRaw,
    merchantVertical: record.merchantVertical,
    categoryName: record.categoryName,
    campaignType: record.campaignType,
    pricingModel: record.pricingModel,
    defaultCommissionValue:
      decimalToString(record.defaultCommissionValue) ??
      (String(record.supplier || "").toUpperCase() === "BOOSTINY"
        ? resolveBoostinyDefaultCommission({ commissionGroups: record.commissionGroups })
        : null),
    commissionUnit: record.commissionUnit,
    commissionCurrency: record.commissionCurrency,
    commissionGroups: record.commissionGroups,
    trackingUrl: record.trackingUrl,
    destinationUrl: record.destinationUrl,
    mboTrackingSlug: record.mboTrackingSlug,
    mboTrackingToken: record.mboTrackingToken,
    mboTrackingUrl: record.mboTrackingUrl,
    deepLinkingEnabled: record.deepLinkingEnabled,
    cookieDurationDays: record.cookieDurationDays,
    campaignStatus: record.campaignStatus,
    participationStatus: record.participationStatus,
    isJoined: record.isJoined,
    countryCodes: record.countryCodes ?? [],
    currencyCode: record.currencyCode,
    campaignStartDate: toIso(record.campaignStartDate),
    firstSeenAt: toIso(record.firstSeenAt),
    lastSyncedAt: toIso(record.lastSyncedAt),
    entityId: record.entityId,
    rawPayload: record.rawPayload,
    normalizedPayload: record.normalizedPayload,
    mapperVersion: record.mapperVersion,
    syncConflict: record.syncConflict,
    adminOverrides: record.adminOverrides,
    fieldPolicies: record.fieldPolicies,
    archivedAt: toIso(record.archivedAt),
    supplierRefId: record.supplierRefId,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export function toSupplierCampaignSummaryDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    supplier: record.supplier,
    supplierRegion: record.supplierRegion,
    supplierCampaignId: record.supplierCampaignId,
    sourceAccountLabel: record.sourceAccountLabel,
    campaignName: record.campaignName,
    merchantNameRaw: record.merchantNameRaw,
    campaignStatus: record.campaignStatus,
    participationStatus: record.participationStatus,
    isJoined: record.isJoined,
    lastSyncedAt: toIso(record.lastSyncedAt),
    archivedAt: toIso(record.archivedAt),
  };
}
