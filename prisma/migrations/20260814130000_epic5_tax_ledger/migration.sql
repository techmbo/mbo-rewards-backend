-- Epic 5 — TaxLedger / GST (additive only; no historical rewrite)

-- AlterEnum ExceptionCaseType
ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'TAX_CONFIGURATION_MISSING';
ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'TAX_LEGAL_REVIEW_REQUIRED';
ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'TAX_CURRENCY_MISMATCH';
ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'TAX_CALCULATION_BLOCKED';

-- CreateEnum
CREATE TYPE "TaxLegalReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'NOT_REQUIRED');
CREATE TYPE "TaxType" AS ENUM ('GST', 'UNKNOWN');
CREATE TYPE "TaxCalculationPolicy" AS ENUM ('CONTRACT_CONFIG', 'LEGAL_REVIEW_REQUIRED');
CREATE TYPE "TaxLedgerStatus" AS ENUM ('DRAFT', 'POSTED', 'VOID');

-- AlterTable ClientInvoice
ALTER TABLE "client_invoices" ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "client_tax_profiles" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxEnabled" BOOLEAN NOT NULL DEFAULT false,
    "taxCountry" VARCHAR(8),
    "taxRatePercent" DECIMAL(9,4),
    "taxType" "TaxType" NOT NULL DEFAULT 'UNKNOWN',
    "legalReviewStatus" "TaxLegalReviewStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_tax_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_tax_profiles_clientId_key" ON "client_tax_profiles"("clientId");

ALTER TABLE "client_tax_profiles"
  ADD CONSTRAINT "client_tax_profiles_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "tax_ledgers" (
    "id" TEXT NOT NULL,
    "recognitionKey" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "financialTransactionId" TEXT,
    "clientStatementId" TEXT,
    "clientInvoiceId" TEXT,
    "invoiceNumber" TEXT,
    "taxCountry" VARCHAR(8),
    "taxRate" DECIMAL(9,4),
    "taxAmount" DECIMAL(18,4) NOT NULL,
    "taxableAmount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "taxType" "TaxType" NOT NULL DEFAULT 'UNKNOWN',
    "calculationPolicy" "TaxCalculationPolicy" NOT NULL DEFAULT 'LEGAL_REVIEW_REQUIRED',
    "status" "TaxLedgerStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "tax_ledgers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tax_ledgers_recognitionKey_key" ON "tax_ledgers"("recognitionKey");
CREATE INDEX IF NOT EXISTS "tax_ledgers_clientId_status_idx" ON "tax_ledgers"("clientId", "status");
CREATE INDEX IF NOT EXISTS "tax_ledgers_clientInvoiceId_idx" ON "tax_ledgers"("clientInvoiceId");
CREATE INDEX IF NOT EXISTS "tax_ledgers_clientStatementId_idx" ON "tax_ledgers"("clientStatementId");
CREATE INDEX IF NOT EXISTS "tax_ledgers_financialTransactionId_idx" ON "tax_ledgers"("financialTransactionId");

ALTER TABLE "tax_ledgers"
  ADD CONSTRAINT "tax_ledgers_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tax_ledgers"
  ADD CONSTRAINT "tax_ledgers_financialTransactionId_fkey"
  FOREIGN KEY ("financialTransactionId") REFERENCES "financial_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tax_ledgers"
  ADD CONSTRAINT "tax_ledgers_clientStatementId_fkey"
  FOREIGN KEY ("clientStatementId") REFERENCES "client_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tax_ledgers"
  ADD CONSTRAINT "tax_ledgers_clientInvoiceId_fkey"
  FOREIGN KEY ("clientInvoiceId") REFERENCES "client_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
