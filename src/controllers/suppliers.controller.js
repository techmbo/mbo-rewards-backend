import { ok } from "../core/apiResponse.js";
import { runPromotionJob } from "../jobs/promotion.job.js";
import { NetworkOpsService } from "../modules/ops/networkOps.service.js";
import { SupplierQueryService } from "../modules/supplier/services/query/supplierQuery.service.js";
import { supplierListQuerySchema } from "../modules/supplier/validators/schemas.js";

const supplierQuery = new SupplierQueryService();
const networkOps = new NetworkOpsService();

/**
 * Networks / supplier integrations — operational contract (not a static seed table).
 */
export async function listSuppliersHandler(req, res, next) {
  try {
    // Prefer operational network contract when ops/view filters are present or view=networks (default).
    const view = String(req.query.view || "networks").toLowerCase();
    if (view === "seed" || view === "legacy") {
      const query = supplierListQuerySchema.parse(req.query);
      const data = await supplierQuery.list({ status: query.status }, req.permissions || []);
      return res.json(ok(data));
    }

    if (["1", "true", "yes"].includes(String(req.query.refresh || "").toLowerCase())) {
      networkOps.invalidateAggregateCache();
    }

    const result = await networkOps.listNetworks({
      q: req.query.q,
      integrationStatus: req.query.integrationStatus,
      connectionStatus: req.query.connectionStatus,
      dataHealth: req.query.dataHealth,
      mappingStatus: req.query.mappingStatus,
      capability: req.query.capability,
      capabilityState: req.query.capabilityState,
    });
    res.json({
      ok: true,
      data: result.items,
      total: result.total,
      contract: result.contract,
      liveSync: result.liveSync,
      scheduler: result.scheduler,
    });
  } catch (error) {
    next(error);
  }
}

export async function getSupplierHandler(req, res, next) {
  try {
    res.json(ok(await networkOps.getNetwork(req.params.key)));
  } catch (error) {
    next(error);
  }
}
