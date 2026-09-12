/**
 * Epic 7 + v15 correction — Staff/admin contract DTOs (workbook 03A / 03G / 04A / 07E).
 * Never use these for CLIENT portal responses.
 */

import {
  iso,
  isoDate,
  money,
  parseExactDiscountPercent,
  mapRelationshipStatus,
  mapCampaignStatus,
  mapCampaignType,
  resolveRelationshipStatus,
  deriveIsAssignable,
  deriveMboReady,
  deriveCampaignChannelType,
  deriveMappingStatus,
  formatCommissionSummary,
  monthYearFromDate,
  mapCanonicalPaymentStatus,
  buildMappingCertificationChecklist,
} from "./v15FieldContract.js";
import {
  extractMboActualReceipt,
} from "../finance/financeSeparation.contract.js";
import {
  projectBrandIdentity,
  brandIdentityToAdminLinks,
} from "../merchant/brandIdentity.js";

export const V15_CLIENT_RULE_TYPES = Object.freeze([
  "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
  "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE",
  "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER",
  "MANUAL_APPROVED_CLIENT_COMMISSION",
  "DISPLAY_RANGE_WITH_ACTUAL_SPLIT",
]);

export function formatAdminCommissionRuleType(type) {
  const t = String(type || "").toUpperCase();
  if (t === "TIERED") {
    return {
      commissionType: t,
      label: "TIERED — Not Implemented",
      status: "NOT_IMPLEMENTED",
      creatable: false,
      activatable: false,
    };
  }
  if (V15_CLIENT_RULE_TYPES.includes(t) || t === "PERCENT") {
    return {
      commissionType: t,
      label: t === "PERCENT" ? "PERCENT (legacy alias)" : t,
      status: "SUPPORTED",
      creatable: true,
      activatable: true,
    };
  }
  if (t === "FIXED") {
    return {
      commissionType: t,
      label: "FIXED (legacy — needs fixedAmount)",
      status: "LEGACY",
      creatable: true,
      activatable: true,
    };
  }
  return {
    commissionType: t || "UNKNOWN",
    label: t || "UNKNOWN",
    status: "UNKNOWN",
    creatable: false,
    activatable: false,
  };
}

function hasHttpUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build 03G admin campaign contract from service-assembled row.
 * Missing joins stay null — never invent UNKNOWN / USD / commission.
 */
