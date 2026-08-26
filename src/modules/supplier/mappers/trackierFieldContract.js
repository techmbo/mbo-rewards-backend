/**
 * Authoritative Trackier / vCommission supplier field contract helpers.
 * Supplier field names stay at the ingestion boundary; canonical MBO names are applied in mappers.
 * Never invent values; never treat supplier tracking URLs as MBO tracking links.
 */

export function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      const nested = firstNonEmpty(value.name, value.title, value.label, value.full_url);
      if (nested != null) return nested;
      continue;
    }
    return value;
  }
  return null;
}

export function asTrimmedString(value) {
  const v = firstNonEmpty(value);
  if (v == null) return null;
  return String(v).trim() || null;
}

/** id / offer_id / campaign_id → supplier_campaign_id */
export function pickTrackierCampaignId(raw = {}) {
  const id = firstNonEmpty(raw.id, raw.offer_id, raw.campaign_id, raw.campaignId, raw._id);
  return id == null ? null : String(id);
}

/** title / campaign_name / offer_name / name → supplier_campaign_name */
export function pickTrackierCampaignName(raw = {}) {
  return asTrimmedString(
    firstNonEmpty(raw.title, raw.campaign_name, raw.offer_name, raw.name, raw.campaignName),
  );
}

/** advertiser_name / advertiser / merchant_name → raw_merchant_name */
export function pickTrackierMerchantName(raw = {}) {
  return asTrimmedString(
    firstNonEmpty(
      raw.advertiser_name,
      typeof raw.advertiser === "string" ? raw.advertiser : raw.advertiser?.name,
      raw.merchant_name,
      raw.advertiserName,
      raw.brand,
    ),
  );
}

/** advertiser_id / merchant_id → supplier_merchant_id (lineage only; no invent) */
export function pickTrackierSupplierMerchantId(raw = {}) {
  const id = firstNonEmpty(raw.advertiser_id, raw.merchant_id, raw.advertiserId, raw.merchantId);
  return id == null ? null : String(id);
}

/** status → campaign_status source (do not invent) */
export function pickTrackierCampaignStatusRaw(raw = {}) {
  return firstNonEmpty(raw.status, raw.campaign_status, raw.campaignStatus);
}

/**
 * application_status → relationship_status (Master: status/application_status).
 * Prefer application_status; fall back to status only for relationship-shaped tokens.
 */
export function pickTrackierApplicationStatusRaw(raw = {}) {
  const dedicated = firstNonEmpty(raw.application_status, raw.applicationStatus);
  if (dedicated != null) return dedicated;

  const status = firstNonEmpty(raw.status, raw.campaign_status, raw.campaignStatus);
  if (status == null) return null;
  const v = String(status).trim().toLowerCase().replace(/[\s-]+/g, "_");
  // Only reuse status for relationship when it looks like join/approval vocabulary.
  if (
    [
      "approved",
      "joined",
      "pending",
      "awaiting",
      "need_approval",
      "approval_pending",
      "denied",
      "rejected",
      "declined",
      "not_joined",
      "notapplied",
      "not_applied",
    ].includes(v)
  ) {
    return status;
  }
  return null;
}

/** conversion_flow / offer_type / campaign_type → campaign_type (not category, not model) */
export function pickTrackierCampaignType(raw = {}) {
  return asTrimmedString(
    firstNonEmpty(raw.conversion_flow, raw.offer_type, raw.campaign_type, raw.campaignType, raw.campaignTypeName),
  );
}

/** category / category_name / categoryName / vertical → category */
export function pickTrackierCategory(raw = {}) {
  const fromArray = Array.isArray(raw.categories)
    ? raw.categories.map((c) => (typeof c === "string" ? c : c?.name)).filter(Boolean).join(", ")
    : null;
  return asTrimmedString(
    firstNonEmpty(raw.category_name, raw.categoryName, raw.category, raw.vertical, fromArray),
  );
}

export function pickTrackierSubcategory(raw = {}) {
  return asTrimmedString(firstNonEmpty(raw.subcategory, raw.sub_category, raw.subCategory));
}

/** preview_url / url / offer_url / website → landing_page_url */
export function pickTrackierLandingUrl(raw = {}) {
  return asTrimmedString(
    firstNonEmpty(raw.preview_url, raw.url, raw.offer_url, raw.website, raw.destination_url, raw.destinationUrl),
  );
}

/** tracking_link / tracking_url → supplier_tracking_url (never MBO link) */
export function pickTrackierTrackingUrl(raw = {}) {
  return asTrimmedString(
    firstNonEmpty(raw.tracking_link, raw.tracking_url, raw.trackingUrl, raw.click_url),
  );
}

/** deep_link / deeplink → supports_deeplink evidence */
export function pickTrackierDeepLink(raw = {}) {
  return asTrimmedString(firstNonEmpty(raw.deep_link, raw.deeplink, raw.deepLink));
}

