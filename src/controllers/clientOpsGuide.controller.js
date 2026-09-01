import { ok } from "../core/apiResponse.js";
import { ClientOpsGuideService } from "../modules/client/clientOpsGuide.service.js";

const service = new ClientOpsGuideService();

export async function clientOpsGuideHandler(req, res, next) {
  try {
    const guide = await service.getGuide();
    res.json(ok(guide));
  } catch (error) {
    next(error);
  }
}