export function toAdminCampaignListDto(row) {
  const merchant = row.merchant || null;
  const primary = row.primarySource || row.sources?.[0] || null;
  const sc = primary?.supplierCampaign || null;
  const hasCampaignSource = Boolean(primary);
  const supplier = sc?.supplier || primary?.supplier || null;

  const brand = projectBrandIdentity(merchant, sc);
  const brandLinks = brandIdentityToAdminLinks(brand);
  const brandName = brandLinks.brandName;
  const brandWebsiteLink = brandLinks.brandWebsiteLink;
  const brandLogoLink = brandLinks.brandLogoLink;
  const campaignName = row.displayName || sc?.campaignName || null;

  const countryCodes =
    Array.isArray(sc?.countryCodes) && sc.countryCodes.length
      ? sc.countryCodes
      : Array.isArray(row.countries) && row.countries.length
        ? row.countries
        : null;
  // Do not invent currency from country (v15 regional rule is not a silent USD/INR default).
  const currency = sc?.currencyCode || row.defaultCurrency || null;

  const campaignType = mapCampaignType(sc?.campaignType, sc?.pricingModel);
  const campaignStatus = mapCampaignStatus(sc?.campaignStatus);
  const relationshipStatus = resolveRelationshipStatus(primary, sc);

  const trackingUrl = sc?.trackingUrl || null;
  let linkSupport = null;
  let couponSupport = null;
  let deeplinkSupport = null;
  if (hasCampaignSource) {
    // Capability from CampaignSource / supplier flags — do not infer couponSupport from coupon rows here.
    linkSupport =
      Boolean(primary?.supportsLink) ||
      hasHttpUrl(trackingUrl) ||
      hasHttpUrl(sc?.destinationUrl);
    couponSupport = Boolean(primary?.supportsCoupon);
    deeplinkSupport =
      Boolean(sc?.deepLinkingEnabled) ||
      (Array.isArray(primary?.channelSupport) && primary.channelSupport.includes("DEEPLINK"));
  }

  const rules = row.supplierCommissionRules || [];
  const commissionRuleCount =
    row.commissionRuleCount != null ? Number(row.commissionRuleCount) : rules.length;
  const grossEstimate = primary?.grossCommission ?? sc?.defaultCommissionValue ?? null;
  const ratePercents = rules
    .map((r) => (r.ratePercent != null ? Number(r.ratePercent) : null))
    .filter((n) => Number.isFinite(n));
  const campaignCommission = formatCommissionSummary({
    grossCommission: grossEstimate,
    rules: commissionRuleCount,
    commissionUnit: sc?.commissionUnit ?? null,
    ratePercents,
  });

  const commissionAvailable =
    commissionRuleCount > 0 || (grossEstimate != null && Number(grossEstimate) !== 0);

  const certification = row.mappingCertification || sc?.mappingCertification || null;
  const checklistEval = buildMappingCertificationChecklist({
    supplierCampaign: sc,
    hasCampaignSource,
    commissionAvailable,
    mapperVersion: sc?.mapperVersion,
  });
  const mappingStatus = hasCampaignSource
    ? row.mappingStatus ||
      deriveMappingStatus({
        syncConflict: sc?.syncConflict,
        merchantId: sc?.merchantId || row.merchantId,
        rawPayloadId: sc?.rawPayloadId,
        certificationStatus: certification?.status || null,
        checklistValid: Boolean(certification?.status === "CERTIFIED" && checklistEval.valid),
      })
    : "NEEDS_REVIEW";

  const isAssignable = deriveIsAssignable({
    campaignStatus: sc?.campaignStatus,
    relationshipStatus,
    supportsLink: linkSupport,
    supportsCoupon: couponSupport,
    supportsDeeplink: deeplinkSupport,
    commissionAvailable,
    hasCampaignSource,
    mappingStatus,
  });

  const brandMappingComplete = Boolean(sc?.merchantId || row.merchantId);
  const hasUsableAsset = Boolean(linkSupport || couponSupport || deeplinkSupport);
  const sourceHidden =
    String(row.visibility || "").toUpperCase() === "HIDDEN" ||
    String(row.status || "").toUpperCase() === "ARCHIVED";
  const mboReady = deriveMboReady({
    campaignStatus: sc?.campaignStatus,
    relationshipStatus,
    brandMappingComplete,
    mappingStatus,
    commissionAvailable,
    hasUsableAsset,
    sourceHidden,
    hasCampaignSource,
  });
  const campaignChannelType = deriveCampaignChannelType({
    supportsLink: linkSupport,
    supportsCoupon: couponSupport,
    supportsDeeplink: deeplinkSupport,
    trackingUrl,
  });

  const discountPercent =
    row.discountPercent !== undefined ? parseExactDiscountPercent(row.discountPercent) : null;

  const warnings = [...(row.operationalWarnings || [])];
  if (!hasCampaignSource && !warnings.includes("NO_ACTIVE_SOURCE")) {
    warnings.push("NO_ACTIVE_SOURCE");
  }

  return {
    id: row.id,

    networkSource: supplier ?? null,
    brand,
    brandName,
    brandWebsiteLink: brandWebsiteLink || null,
    brandLogoLink: brandLogoLink || null,
    campaignName,
    primaryCategory: row.category || merchant?.category || sc?.categoryName || null,
    secondaryCategory: row.secondaryCategory ?? null,
    country: countryCodes,
    currency,
    campaignType,
    campaignDescription: sc?.campaignDescription ?? null,
    campaignTermsAndCondition: row.campaignTermsAndCondition ?? null,
    campaignCommission,
    campaignTrackingLink: trackingUrl,
    mboTrackingLink: sc?.mboTrackingUrl ?? null,
    campaignStartDate: isoDate(sc?.campaignStartDate),
    campaignEndDate: row.campaignEndDate ?? null,
    campaignStatus,
    campaignPromotionDescription: row.campaignPromotionDescription ?? null,
    discountPercent,
    couponCode: row.couponCode ?? null,
    couponExpiry: row.couponExpiry ?? null,
    relationshipStatus,
    isAssignable,
    mboReady,
    campaignChannelType,
    brandMappingComplete,
    supplierCampaignId: sc?.supplierCampaignId ?? null,
    supplierCampaignRowId: sc?.id ?? null,
    campaignSourceId: primary?.id ?? null,
    networkAccount: sc?.sourceAccountLabel ?? primary?.supplierCampaign?.sourceAccountLabel ?? null,
    linkSupport,
    couponSupport,
    deeplinkSupport,
    commissionRuleCount,
    lastSyncedAt: iso(sc?.lastSyncedAt),
    mappingStatus,
    mappingCertificationStatus: certification?.status ?? null,
    rawPayloadId: sc?.rawPayloadId ?? null,
    rawPayloadLink: sc?.rawPayloadId ? `/ops/raw-payloads/${sc.rawPayloadId}` : null,

    commissionDisplayEstimate: grossEstimate != null ? String(grossEstimate) : null,
    commissionDisplayNote:
      row.commissionDisplayNote ??
      "Campaign display commission is an estimate — not payout truth. FinancialTransaction is SoT.",
    supplierCommissionRules: Array.isArray(rules)
      ? rules.map((r) => ({
          id: r.id,
          basis: r.basis ?? "UNKNOWN",
          supplierRuleType: r.supplierRuleType ?? null,
          ratePercent: money(r.ratePercent),
          fixedAmount: money(r.fixedAmount),
          currency: r.currency ?? null,
          conditions: r.metadata?.conditions ?? r.conditions ?? null,
          effectiveFrom: iso(r.effectiveFrom),
          effectiveUntil: iso(r.effectiveUntil),
        }))
      : [],

    catalogStatus: row.status ?? null,
    visibility: row.visibility ?? null,
    merchantId: row.merchantId ?? null,
    eligibilityState: isAssignable ? "ASSIGNABLE" : "NOT_ASSIGNABLE",
    assignmentCount: row.assignmentCount ?? 0,
    conversionCount: row.conversionCount ?? 0,
    orderCount: row.orderCount ?? 0,
    openExceptionCount: row.openExceptionCount ?? 0,
    productFeedAvailability: row.productFeedAvailability ?? null,
    operationalWarnings: warnings,
    updatedAt: iso(row.updatedAt),

    // Legacy aliases for older ops clients — same truthful nulls, not invented UNKNOWN.
    displayName: campaignName,
    supplier: supplier ?? null,
    status: campaignStatus,
    category: row.category ?? null,
    countries: countryCodes,
    defaultCurrency: currency,
    primaryCampaignSourceId: primary?.id ?? null,
  };
}

