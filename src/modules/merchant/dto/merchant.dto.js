function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function decimalToString(value) {
  return value?.toString?.() ?? value ?? null;
}

/** Prefer a confirmed MANUAL alias; else any confirmed alias. */
export function resolveNetworkSource(record) {
  const aliases = record?.aliases ?? [];
  const manual = aliases.find((a) => a.source === "MANUAL" && a.status === "CONFIRMED");
  if (manual?.supplier) return manual.supplier;
  const confirmed = aliases.find((a) => a.status === "CONFIRMED");
  return confirmed?.supplier ?? null;
}

export function toMerchantDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    displayName: record.displayName,
    normalizedName: record.normalizedName,
    slug: record.slug,
    website: record.website,
    supplierTrackingLink: record.supplierTrackingLink ?? null,
    couponDescription: record.couponDescription ?? null,
    category: record.category ?? null,
    logoUrl: record.logoUrl,
    country: record.country,
    status: record.status,
    verificationStatus: record.verificationStatus,
    isVerified: record.isVerified,
    notes: record.notes,
    networkSource: resolveNetworkSource(record),
    mergedIntoId: record.mergedIntoId,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    deletedAt: toIso(record.deletedAt),
  };
}

export function toMerchantSummaryDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    displayName: record.displayName,
    normalizedName: record.normalizedName,
    slug: record.slug,
    status: record.status,
    isVerified: record.isVerified,
    country: record.country,
    category: record.category ?? null,
    logoUrl: record.logoUrl ?? null,
    website: record.website ?? null,
    networkSource: resolveNetworkSource(record),
  };
}

export function toMerchantReviewDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    supplierCampaignId: record.supplierCampaignId,
    merchantId: record.merchantId,
    merchantNameRaw: record.merchantNameRaw,
    supplier: record.supplier,
    status: record.status,
    confidence: decimalToString(record.confidence),
    matchMethod: record.matchMethod,
    reviewedBy: record.reviewedBy,
    reviewedAt: toIso(record.reviewedAt),
    notes: record.notes,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export function toMatchResultDto(result) {
  return {
    supplierCampaignId: result.supplierCampaignId,
    outcome: result.outcome,
    merchantId: result.merchantId ?? null,
    confidence: result.confidence ?? null,
    matchMethod: result.matchMethod ?? null,
    reviewId: result.reviewId ?? null,
    reviewStatus: result.reviewStatus ?? null,
  };
}
