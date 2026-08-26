/**
 * Campaign assignment eligibility — aligned with admin deriveIsAssignable + Wave A gates.
 * Unlinked catalogs (no CampaignSource) are not assignable.
 */

import { ClientVisibilityService } from "./visibility.service.js";
import {
  deriveIsAssignable,
  mapCampaignStatus,
  resolveRelationshipStatus,
} from "../../ops/v15FieldContract.js";

function hasHttpUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const ELIGIBILITY_REASON_LABELS = {
  catalog_archived: "Campaign archived",
  catalog_hidden: "Campaign hidden",
  catalog_not_assignable: "Campaign not assignable",
  catalog_not_publishable: "Campaign not publishable",
  client_not_active: "Client is not active",
  client_offboarded: "Client is offboarded",
  country_mismatch: "Country mismatch",
  currency_mismatch: "Currency mismatch",
  no_campaign_source_linked: "Source not linked",
  missing_merchant: "Needs merchant mapping",
  no_eligible_campaign_source: "No eligible campaign source",
  missing_source: "Source not linked",
  source_inactive: "Source inactive",
  source_deprecated: "Source deprecated",
  relationship_not_joined: "Publisher not joined",
  relationship_unknown: "Publisher relationship not confirmed",
  relationship_pending: "Relationship pending",
  missing_tracking_or_coupon_capability: "No supported distribution channel",
  missing_commission: "No commission information",
  campaign_inactive: "Campaign inactive",
  supplier_campaign_archived: "Supplier campaign archived",
  supplier_campaign_retired: "Campaign retired",
  missing_effective_commission_rule: "Missing client commission rule",
  mapping_error: "Mapping error",
};

export function labelEligibilityReason(code) {
  return ELIGIBILITY_REASON_LABELS[code] || String(code || "Not eligible").replaceAll("_", " ");
}

export function deriveSourceCapabilities(source) {
  const supplierCampaign = source?.supplierCampaign || null;
  const trackingUrl = supplierCampaign?.trackingUrl || supplierCampaign?.destinationUrl || null;
  const supportsLink = source?.supportsLink === true || hasHttpUrl(trackingUrl);
  const supportsCoupon =
    source?.supportsCoupon === true ||
    Boolean(supplierCampaign?.coupons?.some?.((c) => c.couponCode || c.couponLink));
  const supportsDeeplink =
    source?.channelSupport?.includes?.("DEEPLINK") ||
    supplierCampaign?.deepLinkingEnabled === true;
  return { supportsLink, supportsCoupon, supportsDeeplink, trackingUrl };
}

export function isSourceEligible(source, { requireJoined = true } = {}) {
  if (!source) return { ok: false, reasons: ["missing_source"] };
  const reasons = [];

  if (source.isActive === false) reasons.push("source_inactive");
  if (source.status === "DEPRECATED") reasons.push("source_deprecated");

  const supplierCampaign = source.supplierCampaign || null;
  const relationship = resolveRelationshipStatus(source, supplierCampaign);
  if (requireJoined) {
    if (relationship === "JOINED" || relationship === "APPROVED") {
      // ok
    } else if (relationship === "PENDING" || relationship === "REQUIRES_APPROVAL") {
      reasons.push("relationship_pending");
    } else if (relationship === "NOT_APPLIED" || relationship === "NOT_JOINED") {
      reasons.push("relationship_not_joined");
    } else if (relationship === "UNKNOWN" || relationship == null) {
      reasons.push("relationship_unknown");
    } else {
      reasons.push("relationship_not_joined");
    }
  }

  if (!supplierCampaign?.merchantId) {
    reasons.push("missing_merchant");
  }

  const campaignStatus = mapCampaignStatus(supplierCampaign?.campaignStatus);
  if (campaignStatus && campaignStatus !== "ACTIVE") {
    reasons.push("campaign_inactive");
  }

  const caps = deriveSourceCapabilities(source);
  if (!caps.supportsLink && !caps.supportsCoupon && !caps.supportsDeeplink) {
    reasons.push("missing_tracking_or_coupon_capability");
  }

  const gross =
    source.grossCommission ?? supplierCampaign?.defaultCommissionValue ?? null;
  const commissionAvailable =
    (gross != null && Number(gross) !== 0) ||
    (Array.isArray(supplierCampaign?.commissionRules) &&
      supplierCampaign.commissionRules.length > 0);
  if (!commissionAvailable) {
    reasons.push("missing_commission");
  }

  if (supplierCampaign?.archivedAt) reasons.push("supplier_campaign_archived");
  if (supplierCampaign?.campaignStatus === "RETIRED") reasons.push("supplier_campaign_retired");
  if (supplierCampaign?.syncConflict) reasons.push("mapping_error");

  return {
    ok: reasons.length === 0,
    reasons,
    capabilities: caps,
    relationshipStatus: relationship,
    commissionAvailable,
  };
}

