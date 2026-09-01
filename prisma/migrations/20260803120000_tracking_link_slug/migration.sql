-- Add human-readable slug for MBO tracking URLs: /r/{slug}/{token}
ALTER TABLE "tracking_links" ADD COLUMN "slug" TEXT;

CREATE INDEX "tracking_links_slug_idx" ON "tracking_links"("slug");
