/**
 * Pointer 10 — CouponVoucher canonical record contract.
 * Every network coupon/voucher is one row; never concatenate on campaign cells.
 */

import { FIELD_MAPPING_OUTCOME } from "../mapping/mappingOutcome.contract.js";

export const COUPON_VOUCHER_FIELDS = Object.freeze([
  "networkSource",
  "supplierCampaignId",
  "supplierCouponId",
  "couponCode",
  "title",
  "promotionDescription",
  "discountValue",
  "discountType",
  "couponStartDate",
  "couponEndDate",
  "couponStatus",
  "couponIsExclusive",
  "customerType",
  "country",
  "couponLink",
  "sourceObject",
  "sourcePath",
  "mappingStatus",
  "fieldMappingOutcome",
  "mappingVersion",
]);

function first(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function asString(value) {
  if (value == null || value === "") return null;
  return String(value).trim() || null;
}

export function inferDiscountType(raw = {}) {
  const explicit = asString(raw.discount_type ?? raw.discountType ?? raw.discount_kind);
  if (explicit) return explicit.toUpperCase();
  const discount = raw.discount ?? raw.discount_value ?? raw.discountValue;
  if (typeof discount === "object" && discount?.type) return String(discount.type).toUpperCase();
  const text = asString(discount);
  if (text && text.includes("%")) return "PERCENT";
  if (text && /^\d/.test(text)) return "FIXED";
  return null;
}

export function enrichCouponVoucherRecord(base, entity, meta = {}) {
  const raw = entity?.rawData && typeof entity.rawData === "object" ? entity.rawData : {};
  const voucherNested =
    raw.voucher_code && typeof raw.voucher_code === "object" ? raw.voucher_code : null;

  const title = asString(
    first(
      raw.title,
      raw.name,
      voucherNested?.title,
      voucherNested?.name,
      raw.voucher?.title,
      entity?.entityName,
    ),
  );
  const promotionDescription = asString(
    first(
      raw.promotion_description,
      raw.promotionDescription,
      raw.promotional_text,
      raw.description,
      voucherNested?.description,
      raw.voucher?.description,
      base.couponDescription,
    ),
  );

  const customerType = asString(
    first(raw.customer_type, raw.customerType, raw.audience, raw.user_type, raw.new_customer_only),
  );
  const country = asString(
    first(
      raw.country,
      raw.country_code,
      raw.countryCode,
      Array.isArray(raw.countries) ? raw.countries[0] : null,
      raw.market,
    ),
  );

  const sourceObject = asString(
    meta.sourceObject ?? raw._mboSourceObject ?? entity?.sourceObject ?? "voucher_codes",
  );
  const sourcePath = asString(meta.sourcePath ?? raw._mboSourcePath ?? null);

  const hasCode = Boolean(base.couponCode || base.couponLink);
  const mappingStatus = hasCode ? "MAPPED" : "NEEDS_REVIEW";
  const fieldMappingOutcome = hasCode
    ? FIELD_MAPPING_OUTCOME.MAPPED
    : FIELD_MAPPING_OUTCOME.REVIEW_REQUIRED;

  return {
    ...base,
    title,
    promotionDescription,
    discountType: inferDiscountType(raw) ?? base.discountType ?? null,
    customerType,
    country,
    networkSource: entity?.networkSource ?? meta.networkSource ?? null,
    sourceObject,
    sourcePath,
    mappingStatus,
    fieldMappingOutcome,
    mappingVersion: base.mapperVersion ?? meta.mappingVersion ?? null,
  };
}

export function toCouponVoucherDto(record) {
  if (!record) return null;
  const campaign = record.supplierCampaign;
  return {
    id: record.id,
    network: record.networkSource ?? campaign?.supplier ?? null,
    networkSource: record.networkSource ?? null,
    campaign: campaign
      ? {
          id: campaign.id,
          supplierCampaignId: campaign.supplierCampaignId,
          campaignName: campaign.campaignName,
        }
      : null,
    supplierCampaignId: record.supplierCampaignId,
    supplierCouponId: record.supplierCouponId,
    couponCode: record.couponCode,
    title: record.title,
    promotionDescription: record.promotionDescription,
    couponDescription: record.couponDescription,
    discountValue: record.discountValue,
    discountType: record.discountType,
    couponStartDate: record.couponStartDate,
    couponEndDate: record.couponEndDate,
    couponStatus: record.couponStatus,
    couponIsExclusive: record.couponIsExclusive,
    customerType: record.customerType,
    country: record.country,
    couponLink: record.couponLink,
    sourceObject: record.sourceObject,
    sourcePath: record.sourcePath,
    mappingStatus: record.mappingStatus,
    fieldMappingOutcome: record.fieldMappingOutcome,
    mappingVersion: record.mappingVersion ?? record.mapperVersion,
    mapperVersion: record.mapperVersion,
    entityId: record.entityId,
    rawPayloadId: record.rawPayloadId,
    lastSyncedAt: record.lastSyncedAt,
  };
}
