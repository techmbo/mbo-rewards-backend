import { buildCampaignBaseFromEntity, buildCouponBaseFromEntity, toDecimalString } from "./shared.js";
import { brandLabelFromLandingUrl } from "../../merchant/brandIdentity.js";
import {
  normalizeCampaignStatus,
  normalizeParticipationStatus,
  normalizePricingModel,
  normalizeCommissionUnit,
} from "./status.js";
import {
  buildTrackierCampaignFieldLineage,
  firstNonEmpty,
  pickTrackierCampaignName,
  pickTrackierCampaignType,
  pickTrackierCategory,
  pickTrackierCreativeUrl,
  pickTrackierCurrency,
  pickTrackierDeepLink,
  pickTrackierLandingUrl,
  pickTrackierLogoUrl,
  pickTrackierMerchantName,
  pickTrackierPayoutType,
  pickTrackierPayoutValue,
  pickTrackierSubcategory,
  pickTrackierSupplierMerchantId,
  pickTrackierTrackingUrl,
  pickTrackierApplicationStatusRaw,
  pickTrackierCampaignStatusRaw,
} from "./trackierFieldContract.js";

export function mapTrackierCampaign(entity) {
  const base = buildCampaignBaseFromEntity(entity);
  const raw = entity.rawData ?? {};

  const destinationUrl =
    firstNonEmpty(base.destinationUrl, pickTrackierLandingUrl(raw)) ?? null;
  const trackingUrl =
    firstNonEmpty(base.trackingUrl, pickTrackierTrackingUrl(raw)) ?? null;
  // CRITICAL: trackingUrl is supplier_tracking_url only — never copied to MBO TrackingLink here.

  const merchantNameRaw =
    firstNonEmpty(
      base.merchantNameRaw,
      pickTrackierMerchantName(raw),
      brandLabelFromLandingUrl(destinationUrl),
    ) ?? null;

  const campaignName =
    firstNonEmpty(pickTrackierCampaignName(raw), base.campaignName) ?? base.campaignName;

  const campaignType =
    firstNonEmpty(pickTrackierCampaignType(raw), base.campaignType) ?? null;

  const categoryName =
    firstNonEmpty(base.categoryName, pickTrackierCategory(raw)) ?? null;

  const subcategory = pickTrackierSubcategory(raw);
  const merchantVertical =
    firstNonEmpty(base.merchantVertical, raw.vertical, subcategory) ?? null;

  const deepLink = pickTrackierDeepLink(raw);
  const deepLinkingEnabled =
    base.deepLinkingEnabled != null
      ? base.deepLinkingEnabled
      : deepLink
        ? true
        : null;

  // status → campaign_status ; application_status → relationship (participation) — NEVER merge
  const campaignStatus = normalizeCampaignStatus(
    pickTrackierCampaignStatusRaw(raw),
    entity.entityStatus,
    base.campaignStatus,
  );

  const participationStatus = normalizeParticipationStatus(
    pickTrackierApplicationStatusRaw(raw),
    base.participationStatus,
  );

  const payoutValue = pickTrackierPayoutValue(raw);
  const payoutType = pickTrackierPayoutType(raw);
  const pricingModel = normalizePricingModel(payoutType, base.pricingModel, raw.model);
  const commissionUnit = normalizeCommissionUnit(payoutType, base.commissionUnit);

  const logoUrl = firstNonEmpty(base.campaignLogoUrl, pickTrackierLogoUrl(raw));
  const creativeUrl = pickTrackierCreativeUrl(raw);
  const currency = firstNonEmpty(base.currencyCode, pickTrackierCurrency(raw));
  const supplierMerchantId = pickTrackierSupplierMerchantId(raw);

  const lineage = buildTrackierCampaignFieldLineage(raw);

  return {
    ...base,
    campaignName,
    merchantNameRaw,
    trackingUrl,
    destinationUrl,
    categoryName,
    campaignType,
    merchantVertical,
    deepLinkingEnabled,
    campaignStatus,
    participationStatus,
    isJoined: participationStatus === "JOINED" || base.isJoined === true,
    defaultCommissionValue:
      base.defaultCommissionValue ?? toDecimalString(payoutValue) ?? null,
    commissionUnit:
      commissionUnit !== "UNKNOWN" ? commissionUnit : base.commissionUnit,
    pricingModel: pricingModel !== "UNKNOWN" ? pricingModel : base.pricingModel,
    campaignLogoUrl: logoUrl ?? null,
    currencyCode: currency ? String(currency).toUpperCase().slice(0, 3) : base.currencyCode,
    commissionCurrency:
      base.commissionCurrency ||
      (currency ? String(currency).toUpperCase().slice(0, 3) : null),
    normalizedPayload: {
      ...(base.normalizedPayload || {}),
      supplier_merchant_id: supplierMerchantId,
      subcategory,
      creative_url: creativeUrl,
      supplier_tracking_url: trackingUrl,
      landing_page_url: destinationUrl,
      _trackierFieldLineage: lineage,
    },
  };
}

export function mapTrackierCoupon(entity) {
  const base = buildCouponBaseFromEntity(entity);
  const raw = entity.rawData ?? {};

  const fromNestedCodes = Array.isArray(raw.coupons)
    ? firstNonEmpty(...raw.coupons.map((c) => c?.code))
    : null;

  const couponCode =
    firstNonEmpty(base.couponCode, raw.code, raw.coupon_code, fromNestedCodes) ?? null;

  return {
    ...base,
    parentSupplierCampaignId:
      base.parentSupplierCampaignId ??
      (raw.campaign_id != null ? String(raw.campaign_id) : null) ??
      (raw.campaignId != null ? String(raw.campaignId) : null),
    couponCode,
    couponLink: firstNonEmpty(base.couponLink, raw.url, raw.deeplink, raw.deep_link) ?? null,
    couponStatus: firstNonEmpty(raw.coupon_status, raw.status, base.couponStatus) ?? base.couponStatus,
    couponType: couponCode ? "CODE" : base.couponLink || raw.url ? "LINK" : base.couponType,
  };
}
