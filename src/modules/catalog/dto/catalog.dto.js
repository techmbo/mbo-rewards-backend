function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function decimalToString(value) {
  return value?.toString?.() ?? value ?? null;
}

export function toCanonicalCampaignDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    merchantId: record.merchantId,
    displayName: record.displayName,
    status: record.status,
    visibility: record.visibility,
    category: record.category,
    countries: record.countries ?? [],
    defaultCurrency: record.defaultCurrency,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    deletedAt: toIso(record.deletedAt),
  };
}

export function toCanonicalCampaignSummaryDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    merchantId: record.merchantId,
    displayName: record.displayName,
    status: record.status,
    visibility: record.visibility,
    category: record.category,
    countries: record.countries ?? [],
    defaultCurrency: record.defaultCurrency,
  };
}

export function toCampaignSourceDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    canonicalCampaignId: record.canonicalCampaignId,
    supplierCampaignId: record.supplierCampaignId,
    priority: record.priority,
    isPrimary: record.isPrimary,
    relationshipStatus: record.relationshipStatus,
    supportsLink: record.supportsLink,
    supportsCoupon: record.supportsCoupon,
    grossCommission: decimalToString(record.grossCommission),
    channelSupport: record.channelSupport ?? [],
    isActive: record.isActive,
    status: record.status,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    supplierCampaign: record.supplierCampaign
      ? {
          id: record.supplierCampaign.id,
          supplier: record.supplierCampaign.supplier,
          supplierRegion: record.supplierCampaign.supplierRegion,
          campaignName: record.supplierCampaign.campaignName,
          merchantNameRaw: record.supplierCampaign.merchantNameRaw,
          campaignStatus: record.supplierCampaign.campaignStatus,
          participationStatus: record.supplierCampaign.participationStatus,
          isJoined: record.supplierCampaign.isJoined,
        }
      : undefined,
  };
}

export function toSourceSelectionDto(selection) {
  return {
    primary: selection.primary ? toCampaignSourceDto(selection.primary) : null,
    secondary: selection.secondary.map((row) => toCampaignSourceDto(row)),
    inactive: selection.inactive.map((row) => toCampaignSourceDto(row)),
    recommendation: selection.recommendation,
  };
}

export function toCatalogDetailDto(record, selection) {
  const campaign = toCanonicalCampaignDto(record);
  if (!campaign) return null;

  return {
    ...campaign,
    sources: record.sources?.map((source) => toCampaignSourceDto(source)) ?? [],
    routing: selection ? toSourceSelectionDto(selection) : null,
  };
}
