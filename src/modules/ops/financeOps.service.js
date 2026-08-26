import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { netFinancialPosition } from "../finance/commissionCalculation.service.js";
import { ReconciliationService } from "../finance/reconciliation.service.js";
import {
  FinanceConsumerService,
  getFinanceConsumerMode,
} from "../finance/financeConsumer.service.js";
import { evaluateFinanceCutoverGate } from "../finance/financeCutover.service.js";
import {
  classifyHistoricalConversion,
  summarizeHistoricalClassification,
  HISTORICAL_CLASS,
} from "../finance/historicalFinanceCoverage.service.js";

export const RECON_STATUS = Object.freeze({
  MATCHED: "MATCHED",
  MISMATCH: "MISMATCH",
  MISSING_FINANCIAL_RECORD: "MISSING_FINANCIAL_RECORD",
  MISSING_SOURCE_RECORD: "MISSING_SOURCE_RECORD",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  PENDING_REVIEW: "PENDING_REVIEW",
});

/**
 * Wave G — finance operations + multi-level reconciliation.
 * FinancialTransaction remains SoT. Never mutates historical FT rows.
 */
export class FinanceOpsService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.reconciliation = deps.reconciliation ?? new ReconciliationService({ prisma: this.db });
    this.financeConsumer = deps.financeConsumer ?? new FinanceConsumerService({ prisma: this.db });
  }

  async getDashboard({ clientId = null, supplier = null, from = null, to = null, currency = null } = {}) {
    const where = {};
    if (clientId) where.clientId = clientId;
    if (supplier) where.supplier = supplier;
    if (from || to) {
      where.effectiveAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }
    if (currency) {
      where.OR = [{ reportingCurrency: currency }, { originalCurrency: currency }];
    }

    const rows = await this.db.financialTransaction.findMany({ where });
    let supplierReceivable = 0;
    let clientPayable = 0;
    let mboMargin = 0;
    let adjustments = 0;
    let reversals = 0;
    let earned = 0;

    for (const row of rows) {
      const useReporting = currency && row.reportingCurrency === currency;
      supplierReceivable += Number(
        useReporting && row.reportingSupplierReceivable != null
          ? row.reportingSupplierReceivable
          : row.supplierReceivable,
      );
      clientPayable += Number(
        useReporting && row.reportingClientPayable != null
          ? row.reportingClientPayable
          : row.clientPayable,
      );
      mboMargin += Number(
        useReporting && row.reportingMboMargin != null ? row.reportingMboMargin : row.mboMargin,
      );
      if (row.transactionType === "ADJUSTMENT") adjustments += 1;
      if (row.transactionType === "REVERSAL") reversals += 1;
      if (row.transactionType === "COMMISSION_EARNED") earned += 1;
    }

    const openFinanceExceptions = await this.db.exceptionCase.count({
      where: {
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        type: {
          in: [
            "MISSING_FX_RATE",
            "INVALID_CURRENCY",
            "FINANCIAL_RECONCILIATION_MISMATCH",
            "DUPLICATE_FINANCIAL_RECOGNITION",
            "CONFLICTING_FINANCIAL_TRANSACTION",
            "COMMISSION_MISSING",
            "COMMISSION_INVALID",
            "TAX_CONFIGURATION_MISSING",
            "TAX_LEGAL_REVIEW_REQUIRED",
            "TAX_CURRENCY_MISMATCH",
            "TAX_CALCULATION_BLOCKED",
          ],
        },
        ...(clientId ? { clientId } : {}),
      },
    });

    const invoiceAgg = await this.db.clientInvoice.groupBy({
      by: ["status"],
      where: clientId ? { clientId } : undefined,
      _sum: { total: true },
      _count: { _all: true },
    });

    const net = netFinancialPosition(
      rows.map((r) => ({
        supplierReceivable: r.supplierReceivable,
        clientPayable: r.clientPayable,
        mboMargin: r.mboMargin,
      })),
    );

    return {
      filters: { clientId, supplier, from, to, currency },
      totals: {
        supplierReceivable: Number(supplierReceivable.toFixed(4)),
        clientPayable: Number(clientPayable.toFixed(4)),
        mboMargin: Number(mboMargin.toFixed(4)),
        reconciles: Math.abs(supplierReceivable - clientPayable - mboMargin) <= 0.02,
      },
      counts: {
        financialTransactions: rows.length,
        commissionEarned: earned,
        adjustments,
        reversals,
        openFinanceExceptions,
      },
      net,
      invoices: invoiceAgg.map((r) => ({
        status: r.status,
        count: r._count._all,
        total: r._sum.total != null ? Number(r._sum.total) : 0,
      })),
      consumerMode: getFinanceConsumerMode(),
    };
  }

  async reconcileTransaction(id) {
    const ft = await this.db.financialTransaction.findUnique({ where: { id } });
    if (!ft) throw fail("Financial transaction not found.", 404);
    const row = this.reconciliation.reconcileTransaction(ft);
    return {
      level: "transaction",
      status: row.ok ? RECON_STATUS.MATCHED : RECON_STATUS.MISMATCH,
      ...row,
      financialTransactionId: id,
    };
  }

  async reconcileConversion(conversionId) {
    const result = await this.reconciliation.reconcileConversion(conversionId);
    return {
      level: "conversion",
      conversionId,
      status: result.ok ? RECON_STATUS.MATCHED : RECON_STATUS.MISMATCH,
      ...result,
    };
  }

  async reconcileClient(clientId, { from = null, to = null } = {}) {
    if (!clientId) throw fail("clientId is required.", 400);
    const where = { clientId };
    if (from || to) {
      where.effectiveAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }
    const rows = await this.db.financialTransaction.findMany({ where });
    if (!rows.length) {
      return {
        level: "client",
        clientId,
        status: RECON_STATUS.MISSING_FINANCIAL_RECORD,
        net: netFinancialPosition([]),
      };
    }
    const byCurrency = new Map();
    for (const row of rows) {
      const cur = row.reportingCurrency || row.originalCurrency || "UNK";
      if (!byCurrency.has(cur)) byCurrency.set(cur, []);
      byCurrency.get(cur).push(row);
    }
    const currencies = [];
    let allOk = true;
    for (const [currency, list] of byCurrency) {
      const net = netFinancialPosition(list);
      const perRow = list.map((r) => ({ id: r.id, ...this.reconciliation.reconcileTransaction(r) }));
      const ok = net.reconciles && perRow.every((r) => r.ok);
      if (!ok) allOk = false;
      currencies.push({ currency, ok, net, perRowCount: perRow.length });
    }
    return {
      level: "client",
      clientId,
      status: allOk ? RECON_STATUS.MATCHED : RECON_STATUS.MISMATCH,
      currencies,
    };
  }

  async reconcileSupplier(supplier, { from = null, to = null } = {}) {
    if (!supplier) throw fail("supplier is required.", 400);
    const where = { supplier };
    if (from || to) {
      where.effectiveAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }
    const rows = await this.db.financialTransaction.findMany({ where });
    const net = netFinancialPosition(rows);
    return {
      level: "supplier",
      supplier,
      status: net.reconciles ? RECON_STATUS.MATCHED : RECON_STATUS.MISMATCH,
      count: rows.length,
      net,
    };
  }

  async getPortalCutoverReadiness({ clientId = null } = {}) {
    const coverage = await this.financeConsumer.getFinancialCoverage({ clientId });
    const shadow = await this.financeConsumer.compareDailyReportDimensions({ clientId });
    const unexplained = shadow.rows.filter((r) => r.status === "DIFFERENCE");
    const legacyOnly = shadow.summary.legacyOnly;
    const financeOnly = shadow.summary.financeOnly;
    const mode = getFinanceConsumerMode();

    const fxOpen = await this.db.exceptionCase.count({
      where: {
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        type: { in: ["MISSING_FX_RATE", "INVALID_CURRENCY"] },
        ...(clientId ? { clientId } : {}),
      },
    });
    const missingRule = await this.db.exceptionCase.count({
      where: {
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        type: { in: ["COMMISSION_MISSING", "COMMISSION_INVALID"] },
        ...(clientId ? { clientId } : {}),
      },
    });
    const taxOpen = await this.db.exceptionCase.count({
      where: {
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        type: {
          in: [
            "TAX_CONFIGURATION_MISSING",
            "TAX_LEGAL_REVIEW_REQUIRED",
            "TAX_CURRENCY_MISMATCH",
            "TAX_CALCULATION_BLOCKED",
          ],
        },
        ...(clientId ? { clientId } : {}),
      },
    });

    const technicalReady =
      coverage.complete &&
      unexplained.length === 0 &&
      legacyOnly === 0 &&
      financeOnly === 0 &&
      fxOpen === 0 &&
      missingRule === 0 &&
      taxOpen === 0;

    const gate = evaluateFinanceCutoverGate({
      technicalReady,
      coverageComplete: coverage.complete,
      unexplainedDifferences: unexplained.length,
      legacyOnly,
      financeOnly,
      openFxExceptions: fxOpen,
      openCommissionRuleExceptions: missingRule,
      openTaxExceptions: taxOpen,
      currencyConflicts: 0,
      mode,
    });

    return {
      ...gate,
      coverage,
      shadowSummary: shadow.summary,
      unexplainedDifferences: unexplained.length,
      openFxExceptions: fxOpen,
      openCommissionRuleExceptions: missingRule,
      openTaxExceptions: taxOpen,
      criteria: [
        "Financial coverage complete for eligible approved conversions",
        "No unexplained SHADOW differences",
        "No legacy-only / finance-only gaps",
        "No open FX exceptions",
        "No open commission rule exceptions",
        "No open tax configuration exceptions",
        "Explicit FINANCE_CUTOVER_APPROVED=true",
        "Explicit FINANCE_CONSUMER_MODE=FINANCE configuration",
      ],
      note: "LEGACY remains default. No silent cutover.",
    };
  }

  async getDailyReportCutoverReadiness({ clientId = null, from = null, to = null } = {}) {
    const mode = getFinanceConsumerMode();
    const shadow = await this.financeConsumer.compareDailyReportDimensions({ clientId, from, to });
    const coverage = await this.financeConsumer.getFinancialCoverage({ clientId });
    const ready =
      coverage.complete &&
      shadow.summary.differences === 0 &&
      shadow.summary.legacyOnly === 0 &&
      shadow.summary.financeOnly === 0;

    return {
      mode,
      operationalMetricsSource: "Click / Conversion / Order",
      financialMetricsSourceTarget: "FinancialTransaction",
      readyForFinanceDimensionWrites: ready,
      coverage,
      shadowSummary: shadow.summary,
      note: "Historical DailyReport rows are never rewritten automatically.",
    };
  }

  /**
   * Dry-run historical FT coverage classification.
   * Does NOT mutate. Does NOT invent commission/FX/GST values.
   */
  async getHistoricalFinanceCoverage({ clientId = null, limit = 500 } = {}) {
    const coverage = await this.financeConsumer.getFinancialCoverage({ clientId });
    const take = Math.min(Math.max(Number(limit) || 500, 1), 2000);

    const conversions = await this.db.conversion.findMany({
      where: {
        status: { in: ["APPROVED", "PAID"] },
        ...(clientId
          ? {
              clientAssignment: { clientId },
            }
          : {}),
      },
      take,
      orderBy: { updatedAt: "desc" },
      include: {
        order: { select: { validationStatus: true, currency: true } },
        clientAssignment: { select: { clientId: true } },
        financialTransactions: {
          where: { transactionType: "COMMISSION_EARNED" },
          select: { id: true },
          take: 1,
        },
      },
    });

    const clientIds = [
      ...new Set(
        conversions
          .map((c) => c.clientAssignment?.clientId || clientId)
          .filter(Boolean),
      ),
    ];
    const fxByClient = new Map();
    const ruleByClient = new Map();
    for (const cid of clientIds) {
      const [fxOpen, ruleOpen] = await Promise.all([
        this.db.exceptionCase.count({
          where: {
            clientId: cid,
            status: { in: ["OPEN", "ACKNOWLEDGED"] },
            type: { in: ["MISSING_FX_RATE", "INVALID_CURRENCY"] },
          },
        }),
        this.db.exceptionCase.count({
          where: {
            clientId: cid,
            status: { in: ["OPEN", "ACKNOWLEDGED"] },
            type: { in: ["COMMISSION_MISSING", "COMMISSION_INVALID"] },
          },
        }),
      ]);
      fxByClient.set(cid, fxOpen);
      ruleByClient.set(cid, ruleOpen);
    }

    const classified = [];
    for (const c of conversions) {
      const clientIdResolved = c.clientAssignment?.clientId || clientId || null;
      const result = classifyHistoricalConversion({
        status: c.status,
        supplierCommission: c.supplierCommission,
        currency: c.currency,
        clientAssignmentId: c.clientAssignmentId,
        clientId: clientIdResolved,
        order: c.order,
        hasEarnFinancialTransaction: (c.financialTransactions || []).length > 0,
        openFxException: clientIdResolved ? (fxByClient.get(clientIdResolved) || 0) > 0 : false,
        openCommissionRuleException: clientIdResolved
          ? (ruleByClient.get(clientIdResolved) || 0) > 0
          : false,
        missingEffectiveRule: false,
        shadowDiscrepancy: false,
      });
      classified.push({
        conversionId: c.id,
        ...result,
      });
    }

    const summary = summarizeHistoricalClassification(classified);
    return {
      ...summary,
      SAFE_TO_BACKFILL: summary.counts.SAFE_TO_BACKFILL,
      NEEDS_REVIEW: summary.counts.NEEDS_REVIEW,
      INSUFFICIENT_DATA: summary.counts.INSUFFICIENT_DATA,
      ALREADY_RECOGNIZED: summary.counts.ALREADY_RECOGNIZED,
      coverage,
      sampled: classified.length,
      sampleLimit: take,
      classes: HISTORICAL_CLASS,
      rows: classified.slice(0, 50),
    };
  }
}