export function toAdminCampaignDetailDto(row) {
  const list = toAdminCampaignListDto(row);
  const primary = row.primarySource || row.sources?.[0] || null;
  const primaryCoupons = primary?.supplierCampaign?.coupons || [];
  const usableCoupon =
    primaryCoupons.find((c) => c.couponCode || c.couponLink) || primaryCoupons[0] || null;
  return {
    ...list,
    couponCode: list.couponCode || usableCoupon?.couponCode || null,
    couponExpiry: list.couponExpiry || isoDate(usableCoupon?.couponEndDate) || null,
    couponDescription: usableCoupon?.couponDescription || null,
    sources: (row.sources || []).map((s) => {
      const sc = s.supplierCampaign || null;
      return {
        id: s.id,
        networkSource: sc?.supplier ?? s.supplier ?? null,
        relationshipStatus: resolveRelationshipStatus(s, sc),
        isPrimary: Boolean(s.isPrimary),
        isActive: Boolean(s.isActive),
        linkSupport: Boolean(s.supportsLink) || hasHttpUrl(sc?.trackingUrl),
        couponSupport: Boolean(s.supportsCoupon),
        deeplinkSupport:
          Boolean(sc?.deepLinkingEnabled) ||
          (Array.isArray(s.channelSupport) && s.channelSupport.includes("DEEPLINK")),
        supplierCampaignId: sc?.supplierCampaignId ?? null,
        campaignTrackingLink: sc?.trackingUrl ?? null,
        campaignStatus: mapCampaignStatus(sc?.campaignStatus),
        campaignType: mapCampaignType(sc?.campaignType, sc?.pricingModel),
        lastSyncedAt: iso(sc?.lastSyncedAt),
        grossCommissionEstimate: money(s.grossCommission),
        estimateOnly: true,
      };
    }),
    clientAssignments: (row.assignments || []).map((a) => ({
      id: a.id,
      clientId: a.clientId,
      clientName: a.client?.name ?? null,
      status: a.status,
      published: Boolean(a.published),
      campaignSourceId: a.campaignSourceId ?? null,
      mboTrackingUrl: a.mboTrackingUrl ?? null,
    })),
    tracking: row.tracking ?? { state: "UNKNOWN", primaryLinkCount: 0 },
    commissionRules: (row.commissionRules || []).map((r) => ({
      id: r.id,
      ...formatAdminCommissionRuleType(r.commissionType),
      ruleStatus: r.status,
      effectiveFrom: iso(r.effectiveFrom),
      effectiveUntil: iso(r.effectiveUntil),
    })),
    productFeeds: row.productFeeds || [],
    exceptions: row.exceptions || { open: 0, samples: [] },
    health: row.health || { sync: "UNKNOWN" },
  };
}

