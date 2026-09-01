/**
 * v13 Network Operations — Tracking Links registry.
 * Pointer 11 — supplier and MBO links are separate; supplier URLs visible internally only.
 */
import { prisma } from "../../database/prisma.js";
import {
  getTrackingParamRule,
  TRACKING_PARAM_CONFIRMATION,
} from "../tracking/trackingParamRules.js";
import {
  attributionParameterLabel,
  buildRedirectChain,
  formatRedirectChainSummary,
  resolveMboTrackingLink,
  resolveSupplierTrackingLink,
  toInternalTrackingLinkDto,
} from "../tracking/trackingLink.contract.js";

function networkLabel(supplier) {
  const key = String(supplier || "").toUpperCase();
  if (key === "TRACKIER") return "Trackier";
  if (key === "VCOMMISSION") return "vCommission";
  if (!key) return null;
  return key.charAt(0) + key.slice(1).toLowerCase();
}

function linkTypeFor(row) {
  if (row.deepLinkingEnabled === true) return "Deeplink";
  return "Campaign Tracking Link";
}

function linkStatusFor(row, rule) {
  const hasSupplier = Boolean(resolveSupplierTrackingLink(row));
  if (!hasSupplier && !resolveMboTrackingLink(row)) return null;
  if (
    rule.confirmation === TRACKING_PARAM_CONFIRMATION.UNCONFIRMED ||
    rule.confirmation === TRACKING_PARAM_CONFIRMATION.DISABLED ||
    (rule.verificationFlags || []).some((f) => String(f).includes("UNVERIFIED") && !rule.clientIdParam)
  ) {
    if (rule.confirmation !== TRACKING_PARAM_CONFIRMATION.CONFIRMED) return "VERIFY_LIVE";
  }
  if (String(row.campaignStatus || "").toUpperCase() === "ACTIVE" && hasSupplier) return "ACTIVE";
  if (hasSupplier) return "ACTIVE";
  return "VERIFY_LIVE";
}

function mappingStatusFor(row, rule) {
  const hasSupplier = Boolean(resolveSupplierTrackingLink(row));
  if (!hasSupplier) return "UNMAPPED";
  if (rule.confirmation === TRACKING_PARAM_CONFIRMATION.CONFIRMED) return "MAPPED";
  return "VERIFY_LIVE";
}

export function toAdminTrackingLinkDto(row) {
  const rule = getTrackingParamRule(row.supplier);
  const brandName = row.merchant?.displayName || row.merchantNameRaw || null;
  const supplierTrackingLink = resolveSupplierTrackingLink({
    trackingUrl: row.trackingUrl,
    destinationUrl: row.destinationUrl,
  });
  const mboTrackingLink = resolveMboTrackingLink({ mboTrackingUrl: row.mboTrackingUrl });
  const attributionParameter = attributionParameterLabel(row.supplier);
  const redirectChain = buildRedirectChain({ supplier: row.supplier, attributionParameter });

  const base = toInternalTrackingLinkDto({
    id: row.id,
    supplier: row.supplier,
    supplierTrackingLink,
    mboTrackingLink,
    trackingLinkId: row.id,
    attributionParameter,
  });

  return {
    ...base,
    networkSourceLabel: networkLabel(row.supplier),
    brandName,
    campaignName: row.campaignName || null,
    linkType: linkTypeFor(row),
    supplierLinkId: row.supplierCampaignId || null,
    landingPageUrl: row.destinationUrl || row.merchant?.website || null,
    supplierDeeplinkUrl: row.deepLinkingEnabled ? supplierTrackingLink : null,
    mboAssignmentStatus: mboTrackingLink ? "ASSIGNED" : "UNASSIGNED",
    linkStatus: linkStatusFor({ ...row, trackingUrl: supplierTrackingLink }, rule),
    deeplinkSupported: row.deepLinkingEnabled === true ? "YES" : row.deepLinkingEnabled === false ? "NO" : null,
    sourceFieldPath: rule.clientIdParam
      ? `tracking URL + ${rule.clientIdParam}`
      : "tracking_url / VERIFY_LIVE",
    mappingStatus: mappingStatusFor({ ...row, trackingUrl: supplierTrackingLink }, rule),
    campaignStatus: row.campaignStatus || null,
    supplier: row.supplier || null,
    updatedAt: row.updatedAt || null,
    redirectChainSummary: formatRedirectChainSummary(redirectChain),
    redirectChain,
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
      contract: "pointer-11-tracking-links",
    };
  }
}
