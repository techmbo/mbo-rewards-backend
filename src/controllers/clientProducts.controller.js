import { sendClientBoundaryJson } from "../modules/client/clientBoundaryResponse.js";
import { ClientProductService } from "../modules/product/productFeed.service.js";

const clientProducts = new ClientProductService();

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

export async function clientListProductsHandler(req, res, next) {
  try {
    const clientId = requirePartnerClient(req, res);
    if (!clientId) return;
    const payload = await clientProducts.listClientProducts(clientId, req.query ?? {});
    sendClientBoundaryJson(res, payload, { surface: "products" });
  } catch (error) {
    next(error);
  }
}
