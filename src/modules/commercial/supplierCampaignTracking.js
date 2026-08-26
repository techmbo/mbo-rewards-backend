import { looksLikeHttpUrl } from "./resolveSupplierDestination.js";
import {
  buildMboTrackingUrl,
  generateTrackingToken,
  slugifyTrackingPart,
} from "./trackingUrl.js";

function extractBrandFromCampaignName(campaignName) {
  if (!campaignName || typeof campaignName !== "string") return null;
  const name = campaignName.trim();
  const pipePart = name.split("|")[0].trim();
  if (pipePart && pipePart !== name) return pipePart;
  const keywordMatch = name.match(/^(.+?)\s+(?:Partners?|Affiliates?|Programme|Program|Network)\b/i);
  if (keywordMatch) return keywordMatch[1].trim();
  return null;
}

export function resolveSupplierCampaignBrandSlug(record = {}) {
  const brand =
    record.merchant?.displayName ||
    record.merchantNameRaw ||
    record.brandName ||
    extractBrandFromCampaignName(record.campaignName) ||
    record.campaignName ||
    "campaign";
  return slugifyTrackingPart(brand) || "campaign";
}

/**
 * Brand-only MBO slug/token at supplier sync time: /r/{brand}/{token}
 */
export function buildSupplierCampaignMboTracking(record = {}, existing = null) {
  const supplierUrl = record.trackingUrl || record.destinationUrl || null;
  if (!looksLikeHttpUrl(supplierUrl)) {
    return {
      mboTrackingSlug: null,
      mboTrackingToken: null,
      mboTrackingUrl: null,
    };
  }

  const brandSlug = resolveSupplierCampaignBrandSlug(record);
  const slug = existing?.mboTrackingSlug || brandSlug;
  const token = existing?.mboTrackingToken || generateTrackingToken();
  const built = buildMboTrackingUrl({ slug, token });

  return {
    mboTrackingSlug: built.slug,
    mboTrackingToken: built.subId,
    mboTrackingUrl: built.mboTrackingUrl,
  };
}

/**
 * Client assignment slug: brand slug + client slug at the end.
 * Example: dazn-thecosmicstack
 */
export function buildAssignedTrackingSlug({ brandSlug, clientSlug } = {}) {
  const brand = slugifyTrackingPart(brandSlug) || "campaign";
  const client = slugifyTrackingPart(clientSlug);
  if (!client) return brand;
  return `${brand}-${client}`;
}

export function buildAssignedMboTrackingUrl({ brandSlug, clientSlug, token } = {}) {
  const slug = buildAssignedTrackingSlug({ brandSlug, clientSlug });
  return buildMboTrackingUrl({ slug, token: token || generateTrackingToken() });
}
