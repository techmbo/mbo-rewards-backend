-- Encrypted API key storage for client portal reveal
ALTER TABLE "client_api_credentials" ADD COLUMN IF NOT EXISTS "keyEnc" TEXT;
