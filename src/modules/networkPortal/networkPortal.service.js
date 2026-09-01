/**
 * Network Operation Portal service — NETWORK → MBO only.
 * Reuses existing domain tables; extends with CouponCodeMaster + NetworkPerformanceFact + certification.
 */
import { prisma } from "../../database/prisma.js";
import { CatalogService } from "../catalog/services/catalog.service.js";
import {
  toCouponPoolDto,
  toNetworkPerformanceDto,
  networkGrainKey,
  buildMappingCertificationChecklist,
  deriveCouponRemainingQuantity,
} from "./networkPortal.dto.js";
import { money } from "../ops/v15FieldContract.js";
import { extractMboActualReceipt } from "../finance/financeSeparation.contract.js";
import { resolveNetworkReconRowStatus } from "../finance/reconciliationLogic.contract.js";
import { ReconciliationService } from "../finance/reconciliation.service.js";
import { isCouponUrlValue } from "../coupons/codeType.js";
import { toSupplierCommissionRuleDto } from "../commercial/supplierCommissionRule.contract.js";

function deriveCouponScopeFromSupplierCoupon(supplierCoupon) {
  if (supplierCoupon?.couponIsExclusive === true) return "UNIQUE_TO_CLIENT";
  if (supplierCoupon?.couponIsExclusive === false) return "UNLIMITED";
  const raw = supplierCoupon?.rawPayload;
  if (raw?.exclusive === true || raw?.is_exclusive === true) return "UNIQUE_TO_CLIENT";
  if (raw?.exclusive === false || raw?.is_exclusive === false) return "UNLIMITED";
  if (raw?.affiliateSpecific === true) return "UNIQUE_TO_CLIENT";
  return "UNKNOWN";
}

const ASSIGNED_COUPON_STATUSES = ["ASSIGNED", "ACTIVE"];

const PERFORMANCE_CAMPAIGN_INCLUDE = {
  select: {
    id: true,
    supplier: true,
    sourceAccountLabel: true,
    supplierCampaignId: true,
    campaignName: true,
    merchantNameRaw: true,
    trackingUrl: true,
    campaignType: true,
    categoryName: true,
    merchant: { select: { displayName: true } },
    campaignSources: {
      select: { id: true, supportsLink: true, supportsCoupon: true, isPrimary: true },
      take: 3,
      orderBy: [{ isPrimary: "desc" }, { isActive: "desc" }],
    },
    couponCodeMasters: {
      select: {
        id: true,
        couponCode: true,
        source: true,
        scope: true,
        supplierCouponExtId: true,
      },
      take: 25,
    },
  },
};

function normalizePerformanceChannelFilter(value) {
  const v = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (!v) return null;
  if (["COUPON_AND_LINK", "LINK_AND_COUPON", "COUPON_PLUS_NETWORK_LINK", "COUPON_+_NETWORK_LINK"].includes(v)) {
    return "COUPON_AND_LINK";
  }
  if (["COUPON_CODE_ONLY", "COUPON"].includes(v)) return "COUPON_CODE_ONLY";
  if (["AFFILIATE_LINK_ONLY", "LINK"].includes(v)) return "AFFILIATE_LINK_ONLY";
  if (v === "DEEPLINK") return "DEEPLINK";
  return null;
}

