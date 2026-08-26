import { summarizeAssignmentProvisioning } from "../provisioningStatus.js";
import {
  mapCampaignType,
  mapClientChannelType,
  resolveRelationshipStatus,
} from "../../ops/v15FieldContract.js";
import {
  projectBrandIdentity,
  brandIdentityToAdminLinks,
} from "../../merchant/brandIdentity.js";
import { derivePartnerAssignmentStatus } from "./partnerCampaign.dto.js";

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function toClientDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    legalName: record.legalName ?? null,
    industry: record.industry,
    category: record.category,
    subCategory: record.subCategory,
    country: record.country,
    currency: record.currency,
    timezone: record.timezone,
    logoUrl: record.logoUrl,
    status: record.status,
    commercialModel: record.commercialModel ?? null,
    deliveryMethod: record.deliveryMethod ?? "API_AND_PORTAL",
    agreementStatus: record.agreementStatus ?? "NONE",
    agreementEffectiveAt: toIso(record.agreementEffectiveAt),
    agreementRenewalAt: toIso(record.agreementRenewalAt),
    agreementDocumentUrl: record.agreementDocumentUrl ?? null,
    paymentCycle: record.paymentCycle ?? null,
    paymentTrigger: record.paymentTrigger ?? null,
    apiEnvironmentConfig: record.apiEnvironmentConfig ?? null,
    clientSharePercent:
      record.clientSharePercent == null || record.clientSharePercent === ""
        ? null
        : Number(record.clientSharePercent),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    deletedAt: toIso(record.deletedAt),
    ...(record.setupProgress ? { setupProgress: record.setupProgress } : {}),
  };
}

export function toClientSummaryDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    status: record.status,
    country: record.country,
    currency: record.currency ?? null,
    industry: record.industry,
    category: record.category,
    subCategory: record.subCategory,
    commercialModel: record.commercialModel ?? null,
    deliveryMethod: record.deliveryMethod ?? "API_AND_PORTAL",
    agreementStatus: record.agreementStatus ?? "NONE",
    clientSharePercent:
      record.clientSharePercent == null || record.clientSharePercent === ""
        ? null
        : Number(record.clientSharePercent),
    ...(record.opsSummary ? { opsSummary: record.opsSummary } : {}),
    ...(record.setupProgress ? { setupProgress: record.setupProgress } : {}),
  };
}

export function toClientBrandRequestDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    clientId: record.clientId,
    merchantId: record.merchantId,
    requestedBrandName: record.requestedBrandName,
    requestedBy: record.requestedBy,
    priority: record.priority,
    status: record.status,
    notes: record.notes,
    requestedAt: toIso(record.requestedAt),
    resolvedAt: toIso(record.resolvedAt),
    fulfilledAssignmentId: record.fulfilledAssignmentId,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    client: record.client ? toClientSummaryDto(record.client) : undefined,
    merchant: record.merchant
      ? {
          id: record.merchant.id,
          displayName: record.merchant.displayName,
          slug: record.merchant.slug,
        }
      : undefined,
  };
}

