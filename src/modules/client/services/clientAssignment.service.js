import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import { ASSIGNMENT_LIFECYCLE } from "../constants.js";
import { CatalogRepository } from "../../catalog/repositories/catalog.repository.js";
import { CatalogService } from "../../catalog/services/catalog.service.js";
import { ClientRepository } from "../repositories/client.repository.js";
import { ClientBrandRequestRepository } from "../repositories/clientBrandRequest.repository.js";
import { ClientCampaignAssignmentRepository } from "../repositories/clientCampaignAssignment.repository.js";
import { CouponAssignmentRepository } from "../../commercial/repositories/commercial.repository.js";
import { extractCouponFieldsFromNormalized } from "../../coupons/couponMerge.js";
import { buildAllotmentDisplayFields } from "../../coupons/allotmentFields.js";
import { ClientVisibilityService } from "./visibility.service.js";
import { CampaignEligibilityService } from "./campaignEligibility.service.js";
import { CommissionRuleRepository } from "../../commercial/repositories/commercial.repository.js";
import { deriveMboCommission } from "../../commercial/commissionMath.js";
import { resolveCommercialPreset } from "../constants/commercialModels.js";
import { auditService } from "../../../platform/audit/audit.service.js";

function resolveCouponType(fields = {}) {
  const codeType = String(fields.codeType ?? "")
    .trim()
    .toLowerCase();
  if (codeType === "link") return "LINK";
  if (codeType === "code" || codeType === "both") return "CODE";
  if (fields.couponLink && !fields.couponCode) return "LINK";
  if (fields.couponCode) return "CODE";
  return "UNKNOWN";
}

/** §11 — draft reserves inventory; publish assigns. */
function couponStatusForAssignment({ published }) {
  return published ? "ASSIGNED" : "RESERVED";
}

export class ClientAssignmentService {
  constructor(deps = {}) {
    this.assignmentRepo = deps.assignmentRepo ?? new ClientCampaignAssignmentRepository();
    this.clientRepo = deps.clientRepo ?? new ClientRepository();
    this.catalogRepo = deps.catalogRepo ?? new CatalogRepository();
    this.catalogService = deps.catalogService ?? new CatalogService();
    this.requestRepo = deps.requestRepo ?? new ClientBrandRequestRepository();
    this.couponAssignmentRepo = deps.couponAssignmentRepo ?? new CouponAssignmentRepository();
    this.visibility = deps.visibility ?? new ClientVisibilityService();
    this.eligibility = deps.eligibility ?? new CampaignEligibilityService({ visibility: this.visibility });
    this.commissionRepo = deps.commissionRepo ?? new CommissionRuleRepository();
    this.db = deps.prisma ?? prisma;
    this.audit = deps.audit ?? auditService;
  }

  validateCatalogForAssignment(catalogCampaign, { client = null, sources = [], hasCouponAssignment = false, preferredSource = null } = {}) {
    if (!this.visibility.isCatalogAssignable(catalogCampaign)) {
      if (catalogCampaign?.status === "ARCHIVED" || catalogCampaign?.deletedAt) {
        throw fail("Cannot assign an archived catalog campaign.", 409);
      }
      if (catalogCampaign?.visibility === "HIDDEN") {
        throw fail("Cannot assign a hidden catalog campaign.", 409);
      }
      throw fail("Catalog campaign is not assignable.", 409);
    }

    const result = this.eligibility.evaluate({
      mode: "assign",
      catalogCampaign,
      client,
      sources,
      hasCouponAssignment,
      preferredSource,
    });
    if (!result.ok) {
      throw fail(
        `Cannot assign campaign. Reason: ${
          result.reasonLabels?.join("; ") || result.reasons.join(", ")
        }`,
        409,
      );
    }
    return result;
  }

