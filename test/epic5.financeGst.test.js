import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  TaxLedgerService,
  taxInvoiceRecognitionKey,
} from "../src/modules/finance/taxLedger.service.js";
import {
  classifyHistoricalConversion,
  summarizeHistoricalClassification,
  HISTORICAL_CLASS,
} from "../src/modules/finance/historicalFinanceCoverage.service.js";
import {
  evaluateFinanceCutoverGate,
  isFinanceCutoverExplicitlyApproved,
} from "../src/modules/finance/financeCutover.service.js";
import { FinanceOpsService } from "../src/modules/ops/financeOps.service.js";
import { InvoiceService } from "../src/modules/finance/invoice.service.js";
import { ExceptionCaseService } from "../src/modules/order/exceptionCase.service.js";
import { netFinancialPosition } from "../src/modules/finance/commissionCalculation.service.js";
import { toClientPaymentStatusDto } from "../src/modules/client/dto/clientReporting.dto.js";
import { FINANCE_CONSUMER_MODES } from "../src/modules/finance/financeConsumer.service.js";

describe("Epic 5 — TaxLedger (v15 09F)", () => {
  it("does not invent tax when profile disabled", () => {
    const svc = new TaxLedgerService({
      prisma: {},
      exceptions: { report: async () => ({}) },
      audit: { record: async () => ({}) },
    });
    const evalResult = svc.evaluateTaxReadiness(
      { taxEnabled: false, legalReviewStatus: "PENDING", taxRatePercent: null },
      { currency: "INR", taxableAmount: 100 },
    );
    assert.equal(evalResult.applyTax, false);
    assert.equal(evalResult.ok, true);
    assert.equal(evalResult.reason, "tax_disabled");
  });

  it("blocks when tax enabled but rate missing — no fabricated value", async () => {
    const exceptions = [];
    const invoices = new Map([
      [
        "inv-1",
        {
          id: "inv-1",
          clientId: "c1",
          invoiceNumber: "INV-1",
          statementId: "st1",
          currency: "INR",
          subtotal: "1000",
          adjustments: "0",
          taxAmount: "0",
          total: "1000",
          status: "DRAFT",
        },
      ],
    ]);
    const db = {
      clientInvoice: {
        findFirst: async ({ where }) =>
          [...invoices.values()].find((i) => i.id === where.id && i.clientId === where.clientId) || null,
        update: async ({ where, data }) => {
          const row = { ...invoices.get(where.id), ...data };
          invoices.set(where.id, row);
          return row;
        },
      },
      clientTaxProfile: {
        findUnique: async () => ({
          clientId: "c1",
          taxEnabled: true,
          taxCountry: "IN",
          taxRatePercent: null,
          legalReviewStatus: "APPROVED",
          taxType: "GST",
        }),
      },
      taxLedger: {
        findUnique: async () => null,
        create: async () => {
          throw new Error("must not create without rate");
        },
      },
      exceptionCase: {
        findFirst: async () => null,
        create: async ({ data }) => {
          exceptions.push(data);
          return { id: "ex1", ...data };
        },
        update: async () => ({}),
      },
    };
    const svc = new TaxLedgerService({
      prisma: db,
      exceptions: new ExceptionCaseService({ prisma: db, audit: { record: async () => ({}) } }),
      audit: { record: async () => ({}) },
    });
    const out = await svc.applyTaxForInvoice("inv-1", "c1");
    assert.equal(out.applied, false);
    assert.equal(out.blocked, true);
    assert.equal(out.exceptionType, "TAX_CONFIGURATION_MISSING");
    assert.equal(exceptions[0].type, "TAX_CONFIGURATION_MISSING");
    assert.equal(String(invoices.get("inv-1").total), "1000");
  });

  it("posts TaxLedger from contract rate and links invoice", async () => {
    const ledgers = new Map();
    const invoices = new Map([
      [
        "inv-1",
        {
          id: "inv-1",
          clientId: "c1",
          invoiceNumber: "INV-GST-1",
          statementId: "st1",
          currency: "INR",
          subtotal: "1000",
          adjustments: "0",
          taxAmount: "0",
          total: "1000",
          status: "DRAFT",
        },
      ],
    ]);
    const db = {
      clientInvoice: {
        findFirst: async ({ where }) =>
          [...invoices.values()].find((i) => i.id === where.id && i.clientId === where.clientId) || null,
        update: async ({ where, data }) => {
          const row = { ...invoices.get(where.id), ...data };
          invoices.set(where.id, row);
          return row;
        },
      },
      clientTaxProfile: {
        findUnique: async () => ({
          clientId: "c1",
          taxEnabled: true,
          taxCountry: "IN",
          taxRatePercent: "18",
          legalReviewStatus: "APPROVED",
          taxType: "GST",
        }),
      },
      taxLedger: {
        findUnique: async ({ where }) => ledgers.get(where.recognitionKey) || null,
        create: async ({ data }) => {
          const row = { id: "tl-1", ...data };
          ledgers.set(data.recognitionKey, row);
          return row;
        },
        update: async ({ where, data }) => {
          const prev = [...ledgers.values()].find((l) => l.id === where.id);
          const row = { ...prev, ...data };
          ledgers.set(row.recognitionKey, row);
          return row;
        },
      },
    };
    const svc = new TaxLedgerService({
      prisma: db,
      exceptions: { report: async () => ({}) },
      audit: { record: async () => ({}) },
    });
    const out = await svc.applyTaxForInvoice("inv-1", "c1");
    assert.equal(out.applied, true);
    assert.equal(out.ledger.recognitionKey, taxInvoiceRecognitionKey("inv-1"));
    assert.equal(String(out.ledger.taxAmount), "180");
    assert.equal(out.ledger.invoiceNumber, "INV-GST-1");
    assert.equal(out.ledger.taxCountry, "IN");
    assert.equal(out.ledger.calculationPolicy, "CONTRACT_CONFIG");
    assert.equal(String(out.invoice.taxAmount), "180");
    assert.equal(String(out.invoice.total), "1180");

    const again = await svc.applyTaxForInvoice("inv-1", "c1");
    assert.equal(again.reused, true);
  });

  it("requires legal review before calculating", () => {
    const svc = new TaxLedgerService({ prisma: {} });
    const evalResult = svc.evaluateTaxReadiness(
      {
        taxEnabled: true,
        taxCountry: "IN",
        taxRatePercent: "18",
        legalReviewStatus: "PENDING",
        taxType: "GST",
      },
      { currency: "INR", taxableAmount: 100 },
    );
    assert.equal(evalResult.ok, false);
    assert.equal(evalResult.exceptionType, "TAX_LEGAL_REVIEW_REQUIRED");
  });
});

