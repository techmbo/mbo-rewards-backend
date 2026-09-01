import {
  buildCampaignBaseFromEntity,
  buildCouponBaseFromEntity,
  extractCommissionValueFromRaw,
  extractCountryCodesFromRaw,
  asOptionalString,
  parseYnFlag,
  normalizeTermsText,
  extractSecondaryCategoryFromRaw,
  extractTrackingUrlFromRaw,
  extractCampaignStartDateFromRaw,
  extractCampaignEndDateFromRaw,
} from "./shared.js";
import { mapPayload } from "../../mapping/engine.js";
import { brandLabelFromLandingUrl } from "../../merchant/brandIdentity.js";
import {
  normalizeParticipationStatus,
  normalizeCampaignStatus,
  normalizePricingModel,
} from "./status.js";

/**
 * Partnerize relationship (Master Field Mapping): status path param a/p/r.
 * Prefer publisher_status / participation_code over nested campaign lifecycle status.
 */
export function mapPartnerizeRelationship(raw = {}) {
  const status = String(
    raw?.publisher_status ?? raw?.participation_code ?? raw?.status ?? raw?.campaign_status ?? "",
  )
    .trim()
    .toLowerCase();
  if (!status) {
    return { participationStatus: "UNKNOWN", isJoined: false, evidenceSource: null, evidenceValue: null };
  }
  // Publisher list endpoints encode participation as single-letter codes.
  if (status === "a") {
    return {
      participationStatus: "JOINED",
      isJoined: true,
      evidenceSource: "partnerize.status",
      evidenceValue: status,
    };
  }
  if (status === "p") {
    return {
      participationStatus: "PENDING",
      isJoined: false,
      evidenceSource: "partnerize.status",
      evidenceValue: status,
    };
  }
  if (status === "r") {
    return {
      participationStatus: "NOT_JOINED",
      isJoined: false,
      evidenceSource: "partnerize.status",
      evidenceValue: status,
    };
  }
  if (["joined", "approved", "live", "active", "accepted"].includes(status)) {
    return {
      participationStatus: "JOINED",
      isJoined: true,
      evidenceSource: "partnerize.status",
      evidenceValue: status,
    };
  }
  if (["pending", "requested", "invited", "waiting", "apply"].includes(status)) {
    return {
      participationStatus: "PENDING",
      isJoined: false,
      evidenceSource: "partnerize.status",
      evidenceValue: status,
    };
  }
  if (["rejected", "not_joined", "unavailable", "available", "declined", "denied"].includes(status)) {
    return {
      participationStatus: "NOT_JOINED",
      isJoined: false,
      evidenceSource: "partnerize.status",
      evidenceValue: status,
    };
  }
  return {
    participationStatus: normalizeParticipationStatus(status),
    isJoined: false,
    evidenceSource: "partnerize.status",
    evidenceValue: status,
  };
}

/**
 * Partnerize campaign lifecycle (Master: campaign.status / status).
 * Prefer discovery lifecycle fields when present.
 * Publisher-list code `a` means the campaign is active (ops display contract).
 */
export function mapPartnerizeCampaignLifecycle(raw = {}, fallback = "UNKNOWN") {
  const candidates = [
    raw.campaign_lifecycle_status,
    raw.lifecycle_status,
    raw.campaign?.status,
    raw.campaign?.campaign_status,
  ];
  const mapped = normalizeCampaignStatus(...candidates);
  if (mapped !== "UNKNOWN") return mapped;

  // Publisher participation/list codes: a = active campaign (and joined relationship).
  const joinCode = String(
    raw.publisher_status ?? raw.participation_code ?? raw.status ?? "",
  )
    .trim()
    .toLowerCase();
  if (joinCode === "a") return "ACTIVE";

  // Non a/p/r top-level status can still be a lifecycle word (active/paused/…).
  const top = String(raw.status ?? "").trim().toLowerCase();
  if (top && !["a", "p", "r"].includes(top)) {
    const fromTop = normalizeCampaignStatus(raw.status);
    if (fromTop !== "UNKNOWN") return fromTop;
  }
  return fallback;
}

function partnerizeLogoUrl(raw = {}) {
  return asOptionalString(
    raw.campaign_icon ??
      raw.campaign_logo ??
      raw.advertiser?.advertiser_icon ??
      raw.advertiser_icon ??
      null,
  );
}

