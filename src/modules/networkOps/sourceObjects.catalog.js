/**
 * Source-object catalog — a network is not one API.
 * Each object is a separate sync unit. live=true only when an adapter/job already fetches it.
 * Declared-but-not-live objects stay in the catalog; we never invent their payloads.
 */
import { resolveSequenceRank } from "./networkIntegrationSequence.js";

export const SOURCE_OBJECT_AVAILABILITY = Object.freeze({
  LIVE: "LIVE",
  DECLARED: "DECLARED",
  /**
   * An adapter call EXISTS and the supplier refuses it for this account — proven live, not
   * assumed. Distinct from DECLARED, which means no fetch was ever built, and from LIVE with zero
   * rows, which means the endpoint answered and the account simply had nothing in the window.
   */
  UNAVAILABLE: "NOT_SUPPORTED_OR_UNAVAILABLE_FOR_CURRENT_ACCOUNT",
  /** No endpoint of this kind exists in the integration at all. */
  NO_ENDPOINT: "NO_ENDPOINT_IN_INTEGRATION",
  /**
   * No endpoint exists AND an implemented non-API path does. NO_ENDPOINT alone would be true but
   * misleading here: it reads as "nothing ingests this", when a manual upload already does. The
   * object is not syncable and not missing — it arrives by another route.
   */
  MANUAL: "MANUAL_ONLY_NO_ENDPOINT_IN_INTEGRATION",
  /**
   * A fetcher EXISTS and nothing calls it. Distinct from DECLARED, where no fetch was ever built,
   * and from LIVE, which would claim an ingest that does not run. The code is there; the wiring,
   * the mapping and the certification are not.
   */
  IMPLEMENTED_NOT_INGESTED: "IMPLEMENTED_NOT_INGESTED",
});

