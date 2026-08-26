/**
 * Partner-facing campaign projection (v15 06C / P1.7 Wave 1).
 * Combines ClientCampaignAssignment + CanonicalCampaign + coupon + tracking + commission
 * into a client-safe response. Never expose supplier internals.
 *
 * Field semantics (do not conflate):
 * - campaignType / channelType = distribution channel (LINK | COUPON | COUPON_LINK | DEEPLINK)
 * - commercialModel = commercial model extension (CPS | CPA | CPL | …) — not interchangeable with campaignType
 * - campaignStatus = supplier/campaign lifecycle (ACTIVE | PAUSED | EXPIRED)
 * - assignmentStatus = derived assignment lifecycle (see derivePartnerAssignmentStatus)
 * - status / published = compatibility fields (raw DB assignment.status + published flag)
 */

import {
  parseExactDiscountPercent,
  mapCampaignStatus,
  mapCampaignType,
  resolveAssignedCampaignType,
  normalizeMboClientCategory,
} from "../../ops/v15FieldContract.js";
import { resolveReportingCurrency } from "../../finance/fx.service.js";

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function stripHtml(value) {
  if (value == null) return null;
  const text = String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

const NEW_ASSIGNMENT_MS = 7 * 24 * 60 * 60 * 1000;
const SUPPORTED_CURRENCIES = new Set(["INR", "USD"]);

/**
 * Client-facing short status for portal badges.
 * Prefer derived lifecycle codes (Wave 1 assignmentStatus), not raw DB alone.
 * Never map published===true → Live without CLIENT_VISIBLE facts (derivePartnerAssignmentStatus).
 */
function displayStatus(derivedAssignmentStatus, endDate) {
  if (endDate) {
    const end = new Date(endDate);
    if (!Number.isNaN(end.getTime()) && end.getTime() < Date.now()) return "Expired";
  }
  const status = String(derivedAssignmentStatus || "").toUpperCase();
  if (status === "CLIENT_VISIBLE") return "Live";
  if (status === "PROVISIONED") return "Ready to publish";
  if (status === "TRACKING_READY") return "Tracking ready";
  if (status === "COMMISSION_READY") return "Commission ready";
  if (status === "PAUSED") return "Paused";
  if (status === "REVOKED") return "Revoked";
  if (status === "ASSIGNED" || status === "ACTIVE") return "Assigned";
  return derivedAssignmentStatus || "Unknown";
}

/** Legacy portal offerType from channel capabilities (not commercial campaignType). */
function legacyOfferType(channelType) {
  if (channelType === "COUPON_LINK") return "link_and_coupon";
  if (channelType === "COUPON") return "coupon";
  if (channelType === "DEEPLINK" || channelType === "LINK") return "link";
  return "link";
}

/**
 * discountDisplay / offer — only from real coupon/offer evidence.
 * Never use campaignName as a discount.
 */
export function resolveDiscountDisplay({
  offer = null,
  discountPercent = null,
  campaignName = null,
} = {}) {
  const name = campaignName != null ? String(campaignName).trim() : "";
  const raw = offer != null ? String(offer).trim() : "";
  if (raw && (!name || raw !== name)) {
    return raw;
  }
  if (discountPercent != null && Number.isFinite(Number(discountPercent))) {
    return `${Number(discountPercent)}% off`;
  }
  return null;
}

/**
 * Derive canonical assignment lifecycle for client API from existing facts only.
 * Does not invent DB enums or columns. Aligned with admin assignmentLifecycle projection.
 *
 * Codes: REVOKED | PAUSED | CLIENT_VISIBLE | PROVISIONED | TRACKING_READY |
 *         COMMISSION_READY | ASSIGNED | (raw status fallback)
 *
 * CLIENT_VISIBLE ≡ published + ACTIVE + usable tracking or coupon (client API visibility truth).
 * Compatibility: raw DB status remains on `status`; `published` remains boolean.
 */
export function derivePartnerAssignmentStatus(projected = {}) {
  const dbStatus = String(projected.assignmentStatus || "").toUpperCase();
  const published = projected.published === true;
  const trackingReady = Boolean(projected.tracking?.mboTrackingUrl);
  const couponReady = Boolean(projected.coupon?.code);
  const ruleStatus = String(projected.commercial?.status || "").toUpperCase();
  const commissionEffective = ruleStatus === "EFFECTIVE";

  if (dbStatus === "REVOKED") return "REVOKED";
  if (dbStatus === "PAUSED") return "PAUSED";

  if (published && dbStatus === "ACTIVE" && (trackingReady || couponReady)) {
    return "CLIENT_VISIBLE";
  }
  if (commissionEffective && (trackingReady || couponReady) && !published) {
    return "PROVISIONED";
  }
  if (trackingReady && !commissionEffective) {
    return "TRACKING_READY";
  }
  if (commissionEffective && !trackingReady && !couponReady) {
    return "COMMISSION_READY";
  }
  if (dbStatus === "ASSIGNED" || dbStatus === "ACTIVE") {
    return "ASSIGNED";
  }
  return dbStatus || null;
}

/**
 * v15 discountType: PERCENT | FIXED_AMOUNT | FREE_SHIPPING | OFFER_TEXT | UNKNOWN
 * Never invent percent from fixed/text offers.
 */
export function mapDiscountType({ discountPercent, discountRaw, discountDisplay } = {}) {
  if (discountPercent != null) return "PERCENT";
  const text = String(discountRaw ?? discountDisplay ?? "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (/free\s*ship/.test(lower)) return "FREE_SHIPPING";
  if (
    /(?:₹|rs\.?|inr|usd|\$|€|£)\s*\d|\d+(?:\.\d+)?\s*(?:₹|rs\.?|inr|usd|\$|€|£|off)\b/i.test(text) &&
    !/%/.test(text)
  ) {
    return "FIXED_AMOUNT";
  }
  if (parseExactDiscountPercent(text) == null) return "OFFER_TEXT";
  return "UNKNOWN";
}

function formatShare(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(4))).replace(/\.?0+$/, "");
}

