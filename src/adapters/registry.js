import { createBoostinyAdapter } from "./boostiny.adapter.js";
import { createOptimiseAdapter } from "./optimise.adapter.js";
import { createTrackierAdapter } from "./trackier.adapter.js";
import { createImpactAdapter } from "./impact.adapter.js";
import { createPartnerizeAdapter } from "./partnerize.adapter.js";
import { createAwinAdapter } from "./awin.adapter.js";
import { createAdmitadAdapter } from "./admitad.adapter.js";
import { createRakutenAdapter } from "./rakuten.adapter.js";
import { createCjAdapter } from "./cj.adapter.js";
import { assertAdapterContract, SUPPLIER_CAPABILITIES } from "./contract.js";

export const KNOWN_SUPPLIER_KEYS = Object.freeze([
  "IMPACT",
  "PARTNERIZE",
  "OPTIMISE",
  "TRACKIER",
  "BOOSTINY",
  "AWIN",
  "ADMITAD",
  "CJ",
  "RAKUTEN",
]);

export const SUPPLIER_CAPABILITY_CATALOG = Object.freeze({
  BOOSTINY: {
    implementationStatus: "IMPLEMENTED",
    // PAYMENTS removed: it is an API capability, and Boostiny exposes no payment, payout,
    // settlement or invoice endpoint — the adapter builds four paths, all campaigns/coupons/
    // performance. The note below already said settlement is a manual CSV; the capability
    // contradicted it, and the adapter's own getCapabilities() never claimed PAYMENTS.
    // Settlement is not lost, it is MANUAL: BoostinyPartnerPaymentService.uploadCsv() is the
    // implemented path, and it is untouched by this change.
    capabilities: [SUPPLIER_CAPABILITIES.CAMPAIGNS, SUPPLIER_CAPABILITIES.COUPONS, SUPPLIER_CAPABILITIES.REPORTING],
    pagination: "page",
    notes: ["Tracking params UNCONFIRMED — Wave A.", "Performance = provisional/mixed granularity (order_id required for order-level).", "Final settlement = Partner Payment CSV (MANUAL_UPLOAD), aggregate PAYMENT_SOURCE_CYCLE only — never fake individual orders.", "No payment/payout/settlement/invoice API capability: settlement arrives only via BoostinyPartnerPaymentService.uploadCsv()."],
  },
  OPTIMISE: {
    implementationStatus: "IMPLEMENTED",
    capabilities: [SUPPLIER_CAPABILITIES.CAMPAIGNS, SUPPLIER_CAPABILITIES.COUPONS, SUPPLIER_CAPABILITIES.CONVERSIONS, SUPPLIER_CAPABILITIES.PAYMENTS, SUPPLIER_CAPABILITIES.INVOICES, SUPPLIER_CAPABILITIES.REPORTING, SUPPLIER_CAPABILITIES.MULTI_CURRENCY, SUPPLIER_CAPABILITIES.TRACKING_SUBID],
    pagination: "page",
    notes: ["UID/UID2 confirmed; click-ref param UNCONFIRMED."],
  },
  TRACKIER: {
    implementationStatus: "IMPLEMENTED",
    capabilities: [SUPPLIER_CAPABILITIES.CAMPAIGNS, SUPPLIER_CAPABILITIES.COUPONS, SUPPLIER_CAPABILITIES.CONVERSIONS, SUPPLIER_CAPABILITIES.TRACKING_SUBID, SUPPLIER_CAPABILITIES.REPORTING],
    pagination: "page",
    notes: ["vCommission aliases to TRACKIER. No payments API."],
  },
  PARTNERIZE: {
    implementationStatus: "IMPLEMENTED",
    // PRODUCTS is deliberately absent. A products mapping file exists, but the adapter builds no
    // product, feed, catalog or item path and has no fetchProducts — so declaring the capability
    // claimed an ingest that cannot run. The adapter's own getCapabilities() always omitted it;
    // this entry was the one place that disagreed.
    capabilities: [SUPPLIER_CAPABILITIES.CAMPAIGNS, SUPPLIER_CAPABILITIES.COUPONS, SUPPLIER_CAPABILITIES.CONVERSIONS, SUPPLIER_CAPABILITIES.PAYMENTS, SUPPLIER_CAPABILITIES.TRACKING_SUBID, SUPPLIER_CAPABILITIES.REPORTING],
    pagination: "page",
    notes: ["v15 12F: adref/pubref/clickref CONFIRMED for injection.", "Products are MAPPING_ONLY: products.mapping.json exists, but no product feed endpoint, feed URL, campaign-scoped product path or fetcher is implemented or evidenced anywhere in this integration.", "Coupons via publisher campaign voucher endpoint.", "Performance Facts derived from conversions (no dedicated clicks report).", "PARTNERIZE_PRODUCTION_ECHO_UNVERIFIED until live conversion sample captured."],
  },
  IMPACT: {
    implementationStatus: "IMPLEMENTED",
    capabilities: [SUPPLIER_CAPABILITIES.CAMPAIGNS, SUPPLIER_CAPABILITIES.CONVERSIONS, SUPPLIER_CAPABILITIES.ADS, SUPPLIER_CAPABILITIES.DEEP_LINK, SUPPLIER_CAPABILITIES.ORDER_ITEMS, SUPPLIER_CAPABILITIES.VALIDATION_STATUS, SUPPLIER_CAPABILITIES.TRACKING_SUBID, SUPPLIER_CAPABILITIES.PRODUCTS, SUPPLIER_CAPABILITIES.PAYMENTS, SUPPLIER_CAPABILITIES.REPORTING],
    pagination: "page",
    notes: ["Publisher/MediaPartner role only.", "Full Product Feed deferred to Wave F — fetchProducts optional foundation.", "Performance Facts derived from Actions; /Reports catalog best-effort.", "COUPONS NOT_APPLICABLE — Promotions are deal content, not CouponCodeMaster voucher codes."],
  },
  AWIN: {
    implementationStatus: "IMPLEMENTED",
    // PRODUCTS removed here and in the adapter: no product feed endpoint or fetcher exists.
    // ORDER_ITEMS stays — basket lines inside a transaction are not a product feed.
    capabilities: [SUPPLIER_CAPABILITIES.CAMPAIGNS, SUPPLIER_CAPABILITIES.COUPONS, SUPPLIER_CAPABILITIES.CONVERSIONS, SUPPLIER_CAPABILITIES.DEEP_LINK, SUPPLIER_CAPABILITIES.ORDER_ITEMS, SUPPLIER_CAPABILITIES.TRACKING_SUBID, SUPPLIER_CAPABILITIES.REPORTING],
    pagination: "page",
    notes: ["OAuth2 Bearer; explicit publisherId → MarketplaceAccount required.", "Throttle 20 req/min/user.", "Transactions: <=31-day windows; poll transaction + validation + amendment dateTypes.", "ClickRef1–6 used for attribution injection.", "Product feeds are DECLARED_ONLY and now undeclared: no feed endpoint, fetcher or mapping exists in this integration."],
  },
  ADMITAD: {
    implementationStatus: "IMPLEMENTED",
    capabilities: [SUPPLIER_CAPABILITIES.CAMPAIGNS, SUPPLIER_CAPABILITIES.COUPONS, SUPPLIER_CAPABILITIES.CONVERSIONS, SUPPLIER_CAPABILITIES.DEEP_LINK, SUPPLIER_CAPABILITIES.TRACKING_SUBID, SUPPLIER_CAPABILITIES.REPORTING],
    pagination: "offset",
    notes: ["OAuth2 Bearer publisher API foundation implemented for websites, programmes, coupons and /statistics/actions/.", "Action status plus processed/paid are separate source facts; do not collapse payment evidence into order approval.", "status_updated windows are the incremental action-status path.", "Product CSV/XML feed ingestion remains gated on a live feed fixture."],
  },
  CJ: {
    implementationStatus: "IMPLEMENTED_DISCOVERY",
    capabilities: [SUPPLIER_CAPABILITIES.CAMPAIGNS, SUPPLIER_CAPABILITIES.COUPONS, SUPPLIER_CAPABILITIES.DEEP_LINK],
    pagination: "page",
    notes: ["Publisher Advertiser Lookup and Link Search REST/XML discovery are implemented.", "Personal Access Token Bearer authentication is required; legacy developer keys are deprecated.", "Advertiser Lookup default Program Term commissions are discovery/display facts only and are not payable commission truth.", "Commission Detail GraphQL remains VERIFY_LIVE until the connected publisher schema and a real fixture are captured.", "Product Search GraphQL is documented but remains gated until its live publisher contract is verified in this integration."],
  },
  RAKUTEN: {
    implementationStatus: "IMPLEMENTED_FOUNDATION",
    capabilities: [SUPPLIER_CAPABILITIES.CAMPAIGNS, SUPPLIER_CAPABILITIES.CONVERSIONS, SUPPLIER_CAPABILITIES.TRACKING_SUBID, SUPPLIER_CAPABILITIES.ORDER_ITEMS, SUPPLIER_CAPABILITIES.PAYMENTS, SUPPLIER_CAPABILITIES.REPORTING],
    pagination: "source_specific",
    notes: ["Advertisers, Partnerships, Offers, recent Events and Advanced Reports foundation are implemented.", "Events are directional recent transaction components and are not the sole historical/expected-commission ledger.", "Advanced Reports require a separate web security token and provide network payment evidence, never automatic MBO receipt evidence.", "Coupon, Product Search and Link Locator XML ingestion remains gated until the XML ingestion path is wired."],
  },
});

