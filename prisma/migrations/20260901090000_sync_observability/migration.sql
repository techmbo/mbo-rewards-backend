-- Pointer 20 — Sync observability fields on NetworkSyncRun
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "jobType" TEXT;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "checkpointBefore" JSONB;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "checkpointAfter" JSONB;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "recordsFetched" INTEGER;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "recordsCreated" INTEGER;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "recordsUpdated" INTEGER;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "recordsUnchanged" INTEGER;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "recordsQuarantined" INTEGER;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "retryCount" INTEGER;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "rateLimitTelemetry" JSONB;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "trigger" TEXT;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "parentSyncRunId" TEXT;
ALTER TABLE "NetworkSyncRun" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

CREATE INDEX IF NOT EXISTS "NetworkSyncRun_jobType_startedAt_idx" ON "NetworkSyncRun"("jobType", "startedAt");
CREATE INDEX IF NOT EXISTS "NetworkSyncRun_parentSyncRunId_idx" ON "NetworkSyncRun"("parentSyncRunId");
