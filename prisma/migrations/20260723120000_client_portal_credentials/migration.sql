-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'CLIENT';

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "clientId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "client_api_credentials" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdBy" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_api_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_clientId_idx" ON "User"("clientId");
CREATE INDEX IF NOT EXISTS "client_api_credentials_clientId_idx" ON "client_api_credentials"("clientId");
CREATE INDEX IF NOT EXISTS "client_api_credentials_keyPrefix_idx" ON "client_api_credentials"("keyPrefix");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_clientId_fkey'
  ) THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_api_credentials_clientId_fkey'
  ) THEN
    ALTER TABLE "client_api_credentials" ADD CONSTRAINT "client_api_credentials_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
