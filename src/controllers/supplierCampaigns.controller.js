import { ok } from "../core/apiResponse.js";
import { runPromotionJob } from "../jobs/promotion.job.js";
import { SupplierCampaignQueryService } from "../modules/supplier/services/query/supplierCampaignQuery.service.js";
import {
  promoteCampaignsBodySchema,
  supplierCampaignBrandParamsSchema,
  supplierCampaignBrandsListQuerySchema,
  supplierCampaignListQuerySchema,
  supplierCampaignParamsSchema,
} from "../modules/supplier/validators/schemas.js";

const campaignQuery = new SupplierCampaignQueryService();

export async function listSupplierCampaignsHandler(req, res, next) {
  try {
    const query = supplierCampaignListQuerySchema.parse(req.query);
    const response = await campaignQuery.list(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function listNetworkBrandsHandler(req, res, next) {
  try {
    const query = supplierCampaignBrandsListQuerySchema.parse(req.query);
    const response = await campaignQuery.listNetworkBrands(query);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function getNetworkBrandWorkspaceHandler(req, res, next) {
  try {
    const params = supplierCampaignBrandParamsSchema.parse(req.params);
    const record = await campaignQuery.getNetworkBrandWorkspace(params.brandKey);
    if (!record) {
      res.status(404).json({ ok: false, message: "Brand not found." });
      return;
    }
    res.json(ok(record));
  } catch (error) {
    next(error);
  }
}

export async function getSupplierCampaignHandler(req, res, next) {
  try {
    const params = supplierCampaignParamsSchema.parse(req.params);
    const includePayloads = req.query.includePayloads === "true";
    const forMaster = req.query.forMaster === "true";
    const record = await campaignQuery.getById(params.id, req.permissions || [], {
      includePayloads,
      forMaster,
    });

    if (!record) {
      res.status(404).json({ ok: false, message: "Supplier campaign not found." });
      return;
    }

    res.json(ok(record));
  } catch (error) {
    next(error);
  }
}

export async function promoteSupplierCampaignsHandler(req, res, next) {
  try {
    const body = promoteCampaignsBodySchema.parse(req.body ?? {});
    const summary = await runPromotionJob({
      entityTypes: body.entityTypes ?? ["campaign"],
      networkSource: body.networkSource,
      entityIds: body.entityIds,
    });

    res.json(okSummary(summary));
  } catch (error) {
    next(error);
  }
}
