import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import { runWithConcurrency } from "../../../core/concurrency.js";
import { AdminContractService } from "../../ops/adminContract.service.js";
import { ClientRepository } from "../repositories/client.repository.js";
import {
  CampaignEligibilityService,
  deriveSourceCapabilities,
  labelEligibilityReason,
} from "./campaignEligibility.service.js";
import { ClientAssignmentService } from "./clientAssignment.service.js";
import {
  deriveCouponRemainingQuantity,
  mapClientChannelType,
  resolveAssignedCampaignType,
  resolveRelationshipStatus,
} from "../../ops/v15FieldContract.js";
import { projectBrandIdentity, brandIdentityToAdminLinks } from "../../merchant/brandIdentity.js";

/** Client Ops v5 — distribution type label (asset), not CPS/CPA commercial model. */
function distributionTypeLabel({ channels = {}, channelType = null, productFeed = null } = {}) {
  if (productFeed === true || String(productFeed || "").toUpperCase() === "AVAILABLE") {
    return "Product Campaign";
  }
  const t = String(channelType || "").toUpperCase();
  if (t === "COUPON" || t === "COUPON_LINK" || t === "LINK_AND_COUPON") return "Coupon Offer";
  if (channels.coupon && !channels.link) return "Coupon Offer";
  if (channels.coupon) return "Coupon Offer";
  if (t === "LINK" || t === "DEEPLINK" || channels.link || channels.deeplink) return "Affiliate Link";
  return null;
}

function clientCommissionLabel(client = {}) {
  const model = String(client.commercialModel || "").toUpperCase();
  if (model === "OFFERS_ONLY") return "Offers only";
  if (model === "OFFERS_PLUS_COMMISSION") {
    if (client.clientSharePercent == null || client.clientSharePercent === "") return null;
    const n = Number(client.clientSharePercent);
    return Number.isFinite(n) ? `${n}%` : null;
  }
  return null;
}

function emptyCouponPool() {
  return {
    couponTotal: null,
    couponAssigned: null,
    couponReserved: null,
    couponRemaining: null,
    couponPoolKnown: false,
  };
}

/**
 * Client campaign allocation catalog — normalized campaigns only, with real eligibility.
 */