describe("Epic 5 — finance cutover gates", () => {
  it("LEGACY default and blocks without explicit approval", () => {
    const original = process.env.FINANCE_CUTOVER_APPROVED;
    delete process.env.FINANCE_CUTOVER_APPROVED;
    try {
      assert.equal(isFinanceCutoverExplicitlyApproved(), false);
      const gate = evaluateFinanceCutoverGate({
        technicalReady: true,
        coverageComplete: true,
        unexplainedDifferences: 0,
        legacyOnly: 0,
        financeOnly: 0,
        openFxExceptions: 0,
        openCommissionRuleExceptions: 0,
        openTaxExceptions: 0,
        mode: FINANCE_CONSUMER_MODES.LEGACY,
      });
      assert.equal(gate.readyForFinanceCutover, true);
      assert.equal(gate.canEnableFinanceMode, false);
      assert.ok(gate.blockedReasons.includes("explicit_operator_approval_required"));
      assert.equal(gate.defaultRemainsLegacy, true);
    } finally {
      if (original === undefined) delete process.env.FINANCE_CUTOVER_APPROVED;
      else process.env.FINANCE_CUTOVER_APPROVED = original;
    }
  });

  it("blocks on FX, missing rules, shadow gaps, insufficient coverage", () => {
    process.env.FINANCE_CUTOVER_APPROVED = "true";
    try {
      const gate = evaluateFinanceCutoverGate({
        technicalReady: false,
        coverageComplete: false,
        unexplainedDifferences: 2,
        legacyOnly: 1,
        financeOnly: 0,
        openFxExceptions: 1,
        openCommissionRuleExceptions: 1,
        openTaxExceptions: 0,
        mode: FINANCE_CONSUMER_MODES.LEGACY,
      });
      assert.equal(gate.canEnableFinanceMode, false);
      assert.ok(gate.blockedReasons.includes("insufficient_financial_coverage"));
      assert.ok(gate.blockedReasons.includes("unexplained_shadow_discrepancies"));
      assert.ok(gate.blockedReasons.includes("open_fx_exceptions"));
      assert.ok(gate.blockedReasons.includes("missing_commission_rules"));
    } finally {
      delete process.env.FINANCE_CUTOVER_APPROVED;
    }
  });

  it("allows enable only when technical ready + explicit approval", () => {
    process.env.FINANCE_CUTOVER_APPROVED = "true";
    try {
      const gate = evaluateFinanceCutoverGate({
        technicalReady: true,
        coverageComplete: true,
        unexplainedDifferences: 0,
        legacyOnly: 0,
        financeOnly: 0,
        openFxExceptions: 0,
        openCommissionRuleExceptions: 0,
        openTaxExceptions: 0,
        mode: FINANCE_CONSUMER_MODES.LEGACY,
      });
      assert.equal(gate.canEnableFinanceMode, true);
      assert.deepEqual(gate.blockedReasons, []);
    } finally {
      delete process.env.FINANCE_CUTOVER_APPROVED;
    }
  });
});