  async loadCatalogSources(canonicalCampaignId, tx) {
    const db =
      tx?.campaignSource?.findMany ? tx : this.db;
    if (!db?.campaignSource?.findMany) return [];
    return db.campaignSource.findMany({
      where: { canonicalCampaignId, isActive: true },
      include: {
        supplierCampaign: {
          include: {
            coupons: {
              where: { couponStatus: { in: ["ACTIVE", "SCHEDULED", "UNKNOWN"] } },
              take: 25,
              select: {
                couponCode: true,
                couponLink: true,
                couponStatus: true,
                discountValue: true,
                couponEndDate: true,
              },
            },
          },
        },
      },
      orderBy: [{ isPrimary: "desc" }, { priority: "asc" }],
    });
  }

  /** Batch-load sources for many campaigns — avoids N+1 on allocation lists. */
  async loadCatalogSourcesByCampaignIds(canonicalCampaignIds = [], tx) {
    const ids = [...new Set((canonicalCampaignIds || []).filter(Boolean))];
    const map = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return map;
    const db = tx?.campaignSource?.findMany ? tx : this.db;
    if (!db?.campaignSource?.findMany) return map;
    const rows = await db.campaignSource.findMany({
      where: { canonicalCampaignId: { in: ids }, isActive: true },
      include: {
        supplierCampaign: {
          include: {
            coupons: {
              where: { couponStatus: { in: ["ACTIVE", "SCHEDULED", "UNKNOWN"] } },
              take: 25,
              select: {
                couponCode: true,
                couponLink: true,
                couponStatus: true,
                discountValue: true,
                couponEndDate: true,
              },
            },
          },
        },
      },
      orderBy: [{ isPrimary: "desc" }, { priority: "asc" }],
    });
    for (const row of rows) {
      const list = map.get(row.canonicalCampaignId) || [];
      list.push(row);
      map.set(row.canonicalCampaignId, list);
    }
    return map;
  }

  /**
   * Load a Coupon CMS Entity for allotment.
   * LEGACY / READ-ONLY / MIGRATION CANDIDATE path — coupon Entity is staging/CMS, not assignment SoT.
   * Supplier linkage is enrichment used to resolve CampaignSource when available.
   */
  async loadCouponCms(couponEntityId, tx) {
    const db = tx ?? prisma;
    const entity = await db.entity.findFirst({
      where: { id: couponEntityId, entityType: "coupon" },
    });
    if (!entity) throw fail("Coupon CMS coupon not found.", 404);

    const supplierCoupon = await db.supplierCoupon.findFirst({
      where: { entityId: couponEntityId },
      orderBy: { lastSyncedAt: "desc" },
    });

    return {
      entity,
      supplierCoupon: supplierCoupon ?? null,
      supplierCampaignId: supplierCoupon?.supplierCampaignId ?? null,
    };
  }

  async loadCampaignSource(campaignSourceId, tx) {
    const db =
      tx?.campaignSource?.findUnique || tx?.campaignSource?.findFirst
        ? tx
        : this.db;
    if (!db?.campaignSource?.findUnique) return null;
    return db.campaignSource.findUnique({
      where: { id: campaignSourceId },
      include: { supplierCampaign: true, canonicalCampaign: true },
    });
  }

  /**
   * Wave B canonical contract — assign client to CanonicalCampaign + CampaignSource.
   * Does not require Coupon Entity. Alias of createDraft for explicit callers.
   */
  async createClientCampaignAssignment(input, client = null) {
    return this.createDraft(input, client);
  }

  async resolveCampaignSourceId({
    campaignSourceId,
    canonicalCampaignId,
    supplierCampaignId,
    sources,
    tx,
  }) {
    if (campaignSourceId) {
      const source = await this.loadCampaignSource(campaignSourceId, tx);
      if (!source) throw fail("Campaign source not found.", 404);
      if (!source.isActive || source.status === "DEPRECATED") {
        throw fail("Campaign source is not active.", 409);
      }
      if (canonicalCampaignId && source.canonicalCampaignId !== canonicalCampaignId) {
        throw fail("Campaign source does not belong to the canonical campaign.", 409);
      }
      const catalogMerchantId = source.canonicalCampaign?.merchantId;
      const supplierMerchantId = source.supplierCampaign?.merchantId;
      if (catalogMerchantId && supplierMerchantId && catalogMerchantId !== supplierMerchantId) {
        throw fail("Campaign source merchant does not match canonical campaign merchant.", 409);
      }
      return source.id;
    }

    if (supplierCampaignId && sources?.length) {
      const match = sources.find((s) => s.supplierCampaignId === supplierCampaignId && s.isActive);
      if (match) return match.id;
    }

    const primary = sources?.find((s) => s.isPrimary && s.isActive) || sources?.find((s) => s.isActive);
    return primary?.id ?? null;
  }

