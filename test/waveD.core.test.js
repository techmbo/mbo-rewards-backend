import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateCommission,
  resolveActualSupplierCommission,
  netFinancialPosition,
} from "../src/modules/finance/commissionCalculation.service.js";
import {
  FxService,
  resolveReportingCurrency,
  convertAmount,
} from "../src/modules/finance/fx.service.js";
import {
  FinancialTransactionService,
  earnRecognitionKey,
  lateRejectionAdjustmentKey,
} from "../src/modules/finance/financialTransaction.service.js";
import { ReconciliationService } from "../src/modules/finance/reconciliation.service.js";
import { StatementService } from "../src/modules/finance/statement.service.js";
import { InvoiceService } from "../src/modules/finance/invoice.service.js";
import { ExceptionCaseService } from "../src/modules/order/exceptionCase.service.js";

const rule70 = {
  id: "rule-1",
  assignmentId: "asg-1",
  grossCommission: "100",
  clientCommission: "70",
  mboCommission: "30",
  commissionType: "PERCENT",
  status: "EFFECTIVE",
  currency: "USD",
  effectiveFrom: new Date("2025-01-01"),
  // Financial recognition requires approved commercial agreement lineage.
  agreementRef: "IO-2025-001",
  agreementApprovedAt: new Date("2025-01-01"),
  agreementApprovedBy: "finance-lead",
};

describe("Wave D — commission calculation", () => {
  it("uses actual supplier commission and never campaign snapshot", () => {
    const conversion = { supplierCommission: "1000", approvedCommission: null, status: "APPROVED", currency: "USD" };
    const order = { validationStatus: "VALIDATION_APPROVED", currency: "USD" };
    const calc = calculateCommission({
      order,
      conversion,
      clientCommissionRule: rule70,
    });
    assert.equal(calc.ok, true);
    assert.equal(calc.supplierGross, "1000.0000");
    assert.equal(calc.clientCommission, "700.0000");
    assert.equal(calc.mboMargin, "300.0000");
    assert.equal(calc.calculationMetadata.neverUsedCampaignSnapshot, true);
  });

  it("requires effective rule and rejects missing supplier commission", () => {
    assert.equal(
      calculateCommission({
        order: { validationStatus: "VALIDATION_APPROVED" },
        conversion: { supplierCommission: "10", status: "APPROVED" },
        clientCommissionRule: null,
      }).reason,
      "missing_effective_commission_rule",
    );
    assert.equal(
      resolveActualSupplierCommission({ supplierCommission: null }).reason,
      "missing_supplier_commission",
    );
  });

  it("rejects client exceeding supplier and reconciles margin", () => {
    const badRule = { ...rule70, grossCommission: "10", clientCommission: "20" };
    const calc = calculateCommission({
      order: { validationStatus: "VALIDATION_APPROVED" },
      conversion: { supplierCommission: "100", status: "APPROVED", currency: "USD" },
      clientCommissionRule: badRule,
    });
    assert.equal(calc.ok, false);
  });

  it("pending/rejected do not calculate payable", () => {
    assert.equal(
      calculateCommission({
        order: { validationStatus: "VALIDATION_PENDING" },
        conversion: { supplierCommission: "100", status: "PENDING" },
        clientCommissionRule: rule70,
      }).ok,
      false,
    );
    assert.equal(
      calculateCommission({
        order: { validationStatus: "VALIDATION_REJECTED" },
        conversion: { supplierCommission: "100", status: "REJECTED" },
        clientCommissionRule: rule70,
      }).reason,
      "validation_rejected",
    );
  });
});

