/**
 * Pointer 14 — Order / Conversion ingestion contract.
 * Default dedupe: network + network_account + network_conversion_id.
 * Item grain adds line_item_id. Never dedupe from brand+amount+date or click id alone.
 */

import { MBO_CANONICAL_OBJECT } from "../mapping/mboCanonicalObjects.contract.js";
import { parseSourceAccountLabel } from "../supplier/entityIdentity.js";

export const ORDER_CONVERSION_OBJECT = MBO_CANONICAL_OBJECT.ORDER_CONVERSION;
export const ORDER_ITEM_OBJECT = MBO_CANONICAL_OBJECT.ORDER_ITEM;

function first(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Extract authoritative network conversion id from raw payload / entity.
 */
export function extractNetworkConversionId(rawInput = {}, entity = {}) {
  const raw = asObject(rawInput?.rawData ?? rawInput);
  const fromRaw = first(
    raw.conversionId,
    raw.conversion_id,
    raw.ActionId,
    raw.action_id,
    raw.etransaction_id,
    raw.networkConversionComponentId,
    raw.advertiserConversionId,
    raw.network_conversion_id,
    raw.networkConversionId,
  );
  if (fromRaw != null) return String(fromRaw).trim();

  const boostinyOrderId = first(raw.order_id, raw.orderId, raw.OrderId);
  if (boostinyOrderId != null && String(boostinyOrderId).trim() !== "") {
    return String(boostinyOrderId).trim();
  }

  const rawId = first(raw.id, raw._id);
  if (rawId != null) {
    const reportType = String(raw.report_type || "").toLowerCase();
    if (reportType === "summary" || reportType === "conversions_by_payment") return null;
    const hasCampaignDateAggregate =
      raw.campaign_id != null &&
      (raw.date || raw.period_from) &&
      !first(raw.conversionId, raw.conversion_id, raw.order_id, raw.orderId, raw.OrderId);
    if (hasCampaignDateAggregate) return null;
    return String(rawId).trim();
  }

  const { localExternalId } = parseSourceAccountLabel(entity?.externalId);
  const match = String(localExternalId || "").match(/(?:^|-)conversion(?:-by-payment)?-(.+)$/i);
  if (match?.[1] && !match[1].startsWith("campaign-") && !match[1].includes("summary")) {
    return match[1];
  }

  return null;
}

/** @deprecated alias */
export const extractSupplierConversionId = extractNetworkConversionId;

export function buildConversionDedupeKey({
  supplier,
  sourceAccountLabel = "default",
  supplierConversionId,
  networkConversionId = null,
} = {}) {
  const conversionId = supplierConversionId ?? networkConversionId;
  if (!supplier || conversionId == null || String(conversionId).trim() === "") return null;
  return [
    String(supplier).toUpperCase(),
    String(sourceAccountLabel || "default"),
    String(conversionId).trim(),
  ].join("|");
}

export function extractLineItemId(item = {}) {
  const row = asObject(item);
  return first(
    row.lineItemId,
    row.line_item_id,
    row.lineId,
    row.line_id,
    row.item_id,
    row.itemId,
    row.supplierItemId,
    row.supplier_item_id,
    row.SkuId,
    row.sku_id,
  );
}

export function buildOrderItemDedupeKey({
  supplier,
  sourceAccountLabel = "default",
  supplierConversionId,
  lineItemId,
} = {}) {
  const base = buildConversionDedupeKey({ supplier, sourceAccountLabel, supplierConversionId });
  const lineId = extractLineItemId({ lineItemId, line_item_id: lineItemId }) ?? lineItemId;
  if (!base || lineId == null || String(lineId).trim() === "") return null;
  return `${base}|${String(lineId).trim()}`;
}

/**
 * Stable line identity within an order — prefer network line_item_id.
 * Positional fallback only when the network omits line ids entirely.
 */
export function resolveOrderItemLineKey(item = {}, index = 0) {
  if (isPresent(item.lineKey)) return String(item.lineKey);
  const lineItemId = extractLineItemId(item);
  if (lineItemId != null && String(lineItemId).trim() !== "") {
    return `line:${String(lineItemId).trim()}`;
  }
  return `idx:${index}`;
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

/** Detect entity external ids built from weak grains (brand/campaign + date). */
export function isWeakConversionExternalId(externalId, rawData = {}) {
  if (extractNetworkConversionId(rawData)) return false;
  const local = String(parseSourceAccountLabel(externalId).localExternalId || externalId || "");
  if (/campaign-\d+-\d{4}-\d{2}-\d{2}/.test(local)) return true;
  if (/-\d{4}-\d{2}-\d{2}(?:-\d{2})?$/.test(local) && /\/.{0,80}-\d{4}-\d{2}-\d{2}/.test(local)) {
    return true;
  }
  const raw = asObject(rawData);
  if (raw.campaignName && raw.date && !extractNetworkConversionId(raw)) return true;
  if (raw.campaign_id != null && (raw.date || raw.period_from) && !extractNetworkConversionId(raw)) {
    return true;
  }
  if (raw.click_id != null && raw.id == null && raw.conversionId == null && raw.conversion_id == null) {
    return true;
  }
  return false;
}

/**
 * Entity staging external id for conversion rows — requires network conversion id.
 */
export function resolveConversionEntityExternalId(rawData = {}, fallbackPrefix = "conversion") {
  const conversionId = extractNetworkConversionId(rawData);
  if (!conversionId) return null;
  return `${fallbackPrefix}-${conversionId}`;
}

export function assertPromotableConversionIdentity(entity = {}) {
  if (entity.entityType && entity.entityType !== "conversion") {
    return { ok: false, reason: "not_conversion_entity" };
  }
  const raw = asObject(entity.rawData);
  if (raw.report_type === "summary" || raw.report_type === "conversions_by_payment") {
    return { ok: false, reason: "aggregate_grain" };
  }
  const supplierConversionId = extractNetworkConversionId(entity);
  if (!supplierConversionId) {
    return { ok: false, reason: "missing_network_conversion_id" };
  }
  if (isWeakConversionExternalId(entity.externalId, raw)) {
    return { ok: false, reason: "weak_dedupe_external_id" };
  }
  return { ok: true, supplierConversionId };
}

export function isPromotableConversionRow(entity = {}) {
  return assertPromotableConversionIdentity(entity).ok;
}

export function enrichConversionIngestMetadata(base = {}, keys = {}) {
  const dedupeKey = buildConversionDedupeKey(keys);
  return {
    ...base,
    mboCanonicalObject: ORDER_CONVERSION_OBJECT,
    dedupeKey,
    networkConversionId: keys.supplierConversionId ?? keys.networkConversionId ?? null,
  };
}

export function enrichOrderItemRecord(item = {}, keys = {}) {
  const lineItemId = extractLineItemId(item);
  const lineKey = resolveOrderItemLineKey(item);
  return {
    ...item,
    lineKey,
    lineItemId: lineItemId != null ? String(lineItemId) : item.lineItemId ?? null,
    itemDedupeKey: buildOrderItemDedupeKey({
      ...keys,
      lineItemId,
    }),
  };
}

export function mapRawOrderItems(rawData = {}) {
  const raw = asObject(rawData);
  const list = raw.items || raw.orderItems || raw.lineItems || raw.products || raw.ActionItems || null;
  if (!Array.isArray(list) || !list.length) return [];
  return list.map((row, index) => {
    const item = asObject(row);
    const mapped = {
      supplierItemId: first(item.id, item.itemId, item.sku_id, item.lineId, item.line_item_id),
      lineItemId: extractLineItemId(item),
      sku: first(item.sku, item.SKU, item.productSku),
      productId: first(item.productId, item.product_id),
      productName: first(item.name, item.productName, item.title),
      quantity: item.quantity ?? item.qty ?? null,
      unitPrice: first(item.unitPrice, item.price, item.unit_price),
      itemValue: first(item.itemValue, item.amount, item.total, item.value),
      currency: first(item.currency, item.currencyCode),
      category: first(item.category, item.categoryName),
      commission: first(item.commission, item.payout),
      metadata: { sourceIndex: index },
      lineKey: resolveOrderItemLineKey(item, index),
    };
    return mapped;
  });
}
