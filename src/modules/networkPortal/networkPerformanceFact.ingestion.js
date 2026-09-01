/**
 * Promote supplier performance Entity / raw report rows → NetworkPerformanceFact.
 * NETWORK → MBO grain only. Never substitutes networkClicks with MBO clicks.
 * Never invents tracking URLs or settlement amounts.
 */
import { prisma } from "../../database/prisma.js";
import { supplierKeyFromPlatform } from "../ops/networkOps.contract.js";
import {
  buildPerformanceRecordMetadata,
  extractPerformanceCouponCode,
  hydratePerformanceIdentityFromCampaign,
  normalizeCustomerType,
  resolvePerformanceChannelType,
  resolvePerformanceCustomerType,
  resolvePerformanceDevicePlatform,
  resolvePerformanceEpc,
  resolvePerformanceImpressions,
} from "./performanceRecord.contract.js";
import { NetworkPortalService } from "./networkPortal.service.js";

export {
  extractPerformanceCouponCode,
  normalizeCustomerType,
} from "./performanceRecord.contract.js";

function first(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== "");
}

function extractPerformanceCouponId(row = {}) {
  return first(row.couponId, row.coupon_id, row.voucher_id, row.code_id, row.codeId, row.CodeId);
}

function toNum(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object" && value.amount != null) return toNum(value.amount);
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addNums(...values) {
  let sum = null;
  for (const v of values) {
    const n = toNum(v);
    if (n == null) continue;
    sum = (sum ?? 0) + n;
  }
  return sum;
}

function mapPerformanceMboStatus(raw) {
  if (raw == null || raw === "") return null;
  const v = String(raw).trim().toLowerCase();
  if (["approved", "confirmed", "validated", "accepted"].includes(v)) return "Confirmed";
  if (["pending", "open", "hold"].includes(v)) return "Pending";
  if (["rejected", "declined", "denied"].includes(v)) return "Rejected";
  if (["cancelled", "canceled"].includes(v)) return "Cancelled";
  if (["paid", "settled"].includes(v)) return "Paid";
  return null;
}

function dayBoundsUtc(reportDate) {
  const start = toDateOnly(reportDate);
  if (!start) return null;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function resolveSupplier(networkSource) {
  const key = supplierKeyFromPlatform(networkSource) || String(networkSource || "").toUpperCase();
  const LIVE = new Set(["BOOSTINY", "OPTIMISE", "TRACKIER", "PARTNERIZE", "IMPACT", "AWIN"]);
  if (LIVE.has(key)) return key;
  const upper = String(networkSource || "").toUpperCase();
  if (upper.startsWith("OPTIMISE")) return "OPTIMISE";
  if (upper === "VCOMMISSION") return "TRACKIER";
  // Planned (Admitad/CJ/Rakuten) are not in SupplierKey enum yet — skip until connectors land.
  return null;
}

/** Accept ISO2 only — never invent from country names (e.g. "Singapore" → null). */
function toIso2Country(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") {
    const nested = first(value.code, value.iso, value.iso2, value.countryCode, value.country);
    return toIso2Country(nested);
  }
  const s = String(value).trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return null;
}

/**
 * Map one performance/report row into NetworkPerformanceFact upsert input.
 * Missing metrics stay null — never invent.
 * Field aliases follow docs/MBO_to_Network_Mapping.csv for all live suppliers.
 */
export function mapPerformanceRowToFactInput(row, {
  networkSource,
  sourceAccountLabel = "default",
  rawPayloadId = null,
  sourceEndpoint = null,
} = {}) {
  if (!row || typeof row !== "object") return null;
  const supplier = resolveSupplier(networkSource);
  if (!supplier) return null;

  const reportDate = toDateOnly(
    first(
      row.date,
      row.reportDate,
      row.day,
      row.created,
      row.conversionDate,
      row.conversion_time,
      row.conversion_date,
      row.conversion_date_time,
      row.EventDate,
      row.CreationDate,
      row.transactionDate,
      row.transactionDateTime,
      row.report_date,
    ),
  );
  if (!reportDate) return null;

  const networkClicks = toNum(
    first(
      row.networkClicks,
      row.network_clicks,
      row.clicks,
      row.Clicks,
      row.click,
      row.totalClicks,
      row.click_count,
      row.link_performance?.clicks,
      row.performance?.clicks,
    ),
  );
  // MBO link clicks must come from MBO Click facts only — leave null here (do not copy networkClicks).
  const mboLinkClicks = toNum(first(row.mboLinkClicks, row.mbo_link_clicks, row.mboClicks));

  const grossOrders = toNum(
    first(
      row.grossOrders,
      row.orders,
      row.totalConversions,
      row.conversions,
      row.gross_orders,
      row.link_performance?.conversions,
      row.performance?.conversions,
      row.sales_open,
    ),
  );
  const confirmedOrders = toNum(
    first(
      row.confirmedOrders,
      row.net_orders,
      row.validatedConversions,
      row.approvedConversions,
      row.sales_approved,
    ),
  );
  const pendingOrders = toNum(first(row.pendingOrders, row.pendingConversions));
  const cancelledOrders = toNum(first(row.cancelledOrders, row.cancelled_orders, row.cancelledConversions));
  const rejectedOrders = toNum(
    first(row.rejectedOrders, row.rejectedConversions, row.rejected_orders, row.sales_declined),
  );

  const grossOrderValue = toNum(
    first(
      row.grossOrderValue,
      row.sales_amount_usd,
      row.originalOrderValue,
      row.originalOrderValueOriginal,
      row.revenue,
      row.sale_amount,
      row.saleAmount,
      row.SaleAmount,
      row.Amount,
      row.saleAmount?.amount,
      row.orderAmount,
      row.conversionValue?.amount,
      row.conversion_value?.value,
      row.conversion_value?.amount,
      row.transactionValue?.amount,
      row.available_commissions?.available_commission?.value,
    ),
  );
  const confirmedOrderValue = toNum(
    first(
      row.confirmedOrderValue,
      row.net_sales_amount_usd,
      row.validatedItemValue,
      row.validatedOrderValue,
    ),
  );
  const grossCommission = toNum(
    first(
      row.grossCommission,
      row.totalCommission,
      row.commission?.amount,
      row.cost?.amount,
      row.commissionAmount?.amount,
      row.commissionAmount,
      row.publisher_commission,
      row.conversion_value?.publisher_commission,
      row.conversion_value?.publisher,
      row.available_commissions?.available_commission?.publisher_commission,
      row.commission,
      row.payout,
      row.Payout,
      row.ActionEarnings,
      row.validatedCommission,
      row.net_revenue,
      row.performance?.commission,
      row.payment_sum_open,
      row.commissions,
    ),
  );
  const confirmedCommission = toNum(
    first(
      row.confirmedCommission,
      row.validatedCommission,
      row.validatedCommissionOriginal,
      row.validatedConversionCommission,
      row.estimatedValidatedCommission,
      row.validatedItemCommission,
      row.commission?.amount,
      row.commissionAmount?.amount,
      row.publisher_commission,
      row.payout,
      row.Payout,
      row.ActionEarnings,
      row.net_revenue,
      row.payment_sum_approved,
    ),
  );
  const pendingCommission = toNum(
    first(
      row.pendingCommission,
      row.pendingCommissionOriginal,
      row.pendingCommissionAmount,
      row.pendingItemCommission,
    ),
  );
  const aov = toNum(first(row.aov, row.aov_usd, row.net_aov_usd));

  const brandName = first(
    row.brandName,
    row.advertiser_name,
    row.advertiserName,
    row.AdvertiserName,
    row.brand_name,
    row.merchant_name,
    row.advertiser?.name,
    row.advertiser?.display_name,
    typeof row.advertiser === "string" ? row.advertiser : null,
    row.merchant,
    null,
  );
  const campaignName = first(
    row.campaignName,
    row.campaign_name,
    row.CampaignName,
    row.campaign_title,
    row.ProgramName,
    row.programmeName,
    row.campaign?.name,
    row.campaign?.title,
    row.offer_name,
    row.name,
    null,
  );
  const couponCode = extractPerformanceCouponCode(row);
  const currency = first(
    row.currency,
    row.Currency,
    row.currencyCode,
    row.targetCurrencyCode,
    row.originalCurrencyCode,
    row.currency?.iso,
    row.commission?.currency,
    row.commissionAmount?.currency,
    row.saleAmount?.currency,
    row.cost?.currency,
    row.conversionValue?.currency,
    row.conversion_value?.currency,
    row.payouts?.[0]?.currency,
    null,
  );
  const country = toIso2Country(
    first(
      row.country,
      row.Country,
      row.countryCode,
      row.CustomerCountry,
      row.customer_country,
      row.customerCountry,
      row.geo,
      row.advertiserCountry,
      row.primaryRegion?.countryCode,
      Array.isArray(row.countries) ? row.countries[0] : null,
      null,
    ),
  );
  const networkTrackingLink = first(
    row.networkTrackingLink,
    row.trackingUrl,
    row.tracking_url,
    row.trackingURL,
    row.baseTrackingUrl,
    row.clickThroughUrl,
    row.urlTracking,
    null,
  );
  // Never invent MBO tracking from network URL
  const mboTrackingLink = first(row.mboTrackingLink, row.mbo_tracking_url, null);

  const supplierCampaignId = first(
    row.supplierCampaignId,
    row.campaign_id,
    row.campaignId,
    row.CampaignId,
    row.ProgramId,
    row.programmeId,
    row.advertiserId,
    row.productId,
    row.offer_id,
    row.offerId,
    null,
  );
  const reportExternalId = first(row.reportExternalId, row.report_id, row.id, row.Id, row._id, null);
  const rawStatus = first(
    row.rawStatus,
    row.raw_status,
    row.status,
    row.Status,
    row.State,
    row.commissionStatus,
    row.conversion_status,
    null,
  );
  const attributionStatus = first(
    row.attributionStatus,
    row.attribution,
    row.attribution_status,
    null,
  );
  const campaignChannelType = resolvePerformanceChannelType({
    ...row,
    couponCode,
    networkTrackingLink,
  });
  const couponIdRaw = extractPerformanceCouponId(row);

  return {
    supplier,
    sourceAccountLabel: sourceAccountLabel || "default",
    reportDate,
    reportExternalId: reportExternalId != null ? String(reportExternalId) : null,
    supplierCampaignId: supplierCampaignId != null ? String(supplierCampaignId) : null,
    brandName: brandName != null ? String(brandName) : null,
    campaignName: campaignName != null ? String(campaignName) : null,
    category: first(row.category, row.category_name, row.categoryName, null),
    country,
    currency: currency != null ? String(currency).toUpperCase().slice(0, 3) : null,
    campaignTypeCommercial: first(row.campaignType, row.campaign_type, row.pricingModel, null),
    campaignChannelType,
    couponId: couponIdRaw != null ? String(couponIdRaw) : null,
    couponCode: couponCode != null ? String(couponCode) : null,
    couponSource: first(row.couponSource, row.coupon_source, null),
    couponScope: first(row.couponScope, row.coupon_scope, null),
    networkTrackingLink: networkTrackingLink != null ? String(networkTrackingLink) : null,
    mboTrackingLink: mboTrackingLink != null ? String(mboTrackingLink) : null,
    trackingLinkId: first(row.trackingLinkId, row.tracking_link_id, row.mboTrackingLinkId, null),
    networkClickId: first(
      row.networkClickId,
      row.click_id,
      row.clickId,
      row.ClickId,
      row.clickref,
      row.click_ref,
      row.clickRef,
      row.clickRef1,
      row.supplierClickId,
      null,
    ),
    mboClickId: first(row.mboClickId, row.mbo_click_id, null),
    subId1: first(row.subId1, row.sub_id_1, row.subid1, row.pubref, row.clickRef, row.SubId1, row.u1, null),
    subId2: first(row.subId2, row.sub_id_2, row.subid2, row.clickRef2, row.SubId2, null),
    subId3: first(row.subId3, row.sub_id_3, row.subid3, row.clickRef3, row.SubId3, null),
    impressions: resolvePerformanceImpressions(row),
    networkClicks,
    mboLinkClicks, // null unless supplier/MBO explicitly provided — never copy networkClicks
    uniqueClicks: toNum(first(row.uniqueClicks, row.unique_clicks, row.UniqueClicks)),
    grossOrders,
    pendingOrders,
    confirmedOrders,
    cancelledOrders,
    rejectedOrders,
    paidOrders: toNum(row.paidOrders),
    grossOrderValue,
    pendingOrderValue: toNum(row.pendingOrderValue),
    confirmedOrderValue,
    cancelledOrderValue: toNum(row.cancelledOrderValue),
    rejectedOrderValue: toNum(row.rejectedOrderValue),
    paidOrderValue: toNum(row.paidOrderValue),
    grossCommission,
    pendingCommission,
    confirmedCommission,
    cancelledCommission: toNum(row.cancelledCommission),
    rejectedCommission: toNum(
      first(row.rejectedCommission, row.rejectedItemCommission),
    ),
    payableCommission: toNum(first(row.payableCommission, confirmedCommission)),
    paidCommission: toNum(row.paidCommission),
    mboReceivable: toNum(first(row.mboReceivable, confirmedCommission)),
    // Settlement evidence only — never invent from payable
    mboActuallyReceived: toNum(first(row.mboActuallyReceived, row.receivedCommission, row.bankReceived)),
    discountPercent: toNum(first(row.discountPercent, row.discount)),
    customerType: resolvePerformanceCustomerType(row),
    devicePlatform: resolvePerformanceDevicePlatform(row),
    conversionRate: toNum(first(row.conversionRate, row.cr, row.cvr)),
    aov,
    epc: resolvePerformanceEpc(row),
    attributionStatus: attributionStatus != null ? String(attributionStatus) : null,
    reconciliationStatus: first(row.reconciliationStatus, row.reconciliation, null),
    rawPayloadId,
    sourceEndpoint,
    reportGranularity: first(row.report_type, row.reportGranularity, "daily"),
    lastSyncedAt: new Date(),
    metadata: buildPerformanceRecordMetadata(row, {
      rawStatus: rawStatus != null ? String(rawStatus) : null,
      mboStandardStatus: mapPerformanceMboStatus(rawStatus),
    }),
  };
}

/**
 * Collapse conversion/event-level rows into daily grain before Fact upsert.
 * Prevents same-day same-campaign conversions from overwriting each other
 * (grainKey does not include conversion id).
 */
export function aggregatePerformanceRowsByGrain(rows = []) {
  const buckets = new Map();
  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    const reportDate = toDateOnly(
      first(
        row.date,
        row.reportDate,
        row.day,
        row.created,
        row.conversionDate,
        row.conversion_time,
        row.conversion_date,
        row.EventDate,
        row.CreationDate,
        row.report_date,
      ),
    );
    if (!reportDate) continue;

    const supplierCampaignId = first(
      row.supplierCampaignId,
      row.campaign_id,
      row.campaignId,
      row.CampaignId,
      row.ProgramId,
      row.programmeId,
      row.advertiserId,
      row.productId,
      row.offer_id,
      null,
    );
    const couponCode = extractPerformanceCouponCode(row);
    const currency = first(
      row.currency,
      row.Currency,
      row.currencyCode,
      row.targetCurrencyCode,
      row.commissionAmount?.currency,
      row.saleAmount?.currency,
      null,
    );
    const country = toIso2Country(
      first(row.country, row.Country, row.countryCode, row.CustomerCountry, row.customer_country, null),
    );
    const customerType = resolvePerformanceCustomerType(row);
    const key = [
      reportDate.toISOString().slice(0, 10),
      supplierCampaignId != null ? String(supplierCampaignId) : "",
      couponCode != null ? String(couponCode) : "",
      currency != null ? String(currency).toUpperCase() : "",
      country != null ? String(country).toUpperCase() : "",
      customerType != null ? String(customerType) : "",
    ].join("|");

    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        ...row,
        date: reportDate.toISOString().slice(0, 10),
        campaign_id: supplierCampaignId,
        coupon_code: couponCode,
        currency,
        country,
        customerType,
        customer_type: customerType,
        custType: customerType,
        clicks: toNum(first(row.clicks, row.click, row.totalClicks, row.Clicks)),
        impressions: toNum(first(row.impressions, row.Impressions)),
        orders: toNum(first(row.orders, row.totalConversions, row.conversions, row.grossOrders)) ?? 1,
        totalConversions: toNum(first(row.totalConversions, row.conversions, row.orders)) ?? 1,
        validatedConversions: toNum(
          first(row.validatedConversions, row.approvedConversions, row.confirmedOrders),
        ),
        pendingConversions: toNum(first(row.pendingConversions, row.pendingOrders)),
        rejectedConversions: toNum(first(row.rejectedConversions, row.rejectedOrders)),
        commission: toNum(
          first(
            row.commission,
            row.publisher_commission,
            row.commissionAmount?.amount,
            row.commissionAmount,
            row.payout,
            row.Payout,
            row.ActionEarnings,
          ),
        ),
        originalOrderValue: toNum(
          first(
            row.originalOrderValue,
            row.order_value,
            row.Amount,
            row.SaleAmount,
            row.saleAmount?.amount,
            row.saleAmount,
            row.conversion_value?.value,
            row.revenue,
          ),
        ),
        _aggCount: 1,
      });
      continue;
    }

    existing.clicks = addNums(existing.clicks, first(row.clicks, row.click, row.totalClicks, row.Clicks));
    existing.impressions = addNums(existing.impressions, first(row.impressions, row.Impressions));
    const orderInc =
      toNum(first(row.orders, row.totalConversions, row.conversions, row.grossOrders)) ?? 1;
    existing.orders = addNums(existing.orders, orderInc);
    existing.totalConversions = addNums(existing.totalConversions, orderInc);
    existing.validatedConversions = addNums(
      existing.validatedConversions,
      first(row.validatedConversions, row.approvedConversions, row.confirmedOrders),
    );
    existing.pendingConversions = addNums(
      existing.pendingConversions,
      first(row.pendingConversions, row.pendingOrders),
    );
    existing.rejectedConversions = addNums(
      existing.rejectedConversions,
      first(row.rejectedConversions, row.rejectedOrders),
    );
    existing.commission = addNums(
      existing.commission,
      first(
        row.commission,
        row.publisher_commission,
        row.commissionAmount?.amount,
        row.commissionAmount,
        row.payout,
        row.Payout,
        row.ActionEarnings,
      ),
    );
    existing.originalOrderValue = addNums(
      existing.originalOrderValue,
      first(
        row.originalOrderValue,
        row.order_value,
        row.Amount,
        row.SaleAmount,
        row.saleAmount?.amount,
        row.saleAmount,
        row.conversion_value?.value,
        row.revenue,
      ),
    );
    existing._aggCount = (existing._aggCount || 1) + 1;
    // Do not invent mboLinkClicks while aggregating network rows.
    if (existing.mboLinkClicks == null && row.mboLinkClicks == null) {
      existing.mboLinkClicks = null;
    }
  }
  return [...buckets.values()];
}

