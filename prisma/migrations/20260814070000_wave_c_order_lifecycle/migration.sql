-- Wave C: Order / OrderItem / validation+payment statuses / ExceptionCase
-- Additive only. Does not backfill historical Conversion → Order.

CREATE TYPE "ValidationStatus" AS ENUM (
  'VALIDATION_PENDING',
  'VALIDATION_APPROVED',
  'VALIDATION_REJECTED',
  'VALIDATION_NEEDS_REVIEW'
);

CREATE TYPE "SupplierPaymentStatus" AS ENUM (
  'PAYMENT_PENDING',
  'PAYMENT_AWAITING_INVOICE',
  'PAYMENT_INVOICED',
  'PAYMENT_PAYABLE',
  'PAYMENT_RECEIVED',
  'PAYMENT_ON_HOLD'
);

CREATE TYPE "ClientPaymentStatus" AS ENUM (
  'CLIENT_PAYMENT_NOT_READY',
  'CLIENT_PAYMENT_PAYABLE',
  'CLIENT_PAYMENT_INVOICED',
  'CLIENT_PAYMENT_PROCESSING',
  'CLIENT_PAYMENT_PAID',
  'CLIENT_PAYMENT_ON_HOLD'
);

CREATE TYPE "ExceptionCaseType" AS ENUM (
  'ATTRIBUTION_UNRESOLVED',
  'DUPLICATE_ORDER',
  'DUPLICATE_CONVERSION',
  'MISSING_SUPPLIER_ORDER_ID',
  'MISSING_SUPPLIER_CONVERSION_ID',
  'INVALID_VALIDATION_TRANSITION',
  'INVALID_PAYMENT_TRANSITION',
  'COMMISSION_MISSING',
  'COMMISSION_INVALID',
  'LATE_REJECTION',
  'ORDER_DATA_CONFLICT',
  'SUPPLIER_STATUS_UNKNOWN'
);

CREATE TYPE "ExceptionSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

CREATE TYPE "ExceptionCaseStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "supplier" "SupplierKey" NOT NULL,
    "sourceAccountLabel" TEXT NOT NULL DEFAULT 'default',
    "supplierOrderId" TEXT NOT NULL,
    "clientId" TEXT,
    "merchantId" TEXT,
    "canonicalCampaignId" TEXT,
    "campaignSourceId" TEXT,
    "clientAssignmentId" TEXT,
    "clickId" TEXT,
    "orderValue" DECIMAL(18,4),
    "currency" CHAR(3),
    "orderDate" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validationStatus" "ValidationStatus" NOT NULL DEFAULT 'VALIDATION_PENDING',
    "supplierPaymentStatus" "SupplierPaymentStatus" NOT NULL DEFAULT 'PAYMENT_PENDING',
    "clientPaymentStatus" "ClientPaymentStatus" NOT NULL DEFAULT 'CLIENT_PAYMENT_NOT_READY',
    "validationChangedAt" TIMESTAMP(3),
    "supplierPaymentChangedAt" TIMESTAMP(3),
    "clientPaymentChangedAt" TIMESTAMP(3),
    "lastApprovedClientCommission" DECIMAL(18,4),
    "lastApprovedMboCommission" DECIMAL(18,4),
    "lastApprovedSupplierCommission" DECIMAL(18,4),
    "rawPayloadId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "orders_supplier_sourceAccountLabel_supplierOrderId_key"
  ON "orders"("supplier", "sourceAccountLabel", "supplierOrderId");
CREATE INDEX "orders_clientId_orderDate_idx" ON "orders"("clientId", "orderDate");
CREATE INDEX "orders_validationStatus_idx" ON "orders"("validationStatus");
CREATE INDEX "orders_supplierPaymentStatus_idx" ON "orders"("supplierPaymentStatus");
CREATE INDEX "orders_clientPaymentStatus_idx" ON "orders"("clientPaymentStatus");
CREATE INDEX "orders_campaignSourceId_idx" ON "orders"("campaignSourceId");
CREATE INDEX "orders_clientAssignmentId_idx" ON "orders"("clientAssignmentId");
CREATE INDEX "orders_rawPayloadId_idx" ON "orders"("rawPayloadId");

ALTER TABLE "orders" ADD CONSTRAINT "orders_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_canonicalCampaignId_fkey"
  FOREIGN KEY ("canonicalCampaignId") REFERENCES "canonical_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_campaignSourceId_fkey"
  FOREIGN KEY ("campaignSourceId") REFERENCES "campaign_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_clientAssignmentId_fkey"
  FOREIGN KEY ("clientAssignmentId") REFERENCES "client_campaign_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_clickId_fkey"
  FOREIGN KEY ("clickId") REFERENCES "clicks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_rawPayloadId_fkey"
  FOREIGN KEY ("rawPayloadId") REFERENCES "raw_payloads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "supplierItemId" TEXT,
    "sku" TEXT,
    "productId" TEXT,
    "productName" TEXT,
    "quantity" DECIMAL(18,4),
    "unitPrice" DECIMAL(18,4),
    "itemValue" DECIMAL(18,4),
    "currency" CHAR(3),
    "category" TEXT,
    "commission" DECIMAL(18,4),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_items_orderId_lineKey_key" ON "order_items"("orderId", "lineKey");
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");
CREATE INDEX "order_items_sku_idx" ON "order_items"("sku");

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "exception_cases" (
    "id" TEXT NOT NULL,
    "type" "ExceptionCaseType" NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "ExceptionCaseStatus" NOT NULL DEFAULT 'OPEN',
    "dedupeKey" TEXT NOT NULL,
    "orderId" TEXT,
    "conversionId" TEXT,
    "supplier" "SupplierKey",
    "clientId" TEXT,
    "entityId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "assignedTo" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exception_cases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "exception_cases_dedupeKey_status_idx" ON "exception_cases"("dedupeKey", "status");
CREATE INDEX "exception_cases_type_status_idx" ON "exception_cases"("type", "status");
CREATE INDEX "exception_cases_orderId_idx" ON "exception_cases"("orderId");
CREATE INDEX "exception_cases_conversionId_idx" ON "exception_cases"("conversionId");
CREATE INDEX "exception_cases_clientId_status_idx" ON "exception_cases"("clientId", "status");
CREATE INDEX "exception_cases_detectedAt_idx" ON "exception_cases"("detectedAt");

ALTER TABLE "exception_cases" ADD CONSTRAINT "exception_cases_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "exception_cases" ADD CONSTRAINT "exception_cases_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversions" ADD COLUMN IF NOT EXISTS "orderId" TEXT;
CREATE INDEX IF NOT EXISTS "conversions_orderId_idx" ON "conversions"("orderId");
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "exception_cases" ADD CONSTRAINT "exception_cases_conversionId_fkey"
  FOREIGN KEY ("conversionId") REFERENCES "conversions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
