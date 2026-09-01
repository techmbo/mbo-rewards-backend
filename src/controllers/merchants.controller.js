import { ok } from "../core/apiResponse.js";
import { toMerchantDto } from "../modules/merchant/dto/merchant.dto.js";
import { MerchantService } from "../modules/merchant/services/merchant.service.js";
import { MerchantQueryService } from "../modules/merchant/services/query/merchantQuery.service.js";
import {
  createMerchantBodySchema,
  merchantListQuerySchema,
  merchantParamsSchema,
  mergeMerchantBodySchema,
  updateMerchantBodySchema,
} from "../modules/merchant/validators/schemas.js";

const merchantService = new MerchantService();
const merchantQuery = new MerchantQueryService();

export async function listMerchantsHandler(req, res, next) {
  try {
    const query = merchantListQuerySchema.parse(req.query);
    const response = await merchantQuery.list(query);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function getMerchantHandler(req, res, next) {
  try {
    const params = merchantParamsSchema.parse(req.params);
    const record = await merchantQuery.getById(params.id);

    if (!record) {
      res.status(404).json({ ok: false, message: "Merchant not found." });
      return;
    }

    res.json(ok(record));
  } catch (error) {
    next(error);
  }
}

export async function createMerchantHandler(req, res, next) {
  try {
    const body = createMerchantBodySchema.parse(req.body ?? {});
    const record = await merchantService.create(body);
    res.status(201).json(ok(toMerchantDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function updateMerchantHandler(req, res, next) {
  try {
    const params = merchantParamsSchema.parse(req.params);
    const body = updateMerchantBodySchema.parse(req.body ?? {});
    const record = await merchantService.update(params.id, body);
    res.json(ok(toMerchantDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function mergeMerchantHandler(req, res, next) {
  try {
    const params = merchantParamsSchema.parse(req.params);
    const body = mergeMerchantBodySchema.parse(req.body ?? {});
    const record = await merchantService.merge(params.id, body, req.user?.id ?? null);
    res.json(ok(toMerchantDto(record)));
  } catch (error) {
    next(error);
  }
}

