/**
 * v13 Network Operations — Tracking Links registry.
 * One row per supplier campaign that has a real supplier and/or MBO tracking URL.
 * Never invents links from campaign metadata alone.
 */
import { prisma } from "../../database/prisma.js";
import {
  getTrackingParamRule,
  TRACKING_PARAM_CONFIRMATION,
} from "../tracking/trackingParamRules.js";

function networkLabel(supplier) {
  const key = String(supplier || "").toUpperCase();
  if (key === "TRACKIER") return "Trackier";
  if (key === "VCOMMISSION") return "vCommission";
  if (!key) return null;
  return key.charAt(0) + key.slice(1).toLowerCase();
}

function attributionParameterFor(supplier) {
  const rule = getTrackingParamRule(supplier);
  if (
    rule.confirmation === TRACKING_PARAM_CONFIRMATION.UNCONFIRMED ||
    rule.confirmation === TRACKING_PARAM_CONFIRMATION.DISABLED
  ) {
    return "VERIFY_LIVE";
  }
  // v13 display prefers the primary client/sub attribution param name.
  if (rule.clientIdParam) {
    const key = String(supplier || "").toUpperCase();
    if (key === "IMPACT") return "SubId1";
    if (key === "OPTIMISE") return "UID";
    if (key === "AWIN") return "clickRef";
    if (key === "PARTNERIZE") return "camref";
    if (key === "TRACKIER" || key === "VCOMMISSION") return "p1 / sub parameter";
    return rule.clientIdParam;
  }
  return "VERIFY_LIVE";
}

function linkTypeFor(row) {
  if (row.deepLinkingEnabled === true) return "Deeplink";
  return "Campaign Tracking Link";
}

function linkStatusFor(row, rule) {
  const hasSupplier = Boolean(row.trackingUrl && String(row.trackingUrl).trim());
  if (!hasSupplier && !row.mboTrackingUrl) return null;
  if (
    rule.confirmation === TRACKING_PARAM_CONFIRMATION.UNCONFIRMED ||
    rule.confirmation === TRACKING_PARAM_CONFIRMATION.DISABLED ||
    (rule.verificationFlags || []).some((f) => String(f).includes("UNVERIFIED") && !rule.clientIdParam)
  ) {
    // Boostiny-style: URL may exist but attribution is still VERIFY_LIVE
    if (rule.confirmation !== TRACKING_PARAM_CONFIRMATION.CONFIRMED) return "VERIFY_LIVE";
  }
  if (String(row.campaignStatus || "").toUpperCase() === "ACTIVE" && hasSupplier) return "ACTIVE";
  if (hasSupplier) return "ACTIVE";
  return "VERIFY_LIVE";
}

function mappingStatusFor(row, rule) {
  const hasSupplier = Boolean(row.trackingUrl && String(row.trackingUrl).trim());
  if (!hasSupplier) return "UNMAPPED";
  if (rule.confirmation === TRACKING_PARAM_CONFIRMATION.CONFIRMED) return "MAPPED";
  return "VERIFY_LIVE";
}

export function toAdminTrackingLinkDto(row) {
  const rule = getTrackingParamRule(row.supplier);
  const brandName =
    row.merchant?.displayName || row.merchantNameRaw || null;
  const supplierTrackingLink = row.trackingUrl || row.destinationUrl || null;
  return {
    id: row.id,
    networkSource: row.supplier || null,
    networkSourceLabel: networkLabel(row.supplier),
    brandName,
    campaignName: row.campaignName || null,
    linkType: linkTypeFor(row),
    supplierLinkId: row.supplierCampaignId || null,
    supplierTrackingLink,
    landingPageUrl: row.destinationUrl || row.merchant?.website || null,
    supplierDeeplinkUrl: row.deepLinkingEnabled ? supplierTrackingLink : null,
    mboTrackingLink: row.mboTrackingUrl || null,
    mboAssignmentStatus: row.mboTrackingUrl ? "ASSIGNED" : "UNASSIGNED",
    attributionParameter: attributionParameterFor(row.supplier),
    linkStatus: linkStatusFor({ ...row, trackingUrl: supplierTrackingLink }, rule),
    deeplinkSupported: row.deepLinkingEnabled === true ? "YES" : row.deepLinkingEnabled === false ? "NO" : null,
    sourceFieldPath: rule.clientIdParam
      ? `tracking URL + ${rule.clientIdParam}`
      : "tracking_url / VERIFY_LIVE",
    mappingStatus: mappingStatusFor({ ...row, trackingUrl: supplierTrackingLink }, rule),
    campaignStatus: row.campaignStatus || null,
    supplier: row.supplier || null,
    updatedAt: row.updatedAt || null,
  };
}

export class TrackingLinksOpsService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  async listTrackingLinks(filters = {}, { skip = 0, take = 50 } = {}) {
    const where = {
      OR: [
        { trackingUrl: { not: null } },
        { mboTrackingUrl: { not: null } },
        { destinationUrl: { not: null } },
      ],
      archivedAt: null,
    };

    if (filters.network || filters.supplier || filters.networkSource) {
      const raw = String(filters.network || filters.supplier || filters.networkSource).trim();
      const key = raw.toUpperCase() === "VCOMMISSION" ? "TRACKIER" : raw.toUpperCase();
      where.supplier = key;
    }

    if (filters.q || filters.search) {
      const q = String(filters.q || filters.search).trim();
      where.AND = [
        {
          OR: [
            { campaignName: { contains: q, mode: "insensitive" } },
            { merchantNameRaw: { contains: q, mode: "insensitive" } },
            { trackingUrl: { contains: q, mode: "insensitive" } },
            { mboTrackingUrl: { contains: q, mode: "insensitive" } },
            { supplierCampaignId: { contains: q, mode: "insensitive" } },
            { merchant: { displayName: { contains: q, mode: "insensitive" } } },
          ],
        },
      ];
    }

    if (filters.linkStatus) {
      // Applied after map — keep DB filter loose
    }

    const [rows, total] = await Promise.all([
      this.db.supplierCampaign.findMany({
        where,
        include: {
          merchant: { select: { id: true, displayName: true, website: true } },
        },
        orderBy: [{ lastSyncedAt: "desc" }, { updatedAt: "desc" }],
        skip,
        take,
      }),
      this.db.supplierCampaign.count({ where }),
    ]);

    let mapped = rows.map(toAdminTrackingLinkDto);
    if (filters.linkStatus) {
      const want = String(filters.linkStatus).toUpperCase();
      mapped = mapped.filter((r) => String(r.linkStatus || "").toUpperCase() === want);
    }

    return {
      rows: mapped,
      total: filters.linkStatus ? mapped.length : total,
      contract: "v13-tracking-links",
    };
  }
}