describe("Epic 5 — historical coverage dry-run", () => {
  it("classifies SAFE / REVIEW / INSUFFICIENT without inventing values", () => {
    assert.equal(
      classifyHistoricalConversion({
        status: "APPROVED",
        supplierCommission: "100",
        currency: "USD",
        clientAssignmentId: "a1",
        order: { validationStatus: "VALIDATION_APPROVED" },
      }).class,
      HISTORICAL_CLASS.SAFE_TO_BACKFILL,
    );
    assert.equal(
      classifyHistoricalConversion({
        status: "APPROVED",
        supplierCommission: null,
        currency: "USD",
        clientAssignmentId: "a1",
      }).class,
      HISTORICAL_CLASS.INSUFFICIENT_DATA,
    );
    assert.equal(
      classifyHistoricalConversion({
        status: "APPROVED",
        supplierCommission: "100",
        currency: "USD",
        clientAssignmentId: "a1",
        order: { validationStatus: "VALIDATION_APPROVED" },
        openFxException: true,
      }).class,
      HISTORICAL_CLASS.NEEDS_REVIEW,
    );
    assert.equal(
      classifyHistoricalConversion({
        status: "APPROVED",
        hasEarnFinancialTransaction: true,
      }).class,
      HISTORICAL_CLASS.ALREADY_RECOGNIZED,
    );
    const summary = summarizeHistoricalClassification([
      { class: HISTORICAL_CLASS.SAFE_TO_BACKFILL, reasons: ["eligible_inputs_present"] },
      { class: HISTORICAL_CLASS.INSUFFICIENT_DATA, reasons: ["missing_currency"] },
    ]);
    assert.equal(summary.autoBackfill, false);
    assert.equal(summary.productionMutation, false);
    assert.equal(summary.counts.SAFE_TO_BACKFILL, 1);
  });
});

describe("Epic 5 — portal cutover readiness uses gate", () => {
  it("reports canEnableFinanceMode false without approval even when technically ready", async () => {
    delete process.env.FINANCE_CUTOVER_APPROVED;
    const db = {
      exceptionCase: { count: mock.fn(async () => 0) },
    };
    const svc = new FinanceOpsService({
      prisma: db,
      financeConsumer: {
        getFinancialCoverage: async () => ({
          complete: true,
          coveragePercent: 100,
          eligibleApprovedConversions: 1,
          financiallyRecognized: 1,
        }),
        compareDailyReportDimensions: async () => ({
          summary: { matches: 1, differences: 0, legacyOnly: 0, financeOnly: 0 },
          rows: [],
        }),
      },
    });
    const out = await svc.getPortalCutoverReadiness({});
    assert.equal(out.readyForFinanceCutover, true);
    assert.equal(out.canEnableFinanceMode, false);
    assert.equal(out.defaultRemainsLegacy, true);
  });
});

