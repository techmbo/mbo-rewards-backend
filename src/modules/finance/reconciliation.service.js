import { netFinancialPosition } from "./commissionCalculation.service.js";
import { extractMboActualReceipt } from "./financeSeparation.contract.js";
import {
  runReconciliationChecks,
  shouldBlockClientPayableRelease,
  summarizeChecksForUi,
} from "./reconciliationLogic.contract.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { resolveAlertSpec } from "../ops/alertException.contract.js";
import { prisma } from "../../database/prisma.js";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function netFinancialAmount(rows = [], field) {
  let total = 0;
  for (const row of rows) {
    const value = Number(row[field] || 0);
    if (row.transactionType === "REVERSAL") total -= value;
    else total += value;
  }
  return total;
}

function sourceAmount(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const value = Number(candidate);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Build pairwise reconciliation inputs for a single order.
 *
 * PR4 rule: source-side amounts stay source-side. Missing network invoice/payment/
 * commission evidence is null; it is never replaced with MBO gross or another internal value.
 */
export function buildOrderReconciliationInputs({ order = null, financialTransactions = [] } = {}) {
  const meta = asObject(order?.metadata);
  const mboGross = netFinancialAmount(financialTransactions, "supplierReceivable");
  const clientPayable = netFinancialAmount(financialTransactions, "clientPayable");
  const receipt = extractMboActualReceipt({ order, financialTransactions });

  const receiptAmount = sourceAmount(receipt?.amount);
  const networkCommission = sourceAmount(
    meta.networkCommission,
    meta.networkReportedCommission,
    meta.reportedCommission,
  );
  const networkInvoiceAmount = sourceAmount(
    meta.networkInvoiceAmount,
    meta.networkInvoicedAmount,
  );
  const networkPaymentAmount = sourceAmount(
    meta.networkPaymentAmount,
    meta.networkPaidAmount,
    meta.paidCommission,
  );

  return {
    networkOrderCount: order?.supplierOrderId || order?.id ? 1 : null,
    mboOrderCount: order?.id ? 1 : null,
    networkCommission,
    mboGrossNetworkCommission: mboGross > 0 ? mboGross : mboGross === 0 ? 0 : null,
    networkInvoiceAmount,
    networkPaymentAmount,
    mboActualReceiptAmount: receiptAmount,
    clientPayableAmount: clientPayable > 0 ? clientPayable : clientPayable === 0 ? 0 : null,
  };
}

export function runOrderReconciliationChecks(context = {}) {
  return runReconciliationChecks(buildOrderReconciliationInputs(context));
}

/**
 * Deterministic reconciliation checks (no UI).
 */
export class ReconciliationService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.exceptions = deps.exceptions ?? new ExceptionCaseService({ prisma: this.db });
  }

  reconcileTransaction(ft) {
    const supplier = Number(ft.supplierReceivable);
    const client = Number(ft.clientPayable);
    const margin = Number(ft.mboMargin);
    const ok = Math.abs(supplier - client - margin) <= 0.00015;
    return {
      ok,
      supplierReceivable: supplier.toFixed(4),
      clientPayable: client.toFixed(4),
      mboMargin: margin.toFixed(4),
      difference: (supplier - client - margin).toFixed(6),
    };
  }

  async reconcileConversion(conversionId, client = null) {
    const db = client ?? this.db;
    const rows = await db.financialTransaction.findMany({
      where: { conversionId },
    });
    const net = netFinancialPosition(rows);
    const perRow = rows.map((r) => ({ id: r.id, ...this.reconcileTransaction(r) }));
    const allOk = net.reconciles && perRow.every((r) => r.ok);

    if (!allOk) {
      await this.exceptions.report(
        {
          type: "FINANCIAL_RECONCILIATION_MISMATCH",
          severity: "HIGH",
          conversionId,
          clientId: rows[0]?.clientId ?? null,
          reason: "Supplier receivable - client payable != MBO margin",
          metadata: { net, perRow },
        },
        db,
      );
    }

    return { ok: allOk, net, perRow };
  }

  async reconcileOrder(orderId, client = null) {
    const db = client ?? this.db;
    const order = await db.order.findUnique({
      where: { id: orderId },
      include: {
        financialTransactions: {
          select: {
            id: true,
            supplierReceivable: true,
            clientPayable: true,
            transactionType: true,
            originalCurrency: true,
            metadata: true,
            calculationMetadata: true,
          },
        },
      },
    });
    if (!order) return { ok: false, error: "Order not found" };

    const result = runOrderReconciliationChecks({
      order,
      financialTransactions: order.financialTransactions,
    });
    await this.reportReconciliationMismatches({
      checks: result.checks,
      grainKey: `order:${order.id}`,
      supplier: order.supplier,
      orderId: order.id,
      clientId: order.clientId,
      metadata: { scope: "order" },
    }, db);

    return {
      ...result,
      checks: summarizeChecksForUi(result.checks),
      blockClientPayable: shouldBlockClientPayableRelease(result.checks),
    };
  }

  async reconcileNetworkGrain(
    { grainKey, supplier, billingMonth, billingYear, inputs },
    client = null,
  ) {
    const db = client ?? this.db;
    const result = runReconciliationChecks(inputs);
    await this.reportReconciliationMismatches(
      {
        checks: result.checks,
        grainKey,
        supplier,
        billingMonth,
        billingYear,
        metadata: { scope: "network_grain", inputs },
      },
      db,
    );

    return {
      ...result,
      checks: summarizeChecksForUi(result.checks),
      blockClientPayable: shouldBlockClientPayableRelease(result.checks),
    };
  }

  async reportReconciliationMismatches(
    { checks, grainKey, supplier, orderId = null, clientId = null, billingMonth = null, billingYear = null, metadata = {} },
    client = null,
  ) {
    const db = client ?? this.db;
    for (const check of checks.filter((c) => !c.ok && !c.skipped)) {
      const spec = resolveAlertSpec({ reconciliationPair: check.pair });
      await this.exceptions.report(
        {
          condition: spec?.condition ?? null,
          reconciliationPair: check.pair,
          type: spec?.type ?? "FINANCIAL_RECONCILIATION_MISMATCH",
          severity: spec?.severity ?? (check.material ? "HIGH" : "MEDIUM"),
          supplier,
          orderId,
          clientId,
          entityId: grainKey,
          dedupeKey: `recon:${grainKey}:${check.pair}`,
          reason: `${check.label}: ${check.mismatchReason || "mismatch"}`,
          metadata: {
            ...metadata,
            grainKey,
            pair: check.pair,
            reconciliationPair: check.pair,
            billingMonth,
            billingYear,
            check,
          },
        },
        db,
      );
    }
  }
}
