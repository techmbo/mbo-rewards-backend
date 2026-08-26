import { netFinancialPosition } from "./commissionCalculation.service.js";
import { ExceptionCaseService } from "../order/exceptionCase.service.js";
import { prisma } from "../../database/prisma.js";

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
      await this.exceptions.report({
        type: "FINANCIAL_RECONCILIATION_MISMATCH",
        severity: "HIGH",
        conversionId,
        clientId: rows[0]?.clientId ?? null,
        reason: "Supplier receivable - client payable != MBO margin",
        metadata: { net, perRow },
      }, db);
    }

    return { ok: allOk, net, perRow };
  }
}
