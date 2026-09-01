-- CreateEnum
CREATE TYPE "ClientAgreementStatus" AS ENUM ('NONE', 'DRAFT', 'SENT', 'PENDING', 'SIGNED');
CREATE TYPE "ClientPaymentCycle" AS ENUM ('MONTHLY', 'QUARTERLY');
CREATE TYPE "ClientPaymentTrigger" AS ENUM ('AFTER_NETWORK_PAYMENT', 'CONTRACT_SPECIFIC');

-- AlterTable
ALTER TABLE "clients" ADD COLUMN "legalName" TEXT;
ALTER TABLE "clients" ADD COLUMN "agreementStatus" "ClientAgreementStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "clients" ADD COLUMN "agreementEffectiveAt" TIMESTAMP(3);
ALTER TABLE "clients" ADD COLUMN "agreementRenewalAt" TIMESTAMP(3);
ALTER TABLE "clients" ADD COLUMN "agreementDocumentUrl" TEXT;
ALTER TABLE "clients" ADD COLUMN "paymentCycle" "ClientPaymentCycle";
ALTER TABLE "clients" ADD COLUMN "paymentTrigger" "ClientPaymentTrigger";
ALTER TABLE "clients" ADD COLUMN "apiEnvironmentConfig" JSONB;
