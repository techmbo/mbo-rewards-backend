-- AlterTable
ALTER TABLE "Entity" ADD COLUMN     "fieldPolicies" JSONB,
ADD COLUMN     "hasSyncConflict" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastSyncedData" JSONB,
ADD COLUMN     "manualData" JSONB;

-- CreateTable
CREATE TABLE "CouponColumnConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "sourceType" TEXT NOT NULL,
    "dataPath" TEXT,
    "optimisePaths" JSONB NOT NULL DEFAULT '[]',
    "boostinyPaths" JSONB NOT NULL DEFAULT '[]',
    "columnType" TEXT NOT NULL DEFAULT 'text',
    "builtinKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CouponColumnConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CouponColumnConfig_key_key" ON "CouponColumnConfig"("key");