export class CampaignEligibilityService {
  constructor(deps = {}) {
    this.visibility = deps.visibility ?? new ClientVisibilityService();
  }

  /**
   * @param {object} input
   * @param {'assign'|'publish'} input.mode
   */
  evaluate(input = {}) {
    const mode = input.mode === "publish" ? "publish" : "assign";
    const catalog = input.catalogCampaign;
    const client = input.client ?? null;
    const sources = Array.isArray(input.sources) ? input.sources : [];
    const remainingGaps = [];
    const reasons = [];

    if (!this.visibility.isCatalogAssignable(catalog)) {
      if (catalog?.status === "ARCHIVED" || catalog?.deletedAt) reasons.push("catalog_archived");
      else if (catalog?.visibility === "HIDDEN") reasons.push("catalog_hidden");
      else reasons.push("catalog_not_assignable");
    }

    if (mode === "publish") {
      if (!this.visibility.isCatalogPublishable(catalog)) {
        reasons.push("catalog_not_publishable");
      }
      const clientStatus = String(client?.status || "").toUpperCase();
      if (clientStatus === "OFFBOARDED" || clientStatus === "SUSPENDED") {
        reasons.push("client_not_active");
      } else if (!this.visibility.isClientEligible(client)) {
        // PROSPECT / onboarding clients can receive ops-published allotments;
        // partner portal visibility still requires ACTIVE.
        remainingGaps.push("client_not_active");
      }
      if (!input.hasEffectiveCommissionRule) {
        reasons.push("missing_effective_commission_rule");
      }
    } else if (client?.status === "OFFBOARDED") {
      reasons.push("client_offboarded");
    }

    const clientCountry = client?.country ? String(client.country).toUpperCase() : null;
    const catalogCountries = Array.isArray(catalog?.countries)
      ? catalog.countries.map((c) => String(c).toUpperCase()).filter(Boolean)
      : [];
    if (clientCountry && catalogCountries.length > 0 && !catalogCountries.includes(clientCountry)) {
      // Multi-geo allotments are reviewed in Assignment Review (deferred regional gate).
      remainingGaps.push("country_mismatch");
    }
    if (!clientCountry || catalogCountries.length === 0) {
      remainingGaps.push("country_incomplete_data");
    }

    const clientCurrency = client?.currency ? String(client.currency).toUpperCase() : null;
    const catalogCurrency = catalog?.defaultCurrency
      ? String(catalog.defaultCurrency).toUpperCase()
      : null;
    if (clientCurrency && catalogCurrency && clientCurrency !== catalogCurrency) {
      remainingGaps.push("currency_mismatch");
    }
    if (!clientCurrency || !catalogCurrency) {
      remainingGaps.push("currency_incomplete_data");
    }
    remainingGaps.push("regional_inr_usd_rule_deferred_wave_d");

    let eligibleSource = null;
    let sourceEvaluation = null;

    const HARD_SOURCE_REASONS = new Set([
      "missing_source",
      "source_inactive",
      "source_deprecated",
      "supplier_campaign_archived",
      "supplier_campaign_retired",
    ]);

    if (sources.length === 0) {
      // Normalized assignment requires CampaignSource.
      // Legacy Coupon CMS bridge may allot/publish without a source when coupon/tracking exists.
      if (
        (mode === "assign" && input.hasCouponAssignment === true) ||
        (mode === "publish" &&
          (input.hasCouponAssignment === true || input.hasResolvableTrackingDestination === true))
      ) {
        remainingGaps.push("no_campaign_source_linked");
      } else {
        reasons.push("no_campaign_source_linked");
      }
      if (mode === "publish") {
        const couponOk = input.hasCouponAssignment === true;
        const trackingOk = input.hasResolvableTrackingDestination === true;
        if (!couponOk && !trackingOk) {
          reasons.push("missing_tracking_or_coupon_capability");
        }
      }
    } else {
      const preferred = input.preferredSource || null;
      if (preferred) {
        const evaluation = isSourceEligible(preferred);
        const hard = (evaluation.reasons || []).filter((code) => HARD_SOURCE_REASONS.has(code));
        // Operator-selected source: accept for draft/publish unless catastrophically unusable.
        // Soft issues (relationship, merchant, commission) go to Assignment Review gaps.
        if (hard.length === 0 && preferred.id) {
          eligibleSource = preferred;
          sourceEvaluation = evaluation;
          for (const code of evaluation.reasons || []) {
            remainingGaps.push(code);
          }
        } else {
          sourceEvaluation = evaluation;
          for (const code of hard.length ? hard : evaluation.reasons || ["no_eligible_campaign_source"]) {
            reasons.push(code);
          }
        }
      } else {
        for (const source of sources) {
          const evaluation = isSourceEligible(source);
          if (evaluation.ok) {
            eligibleSource = source;
            sourceEvaluation = evaluation;
            break;
          }
          sourceEvaluation = sourceEvaluation || evaluation;
        }
      }
      if (!eligibleSource) {
        reasons.push("no_eligible_campaign_source");
        if (sourceEvaluation?.reasons?.length) {
          for (const code of sourceEvaluation.reasons) {
            if (!reasons.includes(code)) reasons.push(code);
          }
        }
      }
    }

    if (mode === "publish" && eligibleSource) {
      const caps = isSourceEligible(eligibleSource).capabilities || {};
      const trackingOk =
        caps.supportsLink ||
        caps.supportsDeeplink ||
        input.hasResolvableTrackingDestination === true;
      const couponOk = caps.supportsCoupon || input.hasCouponAssignment === true;
      if (!trackingOk && !couponOk) {
        reasons.push("missing_tracking_or_coupon_capability");
      }
    }

    remainingGaps.push("mapping_approval_state_not_modeled");

    const uniqueReasons = [...new Set(reasons)];
    const ok = uniqueReasons.length === 0;

    // Cross-check admin matrix when we have a preferred/eligible source (diagnostics only).
    let adminAssignable = null;
    if (eligibleSource || sources[0]) {
      const src = eligibleSource || sources[0];
      const caps = deriveSourceCapabilities(src);
      const sc = src.supplierCampaign || null;
      const gross = src.grossCommission ?? sc?.defaultCommissionValue ?? null;
      adminAssignable = deriveIsAssignable({
        campaignStatus: sc?.campaignStatus,
        relationshipStatus: resolveRelationshipStatus(src, sc),
        supportsLink: caps.supportsLink,
        supportsCoupon: caps.supportsCoupon,
        supportsDeeplink: caps.supportsDeeplink,
        commissionAvailable: gross != null && Number(gross) !== 0,
        hasCampaignSource: true,
        mappingStatus: sc?.syncConflict ? "ERROR" : null,
      });
    }

    return {
      ok,
      mode,
      reasons: uniqueReasons,
      reasonLabels: uniqueReasons.map(labelEligibilityReason),
      remainingGaps: [...new Set(remainingGaps)],
      eligibleSourceId: eligibleSource?.id ?? null,
      adminAssignable,
      eligibilityStatus: ok
        ? "ELIGIBLE"
        : uniqueReasons.some((r) =>
              ["relationship_unknown", "missing_merchant", "relationship_pending"].includes(r),
            )
          ? "NEEDS_REVIEW"
          : uniqueReasons.includes("no_campaign_source_linked")
            ? "UNAVAILABLE"
            : "NOT_ELIGIBLE",
    };
  }

  assertAssignable(input) {
    const result = this.evaluate({ ...input, mode: "assign" });
    if (!result.ok) {
      const err = new Error(
        `Cannot assign campaign. Reason: ${result.reasonLabels.join("; ") || result.reasons.join(", ")}`,
      );
      err.statusCode = 409;
      err.eligibility = result;
      throw err;
    }
    return result;
  }

  assertPublishable(input) {
    const result = this.evaluate({ ...input, mode: "publish" });
    if (!result.ok) {
      const err = new Error(
        `Campaign assignment is not publishable: ${result.reasonLabels.join("; ") || result.reasons.join(", ")}`,
      );
      err.statusCode = 409;
      err.eligibility = result;
      throw err;
    }
    return result;
  }
}
