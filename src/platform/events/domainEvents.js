export const DOMAIN_EVENTS = {
  ENTITY_INGESTED: "EntityIngested",
  SUPPLIER_CAMPAIGN_PROMOTED: "SupplierCampaignPromoted",
  SUPPLIER_CAMPAIGN_CREATED: "SupplierCampaignCreated",
  SUPPLIER_CAMPAIGN_UPDATED: "SupplierCampaignUpdated",
  SUPPLIER_CAMPAIGN_ARCHIVED: "SupplierCampaignArchived",
  SUPPLIER_COUPON_CREATED: "SupplierCouponCreated",
  SUPPLIER_COUPON_UPDATED: "SupplierCouponUpdated",
  MERCHANT_MATCHED: "MerchantMatched",
  MERCHANT_MERGED: "MerchantMerged",
  MERCHANT_CREATED: "MerchantCreated",
  CATALOG_CREATED: "CatalogCreated",
  CAMPAIGN_ASSIGNED: "CampaignAssigned",
  ASSIGNMENT_PUBLISHED: "AssignmentPublished",
  TRACKING_GENERATED: "TrackingGenerated",
  COUPON_ACTIVATED: "CouponActivated",
  COMMISSION_RULE_ACTIVATED: "CommissionRuleActivated",
  CLICK_RECORDED: "ClickRecorded",
  CONVERSION_ATTRIBUTED: "ConversionAttributed",
  CONVERSION_IMPORTED: "ConversionImported",
  DAILY_REPORT_GENERATED: "DailyReportGenerated",
  AGGREGATION_COMPLETED: "AggregationCompleted",
  MAPPER_FAILED: "MapperFailed",
};

export const AUDIT_ACTIONS = {
  MERCHANT_CREATED: "MerchantCreated",
  MERCHANT_MERGED: "MerchantMerged",
  MERCHANT_MATCHING_RUN: "MerchantMatchingRun",
  CAMPAIGN_ASSIGNED: "CampaignAssigned",
  ASSIGNMENT_PUBLISHED: "AssignmentPublished",
  TRACKING_GENERATED: "TrackingGenerated",
  COUPON_ACTIVATED: "CouponActivated",
  COMMISSION_CHANGED: "CommissionChanged",
  CLICK_RECORDED: "ClickRecorded",
  CONVERSION_IMPORTED: "ConversionImported",
  PROMOTION_COMPLETED: "PromotionCompleted",
  AGGREGATION_COMPLETED: "AggregationCompleted",
};

export function buildEventId(parts) {
  return parts.filter(Boolean).join(":");
}
