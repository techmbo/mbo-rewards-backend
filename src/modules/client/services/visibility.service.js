/**
 * Visibility rules for client-facing catalog access.
 * Clients only see allotted canonical campaigns (never supplier internals).
 */
import {
  projectBrandIdentity,
  brandIdentityToClientLinks,
} from "../../merchant/brandIdentity.js";
import {
  intersectCampaignValidity,
  normalizeMboClientCategory,
  mapCampaignStatus,
} from "../../ops/v15FieldContract.js";

export class ClientVisibilityService {
  isClientEligible(client) {
    return Boolean(client && client.deletedAt == null && client.status === "ACTIVE");
  }

  isCatalogAssignable(catalogCampaign) {
    if (!catalogCampaign || catalogCampaign.deletedAt != null) return false;
    if (catalogCampaign.status === "ARCHIVED") return false;
    if (catalogCampaign.visibility === "HIDDEN") return false;
    return true;
  }

  isCatalogPublishable(catalogCampaign) {
    return (
      this.isCatalogAssignable(catalogCampaign) &&
      catalogCampaign.status === "PUBLISHED" &&
      catalogCampaign.visibility !== "HIDDEN"
    );
  }

  /** Strict portal visibility — published grants only. */
  isAssignmentVisibleToClient(assignment, { client, catalogCampaign } = {}) {
    if (!assignment) return false;
    if (!this.isClientEligible(client)) return false;
    if (!this.isCatalogPublishable(catalogCampaign ?? assignment.canonicalCampaign)) return false;

    return assignment.published === true && assignment.status === "ACTIVE";
  }

  /**
   * Partner/portal allotment visibility — any non-revoked assignment with a usable catalog offer.
   * Clients should see everything allotted to them, not only fully published grants.
   */
  isAssignmentAllottedToClient(assignment, { client, catalogCampaign } = {}) {
    if (!assignment) return false;
    if (!this.isClientEligible(client)) return false;
    if (assignment.status === "REVOKED") return false;

    const campaign = catalogCampaign ?? assignment.canonicalCampaign;
    return this.isCatalogAssignable(campaign);
  }

  filterVisibleAssignments(assignments = [], client) {
    return assignments.filter((assignment) =>
      this.isAssignmentVisibleToClient(assignment, {
        client,
        catalogCampaign: assignment.canonicalCampaign,
      }),
    );
  }

  filterAllottedAssignments(assignments = [], client) {
    return assignments.filter((assignment) =>
      this.isAssignmentAllottedToClient(assignment, {
        client,
        catalogCampaign: assignment.canonicalCampaign,
      }),
    );
  }