export class ClientAllocationService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.clientRepo = deps.clientRepo ?? new ClientRepository();
    this.adminContract = deps.adminContract ?? new AdminContractService();
    this.assignmentService = deps.assignmentService ?? new ClientAssignmentService();
    this.eligibility = deps.eligibility ?? new CampaignEligibilityService();
  }

  async #loadClientAssignments(clientId, { detailed = false } = {}) {
    const select = {
      id: true,
      canonicalCampaignId: true,
      status: true,
      published: true,
      campaignSourceId: true,
    };
    if (detailed) {
      select.channel = true;
      select.trackingLinks = {
        where: { deletedAt: null, status: { not: "REVOKED" } },
        select: { mboTrackingUrl: true, status: true, isPrimary: true },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
        take: 3,
      };
      select.couponAssignments = {
        where: { status: { in: ["ASSIGNED", "ACTIVE"] } },
        select: { clientCouponCode: true, status: true },
        take: 3,
      };
    }
    return this.db.clientCampaignAssignment.findMany({
      where: { clientId, status: { not: "REVOKED" } },
      select,
    });
  }

  #isAssignmentFirstQuery(query = {}) {
    const status = String(query.assignmentStatus || "").toUpperCase();
    return status === "ASSIGNED" || status === "PUBLISHED" || status === "PAUSED";
  }

  #clientSummary(client) {
    return {
      id: client.id,
      name: client.name,
      status: client.status,
      commercialModel: client.commercialModel,
      clientSharePercent: client.clientSharePercent,
      agreementStatus: client.agreementStatus ?? null,
      country: client.country,
      currency: client.currency,
    };
  }

  /**
   * Aggregate CouponCodeMaster inventory for supplier campaign DB ids.
   * Never invent totals — null when network/platform inventory is unknown.
   */
  async #couponPoolsBySupplierCampaignDbIds(supplierCampaignDbIds = []) {
    const ids = [...new Set((supplierCampaignDbIds || []).filter(Boolean))];
    const map = new Map();
    if (!ids.length) return map;

    const masters = await this.db.couponCodeMaster.findMany({
      where: { supplierCampaignId: { in: ids } },
      select: {
        id: true,
        supplierCampaignId: true,
        supplierCouponId: true,
        totalQuantity: true,
        assignedQuantity: true,
      },
    });
    if (!masters.length) return map;

    const supplierCouponIds = masters.map((m) => m.supplierCouponId).filter(Boolean);
    const assignedByCoupon = new Map();
    const reservedByCoupon = new Map();
    if (supplierCouponIds.length) {
      const [assignedGroups, reservedGroups] = await Promise.all([
        this.db.clientCouponAssignment.groupBy({
          by: ["supplierCouponId"],
          where: {
            supplierCouponId: { in: supplierCouponIds },
            status: { in: ["ASSIGNED", "ACTIVE"] },
          },
          _count: { _all: true },
        }),
        this.db.clientCouponAssignment.groupBy({
          by: ["supplierCouponId"],
          where: {
            supplierCouponId: { in: supplierCouponIds },
            status: "RESERVED",
          },
          _count: { _all: true },
        }),
      ]);
      for (const g of assignedGroups) assignedByCoupon.set(g.supplierCouponId, g._count._all);
      for (const g of reservedGroups) reservedByCoupon.set(g.supplierCouponId, g._count._all);
    }

    const byCampaign = new Map();
    for (const m of masters) {
      const list = byCampaign.get(m.supplierCampaignId) || [];
      list.push(m);
      byCampaign.set(m.supplierCampaignId, list);
    }

    for (const [campaignId, rows] of byCampaign) {
      let knownTotals = 0;
      let totalSum = 0;
      let assignedSum = 0;
      let reservedSum = 0;
      for (const r of rows) {
        const liveAssigned =
          r.supplierCouponId && assignedByCoupon.has(r.supplierCouponId)
            ? assignedByCoupon.get(r.supplierCouponId)
            : Number(r.assignedQuantity ?? 0);
        const liveReserved =
          r.supplierCouponId && reservedByCoupon.has(r.supplierCouponId)
            ? reservedByCoupon.get(r.supplierCouponId)
            : 0;
        assignedSum += Number.isFinite(liveAssigned) ? liveAssigned : 0;
        reservedSum += Number.isFinite(liveReserved) ? liveReserved : 0;
        if (r.totalQuantity != null && Number.isFinite(Number(r.totalQuantity))) {
          knownTotals += 1;
          totalSum += Number(r.totalQuantity);
        }
      }
      if (knownTotals === 0) {
        // Codes exist but inventory size unknown — do not invent a pool size.
        map.set(campaignId, {
          ...emptyCouponPool(),
          couponCodeCount: rows.length,
          couponAssigned: assignedSum > 0 ? assignedSum : 0,
          couponReserved: reservedSum > 0 ? reservedSum : 0,
        });
      } else {
        const remaining = deriveCouponRemainingQuantity(totalSum, assignedSum + reservedSum);
        map.set(campaignId, {
          couponTotal: totalSum,
          couponAssigned: assignedSum,
          couponReserved: reservedSum,
          couponRemaining: remaining,
          couponPoolKnown: true,
          couponCodeCount: rows.length,
        });
      }
    }
    return map;
  }

  async #attachCouponPools(rows = []) {
    const dbIds = rows
      .map((r) => r.supplierCampaignDbId || r._supplierCampaignDbId)
      .filter(Boolean);
    const pools = await this.#couponPoolsBySupplierCampaignDbIds(dbIds);
    return rows.map((row) => {
      const key = row.supplierCampaignDbId || row._supplierCampaignDbId;
      const pool = (key && pools.get(key)) || emptyCouponPool();
      const { _supplierCampaignDbId, ...rest } = row;
      const supportsCoupon = Boolean(rest.channels?.coupon || rest.coupon);
      if (!supportsCoupon) {
        return {
          ...rest,
          couponTotal: null,
          couponAssigned: null,
          couponReserved: null,
          couponRemaining: null,
          couponPoolKnown: false,
        };
      }
      return {
        ...rest,
        couponTotal: pool.couponTotal ?? null,
        couponAssigned: pool.couponAssigned ?? null,
        couponReserved: pool.couponReserved ?? null,
        couponRemaining: pool.couponRemaining ?? null,
        couponPoolKnown: Boolean(pool.couponPoolKnown),
        couponCodeCount: pool.couponCodeCount ?? null,
      };
    });
  }

  #buildAssignmentWhere(clientId, query = {}) {
    const where = { clientId, status: { not: "REVOKED" } };
    const status = String(query.assignmentStatus || "").toUpperCase();
    if (status === "PUBLISHED") where.published = true;
    else if (status === "PAUSED") where.status = "PAUSED";
    return where;
  }

  #resolveChannels(existing, primary, item, usableCoupon) {
    let channels = { link: false, coupon: false, deeplink: false };
    if (primary) {
      const derived = deriveSourceCapabilities(primary);
      channels.link = derived.supportsLink;
      channels.coupon = derived.supportsCoupon;
      channels.deeplink = derived.supportsDeeplink;
    } else {
      channels.link = Boolean(item.linkSupport);
      channels.coupon = Boolean(item.couponSupport);
      channels.deeplink = Boolean(item.deeplinkSupport);
    }

    if (!existing) {
      return {
        channels,
        channelType: mapClientChannelType({
          supportsLink: channels.link,
          supportsCoupon: channels.coupon,
          supportsDeeplink: channels.deeplink,
          couponCode: usableCoupon?.couponCode,
        }),
      };
    }

    const links = existing.trackingLinks || [];
    const primaryLink =
      links.find((l) => l.isPrimary && l.mboTrackingUrl) ||
      links.find((l) => l.mboTrackingUrl) ||
      null;
    const assignedCouponCode =
      existing.couponAssignments?.find((c) => c.clientCouponCode)?.clientCouponCode ||
      usableCoupon?.couponCode ||
      null;
    const supportsLink = channels.link || Boolean(primaryLink?.mboTrackingUrl);
    const supportsCoupon = channels.coupon || Boolean(assignedCouponCode);
    const supportsDeeplink = channels.deeplink;

    return {
      channels: {
        link: supportsLink,
        coupon: supportsCoupon,
        deeplink: supportsDeeplink,
      },
      channelType: resolveAssignedCampaignType({
        assignmentChannel: existing.channel,
        hasLink: Boolean(primaryLink?.mboTrackingUrl) || supportsLink,
        hasCoupon: Boolean(assignedCouponCode),
        hasDeeplink: supportsDeeplink,
      }),
    };
  }

  async #enrichCatalogItem(item, existing, client, query, sources, evaluation) {
    const primary = sources.find((s) => s.id === evaluation.eligibleSourceId) || sources[0] || null;
    const sc = primary?.supplierCampaign || null;
    const coupons = sc?.coupons || [];
    const usableCoupon =
      coupons.find((c) => (c.couponCode && String(c.couponCode).trim()) || c.couponLink) || null;

    const { channels, channelType } = this.#resolveChannels(existing, primary, item, usableCoupon);

    let allocationState = "AVAILABLE";
    if (existing) allocationState = "ASSIGNED";
    else if (evaluation.eligibilityStatus === "NEEDS_REVIEW") allocationState = "NEEDS_REVIEW";
    else if (evaluation.eligibilityStatus === "UNAVAILABLE") allocationState = "UNAVAILABLE";
    else if (!evaluation.ok) allocationState = "BLOCKED";

    if (query.eligibility === "ELIGIBLE" && !(evaluation.ok && !existing)) return null;
    if (query.eligibility === "NOT_ELIGIBLE" && (evaluation.ok || existing)) return null;
    if (query.eligibility === "BLOCKED" && allocationState !== "BLOCKED") return null;
    if (query.eligibility === "UNAVAILABLE" && allocationState !== "UNAVAILABLE") return null;
    if (query.eligibility === "ALREADY_ASSIGNED" && !existing) return null;
    if (query.eligibility === "NEEDS_REVIEW" && evaluation.eligibilityStatus !== "NEEDS_REVIEW") {
      return null;
    }
    if (query.assignmentStatus === "ASSIGNED" && !existing) return null;
    if (query.assignmentStatus === "AVAILABLE" && existing) return null;
    if (query.assignmentStatus === "NEEDS_REVIEW" && allocationState !== "NEEDS_REVIEW") return null;
    if (query.assignmentStatus === "BLOCKED" && allocationState !== "BLOCKED") return null;
    if (query.assignmentStatus === "PUBLISHED" && !(existing?.published === true)) return null;
    if (query.assignmentStatus === "PAUSED" && existing?.status !== "PAUSED") return null;
    if (query.assignmentStatus === "REVOKED") return null;
    if (query.channel === "LINK" && !channels.link) return null;
    if (query.channel === "COUPON" && !channels.coupon) return null;
    if (query.channel === "DEEPLINK" && !channels.deeplink) return null;
    if (
      (query.channel === "COUPON_LINK" || query.channel === "LINK_AND_COUPON") &&
      !(channels.link && channels.coupon)
    ) {
      return null;
    }
    if (query.currency) {
      const want = String(query.currency).toUpperCase();
      const have = item.currency != null ? String(item.currency).toUpperCase() : "";
      if (have !== want) return null;
    }

    const brand = projectBrandIdentity(
      {
        id: item.brand?.id ?? null,
        displayName: item.brandName,
        logoUrl: item.brandLogoLink,
        website: item.brandWebsiteLink,
      },
      sc,
    );
    const brandLinks = brandIdentityToAdminLinks(brand);
    const relationshipRaw = item.relationshipStatus ?? null;
    const relationshipNeedsReview =
      relationshipRaw == null || String(relationshipRaw).toUpperCase() === "UNKNOWN";

    const isAssignable = evaluation.ok && !existing;
    const mboReady = item.mboReady === true;
    const completeness = evaluation.ok ? "Complete" : "Incomplete";
    const distributionType = distributionTypeLabel({
      channels,
      channelType,
      productFeed: item.productFeedAvailability,
    });

    // Client Ops v5 filters: Coupon Offer / Affiliate Link / Product Campaign
    const offerType = String(query.offerType || query.distributionType || "").toUpperCase();
    if (offerType === "COUPON_OFFER" || offerType === "COUPON OFFER") {
      if (distributionType !== "Coupon Offer") return null;
    } else if (offerType === "AFFILIATE_LINK" || offerType === "AFFILIATE LINK") {
      if (distributionType !== "Affiliate Link") return null;
    } else if (offerType === "PRODUCT_CAMPAIGN" || offerType === "PRODUCT CAMPAIGN") {
      if (distributionType !== "Product Campaign") return null;
    }

    const completenessFilter = String(query.completeness || "").toUpperCase();
    if (completenessFilter === "COMPLETE" && completeness !== "Complete") return null;
    if (completenessFilter === "INCOMPLETE" && completeness !== "Incomplete") return null;

    const altSources = Math.max(0, (sources || []).length - (primary ? 1 : 0));
    const expiry =
      item.couponExpiry ||
      usableCoupon?.couponEndDate ||
      item.campaignEndDate ||
      null;

    const clientCommission = clientCommissionLabel(client);
    // Prefer explicit client share when known; never invent a supplier rate as client commission.
    const clientShare =
      client.commercialModel === "OFFERS_PLUS_COMMISSION" &&
      client.clientSharePercent != null &&
      client.clientSharePercent !== ""
        ? Number(client.clientSharePercent)
        : client.commercialModel === "OFFERS_ONLY"
          ? 0
          : null;

    return {
      id: item.id,
      brand,
      brandName: brandLinks.brandName,
      brandLogoLink: brandLinks.brandLogoLink,
      brandWebsiteLink: brandLinks.brandWebsiteLink,
      campaignName: item.campaignName,
      campaignDescription: item.campaignDescription ?? null,
      networkSource: item.networkSource,
      /** Commercial model (CPS/CPA/…) — not distribution channel. */
      campaignType: item.campaignType,
      commercialModel: item.campaignType ?? null,
      /** Client Ops v5 Type column — Coupon Offer / Affiliate Link / Product Campaign. */
      distributionType,
      country: item.country,
      currency: item.currency,
      /** Admin supplier campaign commission display — not client payout. */
      campaignCommission: item.campaignCommission,
      commissionRuleCount:
        item.commissionRuleCount != null ? Number(item.commissionRuleCount) : null,
      discountPercent: item.discountPercent ?? null,
      customerOffer:
        usableCoupon?.discountValue ||
        usableCoupon?.discountPercentage ||
        (item.discountPercent != null ? `${item.discountPercent}%` : null) ||
        null,
      expiry,
      couponExpiry: item.couponExpiry ?? null,
      campaignEndDate: item.campaignEndDate ?? null,
      campaignStatus: item.campaignStatus,
      relationshipStatus: relationshipRaw,
      relationshipDisplayStatus: relationshipNeedsReview ? "NEEDS_REVIEW" : relationshipRaw,
      relationshipLabel: relationshipNeedsReview
        ? "Needs review"
        : relationshipRaw
          ? String(relationshipRaw)
              .replaceAll("_", " ")
              .replace(/\b\w/g, (c) => c.toUpperCase())
          : null,
      channels,
      /** Distribution channel (LINK/COUPON/…) — not CPS/CPA. */
      channelType,
      eligibilityStatus: evaluation.eligibilityStatus,
      eligibilityOk: evaluation.ok,
      eligibilityReasons: evaluation.reasons,
      eligibilityLabels: evaluation.reasonLabels,
      issue: evaluation.ok
        ? null
        : evaluation.reasonLabels?.find(
            (_label, idx) => evaluation.reasons[idx] !== "no_eligible_campaign_source",
          ) ||
          evaluation.reasonLabels?.[0] ||
          labelEligibilityReason(evaluation.reasons[0]),
      allocationState,
      isAssignable,
      assignmentReady: isAssignable,
      completeness,
      mboReady,
      assignmentId: existing?.id ?? null,
      assignmentStatus: existing?.status ?? null,
      assignmentPublished: existing?.published ?? false,
      primaryCampaignSourceId: item.primaryCampaignSourceId || primary?.id || null,
      primarySource:
        primary?.supplierCampaign?.supplier ||
        primary?.supplier ||
        item.networkSource ||
        null,
      alternativeSources: altSources,
      supplierCampaignId: item.supplierCampaignId || sc?.supplierCampaignId || null,
      supplierCampaignDbId: sc?.id || item.supplierCampaignRowId || null,
      _supplierCampaignDbId: sc?.id || item.supplierCampaignRowId || null,
      lastSyncedAt: item.lastSyncedAt || sc?.lastSyncedAt || null,
      coupon: usableCoupon
        ? {
            code: usableCoupon.couponCode || null,
            link: usableCoupon.couponLink || null,
            status: usableCoupon.couponStatus || null,
            discount: usableCoupon.discountValue || usableCoupon.discountPercentage || null,
          }
        : null,
      clientCommission,
      commercial: {
        supplierCommission: item.campaignCommission,
        commissionRuleCount:
          item.commissionRuleCount != null ? Number(item.commissionRuleCount) : null,
        clientSharePercent: clientShare,
        mboSharePercent:
          clientShare != null && client.commercialModel === "OFFERS_PLUS_COMMISSION"
            ? 100 - clientShare
            : client.commercialModel === "OFFERS_ONLY"
              ? 100
              : null,
        commercialModel: client.commercialModel || null,
      },
    };
  }

  async #listAssignmentFirst(clientId, client, query, page, take) {
    const assignmentWhere = this.#buildAssignmentWhere(clientId, query);
    const commercialModelFilter =
      query.commercialModel || query.campaignType || query.commercial || null;

    const [assignmentRows, totalAssigned] = await Promise.all([
      this.db.clientCampaignAssignment.findMany({
        where: assignmentWhere,
        skip: (page - 1) * take,
        take,
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          canonicalCampaignId: true,
          status: true,
          published: true,
          campaignSourceId: true,
          channel: true,
          trackingLinks: {
            where: { deletedAt: null, status: { not: "REVOKED" } },
            select: { mboTrackingUrl: true, status: true, isPrimary: true },
            orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
            take: 3,
          },
          couponAssignments: {
            where: { status: { in: ["ASSIGNED", "ACTIVE"] } },
            select: { clientCouponCode: true, status: true },
            take: 3,
          },
        },
      }),
      this.db.clientCampaignAssignment.count({ where: assignmentWhere }),
    ]);

    if (!assignmentRows.length) {
      return {
        items: [],
        total: totalAssigned,
        page,
        pageSize: take,
        client: {
          id: client.id,
          name: client.name,
          status: client.status,
          commercialModel: client.commercialModel,
          clientSharePercent: client.clientSharePercent,
          country: client.country,
          currency: client.currency,
        },
        summary: {
          totalAssigned,
          pageEligible: 0,
          pageAssigned: 0,
          pageBlocked: 0,
          pageNeedsReview: 0,
        },
      };
    }

    const campaignIds = assignmentRows.map((row) => row.canonicalCampaignId);
    const admin = await this.adminContract.listCampaigns(
      {
        ids: campaignIds,
        q: query.q || query.search || null,
        networkSource: query.networkSource || query.network || null,
        campaignStatus: query.campaignStatus || null,
        relationshipStatus: query.relationshipStatus || query.relationship || null,
        campaignType: commercialModelFilter,
        country: query.country || null,
        skip: 0,
        take: campaignIds.length,
      },
      [],
    );

    const itemById = new Map((admin.items || []).map((item) => [item.id, item]));
    const sourcesByCampaign = await this.assignmentService.loadCatalogSourcesByCampaignIds(
      assignmentRows.map((row) => row.canonicalCampaignId),
    );

    const enrichedRaw = await runWithConcurrency(assignmentRows, 12, async (assignment) => {
      const item = itemById.get(assignment.canonicalCampaignId);
      if (!item) return null;

      const sources = sourcesByCampaign.get(item.id) || [];
      const evaluation = this.eligibility.evaluate({
        mode: "assign",
        catalogCampaign: {
          id: item.id,
          status: "PUBLISHED",
          visibility: "ASSIGNABLE",
          deletedAt: null,
          countries: item.country || [],
          defaultCurrency: item.currency || null,
        },
        client,
        sources,
      });

      return this.#enrichCatalogItem(item, assignment, client, query, sources, evaluation);
    });
    const enriched = enrichedRaw.filter(Boolean);

    const withPools = await this.#attachCouponPools(enriched);

    return {
      items: withPools,
      total: totalAssigned,
      page,
      pageSize: take,
      client: this.#clientSummary(client),
      summary: {
        totalAssigned,
        pageEligible: withPools.filter((r) => r.eligibilityOk && r.allocationState !== "ASSIGNED")
          .length,
        pageAssigned: withPools.filter((r) => r.allocationState === "ASSIGNED").length,
        pageBlocked: withPools.filter((r) => r.allocationState === "BLOCKED").length,
        pageNeedsReview: withPools.filter((r) => r.allocationState === "NEEDS_REVIEW").length,
      },
    };
  }

  async listForClient(clientId, query = {}) {
    const client = await this.clientRepo.findById(clientId);
    if (!client) throw fail("Client not found.", 404);

    const take = Math.min(100, Math.max(1, Number(query.take) || Number(query.pageSize) || 25));
    const page = Math.max(1, Number(query.page) || 1);

    if (this.#isAssignmentFirstQuery(query)) {
      return this.#listAssignmentFirst(clientId, client, query, page, take);
    }

    // campaignType / commercialModel = CPS/CPA/… (commercial). Channel is filtered separately.
    const commercialModelFilter =
      query.commercialModel || query.campaignType || query.commercial || null;

    const admin = await this.adminContract.listCampaigns(
      {
        q: query.q || query.search || null,
        networkSource: query.networkSource || query.network || null,
        campaignStatus: query.campaignStatus || null,
        relationshipStatus: query.relationshipStatus || query.relationship || null,
        campaignType: commercialModelFilter,
        country: query.country || null,
        isAssignable: query.isAssignable ?? null,
        skip: (page - 1) * take,
        take,
      },
      [],
    );

    const items = admin.items || [];
    const assignmentRows = await this.#loadClientAssignments(clientId, { detailed: true });
    const assignmentByCampaign = new Map(
      assignmentRows.map((row) => [row.canonicalCampaignId, row]),
    );
    const totalAssigned = assignmentRows.length;

    const sourcesByCampaign = await this.assignmentService.loadCatalogSourcesByCampaignIds(
      items.map((item) => item.id),
    );

    const enrichedRaw = await runWithConcurrency(items, 12, async (item) => {
      const sources = sourcesByCampaign.get(item.id) || [];
      const evaluation = this.eligibility.evaluate({
        mode: "assign",
        catalogCampaign: {
          id: item.id,
          status: "PUBLISHED",
          visibility: "ASSIGNABLE",
          deletedAt: null,
          countries: item.country || [],
          defaultCurrency: item.currency || null,
        },
        client,
        sources,
      });

      const existing = assignmentByCampaign.get(item.id) || null;
      return this.#enrichCatalogItem(item, existing, client, query, sources, evaluation);
    });
    const enriched = enrichedRaw.filter(Boolean);

    const withPools = await this.#attachCouponPools(enriched);

    return {
      items: withPools,
      total: admin.total,
      page,
      pageSize: take,
      client: this.#clientSummary(client),
      summary: {
        totalAssigned,
        pageEligible: withPools.filter((r) => r.eligibilityOk && r.allocationState !== "ASSIGNED")
          .length,
        pageAssigned: withPools.filter((r) => r.allocationState === "ASSIGNED").length,
        pageBlocked: withPools.filter((r) => r.allocationState === "BLOCKED").length,
        pageNeedsReview: withPools.filter((r) => r.allocationState === "NEEDS_REVIEW").length,
      },
    };
  }

  async getDetail(clientId, canonicalCampaignId) {
    const client = await this.clientRepo.findById(clientId);
    if (!client) throw fail("Client not found.", 404);

    const detail = await this.adminContract.getCampaign(canonicalCampaignId);
    if (!detail) throw fail("Campaign not found.", 404);

    const sources = await this.assignmentService.loadCatalogSources(canonicalCampaignId);
    const evaluation = this.eligibility.evaluate({
      mode: "assign",
      catalogCampaign: {
        id: detail.id,
        status: "PUBLISHED",
        visibility: "ASSIGNABLE",
        deletedAt: null,
        countries: detail.country || [],
        defaultCurrency: detail.currency || null,
      },
      client,
      sources,
    });

    const existing = await this.db.clientCampaignAssignment.findFirst({
      where: {
        clientId,
        canonicalCampaignId,
        status: { not: "REVOKED" },
      },
    });

    const primary = sources.find((s) => s.id === evaluation.eligibleSourceId) || sources[0] || null;
    const sc = primary?.supplierCampaign || null;
    const coupons = sc?.coupons || [];
    const usableCoupon =
      coupons.find((c) => (c.couponCode && String(c.couponCode).trim()) || c.couponLink) || null;
    const channels = primary
      ? deriveSourceCapabilities(primary)
      : { supportsLink: false, supportsCoupon: false, supportsDeeplink: false };

    const optimiseEvidence =
      sc?.normalizedPayload?.optimisePublisherRelationship &&
      typeof sc.normalizedPayload.optimisePublisherRelationship === "object"
        ? sc.normalizedPayload.optimisePublisherRelationship
        : null;
    const relationshipStatus =
      detail.relationshipStatus ||
      (primary ? resolveRelationshipStatus(primary, sc) : null) ||
      null;
    const relationshipNeedsReview =
      relationshipStatus == null || String(relationshipStatus).toUpperCase() === "UNKNOWN";

    return {
      id: detail.id,
      brand: projectBrandIdentity(
        {
          id: detail.brand?.id ?? null,
          displayName: detail.brandName,
          logoUrl: detail.brandLogoLink,
          website: detail.brandWebsiteLink,
        },
        sc,
      ),
      brandName: detail.brandName,
      brandLogoLink: detail.brandLogoLink ?? null,
      brandWebsiteLink: detail.brandWebsiteLink ?? null,
      campaignName: detail.campaignName,
      networkSource: detail.networkSource,
      country: detail.country,
      currency: detail.currency,
      campaignType: detail.campaignType,
      campaignStatus: detail.campaignStatus,
      relationshipStatus,
      campaignCommission: detail.campaignCommission,
      campaignDescription: detail.campaignDescription,
      channels: {
        link: channels.supportsLink,
        coupon: channels.supportsCoupon,
        deeplink: channels.supportsDeeplink,
      },
      coupon: usableCoupon
        ? {
            code: usableCoupon.couponCode || null,
            link: usableCoupon.couponLink || null,
            status: usableCoupon.couponStatus || null,
          }
        : null,
      eligibilityStatus: evaluation.eligibilityStatus,
      eligibilityOk: evaluation.ok,
      eligibilityReasons: evaluation.reasons,
      eligibilityLabels: evaluation.reasonLabels,
      issue: evaluation.ok
        ? null
        : evaluation.reasonLabels?.[0] || labelEligibilityReason(evaluation.reasons[0]),
      checks: evaluation.ok
        ? [{ code: "eligible", label: "Eligible", passed: true }]
        : evaluation.reasons.map((code) => ({
            code,
            label: labelEligibilityReason(code),
            passed: false,
          })),
      relationship: {
        status: relationshipStatus,
        displayStatus: relationshipNeedsReview ? "NEEDS_REVIEW" : relationshipStatus,
        label: relationshipNeedsReview
          ? "Needs review"
          : String(relationshipStatus || "")
              .replaceAll("_", " ")
              .replace(/\b\w/g, (c) => c.toUpperCase()),
        evidence:
          relationshipNeedsReview && !optimiseEvidence?.sourceValue
            ? "No verified publisher participation status found in imported source data."
            : optimiseEvidence?.sourceField
              ? `Mapped from ${optimiseEvidence.sourceField}=${optimiseEvidence.sourceValue}`
              : primary?.relationshipStatus && primary.relationshipStatus !== "UNKNOWN"
                ? "CampaignSource.relationshipStatus"
                : sc?.isJoined
                  ? "SupplierCampaign.isJoined"
                  : sc?.participationStatus
                    ? `SupplierCampaign.participationStatus=${sc.participationStatus}`
                    : "No verified publisher participation status found in imported source data.",
        evidenceSource: optimiseEvidence?.sourceField || null,
        evidenceValue: optimiseEvidence?.sourceValue || null,
        lastVerified: sc?.lastSyncedAt || null,
        network: sc?.supplier || detail.networkSource || null,
        account: sc?.sourceAccountLabel || null,
      },
      assignment: existing
        ? {
            id: existing.id,
            status: existing.status,
            published: existing.published,
          }
        : null,
      commercial: {
        supplierCommission: detail.campaignCommission,
        clientSharePercent:
          client.commercialModel === "OFFERS_PLUS_COMMISSION"
            ? Number(client.clientSharePercent ?? 70)
            : client.commercialModel === "OFFERS_ONLY"
              ? 0
              : null,
        mboSharePercent:
          client.commercialModel === "OFFERS_PLUS_COMMISSION"
            ? 100 - Number(client.clientSharePercent ?? 70)
            : client.commercialModel === "OFFERS_ONLY"
              ? 100
              : null,
        commercialModel: client.commercialModel || null,
      },
      source: {
        campaignSourceId: primary?.id || null,
        supplier: sc?.supplier || null,
        supplierCampaignId: sc?.supplierCampaignId || null,
        merchantId: sc?.merchantId || null,
        lastSyncedAt: sc?.lastSyncedAt || null,
        trackingUrl: sc?.trackingUrl || null,
      },
      diagnostics: {
        campaignSourceRelationshipStatus: primary?.relationshipStatus || null,
        supplierParticipationStatus: sc?.participationStatus || null,
        supplierIsJoined: sc?.isJoined ?? null,
        optimisePublisherRelationship: optimiseEvidence,
      },
    };
  }
}