export function toAdminPerformanceDto(row, { includeFinancial = false } = {}) {
  const reportDate = row.reportDate ?? row.date ?? null;
  const { month, year } = monthYearFromDate(reportDate);

  const channelTypeRaw = row.channelType ?? row.campaignType ?? null;
  const channelType = normalizeWorkbookChannelType(channelTypeRaw);

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

  const base = {
    clientName: row.clientName ?? null,
    brandName: row.brandName ?? null,
    campaignName: row.campaignName ?? null,
    networkSource: row.networkSource ?? null,
    channelType,
    // Backward-compatible alias for older UI that read campaignType as channel
    campaignType: row.clientCampaignType ?? channelType,
    couponCode: row.couponCode ?? null,
    linkClicks: Number.isFinite(linkClicks) ? linkClicks : null,
    grossOrders: Number.isFinite(grossOrders) ? grossOrders : null,
    grossOrderValue: money(row.grossOrderValue),
    grossCommission: includeFinancial ? money(row.grossCommission) : null,
    clientCommission: includeFinancial ? money(row.clientCommission) : null,
    mboCommission: includeFinancial ? money(row.mboCommission) : null,
    netOrders: Number.isFinite(netOrders) ? netOrders : null,
    netOrderValue: money(row.netOrderValue),
    netCommission: includeFinancial ? money(row.netCommission) : null,
    cancelOrders: row.cancelOrders != null ? Number(row.cancelOrders) : null,
    pendingOrders: row.pendingOrders != null ? Number(row.pendingOrders) : null,
    rejectedOrders: row.rejectedOrders != null ? Number(row.rejectedOrders) : null,
    cancelledOrders: row.cancelledOrders != null ? Number(row.cancelledOrders) : null,
    confirmedOrders:
      row.confirmedOrders != null
        ? Number(row.confirmedOrders)
        : row.approvedConversionCount != null
          ? Number(row.approvedConversionCount)
          : null,
    country: row.country ?? null,
    customerType: null, // never invent — no authoritative source
    currency: row.currency ?? null,
    date: typeof reportDate === "string" ? String(reportDate).slice(0, 10) : isoDate(reportDate),
    month,
    year,
    orderDate: null,
    orderConfirmDate: null,
    orderPaymentConfirmDate: null,
    discountPercent: parseExactDiscountPercent(row.discountPercent),
    clientId: row.clientId ?? null,
    canonicalCampaignId: row.canonicalCampaignId ?? null,
    campaignSourceId: row.campaignSourceId ?? null,
  };

  const financial = includeFinancial
    ? {
        grossCommission: base.grossCommission,
        netCommission: base.netCommission,
        source: row.financeSource ?? "daily_report",
        note: "Supplier commission figures before client split. Not client payable.",
      }
    : { state: "REDACTED", reason: "insufficient_permission" };

  const unavailableFields = [];
  if (base.customerType == null) unavailableFields.push("customerType");
  if (base.channelType == null) unavailableFields.push("channelType");
  if (base.couponCode == null) unavailableFields.push("couponCode");
  if (base.orderConfirmDate == null) unavailableFields.push("orderConfirmDate");
  if (base.brandName == null) unavailableFields.push("brandName");
  if (base.campaignSourceId == null) unavailableFields.push("campaignSourceId");

  return {
    ...base,
    operational: {
      brandName: base.brandName,
      campaignName: base.campaignName,
      networkSource: base.networkSource,
      campaignSourceId: base.campaignSourceId,
      country: base.country,
      currency: base.currency,
      date: base.date,
      month: base.month,
      year: base.year,
      linkClicks: base.linkClicks,
      grossOrders: base.grossOrders,
      netOrders: base.netOrders,
      cancelOrders: base.cancelOrders,
      confirmedOrders: base.confirmedOrders,
      channelType: base.channelType,
      couponCode: base.couponCode,
      customerType: base.customerType,
      grossOrderValue: base.grossOrderValue,
      netOrderValue: base.netOrderValue,
    },
    financial,
    unavailableFields,
  };
}

