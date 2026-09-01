/**
 * Pointer 8 — MBO canonical object taxonomy.
 * Keep objects separate; never collapse into generic Entity/Assets buckets.
 */

export const MBO_CANONICAL_OBJECT = Object.freeze({
  NETWORK_ACCOUNT: "NetworkAccount",
  NETWORK_CAMPAIGN: "NetworkCampaign",
  BRAND: "Brand",
  CAMPAIGN: "Campaign",
  SUPPLIER_COMMISSION_RULE: "SupplierCommissionRule",
  COUPON_VOUCHER: "CouponVoucher",
  TRACKING_LINK: "TrackingLink",
  OFFER_PROMOTION: "OfferPromotion",
  PRODUCT: "Product",
  PERFORMANCE_RECORD: "PerformanceRecord",
  CLICK: "Click",
  ORDER_CONVERSION: "OrderConversion",
  ORDER_ITEM: "OrderItem",
  NETWORK_INVOICE_BILLING: "NetworkInvoiceBilling",
  NETWORK_PAYMENT: "NetworkPayment",
  MBO_RECEIPT: "MBOReceipt",
  CLIENT_CAMPAIGN_ASSIGNMENT: "ClientCampaignAssignment",
  CLIENT_PAYABLE: "ClientPayable",
  EXCEPTION: "Exception",
});

export const MBO_CANONICAL_OBJECT_LIST = Object.freeze(Object.values(MBO_CANONICAL_OBJECT));

const OBJECT_LABELS = Object.freeze({
  NetworkAccount: "Network Account",
  NetworkCampaign: "Network Campaign",
  Brand: "Brand",
  Campaign: "Campaign",
  SupplierCommissionRule: "Supplier Commission Rule",
  CouponVoucher: "Coupon / Voucher",
  TrackingLink: "Tracking Link",
  OfferPromotion: "Offer / Promotion",
  Product: "Product",
  PerformanceRecord: "Performance Record",
  Click: "Click",
  OrderConversion: "Order / Conversion",
  OrderItem: "Order Item",
  NetworkInvoiceBilling: "Network Invoice / Billing",
  NetworkPayment: "Network Payment",
  MBOReceipt: "MBO Receipt",
  ClientCampaignAssignment: "Client Campaign Assignment",
  ClientPayable: "Client Payable",
  Exception: "Exception",
});

/** Legacy informal labels → canonical object (pre–pointer 8). */
const LEGACY_OBJECT_ALIASES = Object.freeze({
  ORDER: MBO_CANONICAL_OBJECT.ORDER_CONVERSION,
  CONVERSION: MBO_CANONICAL_OBJECT.ORDER_CONVERSION,
  COMMISSION: MBO_CANONICAL_OBJECT.SUPPLIER_COMMISSION_RULE,
  ATTRIBUTION: MBO_CANONICAL_OBJECT.CLIENT_CAMPAIGN_ASSIGNMENT,
  COUPON: MBO_CANONICAL_OBJECT.COUPON_VOUCHER,
  VOUCHER: MBO_CANONICAL_OBJECT.COUPON_VOUCHER,
  TRACKING: MBO_CANONICAL_OBJECT.TRACKING_LINK,
  LINK: MBO_CANONICAL_OBJECT.TRACKING_LINK,
  PERFORMANCE: MBO_CANONICAL_OBJECT.PERFORMANCE_RECORD,
  PAYMENT: MBO_CANONICAL_OBJECT.NETWORK_PAYMENT,
  INVOICE: MBO_CANONICAL_OBJECT.NETWORK_INVOICE_BILLING,
  BILLING: MBO_CANONICAL_OBJECT.NETWORK_INVOICE_BILLING,
  ENTITY: MBO_CANONICAL_OBJECT.EXCEPTION,
  ASSETS: MBO_CANONICAL_OBJECT.EXCEPTION,
  ASSET: MBO_CANONICAL_OBJECT.EXCEPTION,
});

