/**
 * v15 workbook field helpers (03A/03G, 04C, 06C).
 * Never invent discount %, customer type, or campaign start from createdAt.
 */

export function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isoDate(v) {
  const full = iso(v);
  return full ? full.slice(0, 10) : null;
}

export function money(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(4)) : null;
}

/**
 * Exact numeric percent only — never invent from fixed amount or free text.
 * Accepts: 10, "10", "10%", "10% off" / "10% OFF".
 * Rejects: "₹50 off", "$20 off", "up to 10%", "approx 10%", embedded marketing copy.
 */
export function parseExactDiscountPercent(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 0 && value <= 100 ? Number(value) : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  // Hedge / range language is not an exact percent (06E / 06A).
  if (/\b(up\s*to|upto|from|approx|approximately|about|~|max|maximum|starting)\b/i.test(text)) {
    return null;
  }
  // Pure number or number+%
  let m = text.match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (!m) {
    // Explicit "N% off" offer text (authoritative 06A example).
    m = text.match(/^(\d+(?:\.\d+)?)\s*%\s*off\.?$/i);
  }
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * Intersect assignment window with supplier/coupon window (06E Validity MUST).
 * start = MAX(available starts); end = MIN(available ends).
 */
export function intersectCampaignValidity({
  assignmentStart = null,
  assignmentEnd = null,
  supplierStart = null,
  supplierEnd = null,
} = {}) {
  const toDate = (v) => {
    if (v == null || v === "") return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const starts = [assignmentStart, supplierStart].map(toDate).filter(Boolean);
  const ends = [assignmentEnd, supplierEnd].map(toDate).filter(Boolean);
  const startDate = starts.length ? new Date(Math.max(...starts.map((d) => d.getTime()))) : null;
  const endDate = ends.length ? new Date(Math.min(...ends.map((d) => d.getTime()))) : null;
  if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
    return { startDate: null, endDate: null, invalid: true };
  }
  return { startDate, endDate, invalid: false };
}

/** Values that must never appear as client primary/secondary category (06E Category MUST). */
const NON_CATEGORY_TOKENS = new Set([
  "CPS",
  "CPA",
  "CPL",
  "CPI",
  "CPC",
  "HYBRID",
  "TIERED",
  "COUPON",
  "LINK",
  "DEEPLINK",
  "DEALS",
  "DEAL",
  "OFFER",
  "CAMPAIGN",
  "CAMPAIGN NAME",
  "UNKNOWN",
  "N/A",
  "NA",
  "NULL",
]);

/**
 * Normalize MBO category for client API — null out supplier junk (vertical codes, geos, channel words).
 */
export function normalizeMboClientCategory(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (NON_CATEGORY_TOKENS.has(upper)) return null;
  // ISO2 country alone is not a category
  if (/^[A-Z]{2}$/.test(upper)) return null;
  // Supplier vertical blobs like "Link Tracking - KSA"
  if (/link\s*tracking/i.test(text)) return null;
  if (/\b(KSA|UAE|GCC)\b/i.test(text) && /tracking|affiliate|network/i.test(text)) return null;
  return text;
}

/**
 * Resolve client-facing campaignType from assignment channel first, then assigned assets.
 * Never use supplier capability alone when the assignment exposes only one channel (06A/06E).
 */
export function resolveAssignedCampaignType({
  assignmentChannel = null,
  hasLink = false,
  hasCoupon = false,
  hasDeeplink = false,
} = {}) {
  const raw = String(assignmentChannel || "").toUpperCase().trim();
  if (raw === "LINK_AND_COUPON" || raw === "COUPON_AND_LINK") return "COUPON_LINK";
  if (raw === "COUPON" || raw === "LINK" || raw === "COUPON_LINK" || raw === "DEEPLINK") {
    return raw;
  }
  if (hasCoupon && hasLink) return "COUPON_LINK";
  if (hasCoupon) return "COUPON";
  if (hasDeeplink && !hasLink) return "DEEPLINK";
  if (hasLink || hasDeeplink) return "LINK";
  return "LINK";
}

/**
 * Workbook relationshipStatus vocabulary.
 * DB enum: JOINED | NOT_JOINED | PENDING | UNKNOWN
 * Workbook API: JOINED | APPROVED | NOT_JOINED | PENDING | REJECTED | SUSPENDED | UNKNOWN
 * Absent input → null (do not invent UNKNOWN).
 */
export function mapRelationshipStatus(raw) {
  if (raw == null || raw === "") return null;
  const v = String(raw).toUpperCase().trim();
  if (v === "JOINED" || v === "APPROVED") return v === "APPROVED" ? "APPROVED" : "JOINED";
  if (v === "NOT_JOINED" || v === "NOT_APPLIED") return "NOT_JOINED";
  if (v === "PENDING" || v === "REQUIRES_APPROVAL") return v === "REQUIRES_APPROVAL" ? "REQUIRES_APPROVAL" : "PENDING";
  if (v === "REJECTED" || v === "SUSPENDED") return v;
  if (v === "UNKNOWN") return "UNKNOWN";
  return "UNKNOWN";
}

/**
 * Prefer CampaignSource.relationshipStatus; when UNKNOWN/absent, derive from SupplierCampaign facts.
 * Does not invent JOINED without evidence.
 */
export function resolveRelationshipStatus(campaignSource, supplierCampaign = null) {
  const sc = supplierCampaign || campaignSource?.supplierCampaign || null;
  const fromSource = campaignSource?.relationshipStatus;
  if (fromSource && String(fromSource).toUpperCase() !== "UNKNOWN") {
    return mapRelationshipStatus(fromSource);
  }
  if (sc?.isJoined === true) return "JOINED";
  const participation = String(sc?.participationStatus || "").toUpperCase();
  if (participation === "JOINED") return "JOINED";
  if (participation === "PENDING") return "PENDING";
  if (participation === "NOT_JOINED" || participation === "NOT_APPLIED") return "NOT_JOINED";
  if (fromSource) return mapRelationshipStatus(fromSource);
  if (!campaignSource && !sc) return null;
  return "UNKNOWN";
}

/**
 * Workbook campaignStatus: ACTIVE / PAUSED / EXPIRED / INACTIVE / UNKNOWN
 * DB CampaignStatus: ACTIVE | PAUSED | PENDING | RETIRED | UNKNOWN
 * Absent input → null (do not invent UNKNOWN).
 */
export function mapCampaignStatus(raw) {
  if (raw == null || raw === "") return null;
  const v = String(raw).toUpperCase().trim();
  if (v === "ACTIVE" || v === "PAUSED" || v === "UNKNOWN") return v;
  if (v === "RETIRED" || v === "EXPIRED") return "EXPIRED";
  if (v === "INACTIVE" || v === "DISABLED") return "INACTIVE";
  if (v === "PENDING") return "PENDING";
  return "UNKNOWN";
}

/** Channel / offer labels must never become campaignType. */
const CHANNEL_TYPE_WORDS = new Set([
  "COUPON",
  "LINK",
  "DEALS",
  "DEAL",
  "OFFER",
  "COUPON_LINK",
  "DEEPLINK",
  "LINK_COUPON",
]);

/**
 * Workbook campaignType commercial model: CPS/CPA/CPL/CPI/CPC/HYBRID/TIERED/UNKNOWN
 * Absent input → null. Unmappable present value → UNKNOWN.
 */
export function mapCampaignType(campaignType, pricingModel) {
  const candidates = [campaignType, pricingModel]
    .map((x) => String(x || "").toUpperCase().trim())
    .filter(Boolean);
  if (!candidates.length) return null;

  const allowed = new Set(["CPS", "CPA", "CPL", "CPI", "CPC", "HYBRID", "TIERED", "UNKNOWN"]);
  for (const c of candidates) {
    if (CHANNEL_TYPE_WORDS.has(c)) continue;
    if (allowed.has(c)) return c === "UNKNOWN" ? "UNKNOWN" : c;
    if (c.includes("TIER")) return "TIERED";
    if (c.includes("CPS") || c.includes("SALE")) return "CPS";
    if (c.includes("CPA") || c.includes("ACTION")) return "CPA";
    if (c.includes("CPL") || c.includes("LEAD")) return "CPL";
    if (c.includes("CPI") || c.includes("INSTALL")) return "CPI";
    if (c.includes("CPC") || c.includes("CLICK")) return "CPC";
    if (c.includes("HYBRID")) return "HYBRID";
  }
  return "UNKNOWN";
}

function trimNum(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(4))).replace(/\.?0+$/, "");
}