  async createDraft(input, client = null) {
    const run = async (tx) => {
      const clientRecord =
        input.clientRecord ?? (await this.clientRepo.findById(input.clientId, {}, tx));
      if (!clientRecord) throw fail("Client not found.", 404);
      if (clientRecord.status === "OFFBOARDED") throw fail("Cannot assign campaigns to an offboarded client.", 409);

      let canonicalCampaignId = input.canonicalCampaignId ?? null;
      let campaignSourceId = input.campaignSourceId ?? null;
      let couponCms = input.couponCms ?? null;
      let supplierCampaignId = input.supplierCampaignId ?? null;

      // Resolve from explicit CampaignSource first (Wave B SoT).
      if (!canonicalCampaignId && campaignSourceId) {
        const source = await this.loadCampaignSource(campaignSourceId, tx);
        if (!source) throw fail("Campaign source not found.", 404);
        canonicalCampaignId = source.canonicalCampaignId;
        supplierCampaignId = supplierCampaignId ?? source.supplierCampaignId;
      }

      // Prefer supplier-normalized catalog path.
      if (!canonicalCampaignId && supplierCampaignId) {
        canonicalCampaignId = await this.catalogService.ensureFromSupplierCampaign(supplierCampaignId, tx);
      }

      // LEGACY: couponEntityId — bridge to supplier campaign when linked; else CMS catalog.
      if (!canonicalCampaignId && (couponCms?.entity || input.couponEntityId)) {
        if (!couponCms?.entity) {
          couponCms = await this.loadCouponCms(input.couponEntityId, tx);
        }
        if (couponCms.supplierCampaignId) {
          supplierCampaignId = supplierCampaignId ?? couponCms.supplierCampaignId;
          canonicalCampaignId = await this.catalogService.ensureFromSupplierCampaign(
            couponCms.supplierCampaignId,
            tx,
          );
        } else {
          canonicalCampaignId = await this.catalogService.ensureFromCouponCmsEntity(couponCms.entity, tx);
        }
      }

      if (!canonicalCampaignId) {
        throw fail(
          "canonicalCampaignId, campaignSourceId, supplierCampaignId, or couponEntityId is required.",
          400,
        );
      }

      if (couponCms?.entity == null && input.couponEntityId) {
        couponCms = await this.loadCouponCms(input.couponEntityId, tx);
        supplierCampaignId = supplierCampaignId ?? couponCms.supplierCampaignId;
      }

      const catalogCampaign = await this.catalogRepo.findById(canonicalCampaignId, {}, tx);
      if (!catalogCampaign) throw fail("Catalog campaign not found.", 404);
      const sources = await this.loadCatalogSources(canonicalCampaignId, tx);

      campaignSourceId = await this.resolveCampaignSourceId({
        campaignSourceId,
        canonicalCampaignId,
        supplierCampaignId,
        sources,
        tx,
      });

      // Canonical path requires CampaignSource — unlinked catalogs are not assignable.
      const usingLegacyCoupon = Boolean(couponCms?.entity || input.couponEntityId);
      if (!usingLegacyCoupon && !campaignSourceId) {
        throw fail(
          "Cannot assign campaign. Reason: Campaign source is not linked to an approved merchant.",
          409,
        );
      }

      if (campaignSourceId) {
        const preferred = sources.find((s) => s.id === campaignSourceId) || null;
        this.validateCatalogForAssignment(catalogCampaign, {
          client: clientRecord,
          sources,
          hasCouponAssignment: usingLegacyCoupon,
          preferredSource: preferred,
        });
      } else {
        this.validateCatalogForAssignment(catalogCampaign, {
          client: clientRecord,
          sources,
          hasCouponAssignment: usingLegacyCoupon,
        });
      }

      const duplicate = await this.assignmentRepo.findActiveByPair(
        { clientId: input.clientId, canonicalCampaignId },
        tx,
      );

      // Same campaign from another Coupon CMS row: attach coupon to the existing grant.
      if (duplicate && couponCms?.entity) {
        await this.createCouponAssignmentFromCms(duplicate.id, couponCms, tx, {
          published: Boolean(input.publish || duplicate.published),
        });
        if (!duplicate.campaignSourceId && campaignSourceId) {
          await this.assignmentRepo.update(duplicate.id, { campaignSourceId }, tx);
        }
        if (input.publish && !duplicate.published) {
          await this.activateCommissionRule(duplicate.id, tx);
          await this.assertPublishEligibility({
            assignmentId: duplicate.id,
            catalogCampaign,
            client: clientRecord,
            sources,
            hasCouponAssignment: true,
            preferredSource: sources.find((s) => s.id === (campaignSourceId || duplicate.campaignSourceId)),
            tx,
          });
          await this.promoteReservedCoupons(duplicate.id, tx);
          const published = await this.assignmentRepo.update(
            duplicate.id,
            {
              status: "ACTIVE",
              published: true,
              publishedAt: new Date(),
              unpublishedAt: null,
            },
            tx,
          );
          try {
            await this.audit.record({
              aggregateType: "ClientCampaignAssignment",
              aggregateId: published.id,
              action: "assignment.publish",
              after: { clientId: published.clientId, published: true },
              reason: "activation_review",
            });
          } catch {
            // best-effort
          }
          return published;
        }
        return { ...duplicate, _allotmentOutcome: "already_assigned" };
      }

      if (duplicate) {
        const err = fail(
          "An active assignment already exists for this client and catalog campaign.",
          409,
        );
        err.code = "ALREADY_ASSIGNED";
        err.existingAssignmentId = duplicate.id;
        throw err;
      }

      let created = await this.assignmentRepo.create(
        {
          clientId: input.clientId,
          canonicalCampaignId,
          campaignSourceId,
          status: "ASSIGNED",
          published: false,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          channel: input.channel ?? null,
          notes: input.notes ?? null,
          clientFacing: input.clientFacing ?? undefined,
        },
        tx,
      );

      if (couponCms?.entity) {
        await this.createCouponAssignmentFromCms(created.id, couponCms, tx, {
          published: Boolean(input.publish),
        });
      } else {
        await this.ensureCouponFromClientFacing(created.id, input.clientFacing, tx, {
          published: Boolean(input.publish),
        });
      }

      await this.ensureCommissionRuleDraft(created.id, clientRecord, input.clientFacing, tx);

      if (input.publish) {
        await this.activateCommissionRule(created.id, tx);
        await this.assertPublishEligibility({
          assignmentId: created.id,
          catalogCampaign,
          client: clientRecord,
          sources,
          hasCouponAssignment: Boolean(couponCms?.entity || input.clientFacing?.couponCode),
          preferredSource: sources.find((s) => s.id === campaignSourceId) || null,
          tx,
        });
        // If coupons were reserved first in this same tx under draft semantics, promote.
        await this.promoteReservedCoupons(created.id, tx);
        created = await this.assignmentRepo.update(
          created.id,
          {
            status: "ACTIVE",
            published: true,
            publishedAt: new Date(),
            unpublishedAt: null,
          },
          tx,
        );
        try {
          await this.audit.record({
            aggregateType: "ClientCampaignAssignment",
            aggregateId: created.id,
            action: "assignment.publish",
            after: {
              clientId: created.clientId,
              canonicalCampaignId: created.canonicalCampaignId,
              campaignSourceId: created.campaignSourceId,
              published: true,
            },
            reason: "activation_review",
          });
        } catch {
          // best-effort
        }
      }

      return created;
    };

    if (client) return run(client);
    return prisma.$transaction(run, {
      maxWait: 15_000,
      timeout: 45_000,
    });
  }

