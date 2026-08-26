export const DOMAIN_EVENTS = {
  ENTITY_INGESTED: "EntityIngested",
  SUPPLIER_CAMPAIGN_CREATED: "SupplierCampaignCreated",
  SUPPLIER_CAMPAIGN_UPDATED: "SupplierCampaignUpdated",
  SUPPLIER_CAMPAIGN_ARCHIVED: "SupplierCampaignArchived",
  SUPPLIER_COUPON_CREATED: "SupplierCouponCreated",
  SUPPLIER_COUPON_UPDATED: "SupplierCouponUpdated",
  MAPPER_FAILED: "MapperFailed",
  EVENT_OUTBOX_CREATED: "EventOutboxCreated",
};

export function buildEventId(...parts) {
  const list = parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts;
  return list.filter(Boolean).join(":");
}
