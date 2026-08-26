function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function hasText(value) {
  return String(value ?? "").trim().length > 0;
}

/** True when a value is a URL (must never be treated as a voucher code). */
export function isCouponUrlValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (/^https?:\/\//i.test(text)) return true;
  if (/^www\./i.test(text)) return true;
  return false;
}

/** Real voucher/promo codes only — never URLs or blank strings. */
export function resolveCouponCode(rawData = {}) {
  const code = first(rawData?.coupon, rawData?.code, rawData?.voucherCode, rawData?.voucher_code);
  if (!hasText(code) || isCouponUrlValue(code)) return null;
  return String(code).trim();
}

function normalizeCodeTypeLabel(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");

  if (!normalized) return null;
  if (/\b(link|deeplink|url)\b/.test(normalized)) return "Link";
  if (/\b(coupon|voucher|promo\s*code|code)\b/.test(normalized)) return "Coupon";
  return null;
}

function hasOptimiseMerchantDeepLink(rawData) {
  const deepLink = String(rawData?.deepLinkURL ?? "").trim();
  if (deepLink && /^https?:\/\//i.test(deepLink)) return true;

  const tracking = String(rawData?.deepLinkTrackingURL ?? rawData?.trackingURL ?? "").trim();
  return /r=https?%3A/i.test(tracking);
}

function resolveOptimiseCouponCodeType(rawData) {
  const explicit = normalizeCodeTypeLabel(rawData?.type);
  if (explicit) return explicit;

  if (resolveCouponCode(rawData)) return "Coupon";
  if (hasOptimiseMerchantDeepLink(rawData)) return "Link";

  return null;
}

function resolveBoostinyCouponCodeType(rawData) {
  const explicit = normalizeCodeTypeLabel(
    first(rawData?.code_type, rawData?.coupon_type, rawData?.offer_type, rawData?.type),
  );
  if (explicit) return explicit;

  const campaignType = normalizeCodeTypeLabel(rawData?.campaign_type);
  if (campaignType) return campaignType;

  if (resolveCouponCode(rawData)) return "Coupon";

  if (
    hasText(
      first(
        rawData?.tracking_link,
        rawData?.tracking_url,
        rawData?.link,
        rawData?.url,
        rawData?.deeplink,
        rawData?.deep_link,
      ),
    )
  ) {
    return "Link";
  }

  return "Coupon";
}

function decodeEmbeddedTrackingUrl(trackingUrl) {
  const match = String(trackingUrl ?? "").match(/[?&]r=(https?%3A[^&]+)/i);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function resolveCouponLink(rawData = {}) {
  const merchantLink = String(rawData?.deepLinkURL ?? "").trim();
  if (merchantLink && /^https?:\/\//i.test(merchantLink)) return merchantLink;

  const deepTracked = String(rawData?.deepLinkTrackingURL ?? "").trim();
  const embeddedDeep = decodeEmbeddedTrackingUrl(deepTracked);
  if (embeddedDeep && /^https?:\/\//i.test(embeddedDeep)) return embeddedDeep;

  const trackedLink = String(rawData?.trackingURL ?? "").trim();
  const embeddedTrack = decodeEmbeddedTrackingUrl(trackedLink);
  if (embeddedTrack && /^https?:\/\//i.test(embeddedTrack)) return embeddedTrack;

  const fallback = first(
    rawData?.link,
    rawData?.url,
    rawData?.deeplink,
    rawData?.deep_link,
    rawData?.offer_url,
    rawData?.offerUrl,
    rawData?.landing_page,
    rawData?.landingPage,
  );
  if (fallback && /^https?:\/\//i.test(String(fallback).trim())) {
    const url = String(fallback).trim();
    // Avoid treating bare affiliate trackers as the voucher destination.
    try {
      const host = new URL(url).hostname.toLowerCase();
      if ((host.includes("omgt") || host.includes("clk.") || host.includes("track.")) && !url.includes("r=")) {
        return null;
      }
    } catch {
      // ignore
    }
    return url;
  }

  return null;
}

/**
 * Display helper: prefer real code, else link.
 * Callers that need a code for CouponCodeMaster must use resolveCouponCode().
 */
export function resolveCouponCodeOrLink(rawData = {}) {
  const code = resolveCouponCode(rawData);
  if (code) return code;

  const link = resolveCouponLink(rawData);
  return hasText(link) ? link : null;
}

function resolveTrackierCouponCodeType(rawData) {
  const explicit = normalizeCodeTypeLabel(rawData?.type);
  if (explicit) return explicit;

  if (rawData?.record_source === "deal") return "Coupon";
  if (resolveCouponCode(rawData)) return "Coupon";
  if (hasText(first(rawData?.link, rawData?.tracking_url, rawData?.tracking_link, rawData?.url))) {
    return "Link";
  }

  return "Coupon";
}

export function resolveCouponCodeType(rawData, networkSource) {
  const source = String(networkSource ?? "").toLowerCase();
  if (source.startsWith("optimise")) return resolveOptimiseCouponCodeType(rawData);
  if (source === "boostiny") return resolveBoostinyCouponCodeType(rawData);
  if (source === "trackier") return resolveTrackierCouponCodeType(rawData);
  return null;
}

export function enrichBoostinyCouponsWithCampaignType(coupons, campaigns) {
  const typeByCampaignName = new Map();
  const idByCampaignName = new Map();

  for (const campaign of campaigns) {
    const name = campaign?.name;
    if (!name) continue;
    const key = String(name).trim().toLowerCase();
    const type = campaign?.campaign_type;
    if (type) typeByCampaignName.set(key, type);
    const id = campaign?.id ?? campaign?.campaign_id ?? campaign?.campaignId ?? null;
    if (id != null && id !== "") idByCampaignName.set(key, String(id));
  }

  return coupons.map((row) => {
    const campaignName = row?.campaign?.name ?? row?.campaign_name ?? null;
    if (!campaignName) return row;

    const key = String(campaignName).trim().toLowerCase();
    const campaignType = typeByCampaignName.get(key);
    const campaignId = idByCampaignName.get(key);
    const next = { ...row };
    if (campaignType && !next.campaign_type) next.campaign_type = campaignType;
    // Boostiny coupon payloads often omit campaign id — stamp it for parent promotion.
    if (campaignId && next.campaign_id == null && next.campaignId == null) {
      next.campaign_id = campaignId;
      if (next.campaign && typeof next.campaign === "object") {
        next.campaign = { ...next.campaign, id: next.campaign.id ?? campaignId };
      }
    }
    return next;
  });
}
