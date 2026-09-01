-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "networkSource" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "normalizedData" JSONB NOT NULL,
    "rawData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldRegistry" (
    "id" TEXT NOT NULL,
    "fieldPath" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJobLog" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "message" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncJobLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceAccount" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "authType" TEXT NOT NULL,
    "accountExternalId" TEXT,
    "encryptedAccessToken" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Entity_entityType_idx" ON "Entity"("entityType");

-- CreateIndex
CREATE INDEX "Entity_networkSource_idx" ON "Entity"("networkSource");

-- CreateIndex
CREATE INDEX "Entity_externalId_networkSource_idx" ON "Entity"("externalId", "networkSource");

-- CreateIndex
CREATE UNIQUE INDEX "Entity_externalId_networkSource_entityType_key" ON "Entity"("externalId", "networkSource", "entityType");

-- CreateIndex
CREATE INDEX "FieldRegistry_entityType_source_idx" ON "FieldRegistry"("entityType", "source");

-- CreateIndex
CREATE UNIQUE INDEX "FieldRegistry_fieldPath_source_entityType_key" ON "FieldRegistry"("fieldPath", "source", "entityType");

-- CreateIndex
CREATE INDEX "MarketplaceAccount_platform_authType_idx" ON "MarketplaceAccount"("platform", "authType");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceAccount_platform_key" ON "MarketplaceAccount"("platform");
