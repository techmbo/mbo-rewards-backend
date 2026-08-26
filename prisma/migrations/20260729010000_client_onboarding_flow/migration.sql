-- CreateEnum
CREATE TYPE "CommercialModel" AS ENUM ('OFFERS_ONLY', 'OFFERS_PLUS_COMMISSION');

-- AlterTable Client
ALTER TABLE "clients" ADD COLUMN "commercialModel" "CommercialModel";

-- AlterTable User (invite / set-password) — Prisma model maps to "User"
ALTER TABLE "User" ADD COLUMN "inviteTokenHash" TEXT;
ALTER TABLE "User" ADD COLUMN "inviteExpiresAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "passwordSetAt" TIMESTAMP(3);

CREATE INDEX "User_inviteTokenHash_idx" ON "User"("inviteTokenHash");

-- AlterTable ClientCampaignAssignment (bound CampaignSource)
ALTER TABLE "client_campaign_assignments" ADD COLUMN "campaignSourceId" TEXT;

CREATE INDEX "client_campaign_assignments_campaignSourceId_idx" ON "client_campaign_assignments"("campaignSourceId");

ALTER TABLE "client_campaign_assignments"
  ADD CONSTRAINT "client_campaign_assignments_campaignSourceId_fkey"
  FOREIGN KEY ("campaignSourceId") REFERENCES "campaign_sources"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
