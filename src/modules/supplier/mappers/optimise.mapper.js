import {
  buildCampaignBaseFromEntity,
  buildCouponBaseFromEntity,
  extractCountryCodesFromRaw,
  normalizeTermsText,
  extractSecondaryCategoryFromRaw,
  extractCampaignStartDateFromRaw,
  extractCampaignEndDateFromRaw,
} from "./shared.js";
import { normalizeCampaignStatus, normalizeParticipationStatus } from "./status.js";

/**
 * Map a single Optimise relationship token → ParticipationStatus.
 * Master Field Mapping: publishers[].campaignSubStatus / publisherEligibility.
 */
function mapOptimiseRelationshipToken(token, evidenceSource) {
  const status = String(token ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "");
  if (!status) {
    return null;
  }

  if (status === "notapplied" || status === "not_applied" || status === "ineligible") {
    return {
      participationStatus: "NOT_JOINED",
      isJoined: false,
      evidenceSource,
      evidenceValue: String(token),
    };
  }
  if (status === "live" || status === "eligible" || status === "joined" || status === "approved") {
    return {
      participationStatus: "JOINED",
      isJoined: true,
      evidenceSource,
      evidenceValue: String(token),
    };
  }
  if (status === "closed" || status === "rejected" || status === "declined") {
    return {
      participationStatus: "NOT_JOINED",
      isJoined: false,
      evidenceSource,
      evidenceValue: String(token),
    };
  }
  if (status === "waiting" || status === "pending") {
    return {
      participationStatus: "PENDING",
      isJoined: false,
      evidenceSource,
      evidenceValue: String(token),
    };
  }
  if (status === "paused") {
    return {
      participationStatus: "UNKNOWN",
      isJoined: false,
      evidenceSource,
      evidenceValue: String(token),
    };
  }

  const normalized = normalizeParticipationStatus(token);
  if (normalized !== "UNKNOWN") {
    return {
      participationStatus: normalized,
      isJoined: normalized === "JOINED",
      evidenceSource,
      evidenceValue: String(token),
    };
  }
  return null;
}

/**
 * Optimise publisher relationship (Master Field Mapping):
 * 1) publishers[].campaignSubStatus
 * 2) publisherEligibility
 * 3) top-level status fallback (notapplied / live / waiting / …)
 *
 * Do NOT treat isEligible / acceptingApplications alone as JOINED
 * (eligible to apply ≠ joined).
 */
export function mapOptimisePublisherRelationship(raw = {}) {
  if (raw?.rejectedDate) {
    return {
      participationStatus: "NOT_JOINED",
      isJoined: false,
      evidenceSource: "optimise.rejectedDate",
      evidenceValue: String(raw.rejectedDate),
    };
  }

  const publishers = Array.isArray(raw.publishers) ? raw.publishers : [];
  for (const pub of publishers) {
    const sub = pub?.campaignSubStatus ?? pub?.campaign_sub_status ?? pub?.status;
    const fromPub = mapOptimiseRelationshipToken(sub, "optimise.publishers[].campaignSubStatus");
    if (fromPub) return fromPub;
  }

  if (raw.publisherEligibility != null && raw.publisherEligibility !== "") {
    const fromElig = mapOptimiseRelationshipToken(
      raw.publisherEligibility,
      "optimise.publisherEligibility",
    );
    if (fromElig) return fromElig;
  }

  const status = String(raw?.status ?? "")
    .trim()
    .toLowerCase();

  if (status === "notapplied") {
    return {
      participationStatus: "NOT_JOINED",
      isJoined: false,
      evidenceSource: "optimise.status",
      evidenceValue: "notapplied",
    };
  }

  if (status === "live") {
    return {
      participationStatus: "JOINED",
      isJoined: true,
      evidenceSource: "optimise.status",
      evidenceValue: "live",
    };
  }

  if (status === "closed") {
    return {
      participationStatus: "NOT_JOINED",
      isJoined: false,
      evidenceSource: "optimise.status",
      evidenceValue: "closed",
    };
  }

  if (status === "waiting" || status === "pending") {
    return {
      participationStatus: "PENDING",
      isJoined: false,
      evidenceSource: "optimise.status",
      evidenceValue: status,
    };
  }

  if (status === "paused") {
    if (raw?.cancelledDate) {
      return {
        participationStatus: "NOT_JOINED",
        isJoined: false,
        evidenceSource: "optimise.cancelledDate",
        evidenceValue: String(raw.cancelledDate),
      };
    }
    return {
      participationStatus: "UNKNOWN",
      isJoined: false,
      evidenceSource: "optimise.status",
      evidenceValue: "paused",
    };
  }

  if (!status) {
    return {
      participationStatus: "UNKNOWN",
      isJoined: false,
      evidenceSource: null,
      evidenceValue: null,
    };
  }

  return {
    participationStatus: "UNKNOWN",
    isJoined: false,
    evidenceSource: "optimise.status",
    evidenceValue: status,
  };
}

