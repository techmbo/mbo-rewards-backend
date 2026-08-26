import { createSupplierAdapter } from "../adapters/registry.js";
import { upsertManyRawEntities } from "../modules/raw/raw.service.js";
import {
  getMarketplaceApiKey,
  getMarketplaceExternalId,
  getMarketplaceRefreshToken,
  getOAuthAccessToken,
} from "../modules/integrations/oauth.service.js";
import {
  enrichFactsWithMboLinkClicks,
  promotePerformanceRowsToFacts,
} from "../modules/networkPortal/networkPerformanceFact.ingestion.js";
import { updateAccountSyncTimestamps } from "./syncTimestamps.js";

/**
 * Wave E — Impact / Partnerize / Awin sync via registry + RawPayload staging.
 * Skips when credentials are absent. Never creates FinancialTransaction.
 *
 * P1.14.1: also promotes conversion-derived NetworkPerformanceFact rows and
 * enriches mboLinkClicks from Click join (never copies networkClicks).
 */

async function stampWaveESync(platform, accountLabel, { campaigns, conversions, payments, coupons }) {
  const now = new Date();
  const data = { lastSuccessfulSync: now };
  if (campaigns > 0) data.lastCampaignSyncAt = now;
  if (conversions > 0) data.lastOrderSyncAt = now;
  if (payments > 0) data.lastPaymentSyncAt = now;
  if (coupons > 0) data.lastCouponSyncAt = now;
  await updateAccountSyncTimestamps(platform, accountLabel || "default", data);
}

async function resolveImpactCredentials(accountLabel = "default") {
  const sid =
    process.env.IMPACT_ACCOUNT_SID ||
    (await getMarketplaceApiKey("impact", accountLabel)) ||
    null;
  const token =
    process.env.IMPACT_AUTH_TOKEN ||
    (await getOAuthAccessToken("impact", accountLabel)) ||
    null;
  if (sid && String(sid).includes(":") && !token) {
    const [a, b] = String(sid).split(":");
    return { accountSid: a, authToken: b };
  }
  if (sid && token) return { accountSid: sid, authToken: token };
  return null;
}

async function resolvePartnerizeCredentials(accountLabel = "default") {
  const appKey =
    process.env.PARTNERIZE_APPLICATION_KEY ||
    (await getMarketplaceApiKey("partnerize", accountLabel)) ||
    null;
  const userKey =
    process.env.PARTNERIZE_USER_API_KEY ||
    (await getMarketplaceRefreshToken("partnerize", accountLabel)) ||
    (await getOAuthAccessToken("partnerize", accountLabel)) ||
    null;
  if (appKey && String(appKey).includes(":") && !userKey) {
    const idx = String(appKey).indexOf(":");
    return {
      applicationKey: String(appKey).slice(0, idx),
      userApiKey: String(appKey).slice(idx + 1),
    };
  }
  if (appKey && userKey) {
    const publisherId =
      process.env.PARTNERIZE_PUBLISHER_ID ||
      (await getMarketplaceExternalId("partnerize", accountLabel)) ||
      null;
    return { applicationKey: appKey, userApiKey: userKey, publisherId };
  }
  return null;
}

async function resolveAwinCredentials(accountLabel = "default") {
  const accessToken =
    process.env.AWIN_ACCESS_TOKEN ||
    (await getOAuthAccessToken("awin", accountLabel)) ||
    (await getMarketplaceApiKey("awin", accountLabel)) ||
    null;
  const publisherId =
    process.env.AWIN_PUBLISHER_ID ||
    (await getMarketplaceExternalId("awin", accountLabel)) ||
    null;
  if (accessToken && publisherId) return { accessToken, publisherId };
  return null;
}

function normalizeImpactCampaign(row) {
  const id = row?.CampaignId ?? row?.Id ?? row?.id ?? null;
  return { ...row, id, campaign_id: row?.campaign_id ?? id };
}

function normalizeImpactAction(row) {
  const id = row?.Id ?? row?.ActionId ?? row?.id ?? null;
  return {
    ...row,
    id,
    conversionId: id,
    // Preserve Impact SubIds for AttributionService via conversion promotion
  };
}

function normalizePartnerizeCampaign(row) {
  const nested = row?.campaign && typeof row.campaign === "object" ? row.campaign : null;
  const base = nested ? { ...nested, ...row } : row;
  const id = base?.campaign_id ?? base?.campaignId ?? base?.id ?? null;
  return { ...base, id, campaign_id: id };
}

function normalizePartnerizeConversion(row) {
  const nested = row?.conversion && typeof row.conversion === "object" ? row.conversion : null;
  const base = nested ? { ...nested, ...row } : row;
  const id = base?.conversion_id ?? base?.conversionId ?? base?.id ?? null;
  return { ...base, id, conversionId: id };
}

function normalizeImpactCatalogItem(row) {
  const id =
    row?.Id ??
    row?.CatalogItemId ??
    row?.Sku ??
    row?.SKU ??
    row?.id ??
    row?.sku ??
    null;
  return { ...row, id, sku: row?.Sku ?? row?.SKU ?? row?.sku ?? id };
}

