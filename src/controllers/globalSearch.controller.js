import { ok } from "../core/apiResponse.js";
import { GlobalSearchService } from "../modules/ops/globalSearch.service.js";

const service = new GlobalSearchService();

export async function globalSearchHandler(req, res, next) {
  try {
    const payload = await service.search(req.query.q || req.query.search || "", {
      permissions: req.permissions || [],
      limit: req.query.limit,
    });
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}
