/**
 * v15 04E/05E grain helpers — classification only; no invented customerType.
 * Ambiguous dimensions return null (do not pick arbitrarily).
 */

export function extractMetadataCouponCode(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const raw =
    metadata.couponCode ??
    metadata.attributionHints?.couponCode ??
    metadata.voucher ??
    null;
  if (raw == null || String(raw).trim() === "") return null;
  return String(raw).trim();
}

/**
 * Per-conversion channel for performance grain.
 * LINK = click/tracking path present
 * COUPON = metadata coupon code present
 * BOTH = both
 * UNKNOWN = neither
 * Does NOT use CampaignSource.supportsCoupon (capability ≠ attribution).
 */
export function classifyConversionChannel(conversion) {
  const hasLink = Boolean(conversion?.clickId || conversion?.trackingLinkId);
  const hasCoupon = Boolean(extractMetadataCouponCode(conversion?.metadata));
  if (hasLink && hasCoupon) return "Link + Coupon";
  if (hasCoupon) return "Coupon";
  if (hasLink) return "Link";
  return "Unknown";
}

/** If all values equal (and non-null), return that value; else null (ambiguous). */
export function uniqueOrNull(values) {
  const set = new Set();
  for (const v of values) {
    if (v == null || v === "") continue;
    set.add(String(v));
  }
  if (set.size === 1) return [...set][0];
  return null;
}

/**
 * Workbook cancel vs confirmed from Conversion.status state machine.
 * APPROVED = confirmed/validated; PAID = confirmed and paid (still confirmed).
 * REJECTED = rejected (client reporting); CANCELLED if status/metadata says so.
 * PENDING/UNKNOWN ≠ confirmed.
 */
export function isConfirmedConversionStatus(status) {
  const v = String(status || "").toUpperCase();
  return v === "APPROVED" || v === "PAID";
}

export function isCancelConversionStatus(status) {
  return String(status || "").toUpperCase() === "REJECTED";
}

export function isPendingConversionStatus(status) {
  const v = String(status || "").toUpperCase();
  return v === "PENDING" || v === "UNKNOWN" || v === "";
}

export function isRejectedConversionStatus(status, metadata = null) {
  const v = String(status || "").toUpperCase();
  if (v === "REJECTED") {
    const reason = String(metadata?.cancelReason || metadata?.statusDetail || "").toLowerCase();
    if (reason.includes("cancel") || reason.includes("revers")) return false;
    return true;
  }
  return false;
}

export function isCancelledConversionStatus(status, metadata = null) {
  const v = String(status || "").toUpperCase();
  if (v === "CANCELLED" || v === "CANCELED") return true;
  if (v === "REJECTED") {
    const reason = String(metadata?.cancelReason || metadata?.statusDetail || "").toLowerCase();
    return reason.includes("cancel") || reason.includes("revers");
  }
  return false;
}

/**
 * Map event channel evidence to workbook channelType vocabulary.
 * Mixed buckets must use uniqueOrNull → null (never invent LINK).
 * Insufficient evidence ("Unknown") → null, not UNKNOWN label for aggregates.
 */
export function toWorkbookChannelType(classified) {
  const v = String(classified || "").trim();
  if (v === "Link") return "LINK";
  if (v === "Coupon") return "COUPON";
  if (v === "Link + Coupon") return "LINK_AND_COUPON";
  return null;
}

/** v20 Client Performance campaign_type labels. */
export function toClientCampaignTypeLabel(channelTypeOrClassified) {
  const v = String(channelTypeOrClassified || "").trim().toUpperCase().replace(/\s+/g, "_");
  if (v === "COUPON" || v === "COUPON_CODE_ONLY") return "Coupon";
  if (v === "LINK" || v === "AFFILIATE_LINK_ONLY" || v === "AFFILIATE_LINK") return "Affiliate Link";
  if (v === "LINK_AND_COUPON" || v === "COUPON_AND_LINK" || v === "LINK_+_COUPON") return "Link + Coupon";
  const classified = String(channelTypeOrClassified || "").trim();
  if (classified === "Coupon") return "Coupon";
  if (classified === "Link") return "Affiliate Link";
  if (classified === "Link + Coupon") return "Link + Coupon";
  return null;
}

/**
 * Aggregate conversion extras for one DailyReport bucket (source + day).
 * Returns null dimensions when mixed within the bucket.
 */
