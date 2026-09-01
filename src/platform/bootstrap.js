import { PromotionJob } from "../jobs/promotion.job.js";
import { AggregationJob } from "../jobs/aggregation.job.js";
import { ConversionPromotionJob } from "../jobs/conversionPromotion.job.js";
import { MerchantMatchingService } from "../modules/merchant/services/merchantMatching.service.js";
import { jobRunner } from "./jobs/jobRunner.js";
import { auditService } from "./audit/audit.service.js";
import { AUDIT_ACTIONS, DOMAIN_EVENTS } from "./events/domainEvents.js";
import { eventDispatcher } from "./events/eventDispatcher.js";
import { logger } from "./logging/logger.js";

const promotionJob = new PromotionJob();
const aggregationJob = new AggregationJob();
const conversionPromotionJob = new ConversionPromotionJob();
const merchantMatching = new MerchantMatchingService();

export function registerPlatformJobs() {
  jobRunner.register(
    "promotion",
    async (payload) => {
      const summary = await promotionJob.run(payload);
      await auditService.record({
        aggregateType: "Promotion",
        action: AUDIT_ACTIONS.PROMOTION_COMPLETED,
        after: summary,
        metadata: { job: "promotion" },
      });
      await eventDispatcher.publish({
        eventType: DOMAIN_EVENTS.SUPPLIER_CAMPAIGN_PROMOTED,
        aggregateId: "promotion",
        payload: summary,
      });
      return summary;
    },
    { concurrency: 1, maxAttempts: 3 },
  );

  jobRunner.register(
    "conversion-promotion",
    async (payload) => {
      const summary = await conversionPromotionJob.run(payload ?? {});
      await auditService.record({
        aggregateType: "Conversion",
        action: "CONVERSION_PROMOTION_COMPLETED",
        after: summary,
        metadata: { job: "conversion-promotion" },
      });
      return summary;
    },
    { concurrency: 1, maxAttempts: 3 },
  );

  jobRunner.register(
    "aggregation",
    async (payload) => {
      const result = payload?.rebuild
        ? await aggregationJob.rebuild(payload)
        : await aggregationJob.run(payload);
      await auditService.record({
        aggregateType: "DailyReport",
        action: AUDIT_ACTIONS.AGGREGATION_COMPLETED,
        after: result,
      });
      await eventDispatcher.publish({
        eventType: DOMAIN_EVENTS.AGGREGATION_COMPLETED,
        aggregateId: "aggregation",
        payload: result,
      });
      return result;
    },
    { concurrency: 1, maxAttempts: 3 },
  );

  jobRunner.register(
    "merchant-matching",
    async (payload) => {
      const result = await merchantMatching.run(payload ?? {});
      await auditService.record({
        aggregateType: "Merchant",
        action: AUDIT_ACTIONS.MERCHANT_MATCHING_RUN,
        after: result,
        metadata: { job: "merchant-matching" },
      });
      await eventDispatcher.publish({
        eventType: DOMAIN_EVENTS.MERCHANT_MATCHED,
        aggregateId: "merchant-matching",
        payload: result,
      });
      return result;
    },
    { concurrency: 1, maxAttempts: 3 },
  );

  logger.info("platform jobs registered");
}

export async function runTrackedJob(jobName, payload = {}) {
  const job = await jobRunner.enqueue(jobName, payload);
  return jobRunner.execute(job.id);
}