function normalizeWorkbookChannelType(label) {
  if (label == null || label === "") return null;
  const v = String(label).trim();
  if (v === "Link" || v === "LINK") return "LINK";
  if (v === "Coupon" || v === "COUPON") return "COUPON";
  if (
    v === "Link + Coupon" ||
    v === "LINK_AND_COUPON" ||
    v === "LINK_+_COUPON" ||
    v === "BOTH"
  ) {
    return "LINK_AND_COUPON";
  }
  return null;
}

export function toAdminOrderDto(order, { includeFinancial = false } = {}) {
  const nc = order.networkContext || {};
  const validation = order.validationStatus ?? "UNKNOWN";
  const payment = order.supplierPaymentStatus ?? order.paymentStatus ?? "UNKNOWN";
  const canonicalOrderStatus = nc.mboOrderStatus ?? null;
  const confirmed =
    validation === "VALIDATION_APPROVED" ||
    canonicalOrderStatus === "CONFIRMED" ||
    String(nc.mboStatus || "").toUpperCase() === "CONFIRMED";
  let mboStatus = canonicalOrderStatus ?? nc.mboStatus ?? null;
  if (!mboStatus) {
    const p = String(payment || "").toUpperCase();
    if (p === "PAYMENT_RECEIVED") mboStatus = "PAID";
    else if (p === "PAYMENT_PAYABLE" || p === "PAYMENT_INVOICED") mboStatus = "PAYABLE";
    else if (confirmed) mboStatus = "CONFIRMED";
    else if (validation === "VALIDATION_REJECTED") mboStatus = "REJECTED";
    else if (validation === "VALIDATION_NEEDS_REVIEW") mboStatus = "NEEDS_REVIEW";
    else if (validation === "VALIDATION_PENDING") mboStatus = "PENDING";
  }
  const orderDate = order.orderDate ? new Date(order.orderDate) : null;
  const couponCode = nc.couponCode ?? null;
  const couponLink = nc.couponLink ?? nc.mboTrackingLink ?? nc.networkTrackingLink ?? null;
  const couponCodeOrLink =
    couponCode && couponLink
      ? `${couponCode} / ${couponLink}`
      : couponCode || couponLink || null;
  const base = {
    orderId: order.id,
    clientId: order.clientId ?? null,
    clientName: order.client?.name ?? null,
    campaignId: order.canonicalCampaignId ?? null,
    campaignName:
      order.canonicalCampaign?.displayName ?? nc.campaignName ?? null,
    campaignType: nc.campaignType ?? null,
    merchantName:
      order.merchant?.displayName ??
      order.canonicalCampaign?.merchant?.displayName ??
      nc.merchantName ??
      null,
    brandName:
      order.merchant?.displayName ??
      order.canonicalCampaign?.merchant?.displayName ??
      nc.merchantName ??
      null,
    orderValue: money(order.orderValue),
    currency: order.currency ?? null,
    commissionCurrency: nc.commissionCurrency ?? order.currency ?? null,
    validationStatus: validation,
    supplierPaymentStatus: payment,
    clientPaymentStatus: order.clientPaymentStatus ?? "UNKNOWN",
    paymentStatus: nc.paymentStatus ?? null,
    orderDate: iso(order.orderDate),
    confirmedDate: iso(nc.confirmedDate),
    paymentConfirmedDate: iso(nc.paymentConfirmedDate),
    exceptionCount: order.exceptionCount ?? 0,
    itemValidationSummary: order.itemValidationSummary ?? null,
    network: nc.network ?? order.supplier ?? null,
    networkAccount: nc.networkAccount ?? null,
    supplierOrderId: nc.supplierOrderId ?? order.supplierOrderId ?? null,
    networkConversionId: nc.networkConversionId ?? null,
    dedupeKey: nc.dedupeKey ?? order.metadata?.dedupeKey ?? null,
    mboCanonicalObject: nc.mboCanonicalObject ?? "OrderConversion",
    attributionStatus: nc.attributionStatus ?? null,
    attributionEvidence: nc.attributionEvidence ?? null,
    attributionEvidenceLabel: nc.attributionEvidenceLabel ?? null,
    attributionReviewReason: nc.attributionReviewReason ?? null,
    attributionReviewReasonLabel: nc.attributionReviewReasonLabel ?? null,
    clientAssignmentId: nc.clientAssignmentId ?? null,
    campaignSourceId: nc.campaignSourceId ?? order.campaignSourceId ?? null,
    supplierCampaignId: nc.supplierCampaignId ?? null,
    couponCode,
    couponType: nc.couponType ?? null,
    couponLink: nc.couponLink ?? null,
    couponCodeOrLink,
    networkTrackingLink: nc.networkTrackingLink ?? null,
    mboTrackingLink: nc.mboTrackingLink ?? null,
    trackingLinkId: nc.trackingLinkId ?? null,
    networkClickId: nc.networkClickId ?? null,
    mboClickId: nc.mboClickId ?? null,
    subId1: nc.subId1 ?? null,
    subId2: nc.subId2 ?? null,
    subId3: nc.subId3 ?? null,
    rawStatus: nc.rawStatus ?? nc.networkRawStatus ?? null,
    networkRawStatus: nc.networkRawStatus ?? nc.rawStatus ?? null,
    mboOrderStatus: nc.mboOrderStatus ?? null,
    mboStatus,
    orderStatus: canonicalOrderStatus ?? mboStatus,
    rawPayloadId: nc.rawPayloadId ?? order.rawPayloadId ?? null,
    billingMonth: orderDate && !Number.isNaN(orderDate.getTime()) ? orderDate.getUTCMonth() + 1 : null,
    billingYear: orderDate && !Number.isNaN(orderDate.getTime()) ? orderDate.getUTCFullYear() : null,
    paymentReference: nc.paymentReference ?? null,
    bankReceivedAt: iso(nc.bankReceivedAt ?? null),
    mboReceivedDateTime: nc.mboReceivedDateTime ?? null,
    mboReceivedAmount: nc.mboReceivedAmount ?? null,
    networkPaymentEvidence: nc.networkPaymentEvidence ?? null,
    clientPayableEligible: nc.clientPayableEligible ?? false,
    reconciliationStatus: nc.reconciliationStatus ?? null,
    lastSyncedAt: iso(nc.lastSyncedAt || order.updatedAt),
    items: Array.isArray(order.items)
      ? order.items.map((it) => ({
          id: it.id,
          lineKey: it.lineKey ?? null,
          sku: it.sku ?? null,
          itemValue: money(it.itemValue),
          validationStatus: it.validationStatus ?? "UNKNOWN",
          itemCommission: includeFinancial ? money(it.commission) : undefined,
        }))
      : undefined,
  };
  if (!includeFinancial) {
    return {
      ...base,
      mboReceived: null,
      financial: { state: "REDACTED", reason: "insufficient_permission" },
    };
  }
  const ft = order.financialSummary || {};
  const payable = money(ft.supplierReceivable);
  const mboReceipt = extractMboActualReceipt({
    order,
    financialTransactions: order.financialTransactions || [],
  });
  const received = mboReceipt?.amount != null ? money(mboReceipt.amount) : null;
  return {
    ...base,
    mboReceived: received,
    // v13 aliases
    supplierActualCommission: payable,
    clientCommission: money(ft.clientPayable),
    mboCommissionMargin: money(ft.mboMargin),
    clientSharePercent: nc.clientSharePercent ?? null,
    mboSharePercent: nc.mboSharePercent ?? null,
    financial: {
      clientPayable: money(ft.clientPayable),
      supplierReceivable: payable,
      mboMargin: money(ft.mboMargin),
      ftStatus: ft.ftStatus ?? "UNKNOWN",
      source: ft.source ?? null,
      adjustmentCount: ft.adjustmentCount ?? 0,
      reversalCount: ft.reversalCount ?? 0,
      note: "Staff/ops only. Corrections via adjustment/reversal services — never mutate original FT.",
    },
  };
}