export function summarizeConversionsForBucket(conversions = []) {
  const channels = [];
  const coupons = [];
  const trackingLinkIds = [];
  let cancelOrders = 0;
  let confirmedOrders = 0;
  let pendingOrders = 0;
  let rejectedOrders = 0;
  let cancelledOrders = 0;
  let netCommission = 0;
  let hasApprovedCommission = false;
  const orderIds = new Set();

  for (const c of conversions) {
    channels.push(classifyConversionChannel(c));
    coupons.push(extractMetadataCouponCode(c.metadata));
    if (c.trackingLinkId) trackingLinkIds.push(c.trackingLinkId);
    if (isCancelConversionStatus(c.status)) cancelOrders += 1;
    if (isConfirmedConversionStatus(c.status)) confirmedOrders += 1;
    if (isPendingConversionStatus(c.status)) pendingOrders += 1;
    if (isRejectedConversionStatus(c.status, c.metadata)) rejectedOrders += 1;
    if (isCancelledConversionStatus(c.status, c.metadata)) cancelledOrders += 1;
    if (c.approvedCommission != null && c.approvedCommission !== "") {
      netCommission += Number(c.approvedCommission) || 0;
      hasApprovedCommission = true;
    }
    if (c.orderId) orderIds.add(c.orderId);
  }

  const unanimousChannel = uniqueOrNull(channels);
  return {
    campaignType: unanimousChannel, // legacy display label when unanimous
    channelType: toWorkbookChannelType(unanimousChannel),
    clientCampaignType: toClientCampaignTypeLabel(unanimousChannel),
    couponCode: uniqueOrNull(coupons),
    trackingLinkId: uniqueOrNull(trackingLinkIds),
    cancelOrders,
    confirmedOrders,
    pendingOrders,
    rejectedOrders,
    cancelledOrders,
    netCommission: hasApprovedCommission ? netCommission : null,
    hasApprovedCommission,
    orderIds: [...orderIds],
    conversionCount: conversions.length,
    ambiguousChannel: channels.length > 0 && unanimousChannel == null,
    ambiguousCoupon: coupons.some(Boolean) && uniqueOrNull(coupons) == null,
  };
}

/**
 * Sum distinct order values — never sum Conversion→Order without dedupe.
 * gross = all linked orders with orderValue
 * net = VALIDATION_APPROVED only
 */
export function sumDistinctOrderValues(orders = []) {
  let gross = 0;
  let net = 0;
  let grossN = 0;
  let netN = 0;
  const seen = new Set();
  for (const o of orders) {
    if (!o?.id || seen.has(o.id)) continue;
    seen.add(o.id);
    const v = o.orderValue != null ? Number(o.orderValue) : NaN;
    if (!Number.isFinite(v)) continue;
    gross += v;
    grossN += 1;
    if (String(o.validationStatus || "").toUpperCase() === "VALIDATION_APPROVED") {
      net += v;
      netN += 1;
    }
  }
  return {
    grossOrderValue: grossN > 0 ? gross : null,
    netOrderValue: netN > 0 ? net : null,
  };
}

/**
 * Prefer FT.supplierReceivable (signed earn/reversal/adjust) as approved supplier net.
 * Falls back to conversion approvedCommission aggregate when no FT.
 */
export function resolveNetSupplierCommission({ ftRows = [], conversionApprovedSum = null } = {}) {
  if (Array.isArray(ftRows) && ftRows.length > 0) {
    let sum = 0;
    for (const ft of ftRows) {
      const amt = Number(ft.supplierReceivable) || 0;
      if (ft.transactionType === "REVERSAL") sum -= Math.abs(amt);
      else sum += amt;
    }
    return { netCommission: sum, source: "financial_transaction.supplierReceivable" };
  }
  if (conversionApprovedSum != null) {
    return {
      netCommission: Number(conversionApprovedSum),
      source: "conversion.approvedCommission",
    };
  }
  return { netCommission: null, source: null };
}

/**
 * Payment-status click join: clicks lack paymentStatus → cannot match exact 05E key.
 * Attaching the same click total to every status bucket = fan-out.
 * Safe policy: return null.
 */
export function paymentLinkClicksPolicy() {
  return {
    linkClicks: null,
    reason:
      "Clicks cannot join the exact payment grain (includes paymentStatus) without fan-out across status buckets.",
  };
}
