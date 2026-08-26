import { fail } from "../../core/apiResponse.js";
import { prisma } from "../../database/prisma.js";
import { auditService } from "../../platform/audit/audit.service.js";
import { ExceptionCaseService } from "./exceptionCase.service.js";

export const SUPPLIER_PAYMENT_TRANSITIONS = {
  PAYMENT_PENDING: [
    "PAYMENT_AWAITING_INVOICE",
    "PAYMENT_INVOICED",
    "PAYMENT_PAYABLE",
    "PAYMENT_RECEIVED",
    "PAYMENT_ON_HOLD",
  ],
  PAYMENT_AWAITING_INVOICE: ["PAYMENT_INVOICED", "PAYMENT_PAYABLE", "PAYMENT_ON_HOLD", "PAYMENT_PENDING"],
  PAYMENT_INVOICED: ["PAYMENT_PAYABLE", "PAYMENT_RECEIVED", "PAYMENT_ON_HOLD"],
  PAYMENT_PAYABLE: ["PAYMENT_RECEIVED", "PAYMENT_ON_HOLD"],
  PAYMENT_RECEIVED: ["PAYMENT_ON_HOLD"],
  PAYMENT_ON_HOLD: [
    "PAYMENT_PENDING",
    "PAYMENT_AWAITING_INVOICE",
    "PAYMENT_INVOICED",
    "PAYMENT_PAYABLE",
    "PAYMENT_RECEIVED",
  ],
};

export const CLIENT_PAYMENT_TRANSITIONS = {
  CLIENT_PAYMENT_NOT_READY: ["CLIENT_PAYMENT_PAYABLE", "CLIENT_PAYMENT_ON_HOLD"],
  CLIENT_PAYMENT_PAYABLE: [
    "CLIENT_PAYMENT_INVOICED",
    "CLIENT_PAYMENT_PROCESSING",
    "CLIENT_PAYMENT_PAID",
    "CLIENT_PAYMENT_ON_HOLD",
    "CLIENT_PAYMENT_NOT_READY",
  ],
  CLIENT_PAYMENT_INVOICED: ["CLIENT_PAYMENT_PROCESSING", "CLIENT_PAYMENT_PAID", "CLIENT_PAYMENT_ON_HOLD"],
  CLIENT_PAYMENT_PROCESSING: ["CLIENT_PAYMENT_PAID", "CLIENT_PAYMENT_ON_HOLD", "CLIENT_PAYMENT_PAYABLE"],
  CLIENT_PAYMENT_PAID: ["CLIENT_PAYMENT_ON_HOLD"],
  CLIENT_PAYMENT_ON_HOLD: [
    "CLIENT_PAYMENT_NOT_READY",
    "CLIENT_PAYMENT_PAYABLE",
    "CLIENT_PAYMENT_INVOICED",
    "CLIENT_PAYMENT_PROCESSING",
  ],
};

/**
 * Wave C payment state machine — transaction truth only (no ledger).
 * v15: supplier funds precede client payment readiness where enforced below.
 */
