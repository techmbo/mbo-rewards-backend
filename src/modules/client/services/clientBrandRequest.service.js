import { fail } from "../../../core/apiResponse.js";
import { ClientRepository } from "../repositories/client.repository.js";
import { MerchantRepository } from "../../merchant/repositories/merchant.repository.js";
import { ClientBrandRequestRepository } from "../repositories/clientBrandRequest.repository.js";

export class ClientBrandRequestService {
  constructor(deps = {}) {
    this.requestRepo = deps.requestRepo ?? new ClientBrandRequestRepository();
    this.clientRepo = deps.clientRepo ?? new ClientRepository();
    this.merchantRepo = deps.merchantRepo ?? new MerchantRepository();
  }

  async create(input, client = null) {
    const clientRecord = await this.clientRepo.findById(input.clientId, {}, client);
    if (!clientRecord) throw fail("Client not found.", 404);

    if (input.merchantId) {
      const merchant = await this.merchantRepo.findById(input.merchantId, client);
      if (!merchant) throw fail("Merchant not found.", 404);
    }

    return this.requestRepo.create(
      {
        clientId: input.clientId,
        merchantId: input.merchantId ?? null,
        requestedBrandName: input.requestedBrandName.trim(),
        requestedBy: input.requestedBy ?? null,
        priority: input.priority ?? 100,
        status: "REQUESTED",
        notes: input.notes ?? null,
        requestedAt: new Date(),
      },
      client,
    );
  }

  async update(id, input, client = null) {
    const record = await this.requestRepo.findById(id, client);
    if (!record) throw fail("Brand request not found.", 404);

    const data = {};
    if (input.status !== undefined) {
      data.status = input.status;
      if (["APPROVED", "REJECTED", "FULFILLED"].includes(input.status)) {
        data.resolvedAt = new Date();
      }
    }
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.fulfilledAssignmentId !== undefined) {
      data.fulfilledAssignmentId = input.fulfilledAssignmentId;
    }

    return this.requestRepo.update(id, data, client);
  }
}
