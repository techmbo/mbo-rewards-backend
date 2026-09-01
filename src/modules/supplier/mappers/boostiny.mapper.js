import {
  buildCampaignBaseFromEntity,
  buildCouponBaseFromEntity,
  extractCountryCodesFromRaw,
  extractCampaignStartDateFromRaw,
  extractCampaignEndDateFromRaw,
  toDecimalString,
} from "./shared.js";
import {
  normalizePricingModel,
  normalizeCommissionUnit,
  normalizeCampaignStatus,
  normalizeParticipationStatus,
} from "./status.js";

/**
 * Boostiny payouts[] — TSV Required: payouts[].model/value/currency.
 * Live API nests rate under payouts[].groups[].value (not top-level value).
 */
export function pickBoostinyPayoutGroupValue(payoutOrRules) {
  const payouts = Array.isArray(payoutOrRules)
    ? payoutOrRules
    : payoutOrRules
      ? [payoutOrRules]
      : [];
  for (const payout of payouts) {
    if (payout?.value != null && String(payout.value).trim() !== "") {
      return payout.value;
    }
    const groups = Array.isArray(payout?.groups) ? payout.groups : [];
    if (!groups.length) continue;
    const sorted = [...groups].sort(
      (a, b) => (Number(a?.priority) || 999) - (Number(b?.priority) || 999),
    );
    const best = sorted.find((g) => g?.value != null && String(g.value).trim() !== "") || sorted[0];
    if (best?.value != null) return best.value;
  }
  return null;
}

export function resolveBoostinyDefaultCommission({ defaultCommissionValue, commissionGroups } = {}) {
  if (defaultCommissionValue != null && String(defaultCommissionValue).trim() !== "") {
    return toDecimalString(defaultCommissionValue);
  }
  return toDecimalString(pickBoostinyPayoutGroupValue(commissionGroups)) ?? null;
}

export function extractBoostinyPayout(raw = {}) {
  const payouts = Array.isArray(raw.payouts) ? raw.payouts : [];
  const first =
    payouts.find(
      (p) => p && (p.value != null || p.model || p.currency || (p.groups && p.groups.length)),
    ) || payouts[0] || null;
  if (!first) {
    return { model: null, value: null, currency: null, rules: payouts.length ? payouts : null };
  }
  const resolvedValue = first.value ?? pickBoostinyPayoutGroupValue(first);
  return {
    model: first.model ?? null,
    value: resolvedValue ?? null,
    currency: first.currency ?? null,
    isGlobal: first.is_global ?? null,
    country: first.country ?? null,
    goal: first.goal ?? null,
    rules: payouts,
  };
}

/**
 * Boostiny campaign_description is an object with nested fields:
 * { description, promotion, dos_and_donts, website_url, creatives }
 * Extract human-readable text for description and offer/promotion fields.
 */
function extractBoostinyDescription(raw = {}) {
  const cd = raw.campaign_description;
  if (!cd) return { description: null, promotion: null };
  if (typeof cd === "string") return { description: cd, promotion: null };
  if (typeof cd === "object") {
    return {
      description: cd.description ?? null,
      promotion: cd.promotion ?? null,
    };
  }
  return { description: null, promotion: null };
}

/**
 * Master Field Mapping:
 * - campaignStatus ← status
 * - networkRelationshipStatus ← allocated / status / application_status
 */
export function mapBoostinyRelationship(raw = {}) {
  const allocated = raw.allocated ?? raw.is_allocated ?? raw.allocated_status;
  const application = raw.application_status ?? raw.applicationStatus;
  const status = raw.status ?? raw.campaign_status;

  const fromDedicated = normalizeParticipationStatus(allocated, application);
  if (fromDedicated !== "UNKNOWN") {
    return {
      participationStatus: fromDedicated,
      isJoined: fromDedicated === "JOINED",
      evidenceSource: allocated != null ? "boostiny.allocated" : "boostiny.application_status",
      evidenceValue: String(allocated ?? application),
    };
  }

  const fromStatus = normalizeParticipationStatus(status);
  if (fromStatus !== "UNKNOWN") {
    return {
      participationStatus: fromStatus,
      isJoined: fromStatus === "JOINED",
      evidenceSource: "boostiny.status",
      evidenceValue: String(status),
    };
  }

  return {
    participationStatus: "UNKNOWN",
    isJoined: false,
    evidenceSource: null,
    evidenceValue: null,
  };
}