/**
 * Client 06C campaignType: COUPON | LINK | COUPON_LINK | DEEPLINK.
 * Prefer an assigned coupon code over bare supportsCoupon so unassigned coupon
 * inventory does not force COUPON on link-only client exposures.
 */
export function mapClientChannelType({ supportsLink, supportsCoupon, supportsDeeplink, couponCode }) {
  const hasCode = Boolean(couponCode && String(couponCode).trim());
  if (supportsDeeplink && !hasCode && !supportsCoupon && !supportsLink) return "DEEPLINK";
  if (hasCode && (supportsLink || supportsDeeplink)) return "COUPON_LINK";
  if (hasCode) return "COUPON";
  // Allocation preview only: capability without assigned code.
  if (supportsCoupon && !supportsLink && !supportsDeeplink) return "COUPON";
  if (supportsLink || supportsDeeplink) return "LINK";
  if (supportsCoupon) return "COUPON";
  return "LINK";
}

/** Performance / payment channel grain: Link | Coupon | Link + Coupon | Unknown */
export function mapPerformanceChannelType({ couponCode, hasLink } = {}) {
  const hasCode = Boolean(couponCode && String(couponCode).trim());
  if (hasCode && hasLink) return "Link + Coupon";
  if (hasCode) return "Coupon";
  if (hasLink) return "Link";
  return "Unknown";
}