export function toClientCampaignAssignmentDto(record, { includeStaffCommercial = false } = {}) {
  if (!record) return null;

  const dto = {
    id: record.id,
    clientId: record.clientId,
    canonicalCampaignId: record.canonicalCampaignId,
    campaignSourceId: record.campaignSourceId ?? null,
    status: record.status,
    published: record.published,
    publishedAt: toIso(record.publishedAt),
    unpublishedAt: toIso(record.unpublishedAt),
    startDate: toIso(record.startDate),
    endDate: toIso(record.endDate),
    // Deprecated for staff UI; retained for backward-compatible API consumers / partner projection inputs.
    channel: record.channel,
    notes: record.notes,
    clientFacing: record.clientFacing ?? null,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
    client: record.client ? toClientSummaryDto(record.client) : undefined,
    canonicalCampaign: record.canonicalCampaign
      ? toClientVisibleCatalogDto(record.canonicalCampaign)
      : undefined,
  };

  if (includeStaffCommercial) {
    dto.suppliers = record.suppliers ?? [];
    dto.supplierLabel = record.supplierLabel ?? null;
    dto.grossOrders = record.grossOrders ?? 0;
    dto.netOrders = record.netOrders ?? 0;
    dto.grossOrderValue = record.grossOrderValue ?? 0;
    dto.netOrderValue = record.netOrderValue ?? 0;
    dto.ordersCurrency = record.ordersCurrency ?? null;

    const merchant = record.canonicalCampaign?.merchant || null;
    const source = record.campaignSource || null;
    const supplierCampaign = source?.supplierCampaign || null;
    const rules = record.commissionRules || [];
    const rule =
      rules.find((r) => r.status === "EFFECTIVE") || rules.find((r) => r.status === "DRAFT") || null;
    const links = (record.trackingLinks || []).filter((l) => l?.status !== "REVOKED");
    const primaryLink =
      links.find((l) => l.isPrimary) || links.find((l) => l.mboTrackingUrl) || links[0] || null;
    const coupons = record.couponAssignments || [];

    const brand = projectBrandIdentity(merchant, supplierCampaign);
    const brandLinks = brandIdentityToAdminLinks(brand);
    const couponCode = coupons[0]?.clientCouponCode ?? null;
    const supportsLink =
      source?.supportsLink === true || Boolean(primaryLink?.mboTrackingUrl);
    const supportsCoupon = source?.supportsCoupon === true || Boolean(couponCode);
    const supportsDeeplink = supplierCampaign?.deepLinkingEnabled === true;
    const commercialModel = mapCampaignType(
      supplierCampaign?.campaignType,
      supplierCampaign?.pricingModel,
    );
    const channelType = mapClientChannelType({
      supportsLink,
      supportsCoupon,
      supportsDeeplink,
      couponCode,
    });
    const assignmentStatus = derivePartnerAssignmentStatus({
      assignmentStatus: record.status,
      published: record.published === true,
      tracking: primaryLink?.mboTrackingUrl
        ? { mboTrackingUrl: primaryLink.mboTrackingUrl }
        : null,
      coupon: couponCode ? { code: couponCode } : null,
      commercial: rule ? { status: rule.status } : null,
    });

    dto.brand = brand;
    dto.brandName = brandLinks.brandName;
    dto.brandLogoLink = brandLinks.brandLogoLink;
    dto.brandWebsiteLink = brandLinks.brandWebsiteLink;
    dto.networkSource =
      supplierCampaign?.supplier ||
      supplierCampaign?.supplierRef?.key ||
      (Array.isArray(dto.suppliers) && dto.suppliers[0] ? dto.suppliers[0] : null);
    dto.relationshipStatus = source
      ? resolveRelationshipStatus(source, supplierCampaign)
      : null;
    dto.relationshipLabel =
      dto.relationshipStatus == null || String(dto.relationshipStatus).toUpperCase() === "UNKNOWN"
        ? "Needs review"
        : String(dto.relationshipStatus)
            .replaceAll("_", " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
    dto.commercialModel = commercialModel ?? null;
    dto.channelType = channelType;
    dto.channels = {
      link: supportsLink,
      coupon: supportsCoupon,
      deeplink: supportsDeeplink,
    };
    /** Derived lifecycle — not raw DB status alone; not interchangeable with published. */
    dto.assignmentStatus = assignmentStatus;
    dto.commissionRuleStatus = rule?.status ?? null;
    dto.commissionType = rule?.commissionType ?? null;
    dto.commissionRuleId = rule?.id ?? null;
    dto.clientCommercialModel = record.client?.commercialModel ?? null;
    dto.clientSharePercent =
      record.client?.clientSharePercent != null && record.client?.clientSharePercent !== ""
        ? Number(record.client.clientSharePercent)
        : null;
    dto.trackingStatus = primaryLink?.status ?? null;
    dto.hasTrackingUrl = Boolean(primaryLink?.mboTrackingUrl);
    dto.trackingUrl = primaryLink?.mboTrackingUrl ?? null;
    dto.supplierTrackingUrl =
      supplierCampaign?.trackingUrl ?? supplierCampaign?.destinationUrl ?? null;
    dto.destinationUrl = supplierCampaign?.destinationUrl ?? null;
    dto.campaignChannelType = supplierCampaign?.campaignType ?? null;
    dto.supplierMboTrackingUrl = supplierCampaign?.mboTrackingUrl ?? null;
    dto.supplierMboTrackingSlug = supplierCampaign?.mboTrackingSlug ?? null;
    dto.trackingLinkId = primaryLink?.id ?? null;
    dto.couponStatus = coupons[0]?.status ?? null;
    dto.couponAssigned = coupons.length > 0;
    dto.couponCode = couponCode;
    dto.supplierCampaignId =
      supplierCampaign?.id || supplierCampaign?.supplierCampaignId || source?.supplierCampaignId || null;
    dto.blocker = null;
    dto.provisioning = summarizeAssignmentProvisioning({
      status: record.status,
      published: record.published,
      commissionRules: rules,
      trackingLinks: links,
    });
    dto.blocker = dto.provisioning?.issue ?? null;
  }

  return dto;
}

/** Client-safe catalog projection — no supplier information. */
export function toClientVisibleCatalogDto(record) {
  if (!record) return null;

  return {
    id: record.id,
    merchantId: record.merchantId,
    displayName: record.displayName,
    status: record.status,
    visibility: record.visibility,
    category: record.category,
    countries: record.countries ?? [],
    defaultCurrency: record.defaultCurrency,
  };
}

export function toClientDetailDto(record, { visibleAssignments = [] } = {}) {
  const client = toClientDto(record);
  if (!client) return null;

  return {
    ...client,
    brandRequests: record.brandRequests?.map((row) => toClientBrandRequestDto(row)) ?? [],
    assignments: record.assignments?.map((row) => toClientCampaignAssignmentDto(row)) ?? [],
    visibleCampaigns: visibleAssignments.map((row) => ({
      assignment: toClientCampaignAssignmentDto(row),
      campaign: toClientVisibleCatalogDto(row.canonicalCampaign),
    })),
  };
}
