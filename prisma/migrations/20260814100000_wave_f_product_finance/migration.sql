-- Wave F: Product catalog + optional OrderItem product link (additive)

CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DISCONTINUED', 'UNKNOWN');
CREATE TYPE "ProductAvailability" AS ENUM ('IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'UNKNOWN');

CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "url" TEXT,
    "imageUrl" TEXT,
    "category" TEXT,
    "brand" TEXT,
    "price" DECIMAL(18,4),
    "currency" CHAR(3),
    "availability" "ProductAvailability" NOT NULL DEFAULT 'UNKNOWN',
    "status" "ProductStatus" NOT NULL DEFAULT 'UNKNOWN',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_sources" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplier" "SupplierKey" NOT NULL,
    "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
    "supplierProductId" TEXT NOT NULL,
    "supplierSku" TEXT,
    "supplierCampaignId" TEXT,
    "catalogId" TEXT,
    "title" TEXT,
    "price" DECIMAL(18,4),
    "currency" CHAR(3),
    "rawPayloadId" TEXT,
    "mapperVersion" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_sources_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "productRecordId" TEXT;

CREATE UNIQUE INDEX "product_sources_supplier_sourceAccountLabel_supplierProductId_key"
    ON "product_sources"("supplier", "sourceAccountLabel", "supplierProductId");

CREATE INDEX "products_merchantId_idx" ON "products"("merchantId");
CREATE INDEX "products_sku_idx" ON "products"("sku");
CREATE INDEX "products_status_idx" ON "products"("status");
CREATE INDEX "product_sources_productId_idx" ON "product_sources"("productId");
CREATE INDEX "product_sources_supplier_supplierSku_idx" ON "product_sources"("supplier", "supplierSku");
CREATE INDEX "product_sources_rawPayloadId_idx" ON "product_sources"("rawPayloadId");
CREATE INDEX "order_items_productRecordId_idx" ON "order_items"("productRecordId");

ALTER TABLE "products" ADD CONSTRAINT "products_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "product_sources" ADD CONSTRAINT "product_sources_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_sources" ADD CONSTRAINT "product_sources_rawPayloadId_fkey"
    FOREIGN KEY ("rawPayloadId") REFERENCES "raw_payloads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productRecordId_fkey"
    FOREIGN KEY ("productRecordId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
