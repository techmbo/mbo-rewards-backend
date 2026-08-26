import { ok } from "../core/apiResponse.js";
import { PartnerCampaignService } from "../modules/client/services/partnerCampaign.service.js";
import {
  partnerCampaignListQuerySchema,
  partnerCampaignParamsSchema,
} from "../modules/client/validators/schemas.js";

const partnerCampaigns = new PartnerCampaignService();

function requirePartnerClient(req, res) {
  const clientId = req.partnerClientId;
  if (!clientId) {
    res.status(401).json({ ok: false, message: "Client authentication required." });
    return null;
  }
  const claimed =
    req.query?.clientId ||
    req.query?.client_id ||
    req.body?.clientId ||
    req.body?.client_id ||
    null;
  if (claimed != null && String(claimed) && String(claimed) !== String(clientId)) {
    res.status(403).json({ ok: false, message: "clientId does not match authenticated tenant." });
    return null;
  }
  return clientId;
}

export async function partnerListCampaignsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;

    const query = partnerCampaignListQuerySchema.parse(req.query ?? {});
    const payload = await partnerCampaigns.listCampaigns(clientId, query);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}

export async function partnerGetCampaignHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;

    const params = partnerCampaignParamsSchema.parse(req.params);
    const payload = await partnerCampaigns.getCampaign(clientId, params.id);
    res.json(ok(payload));
  } catch (error) {
    next(error);
  }
}
