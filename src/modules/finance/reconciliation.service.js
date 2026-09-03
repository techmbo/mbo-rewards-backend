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

/**
 * Sum only financial facts that are actually present on transaction rows.
 *
 * Missing rows / a missing field are not zero-value evidence. They remain null so
 * pairwise reconciliation can report SOURCE_DATA_MISSING instead of fabricating a match.
 * Invalid numeric evidence also fails closed to null.
 */
function netFinancialAmount(rows = [], field) {
  let total = 0;
  let hasEvidence = false;

  for (const row of rows || []) {
    const raw = row?.[field];
    if (raw == null || raw === "") continue;

    const value = Number(raw);
    if (!Number.isFinite(value)) return null;

    // FinancialTransaction adjustment/reversal rows already carry signed deltas.
    // Summing them directly avoids double-negating REVERSAL rows.
    hasEvidence = true;
    total += value;
  }

  return hasEvidence ? total : null;
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
    // Internal MBO order identity is not network evidence. Only source/supplier identity
    // may prove that a network-side order exists at this grain.
    networkOrderCount: order?.supplierOrderId ? 1 : null,
    mboOrderCount: order?.id ? 1 : null,
    networkCommission,
    mboGrossNetworkCommission: mboGross,
    networkInvoiceAmount,
    networkPaymentAmount,
    mboActualReceiptAmount: receiptAmount,
    clientPayableAmount: clientPayable,
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
