import { ok } from "../core/apiResponse.js";
import { MasterCatalogDashboardService } from "../modules/ops/masterCatalogDashboard.service.js";

const service = new MasterCatalogDashboardService();

export async function masterCatalogSummaryHandler(req, res, next) {
  try {
    const summary = await service.getSummary();
    res.json(ok(summary));
  } catch (error) {
    next(error);
  }
}
