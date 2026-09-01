-- Phase 6 — Platform operations (audit trail, job framework)

CREATE TYPE "JobRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DEAD_LETTER');

CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "correlationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "status" "JobRunStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "result" JSONB,
    "lastError" TEXT,
    "correlationId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_events_aggregateType_aggregateId_idx" ON "audit_events"("aggregateType", "aggregateId");
CREATE INDEX "audit_events_action_createdAt_idx" ON "audit_events"("action", "createdAt");
CREATE INDEX "audit_events_correlationId_idx" ON "audit_events"("correlationId");
CREATE INDEX "audit_events_createdAt_idx" ON "audit_events"("createdAt");

CREATE INDEX "job_runs_jobName_status_idx" ON "job_runs"("jobName", "status");
CREATE INDEX "job_runs_status_createdAt_idx" ON "job_runs"("status", "createdAt");
CREATE INDEX "job_runs_correlationId_idx" ON "job_runs"("correlationId");