/**
 * Feed-level admin row.
 *
 * `lastError` holds whatever the ingest path caught — an ORM invocation, a driver failure, an FTP
 * banner carrying credentials — and it used to be returned verbatim. It is now reduced at the
 * boundary to a boolean and, where the shape is recognised, a fixed code drawn from a closed set.
 * No provider text, no substring of it, and no length-derived hint leaves this function.
 *
 * `feedUrl`, `metadata`, `compressedLocation` and `aid` are likewise never returned; only the
 * presence of a feed URL is reported.
 */
export function toAdminProductFeedDto(feed) {
  return {
    id: feed.id,
    supplier: feed.supplier ?? "UNKNOWN",
    sourceAccountLabel: feed.sourceAccountLabel ?? null,
    feedName: feed.feedName ?? null,
    feedExternalId: feed.feedExternalId ?? null,
    feedFormat: feed.feedFormat ?? null,
    status: feed.feedStatus ?? feed.status ?? "UNKNOWN",
    lastSyncAt: iso(feed.lastSyncedAt || feed.updatedAt),
    campaignSourceId: feed.campaignSourceId ?? null,
    itemCount: feed._count?.feedItems ?? feed.itemCount ?? 0,
    productCount: feed._count?.products ?? feed.productCount ?? 0,
    assignmentCount: feed.assignmentCount ?? 0,
    errorCount: feed.errorCount ?? 0,
    exceptionCount: feed.exceptionCount ?? 0,
    hasError: hasFeedError(feed.lastError),
    safeErrorCode: safeFeedErrorCode(feed.lastError),
    hasFeedUrl: Boolean(String(feed.feedUrl ?? "").trim()),
    mappingVersion: feed.mappingVersion ?? null,
    createdAt: iso(feed.createdAt),
    updatedAt: iso(feed.updatedAt),
  };
}

