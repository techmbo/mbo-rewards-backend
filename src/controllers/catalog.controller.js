import { ok } from "../core/apiResponse.js";
import { toCampaignSourceDto, toCanonicalCampaignDto } from "../modules/catalog/dto/catalog.dto.js";
import { CatalogService } from "../modules/catalog/services/catalog.service.js";
import { CatalogQueryService } from "../modules/catalog/services/query/catalogQuery.service.js";
import {
  attachSourceBodySchema,
  catalogListQuerySchema,
  catalogParamsSchema,
  campaignSourceParamsSchema,
  createCatalogBodySchema,
  updateCampaignSourceBodySchema,
  updateCatalogBodySchema,
} from "../modules/catalog/validators/schemas.js";

const catalogService = new CatalogService();
const catalogQuery = new CatalogQueryService({ catalogService });

export async function listCatalogHandler(req, res, next) {
  try {
    const query = catalogListQuerySchema.parse(req.query);
    const response = await catalogQuery.list(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function getCatalogHandler(req, res, next) {
  try {
    const params = catalogParamsSchema.parse(req.params);
    const record = await catalogQuery.getById(params.id, req.permissions || []);

    if (!record) {
      res.status(404).json({ ok: false, message: "Catalog campaign not found." });
      return;
    }

    res.json(ok(record));
  } catch (error) {
    next(error);
  }
}

export async function createCatalogHandler(req, res, next) {
  try {
    const body = createCatalogBodySchema.parse(req.body ?? {});
    const record = await catalogService.create(body);
    res.status(201).json(ok(toCanonicalCampaignDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function updateCatalogHandler(req, res, next) {
  try {
    const params = catalogParamsSchema.parse(req.params);
    const body = updateCatalogBodySchema.parse(req.body ?? {});
    const record = await catalogService.update(params.id, body);
    res.json(ok(toCanonicalCampaignDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function attachCatalogSourceHandler(req, res, next) {
  try {
    const params = catalogParamsSchema.parse(req.params);
    const body = attachSourceBodySchema.parse(req.body ?? {});
    const source = await catalogService.attachSource(params.id, body);
    res.status(201).json(ok(toCampaignSourceDto(source)));
  } catch (error) {
    next(error);
  }
}

export async function updateCatalogSourceHandler(req, res, next) {
  try {
    const params = campaignSourceParamsSchema.parse(req.params);
    const body = updateCampaignSourceBodySchema.parse(req.body ?? {});

    const source = await catalogService.updateSource(params.id, body);
    res.json(ok(toCampaignSourceDto(source)));
  } catch (error) {
    next(error);
  }
}

export async function promoteCatalogSourceHandler(req, res, next) {
  try {
    const params = campaignSourceParamsSchema.parse(req.params);
    const source = await catalogService.promotePrimarySource(params.id);
    res.json(ok(toCampaignSourceDto(source)));
  } catch (error) {
    next(error);
  }
}