/**
 * Client-safe commission projection — never supplier receivable / MBO margin.
 * @param {object|null} commercial — from ClientVisibilityService
 */
export function buildClientCommission(commercial) {
  if (!commercial) return null;

  const commissionType = commercial.commissionType ?? null;
  const note =
    "Campaign commission is a display estimate. Actual payable is on orders/payment-status reports.";

  let commissionDisplay = null;

  if (commercial.displayLabel && String(commercial.displayLabel).trim()) {
    commissionDisplay = String(commercial.displayLabel).trim();
  } else if (commercial.displayRangeMin != null || commercial.displayRangeMax != null) {
    const min = formatShare(commercial.displayRangeMin);
    const max = formatShare(commercial.displayRangeMax);
    if (min != null && max != null) {
      commissionDisplay = min === max ? `${max}%` : `Up to ${max}%`;
    } else if (max != null) {
      commissionDisplay = `Up to ${max}%`;
    } else if (min != null) {
      commissionDisplay = `From ${min}%`;
    }
  } else if (commercial.orderValuePercent != null) {
    const pct = formatShare(commercial.orderValuePercent);
    if (pct != null) commissionDisplay = `${pct}%`;
  } else if (commercial.fixedAmount != null) {
    const amt = formatShare(commercial.fixedAmount);
    const cur = commercial.currency ? `${commercial.currency} ` : "";
    if (amt != null) commissionDisplay = `${cur}${amt} per confirmed order`.trim();
  } else if (commercial.manualAmount != null && commercial.manualApproved === true) {
    const amt = formatShare(commercial.manualAmount);
    const cur = commercial.currency ? `${commercial.currency} ` : "";
    if (amt != null) commissionDisplay = `${cur}${amt}`.trim();
  } else if (commercial.clientSharePercent != null) {
    const share = formatShare(commercial.clientSharePercent);
    if (share != null) {
      commissionDisplay = `${share}% share (display estimate)`;
    }
  }

  return {
    clientSharePercent: commercial.clientSharePercent ?? null,
    commissionType,
    currency: commercial.currency ?? null,
    commissionDisplay,
    commissionDisplayEstimate: commissionDisplay,
    isDisplayOnly: true,
    note,
    // 06C allows string or object — include top-level string alias for consumers
    value: commissionDisplay,
  };
}

