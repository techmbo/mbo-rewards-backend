-- MapperError retry lease clock.
-- Additive only: one nullable column, no backfill, no index, no row is rewritten.
--
-- "retryStartedAt" is set by a conditional retry claim and cleared by every final status write.
-- Existing rows keep NULL: OPEN / RESOLVED / DISCARDED rows never read it, and a RETRYING row left
-- behind by the previous code (which had no lease) reads as stale, so the next automatic retry can
-- reclaim it.

ALTER TABLE "mapper_errors"
ADD COLUMN "retryStartedAt" TIMESTAMP(3);
