import { ok } from "../core/apiResponse.js";
import {
  acceptInviteAndSetPassword,
  ClientOnboardingService,
  getInviteStatus,
} from "../modules/client/services/clientOnboarding.service.js";
import { toClientDto } from "../modules/client/dto/client.dto.js";
import {
  allotCampaignsBodySchema,
  clientParamsSchema,
  inviteAdminBodySchema,
  setCommercialModelBodySchema,
  setPasswordBodySchema,
} from "../modules/client/validators/schemas.js";

const onboardingService = new ClientOnboardingService();

export async function getOnboardingStateHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const state = await onboardingService.getState(params.id);
    res.json(ok(state));
  } catch (error) {
    next(error);
  }
}

export async function setCommercialModelHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const body = setCommercialModelBodySchema.parse(req.body ?? {});
    const record = await onboardingService.setCommercialModel(params.id, body);
    res.json(ok(toClientDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function inviteAdministratorHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const body = inviteAdminBodySchema.parse(req.body ?? {});
    const result = await onboardingService.inviteAdministrator(params.id, body);
    res.status(result.reused ? 200 : 201).json(ok(result));
  } catch (error) {
    next(error);
  }
}

export async function allotCampaignsHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const body = allotCampaignsBodySchema.parse(req.body ?? {});
    let result;
    if (Array.isArray(body.assignments) && body.assignments.length > 0) {
      result = await onboardingService.allotCanonicalCampaigns(params.id, body.assignments);
    } else {
      result = await onboardingService.allotCouponCmsCampaigns(params.id, body.couponEntityIds);
    }
    res.status(201).json(ok(result));
  } catch (error) {
    next(error);
  }
}

export async function provisionClientHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const result = await onboardingService.provision(params.id, {
      createdBy: req.user?.email || req.user?.id || null,
    });
    res.json(ok(result));
  } catch (error) {
    next(error);
  }
}

export async function activateOnboardingClientHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const result = await onboardingService.activate(params.id);
    res.json(ok(result));
  } catch (error) {
    next(error);
  }
}

export async function getInviteHandler(req, res, next) {
  try {
    const token = String(req.params.token || "");
    const result = await getInviteStatus(token);
    res.json(ok(result));
  } catch (error) {
    next(error);
  }
}

export async function setPasswordHandler(req, res, next) {
  try {
    const body = setPasswordBodySchema.parse(req.body ?? {});
    const user = await acceptInviteAndSetPassword(body);
    res.json(ok({ user }));
  } catch (error) {
    next(error);
  }
}
