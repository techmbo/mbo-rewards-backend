/**
 * Maps normalized field names to known raw source keys (from normalizers.js).
 * Prevents false-positive validation when normalized names differ from API keys.
 */

export const NORMALIZED_FIELD_ALIASES = {
  campaign: {
    id: ["id", "_id", "campaign_id", "campaignId", "productId"],
    name: ["name", "campaign_name", "title"],
    advertiser: ["advertiser_name", "advertiserName", "companyName", "merchant"],
    status: ["status", "campaign_status", "subStatus", "campaignStatus", "state", "is_active", "is_live"],
    type: ["campaign_type", "type", "campaignTypeName", "productTypeName"],
  },
  performance: {
    campaign_name: ["campaign_name", "campaignName", "name"],
    revenue: [
      "revenue",
      "net_revenue",
      "sales_amount",
      "sales_amount_usd",
      "net_sales_amount_usd",
      "originalOrderValue",
      "validatedItemValue",
    ],
    commission: [
      "commission",
      "validatedCommission",
      "pendingCommission",
      "totalCommission",
      "commissionValue",
      "netPayout",
      "total",
    ],
    orders: ["orders", "net_orders", "validatedConversions", "totalConversions"],
    clicks: ["clicks"],
    status: ["status", "paymentStatus", "PaymentStatus"],
    date: [
      "date",
      "period_from",
      "conversionDate",
      "invoiceDate",
      "dateCreated",
      "dateSent",
      "PaymentDate",
      "createdAt",
    ],
  },
  conversion: {
    campaign_name: ["campaign_name", "campaignName", "name"],
    revenue: [
      "revenue",
      "net_revenue",
      "sales_amount",
      "sales_amount_usd",
      "net_sales_amount_usd",
      "originalOrderValue",
      "validatedItemValue",
    ],
    commission: [
      "commission",
      "validatedCommission",
      "pendingCommission",
      "totalCommission",
      "commissionValue",
      "netPayout",
      "total",
    ],
    orders: ["orders", "net_orders", "validatedConversions", "totalConversions"],
    clicks: ["clicks"],
    status: ["status", "paymentStatus", "PaymentStatus"],
    date: [
      "date",
      "period_from",
      "conversionDate",
      "invoiceDate",
      "dateCreated",
      "dateSent",
      "PaymentDate",
      "createdAt",
    ],
  },
  payment: {
    id: ["id", "invoiceId", "InvoiceNumber"],
    status: ["status", "PaymentStatus", "paymentStatus"],
    revenue: ["total", "gross", "sales_amount_usd", "sales_amount", "netPayout", "ValidatedCommission"],
    commission: ["netPayout", "net", "net_revenue", "revenue", "vatPayout", "validatedCommission"],
    date: ["dateCreated", "dateSent", "PaymentDate", "period_from", "date", "startYear"],
    campaign_name: ["campaignName", "campaign_name", "Product", "Merchant", "advertiser"],
  },
  coupon: {
    code: ["coupon", "code", "voucherCode", "voucher_code"],
    campaign_name: ["campaign_name", "campaignName"],
    discount: ["discount", "offer", "value", "description", "title"],
    expiry: ["expiry", "expiryDate", "endDate", "validTo"],
  },
};

/** Nested raw paths not covered by flat alias keys. */
export const NESTED_FIELD_RESOLVERS = {
  campaign: {
    advertiser: (rawData) => rawData?.advertiser?.name,
  },
  performance: {
    campaign_name: (rawData) => rawData?.campaign?.name,
    revenue: (rawData) =>
      rawData?.conversionValue?.amount ??
      rawData?.rawConversionValue?.amount ??
      rawData?.origConversionValue?.amount,
    commission: (rawData) => rawData?.commission?.amount ?? rawData?.payout?.amount,
  },
  conversion: {
    campaign_name: (rawData) => rawData?.campaign?.name,
    revenue: (rawData) =>
      rawData?.conversionValue?.amount ??
      rawData?.rawConversionValue?.amount ??
      rawData?.origConversionValue?.amount,
    commission: (rawData) => rawData?.commission?.amount ?? rawData?.payout?.amount,
  },
};
