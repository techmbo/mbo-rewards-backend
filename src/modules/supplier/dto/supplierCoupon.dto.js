import { toCouponVoucherDto } from "../../coupons/couponVoucher.contract.js";
import { mapCampaignStatus } from "../../ops/v15FieldContract.js";

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toSupplierCouponDto(record) {
  if (!record) return null;

  const voucher = toCouponVoucherDto(record);
  const campaign = record.supplierCampaign;

  return {
    ...voucher,
    couponType: record.couponType,
    supplier: record.networkSource ?? campaign?.supplier ?? null,
    brandName: campaign?.merchantNameRaw ?? null,
    campaignName: campaign?.campaignName ?? null,
    rawPayload: record.rawPayload,
    normalizedPayload: record.normalizedPayload,
    firstSeenAt: toIso(record.firstSeenAt),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    supplierCampaign: campaign
      ? {
          id: campaign.id,
          supplier: campaign.supplier,
          supplierRegion: campaign.supplierRegion,
          supplierCampaignId: campaign.supplierCampaignId,
          campaignName: campaign.campaignName,
          merchantNameRaw: campaign.merchantNameRaw,
          campaignStatus: mapCampaignStatus(campaign.campaignStatus),
          sourceCampaignStatus: campaign.campaignStatus ?? null,
        }
      : undefined,
  };
}