export function hasFeedError(lastError) {
  return String(lastError ?? "").trim() !== "";
}

/**
 * A fixed code for the few failure shapes worth telling an operator apart, or the catch-all.
 *
 * The returned value is always one of these literals — it is chosen by the input but never built
 * from it, so no provider text can travel out through this function however the input is shaped.
 */
export const FEED_ERROR_CODES = Object.freeze([
  "NONE",
  "AUTH_FAILED",
  "NOT_FOUND",
  "TIMEOUT",
  "NETWORK_UNREACHABLE",
  "PARSE_FAILED",
  "MAPPING_FAILED",
  "UPSTREAM_ERROR",
  "UNCLASSIFIED",
]);

export function safeFeedErrorCode(lastError) {
  const text = String(lastError ?? "").trim();
  if (!text) return "NONE";
  const t = text.toLowerCase();
  if (/\b(401|403|unauthor|forbidden|permission denied|login failed|invalid credentials|authentication)\b/.test(t)) return "AUTH_FAILED";
  if (/\b(404|not found|no such file|enoent)\b/.test(t)) return "NOT_FOUND";
  if (/\b(timeout|timed out|etimedout|deadline exceeded)\b/.test(t)) return "TIMEOUT";
  if (/\b(econnrefused|enotfound|ehostunreach|enetunreach|dns|socket hang up)\b/.test(t)) return "NETWORK_UNREACHABLE";
  if (/\b(parse|malformed|unexpected token|invalid xml|invalid json|csv)\b/.test(t)) return "PARSE_FAILED";
  if (/\b(mapping_failed|mapping failed|missing_supplier_product_id|schema)\b/.test(t)) return "MAPPING_FAILED";
  if (/\b(5\d\d|internal server error|bad gateway|service unavailable)\b/.test(t)) return "UPSTREAM_ERROR";
  return "UNCLASSIFIED";
}

