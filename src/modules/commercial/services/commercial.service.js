import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import { deriveMboCommission } from "../commissionMath.js";
import { buildMboTrackingUrl, buildTrackingSlug } from "../trackingUrl.js";
import {
  buildAssignedTrackingSlug,
  resolveSupplierCampaignBrandSlug,
} from "../supplierCampaignTracking.js";
import { resolveSupplierDestination } from "../resolveSupplierDestination.js";
import {
  CommissionRuleRepository,
  CouponAssignmentRepository,
  TrackingLinkRepository,
} from "../repositories/commercial.repository.js";
import { ClientCampaignAssignmentRepository } from "../../client/repositories/clientCampaignAssignment.repository.js";
import { CampaignSourceRepository } from "../../catalog/repositories/campaignSource.repository.js";

function assertCommercialAssignment(assignment) {
  if (!assignment) throw fail("Assignment not found.", 404);
  if (assignment.status === "REVOKED") throw fail("Cannot add commercial objects to a revoked assignment.", 409);
  if (!assignment.published || assignment.status !== "ACTIVE") {
    throw fail("Assignment must be published and active for commercial operations.", 409);
  }
}

function assertTrackingLinkAssignment(assignment) {
  if (!assignment) throw fail("Assignment not found.", 404);
  if (assignment.status === "REVOKED") {
    throw fail("Cannot add tracking links to a revoked assignment.", 409);
  }
  const publishedActive = assignment.published === true && assignment.status === "ACTIVE";
  const reviewDraft = assignment.published === false && assignment.status === "ASSIGNED";
  if (!publishedActive && !reviewDraft) {
    throw fail("Assignment must be an active published grant or an unpublished review draft.", 409);
  }
}

function stableValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stableValue(val)]));
  }
  return value;
}

function stableConditionValue(operator, value) {
  const normalized = stableValue(value);
  if (["IN", "NOT_IN"].includes(String(operator || "").toUpperCase()) && Array.isArray(normalized)) {
    return [...normalized].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }
  return normalized;
}

