import { ok } from "../core/apiResponse.js";
import { toClientBrandRequestDto, toClientCampaignAssignmentDto, toClientDto } from "../modules/client/dto/client.dto.js";
import { ClientService } from "../modules/client/services/client.service.js";
import { ClientBrandRequestService } from "../modules/client/services/clientBrandRequest.service.js";
import { ClientAssignmentService } from "../modules/client/services/clientAssignment.service.js";
import { ClientQueryService } from "../modules/client/services/query/clientQuery.service.js";
import {
  assignmentListQuerySchema,
  assignmentParamsSchema,
  brandRequestListQuerySchema,
  brandRequestParamsSchema,
  clientListQuerySchema,
  clientParamsSchema,
  createAssignmentBodySchema,
  createBrandRequestBodySchema,
  createClientBodySchema,
  updateAssignmentBodySchema,
  updateBrandRequestBodySchema,
  updateClientBodySchema,
} from "../modules/client/validators/schemas.js";

const clientService = new ClientService();
const brandRequestService = new ClientBrandRequestService();
const assignmentService = new ClientAssignmentService();
const clientQuery = new ClientQueryService({ assignmentService });

export async function listClientsHandler(req, res, next) {
  try {
    const query = clientListQuerySchema.parse(req.query);
    const response = await clientQuery.listClients(query);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function getClientHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const record = await clientQuery.getClientById(params.id);

    if (!record) {
      res.status(404).json({ ok: false, message: "Client not found." });
      return;
    }

    res.json(ok(record));
  } catch (error) {
    next(error);
  }
}

export async function createClientHandler(req, res, next) {
  try {
    const body = createClientBodySchema.parse(req.body ?? {});
    const record = await clientService.create(body);
    res.status(201).json(ok(toClientDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function updateClientHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const body = updateClientBodySchema.parse(req.body ?? {});
    const record = await clientService.update(params.id, body);
    res.json(ok(toClientDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function deleteClientHandler(req, res, next) {
  try {
    const params = clientParamsSchema.parse(req.params);
    const record = await clientService.remove(params.id);
    res.json(ok(toClientDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function listBrandRequestsHandler(req, res, next) {
  try {
    const query = brandRequestListQuerySchema.parse(req.query);
    const response = await clientQuery.listBrandRequests(query);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function createBrandRequestHandler(req, res, next) {
  try {
    const body = createBrandRequestBodySchema.parse(req.body ?? {});
    const record = await brandRequestService.create({
      ...body,
      requestedBy: body.requestedBy ?? req.user?.id ?? null,
    });
    res.status(201).json(ok(toClientBrandRequestDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function updateBrandRequestHandler(req, res, next) {
  try {
    const params = brandRequestParamsSchema.parse(req.params);
    const body = updateBrandRequestBodySchema.parse(req.body ?? {});
    const record = await brandRequestService.update(params.id, body);
    res.json(ok(toClientBrandRequestDto(record)));
  } catch (error) {
    next(error);
  }
}

export async function listAssignmentsHandler(req, res, next) {
  try {
    const query = assignmentListQuerySchema.parse(req.query);
    const response = await clientQuery.listAssignments(query);
    res.json(response);
  } catch (error) {
    next(error);
  }
}

export async function createAssignmentHandler(req, res, next) {
  try {
    const body = createAssignmentBodySchema.parse(req.body ?? {});
    const record = await assignmentService.createDraft(body);
    const dto = toClientCampaignAssignmentDto(record);
    dto.lifecycle = assignmentService.resolveLifecycle(record);
    res.status(201).json(ok(dto));
  } catch (error) {
    next(error);
  }
}

export async function updateAssignmentHandler(req, res, next) {
  try {
    const params = assignmentParamsSchema.parse(req.params);
    const body = updateAssignmentBodySchema.parse(req.body ?? {});
    const record = await assignmentService.update(params.id, body);
    const dto = toClientCampaignAssignmentDto(record);
    dto.lifecycle = assignmentService.resolveLifecycle(record);
    res.json(ok(dto));
  } catch (error) {
    next(error);
  }
}