const ENTITY_TYPE_TO_OBJECT = Object.freeze({
  campaign: MBO_CANONICAL_OBJECT.NETWORK_CAMPAIGN,
  conversion: MBO_CANONICAL_OBJECT.ORDER_CONVERSION,
  conversion_item: MBO_CANONICAL_OBJECT.ORDER_ITEM,
  coupon: MBO_CANONICAL_OBJECT.COUPON_VOUCHER,
  product: MBO_CANONICAL_OBJECT.PRODUCT,
  performance: MBO_CANONICAL_OBJECT.PERFORMANCE_RECORD,
  payment: MBO_CANONICAL_OBJECT.NETWORK_PAYMENT,
  link: MBO_CANONICAL_OBJECT.TRACKING_LINK,
});

export function normalizeMboCanonicalObject(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (MBO_CANONICAL_OBJECT_LIST.includes(raw)) return raw;
  const upper = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const canonical of MBO_CANONICAL_OBJECT_LIST) {
    if (canonical.toUpperCase() === upper) return canonical;
  }
  const legacy = LEGACY_OBJECT_ALIASES[upper];
  return legacy || null;
}

export function isValidMboCanonicalObject(value) {
  return Boolean(normalizeMboCanonicalObject(value));
}

export function mboCanonicalObjectLabel(value) {
  const key = normalizeMboCanonicalObject(value);
  return key ? OBJECT_LABELS[key] || key : "—";
}

function inferFromCanonicalField(field = "") {
  const f = String(field || "");
  const lower = f.toLowerCase();

  if (f.startsWith("attribution.")) return MBO_CANONICAL_OBJECT.CLIENT_CAMPAIGN_ASSIGNMENT;
  if (/^brand/i.test(f) || lower === "merchantname" || lower === "merchantnameraw") {
    return MBO_CANONICAL_OBJECT.BRAND;
  }
  if (/clientpayable|payableamount|payablestatus/i.test(f)) {
    return MBO_CANONICAL_OBJECT.CLIENT_PAYABLE;
  }
  if (/receipt/i.test(f)) return MBO_CANONICAL_OBJECT.MBO_RECEIPT;
  if (/exception|anomaly|dispute/i.test(f)) return MBO_CANONICAL_OBJECT.EXCEPTION;

  if (/^(default|headline|tier|rule).*commission|commissionrule|commissiontier/i.test(f)) {
    return MBO_CANONICAL_OBJECT.SUPPLIER_COMMISSION_RULE;
  }

  if (/clickid|clickref|clickcount|^click$/i.test(f)) return MBO_CANONICAL_OBJECT.CLICK;
  if (/trackingurl|trackinglink|deeplink|landingurl|redirecturl/i.test(f)) {
    return MBO_CANONICAL_OBJECT.TRACKING_LINK;
  }

  if (/coupon|voucher|promocode/i.test(f)) return MBO_CANONICAL_OBJECT.COUPON_VOUCHER;
  if (/offer|promotion|deal/i.test(f)) return MBO_CANONICAL_OBJECT.OFFER_PROMOTION;
  if (/product/i.test(f)) return MBO_CANONICAL_OBJECT.PRODUCT;

  if (/suppliercampaignid|networkcampaignid/i.test(f)) {
    return MBO_CANONICAL_OBJECT.NETWORK_CAMPAIGN;
  }
  if (/campaignname|campaignstatus|participationstatus/i.test(f)) {
    return MBO_CANONICAL_OBJECT.NETWORK_CAMPAIGN;
  }
  if (/^campaign/i.test(f)) return MBO_CANONICAL_OBJECT.CAMPAIGN;

  if (/suppliercommission|approvedcommission|ordervalue|conversiondate|supplierorderid|supplierconversionid/i.test(f)) {
    return MBO_CANONICAL_OBJECT.ORDER_CONVERSION;
  }
  if (/basket|lineitem|orderitem|sku|quantity|itemvalue/i.test(f)) {
    return MBO_CANONICAL_OBJECT.ORDER_ITEM;
  }

  if (/invoice|billingstatement/i.test(f)) return MBO_CANONICAL_OBJECT.NETWORK_INVOICE_BILLING;
  if (/payment|payout|withdrawal/i.test(f)) return MBO_CANONICAL_OBJECT.NETWORK_PAYMENT;

  if (/impression|report|analytics|performance|stat/i.test(f)) {
    return MBO_CANONICAL_OBJECT.PERFORMANCE_RECORD;
  }

  if (/accountid|accountname|publisherid|networkaccount/i.test(f)) {
    return MBO_CANONICAL_OBJECT.NETWORK_ACCOUNT;
  }

  return null;
}