/**
 * Admin list assignability — CSV Is Assignable (is_assignable):
 * Requires CampaignSource (network supplier source) plus:
 * ACTIVE + JOINED/APPROVED + (link|coupon|deeplink) + commission exists.
 * Same derivation for every network once CampaignSource is linked.
 *
 * NOTE: This is NOT HTML "MBO Ready". Use deriveMboReady for catalog/certification readiness.
 */
export function deriveIsAssignable({
  campaignStatus,
  relationshipStatus,
  supportsLink,
  supportsCoupon,
  supportsDeeplink,
  commissionAvailable,
  hasCampaignSource = true,
  mappingStatus = null,
} = {}) {
  if (!hasCampaignSource) return false;
  if (mappingStatus === "ERROR") return false;
  const statusOk = mapCampaignStatus(campaignStatus) === "ACTIVE";
  const rel = mapRelationshipStatus(relationshipStatus);
  const relOk = rel === "JOINED" || rel === "APPROVED";
  const channelOk = Boolean(supportsLink || supportsCoupon || supportsDeeplink);
  const commissionOk = Boolean(commissionAvailable);
  return statusOk && relOk && channelOk && commissionOk;
}

/**
 * HTML Network Campaigns "MBO Ready" — stricter than isAssignable.
 * Requires mapping_status=MAPPED and brand mapping complete and source not hidden.
 */
export function deriveMboReady({
  campaignStatus,
  relationshipStatus,
  brandMappingComplete = false,
  mappingStatus = null,
  commissionAvailable = false,
  hasUsableAsset = false,
  sourceHidden = false,
  hasCampaignSource = true,
} = {}) {
  if (!hasCampaignSource) return false;
  if (sourceHidden) return false;
  if (mapCampaignStatus(campaignStatus) !== "ACTIVE") return false;
  const rel = mapRelationshipStatus(relationshipStatus);
  if (rel !== "JOINED" && rel !== "APPROVED") return false;
  if (mappingStatus !== "MAPPED") return false;
  if (!brandMappingComplete) return false;
  if (!commissionAvailable) return false;
  if (!hasUsableAsset) return false;
  return true;
}

/**
 * Derive campaign channel type (HTML assets semantics) — distinct from CPS/CPA commercial model.
 */
export function deriveCampaignChannelType({
  supportsLink,
  supportsCoupon,
  supportsDeeplink,
  trackingUrl,
} = {}) {
  const link = Boolean(supportsLink) || Boolean(trackingUrl && String(trackingUrl).trim());
  const coupon = Boolean(supportsCoupon);
  const deeplink = Boolean(supportsDeeplink);
  if (coupon && link) return "COUPON_AND_LINK";
  if (coupon && !link) return "COUPON_CODE_ONLY";
  if (deeplink && !coupon && !link) return "DEEPLINK";
  if (link && !coupon) return "AFFILIATE_LINK_ONLY";
  return "UNKNOWN";
}

/**
 * Evidence-based mapping status.
 * MAPPED only when MappingCertification is CERTIFIED and checklist gates pass.
 * Never invent MAPPED from merchant/raw presence alone.
 */
export function deriveMappingStatus({
  syncConflict,
  merchantId,
  rawPayloadId,
  certificationStatus = null,
  checklistValid = false,
} = {}) {
  if (syncConflict) return "ERROR";
  if (certificationStatus === "CERTIFIED" && checklistValid) return "MAPPED";
  if (certificationStatus === "REVOKED") return "NEEDS_REVIEW";
  if (!merchantId || !rawPayloadId) return "NEEDS_REVIEW";
  return "NEEDS_REVIEW";
}

/**
 * Build / validate certification checklist for a supplier campaign.
 * Returns { valid, checklist }.
 */