describe("Wave D — FX", () => {
  it("preserves original + reporting amounts and reuses persisted rate", async () => {
    const rates = new Map([["USD:INR:2025-06-01", "83.25"]]);
    const fx = new FxService({ rateProvider: rates });
    const once = await fx.convert({
      amount: 100,
      fromCurrency: "USD",
      toCurrency: "INR",
      effectiveDate: "2025-06-01",
    });
    assert.equal(once.ok, true);
    assert.equal(once.originalAmount, "100.0000");
    assert.equal(once.originalCurrency, "USD");
    assert.equal(once.reportingAmount, "8325.0000");
    assert.equal(once.reportingCurrency, "INR");
    assert.equal(once.fxRate, "83.25");

    const again = await fx.convert({
      amount: 100,
      fromCurrency: "USD",
      toCurrency: "INR",
      effectiveDate: "2025-06-01",
      persistedRate: once.fxRate,
    });
    assert.equal(again.fxSource, "persisted");
    assert.equal(again.reportingAmount, "8325.0000");
  });

  it("fails on unsupported currency / invalid / missing rate", async () => {
    assert.equal(resolveReportingCurrency({}).ok, false);
    assert.equal(resolveReportingCurrency({ country: "IN" }).currency, "INR");
    assert.equal(resolveReportingCurrency({ country: "AE" }).currency, "USD");
    assert.equal(convertAmount(10, 0).ok, false);
    const fx = new FxService({ rateProvider: new Map() });
    const missing = await fx.convert({
      amount: 10,
      fromCurrency: "USD",
      toCurrency: "INR",
      effectiveDate: "2025-01-01",
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "missing_fx_rate");
  });
});

function financeMockDb() {
  const ft = new Map();
  const adj = new Map();
  const statements = new Map();
  const statementLines = new Map();
  const invoices = new Map();
  const payments = new Map();
  const exceptions = [];

  const conversion = {
    id: "cv-1",
    supplier: "OPTIMISE",
    supplierCommission: "800",
    approvedCommission: "800",
    currency: "USD",
    status: "APPROVED",
    conversionDate: new Date("2025-06-01"),
    clientAssignmentId: "asg-1",
    campaignSourceId: "src-1",
    orderId: "ord-1",
    order: {
      id: "ord-1",
      supplier: "OPTIMISE",
      clientId: "client-a",
      clientAssignmentId: "asg-1",
      campaignSourceId: "src-1",
      validationStatus: "VALIDATION_APPROVED",
      clientPaymentStatus: "CLIENT_PAYMENT_NOT_READY",
      currency: "USD",
      orderDate: new Date("2025-06-01"),
      metadata: {},
    },
    clientAssignment: {
      id: "asg-1",
      clientId: "client-a",
      client: { id: "client-a", country: "AE", currency: "USD" },
    },
  };

  return {
    conversion: {
      findUnique: async () => ({ ...conversion, order: { ...conversion.order } }),
    },
    order: {
      findUnique: async () => ({ ...conversion.order }),
      update: async () => ({}),
    },
    client: {
      findUnique: async ({ where }) =>
        where.id === "client-a"
          ? { id: "client-a", country: "AE", currency: "USD" }
          : where.id === "client-b"
            ? { id: "client-b", country: "IN", currency: "INR" }
            : null,
    },
    financialTransaction: {
      findUnique: async ({ where }) => {
        if (where.recognitionKey) {
          return [...ft.values()].find((r) => r.recognitionKey === where.recognitionKey) || null;
        }
        return ft.get(where.id) || null;
      },
      findFirst: async ({ where }) => {
        return [...ft.values()].find((r) => r.id === where.id && r.clientId === where.clientId) || null;
      },
      findMany: async ({ where }) => {
        return [...ft.values()].filter((r) => {
          if (where.clientId && r.clientId !== where.clientId) return false;
          if (where.conversionId && r.conversionId !== where.conversionId) return false;
          return true;
        });
      },
      create: async ({ data }) => {
        const row = { id: `ft-${ft.size + 1}`, ...data };
        ft.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...ft.get(where.id), ...data };
        ft.set(where.id, row);
        return row;
      },
      count: async ({ where }) =>
        [...ft.values()].filter((r) => r.clientId === where.clientId).length,
    },
    commissionAdjustment: {
      findUnique: async ({ where }) => adj.get(where.adjustmentKey) || null,
      create: async ({ data }) => {
        const row = { id: `adj-${adj.size + 1}`, ...data };
        adj.set(data.adjustmentKey, row);
        return row;
      },
    },
    clientStatement: {
      findUnique: async ({ where }) => {
        const key = `${where.clientId_periodStart_periodEnd_currency.clientId}:${where.clientId_periodStart_periodEnd_currency.currency}`;
        return statements.get(key) || null;
      },
      findFirst: async ({ where }) => {
        return [...statements.values()].find((s) => s.id === where.id && s.clientId === where.clientId) || null;
      },
      create: async ({ data }) => {
        const row = { id: `st-${statements.size + 1}`, ...data };
        const key = `${data.clientId}:${data.currency}`;
        statements.set(key, row);
        return row;
      },
      update: async ({ where, data }) => {
        const existing = [...statements.values()].find((s) => s.id === where.id);
        const row = { ...existing, ...data };
        statements.set(`${row.clientId}:${row.currency}`, row);
        return row;
      },
    },
    clientStatementLine: {
      deleteMany: async () => ({}),
      create: async ({ data }) => {
        const row = { id: `sl-${statementLines.size + 1}`, ...data };
        statementLines.set(row.id, row);
        return row;
      },
    },
    clientInvoice: {
      findFirst: async ({ where }) => {
        const row = [...invoices.values()].find((i) => i.id === where.id && i.clientId === where.clientId);
        if (!row) return null;
        return {
          ...row,
          payments: [...payments.values()].filter((p) => p.invoiceId === row.id),
          statement: null,
        };
      },
      create: async ({ data }) => {
        const row = { id: `inv-${invoices.size + 1}`, ...data };
        invoices.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...invoices.get(where.id), ...data };
        invoices.set(where.id, row);
        return row;
      },
    },
    clientPayment: {
      findFirst: async ({ where }) =>
        [...payments.values()].find((p) => p.id === where.id && p.clientId === where.clientId) || null,
      create: async ({ data }) => {
        const row = { id: `pay-${payments.size + 1}`, ...data };
        payments.set(row.id, row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = { ...payments.get(where.id), ...data };
        payments.set(where.id, row);
        return row;
      },
    },
    exceptionCase: {
      findFirst: async () => null,
      create: async ({ data }) => {
        const row = { id: `ex-${exceptions.length + 1}`, ...data };
        exceptions.push(row);
        return row;
      },
      update: async () => ({}),
    },
    _ft: ft,
    _adj: adj,
    _exceptions: exceptions,
    _invoices: invoices,
    _payments: payments,
    _statements: statements,
    _statementLines: statementLines,
  };
}