describe("Epic 5 — golden path finance + tax + payment status + late rejection", () => {
  it("Assignment→Rule→FT→Statement→Invoice→Tax→Payment→status DTO; late rejection net zero", async () => {
    // Simulated golden path evidence (unit-level, no invented GST without profile)
    const earn = {
      recognitionKey: "earn:cv-gp",
      transactionType: "COMMISSION_EARNED",
      supplierReceivable: 100,
      clientPayable: 70,
      mboMargin: 30,
      originalCurrency: "INR",
    };
    const reversal = {
      recognitionKey: "rev:late_rejection:cv-gp",
      transactionType: "REVERSAL",
      supplierReceivable: -100,
      clientPayable: -70,
      mboMargin: -30,
      originalCurrency: "INR",
    };
    const net = netFinancialPosition([earn, reversal]);
    assert.equal(net.clientPayable, "0.0000");
    assert.equal(net.reconciles, true);
    // Original earn immutable
    assert.equal(earn.clientPayable, 70);

    const ledgers = new Map();
    const invoices = new Map();
    const db = {
      clientStatement: {
        findFirst: async () => ({
          id: "st-gp",
          clientId: "client-gp",
          currency: "INR",
          closingBalance: "70",
        }),
      },
      clientInvoice: {
        findFirst: async ({ where }) => {
          const row = invoices.get(where.id);
          if (!row || row.clientId !== where.clientId) return null;
          return { ...row, payments: [], statement: null, taxLedgers: [...ledgers.values()] };
        },
        create: async ({ data }) => {
          const row = { id: "inv-gp", ...data };
          invoices.set(row.id, row);
          return row;
        },
        update: async ({ where, data }) => {
          const row = { ...invoices.get(where.id), ...data };
          invoices.set(where.id, row);
          return row;
        },
      },
      clientTaxProfile: {
        findUnique: async () => ({
          clientId: "client-gp",
          taxEnabled: true,
          taxCountry: "IN",
          taxRatePercent: "18",
          legalReviewStatus: "APPROVED",
          taxType: "GST",
        }),
      },
      taxLedger: {
        findUnique: async ({ where }) => ledgers.get(where.recognitionKey) || null,
        create: async ({ data }) => {
          const row = { id: "tl-gp", ...data };
          ledgers.set(data.recognitionKey, row);
          return row;
        },
      },
      clientPayment: {
        create: async ({ data }) => ({ id: "pay-gp", ...data }),
        findFirst: async () => null,
        update: async () => ({}),
      },
    };

    const invoicesSvc = new InvoiceService({
      prisma: db,
      audit: { record: async () => ({}) },
      taxLedger: new TaxLedgerService({
        prisma: db,
        exceptions: { report: async () => ({}) },
        audit: { record: async () => ({}) },
      }),
    });
    const invoice = await invoicesSvc.createFromStatement("st-gp", "client-gp", {
      invoiceNumber: "INV-GP-1",
    });
    assert.equal(String(invoice.taxAmount), "12.6");
    assert.equal(String(invoice.total), "82.6");
    assert.equal(ledgers.get(taxInvoiceRecognitionKey("inv-gp")).invoiceNumber, "INV-GP-1");

    const paymentDto = toClientPaymentStatusDto({
      billingMonth: 8,
      billingYear: 2026,
      payableOrders: 1,
      payableCommission: 70,
      paymentStatus: "Payable",
      currency: "INR",
      paymentConfirmedDate: null,
      commissionSource: "financial_transaction",
      taxAmount: invoice.taxAmount,
    });
    assert.equal(paymentDto.payableCommission, 70);
    assert.equal(paymentDto.taxAmount, 12.6);
    assert.equal(paymentDto.commissionSource, "financial_transaction");
    assert.equal(Object.prototype.hasOwnProperty.call(paymentDto, "mboMargin"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(paymentDto, "supplierReceivable"), false);
  });
});

describe("Epic 5 — exception retry policy for tax", () => {
  it("blocks automatic retry for tax configuration exceptions", () => {
    const svc = new ExceptionCaseService({ prisma: {}, audit: { record: async () => ({}) } });
    assert.equal(svc.getRetryPolicy("TAX_CONFIGURATION_MISSING").allowed, false);
    assert.equal(svc.getRetryPolicy("TAX_LEGAL_REVIEW_REQUIRED").allowed, false);
  });
});
