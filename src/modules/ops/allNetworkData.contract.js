/**
 * Pointer 22 — All Network Data view contract.
 * One ops inspection screen: Network + Data Type with MBO naming and view modes.
 */

import { stripSensitivePayload } from "./importedRecords.contract.js";
import { PERFORMANCE_RECORD_MBO_FIELDS } from "../networkPortal/performanceRecord.contract.js";

export const CONTRACT_POINTER = 22;

export const VIEW_MODE = Object.freeze({
  MBO_DEFAULT: "MBO_DEFAULT",
  COMPACT: "COMPACT",
  ALL_COLUMNS: "ALL_COLUMNS",
  CUSTOM: "CUSTOM",
});

export const UI_RECORD_TYPES = Object.freeze({
  CAMPAIGN: "campaign",
  COUPON: "coupon",
  CONVERSION: "conversion",
  PRODUCT: "product",
});

/** Entity types stored on imported-records API. */
export const API_RECORD_TYPES = Object.freeze({
  CAMPAIGN: "campaign",
  COUPON: "coupon",
  PERFORMANCE: "performance",
  PRODUCT: "product",
});

const SENSITIVE_KEY =
  /password|secret|token|api[_-]?key|authorization|access[_-]?key|refresh[_-]?token|credential|private[_-]?key/i;

/** Map UI record type → API query type. */
export function normalizeRecordTypeForApi(uiType) {
  const t = String(uiType || "campaign").toLowerCase();
  if (t === "conversion") return API_RECORD_TYPES.PERFORMANCE;
  return t;
}

/** Map API entity type → UI label type. */
export function normalizeRecordTypeForUi(apiType) {
  const t = String(apiType || "campaign").toLowerCase();
  if (t === "performance") return UI_RECORD_TYPES.CONVERSION;
  return t;
}

function col(key, label, technical, { defaultVisible = false, compact = false, sourceOnly = false } = {}) {
  return { key, label, technical, defaultVisible, compactVisible: compact, sourceOnly, canonical: !sourceOnly };
}

