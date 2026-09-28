-- Network Connections control plane (additive only).
-- 1. Provider-referenced connections keep no encrypted secret in the row, so the column becomes
--    nullable. Existing values are untouched.
ALTER TABLE "MarketplaceAccount" ALTER COLUMN "encryptedAccessToken" DROP NOT NULL;

-- 2. New operational state. Constant defaults keep every existing row's behaviour unchanged.
ALTER TABLE "MarketplaceAccount"
  ADD COLUMN "credentialSource" TEXT NOT NULL DEFAULT 'ENCRYPTED_DB',
  ADD COLUMN "pausedAt" TIMESTAMP(3),
  ADD COLUMN "pausedReason" TEXT,
  ADD COLUMN "campaignSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "couponSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "productSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "conversionSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "lastTestAt" TIMESTAMP(3),
  ADD COLUMN "lastTestStatus" TEXT,
  ADD COLUMN "lastTestResult" JSONB,
  ADD COLUMN "lastFailureAt" TIMESTAMP(3),
  ADD COLUMN "lastFailureCode" TEXT;