/** logo / thumbnail / image / campaign_logo / creatives[].full_url */
export function pickTrackierLogoUrl(raw = {}) {
  const creativeUrl = Array.isArray(raw.creatives)
    ? firstNonEmpty(...raw.creatives.map((c) => c?.full_url ?? c?.url))
    : null;
  return asTrimmedString(
    firstNonEmpty(raw.logo, raw.thumbnail, raw.image, raw.campaign_logo, raw.campaignLogo, creativeUrl),
  );
}

export function pickTrackierCreativeUrl(raw = {}) {
  if (!Array.isArray(raw.creatives)) return null;
  return asTrimmedString(firstNonEmpty(...raw.creatives.map((c) => c?.full_url ?? c?.url)));
}

/** payout / payout_value → commission_value */
export function pickTrackierPayoutValue(raw = {}) {
  return firstNonEmpty(raw.payout_value, raw.payout, raw.default_commission, raw.commission);
}

/** payout_type / payoutType / model → commission_type / pricing model source */
export function pickTrackierPayoutType(raw = {}) {
  return firstNonEmpty(raw.payout_type, raw.payoutType, raw.model, raw.commission_type, raw.commissionUnit);
}

export function pickTrackierCurrency(raw = {}) {
  return asTrimmedString(firstNonEmpty(raw.currency, raw.currency_code, raw.commission_currency));
}

export function pickTrackierCountries(raw = {}) {
  const fromGeo = flattenIfPresent(raw.geo);
  const fromCountries = flattenIfPresent(raw.countries);
  const fromCountry = flattenIfPresent(raw.country ?? raw.country_code ?? raw.countryName);
  const merged = [...fromGeo, ...fromCountries, ...fromCountry].filter(Boolean);
  return merged.length ? merged : [];
}

function flattenIfPresent(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      typeof item === "object" && item
        ? [item.iso || item.code || item.countryCode || item.name || item].filter(Boolean)
        : [item],
    );
  }
  if (typeof value === "string") {
    return value.split(/[,;|]/).map((part) => part.trim()).filter(Boolean);
  }
  return [value];
}

/**
 * Build lineage map: canonical MBO field → { sourceField, value }.
 * Values are supplier-side; null sources omitted.
 */
export function buildTrackierCampaignFieldLineage(raw = {}) {
  const entries = [
    ["supplier_campaign_id", ["id", "offer_id", "campaign_id"], pickTrackierCampaignId(raw)],
    ["supplier_campaign_name", ["title", "campaign_name", "offer_name", "name"], pickTrackierCampaignName(raw)],
    ["raw_merchant_name", ["advertiser_name", "advertiser", "merchant_name"], pickTrackierMerchantName(raw)],
    ["supplier_merchant_id", ["advertiser_id", "merchant_id"], pickTrackierSupplierMerchantId(raw)],
    ["campaign_status", ["status"], pickTrackierCampaignStatusRaw(raw)],
    ["relationship_status", ["application_status"], pickTrackierApplicationStatusRaw(raw)],
    ["campaign_type", ["conversion_flow", "offer_type", "campaign_type"], pickTrackierCampaignType(raw)],
    ["category", ["category", "category_name", "categoryName", "vertical"], pickTrackierCategory(raw)],
    ["subcategory", ["subcategory"], pickTrackierSubcategory(raw)],
    ["landing_page_url", ["preview_url", "url", "offer_url", "website"], pickTrackierLandingUrl(raw)],
    ["supplier_tracking_url", ["tracking_link", "tracking_url"], pickTrackierTrackingUrl(raw)],
    ["supports_deeplink", ["deep_link", "deeplink"], pickTrackierDeepLink(raw)],
    ["campaign_logo_url", ["logo", "thumbnail", "image", "campaign_logo"], pickTrackierLogoUrl(raw)],
    ["creative_url", ["creatives[].full_url"], pickTrackierCreativeUrl(raw)],
    ["commission_value", ["payout", "payout_value"], pickTrackierPayoutValue(raw)],
    ["commission_type", ["payout_type", "payoutType", "model"], pickTrackierPayoutType(raw)],
    ["currency", ["currency"], pickTrackierCurrency(raw)],
    ["countries", ["geo", "countries", "country"], pickTrackierCountries(raw)],
  ];

  const lineage = {};
  for (const [canonical, aliases, value] of entries) {
    if (value == null || value === "") continue;
    let sourceField = aliases[0];
    for (const alias of aliases) {
      if (alias.includes("[]")) {
        if (Array.isArray(raw.creatives) && raw.creatives.some((c) => c?.full_url || c?.url)) {
          sourceField = "creatives[].full_url";
          break;
        }
        continue;
      }
      const present = raw[alias];
      if (present !== undefined && present !== null && !(typeof present === "string" && present.trim() === "")) {
        sourceField = alias;
        break;
      }
      if (alias === "advertiser" && raw.advertiser) {
        sourceField = "advertiser";
        break;
      }
    }
    lineage[canonical] = { sourceField, value: typeof value === "string" ? value : value };
  }
  return lineage;
}