describe("Wave D — financial recognition + late rejection", () => {
  it("recognizes approved conversion idempotently and reverses on late rejection", async () => {
    const db = financeMockDb();
    const rates = new Map([["USD:USD:2025-06-01", "1"]]);
    const finance = new FinancialTransactionService({
      prisma: db,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      fx: new FxService({ rateProvider: rates }),
      commissionRepo: {
        findEffectiveForAssignment: async () => rule70, findEffectiveRulesForAssignment: async () => [rule70],
      },
    });

    const first = await finance.recognizeConversion({ conversionId: "cv-1", orderId: "ord-1" });
    assert.equal(first.created, true);
    assert.equal(first.record.recognitionKey, earnRecognitionKey("cv-1"));
    assert.equal(Number(first.record.supplierReceivable), 800);
    assert.equal(Number(first.record.clientPayable), 560);
    assert.equal(Number(first.record.mboMargin), 240);

    const second = await finance.recognizeConversion({ conversionId: "cv-1", orderId: "ord-1" });
    assert.equal(second.reused, true);
    assert.equal(db._ft.size, 1);

    const rev1 = await finance.reverseForLateRejection({
      conversionId: "cv-1",
      orderId: "ord-1",
      reason: "network rejected",
    });
    assert.equal(rev1.created, true);
    assert.equal(rev1.adjustment.adjustmentKey, lateRejectionAdjustmentKey("cv-1"));

    const rev2 = await finance.reverseForLateRejection({
      conversionId: "cv-1",
      orderId: "ord-1",
    });
    assert.equal(rev2.reused, true);

    const net = await finance.netPositionForConversion("cv-1");
    assert.equal(net.net.clientPayable, "0.0000");
    assert.equal(net.net.supplierReceivable, "0.0000");
    assert.equal(net.net.mboMargin, "0.0000");
    assert.equal(net.net.reconciles, true);
    assert.equal(net.rows.length, 2);
    assert.equal(net.rows[0].status, "FINANCIAL_REVERSED");
    assert.equal(Number(net.rows[0].clientPayable), 560); // original immutable
  });

  it("supplier correction creates adjustment leaving original intact", async () => {
    const db = financeMockDb();
    const finance = new FinancialTransactionService({
      prisma: db,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      fx: new FxService({ rateProvider: new Map([["USD:USD:2025-06-01", "1"]]) }),
      commissionRepo: { findEffectiveForAssignment: async () => rule70, findEffectiveRulesForAssignment: async () => [rule70] },
    });

    const earn = await finance.recognizeConversion({ conversionId: "cv-1" });
    // 1000→800 style correction on 800 base: delta supplier -200, client -140, margin -60
    // Start from 800/560/240; correction to 600/420/180 would be -200/-140/-60
    const adj = await finance.createAdjustment({
      originalTransactionId: earn.record.id,
      adjustmentType: "SUPPLIER_CORRECTION",
      reason: "supplier corrected commission",
      supplierReceivableDelta: "-200.0000",
      clientPayableDelta: "-140.0000",
      mboMarginDelta: "-60.0000",
      correctionKey: "corr-1",
    });
    assert.equal(adj.created, true);
    assert.equal(Number(earn.record.clientPayable), 560);
    const net = await finance.netPositionForConversion("cv-1");
    assert.equal(net.net.supplierReceivable, "600.0000");
    assert.equal(net.net.clientPayable, "420.0000");
    assert.equal(net.net.mboMargin, "180.0000");
  });
});

