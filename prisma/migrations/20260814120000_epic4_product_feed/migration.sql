-- Epic 4: Product Feed stack (additive)

DO $$ BEGIN
  CREATE TYPE "ProductFeedFormat" AS ENUM ('CSV', 'XML', 'JSON', 'GOOGLE_SHOPPING', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ProductFeedStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR', 'NEEDS_REVIEW');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ClientProductAssignmentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ProductTrackingLinkStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'PRODUCT_FEED_ERROR';
ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'PRODUCT_MISSING_ID';
ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'PRODUCT_MISSING_URL';
ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'PRODUCT_NEEDS_REVIEW';
ALTER TYPE "ExceptionCaseType" ADD VALUE IF NOT EXISTS 'PRODUCT_DUPLICATE_SOURCE';

ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "productFeedId" TEXT,
  ADD COLUMN IF NOT EXISTS "campaignSourceId" TEXT,
  ADD COLUMN IF NOT EXISTS "salePrice" DECIMAL(18,4),
  ADD COLUMN IF NOT EXISTS "clientReportingCurrency" CHAR(3),
  ADD COLUMN IF NOT EXISTS "feedStatus" "ProductFeedStatus" DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "supplierProductTrackingUrl" TEXT;

CREATE TABLE IF NOT EXISTS "product_feeds" (
  "id" TEXT NOT NULL,
  "supplier" "SupplierKey" NOT NULL,
  "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
  "campaignSourceId" TEXT,
  "feedExternalId" TEXT NOT NULL DEFAULT 'default',
  "feedName" TEXT,
  "feedUrl" TEXT,
  "feedFormat" "ProductFeedFormat" NOT NULL DEFAULT 'UNKNOWN',
  "feedStatus" "ProductFeedStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
  "aid" TEXT,
  "compressedLocation" TEXT,
  "creativeId" TEXT,
  "mappingVersion" TEXT,
  "lastSyncedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_feeds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_feeds_supplier_sourceAccountLabel_feedExternalId_key"
  ON "product_feeds"("supplier", "sourceAccountLabel", "feedExternalId");
CREATE INDEX IF NOT EXISTS "product_feeds_campaignSourceId_idx" ON "product_feeds"("campaignSourceId");
CREATE INDEX IF NOT EXISTS "product_feeds_feedStatus_idx" ON "product_feeds"("feedStatus");
CREATE INDEX IF NOT EXISTS "product_feeds_supplier_lastSyncedAt_idx" ON "product_feeds"("supplier", "lastSyncedAt");

CREATE TABLE IF NOT EXISTS "product_feed_items" (
  "id" TEXT NOT NULL,
  "productFeedId" TEXT NOT NULL,
  "productId" TEXT,
  "productSourceId" TEXT,
  "supplierProductId" TEXT NOT NULL,
  "title" TEXT,
  "price" DECIMAL(18,4),
  "currency" CHAR(3),
  "productUrl" TEXT,
  "imageUrl" TEXT,
  "supplierTrackingUrl" TEXT,
  "status" "ProductFeedStatus" NOT NULL DEFAULT 'ACTIVE',
  "rawPayloadId" TEXT,
  "mapperVersion" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_feed_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_feed_items_productFeedId_supplierProductId_key"
  ON "product_feed_items"("productFeedId", "supplierProductId");
CREATE INDEX IF NOT EXISTS "product_feed_items_productId_idx" ON "product_feed_items"("productId");
CREATE INDEX IF NOT EXISTS "product_feed_items_productSourceId_idx" ON "product_feed_items"("productSourceId");
CREATE INDEX IF NOT EXISTS "product_feed_items_rawPayloadId_idx" ON "product_feed_items"("rawPayloadId");

CREATE TABLE IF NOT EXISTS "client_product_assignments" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "clientCampaignAssignmentId" TEXT,
  "status" "ClientProductAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "publishedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "client_product_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_product_assignments_clientId_productId_key"
  ON "client_product_assignments"("clientId", "productId");
CREATE INDEX IF NOT EXISTS "client_product_assignments_clientId_status_idx"
  ON "client_product_assignments"("clientId", "status");
CREATE INDEX IF NOT EXISTS "client_product_assignments_productId_idx" ON "client_product_assignments"("productId");
CREATE INDEX IF NOT EXISTS "client_product_assignments_clientCampaignAssignmentId_idx"
  ON "client_product_assignments"("clientCampaignAssignmentId");

CREATE TABLE IF NOT EXISTS "product_tracking_links" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "clientProductAssignmentId" TEXT,
  "clientCampaignAssignmentId" TEXT,
  "token" TEXT NOT NULL,
  "supplierProductTrackingUrl" TEXT NOT NULL,
  "mboProductTrackingUrl" TEXT NOT NULL,
  "status" "ProductTrackingLinkStatus" NOT NULL DEFAULT 'ACTIVE',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "product_tracking_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_tracking_links_token_key" ON "product_tracking_links"("token");
CREATE INDEX IF NOT EXISTS "product_tracking_links_clientId_productId_idx"
  ON "product_tracking_links"("clientId", "productId");
CREATE INDEX IF NOT EXISTS "product_tracking_links_productId_idx" ON "product_tracking_links"("productId");
CREATE INDEX IF NOT EXISTS "product_tracking_links_clientProductAssignmentId_idx"
  ON "product_tracking_links"("clientProductAssignmentId");
CREATE INDEX IF NOT EXISTS "product_tracking_links_status_idx" ON "product_tracking_links"("status");

CREATE INDEX IF NOT EXISTS "products_productFeedId_idx" ON "products"("productFeedId");
CREATE INDEX IF NOT EXISTS "products_campaignSourceId_idx" ON "products"("campaignSourceId");

DO $$ BEGIN
  ALTER TABLE "product_feeds" ADD CONSTRAINT "product_feeds_campaignSourceId_fkey"
    FOREIGN KEY ("campaignSourceId") REFERENCES "campaign_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_productFeedId_fkey"
    FOREIGN KEY ("productFeedId") REFERENCES "product_feeds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_campaignSourceId_fkey"
    FOREIGN KEY ("campaignSourceId") REFERENCES "campaign_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "product_feed_items" ADD CONSTRAINT "product_feed_items_productFeedId_fkey"
    FOREIGN KEY ("productFeedId") REFERENCES "product_feeds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "product_feed_items" ADD CONSTRAINT "product_feed_items_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "product_feed_items" ADD CONSTRAINT "product_feed_items_productSourceId_fkey"
    FOREIGN KEY ("productSourceId") REFERENCES "product_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "product_feed_items" ADD CONSTRAINT "product_feed_items_rawPayloadId_fkey"
    FOREIGN KEY ("rawPayloadId") REFERENCES "raw_payloads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "client_product_assignments" ADD CONSTRAINT "client_product_assignments_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "client_product_assignments" ADD CONSTRAINT "client_product_assignments_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "client_product_assignments" ADD CONSTRAINT "client_product_assignments_clientCampaignAssignmentId_fkey"
    FOREIGN KEY ("clientCampaignAssignmentId") REFERENCES "client_campaign_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "product_tracking_links" ADD CONSTRAINT "product_tracking_links_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "product_tracking_links" ADD CONSTRAINT "product_tracking_links_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "product_tracking_links" ADD CONSTRAINT "product_tracking_links_clientProductAssignmentId_fkey"
    FOREIGN KEY ("clientProductAssignmentId") REFERENCES "client_product_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "product_tracking_links" ADD CONSTRAINT "product_tracking_links_clientCampaignAssignmentId_fkey"
    FOREIGN KEY ("clientCampaignAssignmentId") REFERENCES "client_campaign_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