/**
 * Campaign lifecycle for Optimise — Master Field Mapping: `status`.
 * Prefer advertiserCampaignStatus when present; `notapplied` is relationship-only.
 */
export function mapOptimiseCampaignLifecycle(raw = {}, fallback = "UNKNOWN") {
  const advertiserStatus = normalizeCampaignStatus(
    raw.advertiserCampaignStatus,
    raw.advertiser_campaign_status,
    raw.advertiserCampaignStatuses,
  );
  if (advertiserStatus !== "UNKNOWN") return advertiserStatus;

  const status = String(raw?.status ?? "")
    .trim()
    .toLowerCase();
  if (status === "notapplied") return "UNKNOWN";
  if (status === "live") return "ACTIVE";
  if (status === "paused") return "PAUSED";
  if (status === "closed" || status === "retired" || status === "ended") return "RETIRED";
  if (status === "waiting" || status === "pending") return "PENDING";

  const fromStatus = normalizeCampaignStatus(raw.status);
  if (fromStatus !== "UNKNOWN") return fromStatus;
  return fallback;
}

export function mapOptimiseCampaign(entity) {
  const base = buildCampaignBaseFromEntity(entity);
  const raw = entity.rawData ?? {};
  const relationship = mapOptimisePublisherRelationship(raw);
  const campaignStatus = mapOptimiseCampaignLifecycle(raw, base.campaignStatus);

  const participationStatus =
    relationship.participationStatus !== "UNKNOWN"
      ? relationship.participationStatus
      : base.participationStatus;
  const isJoined = relationship.isJoined === true || base.isJoined === true;

  // Extract T&C from terms.body / nested terms (GET /campaigns/{productId} detail)
  const termsBody = normalizeTermsText(raw.terms ?? raw.termsAndConditions ?? raw.conditions);

  return {
    ...base,
    campaignName: base.campaignName ?? raw.campaignName ?? raw.name ?? null,
    merchantNameRaw: base.merchantNameRaw ?? raw.advertiserName ?? raw.companyName ?? null,
    campaignDescription:
      base.campaignDescription ??
      (raw.description ? String(raw.description).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null),
    campaignLogoUrl:
      base.campaignLogoUrl ??
      (raw.campaignLogo || raw.advertiserLogoLocation
        ? String(raw.campaignLogo || raw.advertiserLogoLocation).trim() || null
        : null),
    trackingUrl: base.trackingUrl ?? raw.trackingURL ?? raw.deepLinkTrackingURL ?? raw.baseTrackingUrl ?? null,
    destinationUrl:
      base.destinationUrl ??
      raw.deepLinkURL ??
      raw.destinationUrl ??
      raw.landingPage?.websiteUrl ??
      raw.website ??
      null,
    categoryName:
      base.categoryName ??
      (raw.vertical?.primary ? String(raw.vertical.primary) : null) ??
      (raw.vertical?.name ? String(raw.vertical.name) : null) ??
      (typeof raw.vertical === "string" ? raw.vertical : null) ??
      null,
    secondaryCategory:
      base.secondaryCategory ??
      extractSecondaryCategoryFromRaw(raw, raw.vertical?.primary ?? raw.vertical?.name ?? base.categoryName),
    countryCodes:
      base.countryCodes?.length ? base.countryCodes : extractCountryCodesFromRaw(raw),
    deepLinkingEnabled:
      base.deepLinkingEnabled ??
      Boolean(raw.deepLinkEnabled || raw.deeplinkEnabled || raw.deepLinkURL || raw.deepLinkTrackingURL),
    pricingModel:
      base.pricingModel !== "UNKNOWN"
        ? base.pricingModel
        : inferOptimisePricing(raw) !== "UNKNOWN"
          ? inferOptimisePricing(raw)
          : String(raw.payout?.type || "").toLowerCase().includes("sale")
            ? "CPS"
            : "UNKNOWN",
    defaultCommissionValue: base.defaultCommissionValue ?? extractOptimiseCommissionValue(raw),
    commissionUnit: base.commissionUnit !== "UNKNOWN" ? base.commissionUnit : extractOptimiseCommissionUnit(raw),
    commissionCurrency:
      base.commissionCurrency ??
      (raw.payout?.currency ? String(raw.payout.currency).slice(0, 3) : null),
    currencyCode:
      base.currencyCode ??
      (raw.currencyCode ? String(raw.currencyCode).slice(0, 3) : null) ??
      (raw.payout?.currency ? String(raw.payout.currency).slice(0, 3) : null),
    commissionGroups:
      base.commissionGroups ??
      raw.commissionGroups ??
      raw.commission_groups ??
      raw.commissionGroup ??
      null,
    campaignStatus,
    participationStatus,
    isJoined,
    campaignStartDate: base.campaignStartDate ?? extractCampaignStartDateFromRaw(raw, entity),
    campaignEndDate: base.campaignEndDate ?? extractCampaignEndDateFromRaw(raw),
    normalizedPayload: {
      ...(base.normalizedPayload && typeof base.normalizedPayload === "object" ? base.normalizedPayload : {}),
      optimisePublisherRelationship: {
        sourceField: relationship.evidenceSource,
        sourceValue: relationship.evidenceValue,
        participationStatus,
        isJoined,
      },
      // Lineage-only: preserve Optimise commission metrics when present (never invent).
      optimiseCommissionMetrics: {
        commissionCost: raw.commissionCost ?? null,
        pendingCommission: raw.pendingCommission ?? null,
        validatedCommission: raw.validatedCommission ?? null,
        rejectedCommission: raw.rejectedCommission ?? null,
        totalCommission: raw.totalCommission ?? null,
        averageCommission: raw.averageCommission ?? null,
        clickCommission: raw.clickCommission ?? null,
        validatedConversionCommission: raw.validatedConversionCommission ?? null,
        estimatedValidatedCommission: raw.estimatedValidatedCommission ?? null,
        validatedItemCommission: raw.validatedItemCommission ?? null,
        pendingItemCommission: raw.pendingItemCommission ?? null,
        rejectedItemCommission: raw.rejectedItemCommission ?? null,
        commissionGroupBandType: raw.commissionGroupBandType ?? null,
        commissionGroupName: raw.commissionGroupName ?? null,
      },
      supplier_tracking_url:
        base.trackingUrl ?? raw.trackingURL ?? raw.deepLinkTrackingURL ?? raw.baseTrackingUrl ?? null,
      termsAndConditions: termsBody,
    },
  };
}

