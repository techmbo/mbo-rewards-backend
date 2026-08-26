import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import {
  buildPipelineStages,
  deriveImportedRecordStatuses,
  displayNetwork,
  recordTypeLabel,
  stripSensitivePayload,
  SUPPORTED_RECORD_TYPES,
  MAPPING_STATUS,
  SOURCE_STATUS,
} from "./importedRecords.contract.js";
import {
  deriveCampaignChannelType,
  deriveIsAssignable,
  deriveMappingStatus,
  deriveMboReady,
  formatCommissionSummary,
  mapCampaignStatus,
  mapCampaignType,
  resolveRelationshipStatus,
  buildMappingCertificationChecklist,
  money,
} from "./v15FieldContract.js";
import { CampaignNormalizationService } from "./campaignNormalization.service.js";
import { PromotionJob } from "../../jobs/promotion.job.js";
import {
  projectBrandIdentity,
  brandIdentityToAdminLinks,
  brandLabelFromLandingUrl,
  extractBrandFromCampaignName,
  humanizeBrandFromDomain,
} from "../merchant/brandIdentity.js";
import { tryMapCampaignEntity } from "../supplier/mappers/index.js";
import { extractCountryCodesFromRaw, extractCommissionValueFromRaw, normalizeTermsText, extractSecondaryCategoryFromRaw, extractTrackingUrlFromRaw, extractCampaignStartDateFromRaw, extractCampaignEndDateFromRaw } from "../supplier/mappers/shared.js";

