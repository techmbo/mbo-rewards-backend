import { ok, okPaged } from "../core/apiResponse.js";
import { ClientAllocationService } from "../modules/client/services/clientAllocation.service.js";

const allocationService = new ClientAllocationService();

export async function listClientAllocationCampaignsHandler(req, res, next) {
  try {
    const clientId = req.params.id;
    const result = await allocationService.listForClient(clientId, req.query);
    res.json({
      ok: true,
      data: {
        items: result.items,
        summary: result.summary,
        client: result.client,
      },
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        hasMore: result.page * result.pageSize < result.total,
      },
      // Compatibility aliases (same payload)
      summary: result.summary,
      client: result.client,
    });
  } catch (error) {
    next(error);
  }
}

export async function getClientAllocationCampaignHandler(req, res, next) {
  try {
    const detail = await allocationService.getDetail(req.params.id, req.params.campaignId);
    res.json(ok(detail));
  } catch (error) {
    next(error);
  }
}
