import { fail } from "../../../core/apiResponse.js";
import { logger } from "../../../platform/logging/logger.js";
import { TrackingLinkRepository } from "../../commercial/repositories/commercial.repository.js";
import {
  looksLikeHttpUrl,
  resolveSupplierDestination,
} from "../../commercial/resolveSupplierDestination.js";
import { AttributionService } from "./attribution.service.js";
import {
  buildAttributionQueryParams,
  appendTrackingParams,
  resolveSupplierKey,
} from "../../tracking/index.js";

function resolveSupplierFromLink(link) {
  const fromSource =
    link?.campaignSource?.supplierCampaign?.supplier ||
    link?.assignment?.campaignSource?.supplierCampaign?.supplier ||
    null;
  if (fromSource) return resolveSupplierKey(fromSource);

  const network =
    link?.assignment?.couponAssignments?.[0]?.supplierCoupon?.entity?.networkSource || null;
  if (network) {
    const lower = String(network).toLowerCase();
    if (lower.startsWith("optimise")) return "OPTIMISE";
    if (lower.includes("trackier") || lower.includes("vcommission")) return "TRACKIER";
    if (lower.includes("boostiny")) return "BOOSTINY";
    if (lower.includes("partnerize")) return "PARTNERIZE";
  }
  return "UNKNOWN";
}

function pickActiveCouponCode(link) {
  const rows = link?.assignment?.couponAssignments || [];
  const active =
    rows.find((row) => row.status === "ACTIVE" && row.clientCouponCode) ||
    rows.find((row) => row.status === "ASSIGNED" && row.clientCouponCode) ||
    null;
  return active?.clientCouponCode ?? null;
}

/**
 * CODE-like coupons may redirect to a merchant website (not an affiliate click URL).
 * Injecting network sub-IDs onto a merchant site is incorrect and can break the offer.
 */
function shouldInjectAttributionParams(resolved, link) {
  const source = String(resolved?.source || "");
  if (source === "couponCms.websiteUrl") return false;

  const couponType = (link?.assignment?.couponAssignments || []).find(
    (row) => row.status === "ACTIVE" || row.status === "ASSIGNED",
  )?.couponType;
  if (String(couponType || "").toUpperCase() === "CODE" && source.includes("website")) {
    return false;
  }
  return true;
}

export class TrackingRedirectService {
  constructor(deps = {}) {
    this.trackingRepo = deps.trackingRepo ?? new TrackingLinkRepository();
    this.attribution = deps.attribution ?? new AttributionService();
    this.resolveDestinationFn = deps.resolveDestinationFn ?? resolveSupplierDestination;
    this.appendParamsFn = deps.appendParamsFn ?? appendTrackingParams;
    this.buildParamsFn = deps.buildParamsFn ?? buildAttributionQueryParams;
  }

  async resolveDestination(link) {
    const resolved = await this.resolveDestinationFn({
      link,
      assignmentId: link.assignmentId,
      preferPersisted: true,
    });
    return resolved;
  }

  async loadLink({ slug, token }) {
    const subId = String(token || "").trim();
    if (!subId) throw fail("Tracking token is required.", 400);

    if (slug) {
      const bySlug = await this.trackingRepo.findBySlugAndToken(slug, subId);
      if (bySlug) return bySlug;

      // Wrong slug for a slug-bearing link must not resolve via token alone.
      const byToken = await this.trackingRepo.findBySubId(subId);
      if (byToken?.slug) return null;
      // Legacy links without slug still resolve when accessed via /r/:slug/:token.
      return byToken;
    }

    return this.trackingRepo.findBySubId(subId);
  }

