import { buildCampaignBaseFromEntity, buildCouponBaseFromEntity } from "./shared.js";

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function safeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * CJ Advertiser Lookup is the advertiser/program master, not financial truth.
 * Program Terms is the authoritative expected-commission source.
 */
export function mapCjCampaign(entity = {}) {
  const base = buildCampaignBaseFromEntity(entity);
  const raw = entity.rawData ?? {};
  const advertiserId = first(raw.advertiser_id, raw.advertiserId, raw.id);
  const advertiserName = first(raw.advertiser_name, raw.advertiserName, raw.name);
  const category = first(raw.primary_category?.child, raw.primary_category?.parent, raw.category);

  return {
    ...base,
    supplierCampaignId: advertiserId != null ? String(advertiserId) : base.supplierCampaignId,
    campaignName: advertiserName ? String(advertiserName) : base.campaignName,
    merchantNameRaw: advertiserName ? String(advertiserName) : base.merchantNameRaw,
    categoryName: category ? String(category) : base.categoryName,
    merchantVertical: raw.primary_category?.parent
      ? String(raw.primary_category.parent)
      : base.merchantVertical,
    destinationUrl: first(raw.program_url, raw.programUrl, base.destinationUrl) ?? null,
    // Advertiser Lookup headline/default action commission is display/discovery data only.
    // Expected commission is persisted from CJ Program Terms instead.
    defaultCommissionValue: null,
    commissionUnit: "UNKNOWN",
    commissionCurrency: null,
    commissionGroups: null,
    normalizedPayload: {
      ...(base.normalizedPayload ?? {}),
      cjAdvertiserLookup: {
        accountStatus: raw.account_status ?? null,
        relationshipStatus: raw.relationship_status ?? null,
        sevenDayEpc: raw.seven_day_epc ?? null,
        threeMonthEpc: raw.three_month_epc ?? null,
        networkRank: raw.network_rank ?? null,
        performanceIncentives: raw.performance_incentives ?? null,
        actions: Array.isArray(raw.actions) ? raw.actions : [],
        note: "Advertiser Lookup commissions are discovery/display facts; Program Terms is financial source-of-truth.",
      },
    },
    mapperVersion: `${base.mapperVersion || "supplier-mapper"}:cj-advertiser-v1`,
  };
}

/**
 * CJ coupon rows come from Link Search with promotion-type=coupon.
 * The advertiser id is the SupplierCampaign business key; the link id is the
 * coupon source identity. Link commission strings stay display evidence only.
 */
export function mapCjCoupon(entity = {}) {
  const raw = entity.rawData ?? {};
  const advertiserId = first(raw.advertiser_id, raw.advertiserId);
  const base = buildCouponBaseFromEntity(
    entity,
    advertiserId != null ? String(advertiserId) : null,
  );

  return {
    ...base,
    supplierCouponId:
      first(raw.link_id, raw.linkId, base.supplierCouponId) != null
        ? String(first(raw.link_id, raw.linkId, base.supplierCouponId))
        : null,
    parentSupplierCampaignId:
      advertiserId != null ? String(advertiserId) : base.parentSupplierCampaignId,
    parentCampaignName:
      first(raw.advertiser_name, raw.advertiserName, base.parentCampaignName) ?? null,
    couponType: raw.coupon_code ? "CODE" : raw.click_url || raw.destination ? "LINK" : base.couponType,
    couponCode: raw.coupon_code ? String(raw.coupon_code) : base.couponCode,
    couponLink: first(raw.click_url, raw.clickUrl, raw.destination, base.couponLink) ?? null,
    couponDescription:
      first(raw.description, raw.link_name, raw.linkName, base.couponDescription) ?? null,
    couponStartDate: safeDate(raw.promotion_start_date) ?? base.couponStartDate,
    couponEndDate: safeDate(raw.promotion_end_date) ?? base.couponEndDate,
    normalizedPayload: {
      ...(base.normalizedPayload ?? {}),
      cjLinkSearch: {
        linkId: raw.link_id ?? null,
        linkType: raw.link_type ?? null,
        promotionType: raw.promotion_type ?? null,
        relationshipStatus: raw.relationship_status ?? null,
        targetedCountries: raw.targeted_countries ?? null,
        saleCommissionDisplay: raw.sale_commission ?? null,
        clickCommissionDisplay: raw.click_commission ?? null,
        leadCommissionDisplay: raw.lead_commission ?? null,
        note: "Link Search commission strings are display/link facts, not SupplierCommissionRule financial truth.",
      },
    },
    mapperVersion: `${base.mapperVersion || "supplier-mapper"}:cj-link-search-v1`,
  };
}