function extractOptimiseCommissionValue(raw) {
  // Prefer explicit commissionCost when present (TSV Required → commission_value).
  if (raw.commissionCost != null && raw.commissionCost !== "") {
    const match = String(raw.commissionCost).match(/-?\d+(\.\d+)?/);
    if (match) return match[0];
  }
  const group = Array.isArray(raw.commissionGroup)
    ? raw.commissionGroup[0]
    : Array.isArray(raw.commissionGroups)
      ? raw.commissionGroups[0]
      : null;
  if (group?.commission != null && group.commission !== "") {
    const match = String(group.commission).match(/-?\d+(\.\d+)?/);
    if (match) return match[0];
  }
  const commission = raw.commission;
  if (commission == null) return null;
  if (typeof commission === "number") return String(commission);
  if (typeof commission === "string") {
    const match = commission.match(/-?\d+(\.\d+)?/);
    return match ? match[0] : null;
  }
  if (typeof commission === "object") {
    const rawValue = commission.value ?? commission.amount ?? commission.rate;
    if (rawValue == null) return null;
    const match = String(rawValue).match(/-?\d+(\.\d+)?/);
    return match ? match[0] : null;
  }
  return null;
}

function extractOptimiseCommissionUnit(raw) {
  const commission = raw.commission;
  if (commission == null) return "UNKNOWN";
  if (typeof commission === "string") {
    return commission.includes("%") || /percent/i.test(commission) ? "PERCENT" : "UNKNOWN";
  }
  if (typeof commission === "object") {
    const type = String(commission.type ?? "");
    const value = String(commission.value ?? "");
    if (type.toLowerCase().includes("percent") || value.includes("%")) return "PERCENT";
    if (type.toLowerCase().includes("flat") || type.toLowerCase().includes("fixed")) return "FLAT";
  }
  return "UNKNOWN";
}