export class PaymentStateService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.audit = deps.audit ?? auditService;
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db, audit: this.audit });
    /** When true, client cannot become PAYABLE until supplier PAYMENT_RECEIVED. */
    this.requireSupplierReceivedForClientPayable =
      deps.requireSupplierReceivedForClientPayable !== false;
  }

  assertSupplierTransition(from, to) {
    if (from === to) return true;
    const allowed = SUPPLIER_PAYMENT_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
      throw fail(`Invalid supplier payment transition: ${from} → ${to}`, 409);
    }
    return true;
  }

  assertClientTransition(from, to) {
    if (from === to) return true;
    const allowed = CLIENT_PAYMENT_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
      throw fail(`Invalid client payment transition: ${from} → ${to}`, 409);
    }
    return true;
  }

  async transitionSupplierPayment(orderId, toStatus, { reason, actorId } = {}, client = null) {
    const db = client ?? this.db;
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) throw fail("Order not found.", 404);

    if (order.validationStatus === "VALIDATION_REJECTED") {
      if (toStatus === "PAYMENT_PAYABLE" || toStatus === "PAYMENT_RECEIVED") {
        await this.exceptions.report(
          {
            type: "INVALID_PAYMENT_TRANSITION",
            severity: "HIGH",
            supplier: order.supplier,
            orderId: order.id,
            reason: "Rejected order cannot become supplier payable/received",
            metadata: { toStatus },
          },
          db,
        );
        throw fail("Rejected order cannot become supplier payable/received.", 409);
      }
    }

    try {
      this.assertSupplierTransition(order.supplierPaymentStatus, toStatus);
    } catch (error) {
      await this.exceptions.report(
        {
          type: "INVALID_PAYMENT_TRANSITION",
          severity: "MEDIUM",
          supplier: order.supplier,
          orderId: order.id,
          reason: error.message,
          metadata: { kind: "supplier", from: order.supplierPaymentStatus, to: toStatus },
        },
        db,
      );
      throw error;
    }

    const updated = await db.order.update({
      where: { id: orderId },
      data: {
        supplierPaymentStatus: toStatus,
        supplierPaymentChangedAt: new Date(),
      },
    });

    try {
      await this.audit.record({
        aggregateType: "Order",
        aggregateId: orderId,
        action: "order.supplier_payment.changed",
        actorId,
        before: { supplierPaymentStatus: order.supplierPaymentStatus },
        after: { supplierPaymentStatus: toStatus },
        reason,
      });
    } catch {
      // ignore
    }

    return updated;
  }

  async transitionClientPayment(orderId, toStatus, { reason, actorId } = {}, client = null) {
    const db = client ?? this.db;
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) throw fail("Order not found.", 404);

    if (order.validationStatus === "VALIDATION_REJECTED") {
      if (toStatus !== "CLIENT_PAYMENT_ON_HOLD" && toStatus !== "CLIENT_PAYMENT_NOT_READY") {
        await this.exceptions.report(
          {
            type: "INVALID_PAYMENT_TRANSITION",
            severity: "HIGH",
            supplier: order.supplier,
            orderId: order.id,
            clientId: order.clientId,
            reason: "Rejected order cannot enter client payable/paid states",
            metadata: { toStatus },
          },
          db,
        );
        throw fail("Rejected order cannot enter client payable/paid states.", 409);
      }
    }

    if (
      this.requireSupplierReceivedForClientPayable &&
      toStatus === "CLIENT_PAYMENT_PAYABLE" &&
      order.supplierPaymentStatus !== "PAYMENT_RECEIVED" &&
      order.validationStatus === "VALIDATION_APPROVED"
    ) {
      throw fail(
        "Client payment cannot become PAYABLE until supplier payment is RECEIVED.",
        409,
      );
    }

    try {
      this.assertClientTransition(order.clientPaymentStatus, toStatus);
    } catch (error) {
      await this.exceptions.report(
        {
          type: "INVALID_PAYMENT_TRANSITION",
          severity: "MEDIUM",
          supplier: order.supplier,
          orderId: order.id,
          clientId: order.clientId,
          reason: error.message,
          metadata: { kind: "client", from: order.clientPaymentStatus, to: toStatus },
        },
        db,
      );
      throw error;
    }

    const updated = await db.order.update({
      where: { id: orderId },
      data: {
        clientPaymentStatus: toStatus,
        clientPaymentChangedAt: new Date(),
      },
    });

    try {
      await this.audit.record({
        aggregateType: "Order",
        aggregateId: orderId,
        action: "order.client_payment.changed",
        actorId,
        before: { clientPaymentStatus: order.clientPaymentStatus },
        after: { clientPaymentStatus: toStatus },
        reason,
      });
    } catch {
      // ignore
    }

    return updated;
  }
}