function parsePage(query) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function buildWhere(filters = {}) {
  const where = {};
  const and = [];

  if (filters.networkSource) {
    const ns = String(filters.networkSource).toLowerCase();
    if (ns === "optimise") {
      where.networkSource = { startsWith: "optimise" };
    } else {
      where.networkSource = ns;
    }
  }

  if (filters.recordType) {
    where.entityType = String(filters.recordType).toLowerCase();
  } else if (filters.entityType) {
    where.entityType = String(filters.entityType).toLowerCase();
  }

  if (filters.fromDate || filters.toDate) {
    where.createdAt = {};
    if (filters.fromDate) where.createdAt.gte = new Date(filters.fromDate);
    if (filters.toDate) where.createdAt.lte = new Date(filters.toDate);
  }

  if (filters.search) {
    const q = String(filters.search).trim();
    if (q) {
      and.push({
        OR: [
          { externalId: { contains: q, mode: "insensitive" } },
          { entityName: { contains: q, mode: "insensitive" } },
          { campaignName: { contains: q, mode: "insensitive" } },
          { advertiserName: { contains: q, mode: "insensitive" } },
          { networkSource: { contains: q, mode: "insensitive" } },
          { id: { equals: q } },
          {
            supplierCampaigns: {
              some: {
                OR: [
                  { supplierCampaignId: { contains: q, mode: "insensitive" } },
                  { campaignName: { contains: q, mode: "insensitive" } },
                  { merchantNameRaw: { contains: q, mode: "insensitive" } },
                  { categoryName: { contains: q, mode: "insensitive" } },
                  { trackingUrl: { contains: q, mode: "insensitive" } },
                  { sourceAccountLabel: { contains: q, mode: "insensitive" } },
                  { rawPayloadId: { equals: q } },
                  { id: { equals: q } },
                  {
                    campaignSources: {
                      some: { id: { equals: q } },
                    },
                  },
                  {
                    coupons: {
                      some: { couponCode: { contains: q, mode: "insensitive" } },
                    },
                  },
                ],
              },
            },
          },
          {
            rawPayloads: {
              some: { id: { equals: q } },
            },
          },
          {
            supplierCoupons: {
              some: { couponCode: { contains: q, mode: "insensitive" } },
            },
          },
        ],
      });
    }
  }

  if (filters.brand) {
    const brand = String(filters.brand).trim();
    and.push({
      OR: [
        { advertiserName: { contains: brand, mode: "insensitive" } },
        {
          supplierCampaigns: {
            some: {
              OR: [
                { merchantNameRaw: { contains: brand, mode: "insensitive" } },
                { merchant: { displayName: { contains: brand, mode: "insensitive" } } },
              ],
            },
          },
        },
      ],
    });
  }

  if (filters.campaign) {
    const campaign = String(filters.campaign).trim();
    and.push({
      OR: [
        { campaignName: { contains: campaign, mode: "insensitive" } },
        { entityName: { contains: campaign, mode: "insensitive" } },
        {
          supplierCampaigns: {
            some: { campaignName: { contains: campaign, mode: "insensitive" } },
          },
        },
      ],
    });
  }

  // Status filters require join-aware predicates
  if (filters.mappingStatus === MAPPING_STATUS.ERROR || filters.preset === "mapping_errors") {
    and.push({ mapperErrors: { some: { status: "OPEN" } } });
  } else if (filters.mappingStatus === MAPPING_STATUS.MAPPED || filters.preset === "normalized") {
    and.push({
      OR: [
        {
          entityType: "campaign",
          supplierCampaigns: {
            some: {
              merchantId: { not: null },
              campaignSources: { some: { isActive: true } },
            },
          },
        },
        {
          entityType: "coupon",
          supplierCoupons: { some: {} },
        },
      ],
    });
  } else if (
    filters.mappingStatus === MAPPING_STATUS.NEEDS_REVIEW ||
    filters.preset === "needs_review" ||
    filters.preset === "imported_not_normalized"
  ) {
    and.push({
      mapperErrors: { none: { status: "OPEN" } },
      OR: [
        {
          entityType: "campaign",
          NOT: {
            supplierCampaigns: {
              some: {
                merchantId: { not: null },
                campaignSources: { some: { isActive: true } },
              },
            },
          },
        },
        {
          entityType: "coupon",
          supplierCoupons: { none: {} },
        },
        { entityType: "performance" },
      ],
    });
  } else if (filters.mappingStatus === MAPPING_STATUS.NOT_AVAILABLE) {
    and.push({ entityType: "performance" });
  }

  if (filters.sourceStatus === SOURCE_STATUS.FAILED) {
    and.push({ mapperErrors: { some: { status: "OPEN" } } });
  } else if (filters.sourceStatus === SOURCE_STATUS.PROCESSED) {
    and.push({
      mapperErrors: { none: { status: "OPEN" } },
      OR: [
        { entityType: "campaign", supplierCampaigns: { some: {} } },
        { entityType: "coupon", supplierCoupons: { some: {} } },
      ],
    });
  } else if (filters.sourceStatus === SOURCE_STATUS.IMPORTED) {
    and.push({
      mapperErrors: { none: { status: "OPEN" } },
      OR: [
        { entityType: "campaign", supplierCampaigns: { none: {} } },
        { entityType: "coupon", supplierCoupons: { none: {} } },
        { entityType: "performance" },
      ],
    });
  }

  if (filters.issue) {
    const issue = String(filters.issue).toUpperCase();
    if (issue === "MISSING_MERCHANT_IDENTIFIER") {
      and.push({
        entityType: "campaign",
        supplierCampaigns: {
          some: { merchantId: null, OR: [{ merchantNameRaw: null }, { merchantNameRaw: "" }] },
        },
      });
    } else if (issue === "CAMPAIGN_NOT_PROMOTED") {
      and.push({ entityType: "campaign", supplierCampaigns: { none: {} } });
    } else if (issue === "CAMPAIGN_SOURCE_MISSING") {
      and.push({
        entityType: "campaign",
        supplierCampaigns: {
          some: { merchantId: { not: null }, campaignSources: { none: {} } },
        },
      });
    }
  }

  if (filters.preset === "recently_imported") {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    where.createdAt = { ...(where.createdAt || {}), gte: since };
  }

  // Network campaign inventory filters (campaign entities with SupplierCampaign joins)
  if (filters.country) {
    const country = String(filters.country).trim().toUpperCase().slice(0, 2);
    and.push({
      entityType: "campaign",
      supplierCampaigns: { some: { countryCodes: { has: country } } },
    });
  }
  if (filters.campaignStatus) {
    const rawStatus = String(filters.campaignStatus).toUpperCase();
    // Workbook vocab → DB CampaignStatus (ACTIVE|PAUSED|PENDING|RETIRED|UNKNOWN)
    const statusIn =
      rawStatus === "EXPIRED" || rawStatus === "INACTIVE"
        ? ["RETIRED"]
        : ["ACTIVE", "PAUSED", "PENDING", "RETIRED", "UNKNOWN"].includes(rawStatus)
          ? [rawStatus]
          : null;
    if (statusIn) {
      and.push({
        entityType: "campaign",
        supplierCampaigns: {
          some: { campaignStatus: { in: statusIn } },
        },
      });
    }
  }
  if (filters.relationshipStatus) {
    const rawRel = String(filters.relationshipStatus).toUpperCase();
    // Workbook vocab → DB CampaignSourceRelationshipStatus (JOINED|NOT_JOINED|PENDING|UNKNOWN)
    let relIn = null;
    if (rawRel === "NOT_APPLIED" || rawRel === "REJECTED" || rawRel === "SUSPENDED") {
      relIn = ["NOT_JOINED"];
    } else if (rawRel === "APPROVED") {
      relIn = ["JOINED"];
    } else if (["JOINED", "NOT_JOINED", "PENDING", "UNKNOWN"].includes(rawRel)) {
      relIn = [rawRel];
    }
    if (relIn) {
      and.push({
        entityType: "campaign",
        supplierCampaigns: {
          some: {
            campaignSources: {
              some: {
                relationshipStatus: { in: relIn },
              },
            },
          },
        },
      });
    }
  }
  if (filters.campaignType) {
    const ct = String(filters.campaignType).trim();
    and.push({
      entityType: "campaign",
      supplierCampaigns: {
        some: { campaignType: { contains: ct, mode: "insensitive" } },
      },
    });
  }
  if (filters.category) {
    const cat = String(filters.category).trim();
    and.push({
      entityType: "campaign",
      supplierCampaigns: {
        some: { categoryName: { contains: cat, mode: "insensitive" } },
      },
    });
  }
  if (filters.currency) {
    const cur = String(filters.currency).trim().toUpperCase().slice(0, 3);
    and.push({
      entityType: "campaign",
      supplierCampaigns: {
        some: {
          OR: [{ currencyCode: cur }, { commissionCurrency: cur }],
        },
      },
    });
  }
  if (filters.isAssignable === "true" || filters.isAssignable === true) {
    // CSV: ACTIVE + JOINED/APPROVED + tracking/coupon support + commission (exact filter in list()).
    and.push({
      entityType: "campaign",
      supplierCampaigns: {
        some: {
          campaignStatus: "ACTIVE",
          OR: [
            { participationStatus: { in: ["JOINED", "APPROVED"] } },
            {
              campaignSources: {
                some: {
                  isActive: true,
                  relationshipStatus: { in: ["JOINED", "APPROVED"] },
                },
              },
            },
          ],
        },
      },
    });
  } else if (filters.isAssignable === "false" || filters.isAssignable === false) {
    and.push({
      entityType: "campaign",
      OR: [
        { supplierCampaigns: { none: {} } },
        {
          supplierCampaigns: {
            some: {
              OR: [
                { campaignStatus: { not: "ACTIVE" } },
                {
                  AND: [
                    { participationStatus: { notIn: ["JOINED", "APPROVED"] } },
                    {
                      campaignSources: {
                        none: {
                          isActive: true,
                          relationshipStatus: { in: ["JOINED", "APPROVED"] },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    });
  }

  if (filters.mboReady === "true" || filters.mboReady === true) {
    // Approximate DB prefilter: ACTIVE + JOINED + merchant + campaign source.
    // Exact deriveMboReady (certification/commission/assets) applied in list().
    and.push({
      entityType: "campaign",
      supplierCampaigns: {
        some: {
          campaignStatus: "ACTIVE",
          merchantId: { not: null },
          campaignSources: {
            some: {
              isActive: true,
              relationshipStatus: "JOINED",
            },
          },
        },
      },
    });
  } else if (filters.mboReady === "false" || filters.mboReady === false) {
    and.push({
      entityType: "campaign",
      OR: [
        { supplierCampaigns: { none: {} } },
        {
          supplierCampaigns: {
            some: {
              OR: [
                { campaignStatus: { not: "ACTIVE" } },
                { merchantId: null },
                { campaignSources: { none: { isActive: true } } },
              ],
            },
          },
        },
      ],
    });
  }

  if (and.length) where.AND = and;
  return where;
}

function pickDetectedFields(entity, supplierCampaign) {
  const raw = entity.rawData && typeof entity.rawData === "object" ? entity.rawData : {};
  const scSnapshot = resolveEntityCampaignSnapshot(entity, supplierCampaign);
  const merchant = scSnapshot?.merchant ?? supplierCampaign?.merchant ?? null;
  const lineage =
    supplierCampaign?.normalizedPayload?._trackierFieldLineage &&
    typeof supplierCampaign.normalizedPayload._trackierFieldLineage === "object"
      ? supplierCampaign.normalizedPayload._trackierFieldLineage
      : null;
  const fields = {};

  const brand = resolveExtractedBrand(entity, scSnapshot, merchant);
  if (brand) fields.brand = String(brand);

  const campaign =
    scSnapshot?.campaignName ||
    supplierCampaign?.campaignName ||
    entity.campaignName ||
    entity.entityName ||
    raw.title ||
    raw.campaign_name ||
    raw.campaignName ||
    raw.offer_name ||
    raw.name ||
    null;
  if (campaign) fields.campaign = String(campaign);

  const countries =
    supplierCampaign?.countryCodes?.length
      ? supplierCampaign.countryCodes
      : extractCountryCodesFromRaw(raw);
  if (countries?.length) fields.country = countries;

  const currency =
    supplierCampaign?.currencyCode ||
    raw.currency?.iso ||
    (typeof raw.currency === "string" ? raw.currency : null) ||
    raw.currency_code ||
    raw.currencyCode ||
    raw.payout?.currency ||
    raw.payouts?.[0]?.currency ||
    null;
  if (currency) fields.currency = String(currency).slice(0, 3);

  const model =
    supplierCampaign?.pricingModel ||
    raw.pricing_model ||
    raw.model ||
    raw.payout_type ||
    raw.payouts?.[0]?.model ||
    raw.payout?.type ||
    raw.campaignTypeName ||
    raw.productTypeName ||
    null;
  if (model) fields.commercialModel = String(model);

  const tracking =
    supplierCampaign?.trackingUrl ||
    raw.tracking_url ||
    raw.tracking_link ||
    raw.trackingURL ||
    raw.baseTrackingUrl ||
    null;
  if (tracking) fields.trackingUrl = String(tracking);

  const landing =
    supplierCampaign?.destinationUrl ||
    raw.preview_url ||
    raw.offer_url ||
    raw.website ||
    raw.landingPage?.websiteUrl ||
    raw.default_destination ||
    null;
  if (landing) fields.landingPageUrl = String(landing);

  if (raw.application_status || raw.applicationStatus) {
    fields.applicationStatus = String(raw.application_status || raw.applicationStatus);
  }
  if (raw.status) fields.supplierStatus = String(raw.status);

  const coupon = entity.code || raw.coupon || raw.code || null;
  if (coupon) fields.couponCode = String(coupon);

  if (lineage) fields.trackierFieldLineage = lineage;

  return fields;
}

function isUnset(value) {
  if (value === undefined || value === null || value === "") return true;
  if (value instanceof Date) return Number.isNaN(value.getTime());
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === "object") return Object.keys(value).length === 0;
  const asString = String(value).trim().toUpperCase();
  return asString === "UNKNOWN" || asString === "NULL" || asString === "-" || asString === "[OBJECT OBJECT]";
}

function firstFilled(...values) {
  for (const value of values) {
    if (!isUnset(value)) return value;
  }
  return null;
}

function mergeCampaignSnapshot(stored, extracted) {
  if (!extracted) return stored || null;
  if (!stored) return extracted;
  const storedCountries = Array.isArray(stored.countryCodes) ? stored.countryCodes : [];
  const extractedCountries = Array.isArray(extracted.countryCodes) ? extracted.countryCodes : [];
  return {
    ...stored,
    campaignName: firstFilled(stored.campaignName, extracted.campaignName),
    campaignDescription: firstFilled(stored.campaignDescription, extracted.campaignDescription),
    merchantNameRaw: firstFilled(stored.merchantNameRaw, extracted.merchantNameRaw),
    categoryName: firstFilled(stored.categoryName, extracted.categoryName),
    merchantVertical: firstFilled(stored.merchantVertical, extracted.merchantVertical),
    campaignType: firstFilled(stored.campaignType, extracted.campaignType),
    pricingModel: firstFilled(stored.pricingModel, extracted.pricingModel),
    defaultCommissionValue: firstFilled(
      stored.defaultCommissionValue,
      extracted.defaultCommissionValue,
    ),
    commissionUnit: firstFilled(stored.commissionUnit, extracted.commissionUnit),
    commissionCurrency: firstFilled(stored.commissionCurrency, extracted.commissionCurrency),
    commissionGroups: stored.commissionGroups ?? extracted.commissionGroups,
    trackingUrl: firstFilled(stored.trackingUrl, extracted.trackingUrl),
    destinationUrl: firstFilled(stored.destinationUrl, extracted.destinationUrl),
    campaignLogoUrl: firstFilled(stored.campaignLogoUrl, extracted.campaignLogoUrl),
    currencyCode: firstFilled(stored.currencyCode, extracted.currencyCode),
    countryCodes: storedCountries.length ? storedCountries : extractedCountries,
    campaignStatus: firstFilled(stored.campaignStatus, extracted.campaignStatus),
    participationStatus: firstFilled(stored.participationStatus, extracted.participationStatus),
    isJoined: stored.isJoined === true || extracted.isJoined === true,
    deepLinkingEnabled: stored.deepLinkingEnabled ?? extracted.deepLinkingEnabled,
    campaignStartDate: firstFilled(stored.campaignStartDate, extracted.campaignStartDate),
    campaignEndDate: firstFilled(
      stored.campaignEndDate,
      extracted.campaignEndDate,
      extracted.normalizedPayload?.campaignEndDate,
    ),
    termsAndConditions: firstFilled(stored.termsAndConditions, extracted.termsAndConditions),
    promotionDescription: firstFilled(stored.promotionDescription, extracted.promotionDescription),
    secondaryCategory: firstFilled(stored.secondaryCategory, extracted.secondaryCategory),
    discountPercent: firstFilled(stored.discountPercent, extracted.discountPercent),
  };
}

function resolveEntityCampaignSnapshot(entity, supplierCampaign) {
  if (supplierCampaign) return supplierCampaign;
  const entityType = String(entity?.entityType || "").toLowerCase();
  if (entityType !== "campaign") return null;
  const extracted = tryMapCampaignEntity(entity);
  return mergeCampaignSnapshot(null, extracted);
}

function resolveExtractedBrand(entity, scSnapshot, merchant = null) {
  const raw = entity?.rawData && typeof entity.rawData === "object" ? entity.rawData : {};
  const campaignName = firstFilled(
    scSnapshot?.campaignName,
    entity?.campaignName,
    entity?.entityName,
    raw.title,
    raw.campaign_name,
    raw.campaignName,
    raw.name,
  );
  const landingUrl = firstFilled(
    scSnapshot?.destinationUrl,
    raw.destination_url,
    raw.default_destination,
    raw.preview_url,
    raw.website,
    raw.landingPage?.websiteUrl,
  );
  const mappedMerchantName = scSnapshot?.merchantNameRaw;
  const merchantNameFromCampaign = extractBrandFromCampaignName(campaignName);
  const merchantNameFromLanding = brandLabelFromLandingUrl(landingUrl);
  const merchantNameFromDomain = humanizeBrandFromDomain(
    merchantNameFromLanding || (mappedMerchantName && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(String(mappedMerchantName).trim()) ? mappedMerchantName : null),
  );

  return firstFilled(
    merchant?.displayName,
    mappedMerchantName && !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(String(mappedMerchantName).trim())
      ? mappedMerchantName
      : null,
    merchantNameFromCampaign,
    merchantNameFromDomain,
    mappedMerchantName,
    entity?.advertiserName,
    raw.advertiser_name,
    raw.advertiserName,
    typeof raw.advertiser === "string" ? raw.advertiser : raw.advertiser?.name,
    raw.advertiser?.display_name,
    raw.merchant_name,
    raw.companyName,
    raw.brand_name,
    raw.brandName,
    merchantNameFromLanding,
  );
}

function availableActions({ openMapperError, entityType }) {
  const actions = [];
  if (openMapperError) {
    actions.push({
      key: "retry",
      label: "Retry",
      endpoint: "POST /promotion/retry",
      mapperErrorId: openMapperError.id,
    });
  }
  if (String(entityType).toLowerCase() === "campaign" || String(entityType).toLowerCase() === "coupon") {
    actions.push({
      key: "reprocess",
      label: "Reprocess",
      endpoint: "POST /promotion/run",
    });
  }
  return actions;
}

/**
 * Network Campaign contract fields from SupplierCampaign + CampaignSource + live payload.
 * Coupons inherit the parent campaign. Never invent tracking URLs, commission, or MBO Ready.
 */
function buildNetworkCampaignFields({
  entity,
  supplierCampaign,
  campaignSource,
  merchant,
  statuses,
  openMapperError,
  coupon = null,
}) {
  const entityType = String(entity.entityType || "").toLowerCase();
  const empty = {
    networkAccount: null,
    campaignSourceId: null,
    supplierCampaignExtId: null,
    networkCampaignId: null,
    rawPayloadId: null,
    category: null,
    secondaryCategory: null,
    country: null,
    currency: null,
    campaignType: null,
    commercialType: null,
    channelType: null,
    relationshipStatus: null,
    campaignStatus: null,
    certificationStatus: null,
    mboReady: null,
    isAssignable: null,
    commission: null,
    commissionType: null,
    commissionRate: null,
    commissionDisplay: null,
    commissionRuleCount: null,
    assets: null,
    linkSupport: null,
    couponSupport: null,
    deeplinkSupport: null,
    feedSupport: null,
    networkTrackingLink: null,
    mboTrackingLink: null,
    trackingLinkId: null,
    networkClickId: null,
    mboClickId: null,
    subId1: null,
    subId2: null,
    subId3: null,
    brandWebsite: null,
    campaignDescription: null,
    termsAndConditions: null,
    promotionDescription: null,
    discountPercent: null,
    startDate: null,
    endDate: null,
    lastSyncedAt: null,
    couponCount: null,
    sourceEndpoint: null,
    mappingStatus: null,
  };

  if (entityType !== "campaign" && entityType !== "coupon") {
    return empty;
  }

  const parentFromCoupon = coupon?.supplierCampaign || null;
  const stored = supplierCampaign || parentFromCoupon || null;
  const extracted =
    entityType === "campaign"
      ? tryMapCampaignEntity(entity)
      : stored
        ? null
        : couponSnapshotFromEntity(entity, coupon);
  const sc = mergeCampaignSnapshot(stored, extracted);
  const cs = campaignSource || stored?.campaignSources?.[0] || null;
  const raw = entity.rawData && typeof entity.rawData === "object" ? entity.rawData : {};

  const certification = stored?.mappingCertification ?? null;
  const trackingLink = cs?.trackingLinks?.[0] ?? null;
  const feedCount = cs?._count?.productFeeds ?? 0;
  const couponCount =
    stored?._count?.coupons != null
      ? Number(stored._count.coupons)
      : coupon || entityType === "coupon"
        ? 1
        : null;

  const hasHttpUrl = (value) => {
    const s = value != null ? String(value).trim() : "";
    return /^https?:\/\//i.test(s);
  };
  const partnerizeVoucherSignal =
    (Array.isArray(raw.voucher_commissions) && raw.voucher_commissions.length > 0) ||
    (Array.isArray(raw.vouchers) && raw.vouchers.length > 0) ||
    (Array.isArray(raw.coupons) && raw.coupons.length > 0) ||
    Boolean(raw.voucher);
  const linkSupport =
    Boolean(cs?.supportsLink) ||
    hasHttpUrl(sc?.trackingUrl) ||
    // Destination proves link channel capability (tracking URL may be generated separately).
    hasHttpUrl(sc?.destinationUrl) ||
    hasHttpUrl(raw.destination_url) ||
    hasHttpUrl(raw.default_destination) ||
    Boolean(coupon?.couponLink);
  const couponSupport =
    Boolean(cs?.supportsCoupon) ||
    (couponCount != null && couponCount > 0) ||
    Boolean(coupon?.couponCode) ||
    partnerizeVoucherSignal ||
    entityType === "coupon";
  const deeplinkSupport =
    Boolean(sc?.deepLinkingEnabled) ||
    Boolean(raw.deepLinkEnabled) ||
    Boolean(raw.deeplinkEnabled) ||
    String(raw.allow_deep_linking || raw.allowDeepLinking || "")
      .trim()
      .toLowerCase() === "y" ||
    raw.allow_deep_linking === true ||
    raw.allowDeepLinking === true;
  const feedSupport = feedCount > 0;

  const commissionValue = money(
    firstFilled(sc?.defaultCommissionValue, extractCommissionValueFromRaw(raw), cs?.grossCommission),
  );
  const commissionUnit = firstFilled(sc?.commissionUnit, null);
  const commissionGroups = sc?.commissionGroups;
  const commissionRules = Array.isArray(commissionGroups)
    ? commissionGroups
    : commissionGroups
      ? [commissionGroups]
      : [];
  const commissionAvailable =
    (commissionValue != null && Number(commissionValue) !== 0) ||
    (cs?.grossCommission != null && Number(cs.grossCommission) !== 0) ||
    commissionRules.length > 0;

  const checklistEval = buildMappingCertificationChecklist({
    supplierCampaign: stored || sc,
    hasCampaignSource: Boolean(cs?.id),
    commissionAvailable,
    mapperVersion: stored?.mapperVersion,
  });
  const certificationStatus = certification?.status ?? null;
  const certificationMappingStatus = cs?.id
    ? deriveMappingStatus({
        syncConflict: stored?.syncConflict,
        merchantId: stored?.merchantId,
        rawPayloadId: stored?.rawPayloadId || entity.rawPayloads?.[0]?.id || null,
        certificationStatus,
        checklistValid: Boolean(certificationStatus === "CERTIFIED" && checklistEval.valid),
      })
    : "NEEDS_REVIEW";

  const relationshipStatus = resolveRelationshipStatus(cs, sc);
  let campaignStatus = sc?.campaignStatus ? mapCampaignStatus(sc.campaignStatus) : null;
  // Partnerize publisher-list status "a" means Active — apply on read when stored status is blank/UNKNOWN.
  if (
    (!campaignStatus || campaignStatus === "UNKNOWN") &&
    String(entity.networkSource || "").toLowerCase() === "partnerize"
  ) {
    const code = String(
      raw.publisher_status ?? raw.participation_code ?? raw.status ?? "",
    )
      .trim()
      .toLowerCase();
    if (code === "a") campaignStatus = "ACTIVE";
  }
  const brandMappingComplete = Boolean(stored?.merchantId);
  const hasUsableAsset = Boolean(linkSupport || couponSupport || deeplinkSupport);
  const mboReady =
    entityType === "coupon"
      ? null
      : sc
        ? deriveMboReady({
            campaignStatus: campaignStatus || sc.campaignStatus,
            relationshipStatus,
            brandMappingComplete,
            mappingStatus: certificationMappingStatus,
            commissionAvailable,
            hasUsableAsset,
            sourceHidden: Boolean(stored?.archivedAt),
            hasCampaignSource: Boolean(cs?.id),
          })
        : false;

  const isAssignable =
    entityType === "coupon"
      ? null
      : sc
        ? deriveIsAssignable({
            campaignStatus: campaignStatus || sc.campaignStatus,
            relationshipStatus,
            supportsLink: linkSupport,
            supportsCoupon: couponSupport,
            supportsDeeplink: deeplinkSupport,
            commissionAvailable,
            // CampaignSource = network supplier source for this campaign.
            hasCampaignSource: Boolean(cs?.id),
            mappingStatus: certificationMappingStatus,
          })
        : false;

  const channelType = deriveCampaignChannelType({
    supportsLink: linkSupport,
    supportsCoupon: couponSupport,
    supportsDeeplink: deeplinkSupport,
    trackingUrl: sc?.trackingUrl,
  });

  // Commercial model (CPS/CPA/…) — never leak channel words into campaignType.
  const campaignTypeOnly = mapCampaignType(
    firstFilled(sc?.campaignType, entity.entitySubType),
    firstFilled(sc?.pricingModel, null),
  );
  const commercialTypeOnly = firstFilled(sc?.pricingModel, campaignTypeOnly);

  const commissionDisplay = formatCommissionSummary({
    grossCommission: commissionValue ?? cs?.grossCommission,
    commissionUnit,
    rules: commissionRules,
    ratePercents: [],
  });
  const commissionRuleCount = commissionRules.length;

  const networkTrackingLink = (() => {
    const url = firstFilled(sc?.trackingUrl, extractTrackingUrlFromRaw(raw), coupon?.couponLink);
    return url && String(url).trim() ? String(url).trim() : null;
  })();
  const mboTrackingLink =
    trackingLink?.mboTrackingUrl && String(trackingLink.mboTrackingUrl).trim()
      ? String(trackingLink.mboTrackingUrl).trim()
      : sc?.mboTrackingUrl && String(sc.mboTrackingUrl).trim()
        ? String(sc.mboTrackingUrl).trim()
        : null;

  const rawPayloadId = stored?.rawPayloadId || entity.rawPayloads?.[0]?.id || null;
  const sourceEndpoint =
    entity.rawPayloads?.[0]?.resourceKey ||
    (entity.networkSource ? `${entity.networkSource}:${entityType}` : null);

  const country =
    Array.isArray(sc?.countryCodes) && sc.countryCodes.length
      ? sc.countryCodes
      : extractCountryCodesFromRaw(raw).length
        ? extractCountryCodesFromRaw(raw)
        : null;
  const currency = firstFilled(sc?.currencyCode, sc?.commissionCurrency);

  const isoDate = (value) => {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (value instanceof Date) return value.toISOString();
    if (typeof value?.toISOString === "function") return value.toISOString();
    return null;
  };

  const campaignDescription = firstFilled(
    sc?.campaignDescription,
    typeof raw.description === "string" ? raw.description : null,
    typeof raw.campaign_description === "string" ? raw.campaign_description : null,
    typeof raw.summary === "string" ? raw.summary : null,
  );
  // Normalize each candidate so a stored "[object Object]" / empty {} does not
  // block usable raw.terms.body / Partnerize locale terms.
  const termsAndConditions = firstFilled(
    normalizeTermsText(sc?.termsAndConditions),
    normalizeTermsText(sc?.normalizedPayload?.termsAndConditions),
    normalizeTermsText(raw.terms),
    normalizeTermsText(raw.termsAndConditions),
    normalizeTermsText(raw.terms_and_conditions),
    normalizeTermsText(raw.conditions),
  );
  const promotionDescription = firstFilled(
    sc?.promotionDescription,
    raw.promotion,
    raw.promotion_description,
    raw.promotional_text,
    raw.voucher?.title,
  );
  const primaryCategory = firstFilled(sc?.categoryName, sc?.merchantVertical);
  const secondaryCategory = firstFilled(
    sc?.secondaryCategory,
    extractSecondaryCategoryFromRaw(raw, primaryCategory),
    raw.sub_category,
    raw.subcategory,
    raw.vertical?.secondary,
    raw.subVertical,
  );
  const discountRaw = firstFilled(
    sc?.discountPercent,
    raw.discount_percent,
    raw.discountPercent,
    raw.voucher?.discount,
    coupon?.discountPercent,
  );
  const discountPercent =
    discountRaw == null || discountRaw === ""
      ? null
      : Number.isFinite(Number(discountRaw))
        ? Number(discountRaw)
        : null;
  const startDate = isoDate(
    firstFilled(
      sc?.campaignStartDate,
      extractCampaignStartDateFromRaw(raw, entity),
    ),
  );
  const endDate = isoDate(
    firstFilled(
      sc?.campaignEndDate,
      sc?.normalizedPayload?.campaignEndDate,
      extractCampaignEndDateFromRaw(raw),
    ),
  );

  return {
    networkAccount: stored?.sourceAccountLabel ?? sc?.sourceAccountLabel ?? null,
    campaignSourceId: cs?.id ?? null,
    supplierCampaignExtId: stored?.supplierCampaignId ?? sc?.supplierCampaignId ?? null,
    networkCampaignId: stored?.supplierCampaignId ?? sc?.supplierCampaignId ?? null,
    rawPayloadId,
    category: primaryCategory,
    secondaryCategory: secondaryCategory ? String(secondaryCategory) : null,
    country,
    currency: currency ? String(currency).toUpperCase().slice(0, 3) : null,
    campaignType: campaignTypeOnly,
    commercialType: commercialTypeOnly ? String(commercialTypeOnly) : null,
    channelType,
    relationshipStatus,
    campaignStatus,
    certificationStatus,
    certificationMappingStatus,
    mappingStatus: statuses?.mappingStatus ?? certificationMappingStatus ?? null,
    mboReady,
    isAssignable,
    commission: commissionValue,
    commissionType: commissionUnit,
    commissionRate: commissionValue,
    commissionDisplay,
    commissionRuleCount,
    commissionCurrency: firstFilled(sc?.commissionCurrency, currency),
    assets: {
      link: linkSupport,
      coupon: couponSupport,
      deeplink: deeplinkSupport,
      feed: feedSupport,
    },
    linkSupport,
    couponSupport,
    deeplinkSupport,
    feedSupport,
    networkTrackingLink,
    mboTrackingLink,
    trackingLinkId: trackingLink?.id ?? null,
    networkClickId: null,
    mboClickId: null,
    subId1: trackingLink?.subId ?? null,
    subId2: null,
    subId3: null,
    brandWebsite: merchant?.website
      ? String(merchant.website).trim() || null
      : sc?.destinationUrl && String(sc.destinationUrl).trim()
        ? String(sc.destinationUrl).trim()
        : null,
    campaignDescription: campaignDescription ? String(campaignDescription) : null,
    termsAndConditions: termsAndConditions || null,
    promotionDescription: promotionDescription ? String(promotionDescription) : null,
    discountPercent,
    startDate,
    endDate,
    lastSyncedAt: stored?.lastSyncedAt?.toISOString?.() ?? stored?.lastSyncedAt ?? sc?.lastSyncedAt ?? null,
    couponCount,
    sourceEndpoint,
    openMapperErrorPresent: Boolean(openMapperError),
    operationalMappingStatus: statuses?.mappingStatus ?? null,
  };
}

function couponSnapshotFromEntity(entity, coupon = null) {
  const raw = entity?.rawData && typeof entity.rawData === "object" ? entity.rawData : {};
  return {
    campaignName: firstFilled(
      entity?.campaignName,
      entity?.entityName,
      raw.campaign_name,
      raw.campaignName,
      raw.title,
    ),
    merchantNameRaw: firstFilled(
      entity?.advertiserName,
      raw.advertiser_name,
      raw.advertiserName,
      typeof raw.advertiser === "string" ? raw.advertiser : raw.advertiser?.name,
      raw.merchant_name,
      raw.companyName,
      raw.brand_name,
    ),
    categoryName: firstFilled(raw.category_name, raw.categoryName, raw.category, raw.vertical),
    campaignType: firstFilled(entity?.entitySubType, coupon?.couponType, raw.type),
    countryCodes: extractCountryCodesFromRaw(raw),
    defaultCommissionValue: extractCommissionValueFromRaw(raw),
    trackingUrl: firstFilled(coupon?.couponLink, raw.deeplink, raw.deep_link, raw.link, raw.url),
    destinationUrl: firstFilled(raw.preview_url, raw.website, raw.url),
    campaignStatus: firstFilled(entity?.entityStatus, raw.status, coupon?.couponStatus),
  };
}

function formatAssetsLabel(assets) {
  if (!assets || typeof assets !== "object") return null;
  const parts = [];
  if (assets.link) parts.push("Link");
  if (assets.coupon) parts.push("Coupon");
  if (assets.deeplink) parts.push("Deeplink");
  if (assets.feed) parts.push("Feed");
  return parts.length ? parts.join(" · ") : null;
}

function pickOpenMapperError(mapperErrors = []) {
  return (
    mapperErrors.find((err) => err.status === "OPEN" || err.status === "RETRYING") ?? null
  );
}

function toListRow(entity) {
  const coupon = entity.supplierCoupons?.[0] ?? null;
  const supplierCampaign = entity.supplierCampaigns?.[0] ?? coupon?.supplierCampaign ?? null;
  const campaignSource = supplierCampaign?.campaignSources?.[0] ?? null;
  const merchant = supplierCampaign?.merchant ?? null;
  const openMapperError = pickOpenMapperError(entity.mapperErrors);
  const statuses = deriveImportedRecordStatuses({
    entityType: entity.entityType,
    supplierCampaign,
    campaignSource,
    openMapperError,
    coupon,
  });

  const raw = entity.rawData && typeof entity.rawData === "object" ? entity.rawData : {};
  const scSnapshot = resolveEntityCampaignSnapshot(entity, supplierCampaign);
  const extractedBrand = resolveExtractedBrand(entity, scSnapshot, merchant);
  const rawDestination = firstFilled(
    scSnapshot?.destinationUrl,
    raw.destination_url,
    raw.default_destination,
    raw.preview_url,
    raw.website,
  );
  const rawLogo = firstFilled(scSnapshot?.campaignLogoUrl, raw.campaign_logo, raw.logo_url, raw.logoUrl);

  const brand = projectBrandIdentity(
    merchant
      ? {
          id: merchant.id,
          displayName: merchant.displayName || extractedBrand || null,
          logoUrl: merchant.logoUrl,
          website: merchant.website,
        }
      : {
          id: null,
          displayName: extractedBrand || null,
          logoUrl: null,
          website: null,
        },
    scSnapshot || extractedBrand || rawDestination || rawLogo
      ? {
          merchantNameRaw: extractedBrand || scSnapshot?.merchantNameRaw || null,
          campaignLogoUrl: rawLogo,
          destinationUrl: rawDestination,
          trackingUrl: scSnapshot?.trackingUrl || null,
        }
      : null,
  );
  const brandLinks = brandIdentityToAdminLinks(brand);

  const network = buildNetworkCampaignFields({
    entity,
    supplierCampaign,
    campaignSource,
    merchant,
    statuses,
    openMapperError,
    coupon,
  });

  // Optional post-filter for exact mboReady when approximate DB filter used
  const row = {
    id: entity.id,
    network: displayNetwork(entity.networkSource),
    networkSource: entity.networkSource,
    networkAccount: network.networkAccount,
    recordType: recordTypeLabel(entity.entityType),
    entityType: entity.entityType,
    brand: brandLinks.brandName,
    brandLogoLink: brandLinks.brandLogoLink,
    brandWebsiteLink: brandLinks.brandWebsiteLink || network.brandWebsite,
    campaign:
      supplierCampaign?.campaignName ||
      entity.campaignName ||
      entity.entityName ||
      raw.campaign_name ||
      raw.campaignName ||
      raw.title ||
      null,
    sourceRecordId: entity.externalId,
    sourceStatus: statuses.sourceStatus,
    mappingStatus: statuses.mappingStatus,
    certificationStatus: network.certificationStatus,
    issue: statuses.issue,
    issueCode: statuses.issueCode,
    importedAt: entity.createdAt?.toISOString?.() ?? entity.createdAt,
    lastUpdated: entity.updatedAt?.toISOString?.() ?? entity.updatedAt,
    lastSyncedAt: network.lastSyncedAt,
    supplierCampaignId: supplierCampaign?.id ?? null,
    supplierCampaignExtId: network.supplierCampaignExtId,
    networkCampaignId: network.networkCampaignId,
    campaignSourceId: network.campaignSourceId || campaignSource?.id || null,
    canonicalCampaignId: campaignSource?.canonicalCampaignId ?? null,
    merchantId: merchant?.id ?? null,
    rawPayloadId: network.rawPayloadId,
    category: network.category,
    country: network.country,
    currency: network.currency,
    campaignType: network.campaignType,
    commercialType: network.commercialType,
    channelType: network.channelType,
    relationshipStatus: network.relationshipStatus,
    campaignStatus: network.campaignStatus,
    mboReady: network.mboReady,
    isAssignable: network.isAssignable,
    commission: network.commission,
    commissionType: network.commissionType,
    commissionDisplay: network.commissionDisplay,
    commissionCurrency: network.commissionCurrency,
    commissionRuleCount: network.commissionRuleCount,
    secondaryCategory: network.secondaryCategory,
    campaignDescription: network.campaignDescription,
    termsAndConditions: network.termsAndConditions,
    promotionDescription: network.promotionDescription,
    discountPercent: network.discountPercent,
    startDate: network.startDate,
    endDate: network.endDate,
    assets: network.assets,
    assetsLabel: formatAssetsLabel(network.assets),
    linkSupport: network.linkSupport,
    couponSupport: network.couponSupport,
    deeplinkSupport: network.deeplinkSupport,
    feedSupport: network.feedSupport,
    networkTrackingLink: network.networkTrackingLink,
    mboTrackingLink: network.mboTrackingLink,
    trackingLinkId: network.trackingLinkId,
    couponCount: network.couponCount,
    openMapperErrorId: openMapperError?.id ?? null,
    actions: availableActions({
      openMapperError,
      entityType: entity.entityType,
    }),
  };
  return row;
}

function toDetailDto(entity) {
  const row = toListRow(entity);
  const coupon = entity.supplierCoupons?.[0] ?? null;
  const supplierCampaign = entity.supplierCampaigns?.[0] ?? coupon?.supplierCampaign ?? null;
  const campaignSource = supplierCampaign?.campaignSources?.[0] ?? null;
  const merchant = supplierCampaign?.merchant ?? null;
  const openMapperError = pickOpenMapperError(entity.mapperErrors);
  const rawPayload = entity.rawPayloads?.[0] ?? null;
  const statuses = deriveImportedRecordStatuses({
    entityType: entity.entityType,
    supplierCampaign,
    campaignSource,
    openMapperError,
    coupon,
  });

  const pipeline = buildPipelineStages({
    entityType: entity.entityType,
    supplierCampaign,
    campaignSource,
    merchant,
    openMapperError,
    statuses,
  });

  const detected = pickDetectedFields(entity, supplierCampaign);
  const network = buildNetworkCampaignFields({
    entity,
    supplierCampaign,
    campaignSource,
    merchant,
    statuses,
    openMapperError,
    coupon,
  });

  return {
    ...row,
    source: {
      network: row.network,
      networkSource: entity.networkSource,
      networkAccount: network.networkAccount,
      recordType: row.recordType,
      sourceRecordId: entity.externalId,
      importedAt: row.importedAt,
      lastUpdated: row.lastUpdated,
      lastSyncedAt: network.lastSyncedAt,
      sourceEndpoint: network.sourceEndpoint,
      rawPayloadReference: rawPayload
        ? {
            id: rawPayload.id,
            resourceKey: rawPayload.resourceKey,
            fetchedAt: rawPayload.fetchedAt?.toISOString?.() ?? rawPayload.fetchedAt,
            processingStatus: rawPayload.processingStatus,
          }
        : network.rawPayloadId
          ? { id: network.rawPayloadId, resourceKey: null, fetchedAt: null, processingStatus: null }
          : null,
    },
    identity: {
      rawPayloadId: network.rawPayloadId,
      supplierCampaignId: network.supplierCampaignExtId,
      supplierCampaignRowId: supplierCampaign?.id ?? null,
      campaignSourceId: network.campaignSourceId,
      networkCampaignId: network.networkCampaignId,
      networkAccount: network.networkAccount,
      network: row.network,
    },
    brandDetail: {
      brand: row.brand,
      brandWebsite: network.brandWebsite || row.brandWebsiteLink,
      brandLogoLink: row.brandLogoLink,
      campaign: row.campaign,
    },
    tracking: {
      networkTrackingLink: network.networkTrackingLink,
      mboTrackingLink: network.mboTrackingLink,
      trackingLinkId: network.trackingLinkId,
      networkClickId: network.networkClickId,
      mboClickId: network.mboClickId,
      subId1: network.subId1,
      subId2: network.subId2,
      subId3: network.subId3,
      note: "networkTrackingLink and mboTrackingLink are independent — never substituted.",
    },
    campaignDetail: {
      category: network.category,
      secondaryCategory: network.secondaryCategory,
      country: network.country,
      currency: network.currency,
      campaignType: network.campaignType,
      commercialType: network.commercialType,
      channelType: network.channelType,
      relationshipStatus: network.relationshipStatus,
      campaignStatus: network.campaignStatus,
      campaignDescription: network.campaignDescription,
      termsAndConditions: network.termsAndConditions,
      promotionDescription: network.promotionDescription,
      discountPercent: network.discountPercent,
      startDate: network.startDate,
      endDate: network.endDate,
      isAssignable: network.isAssignable,
    },
    commercial: {
      commission: network.commission,
      commissionType: network.commissionType,
      commissionRate: network.commissionRate,
      commissionDisplay: network.commissionDisplay,
      commissionCurrency: network.commissionCurrency,
      commissionRuleCount: network.commissionRuleCount,
    },
    assetsDetail: network.assets,
    ingestion: {
      sourceStatus: statuses.sourceStatus,
      mappingStatus: statuses.mappingStatus,
      certificationStatus: network.certificationStatus,
      certificationMappingStatus: network.certificationMappingStatus,
      mboReady: network.mboReady,
      isAssignable: network.isAssignable,
      lastSyncedAt: network.lastSyncedAt,
      lastUpdated: row.lastUpdated,
      importedAt: row.importedAt,
      issue: statuses.issue,
      issueCode: statuses.issueCode,
      couponCount: network.couponCount,
    },
    detected,
    normalized: supplierCampaign
      ? {
          brand: merchant?.displayName || supplierCampaign.merchantNameRaw || null,
          merchantId: merchant?.id || null,
          supplierCampaignId: supplierCampaign.id,
          supplierCampaignExtId: supplierCampaign.supplierCampaignId,
          canonicalCampaignId: campaignSource?.canonicalCampaignId || null,
          campaignSourceId: campaignSource?.id || null,
          campaignName: supplierCampaign.campaignName,
          commission: {
            value: supplierCampaign.defaultCommissionValue?.toString?.() ?? null,
            unit: supplierCampaign.commissionUnit,
            currency: supplierCampaign.commissionCurrency,
          },
          // Network tracking only — never invent MBO URL here
          trackingUrl: supplierCampaign.trackingUrl,
          mboTrackingUrl: network.mboTrackingLink,
          coupon: coupon
            ? {
                id: coupon.id,
                code: coupon.couponCode,
                link: coupon.couponLink,
                status: coupon.couponStatus,
              }
            : null,
        }
      : { status: "Not yet linked" },
    mapping: {
      status: statuses.mappingStatus,
      sourceStatus: statuses.sourceStatus,
      certificationStatus: network.certificationStatus,
      mboReady: network.mboReady,
      reason: statuses.issue,
      issueCode: statuses.issueCode,
      mapperError: openMapperError
        ? {
            id: openMapperError.id,
            network: displayNetwork(entity.networkSource),
            record: row.campaign || entity.externalId,
            field: inferErrorField(openMapperError),
            error: openMapperError.message,
            errorCode: openMapperError.errorCode,
            severity: "Needs review",
            firstDetected: openMapperError.createdAt?.toISOString?.() ?? openMapperError.createdAt,
            lastDetected: openMapperError.createdAt?.toISOString?.() ?? openMapperError.createdAt,
            attempts: openMapperError.attempts,
            status: openMapperError.status,
          }
        : null,
    },
    pipeline,
    sourceData: stripSensitivePayload(entity.rawData),
    actions: availableActions({
      openMapperError,
      entityType: entity.entityType,
    }),
  };
}

function inferErrorField(error) {
  const msg = String(error?.message || "").toLowerCase();
  if (msg.includes("merchantdescription") || msg.includes("campaign description")) {
    return "campaignDescription";
  }
  if (msg.includes("merchantvertical") || msg.includes("merchant vertical")) return "merchantVertical";
  if (msg.includes("missing_parent") || msg.includes("parent")) return "parentSupplierCampaignId";
  if (msg.includes("merchant")) return "merchantName";
  return null;
}

const CAMPAIGN_JOIN_INCLUDE = {
  merchant: true,
  mappingCertification: true,
  _count: { select: { coupons: true } },
  campaignSources: {
    where: { isActive: true },
    take: 1,
    orderBy: [{ isPrimary: "desc" }, { priority: "asc" }],
    include: {
      trackingLinks: {
        where: { deletedAt: null, status: { in: ["GENERATED", "ACTIVE"] } },
        take: 1,
        orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          mboTrackingUrl: true,
          supplierTrackingUrl: true,
          subId: true,
        },
      },
      _count: { select: { productFeeds: true } },
    },
  },
};

const ENTITY_LIST_INCLUDE = {
  supplierCampaigns: {
    take: 1,
    orderBy: { updatedAt: "desc" },
    include: CAMPAIGN_JOIN_INCLUDE,
  },
  supplierCoupons: {
    take: 1,
    orderBy: { updatedAt: "desc" },
    include: {
      supplierCampaign: { include: CAMPAIGN_JOIN_INCLUDE },
    },
  },
  mapperErrors: {
    where: { status: { in: ["OPEN", "RETRYING"] } },
    orderBy: { createdAt: "desc" },
    take: 3,
  },
};

const ENTITY_INCLUDE = {
  ...ENTITY_LIST_INCLUDE,
  rawPayloads: { take: 1, orderBy: { fetchedAt: "desc" } },
};

const COUNT_CACHE_TTL_MS = 5 * 60 * 1000;
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const countCache = new Map();
const listCache = new Map();

function countCacheKey(where) {
  return JSON.stringify(where);
}

function listCacheKey(filters, page, pageSize) {
  return JSON.stringify({ filters, page, pageSize });
}

export function invalidateImportedRecordsListCache() {
  listCache.clear();
  countCache.clear();
}

async function cachedEntityCount(db, where) {
  const key = countCacheKey(where);
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < COUNT_CACHE_TTL_MS) {
    return hit.total;
  }
  const total = await db.entity.count({ where });
  countCache.set(key, { total, at: Date.now() });
  return total;
}

export class ImportedRecordsService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.promotionJob = deps.promotionJob ?? new PromotionJob();
    this.normalization = deps.normalization ?? new CampaignNormalizationService();
  }

  async list(filters = {}) {
    const { page, pageSize, skip } = parsePage(filters);
    const cacheKey = listCacheKey(filters, page, pageSize);
    const cached = listCache.get(cacheKey);
    if (cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) {
      return cached.data;
    }

    const where = buildWhere(filters);
    const exactMboReady =
      filters.mboReady === "true" ||
      filters.mboReady === true ||
      filters.mboReady === "false" ||
      filters.mboReady === false;
    const exactAssignable =
      filters.isAssignable === "true" ||
      filters.isAssignable === true ||
      filters.isAssignable === "false" ||
      filters.isAssignable === false;
    const exactBoolFilter = exactMboReady || exactAssignable;

    // When exact boolean filters are set, over-fetch then apply derived flags (CSV / v15).
    const take = exactBoolFilter ? Math.min(500, Math.max(pageSize * 5, 100)) : pageSize;
    const querySkip = exactBoolFilter ? 0 : skip;

    const [totalRaw, rowsRaw] = await Promise.all([
      cachedEntityCount(this.db, where),
      this.db.entity.findMany({
        where,
        include: ENTITY_LIST_INCLUDE,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip: querySkip,
        take,
      }),
    ]);

    let mapped = rowsRaw.map(toListRow);
    if (exactMboReady) {
      const want = filters.mboReady === "true" || filters.mboReady === true;
      mapped = mapped.filter((r) => Boolean(r.mboReady) === want);
    }
    if (exactAssignable) {
      const want = filters.isAssignable === "true" || filters.isAssignable === true;
      mapped = mapped.filter((r) => Boolean(r.isAssignable) === want);
    }
    if (exactBoolFilter) {
      const total = mapped.length;
      const pageRows = mapped.slice(skip, skip + pageSize);
      const result = {
        rows: pageRows,
        total,
        page,
        pageSize,
        hasMore: skip + pageRows.length < total,
        supportedRecordTypes: SUPPORTED_RECORD_TYPES,
        note: exactAssignable
          ? "isAssignable filter uses CSV rule: ACTIVE + JOINED/APPROVED + channel + commission."
          : "mboReady filter uses deriveMboReady (not inventable).",
      };
      listCache.set(cacheKey, { data: result, at: Date.now() });
      return result;
    }

    const result = {
      rows: mapped,
      total: totalRaw,
      page,
      pageSize,
      hasMore: skip + mapped.length < totalRaw,
      supportedRecordTypes: SUPPORTED_RECORD_TYPES,
    };
    listCache.set(cacheKey, { data: result, at: Date.now() });
    return result;
  }

  async getById(id) {
    const entity = await this.db.entity.findUnique({
      where: { id },
      include: ENTITY_INCLUDE,
    });
    if (!entity) throw fail("Imported record not found.", 404);
    return toDetailDto(entity);
  }

  async summary(filters = {}) {
    const baseWhere = buildWhere({
      networkSource: filters.networkSource,
      recordType: filters.recordType,
      fromDate: filters.fromDate,
      toDate: filters.toDate,
    });

    const [
      importedRecords,
      openErrors,
      promotedCampaigns,
      linkedCampaigns,
      campaignImported,
      types,
      byNetwork,
    ] = await Promise.all([
      this.db.entity.count({ where: baseWhere }),
      this.db.mapperError.count({
        where: {
          status: "OPEN",
          ...(filters.networkSource
            ? {
                entity: buildWhere({ networkSource: filters.networkSource }),
              }
            : {}),
        },
      }),
      this.db.supplierCampaign.count(),
      this.db.campaignSource.count({ where: { isActive: true } }),
      this.db.entity.count({
        where: { ...baseWhere, entityType: "campaign" },
      }),
      this.db.entity.groupBy({
        by: ["entityType"],
        where: baseWhere,
        _count: true,
      }),
      this.db.entity.groupBy({
        by: ["networkSource", "entityType"],
        where: { entityType: "campaign" },
        _count: true,
      }),
    ]);

    const needsReview = await this.db.entity.count({
      where: buildWhere({
        ...filters,
        preset: "needs_review",
      }),
    });

    const networkMetrics = {};
    for (const row of byNetwork) {
      const label = displayNetwork(row.networkSource) || row.networkSource;
      if (!networkMetrics[label]) {
        networkMetrics[label] = {
          network: label,
          networkSource: row.networkSource,
          importedCampaigns: 0,
          linkedCampaigns: null,
        };
      }
      networkMetrics[label].importedCampaigns += row._count;
    }

    // Linked counts per supplier from CampaignSource → SupplierCampaign
    const linkedBySupplier = await this.db.campaignSource.groupBy({
      by: ["supplierCampaignId"],
      where: { isActive: true },
    });
    const supplierIds = linkedBySupplier.map((r) => r.supplierCampaignId);
    if (supplierIds.length) {
      const linkedCampaignsRows = await this.db.supplierCampaign.findMany({
        where: { id: { in: supplierIds } },
        select: { id: true, supplier: true, supplierRegion: true },
      });
      const linkedCounts = {};
      for (const sc of linkedCampaignsRows) {
        const label =
          sc.supplier === "OPTIMISE"
            ? "Optimise"
            : sc.supplier === "TRACKIER"
              ? "Trackier"
              : sc.supplier === "BOOSTINY"
                ? "Boostiny"
                : sc.supplier;
        linkedCounts[label] = (linkedCounts[label] || 0) + 1;
      }
      for (const [label, metric] of Object.entries(networkMetrics)) {
        metric.linkedCampaigns = linkedCounts[label] ?? 0;
        metric.needsReview =
          metric.importedCampaigns != null && metric.linkedCampaigns != null
            ? Math.max(0, metric.importedCampaigns - metric.linkedCampaigns)
            : null;
      }
    } else {
      for (const metric of Object.values(networkMetrics)) {
        metric.linkedCampaigns = 0;
        metric.needsReview = metric.importedCampaigns;
      }
    }

    return {
      importedRecords,
      normalizedCampaigns: linkedCampaigns,
      promotedSupplierCampaigns: promotedCampaigns,
      needsReview,
      mappingErrors: openErrors,
      importedCampaigns: campaignImported,
      linkedCampaigns,
      unlinkedCampaigns:
        campaignImported != null && linkedCampaigns != null
          ? Math.max(0, campaignImported - linkedCampaigns)
          : null,
      recordTypeCounts: Object.fromEntries(
        types.map((t) => [t.entityType, t._count]),
      ),
      byNetwork: Object.values(networkMetrics),
      supportedRecordTypes: SUPPORTED_RECORD_TYPES,
    };
  }

  async reprocess({ entityIds, networkSource } = {}) {
    if (!entityIds?.length && !networkSource) {
      throw fail("entityIds or networkSource is required for reprocess.", 400);
    }
    invalidateImportedRecordsListCache();
    return this.promotionJob.run({
      entityIds,
      networkSource,
      entityTypes: ["campaign", "coupon"],
    });
  }
}

/** Test/helpers — Network Campaign field projection for imported campaign entities. */
export {
  buildNetworkCampaignFields,
  toListRow,
  toDetailDto,
  formatAssetsLabel,
};