  async redirect(tokenOrOptions, requestMeta = {}) {
    const options =
      typeof tokenOrOptions === "string"
        ? { token: tokenOrOptions }
        : tokenOrOptions || {};

    const link = await this.loadLink({
      slug: options.slug,
      token: options.token,
    });
    if (!link) throw fail("Tracking link not found.", 404);
    if (link.status === "REVOKED" || link.deletedAt) {
      throw fail("Tracking link has been revoked.", 410);
    }
    if (link.status !== "ACTIVE" && link.status !== "GENERATED") {
      throw fail(`Tracking link status is ${link.status}; redirect is not allowed.`, 409);
    }

    const assignment = link.assignment;
    if (!assignment) {
      throw fail("Campaign assignment is missing for this tracking link.", 410);
    }
    if (assignment.status === "REVOKED") {
      throw fail("Campaign assignment has been revoked.", 410);
    }
    if (!assignment.published || assignment.status !== "ACTIVE") {
      throw fail("Campaign assignment is not live (unpublished or inactive).", 409);
    }
    if (assignment.client?.status !== "ACTIVE" || assignment.client?.deletedAt) {
      throw fail("Client account is not active.", 409);
    }

    const catalog = assignment.canonicalCampaign;
    if (!catalog || catalog.deletedAt) {
      throw fail("Campaign is missing.", 410);
    }
    if (catalog.status === "ARCHIVED" || catalog.visibility === "HIDDEN") {
      throw fail("Campaign is inactive or hidden.", 410);
    }

    const resolved = await this.resolveDestination(link);
    if (!resolved.url) {
      logger.warn(
        {
          trackingLinkId: link.id,
          assignmentId: link.assignmentId,
          reason: resolved.reason,
          source: resolved.source,
        },
        "tracking redirect missing supplier destination",
      );
      throw fail(
        resolved.reason ||
          "Supplier tracking URL is missing for this campaign; cannot redirect.",
        409,
      );
    }

    // Persist resolved destination so future redirects are O(1) and resilient.
    if (!looksLikeHttpUrl(link.supplierTrackingUrl) || link.supplierTrackingUrl.trim() !== resolved.url) {
      try {
        await this.trackingRepo.update(link.id, { supplierTrackingUrl: resolved.url });
      } catch (error) {
        logger.warn(
          { trackingLinkId: link.id, err: error.message },
          "failed to backfill supplierTrackingUrl",
        );
      }
    }

    const click = await this.attribution.recordClick({
      trackingLinkId: link.id,
      subId: link.subId,
      ip: requestMeta.ip,
      userAgent: requestMeta.userAgent,
      country: requestMeta.country,
      device: requestMeta.device,
      referrer: requestMeta.referrer,
      metadata: {
        source: "public_redirect",
        slug: link.slug || null,
        destinationSource: resolved.source,
      },
    });

    const supplier = resolveSupplierFromLink(link);
    let destination = resolved.url;
    let attributionInjection = {
      supplier,
      injected: false,
      params: {},
      skippedReason: null,
    };

    if (shouldInjectAttributionParams(resolved, link)) {
      const built = this.buildParamsFn({
        supplier,
        clientId: assignment.clientId ?? assignment.client?.id ?? null,
        assignmentId: link.assignmentId,
        mboClickId: click?.id ?? null,
        trackingLinkSubId: link.subId,
        couponCode: pickActiveCouponCode(link),
      });

      attributionInjection = {
        supplier,
        injected: built.injected,
        params: built.params,
        skippedReason: built.skippedReason,
        confirmation: built.rule?.confirmation ?? null,
      };

      if (built.injected) {
        try {
          const appended = this.appendParamsFn(resolved.url, built.params, {
            overwriteExisting: false,
          });
          destination = appended.url;
          attributionInjection.applied = appended.applied;
          attributionInjection.skippedExisting = appended.skipped;
        } catch (error) {
          logger.warn(
            { trackingLinkId: link.id, supplier, err: error.message },
            "failed to append attribution params; redirecting to base supplier URL",
          );
          attributionInjection.skippedReason = error.message;
          attributionInjection.injected = false;
        }
      } else if (built.skippedReason) {
        logger.info(
          { trackingLinkId: link.id, supplier, reason: built.skippedReason },
          "attribution param injection skipped",
        );
      }
    } else {
      attributionInjection.skippedReason =
        "Destination is a merchant website/coupon landing page — network sub-ID injection skipped.";
    }

    return {
      destination,
      subId: link.subId,
      slug: link.slug || null,
      destinationSource: resolved.source,
      clickId: click?.id ?? null,
      attributionInjection,
    };
  }
}