/**
 * Regional currency (v15 09J): India → INR; else USD; contract override; else null.
 * Never invent FX conversions.
 */
export function resolveClientFacingCurrency({
  primaryCountry = null,
  clientCurrency = null,
  contractCurrency = null,
} = {}) {
  const override = contractCurrency || clientCurrency;
  if (override && SUPPORTED_CURRENCIES.has(String(override).toUpperCase())) {
    return String(override).toUpperCase();
  }

  const regional = resolveReportingCurrency({ country: primaryCountry });
  if (regional.ok && regional.currency) return regional.currency;
  return null;
}

/**
 * @param {object|null} projected — output of ClientVisibilityService.projectVisibleCampaign
 * @param {{ client?: object|null }} [opts]
 */
export function toPartnerCampaignDto(projected, opts = {}) {
  if (!projected) return null;

  const client = opts.client ?? null;
  const trackingUrl = projected.tracking?.mboTrackingUrl ?? null;
  const endDate = projected.campaign?.validity?.endDate ?? projected.endDate ?? null;
  const addedAt = projected.createdAt ?? null;
  const isNew =
    Boolean(addedAt) && Date.now() - new Date(addedAt).getTime() <= NEW_ASSIGNMENT_MS;

  const countries = Array.isArray(projected.campaign?.countries) ? projected.campaign.countries : [];
  const primaryCountry = countries[0] ?? null;
  const secondaryCountries = countries.slice(1);

  const couponCode = projected.coupon?.code ?? null;
  const discountPercent = parseExactDiscountPercent(projected.coupon?.discountPercentage);
  const caps = projected.sourceCapabilities || {};
  const campaignName = projected.campaign?.displayName ?? null;
  const hasLink = Boolean(projected.tracking?.mboTrackingUrl);
  const hasCoupon = Boolean(couponCode);
  const hasDeeplink =
    caps.supportsDeeplink === true || projected.campaign?.deepLinkingEnabled === true;

  // campaignType = distribution/channel (06C). Prefer assignment.channel; else assigned assets.
  // commercialModel = CPS/CPA/… (extension). Never collapse commercial model into campaignType.
  const commercialModel = mapCampaignType(
    projected.campaign?.campaignTypeRaw,
    projected.campaign?.pricingModelRaw,
  );
  const channelType = resolveAssignedCampaignType({
    assignmentChannel: projected.channel,
    hasLink,
    hasCoupon,
    hasDeeplink,
  });
  const campaignType = channelType;

  const discountDisplay = resolveDiscountDisplay({
    offer: projected.campaign?.offer,
    discountPercent,
    campaignName,
  });
  const discountType = mapDiscountType({
    discountPercent,
    discountRaw: projected.coupon?.discountPercentage,
    discountDisplay,
  });

  const supplierStatus = mapCampaignStatus(projected.campaign?.supplierCampaignStatus);
  const campaignStatus =
    supplierStatus === "ACTIVE" || supplierStatus === "PAUSED" || supplierStatus === "EXPIRED"
      ? supplierStatus
      : projected.assignmentStatus === "ACTIVE" || projected.assignmentStatus === "ASSIGNED"
        ? "ACTIVE"
        : projected.assignmentStatus === "PAUSED"
          ? "PAUSED"
          : projected.campaign?.status === "PUBLISHED"
            ? "ACTIVE"
            : "ACTIVE";

  const commission = buildClientCommission(projected.commercial);
  const assignmentStatus = derivePartnerAssignmentStatus(projected);

  const channels = {
    link: hasLink || caps.supportsLink === true,
    coupon: hasCoupon,
    deeplink: hasDeeplink,
  };

  const couponAvailability = couponCode
    ? "ASSIGNED"
    : caps.supportsCoupon
      ? "AVAILABLE_NOT_ASSIGNED"
      : "NOT_SUPPORTED";

  const campaignValidity = {
    startDate: toIso(projected.campaign?.validity?.startDate ?? projected.startDate),
    endDate: toIso(endDate),
  };

  const currency = resolveClientFacingCurrency({
    primaryCountry,
    // Approved client commercial override only — never Optimise/campaign defaultCurrency.
    clientCurrency: client?.currency ?? null,
    contractCurrency: null,
  });

  return {
    // ——— 06C exact keys ———
    brandName: projected.campaign?.brand ?? null,
    brandWebsiteUrl: projected.campaign?.brandWebsiteUrl ?? null,
    brandLogoUrl: projected.campaign?.brandLogoUrl ?? null,
    brand: {
      id: projected.campaign?.merchantId ?? null,
      name: projected.campaign?.brand ?? null,
      logoUrl: projected.campaign?.brandLogoUrl ?? null,
      websiteUrl: projected.campaign?.brandWebsiteUrl ?? null,
    },
    primaryCategory: normalizeMboClientCategory(projected.campaign?.category ?? null),
    secondaryCategory: normalizeMboClientCategory(projected.campaign?.secondaryCategory ?? null),
    campaignName,
    campaignDescription: stripHtml(projected.campaign?.description),
    /** Distribution channel (LINK | COUPON | COUPON_LINK | DEEPLINK) — not CPS/CPA. */
    campaignType,
    /** Alias of campaignType (channel). */
    channelType,
    /** Commercial model (CPS | CPA | …) — separate from campaignType. */
    commercialModel: commercialModel ?? null,
    channels,
    termsAndConditions: stripHtml(projected.campaign?.termsAndConditions),
    couponCode,
    couponAvailability,
    link: trackingUrl,
    primaryCountry,
    secondaryCountries,
    discountPercent,
    discountType,
    discountDisplay,
    campaignValidity,
    commission,
    currency,
    campaignStatus,
    /** Derived assignment lifecycle (not campaignStatus; not raw DB alone). */
    assignmentStatus,

    // Compatibility: raw DB assignment.status + published flag (not the lifecycle label).
    assignmentId: projected.assignmentId,
    campaignId: projected.campaign?.id ?? null,
    channel: projected.channel ?? null,
    published: projected.published === true,
    status: projected.assignmentStatus ?? null,
    displayStatus: displayStatus(assignmentStatus, endDate),
    addedAt: toIso(addedAt),
    isNew,
    tracking: projected.tracking
      ? {
          url: projected.tracking.mboTrackingUrl,
          status: projected.tracking.status,
        }
      : null,

    // Deprecated aliases for existing portal UI — prefer 06C keys
    // Note: nested `brand` object is canonical; string `brandName` remains for 06C.
    merchant: projected.campaign?.merchantId
      ? {
          id: projected.campaign.merchantId,
          name: projected.campaign.brand ?? null,
        }
      : null,
    name: campaignName,
    description: stripHtml(projected.campaign?.description),
    category: projected.campaign?.category ?? null,
    countries,
    offer: discountDisplay,
    offerType: legacyOfferType(channelType),
    validity: campaignValidity,
    coupon: projected.coupon
      ? {
          type: projected.coupon.type,
          code: projected.coupon.code,
          discountPercentage: discountPercent,
          validFrom: toIso(projected.coupon.validFrom),
          validUntil: toIso(projected.coupon.validUntil),
          status: projected.coupon.status,
        }
      : null,
    trackingUrl,
  };
}

export function toPartnerClientSummaryDto(client) {
  if (!client) return null;
  const share =
    client.clientSharePercent != null && client.clientSharePercent !== ""
      ? Number(client.clientSharePercent)
      : null;
  return {
    id: client.id,
    name: client.name,
    slug: client.slug,
    status: client.status,
    commercialModel: client.commercialModel ?? null,
    country: client.country ?? null,
    currency: client.currency ?? null,
    industry: client.industry ?? null,
    clientSharePercent: Number.isFinite(share) ? share : null,
    clientCode: client.slug ? `MBO-${String(client.slug).toUpperCase()}` : null,
  };
}