export const COLUMN_CATALOG = Object.freeze({
  campaign: [
    col("network", "Network Source", "supplier", { defaultVisible: true, compact: true }),
    col("brand", "Brand Name", "brand_name", { defaultVisible: true, compact: true }),
    col("campaign", "Campaign Name", "campaignName", { defaultVisible: true, compact: true }),
    col("campaignStatus", "Campaign Status", "campaign_status", { defaultVisible: true, compact: true }),
    col("relationshipStatus", "Relationship Status", "relationship_status", { defaultVisible: true, compact: true }),
    col("country", "Country", "country", { defaultVisible: true, compact: true }),
    col("currency", "Currency", "currency", { defaultVisible: true }),
    col("commissionDisplay", "Campaign Commission", "campaignCommissionDisplay", { defaultVisible: true, compact: true }),
    col("isAssignable", "Is Assignable", "is_assignable", { defaultVisible: true }),
    col("mappingStatus", "Mapping Status", "mapping_status", { defaultVisible: true, compact: true }),
    col("brandWebsiteLink", "Brand Website Link", "brandWebsiteUrl", { defaultVisible: true }),
    col("brandLogoLink", "Brand Logo Link", "brandLogoUrl", { defaultVisible: true }),
    col("category", "Primary Category", "primaryCategory", { defaultVisible: true }),
    col("secondaryCategory", "Secondary Category", "secondaryCategory", { defaultVisible: true }),
    col("campaignType", "Campaign Type", "campaignType", { defaultVisible: true }),
    col("campaignDescription", "Campaign Description", "campaignDescription", { defaultVisible: true }),
    col("termsAndConditions", "Campaign Terms and Condition", "campaignTerms", { defaultVisible: true }),
    col("commissionAverageDisplay", "Avg. Commission", "campaignCommissionAverage", { defaultVisible: true }),
    col("networkTrackingLink", "Supplier Tracking Link", "supplierTrackingLink", { defaultVisible: true }),
    col("startDate", "Campaign Start Date", "campaignStartDate", { defaultVisible: true }),
    col("endDate", "Campaign End Date", "campaignEndDate", { defaultVisible: true }),
    col("promotionDescription", "Campaign Promotion Description", "promotion_description", { defaultVisible: false }),
    col("discountPercent", "Discount %", "discount_percent", { defaultVisible: false }),
    col("supplierCampaignExtId", "Supplier Campaign ID", "supplier_campaign_id", { defaultVisible: true }),
    col("campaignSourceId", "Campaign Source ID", "campaign_source_id", { defaultVisible: true }),
    col("linkSupport", "Link Support", "supports_link_tracking", { defaultVisible: true }),
    col("couponSupport", "Coupon Support", "supports_coupon", { defaultVisible: true }),
    col("deeplinkSupport", "Deeplink Support", "supports_deeplink", { defaultVisible: true }),
    col("feedSupport", "Feed Support", "supports_product_feed", { defaultVisible: false }),
    col("commissionRuleCount", "Commission Rule Count", "commission_rule_count", { defaultVisible: true }),
    col("lastSyncedAt", "Last Synced At", "last_synced_at", { defaultVisible: true }),
    col("rawPayloadId", "Raw Payload Link", "raw_payload_id", { defaultVisible: false }),
    col("sourceRecordId", "Source Record ID", "external_id", { defaultVisible: false }),
  ],
  coupon: [
    col("network", "Network Source", "supplier", { defaultVisible: true, compact: true }),
    col("brand", "Brand Name", "brand_name", { defaultVisible: true, compact: true }),
    col("campaign", "Campaign Name", "campaignName", { defaultVisible: true, compact: true }),
    col("couponCode", "Coupon Code", "coupon_code", { defaultVisible: true, compact: true }),
    col("couponStatus", "Coupon Status", "coupon_status", { defaultVisible: true, compact: true }),
    col("couponLink", "Coupon Link", "coupon_link", { defaultVisible: true }),
    col("country", "Country", "country", { defaultVisible: true, compact: true }),
    col("currency", "Currency", "currency", { defaultVisible: true }),
    col("startDate", "Start Date", "start_date", { defaultVisible: true }),
    col("endDate", "End Date", "end_date", { defaultVisible: true }),
    col("mappingStatus", "Mapping Status", "mapping_status", { defaultVisible: true, compact: true }),
    col("sourceStatus", "Source Status", "source_status", { defaultVisible: true }),
    col("lastSyncedAt", "Last Synced At", "last_synced_at", { defaultVisible: true }),
    col("rawPayloadId", "Raw Payload Link", "raw_payload_id", { defaultVisible: false }),
    col("sourceRecordId", "Source Record ID", "external_id", { defaultVisible: false }),
  ],
  performance: [
    col("network", "Network Source", "supplier", { defaultVisible: true, compact: true }),
    col("brandName", "Brand Name", "brand_name", { defaultVisible: true, compact: true }),
    col("campaignName", "Campaign Name", "campaign_name", { defaultVisible: true, compact: true }),
    col("reportDate", "Report Date", "report_date", { defaultVisible: true, compact: true }),
    col("reportGranularity", "Report Granularity", "report_granularity", { defaultVisible: true }),
    col("country", "Country", "country", { defaultVisible: true, compact: true }),
    col("currency", "Currency", "currency", { defaultVisible: true, compact: true }),
    col("couponCode", "Coupon Code", "coupon_code", { defaultVisible: true }),
    col("networkOrderId", "Network Order ID", "network_order_id", { defaultVisible: true, compact: true }),
    col("networkConversionId", "Network Conversion ID", "network_conversion_id", { defaultVisible: true }),
    col("networkClickId", "Network Click ID", "network_click_id", { defaultVisible: true }),
    col("networkClicks", "Network Clicks", "network_clicks", { defaultVisible: true }),
    col("grossOrders", "Gross Orders", "gross_orders", { defaultVisible: true, compact: true }),
    col("confirmedOrders", "Confirmed Orders", "confirmed_orders", { defaultVisible: true, compact: true }),
    col("grossOrderValue", "Gross Order Value", "gross_order_value", { defaultVisible: true, compact: true }),
    col("grossCommission", "Gross Commission", "gross_commission", { defaultVisible: true, compact: true }),
    col("networkOrderStatusRaw", "Network Raw Status", "network_raw_status", { defaultVisible: true }),
    col("mappingStatus", "Mapping Status", "mapping_status", { defaultVisible: true, compact: true }),
    col("lastSyncedAt", "Last Synced At", "last_synced_at", { defaultVisible: true }),
    col("sourceEndpoint", "Source Endpoint", "source_endpoint", { defaultVisible: false }),
    col("rawPayloadId", "Raw Payload Link", "raw_payload_id", { defaultVisible: false }),
    col("sourceRecordId", "Source Record ID", "external_id", { defaultVisible: false }),
  ],
  product: [
    col("networkSource", "Network Source", "network_source", { defaultVisible: true, compact: true }),
    col("brandName", "Brand Name", "brand_name", { defaultVisible: true, compact: true }),
    col("campaignName", "Campaign Name", "campaign_name", { defaultVisible: true, compact: true }),
    col("productName", "Product Name", "product_name", { defaultVisible: true, compact: true }),
    col("supplierProductId", "Supplier Product ID", "supplier_product_id", { defaultVisible: true, compact: true }),
    col("sku", "SKU", "sku", { defaultVisible: true, compact: true }),
    col("price", "Price", "price", { defaultVisible: true, compact: true }),
    col("currency", "Currency", "currency", { defaultVisible: true, compact: true }),
    col("availability", "Availability", "availability", { defaultVisible: true }),
    col("productFeedSource", "Product Feed / API Source", "product_feed_source", { defaultVisible: true }),
    col("mappingStatus", "Mapping Status", "mapping_status", { defaultVisible: true, compact: true }),
    col("sourceRecordId", "Source Record ID", "external_id", { defaultVisible: false }),
  ],
});

