import { createBoostinyAdapter } from "./boostiny.adapter.js";
import { createOptimiseAdapter } from "./optimise.adapter.js";
import { createTrackierAdapter } from "./trackier.adapter.js";
import { createImpactAdapter } from "./impact.adapter.js";
import { createPartnerizeAdapter } from "./partnerize.adapter.js";
import { createAwinAdapter } from "./awin.adapter.js";
import { assertAdapterContract, SUPPLIER_CAPABILITIES } from "./contract.js";

/**
 * Static capability catalog (authoritative for ops / docs).
 * Live adapters may expose a subset based on credentials/config.
 */
export const SUPPLIER_CAPABILITY_CATALOG = Object.freeze({
  BOOSTINY: {
    capabilities: [
      SUPPLIER_CAPABILITIES.CAMPAIGNS,
      SUPPLIER_CAPABILITIES.COUPONS,
      SUPPLIER_CAPABILITIES.REPORTING,
      SUPPLIER_CAPABILITIES.PAYMENTS,
    ],
    pagination: "page",
    notes: [
      "Tracking params UNCONFIRMED — Wave A.",
      "Performance = provisional/mixed granularity (order_id required for order-level).",
      "Final settlement = Partner Payment CSV (MANUAL_UPLOAD), aggregate PAYMENT_SOURCE_CYCLE only — never fake individual orders.",
    ],
  },
  OPTIMISE: {
    capabilities: [
      SUPPLIER_CAPABILITIES.CAMPAIGNS,
      SUPPLIER_CAPABILITIES.COUPONS,
      SUPPLIER_CAPABILITIES.CONVERSIONS,
      SUPPLIER_CAPABILITIES.PAYMENTS,
      SUPPLIER_CAPABILITIES.INVOICES,
      SUPPLIER_CAPABILITIES.REPORTING,
      SUPPLIER_CAPABILITIES.MULTI_CURRENCY,
      SUPPLIER_CAPABILITIES.TRACKING_SUBID,
    ],
    pagination: "page",
    notes: ["UID/UID2 confirmed; click-ref param UNCONFIRMED."],
  },
  TRACKIER: {
    capabilities: [
      SUPPLIER_CAPABILITIES.CAMPAIGNS,
      SUPPLIER_CAPABILITIES.COUPONS,
      SUPPLIER_CAPABILITIES.CONVERSIONS,
      SUPPLIER_CAPABILITIES.TRACKING_SUBID,
      SUPPLIER_CAPABILITIES.REPORTING,
    ],
    pagination: "page",
    notes: ["vCommission aliases to TRACKIER. No payments API."],
  },
  PARTNERIZE: {
    capabilities: [
      SUPPLIER_CAPABILITIES.CAMPAIGNS,
      SUPPLIER_CAPABILITIES.COUPONS,
      SUPPLIER_CAPABILITIES.CONVERSIONS,
      SUPPLIER_CAPABILITIES.PAYMENTS,
      SUPPLIER_CAPABILITIES.TRACKING_SUBID,
      SUPPLIER_CAPABILITIES.PRODUCTS,
      SUPPLIER_CAPABILITIES.REPORTING,
    ],
    pagination: "page",
    notes: [
      "v15 12F: adref/pubref/clickref CONFIRMED for injection.",
      "v15 11B: Partnerize product feed Yes/High — ProductFeed ingest supported.",
      "Coupons via publisher campaign voucher endpoint.",
      "Performance Facts derived from conversions (no dedicated clicks report).",
      "PARTNERIZE_PRODUCTION_ECHO_UNVERIFIED until live conversion sample captured.",
    ],
  },
  IMPACT: {
    capabilities: [
      SUPPLIER_CAPABILITIES.CAMPAIGNS,
      SUPPLIER_CAPABILITIES.CONVERSIONS,
      SUPPLIER_CAPABILITIES.ADS,
      SUPPLIER_CAPABILITIES.DEEP_LINK,
      SUPPLIER_CAPABILITIES.ORDER_ITEMS,
      SUPPLIER_CAPABILITIES.VALIDATION_STATUS,
      SUPPLIER_CAPABILITIES.TRACKING_SUBID,
      SUPPLIER_CAPABILITIES.PRODUCTS,
      SUPPLIER_CAPABILITIES.PAYMENTS,
      SUPPLIER_CAPABILITIES.REPORTING,
    ],
    pagination: "page",
    notes: [
      "Publisher/MediaPartner role only.",
      "Full Product Feed deferred to Wave F — fetchProducts optional foundation.",
      "Performance Facts derived from Actions; /Reports catalog best-effort.",
      "COUPONS NOT_APPLICABLE — Promotions are deal content, not CouponCodeMaster voucher codes.",
    ],
  },
  AWIN: {
    capabilities: [
      SUPPLIER_CAPABILITIES.CAMPAIGNS,
      SUPPLIER_CAPABILITIES.COUPONS,
      SUPPLIER_CAPABILITIES.CONVERSIONS,
      SUPPLIER_CAPABILITIES.PRODUCTS,
      SUPPLIER_CAPABILITIES.DEEP_LINK,
      SUPPLIER_CAPABILITIES.ORDER_ITEMS,
      SUPPLIER_CAPABILITIES.TRACKING_SUBID,
      SUPPLIER_CAPABILITIES.REPORTING,
    ],
    pagination: "page",
    notes: [
      "OAuth2 Bearer; explicit publisherId → MarketplaceAccount required.",
      "Throttle 20 req/min/user.",
      "Transactions: <=31-day windows; poll transaction + validation + amendment dateTypes.",
      "ClickRef1–6 used for attribution injection.",
    ],
  },
});

const FACTORIES = {
  BOOSTINY: createBoostinyAdapter,
  OPTIMISE: createOptimiseAdapter,
  TRACKIER: createTrackierAdapter,
  PARTNERIZE: createPartnerizeAdapter,
  IMPACT: createImpactAdapter,
  AWIN: createAwinAdapter,
};

/**
 * Resolve supplier key (aliases).
 * @param {string} value
 */
export function normalizeSupplierKey(value) {
  if (!value) return null;
  const key = String(value).trim().toUpperCase();
  if (key === "VCOMMISSION") return "TRACKIER";
  if (key === "MEDIAPARTNER" || key === "IMPACT_COM") return "IMPACT";
  if (FACTORIES[key]) return key;
  return null;
}

/**
 * Create adapter for supplier. Throws on unknown supplier.
 * @param {string} supplierKey
 * @param {object} [config]
 */
export function createSupplierAdapter(supplierKey, config = {}) {
  const key = normalizeSupplierKey(supplierKey);
  if (!key) {
    const err = new Error(`Unknown supplier: ${supplierKey}`);
    err.code = "UNKNOWN_SUPPLIER";
    throw err;
  }
  const factory = FACTORIES[key];
  const adapter = factory(config);
  if (!adapter.supplierKey) adapter.supplierKey = key;
  if (typeof adapter.getCapabilities !== "function") {
    const catalog = SUPPLIER_CAPABILITY_CATALOG[key];
    adapter.getCapabilities = () => ({ ...catalog });
  }
  assertAdapterContract(adapter);
  return adapter;
}

export function listRegisteredSuppliers() {
  return Object.keys(FACTORIES);
}

export function getSupplierCapabilities(supplierKey) {
  const key = normalizeSupplierKey(supplierKey);
  if (!key) return null;
  return SUPPLIER_CAPABILITY_CATALOG[key] ?? null;
}

export function isSupplierRegistered(supplierKey) {
  return Boolean(normalizeSupplierKey(supplierKey));
}
