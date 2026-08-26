-- Wave D: Financial truth layer (additive). No historical financial backfill.

ALTER TYPE "ExceptionCaseType" ADD VALUE 'MISSING_FX_RATE';
ALTER TYPE "ExceptionCaseType" ADD VALUE 'INVALID_CURRENCY';
ALTER TYPE "ExceptionCaseType" ADD VALUE 'FINANCIAL_RECONCILIATION_MISMATCH';
ALTER TYPE "ExceptionCaseType" ADD VALUE 'DUPLICATE_FINANCIAL_RECOGNITION';
ALTER TYPE "ExceptionCaseType" ADD VALUE 'CONFLICTING_FINANCIAL_TRANSACTION';

CREATE TYPE "FinancialTransactionType" AS ENUM ('COMMISSION_EARNED', 'REVERSAL', 'ADJUSTMENT');
CREATE TYPE "FinancialTransactionStatus" AS ENUM (
  'FINANCIAL_RECOGNIZED',
  'FINANCIAL_ADJUSTED',
  'FINANCIAL_REVERSED',
  'FINANCIAL_UNRESOLVED'
);
CREATE TYPE "CommissionAdjustmentType" AS ENUM (
  'LATE_REJECTION',
  'SUPPLIER_CORRECTION',
  'COMMISSION_CORRECTION',
  'ATTRIBUTION_CORRECTION',
  'MANUAL_ADJUSTMENT',
  'FX_CORRECTION'
);
CREATE TYPE "ClientStatementStatus" AS ENUM ('OPEN', 'CLOSED', 'SUPERSEDED');
CREATE TYPE "ClientInvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'OVERDUE');
CREATE TYPE "ClientPaymentRecordStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED');

