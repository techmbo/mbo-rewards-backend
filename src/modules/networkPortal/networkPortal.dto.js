/**
 * Network Operation Portal — domain helpers (NETWORK → MBO only).
 */
import { createHash } from "node:crypto";
import {
  deriveCouponRemainingQuantity,
  buildMappingCertificationChecklist,
  deriveMappingStatus,
  deriveMboReady,
  deriveCampaignChannelType,
  mapCampaignStatus,
  resolveRelationshipStatus,
  formatCommissionSummary,
  money,
  iso,
  isoDate,
} from "../ops/v15FieldContract.js";
import { isCouponUrlValue } from "../coupons/codeType.js";

export function networkGrainKey(parts = []) {
  const raw = parts.map((p) => (p == null || p === "" ? "-" : String(p))).join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

function metaOf(row) {
  return row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata
    : {};
}

function joinDefined(parts, sep = " · ") {
  const values = (parts || []).map((p) => (p == null || p === "" ? null : String(p).trim())).filter(Boolean);
  return values.length ? values.join(sep) : null;
}

function humanizeToken(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw || raw.toUpperCase() === "UNKNOWN") return null;
  return raw
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** HTML 04A / 14E campaign type (channel) — never use CPS/CPA commercial model as this label. */
export function campaignTypeLabel(channelType) {
  const ch = String(channelType || "").toUpperCase();
  if (ch === "COUPON_AND_LINK" || ch === "LINK_AND_COUPON") return "Link + Coupon";
  if (ch === "COUPON_CODE_ONLY" || ch === "COUPON") return "Coupon";
  if (ch === "AFFILIATE_LINK_ONLY" || ch === "LINK") return "Link";
  if (ch === "DEEPLINK") return "Deeplink";
  return null;
}

export function couponSourceLabel(value) {
  const v = String(value || "").toUpperCase();
  if (v === "NETWORK_API") return "Network API";
  if (v === "MANUAL_EMAIL") return "Manual Email";
  if (v === "EXCEL") return "Excel";
  if (v === "ACCOUNT_MANAGER") return "Account Manager";
  if (v === "BRAND") return "Brand";
  if (v === "MANUAL") return "Manual";
  return humanizeToken(value);
}

export function couponScopeLabel(value) {
  const v = String(value || "").toUpperCase();
  if (v === "SHARED_LIMITED") return "Shared Limited Code";
  if (v === "UNIQUE_TO_CLIENT") return "Unique to Client";
  if (v === "UNLIMITED") return "Unlimited";
  return humanizeToken(value);
}

export function reportGranularityLabel(value) {
  if (value == null || value === "") return null;
  const v = String(value).trim().toLowerCase();
  if (v === "daily" || v === "daily_aggregate" || v === "daily aggregate") return "Daily Aggregate";
  return String(value);
}

export function attributionLabel(value) {
  if (value == null || value === "") return null;
  const v = String(value).trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (v === "MATCHED" || v === "ATTRIBUTED") return "Matched";
  if (v === "COUPON_CLICK" || v === "COUPON_PLUS_CLICK" || v === "COUPON_+_CLICK") return "Coupon + Click";
  if (v === "PENDING") return "Pending";
  if (v === "PARTIAL") return "Partial";
  return humanizeToken(value);
}

/**
 * Fill null identity/tracking fields from the related SupplierCampaign.
 * Never copies network tracking URL into mboTrackingLink. Never invents coupons.
 */
export function hydrateNetworkPerformanceFact(fact) {
  if (!fact || typeof fact !== "object") return fact;
  const sc = fact.supplierCampaign || null;
  const sources = sc?.campaignSources || [];
  const source = sources.find((s) => s?.isPrimary) || sources[0] || null;
  const couponCode = fact.couponCode ? String(fact.couponCode) : null;
  const coupon =
    couponCode && Array.isArray(sc?.couponCodeMasters)
      ? sc.couponCodeMasters.find((c) => String(c.couponCode) === couponCode) || null
      : null;

  const hasStoredChannel =
    fact.campaignChannelType && String(fact.campaignChannelType).toUpperCase() !== "UNKNOWN";
  const derivedChannel = hasStoredChannel
    ? fact.campaignChannelType
    : deriveCampaignChannelType({
        supportsLink: source?.supportsLink,
        supportsCoupon: source?.supportsCoupon || Boolean(couponCode),
        trackingUrl: fact.networkTrackingLink || sc?.trackingUrl,
      });

  return {
    ...fact,
    brandName: fact.brandName || sc?.merchant?.displayName || sc?.merchantNameRaw || null,
    campaignName: fact.campaignName || sc?.campaignName || null,
    supplierCampaignId: fact.supplierCampaignId || sc?.supplierCampaignId || null,
    campaignSourceId: fact.campaignSourceId || source?.id || null,
    category: fact.category || sc?.categoryName || null,
    campaignTypeCommercial: fact.campaignTypeCommercial || sc?.campaignType || null,
    campaignChannelType: derivedChannel,
    networkTrackingLink: fact.networkTrackingLink || sc?.trackingUrl || null,
    couponId: fact.couponId || coupon?.supplierCouponExtId || coupon?.id || null,
    couponSource: fact.couponSource || coupon?.source || null,
    couponScope: fact.couponScope || coupon?.scope || null,
  };
}

export function toCouponPoolDto(row, { assignmentCount = null, alertReason = null } = {}) {
  const assigned =
    assignmentCount != null && Number.isFinite(Number(assignmentCount))
      ? Number(assignmentCount)
      : Number(row.assignedQuantity ?? 0);
  const total = row.totalQuantity == null ? null : Number(row.totalQuantity);
  const remaining = deriveCouponRemainingQuantity(total, assigned);
  const sc = row.supplierCampaign || null;
  const supplierCoupon = row.supplierCoupon || null;
  const rawCode = row.couponCode ?? null;
  const codeIsUrl = isCouponUrlValue(rawCode);
  const couponCode = codeIsUrl ? null : rawCode;
  const couponLink =
    supplierCoupon?.couponLink ||
    (codeIsUrl ? rawCode : null) ||
    null;
  const couponTypeRaw = supplierCoupon?.couponType ?? null;
  let couponType = couponTypeRaw && String(couponTypeRaw).toUpperCase() !== "UNKNOWN"
    ? String(couponTypeRaw).toUpperCase()
    : null;
  if (!couponType) {
    if (couponCode) couponType = "CODE";
    else if (couponLink) couponType = "LINK";
  }
  const brandName =
    sc?.merchant?.displayName ||
    sc?.merchantNameRaw ||
    supplierCoupon?.rawPayload?.companyName ||
    null;
  const campaignName =
    sc?.campaignName ||
    supplierCoupon?.rawPayload?.campaignName ||
    null;
  let scope = row.scope ?? null;
  if (!scope || scope === "UNKNOWN") {
    if (supplierCoupon?.couponIsExclusive === true || supplierCoupon?.rawPayload?.exclusive === true) {
      scope = "UNIQUE_TO_CLIENT";
    } else if (
      supplierCoupon?.couponIsExclusive === false ||
      supplierCoupon?.rawPayload?.exclusive === false
    ) {
      scope = "UNLIMITED";
    }
  }

  return {
    id: row.id,
    network: row.supplier,
    networkAccount: row.sourceAccountLabel ?? null,
    campaignSourceId: row.campaignSourceId ?? null,
    campaignSource: row.campaignSourceId ?? null,
    supplierCampaignId: sc?.supplierCampaignId ?? row.supplierCampaignId ?? null,
    supplierCouponId: row.supplierCouponId ?? null,
    supplierCouponExtId: row.supplierCouponExtId ?? null,
    brandName,
    brand: brandName,
    campaignName,
    campaign: campaignName,
    couponId: row.supplierCouponExtId || row.supplierCouponId || row.id,
    couponCode,
    couponType,
    couponLink,
    source: row.source ?? null,
    scope,
    totalQuantity: total,
    assignedQuantity: assigned,
    remainingQuantity: remaining,
    status: row.status ?? null,
    validFrom: isoDate(row.validFrom),
    validUntil: isoDate(row.validUntil),
    newCodeAlert: Boolean(row.newCodeAlert),
    alertReason: alertReason ?? (row.newCodeAlert ? "New coupon code requires review" : null),
    alertReviewedAt: iso(row.alertReviewedAt),
    detectedAt: iso(row.detectedAt),
    lastUpdatedAt: iso(row.lastUpdatedAt),
    rawPayloadId: row.rawPayloadId ?? null,
    sharedReusedAssignments: assigned,
    recommendedAction:
      scope === "UNIQUE_TO_CLIENT"
        ? "No action — already unique"
        : scope === "SHARED_LIMITED" || scope === "UNLIMITED"
          ? "Review for upgrade to unique code"
          : row.newCodeAlert
            ? "Review new code before assignment"
            : null,
    note: "assignedQuantity is MBO allocation usage — not network redemption count. totalQuantity stays empty when the network does not provide inventory.",
  };
}

export function toNetworkPerformanceDto(row) {
  const hydrated = hydrateNetworkPerformanceFact(row);
  const meta = metaOf(hydrated);
  const couponSource = couponSourceLabel(hydrated.couponSource);
  const couponScope = couponScopeLabel(hydrated.couponScope);
  const reportDateIso = isoDate(hydrated.reportDate);
  let reportMonth = null;
  let reportYear = null;
  if (reportDateIso && /^\d{4}-\d{2}-\d{2}/.test(reportDateIso)) {
    reportYear = Number(reportDateIso.slice(0, 4));
    reportMonth = Number(reportDateIso.slice(5, 7));
  }
  const cancelled = hydrated.cancelledOrders != null ? Number(hydrated.cancelledOrders) : null;
  const rejected = hydrated.rejectedOrders != null ? Number(hydrated.rejectedOrders) : null;
  const cancelOrders =
    cancelled != null || rejected != null
      ? (Number.isFinite(cancelled) ? cancelled : 0) + (Number.isFinite(rejected) ? rejected : 0)
      : null;

  // 04A Performance Report aliases — network clicks only (never substitute MBO link clicks).
  const linkClicks = hydrated.networkClicks ?? null;
  const netOrders = hydrated.confirmedOrders ?? null;
  const netOrderValue = money(hydrated.confirmedOrderValue);
  const netCommission = money(hydrated.confirmedCommission ?? hydrated.payableCommission);

  return {
    id: hydrated.id,
    reportId: hydrated.reportExternalId || hydrated.id,
    network: hydrated.supplier,
    networkSource: hydrated.supplier,
    networkAccount: hydrated.sourceAccountLabel,
    reportDate: reportDateIso,
    date: reportDateIso,
    month: Number.isFinite(reportMonth) ? reportMonth : null,
    year: Number.isFinite(reportYear) ? reportYear : null,
    campaignSourceId: hydrated.campaignSourceId ?? null,
    supplierCampaignId: hydrated.supplierCampaignId ?? null,
    brandName: hydrated.brandName ?? null,
    campaignName: hydrated.campaignName ?? null,
    category: hydrated.category ?? null,
    country: hydrated.country ?? null,
    currency: hydrated.currency ?? null,
    campaignTypeCommercial: hydrated.campaignTypeCommercial ?? null,
    campaignChannelType: hydrated.campaignChannelType ?? null,
    campaignType: campaignTypeLabel(hydrated.campaignChannelType),
    couponId: hydrated.couponId ?? null,
    couponCode: hydrated.couponCode ?? null,
    couponSource: hydrated.couponSource ?? null,
    couponScope: hydrated.couponScope ?? null,
    couponSourceScope: joinDefined([couponSource, couponScope]),
    networkTrackingLink: hydrated.networkTrackingLink ?? null,
    mboTrackingLink: hydrated.mboTrackingLink ?? null,
    trackingLinkId: hydrated.trackingLinkId ?? null,
    networkClickId: hydrated.networkClickId ?? null,
    mboClickId: hydrated.mboClickId ?? null,
    subId1: hydrated.subId1 ?? null,
    subId2: hydrated.subId2 ?? null,
    subId3: hydrated.subId3 ?? null,
    subIds: joinDefined([hydrated.subId1, hydrated.subId2, hydrated.subId3]),
    impressions: hydrated.impressions ?? null,
    networkClicks: hydrated.networkClicks ?? null,
    /** 04A Link Clicks = network-reported clicks. */
    linkClicks,
    mboLinkClicks: hydrated.mboLinkClicks ?? null,
    uniqueClicks: hydrated.uniqueClicks ?? null,
    grossOrders: hydrated.grossOrders ?? null,
    pendingOrders: hydrated.pendingOrders ?? null,
    confirmedOrders: hydrated.confirmedOrders ?? null,
    cancelledOrders: hydrated.cancelledOrders ?? null,
    rejectedOrders: hydrated.rejectedOrders ?? null,
    cancelOrders,
    paidOrders: hydrated.paidOrders ?? null,
    grossOrderValue: money(hydrated.grossOrderValue),
    pendingOrderValue: money(hydrated.pendingOrderValue),
    confirmedOrderValue: money(hydrated.confirmedOrderValue),
    cancelledOrderValue: money(hydrated.cancelledOrderValue),
    rejectedOrderValue: money(hydrated.rejectedOrderValue),
    paidOrderValue: money(hydrated.paidOrderValue),
    /** 04A Net* = confirmed/approved supplier figures when separate net fields are absent. */
    netOrders,
    netOrderValue,
    netCommission,
    grossCommission: money(hydrated.grossCommission),
    pendingCommission: money(hydrated.pendingCommission),
    confirmedCommission: money(hydrated.confirmedCommission),
    cancelledCommission: money(hydrated.cancelledCommission),
    rejectedCommission: money(hydrated.rejectedCommission),
    payableCommission: money(hydrated.payableCommission),
    paidCommission: money(hydrated.paidCommission),
    mboReceivable: money(hydrated.mboReceivable),
    mboActuallyReceived: money(hydrated.mboActuallyReceived),
    discountPercent: hydrated.discountPercent != null ? Number(hydrated.discountPercent) : null,
    customerType: hydrated.customerType ?? null,
    devicePlatform: hydrated.devicePlatform ?? null,
    conversionRate: hydrated.conversionRate != null ? Number(hydrated.conversionRate) : null,
    aov: money(hydrated.aov),
    epc: money(hydrated.epc),
    attributionStatus: hydrated.attributionStatus ?? null,
    attribution: attributionLabel(hydrated.attributionStatus),
    reconciliationStatus: hydrated.reconciliationStatus ?? null,
    reconciliation: attributionLabel(hydrated.reconciliationStatus) || humanizeToken(hydrated.reconciliationStatus),
    rawStatus: meta.rawStatus ?? hydrated.rawStatus ?? null,
    mboStandardStatus: meta.mboStandardStatus ?? hydrated.mboStandardStatus ?? null,
    orderDate: meta.orderDate ?? null,
    orderConfirmDate: meta.orderConfirmDate ?? meta.orderConfirmedDate ?? null,
    orderPaymentConfirmDate: meta.orderPaymentConfirmDate ?? meta.orderPaymentConfirmedDate ?? null,
    rawPayloadId: hydrated.rawPayloadId ?? null,
    sourceEndpoint: hydrated.sourceEndpoint ?? null,
    reportGranularity: reportGranularityLabel(hydrated.reportGranularity) ?? hydrated.reportGranularity ?? null,
    lastSyncedAt: iso(hydrated.lastSyncedAt),
    lastUpdatedAt: iso(hydrated.lastUpdatedAt),
    note: "04A Performance Report fields. networkClicks/linkClicks and mboLinkClicks are independent — never substituted.",
  };
}

export function toNetworkOrderDto(order) {
  const meta = order.metadata && typeof order.metadata === "object" ? order.metadata : {};
  const click = order.click || null;
  const tracking = order.click?.trackingLink || order.trackingLink || null;
  const sc = order.campaignSource?.supplierCampaign || null;
  const ft = order.financialSummary || {};
  const validation = order.validationStatus || null;
  const confirmed =
    validation === "VALIDATION_APPROVED" ||
    String(meta.mboStatus || "").toUpperCase() === "CONFIRMED";

  return {
    orderId: order.id,
    network: order.supplier,
    networkAccount: order.sourceAccountLabel,
    supplierOrderId: order.supplierOrderId,
    brandName: order.merchant?.displayName || sc?.merchantNameRaw || null,
    campaignName: order.canonicalCampaign?.displayName || sc?.campaignName || null,
    campaignSourceId: order.campaignSourceId ?? null,
    supplierCampaignId: sc?.supplierCampaignId ?? null,
    couponCode: meta.couponCode ?? order.couponCode ?? null,
    orderDate: iso(order.orderDate),
    confirmedDate: iso(order.validationChangedAt || meta.confirmedDate || order.approvedDate),
    orderValue: money(order.orderValue),
    currency: order.currency ?? null,
    commission: money(ft.supplierReceivable ?? meta.commission ?? order.lastApprovedSupplierCommission),
    payableCommission: money(ft.supplierReceivable),
    receivedCommission:
      order.supplierPaymentStatus === "PAYMENT_RECEIVED"
        ? money(ft.supplierReceivable ?? meta.receivedCommission)
        : money(meta.receivedCommission ?? null),
    rawStatus: meta.rawStatus ?? meta.supplierStatus ?? null,
    mboStatus: confirmed ? "CONFIRMED" : mapOrderMboStatus(validation, order.supplierPaymentStatus),
    validationStatus: validation,
    supplierPaymentStatus: order.supplierPaymentStatus ?? null,
    networkTrackingLink: sc?.trackingUrl ?? meta.networkTrackingLink ?? null,
    mboTrackingLink: tracking?.mboTrackingUrl || meta.mboTrackingLink || null,
    trackingLinkId: tracking?.id || order.click?.trackingLinkId || null,
    networkClickId: meta.networkClickId ?? meta.supplierClickId ?? null,
    mboClickId: click?.id ?? null,
    subId1: click?.subId ?? order.conversions?.[0]?.subId ?? meta.subId1 ?? null,
    subId2: meta.subId2 ?? null,
    subId3: meta.subId3 ?? null,
    billingMonth: order.orderDate ? order.orderDate.getUTCMonth() + 1 : null,
    billingYear: order.orderDate ? order.orderDate.getUTCFullYear() : null,
    paymentReference: meta.paymentReference ?? null,
    bankReceivedAt: iso(meta.bankReceivedAt || order.supplierPaymentChangedAt),
    reconciliationStatus: meta.reconciliationStatus ?? null,
    partialPayment: Boolean(meta.partialPayment),
    rawPayloadId: order.rawPayloadId ?? null,
  };
}

function mapOrderMboStatus(validation, payment) {
  const v = String(validation || "").toUpperCase();
  const p = String(payment || "").toUpperCase();
  if (p === "PAYMENT_RECEIVED") return "PAID";
  if (p === "PAYMENT_PAYABLE") return "PAYABLE";
  if (v === "VALIDATION_APPROVED") return "CONFIRMED";
  if (v === "VALIDATION_REJECTED") return "REJECTED";
  if (v === "VALIDATION_NEEDS_REVIEW") return "NEEDS_REVIEW";
  if (v === "VALIDATION_PENDING") return "PENDING";
  return null;
}

export {
  buildMappingCertificationChecklist,
  deriveMappingStatus,
  deriveMboReady,
  deriveCampaignChannelType,
  mapCampaignStatus,
  resolveRelationshipStatus,
  formatCommissionSummary,
  deriveCouponRemainingQuantity,
};
