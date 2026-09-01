import { prisma } from "../../database/prisma.js";
import { netFinancialPosition } from "./commissionCalculation.service.js";
import { isRejectedConversionStatus } from "../reporting/attributionMath.js";
import { auditService } from "../../platform/audit/audit.service.js";

export const FINANCE_CONSUMER_MODES = Object.freeze({
  LEGACY: "LEGACY",
  SHADOW: "SHADOW",
  FINANCE: "FINANCE",
});

export const COMPARISON_STATUS = Object.freeze({
  MATCH: "MATCH",
  DIFFERENCE: "DIFFERENCE",
  NO_FINANCIAL_DATA: "NO_FINANCIAL_DATA",
  LEGACY_ONLY: "LEGACY_ONLY",
  FINANCE_ONLY: "FINANCE_ONLY",
});

function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(4)) : 0;
}

function dayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve finance consumer mode from env (default LEGACY).
 */
export function getFinanceConsumerMode() {
  const raw = String(process.env.FINANCE_CONSUMER_MODE || "LEGACY").trim().toUpperCase();
  return FINANCE_CONSUMER_MODES[raw] ?? FINANCE_CONSUMER_MODES.LEGACY;
}

/**
 * Wave F — compare legacy Conversion snapshots vs FinancialTransaction net.
 */
