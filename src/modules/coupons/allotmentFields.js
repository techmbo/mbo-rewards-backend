import { resolveCouponLink } from "./codeType.js";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function first(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value.trim() : value;
    if (text === "") continue;
    return typeof value === "string" ? value.trim() : value;
  }
  return null;
}

function toIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function looksLikeUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function extractBrandFromCampaignName(name) {
  if (!name) return null;
  const text = String(name).trim();
  if (!text) return null;
  const cut = text.split(/\s+Ecommerce\b|\s+CPS\b|\s+-\s+/i)[0];
  return cut?.trim() || text;
}

function formatPercentLike(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const rounded = Math.round(num * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatCommission(raw, entityCommission, campaignEntity) {
  const campaignRaw = asObject(campaignEntity?.rawData);
  const payouts = campaignRaw.payouts;
  if (Array.isArray(payouts) && payouts.length > 0) {
    const primary = payouts[0];
    const amount = primary?.payout ?? primary?.amount ?? primary?.value;
    const currency = primary?.currency ?? "";
    const model = String(primary?.payout_model || primary?.model || "").toLowerCase();
    if (amount != null && amount !== "") {
      const formatted = formatPercentLike(amount);
      if (model.includes("percent") || model === "percentage" || model === "cps") {
        return `${formatted}%${currency ? ` ${currency}` : ""}`.trim();
      }
      return `${formatted}${currency ? ` ${currency}` : ""}`.trim();
    }
  }

  const commission = first(
    entityCommission,
    campaignEntity?.commission,
    raw.commission,
    raw.payout,
    raw.default_commission,
    campaignRaw.commission,
    campaignRaw.payout,
  );
  if (commission == null) return null;
  if (typeof commission === "object") {
    const amount = commission.amount ?? commission.value ?? commission.payout;
    const unit = commission.unit ?? commission.type ?? "";
    if (amount == null) return null;
    return `${formatPercentLike(amount)}${unit ? ` ${unit}` : ""}`.trim();
  }
  return String(commission);
}

function isPercentLike(value) {
  if (value == null) return false;
  if (typeof value === "number") return true;
  return /^\s*\d+(\.\d+)?\s*%?\s*$/.test(String(value));
}

function nestedCampaign(raw = {}) {
  return asObject(raw.campaign);
}

function extractParentCampaignId(raw = {}) {
  return first(
    raw.campaign_id,
    raw.campaignId,
    raw.campaign?.id,
    typeof raw.campaign === "string" || typeof raw.campaign === "number" ? raw.campaign : null,
  );
}

/**
 * Build the 9 allotment display fields from Coupon CMS Entity data
 * (+ optional parent campaign Entity for logo/website/tracking/commission).
 */
export function buildAllotmentDisplayFields(entity, related = {}) {
  const campaignEntity = related.campaignEntity || null;
  const merchant = related.merchant || null;
  const supplierCampaign = related.supplierCampaign || null;

  const raw = asObject(entity?.rawData);
  const normalized = asObject(entity?.normalizedData);
  const custom = asObject(normalized.custom);
  const campaignRaw = asObject(campaignEntity?.rawData);
  const nested = nestedCampaign(raw);

  const brandName = first(
    normalized.brand_name,
    normalized.advertiser,
    entity?.advertiserName,
    raw.companyName,
    raw.brand_name,
    raw.brandName,
    raw.advertiser,
    nested.name,
    typeof raw.campaign === "string" ? raw.campaign : null,
    merchant?.displayName,
    supplierCampaign?.merchantNameRaw,
    extractBrandFromCampaignName(entity?.campaignName || campaignEntity?.entityName || campaignRaw.name),
  );

  const websiteUrl = first(
    merchant?.website,
    supplierCampaign?.destinationUrl,
    looksLikeUrl(raw.deepLinkURL) ? raw.deepLinkURL : null,
    looksLikeUrl(raw.preview_url) ? raw.preview_url : null,
    looksLikeUrl(raw.website) ? raw.website : null,
    looksLikeUrl(raw.website_url) ? raw.website_url : null,
    looksLikeUrl(raw.landing_page) ? raw.landing_page : null,
    looksLikeUrl(raw.landingPage) ? raw.landingPage : null,
    looksLikeUrl(campaignRaw.preview_url) ? campaignRaw.preview_url : null,
    looksLikeUrl(campaignRaw.website) ? campaignRaw.website : null,
    looksLikeUrl(campaignRaw.website_url) ? campaignRaw.website_url : null,
    looksLikeUrl(campaignRaw.landing_page) ? campaignRaw.landing_page : null,
    looksLikeUrl(campaignRaw.landingPage) ? campaignRaw.landingPage : null,
  );

  const rawDiscountCandidate = first(
    normalized.discount_percentage,
    custom.discountPercentage,
    raw.discount_percentage,
    raw.ad_set,
    isPercentLike(raw.discount) ? raw.discount : null,
    isPercentLike(entity?.discount) ? entity.discount : null,
  );
  const discountPercentage = isPercentLike(rawDiscountCandidate) ? String(rawDiscountCandidate).trim() : null;

  const offerLink = first(
    resolveCouponLink(raw),
    normalized.link,
    custom.couponLink,
    raw.deepLinkURL,
    raw.link,
    raw.url,
    raw.deeplink,
    supplierCampaign?.destinationUrl,
  );

  const offerText = first(
    !isPercentLike(raw.discount) && typeof raw.discount === "string" ? raw.discount : null,
    !isPercentLike(normalized.discount) && typeof normalized.discount === "string" ? normalized.discount : null,
    !isPercentLike(entity?.discount) && typeof entity?.discount === "string" ? entity.discount : null,
    raw.title,
    raw.name,
    raw.description,
    entity?.entityName,
    normalized.display_value,
  );

  // Link coupons: network trackingURL is the affiliate tracking click URL.
  // CODE coupons may fall back through deepLinkTracking / campaign tracking.
  // Optimise merchant deep-link tracking (r=https%3A…) is preferred over bare trackingURL.
  const isLinkCoupon =
    String(normalized.code_type || entity?.entitySubType || "")
      .toLowerCase()
      .includes("link") ||
    (!raw.code && Boolean(raw.deepLinkURL || raw.trackingURL));

  const optimiseMerchantTracking =
    typeof raw.deepLinkTrackingURL === "string" && /r=https?%3A/i.test(raw.deepLinkTrackingURL)
      ? raw.deepLinkTrackingURL
      : null;

  const trackingUrl = isLinkCoupon
    ? first(
        optimiseMerchantTracking,
        raw.trackingURL,
        raw.tracking_url,
        raw.tracking_link,
        raw.click_url,
        raw.deepLinkTrackingURL,
        campaignRaw.trackingURL,
        campaignRaw.tracking_url,
        campaignRaw.tracking_link,
        supplierCampaign?.trackingUrl,
        merchant?.supplierTrackingLink,
      )
    : first(
        raw.deepLinkTrackingURL,
        raw.trackingURL,
        raw.tracking_url,
        raw.tracking_link,
        raw.click_url,
        campaignRaw.tracking_link,
        campaignRaw.tracking_url,
        campaignRaw.trackingURL,
        supplierCampaign?.trackingUrl,
        merchant?.supplierTrackingLink,
      );

  const termsAndConditions = first(
    custom.couponTerms,
    raw.description,
    raw.terms,
    raw.terms_and_conditions,
    raw.tnc,
    !isPercentLike(raw.discount) && typeof raw.discount === "string" ? raw.discount : null,
    !isPercentLike(entity?.discount) && typeof entity?.discount === "string" ? entity.discount : null,
    campaignRaw.description,
    merchant?.couponDescription,
    supplierCampaign?.campaignDescription,
  );

  const commission = formatCommission(raw, entity?.commission, campaignEntity);

  const brandLogo = first(
    merchant?.logoUrl,
    supplierCampaign?.campaignLogoUrl,
    nested.logo,
    raw.logo,
    raw.logo_url,
    raw.image,
    raw.image_url,
    raw.campaign_logo,
    raw.thumbnail,
    campaignRaw.logo,
    campaignRaw.logo_url,
    campaignRaw.image,
    campaignRaw.thumbnail,
  );

  const expiryDate = toIsoDate(
    first(
      entity?.eventDate,
      normalized.expiry,
      raw.expiryDate,
      raw.expiry,
      raw.end_date,
      raw.endDate,
      raw.valid_to,
    ),
  );

  return {
    brandName,
    websiteUrl,
    discountPercentage,
    offerLink: offerLink ? String(offerLink) : null,
    offerText: offerText ? String(offerText) : null,
    trackingUrl: trackingUrl ? String(trackingUrl) : null,
    termsAndConditions: termsAndConditions
      ? String(termsAndConditions).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : null,
    commission: commission ? String(commission) : null,
    brandLogo: brandLogo ? String(brandLogo) : null,
    expiryDate,
    parentCampaignId: extractParentCampaignId(raw),
  };
}

export function extractParentCampaignIds(entities = []) {
  const ids = new Set();
  for (const entity of entities) {
    const id = extractParentCampaignId(asObject(entity?.rawData));
    if (id != null) ids.add(String(id));
  }
  return [...ids];
}
