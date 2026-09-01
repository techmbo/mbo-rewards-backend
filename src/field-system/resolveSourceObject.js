/**
 * Resolve pointer-3 source_object key for schema registry identity.
 */
export function resolveSourceObjectKey({
  sourceObject = null,
  entityType = null,
  resourceKey = null,
} = {}) {
  if (sourceObject) return String(sourceObject).trim().toLowerCase();
  if (resourceKey) return String(resourceKey).trim().toLowerCase();
  const type = String(entityType ?? "unknown").trim().toLowerCase();
  const map = {
    campaign: "campaigns",
    coupon: "coupons",
    conversion: "conversions",
    payment: "payments",
    invoice: "invoices",
    product: "products",
    click: "clicks",
    reporting: "reporting",
    performance: "reporting",
    link: "links",
  };
  return map[type] || type || "unknown";
}

export function normalizeRegistryNetwork(networkSource) {
  return String(networkSource || "").trim().toLowerCase();
}