export function getColumnCatalog(recordType) {
  const apiType = normalizeRecordTypeForApi(recordType);
  return COLUMN_CATALOG[apiType] || COLUMN_CATALOG.campaign;
}

export function getDefaultColumnKeys(recordType) {
  return getColumnCatalog(recordType)
    .filter((c) => c.defaultVisible)
    .map((c) => c.key);
}

export function getCompactColumnKeys(recordType) {
  const catalog = getColumnCatalog(recordType);
  const compact = catalog.filter((c) => c.compactVisible).map((c) => c.key);
  return compact.length ? compact : getDefaultColumnKeys(recordType).slice(0, 8);
}

export function resolveActiveColumnKeys({ viewMode = VIEW_MODE.MBO_DEFAULT, recordType, customKeys = [] } = {}) {
  const catalog = getColumnCatalog(recordType);
  const allKeys = catalog.map((c) => c.key);
  switch (String(viewMode || VIEW_MODE.MBO_DEFAULT).toUpperCase()) {
    case VIEW_MODE.ALL_COLUMNS:
      return allKeys;
    case VIEW_MODE.COMPACT:
      return getCompactColumnKeys(recordType);
    case VIEW_MODE.CUSTOM:
      return customKeys.length ? customKeys.filter((k) => allKeys.includes(k) || String(k).startsWith("source:")) : getDefaultColumnKeys(recordType);
    case VIEW_MODE.MBO_DEFAULT:
    default:
      return getDefaultColumnKeys(recordType);
  }
}

function firstFilled(...values) {
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    return v;
  }
  return null;
}

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Performance / conversion list fields — MBO naming only; no fabrication. */
export function buildPerformanceRowFields(entity) {
  const raw = entity?.rawData && typeof entity.rawData === "object" ? entity.rawData : {};
  const norm = entity?.normalizedData && typeof entity.normalizedData === "object" ? entity.normalizedData : {};
  return {
    brandName: firstFilled(entity.advertiserName, norm.brandName, raw.brand_name, raw.brand, raw.advertiser_name, raw.advertiser),
    campaignName: firstFilled(entity.campaignName, entity.entityName, norm.campaignName, raw.campaign_name, raw.campaignName, raw.program_name),
    reportDate: firstFilled(norm.reportDate, raw.date, raw.report_date, raw.reportDate, raw.day),
    reportGranularity: firstFilled(norm.reportGranularity, raw.granularity, raw.report_granularity),
    country: firstFilled(norm.country, raw.country, raw.country_code),
    currency: firstFilled(norm.currency, raw.currency, raw.currency_code),
    couponCode: firstFilled(norm.couponCode, raw.coupon_code, raw.couponCode, raw.voucher_code),
    networkOrderId: firstFilled(norm.networkOrderId, raw.order_id, raw.orderId, raw.transaction_id, raw.transactionId),
    networkConversionId: firstFilled(norm.networkConversionId, raw.conversion_id, raw.conversionId, entity.externalId),
    networkClickId: firstFilled(norm.networkClickId, raw.click_id, raw.clickId),
    networkClicks: num(firstFilled(norm.networkClicks, raw.clicks, raw.link_clicks)),
    grossOrders: num(firstFilled(norm.grossOrders, raw.orders, raw.gross_orders, raw.total_conversions)),
    confirmedOrders: num(firstFilled(norm.confirmedOrders, raw.confirmed_orders, raw.validated_conversions)),
    grossOrderValue: num(firstFilled(norm.grossOrderValue, raw.order_value, raw.sales_amount, raw.gross_order_value)),
    grossCommission: num(firstFilled(norm.grossCommission, raw.commission, raw.gross_commission, raw.revenue)),
    networkOrderStatusRaw: firstFilled(norm.networkOrderStatusRaw, raw.status, raw.order_status),
    sourceEndpoint: firstFilled(norm.sourceEndpoint, raw.source_endpoint, raw.report_type),
  };
}