/**
 * Partnerize mapper — Wave E: config-driven mapping + shared base.
 * CRITICAL: tracking_link ≠ destination_url; status a/p/r → relationship;
 * Partnerize status `a` also means campaign ACTIVE when no discovery lifecycle is present.
 */
export function mapPartnerizeCampaign(entity) {
  const base = buildCampaignBaseFromEntity(entity);
  const raw = entity.rawData ?? {};
  const mapped = mapPayload({
    supplier: "PARTNERIZE",
    resourceKey: "campaigns",
    payload: raw,
  });
  const n = mapped.normalizedData || {};
  const relationship = mapPartnerizeRelationship(raw);

  const destinationUrl =
    n.destinationUrl ??
    base.destinationUrl ??
    raw.destination_url ??
    raw.default_destination ??
    null;

  const advertiserName =
    n.merchantNameRaw ??
    base.merchantNameRaw ??
    raw.advertiser?.name ??
    raw.advertiser?.display_name ??
    raw.advertiser_name ??
    raw.brand_name ??
    brandLabelFromLandingUrl(destinationUrl) ??
    null;

  const trackingUrl =
    n.trackingUrl ??
    base.trackingUrl ??
    extractTrackingUrlFromRaw(raw) ??
    null;

  // Extract T&C from terms object (multilingual: en_us preferred, then any available locale)
  const termsBody = normalizeTermsText(raw.terms ?? raw.termsAndConditions ?? raw.terms_and_conditions);

  // Extract description (multilingual object like {en_us: "...", fr: "..."})
  const descriptionObj = raw.description && typeof raw.description === "object" ? raw.description : null;
  const descriptionText = descriptionObj
    ? (descriptionObj.en_us ?? descriptionObj.en ?? Object.values(descriptionObj)[0] ?? null)
    : (typeof raw.description === "string" ? raw.description : null);

  const conversionType = raw.conversion_type ?? null;
  const pricingModel = normalizePricingModel(
    conversionType === "sale" ? "CPS" : conversionType,
    base.pricingModel,
  );
  const campaignType =
    conversionType === "sale"
      ? "CPS"
      : asOptionalString(conversionType) ?? base.campaignType;

  // Partnerize: status "a" → ACTIVE campaign + JOINED relationship.
  const campaignStatus = mapPartnerizeCampaignLifecycle(raw, base.campaignStatus);

  const deepLinkingEnabled =
    parseYnFlag(raw.allow_deep_linking, raw.allowDeepLinking) ?? base.deepLinkingEnabled;

  // Partnerize default_commission_rate is a percent rate when present.
  const commissionUnit =
    raw.default_commission_rate != null && String(raw.default_commission_rate).trim() !== ""
      ? "PERCENT"
      : base.commissionUnit;

  const participationStatus =
    relationship.participationStatus !== "UNKNOWN"
      ? relationship.participationStatus
      : n.participationStatus
        ? normalizeParticipationStatus(n.participationStatus)
        : base.participationStatus;

  return {
    ...base,
    supplierCampaignId: n.supplierCampaignId ?? base.supplierCampaignId,
    campaignName: n.campaignName ?? base.campaignName ?? raw.title ?? raw.campaign_title ?? null,
    merchantNameRaw: advertiserName,
    trackingUrl,
    destinationUrl,
    campaignLogoUrl: base.campaignLogoUrl ?? partnerizeLogoUrl(raw) ?? null,
    campaignDescription:
      descriptionText
        ? String(descriptionText)
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : base.campaignDescription,
    categoryName:
      base.categoryName ??
      raw.vertical?.name ??
      raw.vertical_name ??
      null,
    secondaryCategory:
      base.secondaryCategory ??
      extractSecondaryCategoryFromRaw(raw, raw.vertical?.name ?? raw.vertical_name ?? base.categoryName),
    campaignType,
    pricingModel: pricingModel !== "UNKNOWN" ? pricingModel : base.pricingModel,
    countryCodes: base.countryCodes?.length ? base.countryCodes : extractCountryCodesFromRaw(raw),
    defaultCommissionValue:
      base.defaultCommissionValue ??
      (raw.default_commission_rate != null ? String(raw.default_commission_rate) : null) ??
      extractCommissionValueFromRaw(raw),
    currencyCode:
      base.currencyCode ??
      raw.currency?.iso ??
      raw.default_currency ??
      (typeof raw.currency === "string" ? raw.currency : null),
    commissionUnit: commissionUnit !== "UNKNOWN" ? commissionUnit : base.commissionUnit,
    commissionGroups:
      base.commissionGroups ??
      raw.commissions ??
      raw.active_commissions ??
      raw.commission_groups ??
      null,
    campaignStatus,
    participationStatus,
    isJoined: relationship.isJoined === true || base.isJoined === true,
    campaignStartDate: base.campaignStartDate ?? extractCampaignStartDateFromRaw(raw, entity),
    campaignEndDate: base.campaignEndDate ?? extractCampaignEndDateFromRaw(raw),
    deepLinkingEnabled,
    normalizedPayload: {
      ...(base.normalizedPayload || {}),
      _mappingEngine: {
        version: mapped.mappingVersion,
        success: mapped.success,
        unmappedFields: mapped.unmappedFields,
        errors: mapped.errors,
      },
      partnerizeRelationship: {
        sourceField: relationship.evidenceSource,
        sourceValue: relationship.evidenceValue,
        participationStatus,
        isJoined: relationship.isJoined,
      },
      partnerizeCommissionBlob: {
        commissions: raw.commissions ?? null,
        active_commissions: raw.active_commissions ?? null,
        tiers: raw.tiers ?? null,
        voucher_commissions: raw.voucher_commissions ?? null,
        last_modified: raw.last_modified ?? null,
        last_modified_by: raw.last_modified_by ?? null,
        publishers: raw.publishers ?? null,
      },
      supplier_tracking_url: trackingUrl,
      landing_page_url: destinationUrl,
      termsAndConditions: termsBody,
    },
  };
}

