import { ok } from "../core/apiResponse.js";
import { runTrackedJob } from "../platform/bootstrap.js";
import { toMatchResultDto } from "../modules/merchant/dto/merchant.dto.js";
import { runMatchingBodySchema } from "../modules/merchant/validators/schemas.js";

export async function runMerchantMatchingHandler(req, res, next) {
  try {
    const body = runMatchingBodySchema.parse(req.body ?? {});
    const job = await runTrackedJob("merchant-matching", {
      supplierCampaignIds: body.supplierCampaignIds,
      batchSize: body.batchSize,
      supplier: body.supplier,
      matchedBy: req.user?.id ?? null,
    });
    const summary = job.result ?? job;

    res.json(
      ok({
        processed: summary.processed,
        matched: summary.matched,
        needsReview: summary.needsReview,
        noMatch: summary.noMatch,
        results: summary.results?.map(toMatchResultDto) ?? [],
        jobId: job.id,
      }),
    );
  } catch (error) {
    next(error);
  }
}
