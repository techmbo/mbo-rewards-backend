import { buildCampaignBaseFromEntity, buildCouponBaseFromEntity, extractCountryCodesFromRaw } from "./shared.js";
import { mapPayload } from "../../mapping/engine.js";
import { normalizeCampaignStatus, normalizeParticipationStatus } from "./status.js";

/**
 * Impact relationship (Master / Partner API):
 * ContractStatus Active|Expired → JOINED|NOT_JOINED.
 * List Campaigns returns joined programs; ContractStatus is the join/contract signal.
 */
export function mapImpactRelationship(raw = {}) {
  const contract =
    raw.ContractStatus ??
    raw.contractStatus ??
    raw.InsertionOrderStatus ??
    raw.participationStatusRaw ??
    null;

  if (contract != null && String(contract).trim() !== "") {
    const v = String(contract).trim().toLowerCase();
    if (v === "active" || v === "joined" || v === "approved") {
      return {
        participationStatus: "JOINED",
        isJoined: true,
        evidenceSource: "impact.ContractStatus",
        evidenceValue: String(contract),
      };
    }
    if (["expired", "terminated", "inactive", "pending"].includes(v)) {
      return {
        participationStatus: v === "pending" ? "PENDING" : "NOT_JOINED",
        isJoined: false,
        evidenceSource: "impact.ContractStatus",
        evidenceValue: String(contract),
      };
    }
    const mapped = normalizeParticipationStatus(contract);
    if (mapped !== "UNKNOWN") {
      return {
        participationStatus: mapped,
        isJoined: mapped === "JOINED",
        evidenceSource: "impact.ContractStatus",
        evidenceValue: String(contract),
      };
    }
  }

  // Presence on Mediapartners Campaigns list implies a joined program when contract absent.
  if (raw.CampaignId != null || raw.Id != null || raw.campaign_id != null) {
    return {
      participationStatus: "JOINED",
      isJoined: true,
      evidenceSource: "impact.CampaignsList",
      evidenceValue: String(raw.CampaignId ?? raw.Id ?? raw.campaign_id),
    };
  }

  return {
    participationStatus: "UNKNOWN",
    isJoined: false,
    evidenceSource: null,
    evidenceValue: null,
  };
}

/**
 * Impact campaign lifecycle — prefer CampaignStatus; avoid using ContractStatus as lifecycle.
 */
export function mapImpactCampaignLifecycle(raw = {}, fallback = "UNKNOWN") {
  const mapped = normalizeCampaignStatus(
    raw.CampaignStatus,
    raw.campaignStatus,
    raw.State,
    raw.DealState,
    // Only use Status when ContractStatus is separately present (Status may be contract-ish)
    raw.ContractStatus != null ? null : raw.Status,
  );
  return mapped !== "UNKNOWN" ? mapped : fallback;
}

/**
 * Impact mapper — Wave E: config-driven mapping into SupplierCampaign shape.
 * Does not create finance or assignments.
 */
export function mapImpactCampaign(entity) {
  const base = buildCampaignBaseFromEntity(entity);
  const raw = entity.rawData ?? {};
  const mapped = mapPayload({
    supplier: "IMPACT",
    resourceKey: "campaigns",
    payload: raw,
  });
  const n = mapped.normalizedData || {};
  const relationship = mapImpactRelationship({ ...raw, ...n });

  const campaignStatus = n.campaignStatus
    ? normalizeCampaignStatus(n.campaignStatus)
    : mapImpactCampaignLifecycle(raw, base.campaignStatus);

  const participationStatus =
    relationship.participationStatus !== "UNKNOWN"
      ? relationship.participationStatus
      : n.participationStatus
        ? normalizeParticipationStatus(n.participationStatus)
        : base.participationStatus;

  return {
    ...base,
    supplierCampaignId: n.supplierCampaignId ?? base.supplierCampaignId,
    campaignName: n.campaignName ?? base.campaignName,
    merchantNameRaw: n.merchantNameRaw ?? base.merchantNameRaw ?? raw.AdvertiserName ?? raw.advertiserName ?? null,
    trackingUrl: n.trackingUrl ?? base.trackingUrl ?? raw.CampaignUrl ?? raw.TrackingLink ?? null,
    destinationUrl: n.destinationUrl ?? base.destinationUrl ?? raw.WebsiteUrl ?? raw.CampaignUrl ?? null,
    categoryName: base.categoryName ?? n.categoryName ?? raw.Category ?? raw.Vertical ?? null,
    countryCodes: base.countryCodes?.length ? base.countryCodes : extractCountryCodesFromRaw(raw),
    campaignStatus,
    participationStatus,
    isJoined: relationship.isJoined === true || base.isJoined === true || participationStatus === "JOINED",
    currencyCode: base.currencyCode ?? raw.Currency ?? raw.currency ?? null,
    normalizedPayload: {
      ...(base.normalizedPayload || {}),
      _mappingEngine: {
        version: mapped.mappingVersion,
        success: mapped.success,
        unmappedFields: mapped.unmappedFields,
        errors: mapped.errors,
      },
      supplierAdvertiserId: n.supplierAdvertiserId ?? null,
      impactRelationship: {
        sourceField: relationship.evidenceSource,
        sourceValue: relationship.evidenceValue,
        participationStatus,
        isJoined: relationship.isJoined,
      },
    },
  };
}

export function mapImpactCoupon(entity) {
  // Impact Promotions are deal/promo content (v15 13I), not voucher codes.
  // CouponCodeMaster path is NOT_APPLICABLE — do not invent codes from deal text.
  return buildCouponBaseFromEntity(entity);
}
