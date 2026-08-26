import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { PERMISSIONS } from "../../auth/permissions.js";
import {
  toAdminCampaignDetailDto,
  toAdminCampaignListDto,
  toAdminOrderDto,
  toAdminPerformanceDto,
  toAdminProductFeedDto,
  toAdminPaymentStatusDto,
  formatAdminCommissionRuleType,
  V15_CLIENT_RULE_TYPES,
} from "./adminContract.dto.js";
import {
  parseExactDiscountPercent,
  mapCampaignType,
  mapCanonicalPaymentStatus,
  isoDate,
} from "./v15FieldContract.js";
import {
  summarizeConversionsForBucket,
  sumDistinctOrderValues,
  resolveNetSupplierCommission,
  paymentLinkClicksPolicy,
  classifyConversionChannel,
} from "./v15PerformanceGrain.js";

function toV13OrderCampaignType({ conversion = null, order = null, couponCode = null, hasLinkHint = false } = {}) {
  const classified = classifyConversionChannel({
    clickId: order?.clickId || conversion?.clickId || null,
    trackingLinkId: conversion?.trackingLinkId || order?.click?.trackingLinkId || null,
    metadata: {
      ...(conversion?.metadata && typeof conversion.metadata === "object" ? conversion.metadata : {}),
      ...(couponCode ? { couponCode } : {}),
    },
  });
  const hasCoupon = classified === "Coupon" || classified === "Link + Coupon" || Boolean(couponCode);
  const hasLink =
    classified === "Link" || classified === "Link + Coupon" || hasLinkHint;
  // v13 workbook sample naming: "Coupon + Link"
  if (hasCoupon && hasLink) return "Coupon + Link";
  if (hasCoupon) return "Coupon";
  if (hasLink) return "Link";
  return null;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * v13 client_share_percentage / mbo_share_percentage — never invent 70/30.
 * Prefer ClientCommissionRule ratio; else conversion split; else client.clientSharePercent.
 */
function resolveOrderSharePercents({ rule = null, conversion = null, clientSharePercent = null } = {}) {
  const ruleGross = numOrNull(rule?.grossCommission);
  const ruleClient = numOrNull(rule?.clientCommission);
  const ruleMbo = numOrNull(rule?.mboCommission);
  if (ruleGross != null && ruleGross > 0 && ruleClient != null) {
    const clientPct = Number(((ruleClient / ruleGross) * 100).toFixed(2));
    const mboPct =
      ruleMbo != null
        ? Number(((ruleMbo / ruleGross) * 100).toFixed(2))
        : Number((100 - clientPct).toFixed(2));
    return { clientSharePercent: clientPct, mboSharePercent: mboPct };
  }

  const supplier = numOrNull(conversion?.approvedCommission) ?? numOrNull(conversion?.supplierCommission);
  const client = numOrNull(conversion?.clientCommission);
  const mbo = numOrNull(conversion?.mboCommission);
  if (supplier != null && supplier > 0 && client != null) {
    const clientPct = Number(((client / supplier) * 100).toFixed(2));
    const mboPct =
      mbo != null
        ? Number(((mbo / supplier) * 100).toFixed(2))
        : Number((100 - clientPct).toFixed(2));
    return { clientSharePercent: clientPct, mboSharePercent: mboPct };
  }

  const clientDefault = numOrNull(clientSharePercent);
  if (clientDefault != null) {
    return {
      clientSharePercent: clientDefault,
      mboSharePercent: Number((100 - clientDefault).toFixed(2)),
    };
  }

  return { clientSharePercent: null, mboSharePercent: null };
}

/**
 * Epic 7 — staff admin contracts. Reuses existing domain tables; no second campaign domain.
 */
export class AdminContractService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  canViewFinancial(permissions = []) {
    const set = new Set(permissions || []);
    return set.has(PERMISSIONS.FINANCE_OPS_READ) || set.has(PERMISSIONS.COMMISSION_READ);
  }

  async listCampaigns({
    q = null,
    status = null,
    catalogStatus = null,
    campaignStatus = null,
    networkSource = null,
    relationshipStatus = null,
    campaignType = null,
    country = null,
    isAssignable = null,
    linkSupport = null,
    couponSupport = null,
    deeplinkSupport = null,
    mappingStatus = null,
    ids = null,
    skip = 0,
    take = 25,
  } = {}) {
    const where = { deletedAt: null };
    if (Array.isArray(ids) && ids.length) {
      where.id = { in: ids };
    }
    const resolvedCatalogStatus = catalogStatus || status;
    if (resolvedCatalogStatus) where.status = resolvedCatalogStatus;

    if (q) {
      const term = String(q);
      where.OR = [
        { displayName: { contains: term, mode: "insensitive" } },
        { category: { contains: term, mode: "insensitive" } },
        { merchant: { displayName: { contains: term, mode: "insensitive" } } },
        {
          sources: {
            some: {
              supplierCampaign: {
                OR: [
                  { campaignName: { contains: term, mode: "insensitive" } },
                  { merchantNameRaw: { contains: term, mode: "insensitive" } },
                ],
              },
            },
          },
        },
      ];
    }

    const sourceSome = {};
    if (networkSource) {
      sourceSome.supplierCampaign = {
        ...(sourceSome.supplierCampaign || {}),
        supplier: String(networkSource).toUpperCase(),
      };
    }
    if (campaignStatus) {
      const rawStatus = String(campaignStatus).toUpperCase();
      const statusIn =
        rawStatus === "EXPIRED"
          ? ["RETIRED"]
          : rawStatus === "INACTIVE"
            ? ["PAUSED", "RETIRED"]
            : [rawStatus];
      sourceSome.supplierCampaign = {
        ...(sourceSome.supplierCampaign || {}),
        campaignStatus: { in: statusIn },
      };
    }
    if (campaignType) {
      const type = String(campaignType).toUpperCase();
      sourceSome.supplierCampaign = {
        ...(sourceSome.supplierCampaign || {}),
        OR: [{ campaignType: { contains: type, mode: "insensitive" } }, { pricingModel: type }],
      };
    }
    if (relationshipStatus) {
      const rel = String(relationshipStatus).toUpperCase();
      // Workbook vocabulary ↔ DB CampaignSourceRelationshipStatus
      // JOINED | NOT_JOINED | PENDING | UNKNOWN (no APPROVED/REJECTED/SUSPENDED columns yet)
      if (rel === "NOT_APPLIED" || rel === "NOT_JOINED") {
        sourceSome.relationshipStatus = "NOT_JOINED";
      } else if (rel === "APPROVED" || rel === "JOINED") {
        sourceSome.relationshipStatus = "JOINED";
      } else if (rel === "PENDING" || rel === "REQUIRES_APPROVAL") {
        sourceSome.relationshipStatus = "PENDING";
      } else if (rel === "REJECTED" || rel === "SUSPENDED") {
        // Schema gap: stored as NOT_JOINED until enum expanded
        sourceSome.relationshipStatus = "NOT_JOINED";
      } else if (rel === "UNKNOWN" || rel === "NEEDS_REVIEW") {
        sourceSome.relationshipStatus = "UNKNOWN";
      } else {
        sourceSome.relationshipStatus = rel;
      }
    }
    if (country) {
      const code = String(country).toUpperCase();
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { countries: { has: code } },
            { sources: { some: { supplierCampaign: { countryCodes: { has: code } } } } },
          ],
        },
      ];
    }
    if (linkSupport === true || linkSupport === "true") sourceSome.supportsLink = true;
    if (couponSupport === true || couponSupport === "true") sourceSome.supportsCoupon = true;
    if (deeplinkSupport === true || deeplinkSupport === "true") {
      sourceSome.OR = [
        { channelSupport: { has: "DEEPLINK" } },
        { supplierCampaign: { ...(sourceSome.supplierCampaign || {}), deepLinkingEnabled: true } },
      ];
    }
    if (mappingStatus === "ERROR") {
      sourceSome.supplierCampaign = {
        ...(sourceSome.supplierCampaign || {}),
        syncConflict: true,
      };
    } else if (mappingStatus === "NEEDS_REVIEW") {
      sourceSome.supplierCampaign = {
        ...(sourceSome.supplierCampaign || {}),
        syncConflict: false,
      };
    }

    // Assignability: approximate at SQL (JOINED + ACTIVE + channel); DTO refine below.
    const assignableFlag =
      isAssignable === true || isAssignable === "true"
        ? true
        : isAssignable === false || isAssignable === "false"
          ? false
          : null;
    if (assignableFlag === true) {
      sourceSome.isActive = true;
      sourceSome.relationshipStatus = "JOINED";
      sourceSome.supplierCampaign = {
        ...(sourceSome.supplierCampaign || {}),
        campaignStatus: "ACTIVE",
      };
      sourceSome.AND = [
        ...(sourceSome.AND || []),
        {
          OR: [
            { supportsLink: true },
            { supportsCoupon: true },
            { channelSupport: { has: "DEEPLINK" } },
            { supplierCampaign: { trackingUrl: { not: null } } },
          ],
        },
        {
          OR: [
            { grossCommission: { not: null } },
            { supplierCommissionRules: { some: {} } },
            { supplierCampaign: { defaultCommissionValue: { not: null } } },
          ],
        },
      ];
    }

    if (Object.keys(sourceSome).length) {
      where.sources = { some: sourceSome };
    }

    const supplierCampaignSelect = {
      id: true,
      supplier: true,
      sourceAccountLabel: true,
      supplierCampaignId: true,
      campaignName: true,
      campaignDescription: true,
      campaignLogoUrl: true,
      merchantNameRaw: true,
      merchantId: true,
      categoryName: true,
      campaignType: true,
      pricingModel: true,
      defaultCommissionValue: true,
      commissionUnit: true,
      trackingUrl: true,
      destinationUrl: true,
      deepLinkingEnabled: true,
      campaignStatus: true,
      participationStatus: true,
      isJoined: true,
      countryCodes: true,
      currencyCode: true,
      campaignStartDate: true,
      lastSyncedAt: true,
      rawPayloadId: true,
      syncConflict: true,
      mapperVersion: true,
      mappingCertification: {
        select: { status: true, certifiedAt: true, checklist: true },
      },
    };

    const [rows, total] = await Promise.all([
      this.db.canonicalCampaign.findMany({
        where,
        include: {
          merchant: {
            select: { id: true, displayName: true, website: true, logoUrl: true, category: true },
          },
          sources: {
            // Prefer active; still return inactive so unlinked-looking rows can resolve network facts.
            include: {
              supplierCampaign: { select: supplierCampaignSelect },
              _count: { select: { supplierCommissionRules: true } },
            },
            orderBy: [{ isActive: "desc" }, { isPrimary: "desc" }, { priority: "asc" }],
            take: 8,
          },
          _count: {
            select: { assignments: true },
          },
        },
        orderBy: { updatedAt: "desc" },
        skip,
        take,
      }),
      this.db.canonicalCampaign.count({ where }),
    ]);

    const campaignIds = rows.map((r) => r.id);
    const sourceIds = rows.flatMap((r) => (r.sources || []).map((s) => s.id));
    const supplierCampaignIds = rows
      .flatMap((r) => (r.sources || []).map((s) => s.supplierCampaignId || s.supplierCampaign?.id))
      .filter(Boolean);

    const [orderCounts, conversionCounts, feedCounts, exceptionCounts, coupons] = await Promise.all([
      campaignIds.length
        ? this.db.order.groupBy({
            by: ["canonicalCampaignId"],
            where: { canonicalCampaignId: { in: campaignIds } },
            _count: { _all: true },
          })
        : [],
      sourceIds.length
        ? this.db.conversion.groupBy({
            by: ["campaignSourceId"],
            where: { campaignSourceId: { in: sourceIds } },
            _count: { _all: true },
          })
        : [],
      sourceIds.length
        ? this.db.productFeed.groupBy({
            by: ["campaignSourceId"],
            where: { campaignSourceId: { in: sourceIds } },
            _count: { _all: true },
          })
        : [],
      this.db.exceptionCase.count({
        where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      }),
      supplierCampaignIds.length
        ? this.db.supplierCoupon.findMany({
            where: { supplierCampaignId: { in: supplierCampaignIds } },
            select: {
              supplierCampaignId: true,
              discountValue: true,
              couponCode: true,
              couponEndDate: true,
              couponStatus: true,
            },
            take: 500,
          })
        : [],
    ]);

    const ordersByCampaign = new Map(orderCounts.map((r) => [r.canonicalCampaignId, r._count._all]));
    const convBySource = new Map(conversionCounts.map((r) => [r.campaignSourceId, r._count._all]));
    const feedBySource = new Map(feedCounts.map((r) => [r.campaignSourceId, r._count._all]));
    const discountBySupplierCampaign = new Map();
    const couponBySupplierCampaign = new Map();
    for (const c of coupons) {
      if (!couponBySupplierCampaign.has(c.supplierCampaignId) && (c.couponCode || c.couponEndDate)) {
        couponBySupplierCampaign.set(c.supplierCampaignId, {
          couponCode: c.couponCode || null,
          couponExpiry: isoDate(c.couponEndDate),
          couponStatus: c.couponStatus || null,
        });
      }
      if (discountBySupplierCampaign.has(c.supplierCampaignId)) continue;
      const pct = parseExactDiscountPercent(c.discountValue);
      if (pct != null) discountBySupplierCampaign.set(c.supplierCampaignId, pct);
    }

    let items = rows.map((row) => {
      const sources = row.sources || [];
      const active = sources.filter((s) => s.isActive !== false);
      const pool = active.length ? active : sources;
      const primary = pool.find((s) => s.isPrimary) || pool[0] || null;
      const warnings = [];
      if (!primary) warnings.push("NO_ACTIVE_SOURCE");
      if (primary && primary.relationshipStatus && primary.relationshipStatus !== "JOINED") {
        warnings.push("SOURCE_NOT_JOINED");
      }
      const feedCount = primary ? feedBySource.get(primary.id) || 0 : 0;
      const convCount = sources.reduce((s, src) => s + (convBySource.get(src.id) || 0), 0);
      const ruleCount = primary?._count?.supplierCommissionRules ?? 0;
      const scId = primary?.supplierCampaignId || primary?.supplierCampaign?.id;
      const coupon = scId != null ? couponBySupplierCampaign.get(scId) || null : null;
      return toAdminCampaignListDto({
        ...row,
        primarySource: primary,
        commissionRuleCount: ruleCount,
        discountPercent: scId != null ? discountBySupplierCampaign.get(scId) ?? null : null,
        couponCode: coupon?.couponCode ?? null,
        couponExpiry: coupon?.couponExpiry ?? null,
        productFeedAvailability: feedCount > 0 ? "AVAILABLE" : "NOT_CONFIGURED",
        assignmentCount: row._count?.assignments ?? 0,
        conversionCount: convCount,
        orderCount: ordersByCampaign.get(row.id) || 0,
        openExceptionCount: 0,
        operationalWarnings: warnings,
      });
    });

    // Refine assignability filter after DTO (SQL is approximate).
    if (assignableFlag === true) {
      items = items.filter((i) => i.isAssignable === true);
    } else if (assignableFlag === false) {
      items = items.filter((i) => i.isAssignable === false);
    }

    return {
      items,
      total,
      skip,
      take,
      openExceptionsPlatform: exceptionCounts,
      contract: "v15-03G-admin-campaign-tab",
      unavailableFields: [
        "secondaryCategory",
        "campaignTermsAndCondition",
        "campaignPromotionDescription",
        "campaignEndDate",
      ],
    };
  }

  async getCampaign(id) {
    const row = await this.db.canonicalCampaign.findFirst({
      where: { id, deletedAt: null },
      include: {
        merchant: {
          select: { id: true, displayName: true, website: true, logoUrl: true, category: true },
        },
        sources: {
          include: {
            supplierCampaign: {
              select: {
                id: true,
                supplier: true,
                supplierCampaignId: true,
                campaignName: true,
                campaignDescription: true,
                campaignLogoUrl: true,
                merchantNameRaw: true,
                merchantId: true,
                categoryName: true,
                campaignType: true,
                pricingModel: true,
                defaultCommissionValue: true,
                commissionUnit: true,
                trackingUrl: true,
                destinationUrl: true,
                deepLinkingEnabled: true,
                campaignStatus: true,
                participationStatus: true,
                isJoined: true,
                countryCodes: true,
                currencyCode: true,
                campaignStartDate: true,
                lastSyncedAt: true,
                rawPayloadId: true,
                syncConflict: true,
                coupons: {
                  take: 8,
                  orderBy: { lastSyncedAt: "desc" },
                  select: {
                    couponCode: true,
                    couponLink: true,
                    couponDescription: true,
                    discountValue: true,
                    couponEndDate: true,
                    couponStatus: true,
                  },
                },
              },
            },
            _count: { select: { supplierCommissionRules: true } },
          },
          orderBy: [{ isPrimary: "desc" }, { priority: "asc" }],
        },
        assignments: {
          where: { status: { not: "REVOKED" } },
          take: 50,
          include: {
            client: { select: { id: true, name: true } },
            trackingLinks: {
              where: { status: { in: ["GENERATED", "ACTIVE"] } },
              select: { mboTrackingUrl: true, isPrimary: true, status: true },
              take: 3,
            },
          },
        },
      },
    });
    if (!row) throw fail("Campaign not found.", 404);

    const assignmentIds = row.assignments.map((a) => a.id);
    const sourceIds = row.sources.map((s) => s.id);

    const [trackingLinks, rules, feeds, supplierRules, openEx] = await Promise.all([
      assignmentIds.length
        ? this.db.trackingLink.count({
            where: { assignmentId: { in: assignmentIds }, status: { in: ["GENERATED", "ACTIVE"] } },
          })
        : 0,
      assignmentIds.length
        ? this.db.clientCommissionRule.findMany({
            where: { assignmentId: { in: assignmentIds } },
            orderBy: { effectiveFrom: "desc" },
            take: 20,
          })
        : [],
      sourceIds.length
        ? this.db.productFeed.findMany({
            where: { campaignSourceId: { in: sourceIds } },
            include: { _count: { select: { feedItems: true, products: true } } },
            take: 20,
          })
        : [],
      sourceIds.length
        ? this.db.supplierCommissionRule.findMany({
            where: { campaignSourceId: { in: sourceIds } },
            orderBy: { effectiveFrom: "desc" },
            take: 50,
          })
        : [],
      this.db.exceptionCase.count({
        where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      }),
    ]);

    const primary =
      (() => {
        const sources = row.sources || [];
        const active = sources.filter((s) => s.isActive !== false);
        const pool = active.length ? active : sources;
        return pool.find((s) => s.isPrimary) || pool[0] || null;
      })() || null;
    const assignments = row.assignments.map((a) => {
      const link =
        (a.trackingLinks || []).find((t) => t.isPrimary) || (a.trackingLinks || [])[0] || null;
      return { ...a, mboTrackingUrl: link?.mboTrackingUrl ?? null };
    });
    return toAdminCampaignDetailDto({
      ...row,
      assignments,
      primarySource: primary,
      commissionRuleCount: primary?._count?.supplierCommissionRules ?? supplierRules.length,
      supplierCommissionRules: supplierRules,
      tracking: { state: trackingLinks > 0 ? "CONFIGURED" : "NOT_CONFIGURED", primaryLinkCount: trackingLinks },
      commissionRules: rules,
      productFeedAvailability: feeds.length ? "AVAILABLE" : "NOT_CONFIGURED",
      productFeeds: feeds.map(toAdminProductFeedDto),
      assignmentCount: row.assignments.length,
      exceptions: { open: openEx, samples: [] },
      health: { sync: primary?.supplierCampaign?.lastSyncedAt ? "SYNCED" : "UNKNOWN" },
      operationalWarnings: !primary ? ["NO_ACTIVE_SOURCE"] : [],
    });
  }

  async listPerformance(
    {
      from = null,
      to = null,
      date = null,
      clientId = null,
      merchantId = null,
      brand = null,
      network = null,
      campaignId = null,
      country = null,
      currency = null,
      campaignType = null,
      status = null,
      q = null,
      grain = null,
      skip = 0,
      take = 50,
    } = {},
    permissions = [],
  ) {
    const includeFinancial = this.canViewFinancial(permissions);
    const grainNorm = String(grain || "").toLowerCase();
    // Network-grain staff performance uses NetworkPerformanceFact — never force through client DailyReport.
    if (grainNorm === "network" || grainNorm === "network_fact") {
      const { NetworkPortalService } = await import("../networkPortal/networkPortal.service.js");
      const portal = new NetworkPortalService({ prisma: this.db });
      const result = await portal.listNetworkPerformance({
        network,
        from,
        to,
        date,
        brand,
        campaignType,
        status,
        q,
        skip,
        take,
      });
      return {
        items: result.items,
        total: result.total,
        includeFinancial,
        contract: "v15-network-performance-fact",
        unavailableFields: [],
        grainNote:
          "Grain: NetworkPerformanceFact (network → MBO). networkClicks and mboLinkClicks are independent. Client DailyReport remains for client portal.",
        migrationRequired: false,
        kpis: result.kpis,
        grain: "network",
      };
    }
    const where = {};
    if (clientId) where.clientId = clientId;
    if (merchantId) where.merchantId = merchantId;
    if (campaignId) where.canonicalCampaignId = campaignId;
    if (country) where.country = String(country).toUpperCase().slice(0, 2);
    if (currency) where.currency = String(currency).toUpperCase().slice(0, 3);
    if (from || to) {
      where.reportDate = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }
    if (brand) {
      where.merchant = {
        displayName: { contains: String(brand).trim(), mode: "insensitive" },
      };
    }
    if (network) {
      const supplier = String(network).trim().toUpperCase();
      where.campaignSource = {
        supplierCampaign: { supplier },
      };
    }

    const [rows, total, aggregates] = await Promise.all([
      this.db.dailyReport.findMany({
        where,
        include: {
          client: { select: { name: true } },
          merchant: { select: { displayName: true } },
          canonicalCampaign: { select: { displayName: true } },
          campaignSource: {
            select: {
              id: true,
              supplierCampaign: { select: { supplier: true, campaignName: true } },
            },
          },
        },
        orderBy: { reportDate: "desc" },
        skip,
        take,
      }),
      this.db.dailyReport.count({ where }),
      this.db.dailyReport.aggregate({
        where,
        _sum: {
          clickCount: true,
          conversionCount: true,
          approvedConversionCount: true,
          grossCommission: true,
        },
      }),
    ]);

    // Read-only projection from Conversion/Order/FT onto DailyReport pages — does NOT mutate DailyReport.
    // Key includes clientId so multi-tenant rows for the same source+day do not share conversions.
    const sourceIds = [...new Set(rows.map((r) => r.campaignSourceId).filter(Boolean))];
    /** @type {Map<string, any[]>} */
    const convByKey = new Map();
    if (sourceIds.length && rows.length) {
      const dates = rows
        .map((r) => (r.reportDate instanceof Date ? r.reportDate : new Date(r.reportDate)))
        .filter((d) => !Number.isNaN(d.getTime()));
      if (dates.length) {
        const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
        const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
        maxDate.setUTCDate(maxDate.getUTCDate() + 1);
        const clientIds = [...new Set(rows.map((r) => r.clientId).filter(Boolean))];
        const conversions = await this.db.conversion.findMany({
          where: {
            campaignSourceId: { in: sourceIds },
            conversionDate: { gte: minDate, lt: maxDate },
            ...(clientIds.length
              ? { clientAssignment: { clientId: { in: clientIds } } }
              : {}),
          },
          select: {
            id: true,
            campaignSourceId: true,
            conversionDate: true,
            status: true,
            supplierCommission: true,
            approvedCommission: true,
            clickId: true,
            trackingLinkId: true,
            orderId: true,
            metadata: true,
            clientAssignment: { select: { clientId: true } },
          },
        });
        for (const c of conversions) {
          const day = c.conversionDate?.toISOString?.()?.slice(0, 10);
          const clientKey = c.clientAssignment?.clientId;
          if (!day || !c.campaignSourceId || !clientKey) continue;
          const key = `${clientKey}|${c.campaignSourceId}|${day}`;
          if (!convByKey.has(key)) convByKey.set(key, []);
          convByKey.get(key).push(c);
        }
      }
    }

    const allOrderIds = new Set();
    const allConversionIds = [];
    for (const list of convByKey.values()) {
      const summary = summarizeConversionsForBucket(list);
      for (const id of summary.orderIds) allOrderIds.add(id);
      for (const c of list) allConversionIds.push(c.id);
    }

    const [orders, ftRows] = await Promise.all([
      allOrderIds.size
        ? this.db.order.findMany({
            where: { id: { in: [...allOrderIds] } },
            select: { id: true, orderValue: true, validationStatus: true },
          })
        : Promise.resolve([]),
      allConversionIds.length
        ? this.db.financialTransaction.findMany({
            where: { conversionId: { in: allConversionIds } },
            select: {
              conversionId: true,
              supplierReceivable: true,
              transactionType: true,
            },
          })
        : Promise.resolve([]),
    ]);
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const ftByConversion = new Map();
    for (const ft of ftRows) {
      if (!ft.conversionId) continue;
      if (!ftByConversion.has(ft.conversionId)) ftByConversion.set(ft.conversionId, []);
      ftByConversion.get(ft.conversionId).push(ft);
    }

    const items = rows.map((r) => {
      const day = r.reportDate?.toISOString?.()?.slice(0, 10) ?? String(r.reportDate || "").slice(0, 10);
      const key =
        r.campaignSourceId && r.clientId ? `${r.clientId}|${r.campaignSourceId}|${day}` : null;
      const list = key ? convByKey.get(key) || [] : [];
      const summary = summarizeConversionsForBucket(list);
      const bucketOrders = summary.orderIds.map((id) => orderById.get(id)).filter(Boolean);
      const orderValues = sumDistinctOrderValues(bucketOrders);
      const bucketFts = list.flatMap((c) => ftByConversion.get(c.id) || []);
      const netResolved = resolveNetSupplierCommission({
        ftRows: bucketFts,
        conversionApprovedSum: summary.netCommission,
      });

      return toAdminPerformanceDto(
        {
          reportDate: day,
          clientId: r.clientId,
          clientName: r.client?.name ?? null,
          canonicalCampaignId: r.canonicalCampaignId,
          campaignSourceId: r.campaignSourceId,
          brandName: r.merchant?.displayName ?? null,
          campaignName: r.canonicalCampaign?.displayName ?? null,
          networkSource: r.campaignSource?.supplierCampaign?.supplier ?? null,
          country: r.country,
          currency: r.currency,
          clickCount: r.clickCount,
          conversionCount: r.conversionCount,
          approvedConversionCount: r.approvedConversionCount,
          grossCommission: r.grossCommission,
          clientCommission: r.clientCommission,
          mboCommission: r.mboCommission,
          netCommission: netResolved.netCommission,
          cancelOrders: list.length ? summary.cancelOrders : null,
          pendingOrders: list.length ? summary.pendingOrders : null,
          rejectedOrders: list.length ? summary.rejectedOrders : null,
          cancelledOrders: list.length ? summary.cancelledOrders : null,
          confirmedOrders: list.length ? summary.confirmedOrders : r.approvedConversionCount,
          channelType: summary.channelType,
          campaignType: summary.campaignType,
          clientCampaignType: summary.clientCampaignType,
          couponCode: summary.couponCode,
          grossOrderValue: orderValues.grossOrderValue,
          netOrderValue: orderValues.netOrderValue,
          customerType: null,
          financeSource: netResolved.source
            ? `daily_report+${netResolved.source}`
            : "daily_report",
        },
        { includeFinancial },
      );
    });

    const sum = aggregates?._sum || {};
    const hasRows = total > 0;
    const kpis = {
      linkClicks: hasRows ? Number(sum.clickCount ?? 0) : null,
      grossOrders: hasRows ? Number(sum.conversionCount ?? 0) : null,
      confirmedOrders: hasRows ? Number(sum.approvedConversionCount ?? 0) : null,
      cancelOrders: null, // not stored on DailyReport; page projection only
      grossCommission:
        includeFinancial && hasRows && sum.grossCommission != null
          ? Number(sum.grossCommission)
          : null,
      netCommission: null, // requires FT projection — not inventable as filter-wide sum here
      customerType: null,
    };

    return {
      items,
      total,
      includeFinancial,
      kpis,
      contract: "v15-04C-admin-performance",
      unavailableFields: [
        "customerType",
        "orderDate",
        "orderConfirmDate",
        "orderPaymentConfirmDate",
        "discountPercent",
        "channelType_when_mixed_in_bucket",
        "couponCode_when_mixed_in_bucket",
        "cancelOrders_filter_wide_kpi",
        "netCommission_filter_wide_kpi",
      ],
      grainNote:
        "DailyReport grain: client × campaign × source? × country? × day. Projection extras keyed by client|source|day. Mixed channel/coupon → null. 04E persisted grain NOT implemented.",
      migrationRequired: false,
    };
  }

  /**
   * Admin 05C payment-status — supplier receivable, grain includes brand + campaignSourceId.
   * Not withdrawals. Not client payable.
   */
  async listPaymentStatus({ billingMonth = null, billingYear = null, skip = 0, take = 50 } = {}) {
    const orders = await this.db.order.findMany({
      include: {
        merchant: { select: { displayName: true } },
        campaignSource: {
          select: {
            id: true,
            supportsLink: true,
            supportsCoupon: true,
            channelSupport: true,
            supplierCampaign: {
              select: {
                supplier: true,
                campaignType: true,
                pricingModel: true,
                trackingUrl: true,
              },
            },
          },
        },
        conversions: {
          select: {
            clickId: true,
            trackingLinkId: true,
            metadata: true,
            supplierCommission: true,
            approvedCommission: true,
          },
          take: 1,
          orderBy: { createdAt: "desc" },
        },
        financialTransactions: {
          select: {
            supplierReceivable: true,
            transactionType: true,
            effectiveAt: true,
          },
        },
      },
      orderBy: { orderDate: "desc" },
      take: 2000,
    });

    /** @type {Map<string, any>} */
    const buckets = new Map();

    for (const order of orders) {
      const anchor = order.orderDate || order.receivedAt || order.createdAt;
      if (!anchor) continue;
      const d = anchor instanceof Date ? anchor : new Date(anchor);
      if (Number.isNaN(d.getTime())) continue;
      const bm = d.getUTCMonth() + 1;
      const by = d.getUTCFullYear();
      if (billingMonth != null && bm !== Number(billingMonth)) continue;
      if (billingYear != null && by !== Number(billingYear)) continue;

      const paymentStatus = mapCanonicalPaymentStatus({
        supplierPaymentStatus: order.supplierPaymentStatus,
        clientPaymentStatus: order.clientPaymentStatus,
        validationStatus: order.validationStatus,
      });

      const brandName = order.merchant?.displayName ?? null;
      const campaignSourceId = order.campaignSourceId ?? null;
      const network = order.supplier || order.campaignSource?.supplierCampaign?.supplier || null;
      const conversion = order.conversions?.[0] || null;
      const meta =
        conversion?.metadata && typeof conversion.metadata === "object" ? conversion.metadata : {};
      const couponCode =
        meta.couponCode ||
        meta.coupon_code ||
        meta.attributionHints?.couponCode ||
        null;
      const hasLinkHint = Boolean(
        order.clickId ||
          order.campaignSource?.supportsLink ||
          (Array.isArray(order.campaignSource?.channelSupport) &&
            order.campaignSource.channelSupport.some((c) => /link|deeplink/i.test(String(c)))) ||
          order.campaignSource?.supplierCampaign?.trackingUrl,
      );
      // v13 Payment Status: Campaign Type (Coupon or Link) — not CPS/CPA commercial model.
      const campaignType =
        toV13OrderCampaignType({
          conversion,
          order,
          couponCode,
          hasLinkHint,
        }) || "Unknown";
      const currency = order.currency || "USD";
      const mapKey = `${by}|${bm}|${network || "_"}|${brandName || "_"}|${campaignSourceId || "_"}|${campaignType}|${currency}|${paymentStatus}`;

      if (!buckets.has(mapKey)) {
        buckets.set(mapKey, {
          billingMonth: bm,
          billingYear: by,
          brandName,
          campaignSourceId,
          campaignType,
          network,
          currency,
          paymentStatus,
          payableOrders: 0,
          payableCommission: 0,
          orderDate: null,
          orderConfirmDate: null,
          orderPaymentConfirmDate: null,
          date: `${by}-${String(bm).padStart(2, "0")}-01`,
        });
      }
      const b = buckets.get(mapKey);
      b.payableOrders += 1;
      let supplierAmt = 0;
      for (const ft of order.financialTransactions || []) {
        if (ft.transactionType === "REVERSAL") {
          supplierAmt -= Number(ft.supplierReceivable) || 0;
        } else {
          supplierAmt += Number(ft.supplierReceivable) || 0;
        }
      }
      b.payableCommission += supplierAmt;
      if (!b.orderDate || (order.orderDate && order.orderDate < b.orderDate)) {
        b.orderDate = order.orderDate;
      }
      if (order.validationChangedAt && order.validationStatus === "VALIDATION_APPROVED") {
        if (!b.orderConfirmDate || order.validationChangedAt > b.orderConfirmDate) {
          b.orderConfirmDate = order.validationChangedAt;
        }
      }
      if (order.supplierPaymentStatus === "PAYMENT_RECEIVED" && order.supplierPaymentChangedAt) {
        if (!b.orderPaymentConfirmDate || order.supplierPaymentChangedAt > b.orderPaymentConfirmDate) {
          b.orderPaymentConfirmDate = order.supplierPaymentChangedAt;
        }
      }
    }

    const all = [...buckets.values()].sort(
      (a, b) => b.billingYear - a.billingYear || b.billingMonth - a.billingMonth,
    );
    const items = all.slice(skip, skip + take).map((row) =>
      toAdminPaymentStatusDto({
        ...row,
        ...paymentLinkClicksPolicy(),
        payableCommissionSource: "financial_transaction.supplierReceivable",
        // EXTERNAL_DEPENDENCY: bank settlement evidence not ingested — never copy networkPayable.
        mboActuallyReceived: null,
        bankReference: null,
      }),
    );

    return {
      items,
      total: all.length,
      skip,
      take,
      contract: "v13-05A-admin-payment-status",
      unavailableFields: ["linkClicks"],
      note: "Admin payment-status uses supplierReceivable. Client /api/v1/client/payments remains client-payable. Withdrawals remain /portal/v1/payments.",
      grainNote:
        "Grain: billingMonth+billingYear+network+brandName+campaignSourceId+campaignType(Link|Coupon|Link + Coupon)+currency+paymentStatus. linkClicks=null — joining Click events onto paymentStatus buckets causes fan-out.",
      migrationRequired: false,
    };
  }

  async listOrders(
    {
      clientId = null,
      network = null,
      q = null,
      validationStatus = null,
      supplierPaymentStatus = null,
      confirmedOnly = false,
      paidOnly = false,
      from = null,
      to = null,
      skip = 0,
      take = 50,
    } = {},
    permissions = [],
  ) {
    const includeFinancial = this.canViewFinancial(permissions);
    const where = {};
    if (clientId) where.clientId = clientId;
    if (network) where.supplier = String(network).trim().toUpperCase();
    if (confirmedOnly) where.validationStatus = "VALIDATION_APPROVED";
    else if (validationStatus) where.validationStatus = String(validationStatus).toUpperCase();
    if (paidOnly) {
      where.supplierPaymentStatus = { in: ["PAYMENT_PAYABLE", "PAYMENT_RECEIVED", "PAYMENT_INVOICED"] };
    } else if (supplierPaymentStatus) {
      where.supplierPaymentStatus = String(supplierPaymentStatus).toUpperCase();
    }
    if (from || to) {
      const dateFilter = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to
          ? {
              lte: String(to).includes("T")
                ? new Date(to)
                : new Date(`${String(to).slice(0, 10)}T23:59:59.999Z`),
            }
          : {}),
      };
      where.OR = [
        { orderDate: dateFilter },
        { orderDate: null, validationChangedAt: dateFilter },
      ];
    }
    if (q) {
      const qOr = [
        { supplierOrderId: { contains: String(q), mode: "insensitive" } },
        { merchant: { displayName: { contains: String(q), mode: "insensitive" } } },
        { canonicalCampaign: { displayName: { contains: String(q), mode: "insensitive" } } },
      ];
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: qOr }];
        delete where.OR;
      } else {
        where.OR = qOr;
      }
    }

    const [rows, total] = await Promise.all([
      this.db.order.findMany({
        where,
        include: {
          client: { select: { id: true, name: true, clientSharePercent: true } },
          merchant: { select: { id: true, displayName: true } },
          canonicalCampaign: {
            select: {
              id: true,
              displayName: true,
              merchant: { select: { id: true, displayName: true } },
            },
          },
          campaignSource: {
            include: {
              supplierCampaign: {
                select: {
                  supplierCampaignId: true,
                  campaignName: true,
                  trackingUrl: true,
                  merchantNameRaw: true,
                  sourceAccountLabel: true,
                },
              },
            },
          },
          click: {
            select: {
              id: true,
              subId: true,
              trackingLinkId: true,
              trackingLink: {
                select: { id: true, mboTrackingUrl: true, supplierTrackingUrl: true },
              },
            },
          },
          conversions: {
            take: 1,
            orderBy: { conversionDate: "desc" },
            select: {
              subId: true,
              approvedDate: true,
              status: true,
              metadata: true,
              campaignSourceId: true,
              clientAssignmentId: true,
              clickId: true,
              trackingLinkId: true,
              supplierCommission: true,
              approvedCommission: true,
              clientCommission: true,
              mboCommission: true,
              currency: true,
              campaignSource: {
                include: {
                  supplierCampaign: {
                    select: {
                      supplierCampaignId: true,
                      campaignName: true,
                      trackingUrl: true,
                      merchantNameRaw: true,
                      sourceAccountLabel: true,
                    },
                  },
                  canonicalCampaign: {
                    select: {
                      id: true,
                      displayName: true,
                      merchant: { select: { displayName: true } },
                    },
                  },
                },
              },
              clientAssignment: {
                select: {
                  clientId: true,
                  client: { select: { id: true, name: true, clientSharePercent: true } },
                },
              },
              commissionRule: {
                select: {
                  id: true,
                  grossCommission: true,
                  clientCommission: true,
                  mboCommission: true,
                  commissionType: true,
                },
              },
            },
          },
          financialTransactions: includeFinancial
            ? {
                select: {
                  transactionType: true,
                  status: true,
                  clientPayable: true,
                  supplierReceivable: true,
                  mboMargin: true,
                },
              }
            : false,
          _count: { select: { exceptionCases: true } },
        },
        orderBy: { orderDate: "desc" },
        skip,
        take,
      }),
      this.db.order.count({ where }),
    ]);

    // Batch enrich brand/campaign/coupon from entity + coupon→supplierCampaign when FKs are thin.
    const entityIds = new Set();
    const couponCodes = new Set();
    const campaignExtBySupplier = new Map(); // supplier -> Set(extIds)

    const asMeta = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    for (const order of rows) {
      const meta = asMeta(order.metadata);
      const conv = order.conversions?.[0] || null;
      const convMeta = asMeta(conv?.metadata);
      const entityId = meta.entityId || convMeta.entityId;
      if (entityId) entityIds.add(String(entityId));
      const code = meta.couponCode || convMeta.couponCode || convMeta.attributionHints?.couponCode;
      if (code && String(code).trim()) couponCodes.add(String(code).trim());
      const extIds = [
        meta.supplierCampaignId,
        meta.publisherCampaignId,
        convMeta.supplierCampaignId,
        convMeta.publisherCampaignId,
      ]
        .filter(Boolean)
        .map(String);
      if (extIds.length && order.supplier) {
        if (!campaignExtBySupplier.has(order.supplier)) campaignExtBySupplier.set(order.supplier, new Set());
        for (const id of extIds) campaignExtBySupplier.get(order.supplier).add(id);
      }
    }

    const [entities, coupons, supplierCampaigns] = await Promise.all([
      entityIds.size && this.db.entity?.findMany
        ? this.db.entity.findMany({
            where: { id: { in: [...entityIds] } },
            select: { id: true, advertiserName: true, campaignName: true },
          })
        : Promise.resolve([]),
      couponCodes.size && this.db.supplierCoupon?.findMany
        ? this.db.supplierCoupon.findMany({
            where: {
              OR: [...couponCodes].map((code) => ({
                couponCode: { equals: code, mode: "insensitive" },
              })),
            },
            include: {
              supplierCampaign: {
                select: {
                  supplier: true,
                  supplierCampaignId: true,
                  campaignName: true,
                  merchantNameRaw: true,
                  trackingUrl: true,
                  sourceAccountLabel: true,
                  merchant: { select: { displayName: true } },
                },
              },
              couponAssignments: {
                where: { status: { in: ["ASSIGNED", "ACTIVE"] } },
                take: 5,
                include: {
                  assignment: {
                    select: {
                      id: true,
                      clientId: true,
                      status: true,
                      published: true,
                      client: { select: { id: true, name: true } },
                    },
                  },
                },
              },
            },
            // Prefer ACTIVE coupons with a link when resolving display/tracking.
            orderBy: { lastSyncedAt: "desc" },
            take: Math.min(couponCodes.size * 3, 100),
            // couponType/couponLink are scalar defaults on SupplierCoupon
          })
        : Promise.resolve([]),
      campaignExtBySupplier.size && this.db.supplierCampaign?.findMany
        ? this.db.supplierCampaign.findMany({
            where: {
              OR: [...campaignExtBySupplier.entries()].map(([supplier, ids]) => ({
                supplier,
                supplierCampaignId: { in: [...ids] },
              })),
            },
            select: {
              supplier: true,
              supplierCampaignId: true,
              campaignName: true,
              merchantNameRaw: true,
              trackingUrl: true,
              sourceAccountLabel: true,
              merchant: { select: { displayName: true } },
            },
            take: 200,
          })
        : Promise.resolve([]),
    ]);

    const entityById = new Map((entities || []).map((e) => [e.id, e]));
    const couponByCode = new Map();
    for (const c of coupons || []) {
      const key = String(c.couponCode || "").trim().toLowerCase();
      if (key && !couponByCode.has(key)) couponByCode.set(key, c);
    }
    const scBySupplierExt = new Map();
    for (const sc of supplierCampaigns || []) {
      scBySupplierExt.set(`${sc.supplier}::${sc.supplierCampaignId}`, sc);
    }

    const firstNonEmpty = (...vals) => {
      for (const v of vals) {
        if (v != null && String(v).trim() !== "") return typeof v === "string" ? v.trim() : v;
      }
      return null;
    };

    const items = rows.map((order) => {
      const fts = order.financialTransactions || [];
      let clientPayable = 0;
      let supplierReceivable = 0;
      let mboMargin = 0;
      let adjustmentCount = 0;
      let reversalCount = 0;
      for (const ft of fts) {
        clientPayable += Number(ft.clientPayable || 0);
        supplierReceivable += Number(ft.supplierReceivable || 0);
        mboMargin += Number(ft.mboMargin || 0);
        if (ft.transactionType === "ADJUSTMENT") adjustmentCount += 1;
        if (ft.transactionType === "REVERSAL") reversalCount += 1;
      }
      const orderItems = order.items || [];
      const itemValidationSummary = orderItems.length
        ? {
            total: orderItems.length,
            approved: orderItems.filter((i) => i.validationStatus === "VALIDATION_APPROVED").length,
            rejected: orderItems.filter((i) => i.validationStatus === "VALIDATION_REJECTED").length,
            pending: orderItems.filter((i) => i.validationStatus === "VALIDATION_PENDING").length,
            needsReview: orderItems.filter((i) => i.validationStatus === "VALIDATION_NEEDS_REVIEW").length,
            unknown: orderItems.filter((i) => i.validationStatus == null).length,
          }
        : { total: 0, approved: 0, rejected: 0, pending: 0, needsReview: 0, unknown: 0 };

      const meta = asMeta(order.metadata);
      const conv = order.conversions?.[0] || null;
      const convMeta = asMeta(conv?.metadata);
      const hints = asMeta(convMeta.attributionHints);
      const entity = entityById.get(String(meta.entityId || convMeta.entityId || "")) || null;
      const couponCode = firstNonEmpty(
        meta.couponCode,
        convMeta.couponCode,
        hints.couponCode,
        order.couponCode,
      );
      const couponRow = couponCode ? couponByCode.get(String(couponCode).toLowerCase()) : null;
      const scFromCoupon = couponRow?.supplierCampaign || null;
      const scFromExt =
        scBySupplierExt.get(`${order.supplier}::${meta.supplierCampaignId || ""}`) ||
        scBySupplierExt.get(`${order.supplier}::${meta.publisherCampaignId || ""}`) ||
        scBySupplierExt.get(`${order.supplier}::${convMeta.supplierCampaignId || ""}`) ||
        scBySupplierExt.get(`${order.supplier}::${convMeta.publisherCampaignId || ""}`) ||
        null;
      const sc =
        order.campaignSource?.supplierCampaign ||
        conv?.campaignSource?.supplierCampaign ||
        scFromExt ||
        (scFromCoupon?.supplier === order.supplier ? scFromCoupon : null) ||
        null;
      const tracking = order.click?.trackingLink || null;
      const networkTrackingLink = firstNonEmpty(
        sc?.trackingUrl,
        couponRow?.couponLink,
        meta.networkTrackingLink,
        convMeta.networkTrackingLink,
      );
      const mboTrackingLink = firstNonEmpty(tracking?.mboTrackingUrl, meta.mboTrackingLink);

      const campaignName = firstNonEmpty(
        order.canonicalCampaign?.displayName,
        conv?.campaignSource?.canonicalCampaign?.displayName,
        sc?.campaignName,
        meta.campaignName,
        convMeta.campaignName,
        entity?.campaignName,
      );
      const merchantName = firstNonEmpty(
        order.merchant?.displayName,
        order.canonicalCampaign?.merchant?.displayName,
        conv?.campaignSource?.canonicalCampaign?.merchant?.displayName,
        sc?.merchant?.displayName,
        sc?.merchantNameRaw,
        meta.merchantName,
        meta.advertiserName,
        convMeta.merchantName,
        convMeta.advertiserName,
        entity?.advertiserName,
      );

      // Client: order FK → conversion assignment → unique active coupon assignment only.
      let clientName = order.client?.name ?? null;
      let clientId = order.clientId ?? null;
      if (!clientName && conv?.clientAssignment?.client) {
        clientName = conv.clientAssignment.client.name ?? null;
        clientId = conv.clientAssignment.clientId ?? clientId;
      }
      if (!clientName && couponRow?.couponAssignments?.length) {
        const active = couponRow.couponAssignments.filter(
          (a) => a.assignment?.published && ["ASSIGNED", "ACTIVE"].includes(a.assignment.status),
        );
        const uniqueClients = [
          ...new Map(
            active
              .filter((a) => a.assignment?.clientId)
              .map((a) => [a.assignment.clientId, a.assignment.client]),
          ).values(),
        ];
        if (uniqueClients.length === 1) {
          clientName = uniqueClients[0]?.name ?? null;
          clientId = uniqueClients[0]?.id ?? clientId;
        }
      }

      const confirmedDate =
        order.validationChangedAt ||
        conv?.approvedDate ||
        meta.confirmedDate ||
        convMeta.confirmedDate ||
        (order.validationStatus === "VALIDATION_APPROVED" ? order.orderDate : null) ||
        null;

      const hasFt = fts.length > 0;
      // 07E: prefer ledger FT; when absent, fall back to conversion supplier commission (never invent client/MBO).
      if (!hasFt) {
        supplierReceivable =
          numOrNull(conv?.approvedCommission) ?? numOrNull(conv?.supplierCommission) ?? null;
        clientPayable = numOrNull(conv?.clientCommission);
        mboMargin = numOrNull(conv?.mboCommission);
      }

      const campaignType = toV13OrderCampaignType({
        conversion: conv,
        order,
        couponCode,
        hasLinkHint: Boolean(networkTrackingLink || mboTrackingLink || tracking?.id),
      });

      const paymentStatus = mapCanonicalPaymentStatus({
        supplierPaymentStatus: order.supplierPaymentStatus,
        clientPaymentStatus: order.clientPaymentStatus,
        validationStatus: order.validationStatus,
      });

      const shares = resolveOrderSharePercents({
        rule: conv?.commissionRule || null,
        conversion: conv,
        clientSharePercent:
          conv?.clientAssignment?.client?.clientSharePercent ??
          order.client?.clientSharePercent ??
          null,
      });

      return toAdminOrderDto(
        {
          ...order,
          clientId,
          client: clientName ? { id: clientId, name: clientName } : order.client,
          exceptionCount: order._count?.exceptionCases ?? 0,
          itemValidationSummary,
          financialSummary: {
            clientPayable,
            supplierReceivable,
            mboMargin,
            ftStatus: hasFt ? "HAS_FT" : "NO_FT",
            adjustmentCount,
            reversalCount,
            source: hasFt ? "financial_transaction" : conv ? "conversion" : "none",
          },
          networkContext: {
            network: order.supplier ?? null,
            networkAccount: order.sourceAccountLabel || sc?.sourceAccountLabel || null,
            supplierOrderId: order.supplierOrderId ?? null,
            campaignSourceId: order.campaignSourceId || conv?.campaignSourceId || null,
            supplierCampaignId:
              sc?.supplierCampaignId ||
              meta.supplierCampaignId ||
              convMeta.supplierCampaignId ||
              null,
            campaignName,
            merchantName,
            campaignType,
            couponCode,
            couponType: firstNonEmpty(
              couponRow?.couponType,
              meta.couponType,
              convMeta.couponType,
              couponCode && (couponRow?.couponLink || networkTrackingLink) ? "CODE" : null,
              !couponCode && (mboTrackingLink || networkTrackingLink) ? "LINK" : null,
            ),
            couponLink: couponRow?.couponLink || null,
            networkTrackingLink,
            mboTrackingLink,
            trackingLinkId: tracking?.id || order.click?.trackingLinkId || conv?.trackingLinkId || null,
            networkClickId: meta.networkClickId ?? meta.supplierClickId ?? null,
            mboClickId: order.click?.id ?? conv?.clickId ?? null,
            subId1: order.click?.subId ?? conv?.subId ?? meta.subId1 ?? null,
            subId2: meta.subId2 ?? null,
            subId3: meta.subId3 ?? null,
            rawStatus: meta.rawStatus ?? meta.supplierStatus ?? convMeta.rawStatus ?? conv?.status ?? null,
            confirmedDate,
            paymentConfirmedDate:
              order.supplierPaymentStatus === "PAYMENT_RECEIVED"
                ? order.supplierPaymentChangedAt || meta.paymentConfirmedDate || null
                : meta.paymentConfirmedDate || null,
            paymentStatus,
            commissionCurrency: conv?.currency || order.currency || null,
            clientSharePercent: shares.clientSharePercent,
            mboSharePercent: shares.mboSharePercent,
            rawPayloadId: order.rawPayloadId ?? null,
          },
        },
        { includeFinancial },
      );
    });

    return {
      items,
      total,
      includeFinancial,
      contract: "v15-07E-admin-orders",
    };
  }

  async listProductFeeds({ skip = 0, take = 50 } = {}) {
    const [rows, total] = await Promise.all([
      this.db.productFeed.findMany({
        orderBy: { updatedAt: "desc" },
        skip,
        take,
        include: {
          _count: { select: { feedItems: true, products: true } },
          campaignSource: { select: { id: true, canonicalCampaignId: true } },
        },
      }),
      this.db.productFeed.count(),
    ]);

    return {
      items: rows.map((feed) => toAdminProductFeedDto(feed)),
      total,
      contract: "epic4-product-feed-admin",
    };
  }

  getCommissionRuleVocabulary() {
    return {
      supportedClientTypes: V15_CLIENT_RULE_TYPES,
      legacy: ["PERCENT", "FIXED"],
      notImplemented: [
        formatAdminCommissionRuleType("TIERED"),
      ],
      guidance:
        "Supplier-tiered campaigns should use PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION on actual confirmed supplier commission.",
    };
  }
}
