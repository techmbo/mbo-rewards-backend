import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";

/**
 * Client statement aggregates financial transactions (derived truth).
 * Always scoped by clientId (tenant isolation).
 */
export class StatementService {
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
  }

  async getStatementForClient(statementId, clientId, client = null) {
    const db = client ?? this.db;
    const row = await db.clientStatement.findFirst({
      where: { id: statementId, clientId },
      include: { lines: true, invoices: true },
    });
    if (!row) throw fail("Statement not found.", 404);
    return row;
  }

  async buildOrRefresh({ clientId, periodStart, periodEnd, currency }, client = null) {
    if (!clientId) throw fail("clientId is required.", 400);
    const db = client ?? this.db;
    const cur = String(currency).toUpperCase();
    const start = new Date(periodStart);
    const end = new Date(periodEnd);

    const txns = await db.financialTransaction.findMany({
      where: {
        clientId,
        OR: [
          { reportingCurrency: cur },
          { AND: [{ reportingCurrency: null }, { originalCurrency: cur }] },
        ],
        effectiveAt: { gte: start, lte: end },
      },
      orderBy: { effectiveAt: "asc" },
    });

    let balance = 0;
    const lines = [];
    for (const ft of txns) {
      const amount = Number(
        ft.reportingCurrency === cur
          ? ft.reportingClientPayable ?? ft.clientPayable
          : ft.clientPayable,
      );
      balance += amount;
      lines.push({
        financialTransactionId: ft.id,
        description: `${ft.transactionType} ${ft.recognitionKey}`,
        amount: amount.toFixed(4),
        currency: cur,
        effectiveAt: ft.effectiveAt,
      });
    }

    const existing = await db.clientStatement.findUnique({
      where: {
        clientId_periodStart_periodEnd_currency: {
          clientId,
          periodStart: start,
          periodEnd: end,
          currency: cur,
        },
      },
    });

    let statement;
    if (existing) {
      await db.clientStatementLine.deleteMany({ where: { statementId: existing.id } });
      statement = await db.clientStatement.update({
        where: { id: existing.id },
        data: {
          openingBalance: "0",
          closingBalance: balance.toFixed(4),
          status: "OPEN",
        },
      });
    } else {
      statement = await db.clientStatement.create({
        data: {
          clientId,
          periodStart: start,
          periodEnd: end,
          currency: cur,
          openingBalance: "0",
          closingBalance: balance.toFixed(4),
          status: "OPEN",
        },
      });
    }

    for (const line of lines) {
      await db.clientStatementLine.create({
        data: { statementId: statement.id, ...line },
      });
    }

    return this.getStatementForClient(statement.id, clientId, db);
  }
}
