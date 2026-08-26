import { okSummary } from "../core/apiResponse.js";
import { runTrackedJob } from "../platform/bootstrap.js";
import { retryPromotionJob } from "../jobs/promotion.job.js";
import {
  promotionRetryBodySchema,
  promotionRunBodySchema,
} from "../modules/supplier/validators/schemas.js";

export async function runPromotionHandler(req, res, next) {
  try {
    const body = promotionRunBodySchema.parse(req.body ?? {});
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
