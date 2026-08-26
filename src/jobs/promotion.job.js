import { PROMOTION_BATCH_SIZE, SUPPLIER_ENTITY_TYPES } from "../modules/supplier/constants.js";
import { EntityRepository, MapperErrorRepository } from "../modules/supplier/repositories/index.js";
import { PromotionService } from "../modules/supplier/services/promotion.service.js";
import { SupplierCampaignPromotionService } from "../modules/supplier/services/supplierCampaignPromotion.service.js";
import { SupplierCouponPromotionService } from "../modules/supplier/services/supplierCouponPromotion.service.js";
import { CampaignNormalizationService } from "../modules/ops/campaignNormalization.service.js";

function emptySummary() {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    durationMs: 0,
    processed: 0,
    merchantMatched: 0,
    merchantNeedsReview: 0,
    catalogLinked: 0,
  };
}

function accumulate(summary, result) {
  if (result.result === "created") summary.created += 1;
  else if (result.result === "updated") summary.updated += 1;
  else if (result.result === "failed") summary.failed += 1;
  else summary.skipped += 1;
  summary.processed += 1;

  const norm = result.normalization;
  if (!norm) return;
  if (norm.catalogLinked) summary.catalogLinked += 1;
  if (norm.matchOutcome === "matched") summary.merchantMatched += 1;
  if (norm.matchOutcome === "needs_review" || norm.blockedReason === "merchant_no_match" || norm.blockedReason === "missing_merchant_identifier") {
    summary.merchantNeedsReview += 1;
  }
}

export class PromotionJob {
  constructor(deps = {}) {
    this.campaignPromotion = deps.campaignPromotion ?? new SupplierCampaignPromotionService();
    this.couponPromotion = deps.couponPromotion ?? new SupplierCouponPromotionService();
    this.promotionService = deps.promotionService ?? new PromotionService();
    this.mapperErrorRepo = deps.mapperErrorRepo ?? new MapperErrorRepository();
    this.entityRepo = deps.entityRepo ?? new EntityRepository();
    this.normalization = deps.normalization ?? new CampaignNormalizationService();
  }

  async run({
    entityTypes = [SUPPLIER_ENTITY_TYPES.CAMPAIGN, SUPPLIER_ENTITY_TYPES.COUPON],
    networkSource,
    entityIds,
    batchSize = PROMOTION_BATCH_SIZE,
  } = {}) {
    const startedAt = Date.now();
    const summary = emptySummary();

    await this.promotionService.ensureSuppliersSeeded();

    let cursorId = undefined;

    while (true) {
      const batch = await this.entityRepo.findManyForPromotion({
        entityTypes,
        networkSource,
        entityIds,
        batchSize,
        cursorId,
      });

      if (!batch.length) break;

      for (const entity of batch) {
        const result = await this.promoteEntity(entity);
        accumulate(summary, result);
      }

      cursorId = batch[batch.length - 1].id;
      if (batch.length < batchSize) break;
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  async promoteEntity(entity) {
    if (entity.entityType === SUPPLIER_ENTITY_TYPES.CAMPAIGN) {
      const result = await this.campaignPromotion.promoteEntity(entity);
      if ((result.result === "created" || result.result === "updated") && result.record) {
        result.normalization = await this.normalization.normalizeSupplierCampaign(result.record, {
          matchedBy: "promotion",
        });
      }
      return result;
    }
    if (entity.entityType === SUPPLIER_ENTITY_TYPES.COUPON) {
      return this.couponPromotion.promoteEntity(entity);
    }
    return { result: "skipped" };
  }

  async retryFailed({ mapperErrorIds, limit = PROMOTION_BATCH_SIZE } = {}) {
    const startedAt = Date.now();
    const summary = emptySummary();

    const targets = mapperErrorIds?.length
      ? await this.mapperErrorRepo.findByIds(mapperErrorIds)
      : (
          await this.mapperErrorRepo.findMany({ status: "OPEN" }, { skip: 0, take: limit })
        ).rows;

    for (const mapperError of targets) {
      await this.mapperErrorRepo.updateStatus(mapperError.id, "RETRYING");

      const entity = await this.entityRepo.findById(mapperError.entityId);
      if (!entity) {
        await this.mapperErrorRepo.updateStatus(mapperError.id, "DISCARDED", {
          message: "Source Entity no longer exists",
        });
        summary.failed += 1;
        summary.processed += 1;
        continue;
      }

      const result = await this.promoteEntity(entity);
      accumulate(summary, result);

      if (result.result !== "failed") {
        await this.mapperErrorRepo.updateStatus(mapperError.id, "RESOLVED");
      } else {
        await this.mapperErrorRepo.updateStatus(mapperError.id, "OPEN");
      }
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
  }
}

export async function runPromotionJob(options = {}) {
  const job = new PromotionJob();
  return job.run(options);
}

export async function retryPromotionJob(options = {}) {
  const job = new PromotionJob();
  return job.retryFailed(options);
}
