/**
 * Common Network Adapter contract (Wave E).
 *
 * Adapters fetch supplier data only. They must NOT:
 * - calculate client commission / MBO margin
 * - create client assignments, invoices, statements
 * - perform FX
 * - create FinancialTransaction
 */

/** @typedef {'CAMPAIGNS'|'COUPONS'|'CONVERSIONS'|'PAYMENTS'|'PRODUCTS'|'DEEP_LINK'|'TRACKING_SUBID'|'MULTI_CURRENCY'|'ORDER_ITEMS'|'VALIDATION_STATUS'|'ADS'|'INVOICES'|'REPORTING'} SupplierCapability */

export const SUPPLIER_CAPABILITIES = Object.freeze({
  CAMPAIGNS: "CAMPAIGNS",
  COUPONS: "COUPONS",
  CONVERSIONS: "CONVERSIONS",
  PAYMENTS: "PAYMENTS",
  PRODUCTS: "PRODUCTS",
  DEEP_LINK: "DEEP_LINK",
  TRACKING_SUBID: "TRACKING_SUBID",
  MULTI_CURRENCY: "MULTI_CURRENCY",
  ORDER_ITEMS: "ORDER_ITEMS",
  VALIDATION_STATUS: "VALIDATION_STATUS",
  ADS: "ADS",
  INVOICES: "INVOICES",
  REPORTING: "REPORTING",
});

/**
 * @typedef {object} AdapterCapabilities
 * @property {string[]} capabilities
 * @property {boolean} [fetchProducts]
 * @property {string} [pagination] page|cursor|token
 * @property {string[]} [notes]
 */

/**
 * @typedef {object} NetworkAdapter
 * @property {string} supplierKey
 * @property {() => AdapterCapabilities} getCapabilities
 * @property {() => Promise<{ ok: boolean, detail?: string }>} [authenticate]
 * @property {() => Promise<{ ok: boolean, detail?: string }>} [healthCheck]
 * @property {(params?: object, stats?: object|null) => Promise<object[]>} [fetchCampaigns]
 * @property {(params?: object, stats?: object|null) => Promise<object[]>} [fetchCoupons]
 * @property {(params?: object, stats?: object|null) => Promise<object[]>} [fetchConversions]
 * @property {(params?: object, stats?: object|null) => Promise<object[]>} [fetchPayments]
 * @property {(params?: object, stats?: object|null) => Promise<object[]>} [fetchProducts]
 * @property {(params?: object, stats?: object|null) => Promise<object[]>} [fetchAds]
 * @property {(options?: object) => Promise<object>} [fetchAll]
 */

/**
 * Assert adapter exposes required methods for declared capabilities.
 * @param {NetworkAdapter} adapter
 */
/**
 * The capability → adapter method contract, in ONE place.
 *
 * A capability listed here is a claim that the named method exists and can be called. Capabilities
 * absent from this map are descriptive (DEEP_LINK, TRACKING_SUBID, MULTI_CURRENCY, ORDER_ITEMS,
 * VALIDATION_STATUS, INVOICES, REPORTING) — they describe how an implemented fetcher behaves
 * rather than naming a fetcher of their own, so they carry no method requirement.
 *
 * assertAdapterContract checks an adapter against its OWN getCapabilities(). That never saw the
 * registry's SUPPLIER_CAPABILITY_CATALOG, which is a second, independent declaration — and the two
 * silently disagreed. Exported so the registry catalog can be held to the same rule.
 */
export const CAPABILITY_METHODS = Object.freeze({
  [SUPPLIER_CAPABILITIES.CAMPAIGNS]: "fetchCampaigns",
  [SUPPLIER_CAPABILITIES.COUPONS]: "fetchCoupons",
  [SUPPLIER_CAPABILITIES.CONVERSIONS]: "fetchConversions",
  [SUPPLIER_CAPABILITIES.PAYMENTS]: "fetchPayments",
  [SUPPLIER_CAPABILITIES.PRODUCTS]: "fetchProducts",
  [SUPPLIER_CAPABILITIES.ADS]: "fetchAds",
});

export function assertAdapterContract(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Adapter must be an object");
  }
  if (!adapter.supplierKey) {
    throw new Error("Adapter must set supplierKey");
  }
  if (typeof adapter.getCapabilities !== "function") {
    throw new Error(`${adapter.supplierKey}: getCapabilities() required`);
  }
  const caps = adapter.getCapabilities()?.capabilities ?? [];
  for (const cap of caps) {
    const method = CAPABILITY_METHODS[cap];
    if (method && typeof adapter[method] !== "function") {
      throw new Error(`${adapter.supplierKey}: capability ${cap} requires ${method}()`);
    }
  }
  return true;
}

export function hasCapability(adapter, capability) {
  const caps = adapter?.getCapabilities?.()?.capabilities ?? [];
  return caps.includes(capability);
}