  async createCouponAssignmentFromCms(assignmentId, couponCms, tx, { published = false } = {}) {
    const status = couponStatusForAssignment({ published });
    const fields = extractCouponFieldsFromNormalized(couponCms.entity.normalizedData);
    const allotment = buildAllotmentDisplayFields(couponCms.entity);
    const couponType = resolveCouponType({
      ...fields,
      couponCode: couponCms.supplierCoupon?.couponCode ?? fields.couponCode,
      couponLink:
        couponCms.supplierCoupon?.couponLink ?? fields.couponLink ?? allotment.offerLink ?? allotment.trackingUrl,
    });
    const code =
      couponType === "LINK"
        ? couponCms.supplierCoupon?.couponLink ??
          fields.couponLink ??
          allotment.offerLink ??
          allotment.trackingUrl
        : couponCms.supplierCoupon?.couponCode ?? fields.couponCode;
    if (!code && couponType === "UNKNOWN") {
      // Still record a placeholder LINK from tracking/offer when present so redirect works.
      const fallback = allotment.offerLink || allotment.trackingUrl;
      if (!fallback) return null;
      const created = await this.couponAssignmentRepo.create(
        {
          assignmentId,
          supplierCouponId: couponCms.supplierCoupon?.id ?? null,
          supplierCouponCode: fallback,
          clientCouponCode: fallback,
          couponType: "LINK",
          discountPercentage: allotment.discountPercentage != null ? String(allotment.discountPercentage) : null,
          status,
          validFrom: couponCms.supplierCoupon?.couponStartDate ?? null,
          validUntil: couponCms.supplierCoupon?.couponEndDate ?? (allotment.expiryDate ? new Date(allotment.expiryDate) : null),
        },
        tx,
      );
      await this.auditCouponChange(created, "coupon.reserve", status);
      return created;
    }

    const discount =
      couponType === "CODE"
        ? couponCms.supplierCoupon?.discountValue ?? fields.discountPercentage ?? allotment.discountPercentage ?? null
        : allotment.discountPercentage ?? null;

    const created = await this.couponAssignmentRepo.create(
      {
        assignmentId,
        supplierCouponId: couponCms.supplierCoupon?.id ?? null,
        supplierCouponCode: code ?? null,
        clientCouponCode: code ?? null,
        couponType,
        discountPercentage: discount != null ? String(discount) : null,
        status,
        validFrom: couponCms.supplierCoupon?.couponStartDate ?? null,
        validUntil:
          couponCms.supplierCoupon?.couponEndDate ??
          (allotment.expiryDate ? new Date(allotment.expiryDate) : null),
      },
      tx,
    );
    await this.auditCouponChange(created, status === "RESERVED" ? "coupon.reserve" : "coupon.assign", status);
    return created;
  }

