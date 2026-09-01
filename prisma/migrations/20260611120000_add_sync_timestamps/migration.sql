-- Phase 1/5: per-account sync timestamps for incremental sync and static-resource caching
ALTER TABLE "MarketplaceAccount" ADD COLUMN "lastSuccessfulSync" TIMESTAMP(3);
ALTER TABLE "MarketplaceAccount" ADD COLUMN "lastCampaignSyncAt" TIMESTAMP(3);
ALTER TABLE "MarketplaceAccount" ADD COLUMN "lastCouponSyncAt" TIMESTAMP(3);