export function mapOptimiseCoupon(entity) {
  const base = buildCouponBaseFromEntity(entity);
  const raw = entity.rawData ?? {};
  const code = base.couponCode;
  const link =
    base.couponLink ??
    firstPresent(raw.deepLinkURL, raw.deepLinkTrackingURL) ??
    null;

  return {
    ...base,
    parentSupplierCampaignId:
      base.parentSupplierCampaignId ??
      (raw.productId != null ? String(raw.productId) : null) ??
      (raw.campaignId != null ? String(raw.campaignId) : null),
    couponCode: code,
    couponLink: link,
    couponType: code ? "CODE" : link ? "LINK" : base.couponType,
  };
}

function inferOptimisePricing(raw) {
  const typeName = String(raw.productTypeName ?? raw.campaignTypeName ?? raw.payout?.type ?? "").toUpperCase();
  if (typeName.includes("CPA")) return "CPA";
  if (typeName.includes("CPC")) return "CPC";
  if (typeName.includes("CPS")) return "CPS";
  if (typeName.includes("CPL")) return "CPL";
  return "UNKNOWN";
}

function resolveOptimiseCouponType(base, raw) {
  if (base.couponCode) return "CODE";
  if (base.couponLink || raw.deepLinkURL) return "LINK";
  return base.couponType;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function moneyAmount(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object" && value.amount != null) return moneyAmount(value.amount);
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Optimise GET /conversions field projection (lineage + finance inputs).
 * Does NOT invent attribution or campaign-headline commission.
 * See network-mappings/optimise/conversions.mapping.json.
 */
export function extractOptimiseConversionFields(raw = {}) {
  const row = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const conversionValue = row.conversionValue && typeof row.conversionValue === "object" ? row.conversionValue : {};
  const cost = row.cost && typeof row.cost === "object" ? row.cost : {};

  const supplierCommission = moneyAmount(
    firstPresent(
      row.validatedCommission,
      row.pendingCommission,
      row.commissionValue,
      cost.amount,
      row.commission,
    ),
  );
  const approvedCommission = moneyAmount(firstPresent(row.validatedCommission, row.approvedCommission));

  return {
    supplierConversionId:
      firstPresent(row.conversionId, row.conversion_id, row.id) != null
        ? String(firstPresent(row.conversionId, row.conversion_id, row.id))
        : null,
    supplierOrderId:
      firstPresent(row.orderId, row.order_id, row.originalOrderId, row.merchantOrderId) != null
        ? String(firstPresent(row.orderId, row.order_id, row.originalOrderId, row.merchantOrderId))
        : null,
    supplierCampaignId:
      firstPresent(row.campaignId, row.campaign_id, row.productId) != null
        ? String(firstPresent(row.campaignId, row.campaign_id, row.productId))
        : null,
    /** Publisher-facing campaign id — often matches SupplierCampaign.supplierCampaignId when PID differs. */
    publisherCampaignId:
      firstPresent(row.publisherCampaignId, row.publisher_campaign_id) != null
        ? String(firstPresent(row.publisherCampaignId, row.publisher_campaign_id))
        : null,
    campaignName: firstPresent(row.campaignName, row.campaign_name, row.campaignTypeName) ?? null,
    advertiserName: firstPresent(row.advertiserName, row.advertiser_name, row.companyName) ?? null,
    supplierCommission,
    approvedCommission,
    orderValue: moneyAmount(
      firstPresent(
        row.originalOrderValue,
        conversionValue.amount,
        row.validatedItemValue,
        row.conversionValue,
      ),
    ),
    currency:
      firstPresent(
        row.currency,
        cost.currency,
        conversionValue.currency,
        row.currencyCode,
        row.publisherCurrencyCode,
      ) ?? null,
    conversionDate: firstPresent(row.conversionDate, row.conversion_date, row.date) ?? null,
    status: firstPresent(row.status, row.paymentStatus) ?? null,
    assignmentIdHint: firstPresent(row.UID2, row.uid2) ?? null,
    clientIdHint: firstPresent(row.UID, row.uid) ?? null,
    couponCode: firstPresent(row.voucher, row.coupon, row.couponCode, row.coupon_code) ?? null,
    /** Never use these for Conversion.supplierCommission */
    forbiddenCommissionSources: ["defaultCommissionValue", "campaign.headline", "Product.price"],
  };
}
