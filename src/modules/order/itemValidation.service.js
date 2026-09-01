import { fail } from "../../core/apiResponse.js";
import { prisma } from "../../database/prisma.js";
import { auditService } from "../../platform/audit/audit.service.js";
import { ExceptionCaseService } from "./exceptionCase.service.js";
import { FinancialTransactionService } from "../finance/financialTransaction.service.js";
import { VALIDATION_TRANSITIONS } from "./validation.service.js";

/**
 * Epic 9 — OrderItem validation transitions (VAL-006).
 * Reuses ValidationStatus enum + same transition matrix as order-level ValidationService.
 * Does not invent PARTIAL_APPROVAL on Order.
 */
export class ItemValidationService {
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
    // null / unknown → treat as PENDING for transition legality
    const fromKey = from == null || from === "" ? "VALIDATION_PENDING" : from;
    if (fromKey === to) return true;
    const allowed = VALIDATION_TRANSITIONS[fromKey] || [];
    if (!allowed.includes(to)) {
      throw fail(`Invalid item validation transition: ${fromKey} → ${to}`, 409);
    }
    return true;
  }

  /**
   * @param {string} orderItemId
   * @param {string} toStatus
   * @param {{ reason?: string, actorId?: string, expectedClientId?: string|null }} opts
   *   expectedClientId: when set (partner context), must match order.clientId
   */
  async transitionItem(orderItemId, toStatus, { reason, actorId, expectedClientId = undefined } = {}, client = null) {
    const db = client ?? this.db;
    const item = await db.orderItem.findUnique({
      where: { id: orderItemId },
      include: {
        order: {
          include: {
            items: true,
            conversions: true,
          },
        },
      },
    });
    if (!item) throw fail("Order item not found.", 404);
    const order = item.order;
    if (!order) throw fail("Parent order not found.", 404);

    if (expectedClientId !== undefined && expectedClientId !== null) {
      if (!order.clientId || String(order.clientId) !== String(expectedClientId)) {
        throw fail("Order item does not belong to authenticated tenant.", 403);
      }
    }

    const from = item.validationStatus ?? null;
    try {
      this.assertTransition(from, toStatus);
    } catch (error) {
      await this.exceptions.report(
        {
          type: "INVALID_VALIDATION_TRANSITION",
          severity: "MEDIUM",
          supplier: order.supplier,
          orderId: order.id,
          clientId: order.clientId,
          reason: error.message,
          metadata: { orderItemId, from, to: toStatus, scope: "order_item" },
        },
        db,
      );
      throw error;
    }

    if (from === toStatus) {
      return { item, order, unchanged: true };
    }

    const now = new Date();
    const updated = await db.orderItem.update({
      where: { id: orderItemId },
      data: {
        validationStatus: toStatus,
        validationChangedAt: now,
      },
    });

    try {
      await this.audit.record({
        aggregateType: "OrderItem",
        aggregateId: orderItemId,
        action: "order_item.validation.changed",
        actorId,
        before: { validationStatus: from },
        after: { validationStatus: toStatus },
        reason,
        metadata: { orderId: order.id },
      });
    } catch {
      // ignore
    }

    // Refresh order items for finance sync
    const refreshedOrder = await db.order.findUnique({
      where: { id: order.id },
      include: { items: true, conversions: true },
    });

    let financeResult = null;
    if (refreshedOrder?.validationStatus === "VALIDATION_APPROVED") {
      try {
        financeResult = await this.finance.syncApprovedBasisForOrder(
          { orderId: order.id, reason: reason || `Item ${toStatus}` },
          db,
        );
      } catch {
        // Exceptions recorded inside finance service
      }
    }

    return { item: updated, order: refreshedOrder, unchanged: false, financeResult };
  }

  async approveItem(orderItemId, opts = {}, client = null) {
    return this.transitionItem(orderItemId, "VALIDATION_APPROVED", opts, client);
  }

  async rejectItem(orderItemId, opts = {}, client = null) {
    return this.transitionItem(orderItemId, "VALIDATION_REJECTED", opts, client);
  }

  async markItemNeedsReview(orderItemId, opts = {}, client = null) {
    return this.transitionItem(orderItemId, "VALIDATION_NEEDS_REVIEW", opts, client);
  }

  async markItemPending(orderItemId, opts = {}, client = null) {
    return this.transitionItem(orderItemId, "VALIDATION_PENDING", opts, client);
  }
}
