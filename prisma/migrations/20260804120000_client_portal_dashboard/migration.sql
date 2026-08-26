-- Client portal dashboard: bank, withdrawals, support, preferences

ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "portalPreferences" JSONB;

DO $$ BEGIN
  CREATE TYPE "ClientBankStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ClientWithdrawalStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'PAID', 'REJECTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ClientSupportRequestType" AS ENUM ('SUPPORT_TICKET', 'CAMPAIGN_REQUEST');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ClientSupportRequestStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "client_bank_accounts" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNumberLast4" VARCHAR(4) NOT NULL,
    "accountNumberEnc" TEXT NOT NULL,
    "ifscCode" TEXT NOT NULL,
    "accountType" TEXT NOT NULL DEFAULT 'Current',
    "status" "ClientBankStatus" NOT NULL DEFAULT 'VERIFIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_bank_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_bank_accounts_clientId_key" ON "client_bank_accounts"("clientId");

DO $$ BEGIN
  ALTER TABLE "client_bank_accounts" ADD CONSTRAINT "client_bank_accounts_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "client_withdrawals" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "ClientWithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT,
    "notes" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_withdrawals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_withdrawals_reference_key" ON "client_withdrawals"("reference");
CREATE INDEX IF NOT EXISTS "client_withdrawals_clientId_createdAt_idx" ON "client_withdrawals"("clientId", "createdAt");
CREATE INDEX IF NOT EXISTS "client_withdrawals_clientId_status_idx" ON "client_withdrawals"("clientId", "status");

DO $$ BEGIN
  ALTER TABLE "client_withdrawals" ADD CONSTRAINT "client_withdrawals_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "client_support_requests" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "ClientSupportRequestType" NOT NULL,
    "category" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" "ClientSupportRequestStatus" NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_support_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "client_support_requests_clientId_createdAt_idx" ON "client_support_requests"("clientId", "createdAt");
CREATE INDEX IF NOT EXISTS "client_support_requests_clientId_status_idx" ON "client_support_requests"("clientId", "status");

DO $$ BEGIN
  ALTER TABLE "client_support_requests" ADD CONSTRAINT "client_support_requests_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