const FACTORIES = {
  BOOSTINY: createBoostinyAdapter,
  OPTIMISE: createOptimiseAdapter,
  TRACKIER: createTrackierAdapter,
  PARTNERIZE: createPartnerizeAdapter,
  IMPACT: createImpactAdapter,
  AWIN: createAwinAdapter,
  ADMITAD: createAdmitadAdapter,
  CJ: createCjAdapter,
  RAKUTEN: createRakutenAdapter,
};

export function normalizeSupplierKey(value) {
  if (!value) return null;
  const key = String(value).trim().toUpperCase();
  if (key === "VCOMMISSION") return "TRACKIER";
  if (key === "MEDIAPARTNER" || key === "IMPACT_COM") return "IMPACT";
  if (KNOWN_SUPPLIER_KEYS.includes(key)) return key;
  return null;
}

export function createSupplierAdapter(supplierKey, config = {}) {
  const key = normalizeSupplierKey(supplierKey);
  if (!key) {
    const err = new Error(`Unknown supplier: ${supplierKey}`);
    err.code = "UNKNOWN_SUPPLIER";
    throw err;
  }
  const factory = FACTORIES[key];
  if (!factory) {
    const err = new Error(`${key} adapter is not implemented yet`);
    err.code = "ADAPTER_NOT_IMPLEMENTED";
    err.supplierKey = key;
    err.implementationStatus = SUPPLIER_CAPABILITY_CATALOG[key]?.implementationStatus ?? "PLANNED";
    throw err;
  }
  const adapter = factory(config);
  if (!adapter.supplierKey) adapter.supplierKey = key;
  if (typeof adapter.getCapabilities !== "function") {
    const catalog = SUPPLIER_CAPABILITY_CATALOG[key];
    adapter.getCapabilities = () => ({ ...catalog });
  }
  assertAdapterContract(adapter);
  return adapter;
}

export function listRegisteredSuppliers() { return Object.keys(FACTORIES); }
export function listKnownSuppliers() { return [...KNOWN_SUPPLIER_KEYS]; }
export function getSupplierCapabilities(supplierKey) {
  const key = normalizeSupplierKey(supplierKey);
  return key ? SUPPLIER_CAPABILITY_CATALOG[key] ?? null : null;
}
export function isSupplierKnown(supplierKey) { return Boolean(normalizeSupplierKey(supplierKey)); }
export function isSupplierRegistered(supplierKey) {
  const key = normalizeSupplierKey(supplierKey);
  return Boolean(key && FACTORIES[key]);
}