function normalizePartnerizeVoucher(row) {
  const id = row?.voucher_code_id ?? row?.id ?? null;
  const code = row?.voucher_code ?? row?.code ?? null;
  return {
    ...row,
    id: id != null ? String(id) : code != null ? String(code) : null,
    voucher_code: code != null ? String(code) : null,
    campaign_id: row?.campaign_id != null ? String(row.campaign_id) : null,
  };
}

export async function syncImpactAccount(accountLabel = "default") {
  const creds = await resolveImpactCredentials(accountLabel);
  if (!creds) {
    return {
      skipped: true,
      reason: `No Impact credentials [${accountLabel}]. Set IMPACT_ACCOUNT_SID + IMPACT_AUTH_TOKEN or connect Integrations.`,
    };
  }

  const adapter = createSupplierAdapter("IMPACT", creds);
  const stats = { requestCount: 0 };

  const impactDaysBack = Number(process.env.IMPACT_SYNC_DAYS_BACK || 90);
  const impactTo = new Date();
  const impactFrom = new Date(impactTo);
  impactFrom.setUTCDate(impactFrom.getUTCDate() - impactDaysBack);
  const impactDateParams = {
    StartDate: impactFrom.toISOString().slice(0, 10),
    EndDate: impactTo.toISOString().slice(0, 10),
  };

  const campaigns = (await adapter.fetchCampaigns({}, stats)).map(normalizeImpactCampaign);
  const conversions = (await adapter.fetchConversions(impactDateParams, stats)).map(normalizeImpactAction);
  const products = (await adapter.fetchProducts({}, stats)).map(normalizeImpactCatalogItem);
  const performanceRows =
    typeof adapter.fetchPerformance === "function"
      ? await adapter.fetchPerformance({ prefetchedConversions: conversions }, stats)
      : [];

  await upsertManyRawEntities({
    networkSource: "impact",
    entityType: "campaign",
    rows: campaigns,
    externalIdPrefix: "impact-campaign",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
  });

  await upsertManyRawEntities({
    networkSource: "impact",
    entityType: "conversion",
    rows: conversions,
    externalIdPrefix: "impact-conversion",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
  });

  let productPromotion = null;
  if (products.length) {
    await upsertManyRawEntities({
      networkSource: "impact",
      entityType: "product",
      rows: products,
      externalIdPrefix: "impact-product",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
    });
    try {
      const { ProductPromotionService } = await import("../modules/product/productPromotion.service.js");
      productPromotion = await new ProductPromotionService().promoteBatch({
        networkSource: "impact",
        limit: Math.min(500, products.length),
      });
    } catch {
      productPromotion = { skipped: true, reason: "promotion_failed" };
    }
  }

  // Impact Promotions ≠ coupon codes — do not invent CouponCodeMaster rows.
  const factPromo = await promotePerformanceRowsToFacts(performanceRows, {
    networkSource: "impact",
    sourceAccountLabel: accountLabel || "default",
    sourceEndpoint: "impact:/Actions",
    aggregateDaily: true,
  });
  const mboClickEnrich = await enrichFactsWithMboLinkClicks({
    supplier: "IMPACT",
    sourceAccountLabel: accountLabel || "default",
  });

  await stampWaveESync("impact", accountLabel, {
    campaigns: campaigns.length,
    conversions: conversions.length,
    payments: 0,
    coupons: 0,
  });

  return {
    skipped: false,
    campaigns: campaigns.length,
    conversions: conversions.length,
    products: products.length,
    productPromotion,
    coupons: 0,
    couponCapability: "NOT_APPLICABLE",
    performanceFacts: factPromo,
    mboClickEnrich,
    stats,
  };
}