CREATE TABLE "financial_transactions" (
    "id" TEXT NOT NULL,
    "recognitionKey" TEXT NOT NULL,
    "transactionType" "FinancialTransactionType" NOT NULL,
    "status" "FinancialTransactionStatus" NOT NULL DEFAULT 'FINANCIAL_RECOGNIZED',
    "orderId" TEXT,
    "conversionId" TEXT,
    "clientId" TEXT NOT NULL,
    "supplier" "SupplierKey" NOT NULL,
    "campaignSourceId" TEXT,
    "commissionRuleId" TEXT,
    "relatedTransactionId" TEXT,
    "supplierReceivable" DECIMAL(18,4) NOT NULL,
    "clientPayable" DECIMAL(18,4) NOT NULL,
    "mboMargin" DECIMAL(18,4) NOT NULL,
    "originalCurrency" CHAR(3) NOT NULL,
    "reportingSupplierReceivable" DECIMAL(18,4),
    "reportingClientPayable" DECIMAL(18,4),
    "reportingMboMargin" DECIMAL(18,4),
    "reportingCurrency" CHAR(3),
    "fxRate" DECIMAL(18,8),
    "fxDate" TIMESTAMP(3),
    "fxSource" TEXT,
    "ruleSnapshot" JSONB,
    "calculationMetadata" JSONB,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "financial_transactions_recognitionKey_key" ON "financial_transactions"("recognitionKey");
CREATE INDEX "financial_transactions_clientId_effectiveAt_idx" ON "financial_transactions"("clientId", "effectiveAt");
CREATE INDEX "financial_transactions_conversionId_transactionType_idx" ON "financial_transactions"("conversionId", "transactionType");
CREATE INDEX "financial_transactions_orderId_idx" ON "financial_transactions"("orderId");
CREATE INDEX "financial_transactions_status_idx" ON "financial_transactions"("status");
CREATE INDEX "financial_transactions_relatedTransactionId_idx" ON "financial_transactions"("relatedTransactionId");

ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_conversionId_fkey"
  FOREIGN KEY ("conversionId") REFERENCES "conversions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_commissionRuleId_fkey"
  FOREIGN KEY ("commissionRuleId") REFERENCES "client_commission_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_relatedTransactionId_fkey"
  FOREIGN KEY ("relatedTransactionId") REFERENCES "financial_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "commission_adjustments" (
    "id" TEXT NOT NULL,
    "adjustmentKey" TEXT NOT NULL,
    "adjustmentType" "CommissionAdjustmentType" NOT NULL,
    "reason" TEXT,
    "originalTransactionId" TEXT NOT NULL,
    "resultTransactionId" TEXT,
    "orderId" TEXT,
    "conversionId" TEXT,
    "clientId" TEXT NOT NULL,
    "supplierReceivableDelta" DECIMAL(18,4) NOT NULL,
    "clientPayableDelta" DECIMAL(18,4) NOT NULL,
    "mboMarginDelta" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reportingCurrency" CHAR(3),
    "fxRate" DECIMAL(18,8),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    CONSTRAINT "commission_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "commission_adjustments_adjustmentKey_key" ON "commission_adjustments"("adjustmentKey");
CREATE INDEX "commission_adjustments_clientId_createdAt_idx" ON "commission_adjustments"("clientId", "createdAt");
CREATE INDEX "commission_adjustments_originalTransactionId_idx" ON "commission_adjustments"("originalTransactionId");
CREATE INDEX "commission_adjustments_conversionId_idx" ON "commission_adjustments"("conversionId");
CREATE INDEX "commission_adjustments_orderId_idx" ON "commission_adjustments"("orderId");

ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_originalTransactionId_fkey"
  FOREIGN KEY ("originalTransactionId") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_resultTransactionId_fkey"
  FOREIGN KEY ("resultTransactionId") REFERENCES "financial_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_conversionId_fkey"
  FOREIGN KEY ("conversionId") REFERENCES "conversions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "commission_adjustments" ADD CONSTRAINT "commission_adjustments_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "fx_rate_records" (
    "id" TEXT NOT NULL,
    "fromCurrency" CHAR(3) NOT NULL,
    "toCurrency" CHAR(3) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "fx_rate_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fx_rate_records_fromCurrency_toCurrency_effectiveDate_sour_key"
  ON "fx_rate_records"("fromCurrency", "toCurrency", "effectiveDate", "source");
CREATE INDEX "fx_rate_records_fromCurrency_toCurrency_effectiveDate_idx"
  ON "fx_rate_records"("fromCurrency", "toCurrency", "effectiveDate");

CREATE TABLE "client_statements" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "openingBalance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "closingBalance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" "ClientStatementStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    CONSTRAINT "client_statements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_statements_clientId_periodStart_periodEnd_currency_key"
  ON "client_statements"("clientId", "periodStart", "periodEnd", "currency");
CREATE INDEX "client_statements_clientId_status_idx" ON "client_statements"("clientId", "status");
ALTER TABLE "client_statements" ADD CONSTRAINT "client_statements_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "client_statement_lines" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "financialTransactionId" TEXT,
    "description" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_statement_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_statement_lines_statementId_idx" ON "client_statement_lines"("statementId");
CREATE INDEX "client_statement_lines_financialTransactionId_idx" ON "client_statement_lines"("financialTransactionId");
ALTER TABLE "client_statement_lines" ADD CONSTRAINT "client_statement_lines_statementId_fkey"
  FOREIGN KEY ("statementId") REFERENCES "client_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "client_statement_lines" ADD CONSTRAINT "client_statement_lines_financialTransactionId_fkey"
  FOREIGN KEY ("financialTransactionId") REFERENCES "financial_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "client_invoices" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "statementId" TEXT,
    "currency" CHAR(3) NOT NULL,
    "subtotal" DECIMAL(18,4) NOT NULL,
    "adjustments" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL,
    "status" "ClientInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    CONSTRAINT "client_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_invoices_invoiceNumber_key" ON "client_invoices"("invoiceNumber");
CREATE INDEX "client_invoices_clientId_status_idx" ON "client_invoices"("clientId", "status");
CREATE INDEX "client_invoices_statementId_idx" ON "client_invoices"("statementId");
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "client_invoices" ADD CONSTRAINT "client_invoices_statementId_fkey"
  FOREIGN KEY ("statementId") REFERENCES "client_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "client_payments" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "ClientPaymentRecordStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    CONSTRAINT "client_payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_payments_clientId_status_idx" ON "client_payments"("clientId", "status");
CREATE INDEX "client_payments_invoiceId_idx" ON "client_payments"("invoiceId");
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "client_payments" ADD CONSTRAINT "client_payments_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "client_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
