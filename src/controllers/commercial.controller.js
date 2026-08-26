import { ok } from "../core/apiResponse.js";
import {
  toCommissionRuleDto,
  toCouponAssignmentDto,
  toTrackingLinkDto,
} from "../modules/commercial/dto/commercial.dto.js";
import { applyCommissionRuleAccess } from "../auth/commercialDataAccess.js";
import { CommercialService } from "../modules/commercial/services/commercial.service.js";
import { CommercialQueryService } from "../modules/commercial/services/query/commercialQuery.service.js";
import {
  commissionRuleListQuerySchema,
  commissionRuleParamsSchema,
  couponAssignmentListQuerySchema,
  couponAssignmentParamsSchema,
  createCommissionRuleBodySchema,
  createCouponAssignmentBodySchema,
  createTrackingLinkBodySchema,
  trackingLinkDefaultsQuerySchema,
  trackingLinkListQuerySchema,
  trackingLinkParamsSchema,
  updateCommissionRuleBodySchema,
  updateCouponAssignmentBodySchema,
  updateTrackingLinkBodySchema,
} from "../modules/commercial/validators/schemas.js";

const commercialService = new CommercialService();
const commercialQuery = new CommercialQueryService();

export async function listTrackingLinksHandler(req, res, next) {
  try {
    const query = trackingLinkListQuerySchema.parse(req.query);
    const response = await commercialQuery.listTrackingLinks(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function getTrackingLinkDefaultsHandler(req, res, next) {
  try {
    const query = trackingLinkDefaultsQuerySchema.parse(req.query);
    const defaults = await commercialService.resolveSupplierTrackingDefaults(query.assignmentId);
    res.json(ok(defaults));
  } catch (error) {
    next(error);
  }
}

export async function createTrackingLinkHandler(req, res, next) {
  try {
    const body = createTrackingLinkBodySchema.parse(req.body ?? {});
    const record = await commercialService.createTrackingLink(body);
    res.status(201).json(ok(toTrackingLinkDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function updateTrackingLinkHandler(req, res, next) {
  try {
    const params = trackingLinkParamsSchema.parse(req.params);
    const body = updateTrackingLinkBodySchema.parse(req.body ?? {});
    const record = await commercialService.updateTrackingLink(params.id, body);
    res.json(ok(toTrackingLinkDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function listCouponAssignmentsHandler(req, res, next) {
  try {
    const query = couponAssignmentListQuerySchema.parse(req.query);
    const response = await commercialQuery.listCouponAssignments(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function createCouponAssignmentHandler(req, res, next) {
  try {
    const body = createCouponAssignmentBodySchema.parse(req.body ?? {});
    const record = await commercialService.assignCoupon(body);
    res.status(201).json(ok(toCouponAssignmentDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function updateCouponAssignmentHandler(req, res, next) {
  try {
    const params = couponAssignmentParamsSchema.parse(req.params);
    const body = updateCouponAssignmentBodySchema.parse(req.body ?? {});
    const record = await commercialService.updateCouponAssignment(params.id, body);
    res.json(ok(toCouponAssignmentDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function listCommissionRulesHandler(req, res, next) {
  try {
    const query = commissionRuleListQuerySchema.parse(req.query);
    const response = await commercialQuery.listCommissionRules(query, req.permissions || []);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function createCommissionRuleHandler(req, res, next) {
  try {
    const body = createCommissionRuleBodySchema.parse(req.body ?? {});
    const record = await commercialService.createCommissionRule(body);
    res.status(201).json(ok(applyCommissionRuleAccess(record, req.permissions || [])));
  } catch (error) {
    next(error);
  }
}

export async function updateCommissionRuleHandler(req, res, next) {
  try {
    const params = commissionRuleParamsSchema.parse(req.params);
    const body = updateCommissionRuleBodySchema.parse(req.body ?? {});
    const record = await commercialService.updateCommissionRule(params.id, body);
    res.json(ok(applyCommissionRuleAccess(record, req.permissions || [])));
  } catch (error) {
    next(error);
  }
}