/** Admin 05C payment-status row — supplier payable, not client payable / not withdrawals. */
export function toAdminPaymentStatusDto(row) {
  const reportDate = row.date ?? row.reportDate ?? null;
  const { month, year } = monthYearFromDate(reportDate);
  return {
    billingMonth: row.billingMonth ?? null,
    billingYear: row.billingYear ?? null,
    brandName: row.brandName ?? null,
    campaignType: row.campaignType ?? null,
    campaignSourceId: row.campaignSourceId ?? null,
    network: row.network ?? row.supplier ?? null,
    networkSource: row.networkSource ?? row.network ?? row.supplier ?? null,
    networkAccount: row.networkAccount ?? row.sourceAccountLabel ?? null,
    orderId: row.orderId ?? null,
    couponCode: row.couponCode ?? null,
    networkTrackingLink: row.networkTrackingLink ?? null,
    mboTrackingLink: row.mboTrackingLink ?? null,
    linkClicks: row.linkClicks ?? null,
    payableOrders: row.payableOrders ?? null,
    payableCommission: money(row.payableCommission),
    /** NETWORK PAYABLE — amount due from network (not client). */
    networkPayable: money(row.networkPayable ?? row.payableCommission),
    /** MBO ACTUALLY RECEIVED — bank/settlement evidence only; null when unknown. Never copy payable. */
    mboActuallyReceived: money(
      row.mboActuallyReceived != null
        ? row.mboActuallyReceived
        : row.receivedCommission != null
          ? row.receivedCommission
          : null,
    ),
    paymentStatus:
      row.paymentStatus ||
      mapCanonicalPaymentStatus({
        supplierPaymentStatus: row.supplierPaymentStatus,
        clientPaymentStatus: row.clientPaymentStatus,
        validationStatus: row.validationStatus,
      }),
    currency: row.currency ?? null,
    date: typeof reportDate === "string" ? String(reportDate).slice(0, 10) : isoDate(reportDate),
    month: row.month ?? month,
    year: row.year ?? year,
    orderDate: isoDate(row.orderDate),
    orderConfirmDate: isoDate(row.orderConfirmDate),
    orderPaymentConfirmDate: isoDate(row.orderPaymentConfirmDate),
    payableCommissionSource: row.payableCommissionSource ?? "supplier_receivable",
    bankReference: row.bankReference ?? row.paymentReference ?? null,
    reconciliationStatus: row.reconciliationStatus ?? null,
    note:
      row.note ??
      "Admin 05C: networkPayable is supplier receivable. mboActuallyReceived is settlement evidence only — never invent.",
  };
}

export const CLIENT_FORBIDDEN_FINANCE_KEYS = Object.freeze([
  "supplierReceivable",
  "mboMargin",
  "supplierCommission",
  "mboCommission",
  "grossCommission",
  "rawPayload",
  "rawPayloadId",
  "encryptedAccessToken",
  "supplierTrackingUrl",
  "campaignTrackingLink",
  "networkSource",
  "supplierCampaignId",
]);
