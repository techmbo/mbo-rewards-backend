import { okSummary } from "../core/apiResponse.js";
import { runTrackedJob } from "../platform/bootstrap.js";
import { assertAwinPromotionWithinBudget, retryPromotionJob } from "../jobs/promotion.job.js";
import {
  promotionRetryBodySchema,
  promotionRunBodySchema,
} from "../modules/supplier/validators/schemas.js";

export async function runPromotionHandler(req, res, next) {
  try {
    const body = promotionRunBodySchema.parse(req.body ?? {});

    // Refuse an oversized Awin estate BEFORE the job is enqueued, not inside it. The job runner
    // swallows a handler throw — it retries, dead-letters, and returns the job record — so a
    // refusal raised in the handler would surface here as an empty summary and be reported as a
    // success. Checked here, it is one COUNT, nothing is enqueued, nothing is written, and the
    // operator gets the reason and the code.
    await assertAwinPromotionWithinBudget({
      entityTypes: body.entityTypes,
      networkSource: body.networkSource,
      entityIds: body.entityIds,
    });

    const job = await runTrackedJob("promotion", {
      entityTypes: body.entityTypes,
      networkSource: body.networkSource,
      entityIds: body.entityIds,
      batchSize: body.batchSize,
    });
    const summary = job.result ?? {};

    res.json(okSummary(summary));
  } catch (error) {
    next(error);
  }
}

export async function retryPromotionHandler(req, res, next) {
  try {
    const body = promotionRetryBodySchema.parse(req.body ?? {});
    const summary = await retryPromotionJob({
      mapperErrorIds: body.mapperErrorIds,
      limit: body.limit,
    });

    res.json(okSummary(summary));
  } catch (error) {
    next(error);
  }
}