/**
 * Resolve campaign identity for reporting rows that only have campaignName
 * (Optimise default dimensions historically). Unique name match only.
 */
async function enrichFactInputFromCampaignCatalog(input, db = prisma) {
  if (!input?.supplier) return input;
  if (input.supplierCampaignId && input.brandName) return input;

  let campaign = null;
  if (input.supplierCampaignId) {
    campaign = await db.supplierCampaign.findFirst({
      where: {
        supplier: input.supplier,
        sourceAccountLabel: input.sourceAccountLabel || "default",
        supplierCampaignId: String(input.supplierCampaignId),
      },
      select: {
        id: true,
        supplierCampaignId: true,
        campaignName: true,
        merchantNameRaw: true,
        trackingUrl: true,
        merchant: { select: { displayName: true } },
        campaignSources: {
          select: { id: true, isPrimary: true },
          take: 1,
          orderBy: [{ isPrimary: "desc" }, { isActive: "desc" }],
        },
      },
    });
  } else if (input.campaignName) {
    const matches = await db.supplierCampaign.findMany({
      where: {
        supplier: input.supplier,
        sourceAccountLabel: input.sourceAccountLabel || "default",
        campaignName: { equals: String(input.campaignName).trim(), mode: "insensitive" },
      },
      select: {
        id: true,
        supplierCampaignId: true,
        campaignName: true,
        merchantNameRaw: true,
        trackingUrl: true,
        merchant: { select: { displayName: true } },
        campaignSources: {
          select: { id: true, isPrimary: true },
          take: 1,
          orderBy: [{ isPrimary: "desc" }, { isActive: "desc" }],
        },
      },
      take: 3,
    });
    campaign = matches.length === 1 ? matches[0] : null;
  }

  if (!campaign) return input;
  const source = campaign.campaignSources?.[0] || null;
  return hydratePerformanceIdentityFromCampaign(
    {
      ...input,
      supplierCampaignDbId: input.supplierCampaignDbId || campaign.id || null,
    },
    campaign,
    source,
  );
}