export class FinanceConsumerService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.audit = deps.audit ?? auditService;
    this.mode = deps.mode ?? getFinanceConsumerMode();
  }

  getMode() {
    return this.mode ?? getFinanceConsumerMode();
  }

  /**
   * Legacy client commission from Conversion snapshots (Wave A safe — no supplier fallback).
   */
  sumLegacyClientCommission(conversions = [], { includePending = true } = {}) {
    let approved = 0;
    let pending = 0;
    for (const conv of conversions) {
      if (isRejectedConversionStatus(conv.status)) continue;
      const amt =
        conv.clientCommission != null && conv.clientCommission !== ""
          ? money(conv.clientCommission)
          : 0;
      const status = String(conv.status || "").toUpperCase();
      if (status === "APPROVED" || status === "PAID") approved += amt;
      else if (includePending) pending += amt;
    }
    return {
      approved: money(approved),
      pending: money(pending),
      total: money(approved + pending),
    };
  }

  /**
   * Net client payable from FinancialTransaction rows (includes reversals/adjustments).
   */
  sumFinanceClientPayable(transactions = [], { useReporting = true, reportingCurrency = null } = {}) {
    if (!transactions.length) {
      return { net: 0, supplier: 0, margin: 0, currency: reportingCurrency, count: 0 };
    }
    let net = 0;
    let included = 0;
    for (const row of transactions) {
      const rowReportingCur = row.reportingCurrency || null;
      const rowOriginalCur = row.originalCurrency || null;
      if (reportingCurrency) {
        const matchesReporting =
          rowReportingCur === reportingCurrency &&
          row.reportingClientPayable != null &&
          useReporting;
        const matchesOriginal =
          !rowReportingCur && rowOriginalCur === reportingCurrency;
        if (!matchesReporting && !matchesOriginal) continue;
      }
      const useReportingAmount =
        useReporting &&
        reportingCurrency &&
        rowReportingCur === reportingCurrency &&
        row.reportingClientPayable != null;
      net += Number(useReportingAmount ? row.reportingClientPayable : row.clientPayable || 0);
      included += 1;
    }
    const position = netFinancialPosition(transactions);
    const currency =
      reportingCurrency ||
      transactions.find((t) => t.reportingCurrency)?.reportingCurrency ||
      transactions.find((t) => t.originalCurrency)?.originalCurrency ||
      null;
    return {
      net: money(net),
      supplier: money(position.supplierReceivable),
      margin: money(position.mboMargin),
      currency,
      count: included,
      reconciles: position.reconciles,
    };
  }

  async loadClientFinancialTransactions(clientId, { from, to, assignmentIds = null } = {}, client = null) {
    const db = client ?? this.db;
    const where = { clientId };
    if (from || to) {
      where.effectiveAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    }
    if (assignmentIds?.length) {
      where.conversion = { clientAssignmentId: { in: assignmentIds } };
    }
    return db.financialTransaction.findMany({
      where,
      orderBy: { effectiveAt: "asc" },
    });
  }

  async loadClientConversions(clientId, { from, to, assignmentIds } = {}, client = null) {
    const db = client ?? this.db;
    if (!assignmentIds?.length) return [];
    return db.conversion.findMany({
      where: {
        clientAssignmentId: { in: assignmentIds },
        ...(from || to
          ? {
              conversionDate: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      select: {
        id: true,
        clientAssignmentId: true,
        conversionDate: true,
        status: true,
        clientCommission: true,
        currency: true,
      },
    });
  }

  compareAmounts(legacyAmount, financeAmount, { tolerance = 0.0002 } = {}) {
    const diff = money(financeAmount - legacyAmount);
    const abs = Math.abs(diff);
    let status = COMPARISON_STATUS.MATCH;
    if (legacyAmount === 0 && financeAmount === 0) status = COMPARISON_STATUS.MATCH;
    else if (legacyAmount !== 0 && financeAmount === 0) status = COMPARISON_STATUS.LEGACY_ONLY;
    else if (legacyAmount === 0 && financeAmount !== 0) status = COMPARISON_STATUS.FINANCE_ONLY;
    else if (abs > tolerance) status = COMPARISON_STATUS.DIFFERENCE;
    else status = COMPARISON_STATUS.MATCH;
    return { legacyAmount: money(legacyAmount), financeAmount: money(financeAmount), difference: diff, status };
  }

  /**
   * Client-level comparison (portal / payments use case).
   */
  async compareClientEarnings(clientId, { from, to, assignmentIds, reportingCurrency = null } = {}, client = null) {
    const db = client ?? this.db;
    const ids =
      assignmentIds ??
      (
        await db.clientCampaignAssignment.findMany({
          where: { clientId, status: { not: "REVOKED" } },
          select: { id: true },
        })
      ).map((a) => a.id);

    const [conversions, transactions] = await Promise.all([
      this.loadClientConversions(clientId, { from, to, assignmentIds: ids }, db),
      this.loadClientFinancialTransactions(clientId, { from, to, assignmentIds: ids }, db),
    ]);

    const legacy = this.sumLegacyClientCommission(conversions);
    const finance = this.sumFinanceClientPayable(transactions, { reportingCurrency });
    const cmp = this.compareAmounts(legacy.approved, finance.net);

    return {
      clientId,
      mode: this.getMode(),
      legacy,
      finance,
      comparison: cmp,
      conversionCount: conversions.length,
      financialTransactionCount: transactions.length,
    };
  }

  /**
   * Grouped comparison for DailyReport shadow (client + date + currency).
   */
  async compareDailyReportDimensions({ from, to, clientId } = {}, client = null) {
    const db = client ?? this.db;
    const assignmentFilter = clientId ? { clientId, status: { not: "REVOKED" } } : { status: { not: "REVOKED" } };
    const assignments = await db.clientCampaignAssignment.findMany({
      where: assignmentFilter,
      select: { id: true, clientId: true },
    });
    const assignmentIds = assignments.map((a) => a.id);
    const assignmentClient = new Map(assignments.map((a) => [a.id, a.clientId]));

    const [conversions, transactions] = await Promise.all([
      this.loadClientConversions(clientId || undefined, { from, to, assignmentIds }, db),
      clientId
        ? this.loadClientFinancialTransactions(clientId, { from, to }, db)
        : db.financialTransaction.findMany({
            where: {
              ...(from || to
                ? {
                    effectiveAt: {
                      ...(from ? { gte: from } : {}),
                      ...(to ? { lte: to } : {}),
                    },
                  }
                : {}),
            },
          }),
    ]);

    const legacyByKey = new Map();
    for (const conv of conversions) {
      if (!conv.clientAssignmentId) continue;
      const cid = assignmentClient.get(conv.clientAssignmentId);
      if (!cid) continue;
      const dk = dayKey(conv.conversionDate);
      const cur = conv.currency || "UNK";
      const key = `${cid}|${dk}|${cur}`;
      if (!legacyByKey.has(key)) legacyByKey.set(key, []);
      legacyByKey.get(key).push(conv);
    }

    const financeByKey = new Map();
    for (const txn of transactions) {
      const dk = dayKey(txn.effectiveAt);
      const cur = txn.reportingCurrency || txn.originalCurrency || "UNK";
      const key = `${txn.clientId}|${dk}|${cur}`;
      if (!financeByKey.has(key)) financeByKey.set(key, []);
      financeByKey.get(key).push(txn);
    }

    const keys = new Set([...legacyByKey.keys(), ...financeByKey.keys()]);
    const rows = [];
    let matches = 0;
    let differences = 0;
    let legacyOnly = 0;
    let financeOnly = 0;

    for (const key of keys) {
      const legacy = this.sumLegacyClientCommission(legacyByKey.get(key) || []);
      const finance = this.sumFinanceClientPayable(financeByKey.get(key) || []);
      const cmp = this.compareAmounts(legacy.approved, finance.net);
      rows.push({ key, legacyApproved: legacy.approved, financeNet: finance.net, ...cmp });
      if (cmp.status === COMPARISON_STATUS.MATCH) matches += 1;
      else if (cmp.status === COMPARISON_STATUS.DIFFERENCE) differences += 1;
      else if (cmp.status === COMPARISON_STATUS.LEGACY_ONLY) legacyOnly += 1;
      else if (cmp.status === COMPARISON_STATUS.FINANCE_ONLY) financeOnly += 1;
    }

    return {
      mode: this.getMode(),
      summary: { matches, differences, legacyOnly, financeOnly, total: rows.length },
      rows,
    };
  }

  /**
   * Financial coverage: conversions with earn FT / eligible approved conversions.
   */
  async getFinancialCoverage({ clientId } = {}, client = null) {
    const db = client ?? this.db;
    const conversionWhere = {
      ...(clientId
        ? {
            clientAssignment: { clientId },
          }
        : {}),
      status: { in: ["APPROVED", "PAID"] },
    };
    const eligible = await db.conversion.count({ where: conversionWhere });
    const withFinance = await db.financialTransaction.count({
      where: {
        transactionType: "COMMISSION_EARNED",
        ...(clientId ? { clientId } : {}),
      },
    });
    const pct = eligible > 0 ? Number(((withFinance / eligible) * 100).toFixed(2)) : 0;
    return {
      eligibleApprovedConversions: eligible,
      financiallyRecognized: withFinance,
      coveragePercent: pct,
      complete: eligible > 0 && withFinance >= eligible,
    };
  }

  /**
   * Record shadow discrepancy internally (not exposed to clients).
   */
  async recordShadowDiscrepancy(payload = {}) {
    try {
      await this.audit.record({
        aggregateType: "FinanceConsumerShadow",
        aggregateId: payload.clientId ?? null,
        action: "finance_consumer.shadow_discrepancy",
        metadata: {
          ...payload,
          recordedAt: new Date().toISOString(),
        },
      });
    } catch {
      // audit best-effort
    }
  }

  /**
   * Resolve which client commission amount to expose based on mode.
   * SHADOW returns legacy for display; caller should run compare separately.
   */
  resolveDisplayCommission({ legacyApproved, legacyPending, financeNet }) {
    const mode = this.getMode();
    if (mode === FINANCE_CONSUMER_MODES.FINANCE) {
      return {
        approvedCommission: financeNet,
        pendingCommission: 0,
        source: "financial_transaction",
        authoritative: true,
      };
    }
    return {
      approvedCommission: legacyApproved,
      pendingCommission: legacyPending,
      source: "conversion_snapshot",
      authoritative: mode === FINANCE_CONSUMER_MODES.LEGACY,
    };
  }
}
