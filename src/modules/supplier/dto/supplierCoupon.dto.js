function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toSupplierCouponDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    supplierCampaignId: record.supplierCampaignId,
    entityId: record.entityId,
    supplierCouponId: record.supplierCouponId,
    couponType: record.couponType,
    couponCode: record.couponCode,
    couponLink: record.couponLink,
    couponDescription: record.couponDescription,
    discountValue: record.discountValue,
    couponStartDate: toIso(record.couponStartDate),
    couponEndDate: toIso(record.couponEndDate),
    couponStatus: record.couponStatus,
    couponIsExclusive: record.couponIsExclusive,
    rawPayload: record.rawPayload,
    normalizedPayload: record.normalizedPayload,
    mapperVersion: record.mapperVersion,
    firstSeenAt: toIso(record.firstSeenAt),
    lastSyncedAt: toIso(record.lastSyncedAt),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    supplierCampaign: record.supplierCampaign
      ? {
          id: record.supplierCampaign.id,
          supplier: record.supplierCampaign.supplier,
          supplierRegion: record.supplierCampaign.supplierRegion,
          supplierCampaignId: record.supplierCampaign.supplierCampaignId,
          campaignName: record.supplierCampaign.campaignName,
          merchantNameRaw: record.supplierCampaign.merchantNameRaw,
          campaignStatus: record.supplierCampaign.campaignStatus,
        }
      : undefined,
  };
}
