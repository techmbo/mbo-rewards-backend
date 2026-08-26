-- CreateEnum
CREATE TYPE "ApiCredentialEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- AlterTable
ALTER TABLE "client_api_credentials" ADD COLUMN "environment" "ApiCredentialEnvironment" NOT NULL DEFAULT 'PRODUCTION';

-- CreateIndex
CREATE INDEX "client_api_credentials_clientId_environment_idx" ON "client_api_credentials"("clientId", "environment");
