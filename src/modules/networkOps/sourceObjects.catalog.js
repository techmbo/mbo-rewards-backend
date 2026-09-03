/**
 * Source-object catalog — a network is not one API.
 * Each object is a separate sync unit. live=true only when an adapter/job already fetches it.
 * Declared-but-not-live objects stay in the catalog; we never invent their payloads.
 */
import { resolveSequenceRank } from "./networkIntegrationSequence.js";

export const SOURCE_OBJECT_AVAILABILITY = Object.freeze({
  LIVE: "LIVE",
  DECLARED: "DECLARED",
});

function obj({
  sourceObject,
  label,
  endpoint,
  live,
  entityType = null,
  notes = null,
  sequenceRank = null,
}) {
  const rank = sequenceRank ?? resolveSequenceRank(sourceObject, entityType);
  return Object.freeze({
    sourceObject,
    label,
    endpoint,
    live: Boolean(live),
    availability: live ? SOURCE_OBJECT_AVAILABILITY.LIVE : SOURCE_OBJECT_AVAILABILITY.DECLARED,
    entityType,
    notes,
    sequenceRank: rank,
  });
}

const CATALOG = Object.freeze({
  optimise: Object.freeze([
    obj({ sourceObject: "campaigns", label: "Campaigns", endpoint: "GET /campaigns", live: true, entityType: "campaign" }),
    obj({ sourceObject: "voucher_codes", label: "Voucher Codes", endpoint: "GET /vouchercodes", live: true, entityType: "coupon" }),
    obj({ sourceObject: "conversions", label: "Conversions", endpoint: "GET /conversions", live: true, entityType: "conversion" }),
    obj({
      sourceObject: "basket_items",
      label: "Basket Items",
      endpoint: "GET /conversions (basket items)",
      live: false,
      entityType: "conversion_item",
      notes: "Declared Optimise object. No isolated adapter fetch yet.",
    }),
    obj({ sourceObject: "payment_overview", label: "Payment Overview", endpoint: "GET /payments", live: true, entityType: "payment" }),
    obj({ sourceObject: "products", label: "Products", endpoint: "product feed", live: true, entityType: "product" }),
    obj({ sourceObject: "reporting", label: "Reporting", endpoint: "POST /reporting/", live: true, entityType: "performance" }),
    obj({ sourceObject: "invoices", label: "Invoices", endpoint: "GET /invoices", live: true, entityType: "payment" }),
  ]),
  impact: Object.freeze([
    obj({ sourceObject: "programs", label: "Programs", endpoint: "GET /Catalogs", live: true, entityType: "campaign" }),
    obj({ sourceObject: "actions", label: "Actions", endpoint: "GET /Actions", live: true, entityType: "conversion" }),
    obj({
      sourceObject: "action_updates",
      label: "Action Updates",
      endpoint: "GET /Actions (updates)",
      live: false,
      notes: "Declared Impact object. Not fetched as its own run yet.",
    }),
    obj({
      sourceObject: "action_items",
      label: "Action Items",
      endpoint: "GET /ActionUpdates/Items",
      live: false,
      entityType: "conversion_item",
    }),
    obj({ sourceObject: "catalogs", label: "Catalogs", endpoint: "GET /Catalogs/Items", live: true, entityType: "product" }),
    obj({ sourceObject: "reports", label: "Reports", endpoint: "derived /Actions performance", live: true, entityType: "performance" }),
  ]),
  partnerize: Object.freeze([
    obj({ sourceObject: "campaigns", label: "Campaigns", endpoint: "GET campaigns", live: true, entityType: "campaign" }),
    obj({ sourceObject: "conversions", label: "Conversions", endpoint: "GET conversions", live: true, entityType: "conversion" }),
    obj({
      sourceObject: "conversion_items",
      label: "Conversion Items",
      endpoint: "GET conversion items",
      live: false,
      entityType: "conversion_item",
    }),
    obj({ sourceObject: "analytics", label: "Analytics", endpoint: "derived conversion performance", live: true, entityType: "performance" }),
    obj({ sourceObject: "payment_information", label: "Payment Information", endpoint: "GET payments", live: true, entityType: "payment" }),
  ]),
  awin: Object.freeze([
    obj({ sourceObject: "programmes", label: "Programmes", endpoint: "GET programmes", live: true, entityType: "campaign" }),
    obj({ sourceObject: "offers", label: "Offers", endpoint: "GET offers / coupons", live: true, entityType: "coupon" }),
    obj({ sourceObject: "transactions", label: "Transactions", endpoint: "GET transactions", live: true, entityType: "conversion" }),
    obj({
      sourceObject: "product_feeds",
      label: "Product Feeds",
      endpoint: "GET product feeds",
      live: false,
      entityType: "product",
    }),
  ]),
  admitad: Object.freeze([
    obj({ sourceObject: "programs", label: "Programs", endpoint: "GET /advcampaigns/", live: true, entityType: "campaign" }),
    obj({ sourceObject: "coupons", label: "Coupons", endpoint: "GET /coupons/", live: true, entityType: "coupon" }),
    obj({ sourceObject: "actions", label: "Actions", endpoint: "GET /statistics/actions/", live: true, entityType: "conversion" }),
    obj({
      sourceObject: "product_feeds",
      label: "Product Feeds",
      endpoint: "product feeds",
      live: false,
      entityType: "product",
      notes: "Product feed remains declared until a live publisher CSV/XML fixture is captured.",
    }),
  ]),
  cj: Object.freeze([
    obj({ sourceObject: "advertisers", label: "Advertisers", endpoint: "advertisers", live: false, entityType: "campaign" }),
    obj({ sourceObject: "links", label: "Links", endpoint: "links", live: false, entityType: "link" }),
    obj({ sourceObject: "products", label: "Products", endpoint: "products", live: false, entityType: "product" }),
    obj({ sourceObject: "commission_detail", label: "Commission Detail", endpoint: "commission detail", live: false, entityType: "conversion" }),
  ]),
  rakuten: Object.freeze([
    obj({ sourceObject: "advertisers", label: "Advertisers", endpoint: "advertisers", live: false, entityType: "campaign" }),
    obj({ sourceObject: "offers", label: "Offers", endpoint: "offers", live: false, entityType: "coupon" }),
    obj({ sourceObject: "products", label: "Products", endpoint: "products", live: false, entityType: "product" }),
    obj({ sourceObject: "links", label: "Links", endpoint: "links", live: false, entityType: "link" }),
    obj({ sourceObject: "events", label: "Events", endpoint: "events", live: false, entityType: "conversion" }),
    obj({ sourceObject: "advanced_reports", label: "Advanced Reports", endpoint: "advanced reports", live: false, entityType: "performance" }),
  ]),
  trackier: Object.freeze([
    obj({ sourceObject: "campaigns", label: "Campaigns", endpoint: "GET /v2/publisher/campaigns", live: true, entityType: "campaign" }),
    obj({ sourceObject: "conversions", label: "Conversions", endpoint: "GET /v2/publishers/conversions", live: true, entityType: "conversion" }),
    obj({ sourceObject: "tracking", label: "Tracking", endpoint: "GET /v2/publishers/reports", live: true, entityType: "performance" }),
    obj({
      sourceObject: "finance",
      label: "Finance",
      endpoint: "publisher finance",
      live: false,
      entityType: "payment",
      notes: "No Trackier payments endpoint on the live publisher contract.",
    }),
    obj({ sourceObject: "coupons", label: "Coupons", endpoint: "GET /v2/publishers/coupons", live: true, entityType: "coupon" }),
  ]),
  boostiny: Object.freeze([
    obj({ sourceObject: "campaigns", label: "Campaigns", endpoint: "GET campaigns", live: true, entityType: "campaign" }),
    obj({ sourceObject: "api_reports", label: "API / report data", endpoint: "GET performance reports", live: true, entityType: "performance" }),
    obj({ sourceObject: "coupons", label: "Coupons", endpoint: "GET coupons", live: true, entityType: "coupon" }),
    obj({ sourceObject: "link_reports", label: "Link reports", endpoint: "GET link performance", live: true, entityType: "link" }),
    obj({
      sourceObject: "settlement",
      label: "Final settlement",
      endpoint: "account settlement source",
      live: false,
      entityType: "payment",
      notes: "Only sync when a settlement source is validated for the account.",
    }),
  ]),
});

export function networkFamily(network) {
  const n = String(network || "").toLowerCase();
  if (n.startsWith("optimise")) return "optimise";
  if (n === "vcommission") return "trackier";
  return n;
}

export function listSourceObjectCatalog(network) {
  const family = networkFamily(network);
  return CATALOG[family] ? [...CATALOG[family]] : [];
}

export function getSourceObject(network, sourceObject) {
  const key = String(sourceObject || "").toLowerCase();
  return listSourceObjectCatalog(network).find((item) => item.sourceObject === key) || null;
}

export function listCatalogNetworks() {
  return Object.keys(CATALOG);
}

export function defaultEndpointFor(network, sourceObject) {
  return getSourceObject(network, sourceObject)?.endpoint || String(sourceObject || "");
}
