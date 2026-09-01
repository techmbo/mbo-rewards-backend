/**
 * Pointer 24 — Recommended network integration sequence (no catalog/mapping imports).
 */
import { MBO_CANONICAL_OBJECT } from "../mapping/mboCanonicalObjects.contract.js";

export const NETWORK_INTEGRATION_OBJECT_SEQUENCE = Object.freeze([
  {
    stage: "campaigns",
    rank: 1,
    label: "Campaigns",
    mboTargetObject: MBO_CANONICAL_OBJECT.NETWORK_CAMPAIGN,
    patterns: ["campaigns", "programs", "programmes", "advertisers"],
  },
  {
    stage: "commission_rules",
    rank: 2,
    label: "Commission Rules",
    mboTargetObject: MBO_CANONICAL_OBJECT.SUPPLIER_COMMISSION_RULE,
    patterns: ["commission"],
  },
  {
    stage: "coupons",
    rank: 3,
    label: "Coupons",
    mboTargetObject: MBO_CANONICAL_OBJECT.COUPON_VOUCHER,
    patterns: ["coupon", "coupons", "voucher", "voucher_codes", "offers"],
  },
  {
    stage: "tracking_links",
    rank: 4,
    label: "Tracking Links",
    mboTargetObject: MBO_CANONICAL_OBJECT.TRACKING_LINK,
    patterns: ["link", "links", "tracking", "link_reports"],
  },
  {
    stage: "offers_products",
    rank: 5,
    label: "Offers / Products",
    mboTargetObject: MBO_CANONICAL_OBJECT.PRODUCT,
    patterns: ["product", "products", "catalogs", "catalog", "product_feeds", "feed"],
  },
  {
    stage: "conversions_orders",
    rank: 6,
    label: "Conversions / Orders",
    mboTargetObject: MBO_CANONICAL_OBJECT.ORDER_CONVERSION,
    patterns: ["conversion", "conversions", "actions", "transactions", "events", "commission_detail"],
  },
  {
    stage: "order_items",
    rank: 7,
    label: "Order Items",
    mboTargetObject: MBO_CANONICAL_OBJECT.ORDER_ITEM,
    patterns: ["item", "items", "basket"],
  },
  {
    stage: "performance",
    rank: 8,
    label: "Performance",
    mboTargetObject: MBO_CANONICAL_OBJECT.PERFORMANCE_RECORD,
    patterns: ["report", "reporting", "analytics", "performance", "api_reports", "advanced_reports"],
  },
  {
    stage: "finance",
    rank: 9,
    label: "Finance",
    mboTargetObject: MBO_CANONICAL_OBJECT.NETWORK_PAYMENT,
    patterns: ["payment", "payments", "invoice", "invoices", "settlement", "finance", "billing"],
  },
]);

const ENTITY_TYPE_SEQUENCE_RANK = Object.freeze({
  campaign: 1,
  coupon: 3,
  link: 4,
  product: 5,
  conversion: 6,
  conversion_item: 7,
  performance: 8,
  payment: 9,
});

export function resolveSequenceRank(sourceObject, entityType = null) {
  const key = String(sourceObject || "").toLowerCase();
  for (const stage of NETWORK_INTEGRATION_OBJECT_SEQUENCE) {
    if (stage.patterns.some((pattern) => key === pattern || key.includes(pattern))) {
      return stage.rank;
    }
  }
  if (entityType && ENTITY_TYPE_SEQUENCE_RANK[entityType] != null) {
    return ENTITY_TYPE_SEQUENCE_RANK[entityType];
  }
  return null;
}

export function resolveSequenceStage(sourceObject, entityType = null) {
  const rank = resolveSequenceRank(sourceObject, entityType);
  if (rank == null) return null;
  return NETWORK_INTEGRATION_OBJECT_SEQUENCE.find((s) => s.rank === rank) || null;
}