export function buildCouponRowFields(entity, coupon = null) {
  const c = coupon || entity?.supplierCoupons?.[0] || null;
  return {
    couponCode: c?.couponCode ?? null,
    couponLink: c?.couponLink ?? null,
    couponStatus: c?.couponStatus ?? null,
  };
}

const PERFORMANCE_RAW_SOURCE_KEYS = new Set([
  "date",
  "report_date",
  "reportdate",
  "day",
  "clicks",
  "link_clicks",
  "orders",
  "gross_orders",
  "confirmed_orders",
  "commission",
  "gross_commission",
  "revenue",
  "order_id",
  "orderid",
  "transaction_id",
  "conversion_id",
  "click_id",
  "brand_name",
  "brand",
  "advertiser_name",
  "advertiser",
  "campaign_name",
  "campaignname",
  "program_name",
  "country",
  "country_code",
  "currency",
  "currency_code",
  "coupon_code",
  "voucher_code",
  "status",
  "order_status",
  "granularity",
  "report_granularity",
  "source_endpoint",
  "report_type",
]);

/** Top-level raw keys not promoted to canonical MBO columns. */
export function extractSourceOnlyFields(entity, recordType) {
  const raw = stripSensitivePayload(entity?.rawData);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const apiType = normalizeRecordTypeForApi(recordType);
  const canonical = new Set([
    ...getColumnCatalog(recordType).map((c) => c.key),
    ...PERFORMANCE_RECORD_MBO_FIELDS,
    "id",
    "externalId",
    "entityType",
    "networkSource",
  ]);

  const sourceFields = {};
  for (const [key, value] of Object.entries(raw)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (canonical.has(key)) continue;
    if (apiType === "performance" && PERFORMANCE_RAW_SOURCE_KEYS.has(String(key).toLowerCase())) continue;
    if (value == null) continue;
    sourceFields[key] = value;
  }
  return sourceFields;
}

export function enrichAllNetworkDataRow(row, entity) {
  if (!row || !entity) return row;
  const entityType = String(entity.entityType || row.entityType || "campaign").toLowerCase();
  const uiType = normalizeRecordTypeForUi(entityType);

  let extra = {};
  if (entityType === "performance") {
    extra = buildPerformanceRowFields(entity);
    if (!row.network && row.networkSource) extra.network = row.network;
  } else if (entityType === "coupon") {
    extra = buildCouponRowFields(entity);
  }

  const sourceFields = extractSourceOnlyFields(entity, uiType);

  return {
    ...row,
    ...extra,
    sourceFields,
    contractPointer: CONTRACT_POINTER,
  };
}

export function toColumnCatalogDto(recordType) {
  const catalog = getColumnCatalog(recordType);
  return {
    contractPointer: CONTRACT_POINTER,
    recordType: normalizeRecordTypeForUi(normalizeRecordTypeForApi(recordType)),
    apiRecordType: normalizeRecordTypeForApi(recordType),
    viewModes: Object.values(VIEW_MODE),
    columns: catalog,
    defaultKeys: getDefaultColumnKeys(recordType),
    compactKeys: getCompactColumnKeys(recordType),
    sourceOnlyRule:
      "Extra network-specific fields appear in All Columns (source:* keys) and Source Data — never auto-promoted to canonical MBO fields.",
  };
}

export function buildSourceColumnDefs(sourceFieldKeys = []) {
  return sourceFieldKeys.map((key) =>
    col(`source:${key}`, `Source: ${key}`, key, { sourceOnly: true }),
  );
}
