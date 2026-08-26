import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { auditService } from "../../platform/audit/audit.service.js";

/**
 * Epic 5 — TaxLedger (v15 09F step 8).
 * Never invents GST rates or CGST/SGST/IGST splits.
 * Creates tax rows only when ClientTaxProfile has contract rate + legal approval.
 */
export function taxInvoiceRecognitionKey(invoiceId) {
  return `tax:${invoiceId}`;
}

export function round4(n) {
  return Number(Number(n).toFixed(4));
}

export class TaxLedgerService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db });
    this.audit = deps.audit ?? auditService;
  }

  async getOrCreateProfile(clientId, defaults = {}, client = null) {
    const db = client ?? this.db;
    const existing = await db.clientTaxProfile.findUnique({ where: { clientId } });
    if (existing) return existing;
    return db.clientTaxProfile.create({
      data: {
        clientId,
        taxEnabled: defaults.taxEnabled === true,
        taxCountry: defaults.taxCountry ?? null,
        taxRatePercent:
          defaults.taxRatePercent != null ? String(defaults.taxRatePercent) : null,
        taxType: defaults.taxType ?? "UNKNOWN",
        legalReviewStatus: defaults.legalReviewStatus ?? "PENDING",
        notes: defaults.notes ?? null,
        metadata: defaults.metadata ?? undefined,
      },
    });
  }

  /**
   * Evaluate whether tax may be calculated. Never fabricates a rate.
   */
  evaluateTaxReadiness(profile, { currency, taxableAmount } = {}) {
    if (!profile || profile.taxEnabled !== true) {
      return { ok: true, applyTax: false, reason: "tax_disabled" };
    }
    if (profile.legalReviewStatus !== "APPROVED" && profile.legalReviewStatus !== "NOT_REQUIRED") {
      return {
        ok: false,
        applyTax: false,
        reason: "legal_review_required",
        exceptionType: "TAX_LEGAL_REVIEW_REQUIRED",
      };
    }
    if (profile.taxRatePercent == null || profile.taxRatePercent === "") {
      return {
        ok: false,
        applyTax: false,
        reason: "tax_rate_missing",
        exceptionType: "TAX_CONFIGURATION_MISSING",
      };
    }
    if (!profile.taxCountry) {
      return {
        ok: false,
        applyTax: false,
        reason: "tax_country_missing",
        exceptionType: "TAX_CONFIGURATION_MISSING",
      };
    }
    const rate = Number(profile.taxRatePercent);
    if (!Number.isFinite(rate) || rate < 0) {
      return {
        ok: false,
        applyTax: false,
        reason: "tax_rate_invalid",
        exceptionType: "TAX_CONFIGURATION_MISSING",
      };
    }
    const taxable = Number(taxableAmount);
    if (!Number.isFinite(taxable) || taxable < 0) {
      return {
        ok: false,
        applyTax: false,
        reason: "taxable_amount_invalid",
        exceptionType: "TAX_CALCULATION_BLOCKED",
      };
    }
    if (!currency || String(currency).length !== 3) {
      return {
        ok: false,
        applyTax: false,
        reason: "currency_invalid",
        exceptionType: "TAX_CURRENCY_MISMATCH",
      };
    }
    return {
      ok: true,
      applyTax: true,
      taxRate: rate,
      taxAmount: round4((taxable * rate) / 100),
      taxableAmount: round4(taxable),
      taxCountry: profile.taxCountry,
      taxType: profile.taxType || "UNKNOWN",
      calculationPolicy: "CONTRACT_CONFIG",
      currency: String(currency).toUpperCase(),
    };
  }

  async #reportBlocked(profile, invoice, evalResult, client = null) {
    if (!evalResult.exceptionType) return;
    await this.exceptions.report(
      {
        type: evalResult.exceptionType,
        severity: "HIGH",
        clientId: invoice.clientId,
        reason: `TaxLedger blocked: ${evalResult.reason}`,
        dedupeKey: `TAX|${invoice.clientId}|${invoice.id}|${evalResult.exceptionType}`,
        metadata: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          reason: evalResult.reason,
          taxEnabled: profile?.taxEnabled ?? false,
          legalReviewStatus: profile?.legalReviewStatus ?? null,
        },
      },
      client,
    );
  }

  /**
   * Create or reuse TaxLedger for an invoice. Updates invoice.taxAmount + total when applied.
   * Does not rewrite historical invoices that already have POSTED tax (idempotent).
   */
  async applyTaxForInvoice(invoiceId, clientId, { force = false } = {}, client = null) {
    const db = client ?? this.db;
    const invoice = await db.clientInvoice.findFirst({
      where: { id: invoiceId, clientId },
    });
    if (!invoice) throw fail("Invoice not found.", 404);
    if (invoice.status === "VOID") throw fail("Cannot tax a void invoice.", 409);

    const recognitionKey = taxInvoiceRecognitionKey(invoice.id);
    if (!db?.clientTaxProfile?.findUnique || !db?.taxLedger?.findUnique) {
      return { applied: false, blocked: false, reason: "tax_storage_unavailable", invoice };
    }

    const existing = await db.taxLedger.findUnique({ where: { recognitionKey } });
    if (existing && existing.status === "POSTED" && !force) {
      return { applied: true, reused: true, ledger: existing, invoice };
    }

    const profile = await db.clientTaxProfile.findUnique({ where: { clientId } });
    const taxable = Number(invoice.subtotal) + Number(invoice.adjustments || 0);
    const evalResult = this.evaluateTaxReadiness(profile, {
      currency: invoice.currency,
      taxableAmount: taxable,
    });

    if (!evalResult.applyTax) {
      if (!evalResult.ok) {
        await this.#reportBlocked(profile, invoice, evalResult, db);
        return {
          applied: false,
          blocked: true,
          reason: evalResult.reason,
          exceptionType: evalResult.exceptionType,
          invoice,
        };
      }
      // tax disabled — leave invoice unchanged
      return { applied: false, blocked: false, reason: evalResult.reason, invoice };
    }

    const ledgerData = {
      recognitionKey,
      clientId,
      clientInvoiceId: invoice.id,
      clientStatementId: invoice.statementId ?? null,
      invoiceNumber: invoice.invoiceNumber,
      taxCountry: evalResult.taxCountry,
      taxRate: String(evalResult.taxRate),
      taxAmount: String(evalResult.taxAmount),
      taxableAmount: String(evalResult.taxableAmount),
      currency: evalResult.currency,
      taxType: evalResult.taxType,
      calculationPolicy: evalResult.calculationPolicy,
      status: "POSTED",
      metadata: {
        source: "epic5_tax_ledger",
        policy: "CONTRACT_CONFIG",
        note: "Rate from ClientTaxProfile only; no invented GST treatment",
      },
    };

    let ledger;
    if (existing) {
      ledger = await db.taxLedger.update({
        where: { id: existing.id },
        data: { ...ledgerData, status: "POSTED" },
      });
    } else {
      ledger = await db.taxLedger.create({ data: ledgerData });
    }

    const taxAmount = evalResult.taxAmount;
    const total = round4(taxable + taxAmount);
    const updatedInvoice = await db.clientInvoice.update({
      where: { id: invoice.id },
      data: {
        taxAmount: String(taxAmount),
        total: String(total),
      },
    });

    try {
      await this.audit.record({
        aggregateType: "TaxLedger",
        aggregateId: ledger.id,
        action: "TAX_LEDGER_POSTED",
        after: {
          invoiceId: invoice.id,
          taxAmount,
          taxRate: evalResult.taxRate,
          taxCountry: evalResult.taxCountry,
        },
      });
    } catch {
      // ignore
    }

    return { applied: true, reused: false, ledger, invoice: updatedInvoice };
  }
}