  async ensureCouponFromClientFacing(assignmentId, clientFacing, tx = null, { published = false } = {}) {
    const code = String(clientFacing?.couponCode || "").trim();
    const link = String(clientFacing?.trackingUrl || clientFacing?.couponLink || "").trim();
    if (!code && !link) return null;

    const db = tx ?? this.db;
    const existing = db.clientCouponAssignment?.findFirst
      ? await db.clientCouponAssignment.findFirst({
          where: { assignmentId, status: { in: ["RESERVED", "ASSIGNED", "ACTIVE"] } },
        })
      : null;
    if (existing) return existing;

    const status = couponStatusForAssignment({ published });
    const created = await this.couponAssignmentRepo.create(
      {
        assignmentId,
        supplierCouponId: null,
        supplierCouponCode: code || link || null,
        clientCouponCode: code || link || null,
        couponType: code ? "CODE" : "LINK",
        discountPercentage: null,
        status,
        validFrom: null,
        validUntil: clientFacing?.expiry ? new Date(clientFacing.expiry) : null,
      },
      tx,
    );
    await this.auditCouponChange(created, status === "RESERVED" ? "coupon.reserve" : "coupon.assign", status);
    return created;
  }

  async auditCouponChange(record, action, status) {
    if (!record?.id) return;
    try {
      await this.audit.record({
        aggregateType: "ClientCouponAssignment",
        aggregateId: record.id,
        action,
        after: {
          assignmentId: record.assignmentId,
          status,
          supplierCouponCode: record.supplierCouponCode,
          clientCouponCode: record.clientCouponCode,
        },
      });
    } catch {
      // best-effort
    }
  }

