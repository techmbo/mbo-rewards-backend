import { ok } from "../core/apiResponse.js";
import { NetworkOpsDashboardService } from "../modules/ops/networkOpsDashboard.service.js";

const service = new NetworkOpsDashboardService();

export async function networkOpsDashboardHandler(req, res, next) {
  try {
    res.json(ok(await service.getSummary()));
  } catch (error) {
    next(error);
  }
}
