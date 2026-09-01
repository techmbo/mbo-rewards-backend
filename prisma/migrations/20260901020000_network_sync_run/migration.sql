-- Isolated sync runs per source object (not per network blob).

CREATE TABLE IF NOT EXISTS "NetworkSyncRun" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "networkAccountId" TEXT,
    "sourceObject" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recordCount" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NetworkSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "NetworkSyncRun_network_sourceObject_startedAt_idx"
  ON "NetworkSyncRun"("network", "sourceObject", "startedAt");

CREATE INDEX IF NOT EXISTS "NetworkSyncRun_networkAccountId_startedAt_idx"
  ON "NetworkSyncRun"("networkAccountId", "startedAt");

CREATE INDEX IF NOT EXISTS "NetworkSyncRun_status_startedAt_idx"
  ON "NetworkSyncRun"("status", "startedAt");

ALTER TABLE "NetworkSyncRun"
  DROP CONSTRAINT IF EXISTS "NetworkSyncRun_networkAccountId_fkey";

ALTER TABLE "NetworkSyncRun"
  ADD CONSTRAINT "NetworkSyncRun_networkAccountId_fkey"
  FOREIGN KEY ("networkAccountId") REFERENCES "MarketplaceAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
