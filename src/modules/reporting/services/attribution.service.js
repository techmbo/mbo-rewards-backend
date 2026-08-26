import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import { hashPii } from "../../../core/piiHash.js";
import { logger } from "../../../platform/logging/logger.js";
import {
  TrackingLinkRepository,
  CommissionRuleRepository,
  CouponAssignmentRepository,
} from "../../commercial/repositories/commercial.repository.js";
import { ClientCampaignAssignmentRepository } from "../../client/repositories/clientCampaignAssignment.repository.js";
import { ExceptionCaseService } from "../../order/exceptionCase.service.js";
import { isPresent } from "../../order/orderMerge.js";
import {
  ClickRepository,
  ConversionRepository,
} from "../repositories/reporting.repository.js";
import {
  applyCommissionRuleToGross,
  grossCommissionForConversion,
} from "../attributionMath.js";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Wave C — do not overwrite known conversion values with null on re-ingest. */
function mergeConversionUpdate(existing, incoming) {
  const out = { ...incoming };
  for (const key of Object.keys(incoming)) {
    if (incoming[key] === null || incoming[key] === undefined) {
      if (existing[key] != null && existing[key] !== "") {
        delete out[key];
      }
    }
  }
  if (isPresent(incoming.status)) out.status = incoming.status;
  if (isPresent(incoming.supplierCommission)) out.supplierCommission = incoming.supplierCommission;
  if (incoming.metadata != null) {
    out.metadata = { ...asObject(existing.metadata), ...asObject(incoming.metadata) };
  }
  if (incoming.orderId) out.orderId = incoming.orderId;
  if (incoming.rawPayloadId) out.rawPayloadId = incoming.rawPayloadId;
  return out;
}

function extractCouponCodeHint(conversion) {
  const hints = asObject(conversion.metadata?.attributionHints);
  const meta = asObject(conversion.metadata);
  const raw = hints.couponCode ?? meta.couponCode ?? meta.voucher ?? meta.coupon ?? null;
  const code = raw != null ? String(raw).trim() : "";
  return code || null;
}

export class AttributionService {
  constructor(deps = {}) {
    this.clickRepo = deps.clickRepo ?? new ClickRepository();
    this.conversionRepo = deps.conversionRepo ?? new ConversionRepository();
    this.trackingRepo = deps.trackingRepo ?? new TrackingLinkRepository();
    this.assignmentRepo = deps.assignmentRepo ?? new ClientCampaignAssignmentRepository();
    this.commissionRepo = deps.commissionRepo ?? new CommissionRuleRepository();
    this.couponAssignmentRepo = deps.couponAssignmentRepo ?? new CouponAssignmentRepository();
    this.exceptions = deps.exceptions ?? new ExceptionCaseService();
  }

  async recordClick(input, client = null) {
    const link = await this.trackingRepo.findById(input.trackingLinkId, client);
    if (!link) throw fail("Tracking link not found.", 404);
    if (link.status === "REVOKED") throw fail("Tracking link is revoked.", 409);

    const assignment = await this.assignmentRepo.findById(link.assignmentId, {}, client);
    if (!assignment) throw fail("Assignment not found for tracking link.", 404);

    return this.clickRepo.create(
      {
        trackingLinkId: link.id,
        campaignSourceId: link.campaignSourceId,
        clientAssignmentId: link.assignmentId,
        subId: input.subId ?? link.subId,
        ipHash: hashPii(input.ip),
        userAgentHash: hashPii(input.userAgent),
        country: input.country ?? null,
        device: input.device ?? "UNKNOWN",
        referrer: input.referrer ?? null,
        clickedAt: input.clickedAt ?? new Date(),
        metadata: input.metadata ?? null,
      },
      client,
    );
  }