export async function syncPartnerizeAccount(accountLabel = "default") {
  const creds = await resolvePartnerizeCredentials(accountLabel);
  if (!creds) {
    return {
      skipped: true,
      reason: `No Partnerize credentials [${accountLabel}]. Set PARTNERIZE_APPLICATION_KEY + PARTNERIZE_USER_API_KEY or connect Integrations.`,
    };
  }

  const adapter = createSupplierAdapter("PARTNERIZE", {
    ...creds,
    publisherId: creds.publisherId || process.env.PARTNERIZE_PUBLISHER_ID || null,
  });
  const stats = { requestCount: 0 };

  const partnerizeDaysBack = Number(process.env.PARTNERIZE_SYNC_DAYS_BACK || 90);
  const partnerizeTo = new Date();
  const partnerizeFrom = new Date(partnerizeTo);
  partnerizeFrom.setUTCDate(partnerizeFrom.getUTCDate() - partnerizeDaysBack);
  const partnerizeDateParams = {
    start_date: partnerizeFrom.toISOString().slice(0, 10),
    end_date: partnerizeTo.toISOString().slice(0, 10),
  };

  const campaigns = (await adapter.fetchCampaigns({}, stats)).map(normalizePartnerizeCampaign);
  const conversions = (await adapter.fetchConversions(partnerizeDateParams, stats)).map(normalizePartnerizeConversion);
  const payments = await adapter.fetchPayments(partnerizeDateParams, stats);

  const campaignIds = campaigns.map((c) => c?.campaign_id ?? c?.id).filter(Boolean);
  const couponsRaw =
    typeof adapter.fetchCoupons === "function"
      ? await adapter.fetchCoupons({ campaignIds }, stats)
      : [];
  const coupons = couponsRaw.map(normalizePartnerizeVoucher).filter((r) => r.voucher_code);
  const performanceRows =
    typeof adapter.fetchPerformance === "function"
      ? await adapter.fetchPerformance({ prefetchedConversions: conversions }, stats)
      : [];

  await upsertManyRawEntities({
    networkSource: "partnerize",
    entityType: "campaign",
    rows: campaigns,
    externalIdPrefix: "partnerize-campaign",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
  });

  await upsertManyRawEntities({
    networkSource: "partnerize",
    entityType: "conversion",
    rows: conversions,
    externalIdPrefix: "partnerize-conversion",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
  });

  if (payments.length) {
    await upsertManyRawEntities({
      networkSource: "partnerize",
      entityType: "payment",
      rows: payments,
      externalIdPrefix: "partnerize-payment",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
    });
  }

  if (coupons.length) {
    await upsertManyRawEntities({
      networkSource: "partnerize",
      entityType: "coupon",
      rows: coupons,
      externalIdPrefix: "partnerize-coupon",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
    });
  }

  const factPromo = await promotePerformanceRowsToFacts(performanceRows, {
    networkSource: "partnerize",
    sourceAccountLabel: accountLabel || "default",
    sourceEndpoint: "partnerize:conversion_derived",
    aggregateDaily: true,
  });
  const mboClickEnrich = await enrichFactsWithMboLinkClicks({
    supplier: "PARTNERIZE",
    sourceAccountLabel: accountLabel || "default",
  });

  await stampWaveESync("partnerize", accountLabel, {
    campaigns: campaigns.length,
    conversions: conversions.length,
    payments: payments.length,
    coupons: coupons.length,
  });

  return {
    skipped: false,
    campaigns: campaigns.length,
    conversions: conversions.length,
    payments: payments.length,
    coupons: coupons.length,
    performanceFacts: factPromo,
    mboClickEnrich,
    stats,
    warning: stats?.campaignFetchHint || (campaigns.length === 0 && !creds.publisherId
      ? "Partnerize Publisher ID is missing. Add it from Partnerize console → Partner settings, then reconnect/sync."
      : undefined),
  };
}

export async function syncAwinAccount(accountLabel = "default") {
  const creds = await resolveAwinCredentials(accountLabel);
  if (!creds) {
    return {
      skipped: true,
      reason:
        `No Awin credentials [${accountLabel}]. Set AWIN_ACCESS_TOKEN + AWIN_PUBLISHER_ID or connect Integrations.`,
    };
  }

  const adapter = createSupplierAdapter("AWIN", creds);
  const stats = { requestCount: 0 };

  const awinDaysBack = Math.min(Number(process.env.AWIN_SYNC_DAYS_BACK || 30), 31);
  const awinTo = new Date();
  const awinFrom = new Date(awinTo);
  awinFrom.setUTCDate(awinFrom.getUTCDate() - awinDaysBack);
  const awinDateParams = {
    startDate: awinFrom.toISOString().slice(0, 10),
    endDate: awinTo.toISOString().slice(0, 10),
  };

  const campaigns = await adapter.fetchCampaigns({}, stats);
  const conversions = await adapter.fetchConversions(awinDateParams, stats);
  const couponsRaw =
    typeof adapter.fetchCoupons === "function" ? await adapter.fetchCoupons({}, stats).catch(() => []) : [];
  const performanceRows =
    typeof adapter.fetchPerformance === "function"
      ? await adapter.fetchPerformance({ prefetchedConversions: conversions }, stats)
      : [];

  await upsertManyRawEntities({
    networkSource: "awin",
    entityType: "campaign",
    rows: campaigns,
    externalIdPrefix: "awin-campaign",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
  });

  await upsertManyRawEntities({
    networkSource: "awin",
    entityType: "conversion",
    rows: conversions,
    externalIdPrefix: "awin-conversion",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
  });

  if (couponsRaw.length) {
    await upsertManyRawEntities({
      networkSource: "awin",
      entityType: "coupon",
      rows: couponsRaw,
      externalIdPrefix: "awin-coupon",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
    });
  }

  const factPromo = await promotePerformanceRowsToFacts(performanceRows, {
    networkSource: "awin",
    sourceAccountLabel: accountLabel || "default",
    sourceEndpoint: "awin:/transactions",
    aggregateDaily: true,
  });
  const mboClickEnrich = await enrichFactsWithMboLinkClicks({
    supplier: "AWIN",
    sourceAccountLabel: accountLabel || "default",
  });

  await stampWaveESync("awin", accountLabel, {
    campaigns: campaigns.length,
    conversions: conversions.length,
    payments: 0,
    coupons: couponsRaw.length,
  });

  return {
    skipped: false,
    campaigns: campaigns.length,
    conversions: conversions.length,
    coupons: couponsRaw.length,
    performanceFacts: factPromo,
    mboClickEnrich,
    stats,
  };
}