export function mapBoostinyCampaign(entity) {
  const base = buildCampaignBaseFromEntity(entity);
  const raw = entity.rawData ?? {};
  const payout = extractBoostinyPayout(raw);
  const { description: boostinyDesc, promotion: boostinyPromotion } = extractBoostinyDescription(raw);
  const relationship = mapBoostinyRelationship(raw);

  const pricingModel =
    base.pricingModel !== "UNKNOWN" ? base.pricingModel : normalizePricingModel(payout.model);

  const commissionUnit =
    base.commissionUnit !== "UNKNOWN"
      ? base.commissionUnit
      : normalizeCommissionUnit(payout.model, payout.value);

  const boostinyCouponCountries = Array.isArray(raw.coupons)
    ? raw.coupons.flatMap((c) => (Array.isArray(c?.countries) ? c.countries : []))
    : [];

  const campaignStatus = normalizeCampaignStatus(
    raw.status,
    raw.campaign_status,
    raw.campaignStatus,
    entity.entityStatus,
    base.campaignStatus,
  );

  const participationStatus =
    relationship.participationStatus !== "UNKNOWN"
      ? relationship.participationStatus
      : base.participationStatus;

  return {
    ...base,
    trackingUrl: base.trackingUrl ?? raw.tracking_link ?? raw.click_url ?? null,
    destinationUrl:
      base.destinationUrl ??
      raw.campaign_description?.website_url ??
      raw.landing_page ??
      raw.website ??
      null,
    campaignLogoUrl: base.campaignLogoUrl ?? raw.logo_url ?? raw.image_url ?? raw.icon ?? raw.logo ?? null,
    merchantNameRaw:
      base.merchantNameRaw ?? raw.advertiser_name ?? raw.brand_name ?? raw.merchant_name ?? null,
    campaignDescription:
      base.campaignDescription ??
      (boostinyDesc ? String(boostinyDesc).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null),
    categoryName:
      base.categoryName ??
      raw.category?.name ??
      (typeof raw.category === "string" ? raw.category : null) ??
      null,
    countryCodes: base.countryCodes?.length
      ? base.countryCodes
      : extractCountryCodesFromRaw(raw).length
        ? extractCountryCodesFromRaw(raw)
        : payout.country
          ? [String(payout.country).toUpperCase()]
          : extractCountryCodesFromRaw({ countries: boostinyCouponCountries }),
    pricingModel: pricingModel !== "UNKNOWN" ? pricingModel : base.pricingModel,
    defaultCommissionValue:
      base.defaultCommissionValue ??
      toDecimalString(payout.value) ??
      resolveBoostinyDefaultCommission({ commissionGroups: payout.rules }) ??
      null,
    commissionUnit: commissionUnit !== "UNKNOWN" ? commissionUnit : base.commissionUnit,
    commissionCurrency:
      base.commissionCurrency ?? (payout.currency ? String(payout.currency).slice(0, 3) : null),
    currencyCode: base.currencyCode ?? (payout.currency ? String(payout.currency).slice(0, 3) : null),
    commissionGroups: base.commissionGroups ?? (payout.rules?.length ? payout.rules : null),
    campaignStatus,
    participationStatus,
    isJoined: relationship.isJoined === true || base.isJoined === true,
    campaignStartDate: base.campaignStartDate ?? extractCampaignStartDateFromRaw(raw, entity),
    campaignEndDate: base.campaignEndDate ?? extractCampaignEndDateFromRaw(raw),
    normalizedPayload: {
      ...(base.normalizedPayload || {}),
      boostinyPayout: {
        model: payout.model,
        value: payout.value,
        currency: payout.currency,
        is_global: payout.isGlobal,
        country: payout.country,
        goal: payout.goal,
      },
      boostinyPromotion: boostinyPromotion
        ? String(boostinyPromotion).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
        : null,
      boostinyRelationship: {
        sourceField: relationship.evidenceSource,
        sourceValue: relationship.evidenceValue,
        participationStatus,
        isJoined: relationship.isJoined,
      },
    },
  };
}

export function mapBoostinyCoupon(entity) {
  const base = buildCouponBaseFromEntity(entity);
  const raw = entity.rawData ?? {};

  // Boostiny /publisher/coupons rows usually omit status — listed codes are live inventory.
  let couponStatus = base.couponStatus;
  if (!couponStatus || couponStatus === "UNKNOWN") {
    const start = base.couponStartDate;
    if (start instanceof Date && !Number.isNaN(start.getTime()) && start.getTime() > Date.now()) {
      couponStatus = "SCHEDULED";
    } else {
      couponStatus = "ACTIVE";
    }
  }

  return {
    ...base,
    couponCode: base.couponCode ?? raw.coupon ?? raw.code ?? null,
    couponLink: base.couponLink ?? raw.deeplink ?? raw.link ?? null,
    couponType: base.couponCode ? "CODE" : base.couponLink ? "LINK" : base.couponType,
    couponStatus,
  };
}
