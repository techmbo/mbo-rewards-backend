-- NetworkAccount operational fields on MarketplaceAccount.
-- Secrets stay in encryptedAccessToken / encryptedRefreshToken; APIs expose secretRef only.

ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "environment" TEXT NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "secretRef" TEXT;
ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "syncEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "financeSyncEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MarketplaceAccount" ADD COLUMN IF NOT EXISTS "credentialHealth" TEXT NOT NULL DEFAULT 'UNKNOWN';

UPDATE "MarketplaceAccount"
SET "secretRef" = 'mbo-sm://local-encrypted/network-account/' || "id"
WHERE "encryptedAccessToken" IS NOT NULL
  AND "encryptedAccessToken" <> ''
  AND ("secretRef" IS NULL OR "secretRef" = '');

UPDATE "MarketplaceAccount"
SET "credentialHealth" = CASE
  WHEN "encryptedAccessToken" IS NULL OR "encryptedAccessToken" = '' THEN 'NOT_CONFIGURED'
  WHEN "tokenExpiresAt" IS NOT NULL AND "tokenExpiresAt" < NOW() THEN 'EXPIRED'
  WHEN "lastSyncError" IS NOT NULL AND "lastSyncError" <> '' THEN 'FAILED'
  WHEN "lastSuccessfulSync" IS NOT NULL OR "lastAuthCheckAt" IS NOT NULL THEN 'HEALTHY'
  ELSE 'UNKNOWN'
END;