export function mapPartnerizeCoupon(entity) {
  const base = buildCouponBaseFromEntity(entity);
  const raw = entity.rawData ?? {};
  const nested =
    raw.voucher_code && typeof raw.voucher_code === "object" ? raw.voucher_code : null;
  const code =
    base.couponCode ??
    nested?.voucher_code ??
    raw.voucher_code ??
    raw.code ??
    null;
  const supplierCouponId =
    nested?.voucher_code_id ??
    raw.voucher_code_id ??
    raw.id ??
    null;
  const activeYn = String(raw.active ?? nested?.active ?? "").toLowerCase();
  const statusFromActive =
    activeYn === "y" || raw.active === true
      ? "ACTIVE"
      : activeYn === "n" || raw.active === false
        ? "INACTIVE"
        : null;

  return {
    ...base,
    parentSupplierCampaignId:
      base.parentSupplierCampaignId ??
      (raw.campaign_id != null ? String(raw.campaign_id) : null),
    supplierCouponId: supplierCouponId != null ? String(supplierCouponId) : base.supplierCouponId,
    couponCode: code != null ? String(code) : null,
    couponLink: base.couponLink ?? raw.link ?? null,
    couponType: code ? "CODE" : base.couponLink ? "LINK" : base.couponType,
    couponStartDate:
      base.couponStartDate ??
      (raw.start_date_time || raw.start_date || nested?.start_date
        ? new Date(raw.start_date_time || raw.start_date || nested?.start_date)
        : null),
    couponEndDate:
      base.couponEndDate ??
      (raw.end_date_time || raw.end_date || nested?.end_date
        ? new Date(raw.end_date_time || raw.end_date || nested?.end_date)
        : null),
    couponStatus: statusFromActive ?? base.couponStatus,
    normalizedPayload: {
      ...(base.normalizedPayload && typeof base.normalizedPayload === "object"
        ? base.normalizedPayload
        : {}),
      partnerizeVoucher: {
        voucher_code_id: supplierCouponId != null ? String(supplierCouponId) : null,
        voucher_code: code != null ? String(code) : null,
        on_expiry: nested?.on_expiry ?? raw.on_expiry ?? null,
        on_invalid_user: nested?.on_invalid_user ?? raw.on_invalid_user ?? null,
        active: nested?.active ?? raw.active ?? null,
      },
    },
  };
}