  projectVisibleCampaign(assignment) {
    if (!assignment?.canonicalCampaign) return null;

    const facing =
      assignment.clientFacing && typeof assignment.clientFacing === "object"
        ? assignment.clientFacing
        : {};

    const merchant = assignment.canonicalCampaign.merchant;
    const primaryLink =
      (assignment.trackingLinks || []).find(
        (row) =>
          row.isPrimary &&
          row.status !== "REVOKED" &&
          row.mboTrackingUrl,
      ) ||
      (assignment.trackingLinks || []).find(
        (row) => row.status !== "REVOKED" && row.mboTrackingUrl,
      ) ||
      null;
    const couponRow =
      (assignment.couponAssignments || []).find((row) => row.status === "ACTIVE") ||
      (assignment.couponAssignments || []).find((row) => row.status === "ASSIGNED") ||
      null;
    const facingCouponCode =
      facing.couponCode != null && String(facing.couponCode).trim()
        ? String(facing.couponCode).trim()
        : null;
    const coupon = couponRow
      ? couponRow
      : facingCouponCode
        ? {
            couponType: null,
            clientCouponCode: facingCouponCode,
            discountPercentage: facing.customerOffer ?? null,
            validFrom: null,
            validUntil: facing.expiry ? new Date(facing.expiry) : null,
            status: "ASSIGNED",
          }
        : null;
    const rule =
      (assignment.commissionRules || []).find((row) => row.status === "EFFECTIVE") ||
      (assignment.commissionRules || []).find((row) => row.status === "DRAFT") ||
      null;

    const facingShare =
      facing.clientCommissionPercent != null && facing.clientCommissionPercent !== ""
        ? Number(facing.clientCommissionPercent)
        : null;
    const clientShare =
      Number.isFinite(facingShare)
        ? facingShare
        : rule && Number(rule.grossCommission) > 0
          ? Number(((Number(rule.clientCommission) / Number(rule.grossCommission)) * 100).toFixed(2))
          : null;

    const source = assignment.campaignSource || null;
    const supplierCampaign = source?.supplierCampaign || null;
    // Prefer assignment/canonical countries; fall back to supplier countryCodes when catalog empty.
    const countries = (() => {
      if (Array.isArray(facing.countries) && facing.countries.length) {
        return facing.countries.map(String).filter(Boolean);
      }
      const fromCanonical = assignment.canonicalCampaign.countries ?? [];
      if (fromCanonical.length) return fromCanonical;
      const fromSupplier = supplierCampaign?.countryCodes;
      return Array.isArray(fromSupplier) ? fromSupplier : [];
    })();

    const displayName =
      (facing.campaignName != null && String(facing.campaignName).trim()
        ? String(facing.campaignName).trim()
        : null) ||
      assignment.displayName ||
      assignment.canonicalCampaign.displayName ||
      supplierCampaign?.campaignName ||
      null;

    // 06E Validity: assignment window ∩ supplier/coupon window (assignment stricter when present).
    const supplierStart =
      supplierCampaign?.campaignStartDate ?? coupon?.validFrom ?? null;
    const facingExpiry =
      facing.expiry != null && String(facing.expiry).trim()
        ? new Date(String(facing.expiry).trim())
        : null;
    const supplierEnd = coupon?.validUntil ?? (facingExpiry && !Number.isNaN(facingExpiry.getTime()) ? facingExpiry : null);
    const validity = intersectCampaignValidity({
      assignmentStart: assignment.startDate,
      assignmentEnd: assignment.endDate ?? supplierEnd,
      supplierStart,
      supplierEnd,
    });

    const mappedSupplierStatus = mapCampaignStatus(supplierCampaign?.campaignStatus);
    const sourceActive =
      source == null
        ? true
        : source.isActive !== false &&
          (mappedSupplierStatus == null ||
            mappedSupplierStatus === "ACTIVE" ||
            mappedSupplierStatus === "UNKNOWN");

    return {
      assignmentId: assignment.id,
      channel: assignment.channel,
      startDate: assignment.startDate,
      endDate: assignment.endDate,
      createdAt: assignment.createdAt ?? null,
      published: assignment.published === true,
      assignmentStatus: assignment.status,
      validityInvalid: validity.invalid === true,
      sourceActive,
      campaign: (() => {
        const brand = projectBrandIdentity(merchant, supplierCampaign);
        const brandLinks = brandIdentityToClientLinks(brand);
        return {
        id: assignment.canonicalCampaign.id,
        merchantId: assignment.canonicalCampaign.merchantId,
        brand: brandLinks.brandName,
        brandWebsiteUrl: brandLinks.brandWebsiteUrl,
        brandLogoUrl:
          (facing.brandLogoUrl != null && String(facing.brandLogoUrl).trim()
            ? String(facing.brandLogoUrl).trim()
            : null) || brandLinks.brandLogoUrl,
        displayName,
        // Client-safe copy only — never expose supplier ids / raw payload
        description:
          (facing.offerDescription != null && String(facing.offerDescription).trim()
            ? String(facing.offerDescription).trim()
            : null) ||
          assignment.description ||
          supplierCampaign?.campaignDescription ||
          null,
        category: normalizeMboClientCategory(assignment.canonicalCampaign.category),
        secondaryCategory: normalizeMboClientCategory(
          assignment.canonicalCampaign.secondaryCategory ?? null,
        ),
        countries,
        defaultCurrency: assignment.canonicalCampaign.defaultCurrency,
        status: assignment.canonicalCampaign.status,
        supplierCampaignStatus: supplierCampaign?.campaignStatus ?? null,
        deepLinkingEnabled: supplierCampaign?.deepLinkingEnabled === true,
        campaignTypeRaw: supplierCampaign?.campaignType ?? null,
        pricingModelRaw: supplierCampaign?.pricingModel ?? null,
        termsAndConditions:
          (facing.termsAndConditions != null && String(facing.termsAndConditions).trim()
            ? String(facing.termsAndConditions).trim()
            : null) ||
          (assignment.termsAndConditions ?? null),
        // Offer / discountDisplay source only — never campaign name (P1.7 Wave 1).
        offer: (() => {
          if (facing.customerOffer != null && String(facing.customerOffer).trim()) {
            const text = String(facing.customerOffer).trim();
            if (!displayName || text !== String(displayName).trim()) return text;
          }
          const discount = coupon?.discountPercentage;
          if (discount == null || discount === "") return null;
          const text = String(discount).trim();
          if (!text) return null;
          if (/^\d+(\.\d+)?\s*%?$/i.test(text) || /^\d+(\.\d+)?\s*%\s*off\.?$/i.test(text)) {
            const pct = text.replace(/%/gi, "").replace(/\s*off\.?/i, "").trim();
            return `${pct}% off`;
          }
          return text;
        })(),
        validity: {
          startDate: validity.startDate,
          endDate: validity.endDate,
        },
      };
      })(),
      coupon: coupon
        ? {
            type: coupon.couponType,
            code: coupon.clientCouponCode ?? null,
            discountPercentage: coupon.discountPercentage ?? null,
            validFrom: coupon.validFrom ?? null,
            validUntil: coupon.validUntil ?? null,
            status: coupon.status,
          }
        : null,
      sourceCapabilities: {
        supportsLink: source?.supportsLink === true || Boolean(primaryLink),
        supportsCoupon: source?.supportsCoupon === true || Boolean(coupon?.clientCouponCode),
        supportsDeeplink: supplierCampaign?.deepLinkingEnabled === true,
      },
      tracking: primaryLink
        ? {
            mboTrackingUrl: primaryLink.mboTrackingUrl,
            status: primaryLink.status,
          }
        : null,
      commercial:
        rule || Number.isFinite(clientShare)
          ? {
              status: rule?.status ?? null,
              clientSharePercent: clientShare,
              commissionType: rule?.commissionType ?? null,
              currency: rule?.currency ?? null,
              displayLabel:
                rule?.displayLabel ??
                (Number.isFinite(clientShare) ? `${clientShare}% share (display estimate)` : null),
              displayRangeMin:
                rule?.displayRangeMin != null ? Number(rule.displayRangeMin) : null,
              displayRangeMax:
                rule?.displayRangeMax != null ? Number(rule.displayRangeMax) : null,
              orderValuePercent:
                rule?.orderValuePercent != null ? Number(rule.orderValuePercent) : null,
              fixedAmount: rule?.fixedAmount != null ? Number(rule.fixedAmount) : null,
              manualAmount: rule?.manualAmount != null ? Number(rule.manualAmount) : null,
              manualApproved: rule?.manualApproved === true,
            }
          : null,
    };
  }
}
