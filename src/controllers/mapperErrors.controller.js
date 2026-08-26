import { ok } from "../core/apiResponse.js";
import { retryPromotionJob } from "../jobs/promotion.job.js";
import { MapperErrorQueryService } from "../modules/supplier/services/query/mapperErrorQuery.service.js";
import {
  mapperErrorListQuerySchema,
  mapperErrorRetryParamsSchema,
} from "../modules/supplier/validators/schemas.js";

const mapperErrorQuery = new MapperErrorQueryService();

export async function listMapperErrorsHandler(req, res, next) {
  try {
    const query = mapperErrorListQuerySchema.parse(req.query);
    const response = await mapperErrorQuery.list(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function retryMapperErrorHandler(req, res, next) {
  try {
    const params = mapperErrorRetryParamsSchema.parse(req.params);
    const record = await mapperErrorQuery.getById(params.id, req.permissions || []);

    if (!record) {
      res.status(404).json({ ok: false, message: "Mapper error not found." });
      return;
    }

    const summary = await retryPromotionJob({ mapperErrorIds: [params.id], limit: 1 });
    res.json(ok({ summary }));
  } catch (error) {
    next(error);
  }
}