  async ingestConversion(input, client = null) {
    const existing = await this.conversionRepo.findBySupplierKey(
      {
        supplier: input.supplier,
        supplierConversionId: input.supplierConversionId,
        sourceAccountLabel: input.sourceAccountLabel ?? "default",
      },
      client,
    );

    const baseData = {
      supplier: input.supplier,
      supplierConversionId: input.supplierConversionId,
      sourceAccountLabel: input.sourceAccountLabel ?? "default",
      clickId: input.clickId ?? null,
      subId: input.subId ?? null,
      trackingLinkId: input.trackingLinkId ?? null,
      supplierCommission: input.supplierCommission,
      approvedCommission: input.approvedCommission ?? null,
      currency: input.currency ?? null,
      status: input.status ?? "PENDING",
      conversionDate: input.conversionDate,
      approvedDate: input.approvedDate ?? null,
      metadata: input.metadata ?? null,
      ...(input.rawPayloadId ? { rawPayloadId: input.rawPayloadId } : {}),
      ...(input.orderId ? { orderId: input.orderId } : {}),
    };

    const assignmentIdHint = input._assignmentIdHint ?? input.metadata?.attributionHints?.assignmentId ?? null;

    const run = async (tx) => {
      let conversion;
      if (existing) {
        const patch = mergeConversionUpdate(existing, {
          ...baseData,
          attributionStatus: existing.attributionStatus === "ATTRIBUTED" ? "REATTRIBUTED" : "PENDING",
        });
        conversion = await this.conversionRepo.update(existing.id, patch, tx);
      } else {
        conversion = await this.conversionRepo.create(
          { ...baseData, attributionStatus: "PENDING" },
          tx,
        );
      }
      return this.attributeConversion(conversion.id, tx, { assignmentIdHint });
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }

  async attributeConversion(conversionId, client = null, options = {}) {
    const conversion = await this.conversionRepo.findById(conversionId, client);
    if (!conversion) throw fail("Conversion not found.", 404);

    let orderValidation = null;
    if (conversion.orderId && (client ?? prisma)?.order?.findUnique) {
      try {
        const order = await (client ?? prisma).order.findUnique({
          where: { id: conversion.orderId },
          select: { validationStatus: true },
        });
        orderValidation = order?.validationStatus ?? null;
      } catch {
        orderValidation = null;
      }
    }

    const context = await this.resolveAttributionContext(conversion, client, options);

    // Epic 3 — wrong-client rejection: never silently cross-assign when a client hint disagrees.
    const clientIdHint =
      options.clientIdHint ??
      asObject(conversion.metadata?.attributionHints).clientId ??
      null;
    if (context.clientAssignmentId && clientIdHint) {
      const assignment = await this.assignmentRepo.findById(context.clientAssignmentId, {}, client);
      if (assignment?.clientId && String(assignment.clientId) !== String(clientIdHint)) {
        try {
          await this.exceptions.report(
            {
              type: "ATTRIBUTION_UNRESOLVED",
              severity: "HIGH",
              supplier: conversion.supplier,
              conversionId: conversion.id,
              orderId: conversion.orderId ?? null,
              clientId: assignment.clientId,
              reason: "wrong_client_attribution_rejected",
              metadata: {
                assignmentId: context.clientAssignmentId,
                hintedClientId: String(clientIdHint),
                assignmentClientId: String(assignment.clientId),
              },
            },
            client,
          );
        } catch {
          // ignore
        }
        return this.conversionRepo.update(
          conversionId,
          {
            attributionStatus: "ORPHAN",
            metadata: {
              ...asObject(conversion.metadata),
              attributionRejection: {
                reason: "wrong_client",
                hintedClientId: String(clientIdHint),
                assignmentClientId: String(assignment.clientId),
              },
            },
          },
          client,
        );
      }
    }

    // §13 — ambiguous evidence requires review; never force a client.
    if (context.reviewRequired) {
      try {
        await this.exceptions.report(
          {
            type: "ATTRIBUTION_UNRESOLVED",
            severity: "HIGH",
            supplier: conversion.supplier,
            conversionId: conversion.id,
            orderId: conversion.orderId ?? null,
            reason: context.reviewReason || "attribution_review_required",
            metadata: {
              evidence: context.evidence ?? null,
              reviewReason: context.reviewReason ?? null,
              candidateAssignmentIds: context.candidateAssignmentIds ?? [],
              couponCode: context.couponCode ?? null,
            },
          },
          client,
        );
      } catch {
        // ignore
      }
      return this.conversionRepo.update(
        conversionId,
        {
          attributionStatus: "REVIEW_REQUIRED",
          metadata: {
            ...asObject(conversion.metadata),
            attributionReview: {
              reason: context.reviewReason || "ambiguous_evidence",
              evidence: context.evidence ?? null,
              candidateAssignmentIds: context.candidateAssignmentIds ?? [],
              couponCode: context.couponCode ?? null,
            },
          },
        },
        client,
      );
    }

    if (!context.trackingLinkId && !context.clientAssignmentId) {
      try {
        await this.exceptions.report(
          {
            type: "ATTRIBUTION_UNRESOLVED",
            severity: "HIGH",
            supplier: conversion.supplier,
            conversionId: conversion.id,
            orderId: conversion.orderId ?? null,
            reason: "Conversion could not be attributed to click/assignment",
            metadata: { supplierConversionId: conversion.supplierConversionId },
          },
          client,
        );
      } catch {
        // ignore
      }
      return this.conversionRepo.update(
        conversionId,
        { attributionStatus: "ORPHAN" },
        client,
      );
    }

    let clientCommission = null;
    let mboCommission = null;
    let commissionRuleId = null;
    let commissionUnresolvedReason = null;

    const rejected =
      conversion.status === "REJECTED" || orderValidation === "VALIDATION_REJECTED";

    if (rejected) {
      clientCommission = null;
      mboCommission = null;
      commissionUnresolvedReason = "rejected_conversion";
    } else if (context.commissionRule) {
      const gross = grossCommissionForConversion(conversion);
      const split = applyCommissionRuleToGross(gross, context.commissionRule);
      if (split.ok === false) {
        commissionUnresolvedReason = split.reason;
        logger.warn(
          { conversionId, reason: split.reason },
          "commission split unresolved — leaving clientCommission null",
        );
        try {
          await this.exceptions.report(
            {
              type: "COMMISSION_INVALID",
              severity: "MEDIUM",
              supplier: conversion.supplier,
              conversionId: conversion.id,
              orderId: conversion.orderId ?? null,
              reason: split.reason,
            },
            client,
          );
        } catch {
          // ignore
        }
      } else {
        commissionRuleId = context.commissionRule.id;
        clientCommission = split.clientCommission;
        mboCommission = split.mboCommission;
      }
    } else {
      commissionUnresolvedReason = "missing_effective_commission_rule";
      logger.warn(
        { conversionId, assignmentId: context.clientAssignmentId },
        "no EFFECTIVE ClientCommissionRule — clientCommission left null (not falling back to supplier)",
      );
      try {
        await this.exceptions.report(
          {
            type: "COMMISSION_MISSING",
            severity: "MEDIUM",
            supplier: conversion.supplier,
            conversionId: conversion.id,
            orderId: conversion.orderId ?? null,
            reason: "missing_effective_commission_rule",
          },
          client,
        );
      } catch {
        // ignore
      }
    }

    const metadata = {
      ...asObject(conversion.metadata),
      ...(commissionUnresolvedReason
        ? { commissionUnresolvedReason }
        : { commissionUnresolvedReason: null }),
      attributionEvidence: context.evidence ?? null,
    };

    const updated = await this.conversionRepo.update(
      conversionId,
      {
        clickId: context.clickId,
        trackingLinkId: context.trackingLinkId,
        campaignSourceId: context.campaignSourceId,
        clientAssignmentId: context.clientAssignmentId,
        commissionRuleId,
        subId: context.subId ?? conversion.subId,
        clientCommission,
        mboCommission,
        attributionStatus: "ATTRIBUTED",
        metadata,
      },
      client,
    );

    if (conversion.orderId && (client ?? prisma)?.order?.update) {
      try {
        const orderPatch = {};
        if (context.clientAssignmentId) orderPatch.clientAssignmentId = context.clientAssignmentId;
        if (context.campaignSourceId) orderPatch.campaignSourceId = context.campaignSourceId;
        if (context.clickId) orderPatch.clickId = context.clickId;
        if (context.clientAssignmentId) {
          const assignment = await this.assignmentRepo.findById(
            context.clientAssignmentId,
            {},
            client,
          );
          if (assignment?.clientId) orderPatch.clientId = assignment.clientId;
          if (assignment?.canonicalCampaignId) {
            orderPatch.canonicalCampaignId = assignment.canonicalCampaignId;
          }
        }
        if (Object.keys(orderPatch).length) {
          await (client ?? prisma).order.update({
            where: { id: conversion.orderId },
            data: orderPatch,
          });
        }
      } catch {
        // best-effort enrichment
      }
    }

    return updated;
  }

  async reattributeAssignment(assignmentId, client = null) {
    const { rows } = await this.conversionRepo.findMany(
      { clientAssignmentId: assignmentId },
      { skip: 0, take: 10_000 },
      client,
    );

    const results = [];
    for (const conversion of rows) {
      results.push(await this.attributeConversion(conversion.id, client));
    }
    return results;
  }

  /**
   * §13 priority:
   * 1. MBO Click ID / SubID / tracking link / assignment hint
   * 2. Unique assigned coupon
   * 3. Approved single-assignment (exactly one published ACTIVE for campaign source)
   * 4. Shared/ambiguous → REVIEW_REQUIRED
   * 5. Else unattributed (ORPHAN)
   */
  async resolveAttributionContext(conversion, client = null, options = {}) {
    let click = null;
    let trackingLink = null;
    const hints = asObject(conversion.metadata?.attributionHints);
    const assignmentIdHint =
      options.assignmentIdHint ?? hints.assignmentId ?? conversion.metadata?.assignmentId ?? null;

    if (conversion.clickId) {
      click = await this.clickRepo.findById(conversion.clickId, client);
    }

    if (!click && hints.clickId && hints.clickId !== conversion.clickId) {
      click = await this.clickRepo.findById(hints.clickId, client);
    }

    if (!click && conversion.subId) {
      click = await this.clickRepo.findBySubId(conversion.subId, {}, client);
    }

    if (!click && hints.subId) {
      click = await this.clickRepo.findBySubId(hints.subId, {}, client);
    }

    if (conversion.trackingLinkId) {
      trackingLink = await this.trackingRepo.findById(conversion.trackingLinkId, client);
    } else if (click) {
      trackingLink = await this.trackingRepo.findById(click.trackingLinkId, client);
    }

    let clientAssignmentId =
      click?.clientAssignmentId ?? trackingLink?.assignmentId ?? conversion.clientAssignmentId ?? null;
    let evidence = null;

    if (click) evidence = "mbo_click";
    else if ((conversion.subId || hints.subId) && clientAssignmentId) evidence = "network_subid";
    else if (trackingLink) evidence = "tracking_link";

    if (!clientAssignmentId && assignmentIdHint) {
      const assignment = await this.assignmentRepo.findById(assignmentIdHint, {}, client);
      if (assignment) {
        clientAssignmentId = assignment.id;
        evidence = evidence || "assignment_hint";
        if (!trackingLink) {
          trackingLink = await this.trackingRepo.findPrimaryForAssignment(assignment.id, client);
        }
      }
    }

    // §13 step 2 — unique assigned coupon (only when stronger evidence missing).
    let reviewRequired = false;
    let reviewReason = null;
    let candidateAssignmentIds = [];
    const couponCode = extractCouponCodeHint(conversion);

    if (!clientAssignmentId && couponCode && this.couponAssignmentRepo?.findActiveByCouponCode) {
      const matches = await this.couponAssignmentRepo.findActiveByCouponCode(couponCode, client);
      const assignmentIds = [
        ...new Set(matches.map((m) => m.assignmentId || m.assignment?.id).filter(Boolean)),
      ];
      candidateAssignmentIds = assignmentIds;

      if (assignmentIds.length === 1) {
        clientAssignmentId = assignmentIds[0];
        evidence = "unique_coupon";
        if (!trackingLink) {
          trackingLink = await this.trackingRepo.findPrimaryForAssignment(clientAssignmentId, client);
        }
      } else if (assignmentIds.length > 1) {
        reviewRequired = true;
        reviewReason = "shared_coupon_ambiguous";
      }
    }

    // §13 step 3 — approved single-assignment rule.
    let campaignSourceId =
      click?.campaignSourceId ?? trackingLink?.campaignSourceId ?? conversion.campaignSourceId ?? null;

    if (!clientAssignmentId && !reviewRequired && campaignSourceId) {
      const singles =
        typeof this.assignmentRepo.findPublishedActiveByCampaignSource === "function"
          ? await this.assignmentRepo.findPublishedActiveByCampaignSource(campaignSourceId, client)
          : [];
      if (singles.length === 1) {
        clientAssignmentId = singles[0].id;
        evidence = "single_assignment";
        if (!trackingLink) {
          trackingLink = await this.trackingRepo.findPrimaryForAssignment(clientAssignmentId, client);
        }
      } else if (singles.length > 1) {
        reviewRequired = true;
        reviewReason = "multiple_assignments_for_source";
        candidateAssignmentIds = singles.map((s) => s.id);
      }
    }

    const trackingLinkId = trackingLink?.id ?? click?.trackingLinkId ?? null;
    campaignSourceId =
      click?.campaignSourceId ?? trackingLink?.campaignSourceId ?? conversion.campaignSourceId ?? null;

    let commissionRule = null;
    if (clientAssignmentId && !reviewRequired) {
      commissionRule = await this.commissionRepo.findEffectiveForAssignment(
        clientAssignmentId,
        conversion.conversionDate,
        client,
      );
    }

    return {
      clickId: click?.id ?? conversion.clickId ?? null,
      trackingLinkId,
      campaignSourceId,
      clientAssignmentId: reviewRequired ? null : clientAssignmentId,
      subId: click?.subId ?? conversion.subId ?? null,
      commissionRule,
      evidence,
      reviewRequired,
      reviewReason,
      candidateAssignmentIds,
      couponCode,
    };
  }
}
