import { ok } from "../core/apiResponse.js";
import { MerchantMatchingService } from "../modules/merchant/services/merchantMatching.service.js";
import { MerchantQueryService } from "../modules/merchant/services/query/merchantQuery.service.js";
import {
  merchantReviewListQuerySchema,
  merchantReviewParamsSchema,
  updateMerchantReviewBodySchema,
} from "../modules/merchant/validators/schemas.js";
import { toMerchantReviewDto } from "../modules/merchant/dto/merchant.dto.js";

const merchantQuery = new MerchantQueryService();
const matchingService = new MerchantMatchingService();

export async function listMerchantReviewsHandler(req, res, next) {
  try {
    const query = merchantReviewListQuerySchema.parse(req.query);
    const response = await merchantQuery.listReviews(query);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function getMerchantReviewHandler(req, res, next) {
  try {
    const params = merchantReviewParamsSchema.parse(req.params);
    const record = await merchantQuery.getReviewById(params.id);

    if (!record) {
      res.status(404).json({ ok: false, message: "Merchant review not found." });
      return;
    }

    const potentialMatches = await merchantQuery.findPotentialMatchesForReview(params.id);
    res.json(ok({ review: record, potentialMatches }));
  } catch (error) {
    next(error);
  }
}

export async function updateMerchantReviewHandler(req, res, next) {
  try {
    const params = merchantReviewParamsSchema.parse(req.params);
    const body = updateMerchantReviewBodySchema.parse(req.body ?? {});

    const record = await matchingService.resolveReview(params.id, {
      status: body.status,
      merchantId: body.merchantId,
      notes: body.notes,
      reviewedBy: req.user?.id ?? null,
    });

    if (!record) {
      res.status(404).json({ ok: false, message: "Merchant review not found." });
      return;
    }

    res.json(ok(toMerchantReviewDto(record)));
  } catch (error) {
    next(error);
  }
}
