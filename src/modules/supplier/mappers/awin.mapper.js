import {
  buildCampaignBaseFromEntity,
  buildCouponBaseFromEntity,
  extractCountryCodesFromRaw,
  toDecimalString,
} from "./shared.js";
import { normalizeCampaignStatus, normalizeParticipationStatus } from "./status.js";

/**
 * Awin → MBO supplier campaign / coupon / conversion mappers.
 * Preserve raw status; never invent fields.
 */

function firstPresent(...values) {
  return values.find((v) => v !== undefined && v !== null && String(v).trim() !== "");
}

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function mapAwinCampaign(entity) {
  const base = buildCampaignBaseFromEntity(entity);
  const raw = entity.rawData ?? {};
  const country =
    raw.primaryRegion?.countryCode ??
    raw.primaryRegion?.country ??
    raw.countryCode ??
    null;

  const relationship = String(raw.relationship ?? raw.linkStatus ?? "")
    .trim()
    .toLowerCase();
  let participationStatus = base.participationStatus;
  if (relationship === "joined") participationStatus = "JOINED";
  else if (relationship === "pending") participationStatus = "PENDING";
  else if (relationship.includes("not") || relationship === "notjoined") {
    participationStatus = "NOT_JOINED";
  } else if (relationship) {
    participationStatus = normalizeParticipationStatus(relationship);
  }

  return {
    ...base,
    campaignStatus: normalizeCampaignStatus(
      raw.status,
      raw.linkStatus,
      entity.entityStatus,
      base.campaignStatus,
    ),
    participationStatus,
    currency: base.currency ?? raw.currencyCode ?? null,
    countryCodes:
      base.countryCodes?.length
        ? base.countryCodes
        : extractCountryCodesFromRaw({ countries: country ? [country] : [] }),
    destinationUrl:
      base.destinationUrl ?? firstPresent(raw.clickThroughUrl, raw.displayUrl, raw.url) ?? null,
    trackingUrl: base.trackingUrl ?? firstPresent(raw.clickThroughUrl, raw.displayUrl) ?? null,
    defaultCommissionValue:
      base.defaultCommissionValue ??
      toDecimalString(firstPresent(raw.commissionRange?.max, raw.commissionMax, raw.commission)),
    metadata: {
      ...(base.metadata && typeof base.metadata === "object" ? base.metadata : {}),
      awin: {
        validDomains: raw.validDomains ?? null,
        linkStatus: raw.linkStatus ?? null,
        primaryRegion: raw.primaryRegion ?? null,
      },
    },
  };
}

export function mapAwinOffer(entity) {
  const base = buildCouponBaseFromEntity(entity);
  const raw = entity.rawData ?? {};
  return {
    ...base,
    couponCode: base.couponCode ?? firstPresent(raw.voucherCode, raw.code, raw.couponCode) ?? null,
    couponType: base.couponType ?? firstPresent(raw.type, raw.promotionType) ?? null,
    couponDescription:
      base.couponDescription ?? firstPresent(raw.description, raw.title, raw.name) ?? null,
    couponStartDate: base.couponStartDate ?? firstPresent(raw.startDate, raw.validFrom) ?? null,
    couponEndDate: base.couponEndDate ?? firstPresent(raw.endDate, raw.validTo) ?? null,
    // An Awin promotion row carries its parent as NESTED advertiser.id. raw.advertiserId is not a
    // field Awin sends on promotions — buildAwinCouponExternalId records that from production
    // FieldRegistry evidence, and the coupon externalId is built from advertiser.id for exactly
    // that reason. Reading only the flat field left every canonically-identified Awin offer with
    // no parent at all. The flat field is kept as a fallback because the voucher rows fanned out
    // of a campaign payload carry it.
    parentSupplierCampaignId:
      base.parentSupplierCampaignId ??
      (raw.advertiser?.id != null ? String(raw.advertiser.id) : null) ??
      (raw.advertiserId != null ? String(raw.advertiserId) : null),
    // The name is the same evidence in the same place, and resolveParentCampaign falls back to it
    // when the id misses. base wins when it found one, so nothing that resolves today changes.
    parentCampaignName:
      base.parentCampaignName ??
      (raw.advertiser?.name != null ? String(raw.advertiser.name) : null) ??
      (raw.advertiserName != null ? String(raw.advertiserName) : null),
  };
}

/** Awin transaction → conversion ingest shape (pre-attribution). */
export function mapAwinTransaction(raw = {}, { sourceAccountLabel = "default" } = {}) {
  const conversionId = firstPresent(raw.id, raw.transactionId, raw.TransactionId);
  if (conversionId == null) return null;

  const status = mapTransactionStatus(raw.commissionStatus ?? raw.status);
  const commission = toNumberOrNull(
    firstPresent(raw.commissionAmount?.amount, raw.commission, raw.commissionAmount),
  );
  if (commission == null) return null;

  return {
    supplier: "AWIN",
    sourceAccountLabel,
    supplierConversionId: String(conversionId),
    supplierCampaignId: raw.advertiserId != null ? String(raw.advertiserId) : null,
    supplierOrderId: raw.orderRef != null ? String(raw.orderRef) : null,
    supplierCommission: commission,
    currency: firstPresent(raw.commissionAmount?.currency, raw.saleAmount?.currency, raw.currency) ?? null,
    orderValue: toNumberOrNull(firstPresent(raw.saleAmount?.amount, raw.saleAmount, raw.orderAmount)),
    status,
    conversionDate: firstPresent(raw.transactionDate, raw.date, raw.eventDate) ?? null,
    approvedDate: firstPresent(raw.validationDate, raw.amendmentDate) ?? null,
    metadata: {
      awinRawStatus: raw.commissionStatus ?? raw.status ?? null,
      clickRefs: {
        clickRef: raw.clickRef ?? raw.clickRef1 ?? null,
        clickRef2: raw.clickRef2 ?? null,
        clickRef3: raw.clickRef3 ?? null,
        clickRef4: raw.clickRef4 ?? null,
        clickRef5: raw.clickRef5 ?? null,
        clickRef6: raw.clickRef6 ?? null,
      },
      basketProducts: Array.isArray(raw.basketProducts) ? raw.basketProducts : null,
      attributionHints: {
        subId: firstPresent(raw.clickRef, raw.clickRef1) ?? null,
        clickId: firstPresent(raw.clickRef, raw.clickRef1) ?? null,
      },
    },
    rawPayload: raw,
  };
}

function mapTransactionStatus(value) {
  const s = String(value || "").toLowerCase();
  if (s === "pending") return "PENDING";
  if (s === "approved") return "APPROVED";
  if (s === "declined") return "REJECTED";
  if (s === "deleted") return "UNKNOWN";
  return "UNKNOWN";
}