describe("Wave D — reconciliation + statements + invoices + tenant isolation", () => {
  it("reconciles supplier - client = margin", () => {
    const svc = new ReconciliationService({ prisma: {} });
    const ok = svc.reconcileTransaction({
      supplierReceivable: "800",
      clientPayable: "560",
      mboMargin: "240",
    });
    assert.equal(ok.ok, true);
    assert.equal(netFinancialPosition([
      { supplierReceivable: 800, clientPayable: 560, mboMargin: 240 },
      { supplierReceivable: -800, clientPayable: -560, mboMargin: -240 },
    ]).clientPayable, "0.0000");
  });

  it("builds client statement and invoice; payment required to mark paid", async () => {
    const db = financeMockDb();
    // Seed a FT for client-a
    await db.financialTransaction.create({
      data: {
        recognitionKey: "earn:cv-1",
        transactionType: "COMMISSION_EARNED",
        status: "FINANCIAL_RECOGNIZED",
        clientId: "client-a",
        supplier: "OPTIMISE",
        conversionId: "cv-1",
        supplierReceivable: "100",
        clientPayable: "70",
        mboMargin: "30",
        originalCurrency: "USD",
        reportingClientPayable: "70",
        reportingCurrency: "USD",
        effectiveAt: new Date("2025-06-15"),
      },
    });

    const statements = new StatementService({ prisma: db });
    // Patch getStatementForClient include lines from map
    statements.getStatementForClient = async (id, clientId) => {
      const st = [...db._statements.values()].find((s) => s.id === id && s.clientId === clientId);
      if (!st) throw Object.assign(new Error("Statement not found."), { statusCode: 404 });
      return {
        ...st,
        lines: [...db._statementLines.values()].filter((l) => l.statementId === st.id),
        invoices: [],
      };
    };

    const statement = await statements.buildOrRefresh({
      clientId: "client-a",
      periodStart: "2025-06-01",
      periodEnd: "2025-06-30",
      currency: "USD",
    });
    assert.equal(Number(statement.closingBalance), 70);

    const invoices = new InvoiceService({
      prisma: db,
      audit: { record: async () => ({}) },
    });
    // statement findFirst for createFromStatement
    db.clientStatement.findFirst = async ({ where }) =>
      [...db._statements.values()].find((s) => s.id === where.id && s.clientId === where.clientId) || null;

    const invoice = await invoices.createFromStatement(statement.id, "client-a", {
      invoiceNumber: "INV-TEST-1",
    });
    assert.equal(invoice.status, "DRAFT");
    assert.equal(Number(invoice.total), 70);

    await invoices.issue(invoice.id, "client-a");
    await assert.rejects(
      () => invoices.recordPayment({ clientId: "client-a", invoiceId: invoice.id, amount: 100, currency: "USD", confirm: true }),
      (e) => e.statusCode === 409,
    );

    await invoices.recordPayment({
      clientId: "client-a",
      invoiceId: invoice.id,
      amount: 70,
      currency: "USD",
      confirm: true,
    });
    const paid = await invoices.getInvoiceForClient(invoice.id, "client-a");
    assert.equal(paid.status, "PAID");

    // Tenant isolation
    await assert.rejects(
      () => invoices.getInvoiceForClient(invoice.id, "client-b"),
      (e) => e.statusCode === 404,
    );
    await assert.rejects(
      () => statements.getStatementForClient(statement.id, "client-b"),
      (e) => e.statusCode === 404,
    );

    const finance = new FinancialTransactionService({
      prisma: db,
      audit: { record: async () => ({}) },
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      fx: new FxService({ rateProvider: new Map() }),
      commissionRepo: { findEffectiveForAssignment: async () => rule70, findEffectiveRulesForAssignment: async () => [rule70] },
    });
    await assert.rejects(
      () => finance.getForClient([...db._ft.values()][0].id, "client-b"),
      (e) => e.statusCode === 404,
    );
  });
});