function inferFromSourceObject(sourceObject = "") {
  const key = String(sourceObject || "").toLowerCase();

  if (/account|publisher|profile|credential/.test(key)) {
    return MBO_CANONICAL_OBJECT.NETWORK_ACCOUNT;
  }
  if (/basket|line.?item|conversion.?item|action.?item|order.?item/.test(key)) {
    return MBO_CANONICAL_OBJECT.ORDER_ITEM;
  }
  if (/conversion|action|transaction|event/.test(key)) {
    return MBO_CANONICAL_OBJECT.ORDER_CONVERSION;
  }
  if (/click/.test(key)) return MBO_CANONICAL_OBJECT.CLICK;
  if (/voucher|coupon|promo.?code/.test(key)) {
    return MBO_CANONICAL_OBJECT.COUPON_VOUCHER;
  }
  if (/offer|deal|promotion/.test(key)) return MBO_CANONICAL_OBJECT.OFFER_PROMOTION;
  if (/link.?report|tracking.?link|^links$/.test(key)) {
    return MBO_CANONICAL_OBJECT.TRACKING_LINK;
  }
  if (/product|catalog|feed/.test(key)) return MBO_CANONICAL_OBJECT.PRODUCT;
  if (/invoice|billing/.test(key)) return MBO_CANONICAL_OBJECT.NETWORK_INVOICE_BILLING;
  if (/payment|payout|settlement|finance/.test(key)) {
    return MBO_CANONICAL_OBJECT.NETWORK_PAYMENT;
  }
  if (/report|analytics|performance|tracking/.test(key)) {
    return MBO_CANONICAL_OBJECT.PERFORMANCE_RECORD;
  }
  if (/campaign|program|programme|advertiser/.test(key)) {
    return MBO_CANONICAL_OBJECT.NETWORK_CAMPAIGN;
  }
  if (/commission.?rule|commission.?tier/.test(key)) {
    return MBO_CANONICAL_OBJECT.SUPPLIER_COMMISSION_RULE;
  }
  if (/receipt/.test(key)) return MBO_CANONICAL_OBJECT.MBO_RECEIPT;
  if (/payable/.test(key)) return MBO_CANONICAL_OBJECT.CLIENT_PAYABLE;
  if (/assignment|attribution/.test(key)) {
    return MBO_CANONICAL_OBJECT.CLIENT_CAMPAIGN_ASSIGNMENT;
  }
  if (/brand/.test(key)) return MBO_CANONICAL_OBJECT.BRAND;

  return null;
}

/**
 * Resolve which MBO canonical object a mapping rule targets.
 * @param {string} sourceObject — network source object key
 * @param {string|null} mboCanonicalField — MBO field name
 * @param {{ entityType?: string|null, declaredObject?: string|null }} [hints]
 */
export function inferMboTargetObject(sourceObject, mboCanonicalField, hints = {}) {
  const declared = normalizeMboCanonicalObject(hints.declaredObject);
  if (declared) return declared;

  const fromField = inferFromCanonicalField(mboCanonicalField);
  if (fromField) return fromField;

  const entityType = hints.entityType ? String(hints.entityType).toLowerCase() : null;
  if (entityType && ENTITY_TYPE_TO_OBJECT[entityType]) {
    return ENTITY_TYPE_TO_OBJECT[entityType];
  }

  const fromSource = inferFromSourceObject(sourceObject);
  if (fromSource) return fromSource;

  return MBO_CANONICAL_OBJECT.EXCEPTION;
}

export function resolveMboTargetObject(sourceObject, mboCanonicalField, hints = {}) {
  const normalized = normalizeMboCanonicalObject(
    hints.explicitObject ?? hints.declaredObject ?? null,
  );
  if (normalized) return normalized;
  return inferMboTargetObject(sourceObject, mboCanonicalField, hints);
}
