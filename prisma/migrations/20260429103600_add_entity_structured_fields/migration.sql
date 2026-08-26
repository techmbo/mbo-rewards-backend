-- AlterTable
ALTER TABLE "Entity" ADD COLUMN     "advertiserName" TEXT,
ADD COLUMN     "campaignName" TEXT,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "commission" DOUBLE PRECISION,
ADD COLUMN     "discount" TEXT,
ADD COLUMN     "entityName" TEXT,
ADD COLUMN     "entityStatus" TEXT,
ADD COLUMN     "entitySubType" TEXT,
ADD COLUMN     "eventDate" TIMESTAMP(3),
ADD COLUMN     "revenue" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "Entity_entityType_networkSource_updatedAt_idx" ON "Entity"("entityType", "networkSource", "updatedAt");

-- CreateIndex
CREATE INDEX "Entity_campaignName_eventDate_idx" ON "Entity"("campaignName", "eventDate");

-- CreateIndex
CREATE INDEX "Entity_code_eventDate_idx" ON "Entity"("code", "eventDate");