export function buildMappingCertificationChecklist({
  supplierCampaign,
  hasCampaignSource = false,
  commissionAvailable = false,
  mapperVersion = null,
} = {}) {
  const sc = supplierCampaign || {};
  const checklist = {
    hasSupplierCampaignId: Boolean(sc.supplierCampaignId),
    hasCampaignName: Boolean(sc.campaignName && String(sc.campaignName).trim()),
    hasMerchantId: Boolean(sc.merchantId),
    hasRawPayloadId: Boolean(sc.rawPayloadId),
    hasCampaignSource,
    hasCommission: Boolean(commissionAvailable),
    campaignStatusKnown: Boolean(sc.campaignStatus && sc.campaignStatus !== "UNKNOWN"),
    mapperVersion: mapperVersion || sc.mapperVersion || null,
  };
  const valid =
    checklist.hasSupplierCampaignId &&
    checklist.hasCampaignName &&
    checklist.hasMerchantId &&
    checklist.hasRawPayloadId &&
    checklist.hasCampaignSource &&
    checklist.hasCommission &&
    checklist.campaignStatusKnown;
  return { valid, checklist };
}

/**
 * remaining_quantity = total - assigned when total known; never negative; null when total unknown.
 * assigned_quantity is MBO allocation usage — not network redemptions.
 */
export function deriveCouponRemainingQuantity(totalQuantity, assignedQuantity) {
  if (totalQuantity == null || totalQuantity === "") return null;
  const total = Number(totalQuantity);
  const assigned = Number(assignedQuantity ?? 0);
  if (!Number.isFinite(total)) return null;
  const a = Number.isFinite(assigned) ? assigned : 0;
  return Math.max(0, total - a);
}

/**
 * Human-readable supplier commission DISPLAY summary (not payout truth).
 * Examples: "5%", "Up to 16% · 5 rules", "Multiple rules", null when unavailable.
 */
export function formatCommissionSummary({
  grossCommission,
  rules = [],
  commissionUnit = null,
  ratePercents = [],
} = {}) {
  const count = Array.isArray(rules) ? rules.length : Number(rules) || 0;
  const rates = (Array.isArray(ratePercents) ? ratePercents : [])
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  const estimate = money(grossCommission);
  const unit = String(commissionUnit || "").toUpperCase();
  const asPercent = unit === "PERCENT" || unit === "" || unit === "UNKNOWN";

  let primary = null;
  if (rates.length > 1) {
    primary = `Up to ${trimNum(Math.max(...rates))}%`;
  } else if (rates.length === 1) {
    primary = `${trimNum(rates[0])}%`;
  } else if (estimate != null && asPercent) {
    primary = count > 1 ? `Up to ${trimNum(estimate)}%` : `${trimNum(estimate)}%`;
  } else if (estimate != null) {
    primary = String(estimate);
  }

  if (primary && count > 0) {
    return `${primary} · ${count} rule${count === 1 ? "" : "s"}`;
  }
  if (primary) return primary;
  if (count > 1) return "Multiple rules";
  if (count === 1) return "1 rule";
  return null;
}

export function monthYearFromDate(dateValue) {
  const d = dateValue instanceof Date ? dateValue : dateValue ? new Date(dateValue) : null;
  if (!d || Number.isNaN(d.getTime())) return { month: null, year: null };
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
}

/**
 * Workbook 05 payment statuses from proven Order/FT state machines.
 */
export function mapCanonicalPaymentStatus({
  supplierPaymentStatus,
  clientPaymentStatus,
  validationStatus,
} = {}) {
  const validation = String(validationStatus || "").toUpperCase();
  if (validation === "VALIDATION_REJECTED") return "REJECTED";

  const supplier = String(supplierPaymentStatus || "").toUpperCase();
  if (supplier === "PAYMENT_RECEIVED") return "PAID";
  if (supplier === "PAYMENT_PAYABLE") return "PAYABLE";
  if (supplier === "PAYMENT_INVOICED") return "ADVERTISER_INVOICED";
  if (supplier === "PAYMENT_AWAITING_INVOICE") return "APPROVED";
  if (supplier === "PAYMENT_PENDING") return "PENDING";
  if (supplier === "PAYMENT_ON_HOLD") return "NOT_PAYABLE";

  const client = String(clientPaymentStatus || "").toUpperCase();
  if (client === "CLIENT_PAYMENT_PAID") return "PAID";
  if (client === "CLIENT_PAYMENT_PAYABLE" || client === "CLIENT_PAYMENT_PROCESSING") return "PAYABLE";
  if (client === "CLIENT_PAYMENT_INVOICED") return "ADVERTISER_INVOICED";
  if (client === "CLIENT_PAYMENT_ON_HOLD" || client === "CLIENT_PAYMENT_NOT_READY") return "NOT_PAYABLE";

  return "UNKNOWN";
}
