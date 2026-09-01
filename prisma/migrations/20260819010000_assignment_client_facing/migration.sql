-- Client-facing field overrides on campaign assignments (assignment-scoped; does not rewrite master catalog).
ALTER TABLE "client_campaign_assignments" ADD COLUMN IF NOT EXISTS "clientFacing" JSONB;
