/**
 * Pointer 13 — PerformanceRecord contract.
 * Performance remains separate from OrderConversion. MBO-standard fields only on the fact;
 * extra network keys stay source-only evidence. Never fabricate missing dimensions.
 */

import { MBO_CANONICAL_OBJECT } from "../mapping/mboCanonicalObjects.contract.js";
import { FIELD_MAPPING_OUTCOME } from "../mapping/mappingOutcome.contract.js";
import { deriveCampaignChannelType } from "../ops/v15FieldContract.js";

export const PERFORMANCE_RECORD_OBJECT = MBO_CANONICAL_OBJECT.PERFORMANCE_RECORD;

/** MBO-standard columns promoted to NetworkPerformanceFact. */
export const PERFORMANCE_RECORD_MBO_FIELDS = Object.freeze([
  "supplier",
  "sourceAccountLabel",
  "reportDate",
  "reportExternalId",
  "supplierCampaignId",
  "brandName",
  "campaignName",
  "category",
  "country",
  "currency",
  "campaignTypeCommercial",
  "campaignChannelType",
  "couponId",
  "couponCode",
  "couponSource",
  "couponScope",
  "networkTrackingLink",
  "mboTrackingLink",
  "trackingLinkId",
  "networkClickId",
  "mboClickId",
  "subId1",
  "subId2",
  "subId3",
  "impressions",
  "networkClicks",
  "mboLinkClicks",
  "uniqueClicks",
  "grossOrders",
  "pendingOrders",
  "confirmedOrders",
  "cancelledOrders",
  "rejectedOrders",
  "paidOrders",
  "grossOrderValue",
  "pendingOrderValue",
  "confirmedOrderValue",
  "cancelledOrderValue",
  "rejectedOrderValue",
  "paidOrderValue",
  "grossCommission",
  "pendingCommission",
  "confirmedCommission",
  "cancelledCommission",
  "rejectedCommission",
  "payableCommission",
  "paidCommission",
  "mboReceivable",
  "mboActuallyReceived",
  "discountPercent",
  "customerType",
  "devicePlatform",
  "conversionRate",
  "aov",
  "epc",
  "attributionStatus",
  "reconciliationStatus",
  "rawPayloadId",
  "sourceEndpoint",
  "reportGranularity",
]);

/** Dimensions that must never be inferred when absent on the source row. */
export const ANTI_FABRICATION_METRICS = Object.freeze([
  "impressions",
  "devicePlatform",
  "customerType",
  "couponCode",
  "couponId",
  "epc",
  "mboLinkClicks",
  "mboTrackingLink",
  "mboActuallyReceived",
]);

