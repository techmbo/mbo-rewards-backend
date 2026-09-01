import { CLIENT_BOUNDARY_FORBIDDEN_KEYS, assertClientSafeNetworkOpsKeys } from "../../client/clientBoundary.contract.js";
import { ClientModelLeakError } from "./errors.js";

export const CLIENT_SAFE_FORBIDDEN_KEYS = Object.freeze([...CLIENT_BOUNDARY_FORBIDDEN_KEYS]);

const FORBIDDEN_KEY_SET = new Set(CLIENT_SAFE_FORBIDDEN_KEYS.map((k) => String(k).toLowerCase()));

function collectForbiddenKeys(value, found = new Set(), depth = 0) {
  if (value == null || typeof value !== "object" || depth > 6) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenKeys(item, found, depth + 1);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY_SET.has(String(key).toLowerCase())) found.add(key);
    collectForbiddenKeys(child, found, depth + 1);
  }
  return found;
}

export function assertClientSafeMboModel(model, { sourceResponse = null } = {}) {
  if (model == null || typeof model !== "object") {
    throw new ClientModelLeakError("Client model is missing");
  }
  if (sourceResponse && model === sourceResponse) {
    throw new ClientModelLeakError("Client model is the network source response");
  }
  try {
    assertClientSafeNetworkOpsKeys(model, {
      surface: "ingest",
      message: "Client model contains network or internal keys",
    });
  } catch (err) {
    throw new ClientModelLeakError(err.message, { keys: err.keys });
  }
  const leaked = [...collectForbiddenKeys(model)];
  if (leaked.length) {
    throw new ClientModelLeakError("Client model contains network or internal keys", { keys: leaked });
  }
  return model;
}

/**
 * Project a canonical MBO object into a client-safe model.
 * Never copies the source payload through.
 */
export function toClientSafeMboModel(canonical, { entityType = "campaign", sourceResponse = null } = {}) {
  if (!canonical || typeof canonical !== "object") {
    throw new ClientModelLeakError("Canonical object is required before exposing a client model");
  }
  if (sourceResponse && canonical === sourceResponse) {
    throw new ClientModelLeakError("Cannot expose the network source response as the client model");
  }

  const type = String(entityType || "").toLowerCase();
  let model;

  if (type === "conversion" || type === "order") {
    model = {
      orderId: canonical.orderId ?? canonical.id ?? null,
      status: canonical.status ?? canonical.legacyConversionStatus ?? null,
      orderValue: canonical.orderValue ?? null,
      currency: canonical.currency ?? null,
      orderDate: canonical.orderDate ?? canonical.conversionDate ?? null,
      campaignName: canonical.campaignName ?? null,
      brandName: canonical.brandName ?? canonical.merchantNameRaw ?? null,
      couponCode: canonical.couponCode ?? null,
    };
  } else if (type === "coupon") {
    model = {
      couponCode: canonical.couponCode ?? null,
      campaignName: canonical.campaignName ?? null,
      brandName: canonical.brandName ?? canonical.merchantNameRaw ?? null,
      couponStatus: canonical.couponStatus ?? null,
      startDate: canonical.startDate ?? canonical.validFrom ?? null,
      endDate: canonical.endDate ?? canonical.validUntil ?? null,
    };
  } else {
    model = {
      campaignName: canonical.campaignName ?? null,
      brandName: canonical.brandName ?? canonical.merchantNameRaw ?? null,
      campaignStatus: canonical.campaignStatus ?? null,
      campaignDescription: canonical.campaignDescription ?? null,
      country: canonical.country ?? canonical.countryCodes ?? null,
      currency: canonical.currency ?? canonical.commissionCurrency ?? null,
      categoryName: canonical.categoryName ?? null,
    };
  }

  return assertClientSafeMboModel(model, { sourceResponse });
}