export class NetworkPortalService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.catalog = deps.catalogService ?? new CatalogService({ prisma: this.db });
  }

  async certifyMapping(supplierCampaignId, { actorId = null, reason = null } = {}) {
    const sc = await this.db.supplierCampaign.findUnique({
      where: { id: supplierCampaignId },
      include: {
        campaignSources: { take: 1, orderBy: [{ isPrimary: "desc" }, { isActive: "desc" }] },
        mappingCertification: true,
      },
    });
    if (!sc) {
      const err = new Error("Supplier campaign not found");
      err.status = 404;
      throw err;
    }
    const source = sc.campaignSources?.[0] || null;
    let commissionAvailable = sc.defaultCommissionValue != null && Number(sc.defaultCommissionValue) !== 0;
    if (source?.id) {
      const ruleCount = await this.db.supplierCommissionRule.count({
        where: { campaignSourceId: source.id },
      });
      if (ruleCount > 0) commissionAvailable = true;
    }
    const { valid, checklist } = buildMappingCertificationChecklist({
      supplierCampaign: sc,
      hasCampaignSource: Boolean(source),
      commissionAvailable,
      mapperVersion: sc.mapperVersion,
    });
    if (!valid) {
      const err = new Error("Certification checklist incomplete — cannot set MAPPED");
      err.status = 400;
      err.details = checklist;
      throw err;
    }
    const cert = await this.db.mappingCertification.upsert({
      where: { supplierCampaignId: sc.id },
      create: {
        supplierCampaignId: sc.id,
        status: "CERTIFIED",
        checklist,
        certifiedAt: new Date(),
        certifiedBy: actorId,
        reason: reason || "Network Ops mapping certification",
      },
      update: {
        status: "CERTIFIED",
        checklist,
        certifiedAt: new Date(),
        certifiedBy: actorId,
        revokedAt: null,
        revokedBy: null,
        reason: reason || "Network Ops mapping certification",
      },
    });
    return { mappingStatus: "MAPPED", certification: cert, checklist };
  }

  async revokeMapping(supplierCampaignId, { actorId = null, reason = null } = {}) {
    const cert = await this.db.mappingCertification.update({
      where: { supplierCampaignId },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        revokedBy: actorId,
        reason: reason || "Revoked by Network Ops",
      },
    });
    return { mappingStatus: "NEEDS_REVIEW", certification: cert };
  }

  async approveToMasterCatalog(supplierCampaignIds = [], { actorId = null } = {}) {
    const results = [];
    for (const id of supplierCampaignIds) {
      try {
        const canonicalId = await this.catalog.ensureFromSupplierCampaign(id);
        results.push({ supplierCampaignId: id, canonicalCampaignId: canonicalId, ok: true });
      } catch (e) {
        results.push({ supplierCampaignId: id, ok: false, error: e.message });
      }
    }
    return { approvedBy: actorId, results };
  }

  // ─── Coupon Pool ────────────────────────────────────────────────────────
  async listCouponPool({
    network = null,
    q = null,
    newCodeAlert = null,
    status = null,
    source = null,
    scope = null,
    campaign = null,
    validity = null,
    skip = 0,
    take = 50,
  } = {}) {
    const where = {};
    const and = [];
    if (network) where.supplier = String(network).toUpperCase();
    if (newCodeAlert === true || newCodeAlert === "true") where.newCodeAlert = true;
    if (newCodeAlert === false || newCodeAlert === "false") where.newCodeAlert = false;
    if (status) where.status = String(status).toUpperCase();
    if (source) where.source = String(source).toUpperCase();
    if (scope) where.scope = String(scope).toUpperCase();
    if (campaign) {
      const c = String(campaign).trim();
      and.push({
        OR: [
          { supplierCampaign: { campaignName: { contains: c, mode: "insensitive" } } },
          { supplierCampaign: { merchantNameRaw: { contains: c, mode: "insensitive" } } },
          { supplierCampaign: { merchant: { displayName: { contains: c, mode: "insensitive" } } } },
        ],
      });
    }
    if (validity === "expired") {
      and.push({
        OR: [
          { status: "EXPIRED" },
          { validUntil: { lt: new Date() } },
        ],
      });
    } else if (validity === "active" || validity === "valid") {
      and.push({
        status: { in: ["ACTIVE", "SCHEDULED", "UNKNOWN"] },
        OR: [{ validUntil: null }, { validUntil: { gte: new Date() } }],
      });
    } else if (validity === "disabled") {
      and.push({ status: "DISABLED" });
    }
    if (q) {
      const term = String(q).trim();
      and.push({
        OR: [
          { couponCode: { contains: term, mode: "insensitive" } },
          { campaignSourceId: { equals: term } },
          { rawPayloadId: { equals: term } },
          { supplierCouponExtId: { contains: term, mode: "insensitive" } },
          { supplierCouponId: { equals: term } },
          { sourceAccountLabel: { contains: term, mode: "insensitive" } },
          { supplierCampaign: { campaignName: { contains: term, mode: "insensitive" } } },
          { supplierCampaign: { merchantNameRaw: { contains: term, mode: "insensitive" } } },
          { supplierCampaign: { merchant: { displayName: { contains: term, mode: "insensitive" } } } },
          { supplierCampaign: { supplierCampaignId: { contains: term, mode: "insensitive" } } },
        ],
      });
      const net = term.toUpperCase();
      if (["OPTIMISE", "BOOSTINY", "TRACKIER", "PARTNERIZE", "IMPACT"].includes(net)) {
        and[and.length - 1].OR.push({ supplier: net });
      }
    }
    if (and.length) where.AND = and;

    // Coupon-code pool only — never treat tracking/redeem URLs as voucher codes.
    // couponCode is required String on CouponCodeMaster (not nullable), so no null filter.
    const poolFilters = [
      { couponCode: { not: "" } },
      { NOT: { couponCode: { startsWith: "http" } } },
      { NOT: { couponCode: { startsWith: "HTTP" } } },
      { NOT: { couponCode: { startsWith: "www." } } },
    ];
    const poolWhere =
      Object.keys(where).length > 0
        ? { AND: [where, ...poolFilters] }
        : { AND: poolFilters };

    const [rows, total, alertCount, sharedCount, expiredDisabledCount] = await Promise.all([
      this.db.couponCodeMaster.findMany({
        where: poolWhere,
        include: {
          supplierCampaign: {
            select: {
              id: true,
              supplierCampaignId: true,
              campaignName: true,
              merchantNameRaw: true,
              merchant: { select: { displayName: true } },
            },
          },
          supplierCoupon: {
            select: {
              id: true,
              couponCode: true,
              couponLink: true,
              couponType: true,
              couponIsExclusive: true,
              rawPayload: true,
            },
          },
        },
        orderBy: [{ newCodeAlert: "desc" }, { detectedAt: "desc" }],
        skip,
        take,
      }),
      this.db.couponCodeMaster.count({ where: poolWhere }),
      this.db.couponCodeMaster.count({ where: { AND: [poolWhere, { newCodeAlert: true }] } }),
      this.db.couponCodeMaster.count({ where: { AND: [poolWhere, { scope: "SHARED_LIMITED" }] } }),
      this.db.couponCodeMaster.count({
        where: {
          AND: [
            poolWhere,
            {
              OR: [
                { status: { in: ["EXPIRED", "DISABLED"] } },
                { validUntil: { lt: new Date() } },
              ],
            },
          ],
        },
      }),
    ]);

    const supplierCouponIds = rows.map((r) => r.supplierCouponId).filter(Boolean);
    const assignmentCounts = new Map();
    if (supplierCouponIds.length) {
      const groups = await this.db.clientCouponAssignment.groupBy({
        by: ["supplierCouponId"],
        where: {
          supplierCouponId: { in: supplierCouponIds },
          status: { in: ASSIGNED_COUPON_STATUSES },
        },
        _count: { _all: true },
      });
      for (const g of groups) assignmentCounts.set(g.supplierCouponId, g._count._all);
    }

    const items = rows.map((r) => {
      const fromAssignments = r.supplierCouponId ? assignmentCounts.get(r.supplierCouponId) : null;
      // Prefer live assignment count when linked; else stored assignedQuantity.
      const assigned = fromAssignments != null ? fromAssignments : r.assignedQuantity;
      return toCouponPoolDto(r, { assignmentCount: assigned });
    });

    // Global available quantity for filtered set (stored assignedQuantity; not page-only).
    // Null totals are excluded — do not invent inventory.
    const qtyRows = await this.db.couponCodeMaster.findMany({
      where: { AND: [poolWhere, { totalQuantity: { not: null } }] },
      select: { totalQuantity: true, assignedQuantity: true, supplierCouponId: true },
      take: 5000,
    });
    let availableQuantity = 0;
    let knownInventoryRows = 0;
    if (qtyRows.length) {
      const qtySupplierIds = qtyRows.map((r) => r.supplierCouponId).filter(Boolean);
      const qtyAssign = new Map();
      if (qtySupplierIds.length) {
        const groups = await this.db.clientCouponAssignment.groupBy({
          by: ["supplierCouponId"],
          where: {
            supplierCouponId: { in: qtySupplierIds },
            status: { in: ASSIGNED_COUPON_STATUSES },
          },
          _count: { _all: true },
        });
        for (const g of groups) qtyAssign.set(g.supplierCouponId, g._count._all);
      }
      for (const r of qtyRows) {
        const assigned =
          r.supplierCouponId && qtyAssign.has(r.supplierCouponId)
            ? qtyAssign.get(r.supplierCouponId)
            : r.assignedQuantity;
        const rem = deriveCouponRemainingQuantity(r.totalQuantity, assigned);
        if (rem != null) {
          availableQuantity += rem;
          knownInventoryRows += 1;
        }
      }
    }

    return {
      total,
      items,
      kpis: {
        couponRecords: total,
        availableQuantity: knownInventoryRows > 0 ? availableQuantity : null,
        newCodeAlerts: alertCount,
        sharedCodes: sharedCount,
        expiredDisabled: expiredDisabledCount,
        knownInventoryRows,
      },
    };
  }

  async upsertCouponCodeMasterFromSupplierCoupon(supplierCoupon, { source = "NETWORK_API", isNew = false } = {}) {
    const realCode =
      supplierCoupon?.couponCode && !isCouponUrlValue(supplierCoupon.couponCode)
        ? String(supplierCoupon.couponCode).trim()
        : null;
    if (!realCode || !supplierCoupon.supplierCampaignId) {
      // Link-only / URL-as-code rows must not enter the coupon-code pool.
      if (supplierCoupon?.id) {
        await this.db.couponCodeMaster
          .deleteMany({ where: { supplierCouponId: supplierCoupon.id } })
          .catch(() => null);
      }
      return null;
    }
    const sc = await this.db.supplierCampaign.findUnique({
      where: { id: supplierCoupon.supplierCampaignId },
      select: {
        id: true,
        supplier: true,
        sourceAccountLabel: true,
        campaignSources: { select: { id: true }, take: 1 },
      },
    });
    if (!sc) return null;

    const existing = await this.db.couponCodeMaster.findFirst({
      where: {
        OR: [
          { supplierCouponId: supplierCoupon.id },
          {
            supplier: sc.supplier,
            sourceAccountLabel: sc.sourceAccountLabel,
            supplierCampaignId: sc.id,
            couponCode: realCode,
          },
        ],
      },
    });

    const data = {
      supplier: sc.supplier,
      sourceAccountLabel: sc.sourceAccountLabel,
      supplierCampaignId: sc.id,
      campaignSourceId: sc.campaignSources?.[0]?.id ?? null,
      supplierCouponId: supplierCoupon.id,
      supplierCouponExtId: supplierCoupon.supplierCouponId ?? null,
      couponCode: realCode,
      source,
      status: supplierCoupon.couponStatus || "UNKNOWN",
      validFrom: supplierCoupon.couponStartDate,
      validUntil: supplierCoupon.couponEndDate,
      rawPayloadId: supplierCoupon.rawPayloadId ?? null,
      scope: deriveCouponScopeFromSupplierCoupon(supplierCoupon),
    };

    if (existing) {
      return this.db.couponCodeMaster.update({
        where: { id: existing.id },
        data: {
          ...data,
          // Do not clear alert or mutate assignedQuantity on sync refresh.
          newCodeAlert: existing.newCodeAlert,
        },
      });
    }

    const created = await this.db.couponCodeMaster.create({
      data: {
        ...data,
        totalQuantity: null,
        assignedQuantity: 0,
        newCodeAlert: true,
        detectedAt: new Date(),
      },
    });

    // Raise operational exception for new code — does NOT touch client assignments.
    await this.db.exceptionCase.create({
      data: {
        type: "NETWORK_NEW_COUPON_ALERT",
        severity: "MEDIUM",
        status: "OPEN",
        dedupeKey: `new-coupon:${created.id}`,
        supplier: sc.supplier,
        reason: `New coupon code available: ${created.couponCode}`,
        metadata: {
          module: "Coupon Pool",
          couponCodeMasterId: created.id,
          couponCode: created.couponCode,
        },
      },
    }).catch(() => null);

    return created;
  }

  async reviewCouponAlert(id, { actorId = null } = {}) {
    const row = await this.db.couponCodeMaster.update({
      where: { id },
      data: { newCodeAlert: false, alertReviewedAt: new Date() },
    });
    await this.db.exceptionCase.updateMany({
      where: {
        type: "NETWORK_NEW_COUPON_ALERT",
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        metadata: { path: ["couponCodeMasterId"], equals: id },
      },
      data: { status: "RESOLVED", resolvedAt: new Date(), assignedTo: actorId },
    }).catch(() => null);
    return toCouponPoolDto(row);
  }

  async setCouponInventory(id, { totalQuantity = undefined, assignedQuantity = undefined, scope = undefined } = {}) {
    const current = await this.db.couponCodeMaster.findUnique({ where: { id } });
    if (!current) {
      const err = new Error("Coupon not found");
      err.status = 404;
      throw err;
    }
    const nextTotal = totalQuantity !== undefined ? totalQuantity : current.totalQuantity;
    const nextAssigned =
      assignedQuantity !== undefined ? Number(assignedQuantity) : current.assignedQuantity;
    if (nextTotal != null && nextAssigned > Number(nextTotal)) {
      const err = new Error("assignedQuantity cannot exceed totalQuantity");
      err.status = 400;
      throw err;
    }
    const updated = await this.db.couponCodeMaster.update({
      where: { id },
      data: {
        ...(totalQuantity !== undefined ? { totalQuantity } : {}),
        ...(assignedQuantity !== undefined ? { assignedQuantity: nextAssigned } : {}),
        ...(scope ? { scope: String(scope).toUpperCase() } : {}),
      },
      include: {
        supplierCampaign: {
          select: {
            supplierCampaignId: true,
            campaignName: true,
            merchantNameRaw: true,
            merchant: { select: { displayName: true } },
          },
        },
      },
    });
    return toCouponPoolDto(updated);
  }

  // ─── Raw Network Performance (14E) ──────────────────────────────────────
  async listNetworkPerformance({
    network = null,
    from = null,
    to = null,
    date = null,
    brand = null,
    campaignType = null,
    status = null,
    q = null,
    skip = 0,
    take = 50,
  } = {}) {
    const where = {};
    const and = [];
    if (network) where.supplier = String(network).toUpperCase();
    if (brand) where.brandName = { contains: String(brand), mode: "insensitive" };
    const channel = normalizePerformanceChannelFilter(campaignType);
    if (channel) where.campaignChannelType = channel;

    const day = date ? new Date(`${String(date).slice(0, 10)}T00:00:00.000Z`) : null;
    if (day && !Number.isNaN(day.getTime())) {
      where.reportDate = day;
    } else if (from || to) {
      where.reportDate = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }

    const term = q ? String(q).trim() : "";
    if (term) {
      and.push({
        OR: [
          { brandName: { contains: term, mode: "insensitive" } },
          { campaignName: { contains: term, mode: "insensitive" } },
          { couponCode: { contains: term, mode: "insensitive" } },
          { reportExternalId: { contains: term, mode: "insensitive" } },
          { networkClickId: { contains: term, mode: "insensitive" } },
          { mboClickId: { contains: term, mode: "insensitive" } },
          { supplierCampaignId: { contains: term, mode: "insensitive" } },
          { campaignSourceId: { contains: term, mode: "insensitive" } },
        ],
      });
    }

    const statusTerm = status ? String(status).trim() : "";
    if (statusTerm) {
      and.push({
        OR: [
          { attributionStatus: { equals: statusTerm, mode: "insensitive" } },
          { reconciliationStatus: { equals: statusTerm, mode: "insensitive" } },
        ],
      });
    }
    if (and.length) where.AND = and;

    const [rows, total, aggregates] = await Promise.all([
      this.db.networkPerformanceFact.findMany({
        where,
        include: { supplierCampaign: PERFORMANCE_CAMPAIGN_INCLUDE },
        orderBy: { reportDate: "desc" },
        skip,
        take,
      }),
      this.db.networkPerformanceFact.count({ where }),
      this.db.networkPerformanceFact.aggregate({
        where,
        _sum: {
          networkClicks: true,
          mboLinkClicks: true,
          grossOrders: true,
          confirmedOrders: true,
          grossCommission: true,
          confirmedCommission: true,
          mboReceivable: true,
        },
      }),
    ]);

    const attached = await this.attachMissingSupplierCampaigns(rows);

    return {
      total,
      items: attached.map(toNetworkPerformanceDto),
      kpis: {
        networkClicks: aggregates._sum.networkClicks,
        linkClicks: aggregates._sum.networkClicks,
        mboLinkClicks: aggregates._sum.mboLinkClicks,
        grossOrders: aggregates._sum.grossOrders,
        confirmedOrders: aggregates._sum.confirmedOrders,
        netOrders: aggregates._sum.confirmedOrders,
        grossCommission: money(aggregates._sum.grossCommission),
        confirmedCommission: money(aggregates._sum.confirmedCommission),
        netCommission: money(aggregates._sum.confirmedCommission),
        mboReceivable: money(aggregates._sum.mboReceivable),
      },
    };
  }

  /**
   * Attach SupplierCampaign when FK/include is missing.
   * Prefer supplierCampaignId; fall back to unique campaignName match within supplier+account.
   * Ambiguous names (e.g. "CPS") stay unjoined — never invent.
   */
  async attachMissingSupplierCampaigns(rows = []) {
    const missingId = rows.filter((r) => !r.supplierCampaign && r.supplierCampaignId);
    const missingName = rows.filter(
      (r) => !r.supplierCampaign && !r.supplierCampaignId && r.campaignName,
    );
    if (!missingId.length && !missingName.length) return rows;

    const byIdKey = new Map();
    if (missingId.length) {
      const campaigns = await this.db.supplierCampaign.findMany({
        where: {
          OR: missingId.map((r) => ({
            supplier: r.supplier,
            sourceAccountLabel: r.sourceAccountLabel || "default",
            supplierCampaignId: String(r.supplierCampaignId),
          })),
        },
        ...PERFORMANCE_CAMPAIGN_INCLUDE,
      });
      for (const c of campaigns) {
        byIdKey.set(`${c.supplier}|${c.sourceAccountLabel}|${c.supplierCampaignId}`, c);
      }
    }

    /** @type {Map<string, object|null>} null = ambiguous */
    const byNameKey = new Map();
    if (missingName.length) {
      /** @type {Map<string, { supplier: string, account: string, campaignName: string }>} */
      const nameQueries = new Map();
      for (const r of missingName) {
        const campaignName = String(r.campaignName).trim();
        const key = `${r.supplier}|${r.sourceAccountLabel || "default"}|${campaignName.toLowerCase()}`;
        if (!nameQueries.has(key)) {
          nameQueries.set(key, {
            supplier: r.supplier,
            account: r.sourceAccountLabel || "default",
            campaignName,
          });
        }
      }
      for (const [key, q] of nameQueries) {
        const matches = await this.db.supplierCampaign.findMany({
          where: {
            supplier: q.supplier,
            sourceAccountLabel: q.account,
            campaignName: { equals: q.campaignName, mode: "insensitive" },
          },
          ...PERFORMANCE_CAMPAIGN_INCLUDE,
          take: 3,
        });
        byNameKey.set(key, matches.length === 1 ? matches[0] : null);
      }
    }

    return rows.map((r) => {
      if (r.supplierCampaign) return r;
      if (r.supplierCampaignId) {
        const key = `${r.supplier}|${r.sourceAccountLabel || "default"}|${r.supplierCampaignId}`;
        const sc = byIdKey.get(key);
        return sc ? { ...r, supplierCampaign: sc } : r;
      }
      if (!r.campaignName) return r;
      const nameKey = `${r.supplier}|${r.sourceAccountLabel || "default"}|${String(r.campaignName).trim().toLowerCase()}`;
      const sc = byNameKey.get(nameKey);
      return sc ? { ...r, supplierCampaign: sc } : r;
    });
  }

  async upsertNetworkPerformanceFact(input = {}) {
    const grainKey =
      input.grainKey ||
      networkGrainKey([
        input.supplier,
        input.sourceAccountLabel || "default",
        input.reportDate,
        input.supplierCampaignId,
        input.couponCode,
        input.currency,
        input.country,
        input.campaignSourceId,
        input.customerType,
      ]);
    const existing = await this.db.networkPerformanceFact.findUnique({
      where: { grainKey },
      select: { couponCode: true, couponId: true },
    });
    const data = { ...input, grainKey };
    // Preserve conversion-enriched coupon when reporting re-sync omits voucher.
    if ((data.couponCode == null || data.couponCode === "") && existing?.couponCode) {
      data.couponCode = existing.couponCode;
      if (data.couponId == null && existing.couponId) data.couponId = existing.couponId;
    }
    delete data.id;
    return this.db.networkPerformanceFact.upsert({
      where: { grainKey },
      create: data,
      update: { ...data, lastUpdatedAt: new Date() },
    });
  }

  // ─── Reconciliation 14H ─────────────────────────────────────────────────
  async listNetworkReconciliation({ billingMonth = null, billingYear = null, network = null, skip = 0, take = 50 } = {}) {
    const where = {};
    if (billingMonth) where.billingMonth = Number(billingMonth);
    if (billingYear) where.billingYear = Number(billingYear);
    if (network) where.supplier = String(network).toUpperCase();
    const [rows, total] = await Promise.all([
      this.db.networkReconciliationRow.findMany({
        where,
        orderBy: [{ billingYear: "desc" }, { billingMonth: "desc" }],
        skip,
        take,
      }),
      this.db.networkReconciliationRow.count({ where }),
    ]);
    return {
      total,
      items: rows.map((r) => {
        const meta = r.metadata && typeof r.metadata === "object" ? r.metadata : {};
        const checks = Array.isArray(meta.reconciliationChecks) ? meta.reconciliationChecks : [];
        return {
          id: r.id,
          network: r.supplier,
          networkAccount: r.sourceAccountLabel,
          billingMonth: r.billingMonth,
          billingYear: r.billingYear,
          brandName: r.brandName,
          campaignName: r.campaignName,
          campaignSourceId: r.campaignSourceId,
          reported: money(r.reportedCommission),
          confirmed: money(r.confirmedCommission),
          paid: money(r.paidCommission),
          reportedVsConfirmed: money(r.reportedVsConfirmed),
          confirmedVsPaid: money(r.confirmedVsPaid),
          status: r.status,
          currency: r.currency,
          reconciledAt: r.reconciledAt?.toISOString?.() || null,
          orderDrilldown: r.orderDrilldown,
          reconciliationChecks: checks,
          blockClientPayable: meta.blockClientPayable === true,
          networkOrderCount: meta.networkOrderCount ?? null,
          mboOrderCount: meta.mboOrderCount ?? null,
          mboGrossNetworkCommission: money(meta.mboGrossNetworkCommission),
          mboActualReceiptAmount: money(meta.mboActualReceiptAmount),
          clientPayableAmount: money(meta.clientPayableAmount),
        };
      }),
    };
  }

  /**
   * Rebuild reconciliation rows from NetworkPerformanceFact + Order payment evidence.
   * Reported = fact.grossCommission / confirmedCommission; Confirmed = confirmedCommission;
   * Paid = paidCommission / mboActuallyReceived.
   * When billingMonth/Year omitted, rebuilds the latest period that has orders (or current UTC month).
   */
  async rebuildNetworkReconciliation({ billingMonth = null, billingYear = null } = {}) {
    let month = Number(billingMonth);
    let year = Number(billingYear);
    if (!month || !year) {
      const latestOrder = await this.db.order.findFirst({
        where: { orderDate: { not: null } },
        select: { orderDate: true },
        orderBy: { orderDate: "desc" },
      });
      if (latestOrder?.orderDate) {
        const d = latestOrder.orderDate instanceof Date ? latestOrder.orderDate : new Date(latestOrder.orderDate);
        month = d.getUTCMonth() + 1;
        year = d.getUTCFullYear();
      } else {
        const now = new Date();
        month = now.getUTCMonth() + 1;
        year = now.getUTCFullYear();
      }
    }
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 0, 23, 59, 59));

    const facts = await this.db.networkPerformanceFact.findMany({
      where: { reportDate: { gte: from, lte: to } },
    });

    const reconciliation = new ReconciliationService({ prisma: this.db });

    const byKey = new Map();
    for (const f of facts) {
      const key = networkGrainKey([
        f.supplier,
        f.sourceAccountLabel,
        year,
        month,
        f.campaignSourceId,
        f.currency,
      ]);
      const cur = byKey.get(key) || {
        grainKey: key,
        supplier: f.supplier,
        sourceAccountLabel: f.sourceAccountLabel,
        billingMonth: month,
        billingYear: year,
        campaignSourceId: f.campaignSourceId,
        supplierCampaignId: f.supplierCampaignId,
        brandName: f.brandName,
        campaignName: f.campaignName,
        currency: f.currency,
        reportedCommission: 0,
        confirmedCommission: 0,
        paidCommission: 0,
        networkOrderCount: 0,
        mboOrderCount: 0,
        mboGrossNetworkCommission: 0,
        mboActualReceiptAmount: 0,
        clientPayableAmount: 0,
        orders: [],
      };
      cur.reportedCommission += Number(f.grossCommission ?? f.confirmedCommission ?? 0);
      cur.confirmedCommission += Number(f.confirmedCommission ?? 0);
      cur.paidCommission += Number(f.paidCommission ?? 0);
      cur.networkOrderCount += Number(f.confirmedOrders ?? f.grossOrders ?? 0);
      byKey.set(key, cur);
    }

    const orders = await this.db.order.findMany({
      where: {
        orderDate: { gte: from, lte: to },
      },
      include: {
        financialTransactions: {
          select: {
            supplierReceivable: true,
            clientPayable: true,
            transactionType: true,
            originalCurrency: true,
            metadata: true,
            calculationMetadata: true,
          },
          take: 20,
        },
        campaignSource: { select: { id: true } },
        merchant: { select: { displayName: true } },
        canonicalCampaign: { select: { displayName: true } },
      },
    });

    for (const o of orders) {
      const key = networkGrainKey([
        o.supplier,
        o.sourceAccountLabel,
        year,
        month,
        o.campaignSourceId,
        o.currency,
      ]);
      const cur = byKey.get(key) || {
        grainKey: key,
        supplier: o.supplier,
        sourceAccountLabel: o.sourceAccountLabel,
        billingMonth: month,
        billingYear: year,
        campaignSourceId: o.campaignSourceId,
        brandName: o.merchant?.displayName,
        campaignName: o.canonicalCampaign?.displayName,
        currency: o.currency,
        reportedCommission: 0,
        confirmedCommission: 0,
        paidCommission: 0,
        networkOrderCount: 0,
        mboOrderCount: 0,
        mboGrossNetworkCommission: 0,
        mboActualReceiptAmount: 0,
        clientPayableAmount: 0,
        orders: [],
      };

      let recv = 0;
      let clientPay = 0;
      for (const t of o.financialTransactions || []) {
        const sup = Number(t.supplierReceivable || 0);
        const cli = Number(t.clientPayable || 0);
        if (t.transactionType === "REVERSAL") {
          recv -= sup;
          clientPay -= cli;
        } else {
          recv += sup;
          clientPay += cli;
        }
      }

      if (o.validationStatus === "VALIDATION_APPROVED") {
        cur.mboGrossNetworkCommission += recv;
        cur.clientPayableAmount += clientPay;
      }
      cur.mboOrderCount += 1;

      const receipt = extractMboActualReceipt({
        order: o,
        financialTransactions: o.financialTransactions,
      });
      if (receipt) {
        const receiptAmt =
          receipt.amount != null ? Number(receipt.amount) : recv;
        cur.mboActualReceiptAmount += Number.isFinite(receiptAmt) ? receiptAmt : 0;
      }

      if (cur.confirmedCommission === 0 && o.validationStatus === "VALIDATION_APPROVED") {
        cur.confirmedCommission += recv;
      }
      if (cur.reportedCommission === 0) {
        cur.reportedCommission += recv;
      }

      cur.orders.push({
        networkOrderId: o.supplierOrderId,
        campaignSourceId: o.campaignSourceId,
        payable: recv,
        paymentStatus: o.supplierPaymentStatus,
      });
      byKey.set(key, cur);
    }

    const upserts = [];
    for (const row of byKey.values()) {
      const reportedVsConfirmed = Number(row.reportedCommission) - Number(row.confirmedCommission);
      const confirmedVsPaid = Number(row.confirmedCommission) - Number(row.paidCommission);

      const reconResult = await reconciliation.reconcileNetworkGrain({
        grainKey: row.grainKey,
        supplier: row.supplier,
        billingMonth: month,
        billingYear: year,
        inputs: {
          networkOrderCount: row.networkOrderCount || null,
          mboOrderCount: row.mboOrderCount || null,
          networkCommission: row.reportedCommission || null,
          mboGrossNetworkCommission: row.mboGrossNetworkCommission || null,
          networkInvoiceAmount: row.confirmedCommission || null,
          networkPaymentAmount: row.paidCommission || null,
          mboActualReceiptAmount: row.mboActualReceiptAmount || null,
          clientPayableAmount: row.clientPayableAmount || null,
        },
      });

      const status = resolveNetworkReconRowStatus(reconResult);
      const metadata = {
        reconciliationChecks: reconResult.checks,
        blockClientPayable: reconResult.blockClientPayable,
        networkOrderCount: row.networkOrderCount,
        mboOrderCount: row.mboOrderCount,
        mboGrossNetworkCommission: row.mboGrossNetworkCommission,
        mboActualReceiptAmount: row.mboActualReceiptAmount,
        clientPayableAmount: row.clientPayableAmount,
      };

      upserts.push(
        this.db.networkReconciliationRow.upsert({
          where: { grainKey: row.grainKey },
          create: {
            grainKey: row.grainKey,
            supplier: row.supplier,
            sourceAccountLabel: row.sourceAccountLabel,
            billingMonth: month,
            billingYear: year,
            campaignSourceId: row.campaignSourceId,
            supplierCampaignId: row.supplierCampaignId,
            brandName: row.brandName,
            campaignName: row.campaignName,
            reportedCommission: row.reportedCommission,
            confirmedCommission: row.confirmedCommission,
            paidCommission: row.paidCommission,
            reportedVsConfirmed,
            confirmedVsPaid,
            status,
            currency: row.currency,
            reconciledAt: new Date(),
            orderDrilldown: row.orders.slice(0, 50),
            metadata,
          },
          update: {
            reportedCommission: row.reportedCommission,
            confirmedCommission: row.confirmedCommission,
            paidCommission: row.paidCommission,
            reportedVsConfirmed,
            confirmedVsPaid,
            status,
            brandName: row.brandName,
            campaignName: row.campaignName,
            reconciledAt: new Date(),
            orderDrilldown: row.orders.slice(0, 50),
            metadata,
          },
        }),
      );
    }
    await Promise.all(upserts);
    return this.listNetworkReconciliation({ billingMonth: month, billingYear: year });
  }

  // ─── Mapping rules (filesystem SoT) ─────────────────────────────────────
  async listMappingRules({ network = null } = {}) {
    const { readdirSync, readFileSync, existsSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { NETWORK_MAPPINGS_ROOT } = await import("../mapping/loader.js");
    const root = NETWORK_MAPPINGS_ROOT;
    if (!existsSync(root)) return { total: 0, items: [] };

    const entityLabel = (key) => {
      const k = String(key || "").toLowerCase();
      if (k.includes("conversion") || k.includes("order") || k.includes("action")) return "Order";
      if (k.includes("track") || k.includes("click") || k.includes("link")) return "Tracking";
      if (k.includes("coupon") || k.includes("voucher") || k.includes("deal")) return "Coupon";
      if (k.includes("product")) return "Product";
      if (k.includes("commission")) return "Commission";
      if (k.includes("campaign") || k.includes("offer")) return "Campaign";
      return String(key || "Entity")
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    };

    const classifyRuleType = (entity, rawField, mboField) => {
      const mbo = String(mboField || "").toLowerCase();
      const raw = String(rawField || "").toLowerCase();
      const ent = String(entity || "").toLowerCase();
      if (
        /status|state|participation|relationship|contractstatus|application_status/.test(mbo) ||
        /status|state|application_status|contractstatus|allocated/.test(raw.split("|")[0] || "")
      ) {
        return "Status Mapping";
      }
      if (
        ent === "Tracking" ||
        /subid|sub_id|pubref|adref|clickref|trackingparam/.test(`${mbo}|${raw}`) ||
        /^p[123]$/.test((raw.split("|")[0] || "").trim())
      ) {
        return "Tracking Param";
      }
      return "Field Mapping";
    };

    const slugRuleId = (networkName, entity, raw, mbo) => {
      const seed = [networkName, entity, (raw || "").split("|")[0] || mbo || "field"]
        .join("_")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 72);
      return `map_${seed}`;
    };

    const networkLabel = (supplier) => {
      const s = String(supplier || "").toUpperCase();
      const labels = {
        OPTIMISE: "Optimise",
        PARTNERIZE: "Partnerize",
        BOOSTINY: "Boostiny",
        TRACKIER: "Trackier",
        IMPACT: "Impact",
      };
      return labels[s] || s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    };

    const suppliers = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const items = [];
    for (const supplierDir of suppliers) {
      const supplier = String(supplierDir).toUpperCase();
      if (network && supplier !== String(network).toUpperCase()) continue;
      const dir = join(root, supplierDir);
      const files = readdirSync(dir).filter((f) => f.endsWith(".mapping.json"));
      for (const file of files) {
        const fullPath = join(dir, file);
        let def = {};
        let lastUpdated = null;
        try {
          def = JSON.parse(readFileSync(fullPath, "utf8"));
          lastUpdated = statSync(fullPath).mtime.toISOString();
        } catch {
          continue;
        }
        const entityKey = def.resourceKey || file.replace(/\.mapping\.json$/, "");
        const entity = entityLabel(entityKey);
        const fields = Array.isArray(def.fields) ? def.fields : [];
        if (!fields.length) {
          items.push({
            ruleId: slugRuleId(supplierDir, entity, null, entityKey),
            network: networkLabel(supplier),
            networkKey: supplier,
            entity,
            rawField: null,
            mboField: null,
            transform: null,
            ruleType: "Field Mapping",
            status: "ACTIVE",
            lastUpdated,
            qa: false,
            sourceFile: `${supplierDir}/${file}`,
          });
          continue;
        }
        for (const f of fields) {
          const raw =
            f.source ||
            (Array.isArray(f.sources) ? f.sources.join("|") : null) ||
            f.path ||
            null;
          const mboField = f.targetField || f.target || f.to || null;
          const quality = String(f.quality || "").toUpperCase();
          const notes = String(f.notes || "");
          const qa =
            quality === "REQUIRED" ||
            /verified|qa\s*yes|master:/i.test(notes) ||
            Boolean(f.required && quality === "IMPORTANT");
          items.push({
            ruleId: slugRuleId(supplierDir, entity, raw, mboField),
            network: networkLabel(supplier),
            networkKey: supplier,
            entity,
            rawField: raw,
            mboField,
            transform: f.transform || null,
            ruleType: classifyRuleType(entity, raw, mboField),
            status: "ACTIVE",
            lastUpdated,
            qa,
            sourceFile: `${supplierDir}/${file}`,
            required: Boolean(f.required),
            quality: f.quality || null,
            notes: f.notes || null,
          });
        }
      }
    }
    items.sort((a, b) => String(a.ruleId).localeCompare(String(b.ruleId)));
    return { total: items.length, items };
  }

  // ─── Supplier commission rules (CSV Commission Rules entity) ─────────────
  async listSupplierCommissionRules({
    network = null,
    q = null,
    skip = 0,
    take = 25,
  } = {}) {
    const where = {};
    if (network) where.supplier = String(network).toUpperCase();
    if (q) {
      const term = String(q).trim();
      where.OR = [
        { id: { contains: term, mode: "insensitive" } },
        { supplierRuleType: { contains: term, mode: "insensitive" } },
        { sourceAccountLabel: { contains: term, mode: "insensitive" } },
      ];
    }

    const [totalDb, dbRows] = await Promise.all([
      this.db.supplierCommissionRule.count({ where }),
      this.db.supplierCommissionRule.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip,
        take,
        include: {
          campaignSource: {
            include: {
              supplierCampaign: {
                select: {
                  id: true,
                  campaignName: true,
                  merchantNameRaw: true,
                  supplier: true,
                  supplierCampaignId: true,
                  countryCodes: true,
                  categoryName: true,
                },
              },
            },
          },
        },
      }),
    ]);

    if (totalDb > 0) {
      const items = dbRows.map((row) =>
        toSupplierCommissionRuleDto(row, {
          supplierCampaign: row.campaignSource?.supplierCampaign,
          campaignSource: row.campaignSource,
        }),
      );
      return { total: totalDb, items };
    }

    // Fallback: project summary rules from SupplierCampaign commission facts (CSV: campaign summary ≠ rule registry).
    const campWhere = {
      OR: [
        { defaultCommissionValue: { not: null } },
        { commissionGroups: { not: null } },
      ],
      ...(network ? { supplier: String(network).toUpperCase() } : {}),
    };
    if (q) {
      const term = String(q).trim();
      campWhere.AND = [
        {
          OR: [
            { campaignName: { contains: term, mode: "insensitive" } },
            { merchantNameRaw: { contains: term, mode: "insensitive" } },
            { supplierCampaignId: { contains: term, mode: "insensitive" } },
          ],
        },
      ];
    }

    const [totalCamp, camps] = await Promise.all([
      this.db.supplierCampaign.count({ where: campWhere }),
      this.db.supplierCampaign.findMany({
        where: campWhere,
        orderBy: { updatedAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          supplier: true,
          campaignName: true,
          merchantNameRaw: true,
          supplierCampaignId: true,
          defaultCommissionValue: true,
          commissionUnit: true,
          commissionCurrency: true,
          currencyCode: true,
          countryCodes: true,
          categoryName: true,
          commissionGroups: true,
          updatedAt: true,
        },
      }),
    ]);

    const items = camps.map((sc) =>
      toSupplierCommissionRuleDto(
        {
          id: `projected:${sc.id}`,
          supplier: sc.supplier,
          supplierRuleType: String(sc.commissionUnit || "").toUpperCase() === "PERCENT" ? "PERCENT" : "FIXED",
          basis: String(sc.commissionUnit || "").toUpperCase() === "PERCENT" ? "PERCENT_OF_SALE" : "FIXED_AMOUNT",
          ratePercent:
            sc.defaultCommissionValue != null && String(sc.commissionUnit || "").toUpperCase() === "PERCENT"
              ? Number(sc.defaultCommissionValue)
              : null,
          fixedAmount:
            sc.defaultCommissionValue != null && String(sc.commissionUnit || "").toUpperCase() !== "PERCENT"
              ? Number(sc.defaultCommissionValue)
              : null,
          currency: sc.commissionCurrency || sc.currencyCode,
          country: Array.isArray(sc.countryCodes) ? sc.countryCodes.join(", ") : null,
          categoryProductGoal: sc.categoryName,
          mappingStatus:
            (Array.isArray(sc.commissionGroups) ? sc.commissionGroups.length : 0) || sc.defaultCommissionValue != null
              ? "MAPPED"
              : "NEEDS_REVIEW",
          sourcePath:
            String(sc.commissionUnit || "").toUpperCase() === "PERCENT"
              ? "default_commission_rate / commission"
              : "defaultCommissionValue / commissionGroups",
          projected: true,
          updatedAt: sc.updatedAt,
        },
        { supplierCampaign: sc },
      ),
    );

    return { total: totalCamp, items };
  }

  async createTestSupplierCommissionRule(input = {}) {
    const supplier = String(input.networkSource || input.supplier || "IMPACT").toUpperCase();
    const row = await this.db.supplierCommissionRule.create({
      data: {
        supplier,
        sourceAccountLabel: input.sourceAccountLabel || "test",
        supplierRuleType: input.commissionType || "PERCENT",
        basis: "PERCENT_OF_SALE",
        ratePercent: input.ratePercent != null ? Number(input.ratePercent) : 5,
        currency: (input.currency || "USD").slice(0, 3).toUpperCase(),
        effectiveFrom: new Date(),
        metadata: {
          supplierRuleId: input.supplierCommissionRuleId || `SCR-TEST-${Date.now()}`,
          brandName: input.brandName || "Test Brand",
          campaignName: input.campaignName || "Test Campaign",
          customerType: input.customerType || "New Customer",
          country: input.country || null,
          scope: input.categoryProductGoal || "All Products",
          sourceFieldPath: "manual test rule",
          mappingStatus: "MAPPED",
        },
      },
    });
    return { id: row.id, created: true };
  }

  // ─── Credentials platforms ──────────────────────────────────────────────
  static supportedCredentialPlatforms() {
    return [
      "boostiny",
      "optimise_sea",
      "optimise_mena",
      "optimise_uk",
      "trackier",
      "partnerize",
      "impact",
    ];
  }
}
