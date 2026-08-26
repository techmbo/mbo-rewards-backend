import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { auditService } from "../../platform/audit/audit.service.js";
import { TaxLedgerService } from "./taxLedger.service.js";

/**
 * Minimal invoice + payment foundation.
 * Invoice cannot be PAID without a CONFIRMED ClientPayment.
 * Epic 5: optional TaxLedger attach on create/issue when contract tax config present.
 */
export class InvoiceService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.audit = deps.audit ?? auditService;
    this.taxLedger = deps.taxLedger ?? new TaxLedgerService({ prisma: this.db, audit: this.audit });
  }

  async getInvoiceForClient(invoiceId, clientId, client = null) {
    const db = client ?? this.db;
    const row = await db.clientInvoice.findFirst({
      where: { id: invoiceId, clientId },
      include: { payments: true, statement: true, taxLedgers: true },
    });
    if (!row) throw fail("Invoice not found.", 404);
    return row;
  }

  async createFromStatement(statementId, clientId, { invoiceNumber, dueAt, applyTax = true } = {}, client = null) {
    const db = client ?? this.db;
    const statement = await db.clientStatement.findFirst({
      where: { id: statementId, clientId },
    });
    if (!statement) throw fail("Statement not found.", 404);

    const total = Number(statement.closingBalance);
    if (total < 0) throw fail("Cannot invoice negative statement balance.", 409);

    const number =
      invoiceNumber ||
      `INV-${clientId.slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;

    let invoice = await db.clientInvoice.create({
      data: {
        invoiceNumber: number,
        clientId,
        statementId: statement.id,
        currency: statement.currency,
        subtotal: total.toFixed(4),
        adjustments: "0",
        taxAmount: "0",
        total: total.toFixed(4),
        status: "DRAFT",
        dueAt: dueAt ? new Date(dueAt) : null,
      },
    });

    if (applyTax) {
      const taxResult = await this.taxLedger.applyTaxForInvoice(invoice.id, clientId, {}, db);
      if (taxResult.invoice) invoice = taxResult.invoice;
    }

    return invoice;
  }

  async issue(invoiceId, clientId, client = null) {
    const invoice = await this.getInvoiceForClient(invoiceId, clientId, client);
    if (invoice.status !== "DRAFT") throw fail("Only DRAFT invoices can be issued.", 409);
    const db = client ?? this.db;
    const updated = await db.clientInvoice.update({
      where: { id: invoiceId },
      data: { status: "ISSUED", issuedAt: new Date() },
    });
    try {
      await this.audit.record({
        aggregateType: "ClientInvoice",
        aggregateId: invoiceId,
        action: "INVOICE_ISSUED",
        after: { status: "ISSUED", total: updated.total },
      });
    } catch {
      // ignore
    }
    return updated;
  }

  /**
   * Record a client payment. Does not mark invoice PAID until CONFIRMED and covers total.
   */
  async recordPayment(
    { clientId, invoiceId, amount, currency, reference, confirm = false },
    client = null,
  ) {
    if (!clientId) throw fail("clientId is required.", 400);
    const db = client ?? this.db;
    const invoice = invoiceId
      ? await this.getInvoiceForClient(invoiceId, clientId, db)
      : null;

    if (invoice && invoice.status === "VOID") {
      throw fail("Cannot pay a void invoice.", 409);
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) throw fail("Invalid payment amount.", 400);

    if (invoice) {
      const paidSoFar = (invoice.payments || [])
        .filter((p) => p.status === "CONFIRMED")
        .reduce((s, p) => s + Number(p.amount), 0);
      if (paidSoFar + amt - Number(invoice.total) > 0.0001) {
        throw fail("Payment cannot exceed invoice payable balance.", 409);
      }
    }

    const payment = await db.clientPayment.create({
      data: {
        clientId,
        invoiceId: invoiceId || null,
        amount: amt.toFixed(4),
        currency: String(currency || invoice?.currency || "USD").toUpperCase(),
        status: confirm ? "CONFIRMED" : "PENDING",
        paidAt: confirm ? new Date() : null,
        reference: reference || null,
      },
    });

    try {
      await this.audit.record({
        aggregateType: "ClientPayment",
        aggregateId: payment.id,
        action: "PAYMENT_RECORDED",
        after: { amount: payment.amount, status: payment.status, invoiceId },
      });
    } catch {
      // ignore
    }

    if (confirm && invoice) {
      await this.refreshInvoicePaidStatus(invoice.id, clientId, db);
    }

    return payment;
  }

  async confirmPayment(paymentId, clientId, client = null) {
    const db = client ?? this.db;
    const payment = await db.clientPayment.findFirst({
      where: { id: paymentId, clientId },
    });
    if (!payment) throw fail("Payment not found.", 404);

    const updated = await db.clientPayment.update({
      where: { id: paymentId },
      data: { status: "CONFIRMED", paidAt: new Date() },
    });

    if (payment.invoiceId) {
      await this.refreshInvoicePaidStatus(payment.invoiceId, clientId, db);
    }
    return updated;
  }

  async refreshInvoicePaidStatus(invoiceId, clientId, client = null) {
    const invoice = await this.getInvoiceForClient(invoiceId, clientId, client);
    const db = client ?? this.db;
    const confirmed = (invoice.payments || [])
      .filter((p) => p.status === "CONFIRMED")
      .reduce((s, p) => s + Number(p.amount), 0);
    const total = Number(invoice.total);

    let status = invoice.status;
    let paidAt = invoice.paidAt;
    if (confirmed <= 0) {
      status = invoice.issuedAt ? "ISSUED" : "DRAFT";
      paidAt = null;
    } else if (confirmed + 0.0001 >= total) {
      status = "PAID";
      paidAt = new Date();
    } else {
      status = "PARTIALLY_PAID";
      paidAt = null;
    }

    // Never mark PAID without confirmed payment (confirmed > 0 already required).
    return db.clientInvoice.update({
      where: { id: invoiceId },
      data: { status, paidAt },
    });
  }
}