  async promoteReservedCoupons(assignmentId, client = null) {
    const result = await this.couponAssignmentRepo.updateManyForAssignment(
      assignmentId,
      { status: "RESERVED" },
      { status: "ASSIGNED" },
      client,
    );
    if (result?.count) {
      try {
        await this.audit.record({
          aggregateType: "ClientCampaignAssignment",
          aggregateId: assignmentId,
          action: "coupon.assign_from_reserve",
          after: { promotedCount: result.count, status: "ASSIGNED" },
        });
      } catch {
        // best-effort
      }
    }
    return result;
  }

  async releaseReservedCoupons(assignmentId, client = null) {
    const result = await this.couponAssignmentRepo.updateManyForAssignment(
      assignmentId,
      { status: "RESERVED" },
      { status: "REVOKED" },
      client,
    );
    if (result?.count) {
      try {
        await this.audit.record({
          aggregateType: "ClientCampaignAssignment",
          aggregateId: assignmentId,
          action: "coupon.release_reservation",
          after: { releasedCount: result.count, status: "REVOKED" },
        });
      } catch {
        // best-effort
      }
    }
    return result;
  }

  async ensureCommissionRuleDraft(assignmentId, clientRecord, clientFacing = {}, tx = null) {
    const db = tx ?? this.db;
    const model = clientRecord?.commercialModel || "OFFERS_PLUS_COMMISSION";
    const share =
      clientFacing?.clientCommissionPercent ??
      clientRecord?.clientSharePercent ??
      undefined;
    const preset = resolveCommercialPreset(model, share);
    if (!preset) return null;

    const mboCommission = deriveMboCommission(preset.grossCommission, preset.clientCommission);
    const existing = await db.clientCommissionRule.findFirst({
      where: { assignmentId, status: { in: ["DRAFT", "EFFECTIVE"] } },
      orderBy: [{ status: "desc" }, { effectiveFrom: "desc" }],
    });
    if (existing) return existing;

    const effectiveFrom = new Date();
    try {
      return await db.clientCommissionRule.create({
        data: {
          assignmentId,
          grossCommission: preset.grossCommission,
          clientCommission: preset.clientCommission,
          mboCommission,
          commissionType: preset.commissionType,
          effectiveFrom,
          effectiveUntil: null,
          status: "DRAFT",
        },
      });
    } catch {
      effectiveFrom.setSeconds(effectiveFrom.getSeconds() + 1);
      return db.clientCommissionRule.create({
        data: {
          assignmentId,
          grossCommission: preset.grossCommission,
          clientCommission: preset.clientCommission,
          mboCommission,
          commissionType: preset.commissionType,
          effectiveFrom,
          effectiveUntil: null,
          status: "DRAFT",
        },
      });
    }
  }

  async activateCommissionRule(assignmentId, tx = null) {
    const db = tx ?? this.db;
    const rule = await db.clientCommissionRule.findFirst({
      where: { assignmentId, status: { in: ["DRAFT", "EFFECTIVE"] } },
      orderBy: [{ status: "desc" }, { effectiveFrom: "desc" }],
    });
    if (!rule) return null;
    if (rule.status === "EFFECTIVE") return rule;
    const updated = await db.clientCommissionRule.update({
      where: { id: rule.id },
      data: { status: "EFFECTIVE" },
    });
    try {
      await this.audit.record({
        aggregateType: "ClientCommissionRule",
        aggregateId: updated.id,
        action: "commercial_rule.activate",
        before: { status: "DRAFT" },
        after: { status: "EFFECTIVE", assignmentId },
      });
    } catch {
      // best-effort
    }
    return updated;
  }

