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

export function mapConversionStatusToValidation(status) {
  const value = String(status || "").toUpperCase();
  if (value === "REJECTED") return "VALIDATION_REJECTED";
  if (value === "APPROVED" || value === "PAID") return "VALIDATION_APPROVED";
  if (value === "UNKNOWN") return "VALIDATION_NEEDS_REVIEW";
  return "VALIDATION_PENDING";
}

export function mapConversionStatusToSupplierPayment(status) {
  const value = String(status || "").toUpperCase();
  if (value === "PAID") return "PAYMENT_RECEIVED";
  if (value === "APPROVED") return "PAYMENT_PENDING";
  if (value === "REJECTED") return "PAYMENT_ON_HOLD";
  return "PAYMENT_PENDING";
}

export function mapLegacyConversionStatus(validationStatus) {
  if (validationStatus === "VALIDATION_REJECTED") return "REJECTED";
  if (validationStatus === "VALIDATION_APPROVED") return "APPROVED";
  if (validationStatus === "VALIDATION_NEEDS_REVIEW") return "UNKNOWN";
  return "PENDING";
}
