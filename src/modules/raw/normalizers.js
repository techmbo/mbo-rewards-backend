import { toDate, toNumber } from "../../core/normalize.js";
import {
  resolveCouponCode,
  resolveCouponCodeOrLink,
  resolveCouponCodeType,
  resolveCouponLink,
} from "../coupons/codeType.js";

function first(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    return value;
  }
  return null;
}

export function normalizeEntity(rawData, networkSource, entityType) {
  if (entityType === "campaign") {
    return {
      id: String(
        first(
          rawData?.id,
          rawData?._id,
          rawData?.offer_id,
          rawData?.campaign_id,
          rawData?.campaignId,
          rawData?.productId,
          "",
        ),
      ),
      name: first(
        rawData?.title,
        rawData?.campaign_name,
        rawData?.offer_name,
        rawData?.name,
        rawData?.campaignName,
        null,
      ),
      campaign_name: first(
        rawData?.title,
        rawData?.campaign_name,
        rawData?.offer_name,
        rawData?.name,
        rawData?.campaignName,
        null,
      ),
      advertiser: first(
        rawData?.advertiser_name,
        typeof rawData?.advertiser === "string" ? rawData.advertiser : rawData?.advertiser?.name,
        rawData?.merchant_name,
        rawData?.advertiserName,
        rawData?.companyName,
        rawData?.merchant,
        null,
      ),
      status: first(
        rawData?.status,
        rawData?.campaign_status,
        rawData?.subStatus,
        rawData?.campaignStatus,
        rawData?.approval_status,
        rawData?.is_active === true
          ? "Active"
          : rawData?.is_active === false
            ? "Inactive"
            : null,
        rawData?.is_live === true ? "Live" : rawData?.is_live === false ? "Not Live" : null,
        null,
      ),
      application_status: first(rawData?.application_status, rawData?.applicationStatus, null),
      type: first(
        rawData?.conversion_flow,
        rawData?.offer_type,
        rawData?.campaign_type,
        rawData?.campaignTypeName,
        rawData?.productTypeName,
        // Do not use category as campaign type.
        rawData?.type,
        null,
      ),
      date: toDate(
        first(
          rawData?.startDate,
          rawData?.start_date,
          rawData?.activationDate,
          rawData?.createdAt,
          rawData?.created_at,
          null,
        ),
      ),
      network_source: networkSource,
    };
  }

  if (entityType === "performance" || entityType === "conversion") {
    return {
      campaign_name: first(
        rawData?.campaign_name,
        rawData?.campaignName,
        rawData?.campaign?.name,
        rawData?.name,
        null,
      ),
      revenue: toNumber(
        first(
          rawData?.revenue,
          rawData?.net_revenue,
          rawData?.sales_amount,
          rawData?.sales_amount_usd,
          rawData?.net_sales_amount_usd,
          rawData?.originalOrderValue,
          rawData?.validatedItemValue,
          rawData?.conversionValue?.amount,
          rawData?.rawConversionValue?.amount,
          rawData?.origConversionValue?.amount,
          rawData?.saleAmount,
          rawData?.sale_amount,
          null,
        ),
      ),
      commission: toNumber(
        first(
          rawData?.commission,
          rawData?.validatedCommission,
          rawData?.pendingCommission,
          rawData?.totalCommission,
          rawData?.commissionValue,
          rawData?.commission?.amount,
          rawData?.payout?.amount,
          rawData?.payout,
          rawData?.netPayout,
          rawData?.total,
          null,
        ),
      ),
      orders: toNumber(
        first(
          rawData?.orders,
          rawData?.net_orders,
          rawData?.validatedConversions,
          rawData?.totalConversions,
          rawData?.approvedConversions,
          null,
        ),
      ),
      clicks: toNumber(first(rawData?.clicks, null)),
      status: first(rawData?.status, rawData?.paymentStatus, rawData?.PaymentStatus, null),
      date: toDate(
        first(
          rawData?.date,
          rawData?.period_from,
          rawData?.conversionDate,
          rawData?.conversion_date,
          rawData?.created,
          rawData?.invoiceDate,
          rawData?.dateCreated,
          rawData?.dateSent,
          rawData?.PaymentDate,
          rawData?.createdAt,
          null,
        ),
      ),
      network_source: networkSource,
    };
  }

  if (entityType === "payment") {
    return {
      id: String(
        first(
          rawData?.id,
          rawData?.invoiceId,
          rawData?.InvoiceNumber,
          rawData?.period_from && rawData?.period_to
            ? `${rawData.period_from}-${rawData.period_to}`
            : null,
          "",
        ),
      ),
      status: first(rawData?.status, rawData?.PaymentStatus, rawData?.paymentStatus, null),
      revenue: toNumber(
        first(
          rawData?.total,
          rawData?.gross,
          rawData?.sales_amount_usd,
          rawData?.sales_amount,
          rawData?.netPayout,
          rawData?.ValidatedCommission,
          null,
        ),
      ),
      commission: toNumber(
        first(
          rawData?.netPayout,
          rawData?.net,
          rawData?.net_revenue,
          rawData?.revenue,
          rawData?.vatPayout,
          rawData?.validatedCommission,
          null,
        ),
      ),
      date: toDate(
        first(
          rawData?.dateCreated,
          rawData?.dateSent,
          rawData?.PaymentDate,
          rawData?.period_from,
          rawData?.date,
          rawData?.startYear,
          null,
        ),
      ),
      campaign_name: first(
        rawData?.campaignName,
        rawData?.campaign_name,
        rawData?.Product,
        rawData?.Merchant,
        rawData?.advertiser,
        null,
      ),
      network_source: networkSource,
    };
  }

  if (entityType === "coupon") {
    const code = resolveCouponCode(rawData);
    return {
      code,
      link: resolveCouponLink(rawData),
      display_value: resolveCouponCodeOrLink(rawData),
      code_type: resolveCouponCodeType(rawData, networkSource),
      name: first(
        code,
        rawData?.title,
        rawData?.companyName,
        rawData?.campaignName,
        rawData?.description,
        null,
      ),
      campaign_name: first(
        rawData?.campaign_name,
        rawData?.campaignName,
        rawData?.campaign?.name,
        null,
      ),
      advertiser: first(
        rawData?.advertiser_name,
        typeof rawData?.advertiser === "string" ? rawData.advertiser : rawData?.advertiser?.name,
        rawData?.advertiserName,
        rawData?.merchant_name,
        rawData?.companyName,
        rawData?.brand_name,
        rawData?.campaign?.advertiser_name,
        rawData?.campaign?.advertiser,
        null,
      ),
      status: first(rawData?.status, rawData?.coupon_status, rawData?.couponStatus, null),
      type: first(rawData?.type, rawData?.code_type, rawData?.offer_type, null),
      discount: first(rawData?.discount, rawData?.offer, rawData?.value, rawData?.description, rawData?.title, null),
      start_date: toDate(first(rawData?.activationDate, rawData?.start_date, rawData?.startDate, null)),
      expiry: toDate(first(rawData?.expiry, rawData?.expiryDate, rawData?.endDate, rawData?.end, rawData?.validTo, null)),
      network_source: networkSource,
    };
  }

  return {
    network_source: networkSource,
  };
}