  async assertPublishEligibility({
    assignmentId,
    catalogCampaign,
    client,
    sources = [],
    hasCouponAssignment = false,
    preferredSource = null,
    tx = null,
  }) {
    const db = tx ?? this.db;
    const couponCount = db.clientCouponAssignment?.count
      ? await db.clientCouponAssignment.count({
          where: {
            assignmentId,
            status: { in: ["RESERVED", "ASSIGNED", "ACTIVE"] },
          },
        })
      : 0;
    const trackingLink = db.trackingLink?.findFirst
      ? await db.trackingLink.findFirst({
          where: {
            assignmentId,
            deletedAt: null,
            status: { in: ["GENERATED", "ACTIVE"] },
          },
        })
      : null;
    const preferred =
      preferredSource || sources.find((s) => s.isPrimary) || sources[0] || null;
    const sourceTrackingUrl =
      preferred?.supplierCampaign?.trackingUrl ||
      preferred?.supplierCampaign?.destinationUrl ||
      sources.find(
        (s) => s?.supplierCampaign?.trackingUrl || s?.supplierCampaign?.destinationUrl,
      );
    const facingCoupon = Boolean(
      preferred?.supplierCampaign?.coupons?.some?.((c) => c.couponCode || c.couponLink),
    );
    const effectiveRule = await this.commissionRepo.findEffectiveForAssignment(
      assignmentId,
      new Date(),
      tx,
    );

    const result = this.eligibility.evaluate({
      mode: "publish",
      catalogCampaign,
      client,
      sources,
      hasCouponAssignment: hasCouponAssignment || couponCount > 0 || facingCoupon,
      hasResolvableTrackingDestination: Boolean(
        trackingLink?.supplierTrackingUrl ||
          trackingLink?.mboTrackingUrl ||
          sourceTrackingUrl,
      ),
      hasEffectiveCommissionRule: Boolean(effectiveRule),
      preferredSource: preferred,
    });

    if (!result.ok) {
      throw fail(`Campaign assignment is not publishable: ${result.reasons.join(", ")}`, 409);
    }
    return result;
  }

  async publish(id, client = null) {
    const assignment = await this.assignmentRepo.findById(id, { includeCampaign: true, includeClient: true }, client);
    if (!assignment) throw fail("Assignment not found.", 404);
    if (assignment.status === "REVOKED") throw fail("Cannot publish a revoked assignment.", 409);

    const catalogCampaign = assignment.canonicalCampaign;
    const sources = await this.loadCatalogSources(assignment.canonicalCampaignId, client);
    await this.ensureCommissionRuleDraft(
      assignment.id,
      assignment.client,
      assignment.clientFacing || {},
      client,
    );
    await this.activateCommissionRule(assignment.id, client);
    await this.ensureCouponFromClientFacing(assignment.id, assignment.clientFacing || {}, client, {
      published: true,
    });
    await this.assertPublishEligibility({
      assignmentId: assignment.id,
      catalogCampaign,
      client: assignment.client,
      sources,
      preferredSource:
        sources.find((s) => s.id === assignment.campaignSourceId) ||
        sources.find((s) => s.isPrimary) ||
        sources[0] ||
        null,
      tx: client,
    });

    await this.promoteReservedCoupons(assignment.id, client);

    const published = await this.assignmentRepo.update(
      id,
      {
        status: "ACTIVE",
        published: true,
        publishedAt: new Date(),
        unpublishedAt: null,
      },
      client,
    );

    try {
      await this.audit.record({
        aggregateType: "ClientCampaignAssignment",
        aggregateId: published.id,
        action: "assignment.publish",
        before: {
          published: assignment.published,
          status: assignment.status,
        },
        after: {
          published: true,
          status: "ACTIVE",
          clientId: published.clientId,
          canonicalCampaignId: published.canonicalCampaignId,
          campaignSourceId: published.campaignSourceId,
        },
        reason: "activation_review",
      });
    } catch {
      // best-effort
    }

    return published;
  }

  async pause(id, client = null) {
    const assignment = await this.assignmentRepo.findById(id, {}, client);
    if (!assignment) throw fail("Assignment not found.", 404);
    if (!assignment.published) throw fail("Cannot pause a draft assignment.", 409);
    if (assignment.status === "REVOKED") throw fail("Cannot pause a revoked assignment.", 409);

    return this.assignmentRepo.update(id, { status: "PAUSED" }, client);
  }

