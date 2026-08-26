import { fail } from "../../core/apiResponse.js";
import { prisma } from "../../database/prisma.js";
import { auditService } from "../../platform/audit/audit.service.js";
import { mapLegacyConversionStatus } from "./orderMerge.js";
import { ExceptionCaseService } from "./exceptionCase.service.js";
import { FinancialTransactionService } from "../finance/financialTransaction.service.js";

/**
 * Legal validation transitions (Wave C).
 */
export const VALIDATION_TRANSITIONS = {
  VALIDATION_PENDING: ["VALIDATION_APPROVED", "VALIDATION_REJECTED", "VALIDATION_NEEDS_REVIEW"],
  VALIDATION_NEEDS_REVIEW: ["VALIDATION_APPROVED", "VALIDATION_REJECTED", "VALIDATION_PENDING"],
  VALIDATION_APPROVED: ["VALIDATION_REJECTED", "VALIDATION_NEEDS_REVIEW"],
  VALIDATION_REJECTED: ["VALIDATION_NEEDS_REVIEW"], // reopen for review only; not silently to APPROVED
};

export class ValidationService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.audit = deps.audit ?? auditService;
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db, audit: this.audit });
    this.finance =
      deps.finance ??
      new FinancialTransactionService({
        prisma: this.db,
        audit: this.audit,
        exceptions: this.exceptions,
      });
  }

  assertTransition(from, to) {
    const allowed = VALIDATION_TRANSITIONS[from] || [];
    if (from === to) return true;
    if (!allowed.includes(to)) {
      throw fail(`Invalid validation transition: ${from} → ${to}`, 409);
    }
    return true;
  }

  /**
   * Transition Order.validationStatus with rejection safety + late-rejection history.
   * Does not destroy historical commission amounts (stores lastApproved*).
   */
  async transition(orderId, toStatus, { reason, actorId, syncLegacyConversion = true } = {}, client = null) {
    const db = client ?? this.db;
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: { conversions: true },
    });
    if (!order) throw fail("Order not found.", 404);

    const from = order.validationStatus;
    try {
      this.assertTransition(from, toStatus);
    } catch (error) {
      await this.exceptions.report(
        {
          type: "INVALID_VALIDATION_TRANSITION",
          severity: "HIGH",
          supplier: order.supplier,
          orderId: order.id,
          clientId: order.clientId,
          reason: error.message,
          metadata: { from, to: toStatus },
        },
        db,
      );
      throw error;
    }

    const now = new Date();
    const data = {
      validationStatus: toStatus,
      validationChangedAt: now,
    };

    // Late rejection: preserve historical commission snapshot; mark non-payable.
    if (from === "VALIDATION_APPROVED" && toStatus === "VALIDATION_REJECTED") {
      const linked = order.conversions?.[0];
      data.lastApprovedClientCommission =
        order.lastApprovedClientCommission ?? linked?.clientCommission ?? null;
      data.lastApprovedMboCommission =
        order.lastApprovedMboCommission ?? linked?.mboCommission ?? null;
      data.lastApprovedSupplierCommission =
        order.lastApprovedSupplierCommission ?? linked?.supplierCommission ?? null;
      data.clientPaymentStatus = "CLIENT_PAYMENT_ON_HOLD";
      data.clientPaymentChangedAt = now;
      if (
        order.supplierPaymentStatus === "PAYMENT_PAYABLE" ||
        order.supplierPaymentStatus === "PAYMENT_PENDING"
      ) {
        data.supplierPaymentStatus = "PAYMENT_ON_HOLD";
        data.supplierPaymentChangedAt = now;
      }

      await this.exceptions.report(
        {
          type: "LATE_REJECTION",
          severity: "HIGH",
          supplier: order.supplier,
          orderId: order.id,
          clientId: order.clientId,
          conversionId: linked?.id ?? null,
          reason: reason || "Previously approved order rejected",
          metadata: {
            preservedClientCommission: data.lastApprovedClientCommission,
            preservedMboCommission: data.lastApprovedMboCommission,
            preservedSupplierCommission: data.lastApprovedSupplierCommission,
          },
        },
        db,
      );
    }

    if (toStatus === "VALIDATION_REJECTED") {
      data.clientPaymentStatus = data.clientPaymentStatus || "CLIENT_PAYMENT_ON_HOLD";
      if (!data.clientPaymentChangedAt) data.clientPaymentChangedAt = now;
    }

    if (toStatus === "VALIDATION_APPROVED" && from !== "VALIDATION_APPROVED") {
      // Snapshot current linked conversion commissions when approving.
      const linked = order.conversions?.[0];
      if (linked?.clientCommission != null) {
        data.lastApprovedClientCommission = linked.clientCommission;
      }
      if (linked?.mboCommission != null) {
        data.lastApprovedMboCommission = linked.mboCommission;
      }
      if (linked?.supplierCommission != null) {
        data.lastApprovedSupplierCommission = linked.supplierCommission;
      }
    }

    const updated = await db.order.update({ where: { id: orderId }, data });

    if (syncLegacyConversion && order.conversions?.length) {
      const legacyStatus = mapLegacyConversionStatus(toStatus);
      for (const conversion of order.conversions) {
        const convPatch = {
          status: legacyStatus,
          approvedDate: toStatus === "VALIDATION_APPROVED" ? now : conversion.approvedDate,
        };
        // Rejection: clear *current* payable fields but leave lastApproved* on Order.
        if (toStatus === "VALIDATION_REJECTED") {
          convPatch.clientCommission = null;
          convPatch.mboCommission = null;
          convPatch.metadata = {
            ...(conversion.metadata && typeof conversion.metadata === "object" ? conversion.metadata : {}),
            commissionUnresolvedReason: "rejected_validation",
            preservedOnOrder: true,
            lateRejectionAt: from === "VALIDATION_APPROVED" ? now.toISOString() : undefined,
          };
        }
        await db.conversion.update({ where: { id: conversion.id }, data: convPatch });
      }
    }

    // Wave D — financial recognition / late-rejection reversal (immutable FT trail).
    if (toStatus === "VALIDATION_APPROVED" && from !== "VALIDATION_APPROVED") {
      for (const conversion of order.conversions || []) {
        try {
          await this.finance.recognizeConversion(
            { orderId: order.id, conversionId: conversion.id },
            db,
          );
        } catch {
          // Recognition failures are surfaced via ExceptionCase inside finance service.
        }
      }
    }

    if (from === "VALIDATION_APPROVED" && toStatus === "VALIDATION_REJECTED") {
      for (const conversion of order.conversions || []) {
        try {
          await this.finance.reverseForLateRejection(
            {
              conversionId: conversion.id,
              orderId: order.id,
              reason: reason || "Late validation rejection",
            },
            db,
          );
        } catch {
          // Reversal failures reported via exceptions inside finance service.
        }
      }
    }

    try {
      await this.audit.record({
        aggregateType: "Order",
        aggregateId: orderId,
        action: "order.validation.changed",
        actorId,
        before: { validationStatus: from },
        after: { validationStatus: toStatus },
        reason,
      });
    } catch {
      // ignore
    }

    return updated;
  }

  isPayable(order) {
    return order?.validationStatus === "VALIDATION_APPROVED";
  }
}
