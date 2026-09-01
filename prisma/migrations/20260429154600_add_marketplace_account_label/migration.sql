ALTER TABLE "MarketplaceAccount"
ADD COLUMN "accountLabel" TEXT NOT NULL DEFAULT 'default';

DROP INDEX IF EXISTS "MarketplaceAccount_platform_key";

CREATE UNIQUE INDEX "MarketplaceAccount_platform_accountLabel_key"
ON "MarketplaceAccount"("platform", "accountLabel");
