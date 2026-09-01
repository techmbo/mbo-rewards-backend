function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function decimalToString(value) {
  return value?.toString?.() ?? value ?? null;
}

export function toTrackingLinkDto(record) {
  if (!record) return null;

  const assignment = record.assignment || null;
  const campaign = assignment?.canonicalCampaign || null;
  const merchant = campaign?.merchant || null;
  const client = assignment?.client || null;
  const clickCount = record._count?.clicks ?? record.clickCount ?? null;
  const supplierCampaign =
    record.campaignSource?.supplierCampaign ||
    assignment?.campaignSource?.supplierCampaign ||
    null;

  return {
    id: record.id,
    assignmentId: record.assignmentId,
    campaignSourceId: record.campaignSourceId,
    slug: record.slug ?? null,
    subId: record.subId,
    token: record.subId,
    supplierTrackingUrl: record.supplierTrackingUrl,
    mboTrackingUrl: record.mboTrackingUrl,
    deeplinkTemplate: record.deeplinkTemplate,
    trackingType: record.trackingType,
    status: record.status,
    isPrimary: record.isPrimary,
    expiresAt: toIso(record.expiresAt),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    deletedAt: toIso(record.deletedAt),
    clickCount,
    supplier: supplierCampaign?.supplier ?? null,
    client: client
      ? { id: client.id, name: client.name, slug: client.slug, status: client.status }
      : null,
    campaign: campaign
      ? {
          id: campaign.id,
          displayName: campaign.displayName,
          brand: merchant?.displayName ?? null,
          merchantId: campaign.merchantId ?? merchant?.id ?? null,
        }
      : null,
    brand: merchant?.displayName ?? null,
    assignmentStatus: assignment?.status ?? null,
    assignmentPublished: assignment?.published ?? null,
  };
}

export function toCouponAssignmentDto(record) {
  if (!record) return null;
  return {
    id: record.id,
    assignmentId: record.assignmentId,
    supplierCouponId: record.supplierCouponId,
    supplierCouponCode: record.supplierCouponCode,
    clientCouponCode: record.clientCouponCode,
    couponType: record.couponType,
    discountPercentage: record.discountPercentage ?? null,
    status: record.status,
    validFrom: toIso(record.validFrom),
    validUntil: toIso(record.validUntil),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export function toCommissionRuleDto(record) {
  if (!record) return null;
  return {
    id: record.id,
    assignmentId: record.assignmentId,
    grossCommission: decimalToString(record.grossCommission),
    clientCommission: decimalToString(record.clientCommission),
    mboCommission: decimalToString(record.mboCommission),
    commissionType: record.commissionType,
    currency: record.currency,
    orderValuePercent: decimalToString(record.orderValuePercent),
    fixedAmount: decimalToString(record.fixedAmount),
    manualAmount: decimalToString(record.manualAmount),
    manualApproved: Boolean(record.manualApproved),
    manualApprovedAt: toIso(record.manualApprovedAt),
    manualApprovedBy: record.manualApprovedBy ?? null,
    displayRangeMin: decimalToString(record.displayRangeMin),
    displayRangeMax: decimalToString(record.displayRangeMax),
    displayLabel: record.displayLabel ?? null,
    effectiveFrom: toIso(record.effectiveFrom),
    effectiveUntil: toIso(record.effectiveUntil),
    status: record.status,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}
