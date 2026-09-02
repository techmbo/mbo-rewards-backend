/**
 * Wave C merge policy for Order / OrderItem updates:
 * - Never overwrite a known non-null value with null/undefined.
 * - Explicit supplier null: pass `{ forceNull: true }` on a field (rare).
 * - Arrays/objects: shallow-merge metadata; do not replace with empty {}.
 */

export function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

export function mergeScalar(existing, incoming, { forceNull = false } = {}) {
  if (forceNull) return null;
  if (!isPresent(incoming)) return existing ?? null;
  return incoming;
}

export function mergeMetadata(existing, incoming) {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const next = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : {};
  return { ...base, ...next };
}

/**
 * Build patch for Order upsert — only fields with present incoming values (or forceNull).
 */
export function buildOrderPatch(existing, incoming = {}) {
  const patch = {};
  const fields = [
    "clientId",
    "merchantId",
    "canonicalCampaignId",
    "campaignSourceId",
    "clientAssignmentId",
    "clickId",
    "orderValue",
    "currency",
    "orderDate",
    "rawPayloadId",
  ];

  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
    if (!isPresent(incoming[field])) continue; // never overwrite with null/empty
    if (String(incoming[field]) !== String(existing?.[field] ?? "")) {
      patch[field] = incoming[field];
    }
  }

  if (incoming.metadata != null) {
    patch.metadata = mergeMetadata(existing?.metadata, incoming.metadata);
  }

  return patch;
}

export function resolveSupplierOrderId({ supplierOrderId, supplierConversionId }) {
  if (isPresent(supplierOrderId)) return String(supplierOrderId);
  if (isPresent(supplierConversionId)) return `conv:${supplierConversionId}`;
  return null;
}

import { resolveOrderStatusFromNetworkRaw } from "./orderStatusNormalization.contract.js";

/**
 * Bridge only for the platform's legacy/internal conversion state.
 *
 * This is deliberately NOT a network-status mapper. Payment lifecycle words such as
 * PAID / INVOICED / PAYABLE / AVAILABLE / WITHDRAWN must never confirm an order here.
 * Raw supplier statuses must use the source-scoped status-normalization contract.
 */
export function mapConversionStatusToValidation(status) {
  const value = String(status || "").trim().toUpperCase();
  if (!value) return null;

  if (value === "APPROVED" || value === "CONFIRMED") return "VALIDATION_APPROVED";
  if (value === "REJECTED") return "VALIDATION_REJECTED";
  if (value === "PENDING") return "VALIDATION_PENDING";
  if (value === "UNKNOWN") return "VALIDATION_NEEDS_REVIEW";

  // Fail closed for anything outside the explicit internal vocabulary.
  return "VALIDATION_NEEDS_REVIEW";
}

export function mapConversionStatusToSupplierPayment(status) {
  // Pointer 17 — network payment evidence must not auto-set supplier RECEIVED.
  // Contextless supplier/network tokens cannot be trusted for payment transitions.
  const resolved = resolveOrderStatusFromNetworkRaw(status);
  if (resolved.mboOrderStatus === "REJECTED" || resolved.mboOrderStatus === "CANCELLED") {
    return "PAYMENT_ON_HOLD";
  }
  return null;
}

export function mapLegacyConversionStatus(validationStatus) {
  if (validationStatus === "VALIDATION_REJECTED") return "REJECTED";
  if (validationStatus === "VALIDATION_APPROVED") return "CONFIRMED";
  if (validationStatus === "VALIDATION_NEEDS_REVIEW") return null;
  return "PENDING";
}