function obj({
  sourceObject,
  label,
  endpoint,
  live,
  entityType = null,
  notes = null,
  sequenceRank = null,
  // Set only where live evidence contradicts the default LIVE/DECLARED split. Never inferred.
  availability = null,
  liveEvidence = null,
}) {
  const rank = sequenceRank ?? resolveSequenceRank(sourceObject, entityType);
  return Object.freeze({
    sourceObject,
    label,
    endpoint,
    live: Boolean(live),
    availability:
      availability ??
      (live ? SOURCE_OBJECT_AVAILABILITY.LIVE : SOURCE_OBJECT_AVAILABILITY.DECLARED),
    entityType,
    notes,
    liveEvidence,
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
    // live:false, but NOT "declared and never built": the adapter builds and calls this path. The
    // supplier answers 404 for this account, proven by a bounded live certification probe. Marking
    // it LIVE claimed an ingest that has silently returned nothing for as long as it has existed.
    obj({
      sourceObject: "payment_information",
      label: "Payment Information",
      endpoint: "GET /reporting/report_publisher/publisher/{publisherId}/payment.json",
      live: false,
      availability: SOURCE_OBJECT_AVAILABILITY.UNAVAILABLE,
      liveEvidence: "HTTP 404 / NOT_FOUND on a bounded 7d certification probe",
      entityType: "payment",
      notes:
        "Supplier returns 404 for this publisher account. No alternative payment or settlement " +
        "endpoint is evidenced anywhere in the integration, and no Partnerize invoice endpoint " +
        "exists. Schema is UNKNOWN_NO_ACCESSIBLE_SOURCE — not merely empty.",
    }),
    // MAPPING_ONLY, and deliberately distinct from payment_information's UNAVAILABLE: there the
    // adapter builds and calls a path and the supplier refuses it. Here there is no path at all.
    // A products mapping file is not supplier capability, and this entry exists so the mapping
    // cannot be mistaken for one.
    obj({
      sourceObject: "products",
      label: "Products",
      endpoint: "none — no product endpoint exists in this integration",
      live: false,
      availability: SOURCE_OBJECT_AVAILABILITY.NO_ENDPOINT,
      entityType: "product",
      notes:
        "Mapping file src/network-mappings/partnerize/products.mapping.json exists, but no fetch " +
        "endpoint or fetcher is implemented or evidenced. The adapter builds no product, feed, " +
        "catalog or item path, has no fetchProducts, and no feed URL, campaign-scoped product " +
        "path or separate API generation is evidenced. Not certifiable without inventing an " +
        "endpoint: UNKNOWN_NEEDS_LIVE_VERIFICATION.",
    }),
  ]),
  awin: Object.freeze([
    obj({ sourceObject: "programmes", label: "Programmes", endpoint: "GET programmes", live: true, entityType: "campaign" }),
    obj({ sourceObject: "offers", label: "Offers", endpoint: "GET offers / coupons", live: true, entityType: "coupon" }),
    obj({ sourceObject: "transactions", label: "Transactions", endpoint: "GET transactions", live: true, entityType: "conversion" }),
    // NOT live, and deliberately not marked so until certification returns a row. fetchCommissionGroups
    // is implemented and correct, but nothing calls it: syncAwinAccount has no commission step, no
    // Awin commission-group mapper exists, and nothing reaches SupplierCommissionRule. A bounded
    // certification probe is registered; its result is what would justify changing this entry.
    obj({
      sourceObject: "commission_groups",
      label: "Commission Groups",
      endpoint: "GET /publishers/{publisherId}/commissiongroups",
      live: false,
      availability: SOURCE_OBJECT_AVAILABILITY.IMPLEMENTED_NOT_INGESTED,
      entityType: "commission_rule",
      notes:
        "Advertiser-scoped: requires an advertiserId, discovered from a bounded campaigns sample " +
        "and never supplied by a caller. Implemented in the adapter but not wired into sync, not " +
        "mapped, and not written to SupplierCommissionRule. Awin publisher commission is network " +
        "economics; client commission stays derived by MBO commercial rules. Schema is " +
        "UNKNOWN_NEEDS_LIVE_DATA until a row is certified.",
    }),
    // live:false was already correct, but silent about WHY. There is no feed endpoint, no fetcher
    // and not even a src/network-mappings/awin directory — so this is weaker than Partnerize
    // products, which at least has a mapping file. Nothing to certify without inventing a path.
    obj({
      sourceObject: "product_feeds",
      label: "Product Feeds",
      endpoint: "none — no product feed endpoint exists in this integration",
      live: false,
      availability: SOURCE_OBJECT_AVAILABILITY.NO_ENDPOINT,
      entityType: "product",
      notes:
        "No product, feed, catalog or datafeed path is built in the Awin adapter, no fetchProducts " +
        "exists, and no Awin mapping files exist. The PRODUCTS capability that claimed otherwise " +
        "has been removed from both the adapter and the registry. Basket lines returned by " +
        "showBasketProducts on the transactions request are ORDER_ITEMS inside a conversion, not " +
        "a product feed.",
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
      // LIVE because a fetch now exists: fetchCoupons reads GET /coupon/1.0 and parses the
      // documented couponfeed envelope. That is implementation truth and nothing more — it is not
      // a claim that this account has coupon rows, and it is not an ingestion path.
      sourceObject: "coupons",
      label: "Coupons",
      endpoint: "GET /coupon/1.0",
      live: true,
      entityType: "coupon",
      notes:
        "Read path only: fetchCoupons parses the couponfeed XML, but no canonical Coupon is persisted, no clickurl becomes a TrackingLink, and no sync job calls it. Rows have not yet been observed live.",
    }),
    obj({
      // LIVE because a fetch now exists: fetchProducts reads GET /productsearch/1.0 and parses the
      // documented <result>/<item> envelope. Implementation truth only — not a claim that this
      // account has product rows, not an ingestion path, and NOT evidence of a bulk product feed.
      sourceObject: "products",
      label: "Products",
      endpoint: "GET /productsearch/1.0",
      live: true,
      entityType: "product",
      notes:
        "Search read path only: fetchProducts parses the Product Search XML, but nothing is persisted from it, no linkurl becomes a tracking link, and no sync job calls it. A search surface is not a product feed. Rows have not yet been observed live, and whether Rakuten accepts an unfiltered search is not yet established.",
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
    // MANUAL, not merely not-live. The Boostiny adapter builds four paths — campaigns, coupons,
    // performance, link-performance — and none is a payment, payout, settlement or invoice path.
    // Settlement is real and implemented, just not over the API.
    obj({
      sourceObject: "settlement",
      label: "Final settlement",
      endpoint: "none — Partner Payment CSV upload, no settlement endpoint in this integration",
      live: false,
      availability: SOURCE_OBJECT_AVAILABILITY.MANUAL,
      entityType: "payment",
      notes:
        "Final settlement arrives as a Partner Payment CSV through " +
        "BoostinyPartnerPaymentService.uploadCsv(), at PAYMENT_SOURCE_CYCLE granularity — never " +
        "as individual orders. No payment, payout, settlement or invoice endpoint exists in the " +
        "adapter, and no fetchPayments exists; the registry PAYMENTS capability that implied one " +
        "has been removed. Only sync when a settlement source is validated for the account.",
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