function commercialConditionSignature(conditions = []) {
  const list = Array.isArray(conditions) ? conditions : [];
  const normalized = list
    .filter((condition) => String(condition?.conditionType || "").toUpperCase() !== "DEFAULT")
    .map((condition) => ({
      conditionType: String(condition.conditionType || "CUSTOM_FIELD").trim().toUpperCase(),
      operator: String(condition.operator || "EQ").trim().toUpperCase(),
      field: condition.field || null,
      value: stableConditionValue(
        String(condition.operator || "EQ").trim().toUpperCase(),
        condition.value ?? null,
      ),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return normalized.length ? JSON.stringify(normalized) : "DEFAULT";
}

function assertCommercialActivationReady(rule) {
  if (!rule.agreementRef || !rule.agreementApprovedAt || !rule.agreementApprovedBy) {
    throw fail("Commercial agreement/IO/SOW approval lineage is required before activation.", 409);
  }
  if (String(rule.commissionType || "").toUpperCase() === "TIERED") {
    if (!rule.tierMetric || !rule.tierPeriod || !Array.isArray(rule.tiers) || !rule.tiers.length) {
      throw fail("TIERED rules require tierMetric, tierPeriod and at least one persisted tier.", 409);
    }
  }
  if (String(rule.commissionType || "").toUpperCase() === "MANUAL_APPROVED_CLIENT_COMMISSION") {
    if (rule.manualApproved !== true || !rule.manualApprovedAt || !rule.manualApprovedBy) {
      throw fail("Manual-approved client commission requires explicit approval evidence before activation.", 409);
    }
  }
  if (rule.subsidyApproved === true && (!rule.subsidyApprovalRef || !rule.subsidyApprovedAt || !rule.subsidyApprovedBy)) {
    throw fail("Approved subsidy requires approval reference, date and approver.", 409);
  }
}

async function closeSameLineagePredecessors(repo, rule, overlapping, client) {
  const signature = commercialConditionSignature(rule.conditions);
  for (const existing of overlapping) {
    if (commercialConditionSignature(existing.conditions) !== signature) continue;
    const existingStart = new Date(existing.effectiveFrom).getTime();
    const nextStart = new Date(rule.effectiveFrom).getTime();
    if (!Number.isFinite(existingStart) || !Number.isFinite(nextStart) || existingStart >= nextStart) {
      throw fail("An overlapping client commercial rule with the same conditions already exists.", 409);
    }
    await repo.update(
      existing.id,
      { status: "SUPERSEDED", effectiveUntil: rule.effectiveFrom },
      client,
    );
  }
}

export class CommercialService {
  constructor(deps = {}) {
    this.trackingRepo = deps.trackingRepo ?? new TrackingLinkRepository();
    this.couponRepo = deps.couponRepo ?? new CouponAssignmentRepository();
    this.commissionRepo = deps.commissionRepo ?? new CommissionRuleRepository();
    this.assignmentRepo = deps.assignmentRepo ?? new ClientCampaignAssignmentRepository();
    this.sourceRepo = deps.sourceRepo ?? new CampaignSourceRepository();
  }

  async getAssignment(assignmentId, client = null) {
    return this.assignmentRepo.findById(
      assignmentId,
      {
        includeCampaign: true,
        includeClient: true,
        includeSource: true,
      },
      client,
    );
  }

  /**
   * Resolve Supplier Tracking URL for an assignment.
   * Coupon CMS tracking URL is the source of truth when present.
   */
  async resolveSupplierTrackingDefaults(assignmentId, client = null) {
    const resolved = await resolveSupplierDestination(
      {
        assignmentId,
        preferPersisted: false,
      },
      client,
    );

    return {
      assignmentId,
      supplierTrackingUrl: resolved.url,
      source: resolved.source,
      message: resolved.url
        ? `Resolved supplier destination from ${resolved.source}.`
        : resolved.reason || "Supplier tracking URL could not be resolved.",
    };
  }

  validateCommissionSplit(grossCommission, clientCommission) {
    const gross = Number(grossCommission);
    const client = Number(clientCommission);
    if (Number.isNaN(gross) || Number.isNaN(client)) throw fail("Invalid commission values.", 400);
    if (client > gross) throw fail("clientCommission cannot exceed grossCommission.", 400);
    try {
      return deriveMboCommission(gross, client);
    } catch {
      throw fail("Invalid commission values.", 400);
    }
  }

  async createTrackingLink(input, client = null) {
    const run = async (tx) => {
      const assignment = await this.getAssignment(input.assignmentId, tx);
      assertTrackingLinkAssignment(assignment);

      if (input.campaignSourceId) {
        const source = await this.sourceRepo.findById(input.campaignSourceId, {}, tx);
        if (!source || source.canonicalCampaignId !== assignment.canonicalCampaignId) {
          throw fail("Campaign source does not belong to the assignment catalog campaign.", 409);
        }
      }

      let supplierTrackingUrl = input.supplierTrackingUrl ?? null;
      if (!supplierTrackingUrl) {
        const defaults = await this.resolveSupplierTrackingDefaults(input.assignmentId, tx);
        supplierTrackingUrl = defaults.supplierTrackingUrl;
      }
      if (!supplierTrackingUrl) {
        throw fail(
          "Cannot create tracking link: supplier tracking URL is missing for this campaign.",
          409,
        );
      }

      const shouldBePrimary = input.isPrimary === true;
      if (shouldBePrimary) {
        await this.trackingRepo.clearPrimaryForAssignment(input.assignmentId, null, tx);
      }

      const slug =
        input.slug ||
        (await this.resolveTrackingSlugForAssignment(input.assignmentId, tx));
      const supplierCampaign = assignment?.campaignSource?.supplierCampaign ?? null;
      const generated = buildMboTrackingUrl({
        slug,
        token: input.token || supplierCampaign?.mboTrackingToken || undefined,
      });
      // If a custom mboTrackingUrl is provided (legacy), keep it but still store slug/token.
      const mboTrackingUrl = input.mboTrackingUrl?.trim() || generated.mboTrackingUrl;

      return this.trackingRepo.create(
        {
          assignmentId: input.assignmentId,
          campaignSourceId: input.campaignSourceId ?? null,
          slug: generated.slug,
          subId: generated.subId,
          supplierTrackingUrl,
          mboTrackingUrl,
          deeplinkTemplate: input.deeplinkTemplate ?? null,
          trackingType: input.trackingType ?? "STANDARD",
          status: "ACTIVE",
          isPrimary: shouldBePrimary,
          expiresAt: input.expiresAt ?? null,
        },
        tx,
      );
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }

  async resolveTrackingSlugForAssignment(assignmentId, client = null) {
    const assignment = await this.getAssignment(assignmentId, client);
    const supplierCampaign = assignment?.campaignSource?.supplierCampaign ?? null;
    const brandSlug =
      supplierCampaign?.mboTrackingSlug ||
      resolveSupplierCampaignBrandSlug({
        ...supplierCampaign,
        merchant: supplierCampaign?.merchant,
      });
    const clientSlug = assignment?.client?.slug || null;
    const campaignSlug =
      assignment?.canonicalCampaign?.displayName ||
      supplierCampaign?.campaignName ||
      null;

    if (clientSlug) {
      return buildAssignedTrackingSlug({ brandSlug, clientSlug });
    }

    return buildTrackingSlug({
      merchantSlug: brandSlug,
      campaignSlug,
    });
  }

  async rotateTrackingLink(id, input = {}, client = null) {
    const run = async (tx) => {
      const existing = await this.trackingRepo.findById(id, tx);
      if (!existing) throw fail("Tracking link not found.", 404);

      await this.trackingRepo.revoke(id, tx);

      const slug =
        existing.slug ||
        (await this.resolveTrackingSlugForAssignment(existing.assignmentId, tx));

      return this.createTrackingLink(
        {
          assignmentId: existing.assignmentId,
          campaignSourceId: existing.campaignSourceId,
          supplierTrackingUrl: input.supplierTrackingUrl ?? existing.supplierTrackingUrl,
          slug,
          deeplinkTemplate: input.deeplinkTemplate ?? existing.deeplinkTemplate,
          trackingType: input.trackingType ?? existing.trackingType,
          isPrimary: true,
          expiresAt: input.expiresAt ?? existing.expiresAt,
        },
        tx,
      );
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }

  async regenerateTrackingToken(id, client = null) {
    const existing = await this.trackingRepo.findById(id, client);
    if (!existing) throw fail("Tracking link not found.", 404);
    if (existing.status === "REVOKED" || existing.deletedAt) {
      throw fail("Cannot regenerate a revoked tracking link.", 409);
    }

    const slug =
      existing.slug ||
      (await this.resolveTrackingSlugForAssignment(existing.assignmentId, client));
    const generated = buildMboTrackingUrl({ slug });

    return this.trackingRepo.update(
      id,
      {
        slug: generated.slug,
        subId: generated.subId,
        mboTrackingUrl: generated.mboTrackingUrl,
      },
      client,
    );
  }

  async updateTrackingLink(id, input, client = null) {
    if (input.rotate) return this.rotateTrackingLink(id, input, client);
    if (input.regenerateToken) return this.regenerateTrackingToken(id, client);

    const link = await this.trackingRepo.findById(id, client);
    if (!link) throw fail("Tracking link not found.", 404);

    if (input.isPrimary === true) {
      await this.trackingRepo.clearPrimaryForAssignment(link.assignmentId, id, client);
    }

    const data = {};
    if (input.status !== undefined) data.status = input.status;
    if (input.isPrimary !== undefined) data.isPrimary = input.isPrimary;
    if (input.mboTrackingUrl !== undefined) data.mboTrackingUrl = input.mboTrackingUrl;
    if (input.deeplinkTemplate !== undefined) data.deeplinkTemplate = input.deeplinkTemplate;
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;

    return this.trackingRepo.update(id, data, client);
  }

  async assignCoupon(input, client = null) {
    const assignment = await this.getAssignment(input.assignmentId, client);
    assertCommercialAssignment(assignment);

    return this.couponRepo.create(
      {
        assignmentId: input.assignmentId,
        supplierCouponId: input.supplierCouponId ?? null,
        supplierCouponCode: input.supplierCouponCode ?? null,
        clientCouponCode: input.clientCouponCode ?? null,
        couponType: input.couponType ?? "UNKNOWN",
        discountPercentage:
          input.couponType === "CODE" ? input.discountPercentage?.trim?.() || input.discountPercentage || null : null,
        status: "ASSIGNED",
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
      },
      client,
    );
  }

  async activateCoupon(id, client = null) {
    const coupon = await this.couponRepo.findById(id, client);
    if (!coupon) throw fail("Coupon assignment not found.", 404);
    if (coupon.status === "REVOKED" || coupon.status === "EXPIRED") {
      throw fail("Cannot activate a revoked or expired coupon assignment.", 409);
    }

    const assignment = await this.getAssignment(coupon.assignmentId, client);
    assertCommercialAssignment(assignment);

    return this.couponRepo.update(id, { status: "ACTIVE" }, client);
  }

  async deactivateCoupon(id, client = null) {
    const coupon = await this.couponRepo.findById(id, client);
    if (!coupon) throw fail("Coupon assignment not found.", 404);
    return this.couponRepo.update(id, { status: "REVOKED" }, client);
  }

  async updateCouponAssignment(id, input, client = null) {
    if (input.activate) return this.activateCoupon(id, client);
    if (input.deactivate) return this.deactivateCoupon(id, client);

    const data = {};
    if (input.status !== undefined) data.status = input.status;
    if (input.clientCouponCode !== undefined) data.clientCouponCode = input.clientCouponCode;
    if (input.validFrom !== undefined) data.validFrom = input.validFrom;
    if (input.validUntil !== undefined) data.validUntil = input.validUntil;

    const coupon = await this.couponRepo.findById(id, client);
    if (!coupon) throw fail("Coupon assignment not found.", 404);

    return this.couponRepo.update(id, data, client);
  }

  async createCommissionRule(input, client = null) {
    const commissionType = input.commissionType ?? "PERCENT";
    let gross = input.grossCommission;
    let clientShare = input.clientCommission;

    if (gross == null || clientShare == null) {
      if (commissionType === "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE" || commissionType === "TIERED") {
        gross = gross ?? 100;
        clientShare = clientShare ?? 0;
      } else if (
        commissionType === "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER" ||
        (commissionType === "FIXED" && input.fixedAmount != null)
      ) {
        const amt = Number(input.fixedAmount ?? 0);
        gross = gross ?? amt;
        clientShare = clientShare ?? amt;
      } else if (commissionType === "MANUAL_APPROVED_CLIENT_COMMISSION") {
        const amt = Number(input.manualAmount ?? 0);
        gross = gross ?? amt;
        clientShare = clientShare ?? amt;
      } else {
        throw fail("grossCommission and clientCommission are required for this rule type.", 400);
      }
    }

    const mboCommission = this.validateCommissionSplit(gross, clientShare);
    const manualApproved = Boolean(input.manualApproved);

    const run = async (tx) => {
      const assignment = await this.getAssignment(input.assignmentId, tx);
      assertCommercialAssignment(assignment);

      const ruleData = {
        assignmentId: input.assignmentId,
        grossCommission: gross,
        clientCommission: clientShare,
        mboCommission,
        commissionType,
        currency: input.currency ?? assignment.canonicalCampaign?.defaultCurrency ?? null,
        orderValuePercent: input.orderValuePercent ?? null,
        fixedAmount: input.fixedAmount ?? null,
        manualAmount: input.manualAmount ?? null,
        manualApproved,
        manualApprovedAt: manualApproved ? input.manualApprovedAt ?? null : null,
        manualApprovedBy: manualApproved ? input.manualApprovedBy ?? null : null,
        displayRangeMin: input.displayRangeMin ?? null,
        displayRangeMax: input.displayRangeMax ?? null,
        displayLabel: input.displayLabel ?? null,
        priority: input.priority ?? null,
        priorityVerified: Boolean(input.priorityVerified),
        agreementRef: input.agreementRef ?? null,
        agreementApprovedAt: input.agreementApprovedAt ?? null,
        agreementApprovedBy: input.agreementApprovedBy ?? null,
        subsidyApproved: Boolean(input.subsidyApproved),
        subsidyApprovalRef: input.subsidyApprovalRef ?? null,
        subsidyApprovedAt: input.subsidyApprovedAt ?? null,
        subsidyApprovedBy: input.subsidyApprovedBy ?? null,
        tierMetric: input.tierMetric ?? null,
        tierPeriod: input.tierPeriod ?? null,
        metadata: input.metadata ?? null,
        conditions: input.conditions ?? [],
        tiers: input.tiers ?? [],
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil ?? null,
        status: input.activate ? "EFFECTIVE" : "DRAFT",
      };

      if (input.activate) {
        assertCommercialActivationReady(ruleData);
        const overlapping = await this.commissionRepo.findOverlappingEffective(
          input.assignmentId,
          input.effectiveFrom,
          input.effectiveUntil ?? null,
          null,
          tx,
        );
        await closeSameLineagePredecessors(this.commissionRepo, ruleData, overlapping, tx);
      }

      return this.commissionRepo.create(ruleData, tx);
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }

  async activateCommissionRule(id, client = null) {
    const rule = await this.commissionRepo.findById(id, client);
    if (!rule) throw fail("Commission rule not found.", 404);
    if (rule.status === "SUPERSEDED") throw fail("Cannot activate a superseded rule.", 409);
    assertCommercialActivationReady(rule);

    const overlapping = await this.commissionRepo.findOverlappingEffective(
      rule.assignmentId,
      rule.effectiveFrom,
      rule.effectiveUntil,
      rule.id,
      client,
    );
    await closeSameLineagePredecessors(this.commissionRepo, rule, overlapping, client);
    return this.commissionRepo.update(id, { status: "EFFECTIVE" }, client);
  }

  async updateCommissionRule(id, input, client = null) {
    const rule = await this.commissionRepo.findById(id, client);
    if (!rule) throw fail("Commission rule not found.", 404);

    if (input.supersede) {
      return this.commissionRepo.update(
        id,
        { status: "SUPERSEDED", effectiveUntil: input.effectiveUntil ?? new Date() },
        client,
      );
    }

    const activateAfterUpdate = input.activate === true || String(input.status || "").toUpperCase() === "EFFECTIVE";
    const data = {};
    if (input.status !== undefined && !activateAfterUpdate) data.status = input.status;
    if (input.effectiveUntil !== undefined) data.effectiveUntil = input.effectiveUntil;
    if (input.orderValuePercent !== undefined) data.orderValuePercent = input.orderValuePercent;
    if (input.fixedAmount !== undefined) data.fixedAmount = input.fixedAmount;
    if (input.manualAmount !== undefined) data.manualAmount = input.manualAmount;
    if (input.displayRangeMin !== undefined) data.displayRangeMin = input.displayRangeMin;
    if (input.displayRangeMax !== undefined) data.displayRangeMax = input.displayRangeMax;
    if (input.displayLabel !== undefined) data.displayLabel = input.displayLabel;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.priorityVerified !== undefined) data.priorityVerified = Boolean(input.priorityVerified);
    if (input.agreementRef !== undefined) data.agreementRef = input.agreementRef;
    if (input.agreementApprovedAt !== undefined) data.agreementApprovedAt = input.agreementApprovedAt;
    if (input.agreementApprovedBy !== undefined) data.agreementApprovedBy = input.agreementApprovedBy;
    if (input.subsidyApproved !== undefined) data.subsidyApproved = Boolean(input.subsidyApproved);
    if (input.subsidyApprovalRef !== undefined) data.subsidyApprovalRef = input.subsidyApprovalRef;
    if (input.subsidyApprovedAt !== undefined) data.subsidyApprovedAt = input.subsidyApprovedAt;
    if (input.subsidyApprovedBy !== undefined) data.subsidyApprovedBy = input.subsidyApprovedBy;
    if (input.tierMetric !== undefined) data.tierMetric = input.tierMetric;
    if (input.tierPeriod !== undefined) data.tierPeriod = input.tierPeriod;
    if (input.metadata !== undefined) data.metadata = input.metadata;
    if (input.conditions !== undefined) data.conditions = input.conditions;
    if (input.tiers !== undefined) data.tiers = input.tiers;
    if (input.manualApprovedAt !== undefined && input.manualApproved === undefined) {
      data.manualApprovedAt = input.manualApprovedAt;
    }
    if (input.manualApprovedBy !== undefined && input.manualApproved === undefined) {
      data.manualApprovedBy = input.manualApprovedBy;
    }
    if (input.manualApproved !== undefined) {
      data.manualApproved = Boolean(input.manualApproved);
      if (data.manualApproved) {
        data.manualApprovedAt = input.manualApprovedAt ?? rule.manualApprovedAt ?? null;
        data.manualApprovedBy = input.manualApprovedBy ?? rule.manualApprovedBy ?? null;
      } else {
        data.manualApprovedAt = null;
        data.manualApprovedBy = null;
      }
    }

    const updated = Object.keys(data).length
      ? await this.commissionRepo.update(id, data, client)
      : rule;
    if (activateAfterUpdate) return this.activateCommissionRule(updated.id, client);
    return updated;
  }
}