/**
 * Upsert Facts from in-memory performance rows (preferred right after sync fetch).
 * @returns {{ attempted: number, upserted: number, skipped: number }}
 */
export async function promotePerformanceRowsToFacts(
  rows = [],
  {
    networkSource,
    sourceAccountLabel = "default",
    sourceEndpoint = null,
    portalService = null,
    aggregateDaily = false,
  } = {},
) {
  const portal = portalService ?? new NetworkPortalService();
  const db = portal.db ?? prisma;
  const prepared = aggregateDaily ? aggregatePerformanceRowsByGrain(rows) : rows;
  let attempted = 0;
  let upserted = 0;
  let skipped = 0;
  for (const row of prepared) {
    attempted += 1;
    let input = mapPerformanceRowToFactInput(row, {
      networkSource,
      sourceAccountLabel,
      sourceEndpoint,
    });
    if (!input) {
      skipped += 1;
      continue;
    }
    try {
      input = await enrichFactInputFromCampaignCatalog(input, db);
      await portal.upsertNetworkPerformanceFact(input);
      upserted += 1;
    } catch {
      skipped += 1;
    }
  }
  return { attempted, upserted, skipped };
}

/**
 * Deterministic MBO click join into NetworkPerformanceFact.
 *
 * Semantic:
 * - When a campaignSourceId (or resolvable CampaignSource) exists for the fact grain:
 *   mboLinkClicks = COUNT(Click) for that source on reportDate (including 0).
 * - When no CampaignSource join key exists: leave mboLinkClicks unchanged/null
 *   (unavailable) — never copy networkClicks.
 *
 * networkClicks and mboLinkClicks remain independent metrics.
 *
 * @returns {{ examined: number, updated: number, unresolved: number }}
 */
