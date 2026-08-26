/**
 * Client-safe performance DTO — aligned to Reporting v20 Client Performance headers.
 * Never expose supplierReceivable, mboMargin, mboCommission, gross/net supplier commission,
 * rawPayload, supplierTrackingUrl, or credentials.
 *
 * Network commission / MBO margin intentionally excluded (client visibility rule).
 */

function money(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : null;
}

function monthYearFromDate(reportDate) {
  if (!reportDate) return { month: null, year: null };
  const d = reportDate instanceof Date ? reportDate : new Date(reportDate);
  if (Number.isNaN(d.getTime())) {
    const s = String(reportDate);
    const m = Number(s.slice(5, 7));
    const y = Number(s.slice(0, 4));
    return {
      month: Number.isFinite(m) ? m : null,
      year: Number.isFinite(y) ? y : null,
    };
  }
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

function isoDateTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * @param {object} row — assembled grain row (pre-DTO)
 */
export function toClientPerformanceItemDto(row = {}) {
  const reportDate = row.reportDate ?? row.date ?? null;
  const date =
    typeof reportDate === "string"
      ? String(reportDate).slice(0, 10)
      : reportDate instanceof Date
        ? reportDate.toISOString().slice(0, 10)
        : null;
  const { month, year } = monthYearFromDate(reportDate ?? date);

  const linkClicks =
    row.linkClicks != null
      ? Number(row.linkClicks)
      : row.clickCount != null
        ? Number(row.clickCount)
        : null;
  const grossOrders =
    row.grossOrders != null
      ? Number(row.grossOrders)
      : row.conversionCount != null
        ? Number(row.conversionCount)
        : null;
  const netOrders =
    row.netOrders != null
      ? Number(row.netOrders)
      : row.approvedConversionCount != null
        ? Number(row.approvedConversionCount)
        : null;

  const confirmedOrders =
    row.confirmedOrders != null
      ? Number(row.confirmedOrders)
      : row.approvedConversionCount != null
        ? Number(row.approvedConversionCount)
        : null;
  const pendingOrders = row.pendingOrders != null ? Number(row.pendingOrders) : null;
  const rejectedOrders = row.rejectedOrders != null ? Number(row.rejectedOrders) : null;
  const cancelledOrders =
    row.cancelledOrders != null
      ? Number(row.cancelledOrders)
      : row.cancelOrders != null
        ? Number(row.cancelOrders)
        : null;

  const confirmedClientCommission = money(row.confirmedClientCommission ?? row.clientCommission);
  const clientCommissionGenerated = money(
    row.clientCommissionGenerated ??
      (confirmedClientCommission != null || row.pendingClientCommission != null
        ? (Number(confirmedClientCommission) || 0) + (Number(row.pendingClientCommission) || 0)
        : null),
  );
  const confirmedOrderValue = money(row.confirmedOrderValue ?? row.netOrderValue);

  /** v20 campaign_type: Coupon | Affiliate Link | Link + Coupon */
  const campaignTypeLabel =
    row.clientCampaignType ??
    row.campaignTypeLabel ??
    null;

  return {
    id: row.id || `${date}|${row.canonicalCampaignId || ""}|${row.merchantId || ""}`,
    // v20 Client Performance columns
    date,
    brandName: row.brandName ?? null,
    campaignName: row.campaignName ?? null,
    campaignType: campaignTypeLabel,
    couponCode: row.couponCode ?? null,
    mboTrackingLink: row.mboTrackingLink ?? null,
    grossOrders: Number.isFinite(grossOrders) ? grossOrders : null,
    pendingOrders: Number.isFinite(pendingOrders) ? pendingOrders : null,
    confirmedOrders: Number.isFinite(confirmedOrders) ? confirmedOrders : null,
    rejectedOrders: Number.isFinite(rejectedOrders) ? rejectedOrders : null,
    cancelledOrders: Number.isFinite(cancelledOrders) ? cancelledOrders : null,
    grossOrderValue: money(row.grossOrderValue),
    confirmedOrderValue,
    clientCommissionGenerated,
    confirmedClientCommission,
    lastUpdatedAt: isoDateTime(row.lastUpdatedAt ?? row.updatedAt),

    // Compat / internal grain fields (still client-safe)
    month,
    year,
    channelType: row.channelType ?? null,
    /** @deprecated use campaignType (v20 label) */
    linkClicks: Number.isFinite(linkClicks) ? linkClicks : null,
    netOrders: Number.isFinite(netOrders) ? netOrders : null,
    cancelOrders: Number.isFinite(cancelledOrders) ? cancelledOrders : null,
    netOrderValue: confirmedOrderValue,
    clientCommission: confirmedClientCommission,
    pendingClientCommission: money(row.pendingClientCommission),
    country: row.country ?? null,
    currency: row.currency ?? null,
    customerType: row.customerType ?? null,
    orderDate: row.orderDate ?? null,
    orderConfirmDate: row.orderConfirmDate ?? null,
    orderPaymentConfirmDate: row.orderPaymentConfirmDate ?? null,
    discountPercent: row.discountPercent ?? null,
    canonicalCampaignId: row.canonicalCampaignId ?? null,
  };
}

export const CLIENT_PERFORMANCE_UNAVAILABLE_FIELDS = Object.freeze([
  "customerType",
  "orderDate",
  "orderConfirmDate",
  "orderPaymentConfirmDate",
  "discountPercent",
  "channelType_when_mixed_in_bucket",
  "couponCode_when_mixed_in_bucket",
  "mboTrackingLink_when_mixed_or_missing",
  "04E_persisted_grain",
]);

export const CLIENT_PERFORMANCE_FORBIDDEN_KEYS = Object.freeze([
  "supplierReceivable",
  "mboMargin",
  "mboCommission",
  "grossCommission",
  "netCommission",
  "supplierTrackingUrl",
  "rawPayload",
  "rawData",
  "supplierCampaignId",
  "networkSource",
  "supplier",
  "apiKey",
  "keyHash",
]);

/** v20 Client Confirmed Orders — individual order grain (client-safe). */
export function toClientConfirmedOrderDto(row = {}) {
  const lastUpdated = row.lastUpdatedAt instanceof Date ? row.lastUpdatedAt : row.lastUpdatedAt ? new Date(row.lastUpdatedAt) : null;
  const lastUpdatedValid = lastUpdated && !Number.isNaN(lastUpdated.getTime()) ? lastUpdated : null;

  return {
    confirmationType: row.confirmationType ?? "Individual Order",
    orderConfirmedDate: row.orderConfirmedDate ?? null,
    orderDate: row.orderDate ?? null,
    cycle: row.cycle ?? null,
    clientName: row.clientName ?? null,
    network: null, // client-facing: network may be redacted; staff surfaces can override
    brandName: row.brandName ?? null,
    campaignName: row.campaignName ?? null,
    campaignType: row.campaignType ?? null,
    couponCode: row.couponCode ?? null,
    mboTrackingLink: row.mboTrackingLink ?? null,
    networkOrderId: row.networkOrderId ?? null,
    networkConversionId: row.networkConversionId ?? null,
    mboClickId: row.mboClickId ?? null,
    confirmedOrders: row.confirmedOrders != null ? Number(row.confirmedOrders) : 1,
    confirmedOrderValueAmount: money(row.confirmedOrderValueAmount ?? row.orderValue),
    currency: row.currency ?? null,
    clientCommissionRate: row.clientCommissionRate ?? null,
    confirmedClientCommissionAmount: money(row.confirmedClientCommissionAmount ?? row.clientCommission),
    confirmationStatus: row.confirmationStatus ?? "Confirmed",
    settlementStatus: row.settlementStatus ?? null,
    lastUpdatedDate: lastUpdatedValid ? lastUpdatedValid.toISOString().slice(0, 10) : null,
    lastUpdatedTime: lastUpdatedValid
      ? lastUpdatedValid.toISOString().slice(11, 16)
      : null,
    orderId: row.orderId ?? null,
    network: row.network ?? null,
  };
}
