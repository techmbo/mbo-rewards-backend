/** Wave 1 mapper version — bump when mapping rules change. */
export const MAPPER_VERSION = "1.1.1";

export const SUPPLIER_ENTITY_TYPES = {
  CAMPAIGN: "campaign",
  COUPON: "coupon",
};

export const PROMOTION_BATCH_SIZE = 100;

/**
 * The most mapper errors one retry request may attempt (POST /promotion/retry, and the
 * PromotionJob.retryFailed() it calls). The retry runs synchronously inside one serverless
 * invocation and promotes each target in full, so its bound is the production-derived bounded
 * promotion page: 50 entities leave real margin inside a 300 s invocation, while 100 (the legacy
 * PROMOTION_BATCH_SIZE) is documented to lose that margin under contention for this per-entity
 * workload. Kept as a literal here so the validator module does not import the jobs layer; a test
 * pins it equal to PROMOTION_PAGE_SIZE so the two cannot drift apart silently.
 */
export const PROMOTION_RETRY_BATCH_SIZE = 50;