function first(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/**
 * Extract coupon code from a performance row.
 * Boostiny publishes the code as `code` (+ `code_id`) — not coupon_code.
 * Never treat a bare ISO-2 country token as a coupon when code_id is absent.
 */
export function extractPerformanceCouponCode(row = {}) {
  const explicit = first(
    row.couponCode,
    row.coupon_code,
    row.voucher_code,
    row.voucherCode,
    row.voucherCodeUsed,
    row.voucher,
    row.PromoCode,
    row.CouponCode,
    row.promocode,
  );
  if (explicit != null) return String(explicit).trim();

  const boostinyCode = first(row.code, row.Code);
  if (boostinyCode == null) return null;
  const s = String(boostinyCode).trim();
  if (!s) return null;
  const codeId = first(row.code_id, row.codeId, row.CodeId);
  if (codeId != null) return s;
  if (/^[A-Za-z]{2}$/.test(s)) return null;
  return s;
}

/**
 * Normalize supplier customer-type labels only when an authoritative field exists.
 * Never infer from coupon/device/geo/order history.
 */
export function normalizeCustomerType(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const upper = raw.toUpperCase().replace(/[\s-]+/g, "_");
  if (["NEW", "NEW_CUSTOMER", "NEWCUSTOMER", "N"].includes(upper)) return "NEW";
  if (["EXISTING", "RETURNING", "RETURN", "EXISTING_CUSTOMER", "E", "R"].includes(upper)) {
    return "EXISTING";
  }
  if (["UNKNOWN", "U", "N/A", "NA"].includes(upper)) return "UNKNOWN";
  return raw;
}

export function resolvePerformanceImpressions(row = {}) {
  return toNum(first(row.impressions, row.Impressions, row.impression));
}

export function resolvePerformanceDevicePlatform(row = {}) {
  const raw = first(row.devicePlatform, row.device, row.platform, row.Device, row.device_type);
  if (raw == null || raw === "") return null;
  return String(raw).trim() || null;
}

export function resolvePerformanceEpc(row = {}) {
  return toNum(first(row.epc, row.EPC, row.earnings_per_click));
}

export function resolvePerformanceCustomerType(row = {}) {
  return normalizeCustomerType(
    first(
      row.customerType,
      row.customer_type,
      row.custType,
      row.CustType,
      row.user_type,
      row.userType,
      null,
    ),
  );
}

/**
 * Channel type from the performance row only — never from campaign capability/catalog.
 */
export function resolvePerformanceChannelType(row = {}) {
  const couponCode = extractPerformanceCouponCode(row);
  const trackingUrl = first(
    row.networkTrackingLink,
    row.trackingUrl,
    row.tracking_url,
    row.trackingURL,
    row.baseTrackingUrl,
    row.clickThroughUrl,
    row.urlTracking,
    null,
  );
  return deriveCampaignChannelType({
    supportsCoupon: Boolean(couponCode),
    trackingUrl,
  });
}

function toNum(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object" && value.amount != null) return toNum(value.amount);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Top-level source keys consumed by performance mapping — excluded from source-only capture. */
const MAPPED_SOURCE_KEYS = new Set([
  "date",
  "reportDate",
  "day",
  "created",
  "conversionDate",
  "conversion_time",
  "conversion_date",
  "conversion_date_time",
  "EventDate",
  "CreationDate",
  "transactionDate",
  "transactionDateTime",
  "report_date",
  "networkClicks",
  "network_clicks",
  "clicks",
  "Clicks",
  "click",
  "totalClicks",
  "click_count",
  "link_performance",
  "performance",
  "mboLinkClicks",
  "mbo_link_clicks",
  "mboClicks",
  "grossOrders",
  "orders",
  "totalConversions",
  "conversions",
  "gross_orders",
  "sales_open",
  "confirmedOrders",
  "net_orders",
  "validatedConversions",
  "approvedConversions",
  "sales_approved",
  "pendingOrders",
  "pendingConversions",
  "cancelledOrders",
  "cancelled_orders",
  "cancelledConversions",
  "rejectedOrders",
  "rejectedConversions",
  "rejected_orders",
  "sales_declined",
  "grossOrderValue",
  "sales_amount_usd",
  "originalOrderValue",
  "originalOrderValueOriginal",
  "revenue",
  "sale_amount",
  "saleAmount",
  "pendingOrderValue",
  "confirmedOrderValue",
  "cancelledOrderValue",
  "rejectedOrderValue",
  "paidOrderValue",
  "paidOrders",
  "grossCommission",
  "pendingCommission",
  "confirmedCommission",
  "cancelledCommission",
  "rejectedCommission",
  "payableCommission",
  "paidCommission",
  "mboReceivable",
  "mboActuallyReceived",
  "receivedCommission",
  "bankReceived",
  "discountPercent",
  "discount",
  "customerType",
  "customer_type",
  "custType",
  "CustType",
  "user_type",
  "userType",
  "devicePlatform",
  "device",
  "platform",
  "Device",
  "device_type",
  "conversionRate",
  "cr",
  "cvr",
  "aov",
  "aov_usd",
  "net_aov_usd",
  "epc",
  "EPC",
  "earnings_per_click",
  "brandName",
  "advertiser_name",
  "advertiserName",
  "AdvertiserName",
  "brand_name",
  "merchant_name",
  "advertiser",
  "merchant",
  "campaignName",
  "campaign_name",
  "CampaignName",
  "campaign_title",
  "ProgramName",
  "programmeName",
  "campaign",
  "offer_name",
  "name",
  "couponCode",
  "coupon_code",
  "voucher_code",
  "voucherCode",
  "voucherCodeUsed",
  "voucher",
  "PromoCode",
  "CouponCode",
  "promocode",
  "code",
  "Code",
  "code_id",
  "codeId",
  "CodeId",
  "couponId",
  "coupon_id",
  "voucher_id",
  "couponSource",
  "coupon_source",
  "couponScope",
  "coupon_scope",
  "currency",
  "Currency",
  "currencyCode",
  "targetCurrencyCode",
  "originalCurrencyCode",
  "country",
  "Country",
  "countryCode",
  "CustomerCountry",
  "customer_country",
  "customerCountry",
  "geo",
  "advertiserCountry",
  "primaryRegion",
  "countries",
  "networkTrackingLink",
  "trackingUrl",
  "tracking_url",
  "trackingURL",
  "baseTrackingUrl",
  "clickThroughUrl",
  "urlTracking",
  "mboTrackingLink",
  "mbo_tracking_url",
  "supplierCampaignId",
  "campaign_id",
  "campaignId",
  "CampaignId",
  "ProgramId",
  "programmeId",
  "advertiserId",
  "productId",
  "offer_id",
  "offerId",
  "reportExternalId",
  "report_id",
  "id",
  "Id",
  "_id",
  "rawStatus",
  "raw_status",
  "status",
  "Status",
  "State",
  "commissionStatus",
  "conversion_status",
  "attributionStatus",
  "attribution",
  "attribution_status",
  "reconciliationStatus",
  "reconciliation",
  "trackingLinkId",
  "tracking_link_id",
  "mboTrackingLinkId",
  "networkClickId",
  "click_id",
  "clickId",
  "ClickId",
  "clickref",
  "click_ref",
  "clickRef",
  "clickRef1",
  "supplierClickId",
  "mboClickId",
  "mbo_click_id",
  "subId1",
  "sub_id_1",
  "subid1",
  "pubref",
  "clickRef2",
  "SubId1",
  "u1",
  "subId2",
  "sub_id_2",
  "subid2",
  "SubId2",
  "subId3",
  "sub_id_3",
  "subid3",
  "clickRef3",
  "SubId3",
  "impressions",
  "Impressions",
  "impression",
  "uniqueClicks",
  "unique_clicks",
  "UniqueClicks",
  "category",
  "category_name",
  "categoryName",
  "campaignType",
  "campaign_type",
  "pricingModel",
  "report_type",
  "reportGranularity",
  "metadata",
  "commission",
  "commissionAmount",
  "payout",
  "Payout",
  "ActionEarnings",
  "validatedCommission",
  "net_revenue",
  "payment_sum_open",
  "payment_sum_approved",
  "commissions",
  "publisher_commission",
  "order_value",
  "Amount",
  "SaleAmount",
  "conversion_value",
  "conversionValue",
  "cost",
  "payouts",
  "campaign_id",
  "coupon_code",
  "_aggCount",
  "_mboSourceObject",
  "_mboSourcePath",
]);

/**
 * Preserve extra network fields as source-only evidence (not promoted to MBO columns).
 */
export function collectSourceOnlyFields(row = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const sourceOnly = {};
  for (const [key, value] of Object.entries(row)) {
    if (MAPPED_SOURCE_KEYS.has(key)) continue;
    if (key.startsWith("_")) continue;
    if (value === undefined || value === null || value === "") continue;
    sourceOnly[key] = value;
  }
  return Object.keys(sourceOnly).length ? sourceOnly : null;
}

export function buildPerformanceRecordMetadata(row = {}, existing = {}) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  const rowMeta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const sourceOnly = collectSourceOnlyFields(row);
  const next = {
    ...base,
    ...rowMeta,
    mboCanonicalObject: PERFORMANCE_RECORD_OBJECT,
  };
  if (sourceOnly) {
    next.sourceOnly = {
      ...(base.sourceOnly && typeof base.sourceOnly === "object" ? base.sourceOnly : {}),
      ...sourceOnly,
    };
  }
  return next;
}

/** Identity-only hydration from campaign catalog — never metrics or dimensions. */
export function hydratePerformanceIdentityFromCampaign(fact, campaign = null, source = null) {
  if (!fact || typeof fact !== "object") return fact;
  return {
    ...fact,
    brandName: fact.brandName || campaign?.merchant?.displayName || campaign?.merchantNameRaw || null,
    campaignName: fact.campaignName || campaign?.campaignName || null,
    supplierCampaignId: fact.supplierCampaignId || campaign?.supplierCampaignId || null,
    campaignSourceId: fact.campaignSourceId || source?.id || null,
    category: fact.category || campaign?.categoryName || null,
    campaignTypeCommercial: fact.campaignTypeCommercial || campaign?.campaignType || null,
  };
}

/**
 * Hydrate performance fact for DTO — identity from campaign allowed; metrics/dimensions from fact only.
 */
export function hydratePerformanceRecordFact(fact) {
  if (!fact || typeof fact !== "object") return fact;
  const sc = fact.supplierCampaign || null;
  const sources = sc?.campaignSources || [];
  const source = sources.find((s) => s?.isPrimary) || sources[0] || null;

  const hydrated = hydratePerformanceIdentityFromCampaign(fact, sc, source);

  const storedChannel = hydrated.campaignChannelType;
  const channel =
    storedChannel && String(storedChannel).toUpperCase() !== "UNKNOWN"
      ? storedChannel
      : resolvePerformanceChannelType({
          couponCode: hydrated.couponCode,
          networkTrackingLink: hydrated.networkTrackingLink,
        });

  return {
    ...hydrated,
    campaignChannelType: channel,
    // Metrics and dimensions stay exactly as stored — never backfilled from catalog or conversions.
    couponId: hydrated.couponId ?? null,
    couponSource: hydrated.couponSource ?? null,
    couponScope: hydrated.couponScope ?? null,
    networkTrackingLink: hydrated.networkTrackingLink ?? null,
    impressions: hydrated.impressions ?? null,
    devicePlatform: hydrated.devicePlatform ?? null,
    customerType: hydrated.customerType ?? null,
    epc: hydrated.epc ?? null,
    mboLinkClicks: hydrated.mboLinkClicks ?? null,
    mboTrackingLink: hydrated.mboTrackingLink ?? null,
  };
}

export function listSourceOnlyFieldNames(metadata = {}) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const sourceOnly = meta.sourceOnly && typeof meta.sourceOnly === "object" ? meta.sourceOnly : {};
  return Object.keys(sourceOnly).sort();
}

export function toPerformanceRecordDto(row = {}) {
  const hydrated = hydratePerformanceRecordFact(row);
  const meta =
    hydrated.metadata && typeof hydrated.metadata === "object" ? hydrated.metadata : {};
  const sourceOnly = meta.sourceOnly && typeof meta.sourceOnly === "object" ? meta.sourceOnly : null;

  return {
    mboCanonicalObject: PERFORMANCE_RECORD_OBJECT,
    sourceOnlyFields: sourceOnly,
    sourceOnlyFieldNames: sourceOnly ? Object.keys(sourceOnly).sort() : [],
    fieldMappingNote:
      "PerformanceRecord is separate from OrderConversion. Missing network metrics stay null — never fabricated.",
    antiFabricationMetrics: ANTI_FABRICATION_METRICS,
    hydrated,
  };
}

export function performanceFieldOutcome(field, value, { required = false } = {}) {
  if (value != null && value !== "") {
    return FIELD_MAPPING_OUTCOME.MAPPED;
  }
  if (required) return FIELD_MAPPING_OUTCOME.SOURCE_NULL;
  return FIELD_MAPPING_OUTCOME.SOURCE_ONLY;
}