  /**
   * Return a published assignment to draft (unpublished) without revoking.
   * Client API / portal visibility gates on published === true.
   */
  async unpublish(id, client = null) {
    const assignment = await this.assignmentRepo.findById(id, {}, client);
    if (!assignment) throw fail("Assignment not found.", 404);
    if (assignment.status === "REVOKED") throw fail("Cannot unpublish a revoked assignment.", 409);
    if (assignment.published !== true) return assignment;

    return this.assignmentRepo.update(
      id,
      {
        published: false,
        unpublishedAt: new Date(),
      },
      client,
    );
  }

  async archive(id, client = null) {
    const assignment = await this.assignmentRepo.findById(id, {}, client);
    if (!assignment) throw fail("Assignment not found.", 404);

    // §11 — cancel draft releases reservation.
    if (!assignment.published) {
      await this.releaseReservedCoupons(assignment.id, client);
    }

    const archived = await this.assignmentRepo.update(
      id,
      {
        status: "REVOKED",
        published: false,
        unpublishedAt: new Date(),
      },
      client,
    );

    try {
      await this.audit.record({
        aggregateType: "ClientCampaignAssignment",
        aggregateId: archived.id,
        action: "assignment.archive",
        before: { status: assignment.status, published: assignment.published },
        after: { status: "REVOKED", published: false },
      });
    } catch {
      // best-effort
    }

    return archived;
  }

  resolveLifecycle(assignment) {
    if (!assignment) return null;
    if (assignment.status === "REVOKED") return ASSIGNMENT_LIFECYCLE.ARCHIVED;
    if (assignment.status === "PAUSED") return ASSIGNMENT_LIFECYCLE.PAUSED;
    if (assignment.published && assignment.status === "ACTIVE") return ASSIGNMENT_LIFECYCLE.PUBLISHED;
    return ASSIGNMENT_LIFECYCLE.DRAFT;
  }

  async update(id, input, client = null) {
    const assignment = await this.assignmentRepo.findById(id, { includeCampaign: true }, client);
    if (!assignment) throw fail("Assignment not found.", 404);

    if (input.lifecycle === ASSIGNMENT_LIFECYCLE.PUBLISHED) {
      return this.publish(id, client);
    }
    if (input.lifecycle === ASSIGNMENT_LIFECYCLE.DRAFT) {
      return this.unpublish(id, client);
    }
    if (input.lifecycle === ASSIGNMENT_LIFECYCLE.PAUSED) {
      return this.pause(id, client);
    }
    if (input.lifecycle === ASSIGNMENT_LIFECYCLE.ARCHIVED) {
      return this.archive(id, client);
    }

    const data = {};
    if (input.startDate !== undefined) data.startDate = input.startDate;
    if (input.endDate !== undefined) data.endDate = input.endDate;
    if (input.channel !== undefined) data.channel = input.channel;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.status !== undefined) data.status = input.status;
    if (input.clientFacing !== undefined) data.clientFacing = input.clientFacing;
    if (input.campaignSourceId !== undefined) {
      if (input.campaignSourceId) {
        const sources = await this.loadCatalogSources(assignment.canonicalCampaignId, client);
        const match = sources.find((s) => s.id === input.campaignSourceId);
        if (!match) throw fail("Campaign source does not belong to this catalog campaign.", 409);
        data.campaignSourceId = input.campaignSourceId;
      } else {
        data.campaignSourceId = null;
      }
    }

    if (Object.keys(data).length) {
      return this.assignmentRepo.update(id, data, client);
    }

    return assignment;
  }

  async fulfillBrandRequest(requestId, assignmentId, client = null) {
    const request = await this.requestRepo.findById(requestId, client);
    if (!request) throw fail("Brand request not found.", 404);

    return this.requestRepo.update(
      requestId,
      {
        status: "FULFILLED",
        resolvedAt: new Date(),
        fulfilledAssignmentId: assignmentId,
      },
      client,
    );
  }
}
