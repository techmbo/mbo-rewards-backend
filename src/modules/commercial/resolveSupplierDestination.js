import { prisma } from "../../database/prisma.js";
import { buildAllotmentDisplayFields, extractParentCampaignIds } from "../coupons/allotmentFields.js";
import { resolveCouponCodeType } from "../coupons/codeType.js";

export function looksLikeHttpUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function pickUrl(...candidates) {
  for (const candidate of candidates) {
    if (looksLikeHttpUrl(candidate)) return String(candidate).trim();
  }
  return null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * CODE / Coupon-style offers should wrap the merchant website (preview URL),
 * not the affiliate tracking click URL.
 */
export function isCodeLikeCoupon(entity, couponType = null) {
  if (couponType) {
    const normalized = String(couponType).trim().toUpperCase();
    if (normalized === "CODE") return true;
    if (normalized === "LINK") return false;
  }

  const raw = asObject(entity?.rawData);
  const normalizedData = asObject(entity?.normalizedData);
  const resolved = resolveCouponCodeType(raw, entity?.networkSource);
  const label = String(
    resolved || normalizedData.code_type || raw.code_type || raw.coupon_type || raw.type || "",
  )
    .trim()
    .toLowerCase();

  if (!label) {
    // Trackier deals without an explicit link are treated as code/coupon offers.
    if (raw.record_source === "deal") return true;
    return false;
  }
  if (/\blink\b/.test(label) && !/\bcoupon\b/.test(label) && !/\bcode\b/.test(label)) {
    return false;
  }
  return /\b(coupon|code|deal|voucher)\b/.test(label);
}

function sourceForAllotment(allotment, url) {
  if (!url) return null;
  if (allotment.trackingUrl && looksLikeHttpUrl(allotment.trackingUrl) && allotment.trackingUrl.trim() === url) {
    return "couponCms.trackingUrl";
  }
  if (allotment.offerLink && looksLikeHttpUrl(allotment.offerLink) && allotment.offerLink.trim() === url) {
    return "couponCms.offerLink";
  }
  if (allotment.websiteUrl && looksLikeHttpUrl(allotment.websiteUrl) && allotment.websiteUrl.trim() === url) {
    return "couponCms.websiteUrl";
  }
  return "couponCms";
}

/**
 * Extract the supplier destination from a Coupon CMS Entity.
 * CODE coupons → website / preview URL first.
 * LINK coupons → tracking / offer URL first.
 */
export function destinationFromCouponCmsEntity(entity, related = {}, { couponType = null } = {}) {
  if (!entity) return { url: null, source: null };
  const allotment = buildAllotmentDisplayFields(entity, related);
  const preferWebsite = isCodeLikeCoupon(entity, couponType);
  const url = preferWebsite
    ? pickUrl(allotment.websiteUrl, allotment.offerLink, allotment.trackingUrl)
    : pickUrl(allotment.trackingUrl, allotment.offerLink, allotment.websiteUrl);
  if (!url) return { url: null, source: null };
  return { url, source: sourceForAllotment(allotment, url) };
}

const NETWORK_EXTERNAL_ID_PREFIXES = [
  "trackier",
  "boostiny",
  "optimise",
  "vcommission",
  "partnerize",
];

/**
 * Find parent campaign Entity for a coupon without using endsWith/contains scans
 * (those are very slow on large entity tables and can expire interactive transactions).
 */
async function loadCampaignEntityForCoupon(db, entity) {
  if (!entity) return null;
  const parentIds = extractParentCampaignIds([entity]);
  if (parentIds.length) {
    const network = String(entity.networkSource || "").trim().toLowerCase();
    const externalIds = new Set();
    for (const id of parentIds) {
      const rawId = String(id).trim();
      if (!rawId) continue;
      externalIds.add(rawId);
      if (network) {
        externalIds.add(`${network}:${rawId}`);
      }
      for (const prefix of NETWORK_EXTERNAL_ID_PREFIXES) {
        externalIds.add(`${prefix}:${rawId}`);
      }
    }

    const campaigns = await db.entity.findMany({
      where: {
        entityType: "campaign",
        externalId: { in: [...externalIds] },
      },
      take: 20,
    });
    if (campaigns.length) {
      const byId = new Map();
      for (const campaign of campaigns) {
        const ext = String(campaign.externalId || "");
        byId.set(ext, campaign);
        const tail = ext.includes(":") ? ext.slice(ext.lastIndexOf(":") + 1) : ext;
        if (tail) byId.set(tail, campaign);
        if (campaign.rawData?.id != null) byId.set(String(campaign.rawData.id), campaign);
      }
      for (const id of parentIds) {
        const match = byId.get(String(id));
        if (match) return match;
      }
      return campaigns[0];
    }
  }

  const campaignName = entity.campaignName || asObject(entity.rawData).campaign_name;
  if (!campaignName) return null;
  return db.entity.findFirst({
    where: {
      entityType: "campaign",
      OR: [
        { campaignName: { equals: String(campaignName), mode: "insensitive" } },
        { entityName: { equals: String(campaignName), mode: "insensitive" } },
      ],
    },
    orderBy: [{ updatedAt: "desc" }],
  });
}

async function destinationFromEntityWithParent(db, entity, { couponType = null } = {}) {
  if (!entity) return { url: null, source: null };
  const campaignEntity = await loadCampaignEntityForCoupon(db, entity);
  return destinationFromCouponCmsEntity(entity, { campaignEntity }, { couponType });
}

function destinationFromCampaignEntity(campaignEntity, { preferWebsite = false } = {}) {
  if (!campaignEntity) return { url: null, source: null };
  const raw = asObject(campaignEntity.rawData);
  const website = pickUrl(
    raw.preview_url,
    raw.website,
    raw.website_url,
    raw.landingPage,
    raw.landing_page,
    raw.destination_url,
  );
  const tracking = pickUrl(raw.tracking_link, raw.tracking_url, raw.trackingURL, raw.click_url);
  const url = preferWebsite ? pickUrl(website, tracking) : pickUrl(tracking, website);
  if (!url) return { url: null, source: null };
  return {
    url,
    source:
      website && url === website
        ? "campaign.website"
        : tracking && url === tracking
          ? "campaign.tracking"
          : "campaign",
  };
}

/**
 * Resolve the supplier destination that an MBO tracking link must wrap.
 * Priority: Coupon CMS (website for CODE, tracking for LINK) → coupon link →
 * parent campaign → supplier campaign → merchant.
 *
 * @returns {{ url: string|null, source: string|null, reason: string|null }}
 */
export async function resolveSupplierDestination(
  {
    assignmentId,
    couponEntityId = null,
    link = null,
    preferPersisted = true,
  } = {},
  client = null,
) {
  const db = client ?? prisma;

  if (preferPersisted && looksLikeHttpUrl(link?.supplierTrackingUrl)) {
    return {
      url: link.supplierTrackingUrl.trim(),
      source: "trackingLink.supplierTrackingUrl",
      reason: null,
    };
  }

  if (couponEntityId) {
    const entity = await db.entity.findFirst({
      where: { id: couponEntityId, entityType: "coupon" },
    });
    const fromCms = await destinationFromEntityWithParent(db, entity);
    if (fromCms.url) {
      return { url: fromCms.url, source: fromCms.source, reason: null };
    }
  }

  if (!assignmentId && link?.assignmentId) {
    assignmentId = link.assignmentId;
  }
  if (!assignmentId) {
    return {
      url: null,
      source: null,
      reason: "Assignment is missing; cannot resolve supplier tracking URL.",
    };
  }

  const assignment = await db.clientCampaignAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      canonicalCampaign: { include: { merchant: true } },
      campaignSource: { include: { supplierCampaign: true } },
    },
  });

  if (!assignment) {
    return {
      url: null,
      source: null,
      reason: "Campaign assignment is missing.",
    };
  }

  async function tryCouponRows(coupons) {
    for (const coupon of coupons || []) {
      const entity = coupon.supplierCoupon?.entity;
      if (entity) {
        const fromCms = await destinationFromEntityWithParent(db, entity, {
          couponType: coupon.couponType,
        });
        if (fromCms.url) {
          return { url: fromCms.url, source: fromCms.source, reason: null };
        }
      }

      // CODE coupons: never treat the promo code itself as a URL.
      const fromCouponLink = pickUrl(
        coupon.supplierCoupon?.couponLink,
        coupon.couponType === "LINK" ? coupon.clientCouponCode : null,
        coupon.couponType === "LINK" ? coupon.supplierCouponCode : null,
        looksLikeHttpUrl(coupon.clientCouponCode) ? coupon.clientCouponCode : null,
        looksLikeHttpUrl(coupon.supplierCouponCode) ? coupon.supplierCouponCode : null,
      );
      if (fromCouponLink) {
        return { url: fromCouponLink, source: "clientCouponAssignment.link", reason: null };
      }
    }
    return null;
  }

  const loadedCoupons = link?.assignment?.couponAssignments;
  if (Array.isArray(loadedCoupons) && loadedCoupons.length) {
    const fromLoaded = await tryCouponRows(loadedCoupons);
    if (fromLoaded) return fromLoaded;
  }

  const couponAssignments = await db.clientCouponAssignment.findMany({
    where: { assignmentId, status: { in: ["ACTIVE", "ASSIGNED"] } },
    include: {
      supplierCoupon: {
        include: { entity: true },
      },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 20,
  });

  const fromCoupons = await tryCouponRows(couponAssignments);
  if (fromCoupons) return fromCoupons;

  const preferWebsite =
    couponAssignments.some((row) => String(row.couponType).toUpperCase() === "CODE") ||
    (Array.isArray(loadedCoupons) &&
      loadedCoupons.some((row) => String(row.couponType).toUpperCase() === "CODE"));

  // Match Coupon CMS coupon rows by campaign name, then enrich with parent campaign.
  if (assignment.canonicalCampaign?.displayName) {
    const entity = await db.entity.findFirst({
      where: {
        entityType: "coupon",
        campaignName: { equals: assignment.canonicalCampaign.displayName, mode: "insensitive" },
      },
      orderBy: [{ updatedAt: "desc" }],
    });
    const fromCms = await destinationFromEntityWithParent(db, entity, {
      couponType: preferWebsite ? "CODE" : null,
    });
    if (fromCms.url) {
      return { url: fromCms.url, source: `${fromCms.source}+campaignName`, reason: null };
    }

    // Parent campaign entity directly (preview_url / tracking_link).
    const campaignEntity = await db.entity.findFirst({
      where: {
        entityType: "campaign",
        OR: [
          { campaignName: { equals: assignment.canonicalCampaign.displayName, mode: "insensitive" } },
          { entityName: { equals: assignment.canonicalCampaign.displayName, mode: "insensitive" } },
        ],
      },
      orderBy: [{ updatedAt: "desc" }],
    });
    const fromCampaign = destinationFromCampaignEntity(campaignEntity, { preferWebsite });
    if (fromCampaign.url) {
      return { url: fromCampaign.url, source: fromCampaign.source, reason: null };
    }
  }

  // Supplier campaign via CampaignSource
  const supplierCampaign =
    assignment.campaignSource?.supplierCampaign ||
    link?.campaignSource?.supplierCampaign ||
    null;
  const fromSupplierCampaign = preferWebsite
    ? pickUrl(supplierCampaign?.destinationUrl, supplierCampaign?.trackingUrl)
    : pickUrl(supplierCampaign?.trackingUrl, supplierCampaign?.destinationUrl);
  if (fromSupplierCampaign) {
    return {
      url: fromSupplierCampaign,
      source: supplierCampaign?.trackingUrl ? "supplierCampaign.trackingUrl" : "supplierCampaign.destinationUrl",
      reason: null,
    };
  }

  // Merchant website / tracking (last resort)
  const merchant = assignment.canonicalCampaign?.merchant;
  const fromMerchant = preferWebsite
    ? pickUrl(merchant?.website, merchant?.supplierTrackingLink)
    : pickUrl(merchant?.supplierTrackingLink, merchant?.website);
  if (fromMerchant) {
    return {
      url: fromMerchant,
      source: merchant?.website && fromMerchant === merchant.website
        ? "merchant.website"
        : "merchant.supplierTrackingLink",
      reason: null,
    };
  }

  return {
    url: null,
    source: null,
    reason: preferWebsite
      ? "Website URL is missing for this code campaign. Ensure the Coupon CMS / parent campaign has a preview or website URL."
      : "Supplier tracking URL is missing for this campaign. Ensure the Coupon CMS entry has a tracking URL.",
  };
}