export async function enrichFactsWithMboLinkClicks({
  db = prisma,
  supplier = null,
  sourceAccountLabel = null,
  reportDateFrom = null,
  reportDateTo = null,
  take = 5000,
} = {}) {
  const where = {};
  if (supplier) where.supplier = String(supplier).toUpperCase();
  if (sourceAccountLabel) where.sourceAccountLabel = sourceAccountLabel;
  if (reportDateFrom || reportDateTo) {
    where.reportDate = {};
    if (reportDateFrom) where.reportDate.gte = toDateOnly(reportDateFrom);
    if (reportDateTo) where.reportDate.lte = toDateOnly(reportDateTo);
  }

  const facts = await db.networkPerformanceFact.findMany({
    where,
    select: {
      id: true,
      supplier: true,
      sourceAccountLabel: true,
      reportDate: true,
      campaignSourceId: true,
      supplierCampaignDbId: true,
      supplierCampaignId: true,
      networkClicks: true,
      mboLinkClicks: true,
    },
    take,
    orderBy: { reportDate: "desc" },
  });

  let examined = 0;
  let updated = 0;
  let unresolved = 0;

  for (const fact of facts) {
    examined += 1;
    const bounds = dayBoundsUtc(fact.reportDate);
    if (!bounds) {
      unresolved += 1;
      continue;
    }

    let sourceIds = [];
    if (fact.campaignSourceId) {
      sourceIds = [fact.campaignSourceId];
    } else if (fact.supplierCampaignDbId) {
      const sources = await db.campaignSource.findMany({
        where: { supplierCampaignId: fact.supplierCampaignDbId },
        select: { id: true },
      });
      sourceIds = sources.map((s) => s.id);
    } else if (fact.supplierCampaignId) {
      const sc = await db.supplierCampaign.findFirst({
        where: {
          supplier: fact.supplier,
          supplierCampaignId: String(fact.supplierCampaignId),
          sourceAccountLabel: fact.sourceAccountLabel || "default",
        },
        select: { id: true, campaignSources: { select: { id: true } } },
      });
      sourceIds = (sc?.campaignSources || []).map((s) => s.id);
    }

    if (!sourceIds.length) {
      unresolved += 1;
      continue;
    }

    const count = await db.click.count({
      where: {
        campaignSourceId: sourceIds.length === 1 ? sourceIds[0] : { in: sourceIds },
        clickedAt: { gte: bounds.start, lt: bounds.end },
      },
    });

    // Explicit: join succeeded → real zero is allowed; never set equal to networkClicks.
    if (fact.mboLinkClicks === count) continue;

    await db.networkPerformanceFact.update({
      where: { id: fact.id },
      data: {
        mboLinkClicks: count,
        campaignSourceId: fact.campaignSourceId || sourceIds[0] || null,
        lastUpdatedAt: new Date(),
      },
    });
    updated += 1;
  }

  return { examined, updated, unresolved };
}

/**
 * Pointer 13 — Performance stays separate from OrderConversion.
 * Coupon codes on performance facts must come from the performance source object only.
 * @deprecated Cross-object backfill disabled; retained for sync.job call-site compatibility.
 */
export async function enrichFactsWithConversionCoupons() {
  return {
    examined: 0,
    updated: 0,
    unresolved: 0,
    skipped: true,
    reason: "POINTER_13_PERFORMANCE_ORDER_SEPARATION",
  };
}
