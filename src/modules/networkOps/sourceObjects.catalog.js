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
    obj({
      sourceObject: "commission_groups",
      label: "Commission Groups",
      endpoint: "GET /campaigns/{campaignId}/commission-groups",
      live: true,
      entityType: "commission_group",
      notes:
        "Campaign-scoped detailed supplier commission structure (one request per applicable campaign). Feeds SupplierCommissionRule[] / SupplierCommissionCondition[]; campaign commissionCost stays summary evidence.",
    }),
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
    obj({
      sourceObject: "advertisers",
      label: "Advertisers",
      endpoint: "GET https://advertiser-lookup.api.cj.com/v2/advertiser-lookup",
      live: true,
      entityType: "campaign",
      notes: "Publisher Advertiser Lookup REST/XML. Default Program Term commission values are discovery/display evidence only, not payable commission truth.",
    }),
    obj({
      sourceObject: "links",
      label: "Links",
      endpoint: "GET https://link-search.api.cj.com/v2/link-search",
      live: true,
      entityType: "link",
      notes: "Publisher Link Search REST/XML. Tracking URL and link commission strings remain source/display evidence.",
    }),
    obj({
      sourceObject: "coupons",
      label: "Coupons",
      endpoint: "GET https://link-search.api.cj.com/v2/link-search?promotion-type=coupon",
      live: true,
      entityType: "coupon",
      notes: "Coupon rows are a filtered Link Search projection and inherit the advertiser-id parent campaign identity.",
    }),
    obj({
      sourceObject: "program_terms",
      label: "Program Terms",
      endpoint: "CJ Publisher Program Terms GraphQL (endpoint to verify in connected account)",
      live: false,
      entityType: "commission_rule",
      notes: "Schema is documented and mapper is implemented. Keep transport DECLARED until the live endpoint/root query is verified with the connected publisher account.",
    }),
    obj({
      sourceObject: "products",
      label: "Products",
      endpoint: "POST https://ads.api.cj.com/query (Product Search GraphQL)",
      live: false,
      entityType: "product",
      notes: "CJ Product Search GraphQL is documented but remains gated until the connected publisher contract/fixture is verified.",
    }),
    obj({
      sourceObject: "commission_detail",
      label: "Commission Detail",
      endpoint: "POST https://commissions.api.cj.com/query (GraphQL)",
      live: false,
      entityType: "conversion",
      notes: "Do not enable conversion or finance ingestion until the connected publisher GraphQL schema and a real response fixture are captured.",
    }),
  ]),
  rakuten: Object.freeze([
    obj({ sourceObject: "advertisers", label: "Advertisers", endpoint: "GET /v2/advertisers", live: true, entityType: "campaign" }),
    obj({ sourceObject: "partnerships", label: "Partnerships", endpoint: "GET /v1/partnerships", live: true, entityType: "partnership" }),
    obj({ sourceObject: "offers", label: "Offers", endpoint: "GET /v1/offers", live: true, entityType: "offer" }),
    obj({ sourceObject: "commissioning_lists", label: "Commissioning Lists", endpoint: "GET /v1/commissioninglists", live: true, entityType: "commission_rule" }),
    obj({
      sourceObject: "coupons",
      label: "Coupons",
      endpoint: "Coupon API (XML)",
      live: false,
      entityType: "coupon",
      notes: "Rakuten coupon ingestion remains declared until the XML parser/fixture is wired.",
    }),
    obj({
      sourceObject: "products",
      label: "Products",
      endpoint: "Product Search (XML)",
      live: false,
      entityType: "product",
      notes: "Rakuten Product Search is XML-only; no JSON shape is invented here.",
    }),
    obj({
      sourceObject: "links",
      label: "Links",
      endpoint: "Link Locator / Deep Link",
      live: false,
      entityType: "link",
      notes: "Rakuten link XML handling remains declared until the XML ingestion path is wired.",
    }),
    obj({ sourceObject: "events", label: "Events", endpoint: "GET /events/1.0/transactions", live: true, entityType: "conversion" }),
    obj({ sourceObject: "advanced_reports", label: "Advanced Reports", endpoint: "GET /advancedreports/1.0", live: true, entityType: "payment" }),
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
