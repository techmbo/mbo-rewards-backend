import { prisma } from "../database/prisma.js";
import { createBoostinyAdapter } from "../adapters/boostiny.adapter.js";
import { enrichBoostinyCouponsWithCampaignType } from "../modules/coupons/codeType.js";
import {
  isBoostinyPaymentRow,
  splitBoostinyPerformancePayload,
  boostinyPerformanceGranularity,
} from "../modules/boostiny/boostinyRecords.js";
import { createOptimiseAdapter } from "../adapters/optimise.adapter.js";
import {
  createTrackierAdapter,
  enrichTrackierCampaignsWithCategories,
  mapTrackierCouponRow,
  mapTrackierDealRow,
  mapTrackierReportRow,
  toTrackierApiDate,
} from "../adapters/trackier.adapter.js";
import { runWithConcurrency } from "../core/concurrency.js";
import {
  cleanupOptimiseCampaignDuplicates,
  loadCachedCampaignRows,
  upsertManyRawEntities,
} from "../modules/raw/raw.service.js";
import { asArray } from "../core/normalize.js";
import { resolveOptimiseCredentials } from "../modules/integrations/optimiseCredentials.js";
import {
  getMarketplaceApiKey,
  getOAuthAccessToken,
  getNetworkAccountSyncFlags,
  listMarketplaceAccounts,
} from "../modules/integrations/oauth.service.js";
import {
  CREDENTIAL_HEALTH,
  sanitizeSecretError,
} from "../modules/networkOps/networkAccount.contract.js";
import {
  enrichFactsWithMboLinkClicks,
  enrichFactsWithConversionCoupons,
  promotePerformanceRowsToFacts,
} from "../modules/networkPortal/networkPerformanceFact.ingestion.js";
import {
  AUTO_PROMOTE_AFTER_SYNC,
  AUTO_AGGREGATE_AFTER_SYNC,
  AGGREGATION_AFTER_SYNC_DAYS,
  DEFAULT_DAYS_BACK,
  SYNC_ACCOUNT_CONCURRENCY,
  SYNC_OVERLAP_DAYS,
} from "./syncConfig.js";
import { createSyncTimer, mergeTimings } from "./syncMetrics.js";
import {
  getAccountSyncTimestamps,
  shouldRefreshCampaigns,
  shouldRefreshCoupons,
  updateAccountSyncTimestamps,
} from "./syncTimestamps.js";
import { runWithSyncOptions, shouldPromoteAfterSync } from "./syncContext.js";
import {
  initSyncProgress,
  recordAccountSyncComplete,
  setSyncStage,
  setSyncTimings,
} from "./syncState.js";
import { resetFieldSyncCaches } from "../field-system/fieldSyncCache.js";
import {
  buildOptimiseSyncMetadata,
  summariseOptimiseResourceWarnings,
} from "./optimiseResourceSync.js";
import { joinUserMessages } from "./syncErrors.js";
import {
  buildTrackierSyncMetadata,
  summariseTrackierResourceWarnings,
} from "./trackierResourceSync.js";
import { logger } from "../platform/logging/logger.js";
import { syncImpactAccount, syncPartnerizeAccount, syncAwinAccount } from "./waveESupplierSync.js";
import { syncAdmitadAccount } from "./admitadSupplierSync.js";
import { syncRakutenAccount } from "./rakutenSupplierSync.js";
import {
  fetchOptimiseSourceObject,
  fetchTrackierSourceObject,
  includeSourceObject,
  requestedSourceObject,
  resolveNetworkAccountId,
  runLiveSourceObject,
  runUnavailableIfRequested,
  summarizeSourceObjectRun,
  evidenceFromRunSummary,
} from "./sourceObjectRuns.js";
import { resultRows } from "../modules/networkOps/sourceObjectSync.service.js";

/** Phase 11 — accumulates per-account timings for SyncJobLog without changing API result shapes. */
const accountTimingsCollector = [];

function recordAccountTimings(timings) {
  if (timings && Object.keys(timings).length > 0) {
    accountTimingsCollector.push(timings);
  }
}

function drainAccountTimings() {
  const merged = mergeTimings(...accountTimingsCollector);
  accountTimingsCollector.length = 0;
  return merged;
}

async function logJob({ jobName, status, message, metadata, attempt }) {
  await prisma.syncJobLog.create({
    data: {
      jobName,
      status,
      message,
      metadata,
      attempt,
    },
  });
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Incremental start date: lastSuccessfulSync minus a small overlap window
 * so late-arriving rows are caught without re-fetching the full history.
 */
export function incrementalFromDate(lastSuccessfulSync, overlapDays = SYNC_OVERLAP_DAYS) {
  const base = new Date(lastSuccessfulSync);
  const overlap = Math.max(0, Number(overlapDays) || 0);
  base.setUTCDate(base.getUTCDate() - overlap);
  return toISODate(base);
}

/**
 * Phase 1 — incremental date window when lastSuccessfulSync exists; explicit env vars override.
 */
function getBoostinyReportRange(lastSuccessfulSync) {
  const toEnv = String(process.env.BOOSTINY_REPORT_TO || "").trim();
  const fromEnv = String(process.env.BOOSTINY_REPORT_FROM || "").trim();
  const daysBack = Number(process.env.BOOSTINY_REPORT_DAYS_BACK || DEFAULT_DAYS_BACK);

  const to = toEnv || toISODate(new Date());

  if (fromEnv) {
    return { from: fromEnv, to };
  }

  if (lastSuccessfulSync) {
    return { from: incrementalFromDate(lastSuccessfulSync), to };
  }

  const from = toISODate(new Date(Date.now() - Math.max(daysBack, 1) * 24 * 60 * 60 * 1000));
  return { from, to };
}

function getOptimiseDateRange(lastSuccessfulSync) {
  const toEnv = String(process.env.OPTIMISE_CONVERSIONS_TO || "").trim();
  const fromEnv = String(process.env.OPTIMISE_CONVERSIONS_FROM || "").trim();
  const daysBack = Number(process.env.OPTIMISE_CONVERSIONS_DAYS_BACK || DEFAULT_DAYS_BACK);
  const dateField = String(process.env.OPTIMISE_CONVERSIONS_DATE_FIELD || "conversion").trim();
  const targetCurrencyCode = String(process.env.OPTIMISE_TARGET_CURRENCY_CODE || "USD").trim();

  const toDate = toEnv || toISODate(new Date());

  if (fromEnv) {
    return { fromDate: fromEnv, toDate, dateField, targetCurrencyCode };
  }

  if (lastSuccessfulSync) {
    return {
      fromDate: incrementalFromDate(lastSuccessfulSync),
      toDate,
      dateField,
      targetCurrencyCode,
    };
  }

  const fromDate = toISODate(new Date(Date.now() - Math.max(daysBack, 1) * 24 * 60 * 60 * 1000));
  return { fromDate, toDate, dateField, targetCurrencyCode };
}

function getOptimiseConversionsRange(lastSuccessfulSync) {
  return getOptimiseDateRange(lastSuccessfulSync);
}

function getOptimiseReportingRange(lastSuccessfulSync) {
  const range = getOptimiseDateRange(lastSuccessfulSync);
  return {
    fromDate: range.fromDate,
    toDate: range.toDate,
    targetCurrency: range.targetCurrencyCode,
    dateType: String(process.env.OPTIMISE_REPORTING_DATE_TYPE || "conversionDate").trim(),
    dateGroupBy: String(process.env.OPTIMISE_REPORTING_DATE_GROUP_BY || "daily").trim(),
  };
}

function getOptimisePaymentsRange(lastSuccessfulSync) {
  const range = getOptimiseDateRange(lastSuccessfulSync);
  return {
    startDate: range.fromDate,
    endDate: range.toDate,
  };
}

function getTrackierDateRange(lastSuccessfulSync) {
  const toEnv = String(process.env.TRACKIER_SYNC_TO || "").trim();
  const fromEnv = String(process.env.TRACKIER_SYNC_FROM || "").trim();
  const daysBack = Number(process.env.TRACKIER_SYNC_DAYS_BACK || DEFAULT_DAYS_BACK);

  const end = toTrackierApiDate(toEnv) || toISODate(new Date());

  if (fromEnv) {
    return { start: toTrackierApiDate(fromEnv), end };
  }

  if (lastSuccessfulSync) {
    return {
      start: incrementalFromDate(lastSuccessfulSync),
      end,
    };
  }

  const start = toISODate(new Date(Date.now() - Math.max(daysBack, 1) * 24 * 60 * 60 * 1000));
  return { start, end };
}

function hasPositiveMetric(row, keys) {
  return keys.some((key) => {
    const value = row[key];
    if (value === null || value === undefined) return false;
    if (typeof value === "number") return Number.isFinite(value) && value > 0;
    if (typeof value === "string") {
      const normalized = value.replace(/[^0-9.-]/g, "");
      const parsed = Number(normalized);
      return Number.isFinite(parsed) && parsed > 0;
    }
    return false;
  });
}

function isMeaningfulPerformanceRow(row) {
  if (!row || typeof row !== "object") return false;

  const boostinyMetrics = [
    "orders",
    "net_orders",
    "revenue",
    "net_revenue",
    "sales_amount_usd",
    "net_sales_amount_usd",
    "aov_usd",
    "net_aov_usd",
  ];

  const optimiseMetrics = [
    "clicks",
    "totalConversions",
    "validatedConversions",
    "pendingConversions",
    "rejectedConversions",
    "validatedCommission",
    "originalOrderValue",
    "conversionValue",
    "commission",
  ];

  const trackierMetrics = [
    "clicks",
    "approvedConversions",
    "payout",
    "revenue",
    "profit",
    "totalConversions",
    "validatedConversions",
    "validatedCommission",
    "originalOrderValue",
  ];

  return (
    hasPositiveMetric(row, boostinyMetrics) ||
    hasPositiveMetric(row, optimiseMetrics) ||
    hasPositiveMetric(row, trackierMetrics)
  );
}

function hasAnyPerformanceSignal(row) {
  if (!row || typeof row !== "object") return false;
  return Object.values(row).some((value) => value !== null && value !== undefined);
}

function buildBoostinySummaryRows(performanceSummaries, { from, to }) {
  return asArray(performanceSummaries)
    .filter((row) => hasAnyPerformanceSignal(row))
    .map((summary) => ({
      ...summary,
      report_type: "summary",
      period_from: from,
      period_to: to,
    }));
}

function tagReportingRows(rows, reportType) {
  return asArray(rows).map((row) => ({
    ...row,
    report_type: reportType,
  }));
}

function createEntityTimingCollector() {
  const totals = { dbWriteMs: 0, fieldExtractionMs: 0 };
  return {
    onTiming({ dbWriteMs, fieldExtractionMs }) {
      totals.dbWriteMs += dbWriteMs || 0;
      totals.fieldExtractionMs += fieldExtractionMs || 0;
    },
    totals,
  };
}

/**
 * Persist sync watermarks.
 * On partialSuccess, do NOT advance lastSuccessfulSync so the next run
 * still re-fetches the same date window for failed resources.
 * Campaign/coupon TTL stamps still advance when those resources refreshed OK.
 * Order/payment stamps advance when those resources refreshed OK (Network Health).
 */
async function markAccountSyncSuccess(
  platform,
  accountLabel,
  {
    refreshedCampaigns,
    refreshedCoupons,
    refreshedOrders = false,
    refreshedPayments = false,
    advanceLastSuccessfulSync = true,
  },
) {
  const now = new Date();
  const data = {};
  if (advanceLastSuccessfulSync) data.lastSuccessfulSync = now;
  if (refreshedCampaigns) data.lastCampaignSyncAt = now;
  if (refreshedCoupons) data.lastCouponSyncAt = now;
  if (refreshedOrders) data.lastOrderSyncAt = now;
  if (refreshedPayments) data.lastPaymentSyncAt = now;
  data.lastSyncError = null;
  data.credentialHealth = CREDENTIAL_HEALTH.HEALTHY;
  if (Object.keys(data).length === 0) return;
  await updateAccountSyncTimestamps(platform, accountLabel, data);
}

async function markAccountSyncFailure(platform, accountLabel, error) {
  const { handleSyncAuthFailure } = await import("../modules/ops/syncAlert.service.js");
  const paused = await handleSyncAuthFailure({ platform, accountLabel, error });
  if (paused) return;

  const lastSyncError = sanitizeSecretError(error?.message || error || "Sync failed") || "Sync failed";
  await updateAccountSyncTimestamps(platform, accountLabel, {
    lastSyncError,
    credentialHealth: CREDENTIAL_HEALTH.FAILED,
  });
}

/**
 * Phase 2 — sync multiple accounts with controlled concurrency; failures are isolated.
 */
async function syncAccountsWithConcurrency(accountLabels, syncFn, { platform } = {}) {
  const result = {};
  await runWithConcurrency(accountLabels, SYNC_ACCOUNT_CONCURRENCY, async (label) => {
    try {
      const accountResult = await syncFn(label);
      result[label] = accountResult;
      const failed = Boolean(accountResult?.failed);
      const skipped = Boolean(accountResult?.skipped);
      if (failed && platform) {
        await markAccountSyncFailure(platform, label, accountResult.error);
      }
      recordAccountSyncComplete({ success: !failed && !skipped });
    } catch (error) {
      result[label] = { failed: true, error: sanitizeSecretError(error?.message) || "Sync failed" };
      if (platform) {
        await markAccountSyncFailure(platform, label, error);
      }
      recordAccountSyncComplete({ success: false });
    }
  });
  return result;
}

async function countAllSyncAccounts() {
  const boostinyAccounts = await listMarketplaceAccounts("boostiny");
  const trackierAccounts = await listMarketplaceAccounts("trackier");
  const impactAccounts = await listMarketplaceAccounts("impact");
  const partnerizeAccounts = await listMarketplaceAccounts("partnerize");
  const awinAccounts = await listMarketplaceAccounts("awin");
  const admitadAccounts = await listMarketplaceAccounts("admitad");
  const rakutenAccounts = await listMarketplaceAccounts("rakuten");
  let total =
    boostinyAccounts.length +
    trackierAccounts.length +
    impactAccounts.length +
    partnerizeAccounts.length +
    awinAccounts.length +
    admitadAccounts.length +
    rakutenAccounts.length;
  for (const region of ["sea", "mena", "uk"]) {
    // eslint-disable-next-line no-await-in-loop
    const accounts = await listMarketplaceAccounts(`optimise_${region}`);
    total += accounts.length;
  }
  return total;
}

async function countSyncAccountsForPlatform(platform, accountLabel) {
  if (accountLabel) return 1;

  if (platform === "boostiny") {
    const accounts = await listMarketplaceAccounts("boostiny");
    return [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))].length;
  }

  if (platform.startsWith("optimise_")) {
    const accounts = await listMarketplaceAccounts(platform);
    return [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))].length;
  }

  if (platform === "trackier") {
    const accounts = await listMarketplaceAccounts("trackier");
    return [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))].length;
  }

  if (["impact", "partnerize", "awin", "admitad", "rakuten"].includes(platform)) {
    const accounts = await listMarketplaceAccounts(platform);
    return [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))].length;
  }

  return 0;
}

function resolvePlatformStage(platform) {
  if (platform === "boostiny") return "boostiny";
  if (platform.startsWith("optimise_")) return "optimise";
  if (platform === "trackier") return "trackier";
  return platform;
}

async function syncBoostinyAccount(accountLabel) {
  const accountTimer = createSyncTimer();
  accountTimer.start("accountSyncMs");

  const flags = await getNetworkAccountSyncFlags("boostiny", accountLabel);
  if (flags.exists && flags.syncEnabled === false) {
    accountTimer.end("accountSyncMs");
    return {
      skipped: true,
      reason: `Catalog sync is disabled for Boostiny account [${accountLabel || "default"}].`,
    };
  }

  const boostinyApiKey =
    (await getMarketplaceApiKey("boostiny", accountLabel)) ||
    (await getOAuthAccessToken("boostiny", accountLabel)) ||
    process.env.BOOSTINY_API_KEY ||
    null;
  if (!boostinyApiKey) {
    accountTimer.end("accountSyncMs");
    return {
      skipped: true,
      reason: `No connected Boostiny account [${accountLabel || "default"}]. Connect on the Integrations page.`,
    };
  }

  const timestamps = await getAccountSyncTimestamps("boostiny", accountLabel);
  const { from, to } = getBoostinyReportRange(timestamps?.lastSuccessfulSync);
  const refreshCampaigns = shouldRefreshCampaigns(timestamps?.lastCampaignSyncAt);
  const refreshCoupons = shouldRefreshCoupons(timestamps?.lastCouponSyncAt);
  const networkAccountId = await resolveNetworkAccountId("boostiny", accountLabel);
  const requested = requestedSourceObject();
  const unavailable = await runUnavailableIfRequested({
    network: "boostiny",
    networkAccountId,
    requested,
  });
  if (unavailable) {
    accountTimer.end("accountSyncMs");
    return unavailable;
  }

  const adapter = createBoostinyAdapter({
    apiKey: boostinyApiKey,
    baseURL: process.env.BOOSTINY_BASE_URL || "https://api.boostiny.com",
    endpoints: {
      campaigns: process.env.BOOSTINY_CAMPAIGNS_ENDPOINT,
      performance: process.env.BOOSTINY_REPORTS_ENDPOINT,
      linkPerformance: process.env.BOOSTINY_LINK_REPORTS_ENDPOINT,
      coupons: process.env.BOOSTINY_COUPONS_ENDPOINT,
    },
  });

  const runCtx = { network: "boostiny", networkAccountId };
  const sourceObjectRuns = [];
  const stats = { requestCount: 0 };
  const usePerCampaign =
    String(process.env.BOOSTINY_PER_CAMPAIGN_PERFORMANCE || "").toLowerCase() === "true";

  accountTimer.start("apiFetchMs");

  let campaigns = [];
  if (includeSourceObject(requested, "campaigns") && refreshCampaigns) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "campaigns",
      endpoint: "GET campaigns",
      execute: () => adapter.fetchCampaigns(undefined, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    campaigns = resultRows(run);
  }

  let performanceRows = [];
  let performanceSummaries = [];
  let usedPerCampaignPerformance = null;
  let campaignPerformanceCount = 0;
  if (includeSourceObject(requested, "api_reports")) {
    const campaignsForPerf =
      campaigns.length > 0 ? campaigns : await loadCachedCampaignRows("boostiny", accountLabel);
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "api_reports",
      endpoint: "GET performance reports",
      execute: () =>
        adapter.fetchPerformanceReport({ from, to }, stats, {
          campaigns: campaignsForPerf,
          usePerCampaign,
        }),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    if (run.status === "SUCCEEDED" && run.result) {
      performanceRows = run.result.performanceRows || [];
      performanceSummaries = run.result.performanceSummaries || [];
      usedPerCampaignPerformance = run.result.usedPerCampaignPerformance ?? null;
      campaignPerformanceCount = run.result.campaignPerformanceCount ?? performanceRows.length;
    }
  }

  let linkPerformance = [];
  if (includeSourceObject(requested, "link_reports")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "link_reports",
      endpoint: "GET link performance",
      execute: () => adapter.fetchLinkPerformance({ from, to }, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    linkPerformance = resultRows(run).map((row) => ({
      ...row,
      report_type: "link_performance",
    }));
  }

  let coupons = [];
  if (includeSourceObject(requested, "coupons") && refreshCoupons) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "coupons",
      endpoint: "GET coupons",
      execute: () => adapter.fetchCoupons(undefined, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    coupons = resultRows(run);
  }

  accountTimer.end("apiFetchMs");

  const payload = {
    campaigns,
    performanceRows,
    performanceSummaries,
    linkPerformance,
    coupons,
    apiRequestCount: stats.requestCount,
    usedPerCampaignPerformance,
    campaignPerformanceCount,
  };

  const campaignsForEnrichment =
    refreshCampaigns && includeSourceObject(requested, "campaigns") && payload.campaigns.length
      ? payload.campaigns
      : await loadCachedCampaignRows("boostiny", accountLabel);

  const performanceSummaryRows = buildBoostinySummaryRows(payload.performanceSummaries, { from, to });
  const detailPerformanceRows = payload.performanceRows.filter(
    (row) => isMeaningfulPerformanceRow(row) && !isBoostinyPaymentRow(row),
  );
  const { conversions: boostinyConversions, payments: boostinyPayments } = splitBoostinyPerformancePayload(
    detailPerformanceRows,
    performanceSummaryRows,
    campaignsForEnrichment,
  );
  // Only order-level rows (have order_id) become conversion entities / Orders.
  // Campaign/day aggregates stay as performance — never invent fake conversion ids.
  const boostinyConversionRows = boostinyConversions.filter(
    (row) => boostinyPerformanceGranularity(row).granularity === "ORDER_LEVEL",
  );

  const accountPrefix =
    accountLabel && accountLabel !== "default" ? `${accountLabel}:` : "";

  const entityTiming = createEntityTimingCollector();

  if (includeSourceObject(requested, "api_reports")) {
    await prisma.entity.deleteMany({
      where: {
        networkSource: "boostiny",
        entityType: "performance",
        externalId: {
          startsWith: `${accountPrefix}boostiny-performance-summary-`,
        },
      },
    });
  }

  if (refreshCampaigns && includeSourceObject(requested, "campaigns")) {
    await upsertManyRawEntities({
      networkSource: "boostiny",
      entityType: "campaign",
      rows: payload.campaigns,
      externalIdPrefix: "boostiny-campaign",
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((r) => r?.sourceObject === "campaigns"),
      ),
    });
  }

  const factPromo = { upserted: 0 };
  const mboClickEnrich = { updated: 0 };
  let paymentsToStore = [];

  if (includeSourceObject(requested, "api_reports")) {
    await upsertManyRawEntities({
      networkSource: "boostiny",
      entityType: "performance",
      rows: detailPerformanceRows,
      externalIdPrefix: "boostiny-performance",
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((r) => r?.sourceObject === "api_reports"),
        { requestWindow: { from, to } },
      ),
    });
    Object.assign(
      factPromo,
      await promotePerformanceRowsToFacts(detailPerformanceRows, {
        networkSource: "boostiny",
        sourceAccountLabel: accountLabel || "default",
        sourceEndpoint: "boostiny.performance",
      }),
    );
    Object.assign(
      mboClickEnrich,
      await enrichFactsWithMboLinkClicks({
        supplier: "BOOSTINY",
        sourceAccountLabel: accountLabel || "default",
      }),
    );
    paymentsToStore = flags.financeSyncEnabled ? boostinyPayments : [];
    await upsertManyRawEntities({
      networkSource: "boostiny",
      entityType: "payment",
      rows: paymentsToStore,
      externalIdPrefix: "boostiny-payment",
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((r) => r?.sourceObject === "api_reports"),
        { requestWindow: { from, to } },
      ),
    });
    await upsertManyRawEntities({
      networkSource: "boostiny",
      entityType: "conversion",
      rows: boostinyConversionRows,
      externalIdPrefix: "boostiny-conversion",
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((r) => r?.sourceObject === "api_reports"),
        { requestWindow: { from, to } },
      ),
    });
  }

  if (includeSourceObject(requested, "link_reports")) {
    await upsertManyRawEntities({
      networkSource: "boostiny",
      entityType: "link",
      rows: payload.linkPerformance,
      externalIdPrefix: "boostiny-link",
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((r) => r?.sourceObject === "link_reports"),
        { requestWindow: { from, to } },
      ),
    });
  }

  if (refreshCoupons && includeSourceObject(requested, "coupons")) {
    const boostinyCoupons = enrichBoostinyCouponsWithCampaignType(
      payload.coupons,
      campaignsForEnrichment,
    );
    await upsertManyRawEntities({
      networkSource: "boostiny",
      entityType: "coupon",
      rows: boostinyCoupons,
      externalIdPrefix: "boostiny-coupon",
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((r) => r?.sourceObject === "coupons"),
      ),
    });
  }

  await markAccountSyncSuccess("boostiny", accountLabel, {
    refreshedCampaigns: refreshCampaigns && includeSourceObject(requested, "campaigns"),
    refreshedCoupons: refreshCoupons && includeSourceObject(requested, "coupons"),
    refreshedOrders:
      includeSourceObject(requested, "api_reports") &&
      (boostinyConversionRows.length > 0 || detailPerformanceRows.length > 0),
    refreshedPayments: includeSourceObject(requested, "api_reports") && paymentsToStore.length > 0,
  });

  accountTimer.end("accountSyncMs");
  accountTimer.add("dbWriteMs", entityTiming.totals.dbWriteMs);
  accountTimer.add("fieldExtractionMs", entityTiming.totals.fieldExtractionMs);
  recordAccountTimings(accountTimer.toObject());

  return {
    accountLabel: accountLabel || "default",
    campaigns: refreshCampaigns ? payload.campaigns.length : 0,
    performanceRows: detailPerformanceRows.length,
    networkPerformanceFacts: factPromo.upserted,
    mboLinkClickEnrich: mboClickEnrich.updated,
    campaignPerformanceRows: payload.campaignPerformanceCount ?? 0,
    payments: paymentsToStore.length,
    conversions: boostinyConversionRows.length,
    linkPerformance: payload.linkPerformance.length,
    coupons: refreshCoupons ? payload.coupons.length : 0,
    apiRequestCount: payload.apiRequestCount ?? null,
    usedPerCampaignPerformance: payload.usedPerCampaignPerformance ?? null,
    incrementalFrom: from,
    skippedCampaignRefresh: !refreshCampaigns,
    skippedCouponRefresh: !refreshCoupons,
    sourceObjectRuns: sourceObjectRuns.filter(Boolean),
  };
}

async function syncBoostiny() {
  const accounts = await listMarketplaceAccounts("boostiny");
  const accountLabels = [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))];
  if (accountLabels.length === 0) {
    return {
      skipped: true,
      reason: "No Boostiny accounts connected. Connect on the Integrations page.",
    };
  }

  setSyncStage("boostiny");
  return syncAccountsWithConcurrency(accountLabels, syncBoostinyAccount, { platform: "boostiny" });
}

async function syncOptimiseRegion(region, accountLabel) {
  const accountTimer = createSyncTimer();
  accountTimer.start("accountSyncMs");

  const regionUpper = region.toUpperCase();
  const platform = `optimise_${region}`;
  const credentials = await resolveOptimiseCredentials(region, accountLabel);

  if (!credentials.hasMarketplaceAccount) {
    accountTimer.end("accountSyncMs");
    return {
      skipped: true,
      reason: `No connected Optimise ${regionUpper} account [${credentials.accountLabel}]. Connect on the Integrations page.`,
    };
  }

  if (!credentials.apiKey) {
    accountTimer.end("accountSyncMs");
    return {
      skipped: true,
      reason: `Connected Optimise ${regionUpper} account [${credentials.accountLabel}] is missing an API key.`,
    };
  }

  if (!credentials.agencyId || !credentials.contactId) {
    accountTimer.end("accountSyncMs");
    return {
      skipped: true,
      reason: `Connected Optimise ${regionUpper} account [${credentials.accountLabel}] is missing Agency ID or Contact ID. Reconnect on Integrations.`,
    };
  }

  if (credentials.syncEnabled === false) {
    accountTimer.end("accountSyncMs");
    return {
      skipped: true,
      reason: `Catalog sync is disabled for Optimise ${regionUpper} account [${credentials.accountLabel}].`,
    };
  }

  const timestamps = await getAccountSyncTimestamps(platform, credentials.accountLabel);
  const refreshCampaigns = shouldRefreshCampaigns(timestamps?.lastCampaignSyncAt);
  const refreshCoupons = shouldRefreshCoupons(timestamps?.lastCouponSyncAt);
  const networkAccountId =
    credentials.networkAccountId || (await resolveNetworkAccountId(platform, credentials.accountLabel));
  const requested = requestedSourceObject();
  const unavailable = await runUnavailableIfRequested({
    network: platform,
    networkAccountId,
    requested,
  });
  if (unavailable) {
    accountTimer.end("accountSyncMs");
    return unavailable;
  }

  if (requested === "products") {
    const { syncOptimiseProductFeedsForAccount } = await import("./optimiseProductFeedSync.js");
    const run = await runLiveSourceObject({
      network: platform,
      networkAccountId,
      sourceObject: "products",
      endpoint: "product feed",
      execute: () => syncOptimiseProductFeedsForAccount(region, credentials.accountLabel),
    });
    accountTimer.end("accountSyncMs");
    return {
      accountLabel: credentials.accountLabel,
      region: regionUpper,
      sourceObjectRuns: [summarizeSourceObjectRun(run)].filter(Boolean),
    };
  }

  const adapter = createOptimiseAdapter({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseURL,
    agencyId: credentials.agencyId,
    contactId: credentials.contactId,
  });

  const paymentsRange = getOptimisePaymentsRange(timestamps?.lastSuccessfulSync);
  const conversionsRange = getOptimiseConversionsRange(timestamps?.lastSuccessfulSync);
  const reportingRange = getOptimiseReportingRange(timestamps?.lastSuccessfulSync);
  const srcCtx = { network: platform, networkAccountId, sourceObject: requested };

  accountTimer.start("apiFetchMs");

  // Independent Optimise source objects; failure of conversions must not fail campaigns.
  const [
    campaignsResult,
    conversionsResult,
    conversionsByPaymentResult,
    reportingResult,
    invoiceReportingResult,
    paymentsResult,
    invoicesResult,
    voucherCodesResult,
  ] = await Promise.all([
    refreshCampaigns
      ? fetchOptimiseSourceObject("campaigns", credentials, () => adapter.fetchCampaigns(), {}, srcCtx)
      : fetchOptimiseSourceObject(
          "campaigns",
          credentials,
          async () => [],
          { skipped: true, skipReason: "cache" },
          srcCtx,
        ),
    fetchOptimiseSourceObject(
      "conversions",
      credentials,
      () => adapter.fetchConversions(conversionsRange),
      {},
      srcCtx,
    ),
    fetchOptimiseSourceObject(
      "conversionsByPayment",
      credentials,
      () =>
        adapter.fetchConversions({
          ...conversionsRange,
          conversionType: "conversionsByPayment",
        }),
      {},
      srcCtx,
    ),
    fetchOptimiseSourceObject(
      "reporting",
      credentials,
      () => adapter.fetchReporting(reportingRange),
      {},
      srcCtx,
    ),
    credentials.financeSyncEnabled !== false
      ? fetchOptimiseSourceObject(
          "invoiceReporting",
          credentials,
          () => adapter.fetchInvoiceReporting(reportingRange),
          {},
          srcCtx,
        )
      : fetchOptimiseSourceObject(
          "invoiceReporting",
          credentials,
          async () => [],
          { skipped: true, skipReason: "finance_sync_disabled" },
          srcCtx,
        ),
    credentials.financeSyncEnabled !== false
      ? fetchOptimiseSourceObject(
          "payments",
          credentials,
          () => adapter.fetchPayments(paymentsRange),
          {},
          srcCtx,
        )
      : fetchOptimiseSourceObject(
          "payments",
          credentials,
          async () => [],
          { skipped: true, skipReason: "finance_sync_disabled" },
          srcCtx,
        ),
    credentials.financeSyncEnabled !== false
      ? fetchOptimiseSourceObject(
          "invoices",
          credentials,
          () => adapter.fetchInvoices(paymentsRange),
          {},
          srcCtx,
        )
      : fetchOptimiseSourceObject(
          "invoices",
          credentials,
          async () => [],
          { skipped: true, skipReason: "finance_sync_disabled" },
          srcCtx,
        ),
    refreshCoupons
      ? fetchOptimiseSourceObject(
          "voucherCodes",
          credentials,
          () => adapter.fetchVoucherCodes(),
          {},
          srcCtx,
        )
      : fetchOptimiseSourceObject(
          "voucherCodes",
          credentials,
          async () => [],
          { skipped: true, skipReason: "cache" },
          srcCtx,
        ),
  ]);

  accountTimer.end("apiFetchMs");

  const resourceResults = [
    campaignsResult,
    conversionsResult,
    conversionsByPaymentResult,
    reportingResult,
    invoiceReportingResult,
    paymentsResult,
    invoicesResult,
    voucherCodesResult,
  ];

  const warnings = summariseOptimiseResourceWarnings(resourceResults, credentials);
  const syncMetadata = buildOptimiseSyncMetadata(resourceResults, credentials, {
    refreshCampaigns,
    refreshCoupons,
  });

  const optimiseInvoices = asArray(invoicesResult.rows).map((row) => ({
    ...row,
    record_source: "invoice",
    id: row?.invoiceId ?? row?.id,
    netPayout: row?.net ?? row?.netPayout,
    vatPayout: row?.vat ?? row?.vatPayout,
    total: row?.gross ?? row?.total,
    publisherCurrencyCode: row?.currencySymbol ?? row?.publisherCurrencyCode,
  }));
  const networkSource = `optimise_${region}`;
  const reportingRows = tagReportingRows(reportingResult.rows, "conversion_date");
  const invoiceReportingRows = tagReportingRows(invoiceReportingResult.rows, "invoice_date");
  const conversionsByPayment = asArray(conversionsByPaymentResult.rows).map((row) => ({
    ...row,
    report_type: "conversions_by_payment",
  }));

  const entityTiming = createEntityTimingCollector();
  let removedDuplicateCampaigns = 0;

  if (refreshCampaigns) {
    await upsertManyRawEntities({
      networkSource,
      entityType: "campaign",
      rows: campaignsResult.rows,
      externalIdPrefix: `${networkSource}-campaign`,
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(campaignsResult.syncRun),
    });
    removedDuplicateCampaigns = await cleanupOptimiseCampaignDuplicates(networkSource, accountLabel);
  }

  await upsertManyRawEntities({
    networkSource,
    entityType: "performance",
    rows: reportingRows,
    externalIdPrefix: `${networkSource}-report`,
    sourceAccountKey: accountLabel,
    onTiming: entityTiming.onTiming,
    evidence: evidenceFromRunSummary(reportingResult.syncRun, {
      requestWindow: reportingRange,
    }),
  });
  await upsertManyRawEntities({
    networkSource,
    entityType: "performance",
    rows: invoiceReportingRows,
    externalIdPrefix: `${networkSource}-invoice-report`,
    sourceAccountKey: accountLabel,
    onTiming: entityTiming.onTiming,
    evidence: evidenceFromRunSummary(invoiceReportingResult.syncRun, {
      requestWindow: reportingRange,
    }),
  });
  const factPromo = await promotePerformanceRowsToFacts([...reportingRows, ...invoiceReportingRows], {
    networkSource,
    sourceAccountLabel: accountLabel || "default",
    sourceEndpoint: `${networkSource}.reporting`,
  });
  const mboClickEnrich = await enrichFactsWithMboLinkClicks({
    supplier: "OPTIMISE",
    sourceAccountLabel: accountLabel || "default",
  });
  await upsertManyRawEntities({
    networkSource,
    entityType: "conversion",
    rows: conversionsResult.rows,
    externalIdPrefix: `${networkSource}-conversion`,
    sourceAccountKey: accountLabel,
    onTiming: entityTiming.onTiming,
    evidence: evidenceFromRunSummary(conversionsResult.syncRun, {
      requestWindow: conversionsRange,
    }),
  });
  await upsertManyRawEntities({
    networkSource,
    entityType: "conversion",
    rows: conversionsByPayment,
    externalIdPrefix: `${networkSource}-conversion-by-payment`,
    sourceAccountKey: accountLabel,
    onTiming: entityTiming.onTiming,
    evidence: evidenceFromRunSummary(conversionsByPaymentResult.syncRun, {
      requestWindow: conversionsRange,
    }),
  });
  // Pointer 13 — performance coupon must come from the performance source object, not conversions.
  const couponEnrich = await enrichFactsWithConversionCoupons();
  result.conversionCouponEnrich = couponEnrich;
  await upsertManyRawEntities({
    networkSource,
    entityType: "payment",
    rows: paymentsResult.rows,
    externalIdPrefix: `${networkSource}-payment`,
    sourceAccountKey: accountLabel,
    onTiming: entityTiming.onTiming,
    evidence: evidenceFromRunSummary(paymentsResult.syncRun, {
      requestWindow: paymentsRange,
    }),
  });
  await upsertManyRawEntities({
    networkSource,
    entityType: "payment",
    rows: optimiseInvoices,
    externalIdPrefix: `${networkSource}-invoice`,
    sourceAccountKey: accountLabel,
    onTiming: entityTiming.onTiming,
    evidence: evidenceFromRunSummary(invoicesResult.syncRun, {
      requestWindow: paymentsRange,
    }),
  });

  if (refreshCoupons) {
    await upsertManyRawEntities({
      networkSource,
      entityType: "coupon",
      rows: voucherCodesResult.rows,
      externalIdPrefix: `${networkSource}-voucher`,
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(voucherCodesResult.syncRun),
    });
  }

  const savedCounts = {
    campaigns: refreshCampaigns ? campaignsResult.rows.length : 0,
    conversions: conversionsResult.rows.length,
    conversionsByPayment: conversionsByPayment.length,
    reporting: reportingRows.length,
    invoiceReporting: invoiceReportingRows.length,
    payments: paymentsResult.rows.length,
    invoices: optimiseInvoices.length,
    vouchers: refreshCoupons ? voucherCodesResult.rows.length : 0,
  };

  const totalSaved = Object.values(savedCounts).reduce((sum, count) => sum + count, 0);
  if (warnings.length > 0 && totalSaved === 0) {
    throw new Error(joinUserMessages(warnings));
  }

  await markAccountSyncSuccess(platform, credentials.accountLabel, {
    refreshedCampaigns: refreshCampaigns,
    refreshedCoupons: refreshCoupons,
    refreshedOrders: conversionsResult.rows.length > 0 || reportingRows.length > 0,
    refreshedPayments: paymentsResult.rows.length > 0 || optimiseInvoices.length > 0,
    advanceLastSuccessfulSync: warnings.length === 0,
  });

  accountTimer.end("accountSyncMs");
  accountTimer.add("dbWriteMs", entityTiming.totals.dbWriteMs);
  accountTimer.add("fieldExtractionMs", entityTiming.totals.fieldExtractionMs);
  recordAccountTimings(accountTimer.toObject());

  return {
    accountLabel: credentials.accountLabel,
    region: regionUpper,
    removedDuplicateCampaigns,
    partialSuccess: warnings.length > 0,
    warnings,
    userMessage: warnings.length > 0 ? joinUserMessages(warnings) : null,
    incrementalFrom: conversionsRange.fromDate,
    skippedCampaignRefresh: !refreshCampaigns,
    skippedCouponRefresh: !refreshCoupons,
    syncMetadata,
    networkPerformanceFacts: factPromo.upserted,
    mboLinkClickEnrich: mboClickEnrich.updated,
    conversionCouponEnrich: couponEnrich.updated,
    sourceObjectRuns: resourceResults.map((r) => r.syncRun).filter(Boolean),
    ...savedCounts,
  };
}

async function syncOptimiseRegionAccounts(region) {
  const platform = `optimise_${region}`;
  const accounts = await listMarketplaceAccounts(platform);
  const accountLabels = [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))];
  if (accountLabels.length === 0) {
    return {
      skipped: true,
      reason: `No Optimise ${region.toUpperCase()} accounts connected. Connect on the Integrations page.`,
    };
  }

  return syncAccountsWithConcurrency(accountLabels, (label) => syncOptimiseRegion(region, label), {
    platform,
  });
}

async function syncOptimise() {
  const regions = ["sea", "mena", "uk"];
  setSyncStage("optimise");

  // Phase 3 — SEA, MENA, UK sync concurrently; failures in one region do not cancel others.
  const settled = await Promise.allSettled(
    regions.map(async (region) => {
      const regionResult = await syncOptimiseRegionAccounts(region);
      return { region, regionResult };
    }),
  );

  const result = {};
  for (let i = 0; i < settled.length; i += 1) {
    const region = regions[i];
    const entry = settled[i];
    if (entry.status === "fulfilled") {
      result[region] = entry.value.regionResult;
    } else {
      result[region] = {
        failed: true,
        error: entry.reason?.message || "Region sync failed",
      };
    }
  }

  return result;
}

async function syncTrackierAccount(accountLabel) {
  const accountTimer = createSyncTimer();
  accountTimer.start("accountSyncMs");

  const flags = await getNetworkAccountSyncFlags("trackier", accountLabel);
  if (flags.exists && flags.syncEnabled === false) {
    accountTimer.end("accountSyncMs");
    return {
      skipped: true,
      reason: `Catalog sync is disabled for Trackier account [${accountLabel || "default"}].`,
    };
  }

  const trackierApiKey =
    (await getMarketplaceApiKey("trackier", accountLabel)) ||
    (await getOAuthAccessToken("trackier", accountLabel)) ||
    process.env.VCOMMISSION_API_KEY ||
    null;
  if (!trackierApiKey) {
    accountTimer.end("accountSyncMs");
    return {
      skipped: true,
      reason: `No connected Trackier account [${accountLabel || "default"}]. Connect on the Integrations page.`,
    };
  }

  const timestamps = await getAccountSyncTimestamps("trackier", accountLabel);
  const dateRange = getTrackierDateRange(timestamps?.lastSuccessfulSync);
  const refreshCampaigns = shouldRefreshCampaigns(timestamps?.lastCampaignSyncAt);
  const refreshCoupons = shouldRefreshCoupons(timestamps?.lastCouponSyncAt);
  const networkAccountId = await resolveNetworkAccountId("trackier", accountLabel);
  const requested = requestedSourceObject();
  const unavailable = await runUnavailableIfRequested({
    network: "trackier",
    networkAccountId,
    requested,
  });
  if (unavailable) {
    accountTimer.end("accountSyncMs");
    return unavailable;
  }

  const adapter = createTrackierAdapter({
    apiKey: trackierApiKey,
    baseURL: process.env.TRACKIER_BASE_URL || "https://api.trackier.com",
  });

  const credentials = { accountLabel: accountLabel || "default", platform: "trackier" };
  const srcCtx = { network: "trackier", networkAccountId, sourceObject: requested };

  accountTimer.start("apiFetchMs");

  const profileResult = await fetchTrackierSourceObject(
    "profile",
    credentials,
    () => adapter.fetchProfile(),
    {},
    srcCtx,
  );

  const pubId = profileResult.data?.id ?? profileResult.data?.hashId ?? null;

  const reportsKpiResult = await fetchTrackierSourceObject(
    "reportsKpi",
    credentials,
    () => adapter.fetchReportsKpi(),
    {},
    srcCtx,
  );

  const availableKpis =
    reportsKpiResult.rows.length > 0
      ? reportsKpiResult.rows
      : undefined;

  const [
    categoriesResult,
    campaignsCountResult,
    campaignsResult,
    couponsResult,
    dealsResult,
    conversionsResult,
    reportsResult,
  ] = await Promise.all([
    refreshCampaigns
      ? fetchTrackierSourceObject("categories", credentials, () => adapter.fetchCategories(), {}, srcCtx)
      : fetchTrackierSourceObject(
          "categories",
          credentials,
          async () => [],
          { skipped: true, skipReason: "cache" },
          srcCtx,
        ),
    pubId
      ? fetchTrackierSourceObject(
          "campaignsCount",
          credentials,
          () => adapter.fetchCampaignsCount(pubId),
          {},
          srcCtx,
        )
      : fetchTrackierSourceObject(
          "campaignsCount",
          credentials,
          async () => null,
          { skipped: true, skipReason: "missing_publisher_id" },
          srcCtx,
        ),
    refreshCampaigns
      ? fetchTrackierSourceObject("campaigns", credentials, () => adapter.fetchCampaigns(), {}, srcCtx)
      : fetchTrackierSourceObject(
          "campaigns",
          credentials,
          async () => [],
          { skipped: true, skipReason: "cache" },
          srcCtx,
        ),
    refreshCoupons
      ? fetchTrackierSourceObject("coupons", credentials, () => adapter.fetchCoupons(), {}, srcCtx)
      : fetchTrackierSourceObject(
          "coupons",
          credentials,
          async () => [],
          { skipped: true, skipReason: "cache" },
          srcCtx,
        ),
    refreshCoupons
      ? fetchTrackierSourceObject("deals", credentials, () => adapter.fetchDeals(), {}, srcCtx)
      : fetchTrackierSourceObject(
          "deals",
          credentials,
          async () => [],
          { skipped: true, skipReason: "cache" },
          srcCtx,
        ),
    fetchTrackierSourceObject(
      "conversions",
      credentials,
      () =>
        adapter.fetchConversions({
          startDate: dateRange.start,
          endDate: dateRange.end,
        }),
      {},
      srcCtx,
    ),
    fetchTrackierSourceObject(
      "reports",
      credentials,
      () =>
        adapter.fetchReports({
          startDate: dateRange.start,
          endDate: dateRange.end,
          kpis: availableKpis,
        }),
      {},
      srcCtx,
    ),
  ]);

  accountTimer.end("apiFetchMs");

  const resourceResults = [
    profileResult,
    categoriesResult,
    campaignsCountResult,
    campaignsResult,
    couponsResult,
    dealsResult,
    conversionsResult,
    reportsKpiResult,
    reportsResult,
  ];

  const warnings = summariseTrackierResourceWarnings(resourceResults, credentials);
  const syncMetadata = buildTrackierSyncMetadata(resourceResults, credentials, {
    refreshCampaigns,
    refreshCoupons,
    profile: profileResult.data,
    campaignsCount:
      campaignsCountResult.data ??
      (campaignsResult.rows.length > 0 ? { count: campaignsResult.rows.length, source: "campaigns" } : null),
    availableKpis: reportsKpiResult.rows,
  });

  if (profileResult.data?.id || profileResult.data?.hashId) {
    await prisma.marketplaceAccount.updateMany({
      where: { platform: "trackier", accountLabel: accountLabel || "default" },
      data: {
        accountExternalId: String(profileResult.data.id ?? profileResult.data.hashId),
      },
    });
  }

  const trackierCampaigns = enrichTrackierCampaignsWithCategories(
    campaignsResult.rows,
    categoriesResult.rows,
  );
  const trackierCoupons = couponsResult.rows.map(mapTrackierCouponRow);
  const trackierDeals = dealsResult.rows.map(mapTrackierDealRow);
  const trackierCouponsAndDeals = [...trackierCoupons, ...trackierDeals];
  const reportingRows = reportsResult.rows.map(mapTrackierReportRow).filter(isMeaningfulPerformanceRow);

  const entityTiming = createEntityTimingCollector();

  if (refreshCampaigns && includeSourceObject(requested, "campaigns")) {
    await upsertManyRawEntities({
      networkSource: "trackier",
      entityType: "campaign",
      rows: trackierCampaigns,
      externalIdPrefix: "trackier-campaign",
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(campaignsResult.syncRun),
    });
  }

  if (includeSourceObject(requested, "tracking")) {
    await upsertManyRawEntities({
      networkSource: "trackier",
      entityType: "performance",
      rows: reportingRows,
      externalIdPrefix: "trackier-report",
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(reportsResult.syncRun, {
        requestWindow: dateRange,
      }),
    });
  }
  const factPromo = includeSourceObject(requested, "tracking")
    ? await promotePerformanceRowsToFacts(reportingRows, {
        networkSource: "trackier",
        sourceAccountLabel: accountLabel || "default",
        sourceEndpoint: "trackier.reports",
      })
    : { upserted: 0 };
  const mboClickEnrich = includeSourceObject(requested, "tracking")
    ? await enrichFactsWithMboLinkClicks({
        supplier: "TRACKIER",
        sourceAccountLabel: accountLabel || "default",
      })
    : { updated: 0 };
  if (includeSourceObject(requested, "conversions")) {
    await upsertManyRawEntities({
      networkSource: "trackier",
      entityType: "conversion",
      rows: conversionsResult.rows,
      externalIdPrefix: "trackier-conversion",
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(conversionsResult.syncRun, {
        requestWindow: dateRange,
      }),
    });
  }

  if (refreshCoupons && includeSourceObject(requested, "coupons")) {
    await upsertManyRawEntities({
      networkSource: "trackier",
      entityType: "coupon",
      rows: trackierCouponsAndDeals,
      externalIdPrefix: "trackier-coupon",
      sourceAccountKey: accountLabel,
      onTiming: entityTiming.onTiming,
      evidence: evidenceFromRunSummary(couponsResult.syncRun || dealsResult.syncRun),
    });
  }

  const savedCounts = {
    campaigns: refreshCampaigns ? trackierCampaigns.length : 0,
    reporting: reportingRows.length,
    conversions: conversionsResult.rows.length,
    coupons: refreshCoupons ? trackierCoupons.length : 0,
    deals: refreshCoupons ? trackierDeals.length : 0,
  };

  const totalSaved = Object.values(savedCounts).reduce((sum, count) => sum + count, 0);
  if (warnings.length > 0 && totalSaved === 0) {
    throw new Error(joinUserMessages(warnings));
  }

  await markAccountSyncSuccess("trackier", accountLabel, {
    refreshedCampaigns: refreshCampaigns && includeSourceObject(requested, "campaigns"),
    refreshedCoupons: refreshCoupons && includeSourceObject(requested, "coupons"),
    refreshedOrders:
      (includeSourceObject(requested, "conversions") && conversionsResult.rows.length > 0) ||
      (includeSourceObject(requested, "tracking") && reportingRows.length > 0),
    refreshedPayments: false, // Trackier has no payments API
    advanceLastSuccessfulSync: warnings.length === 0,
  });

  accountTimer.end("accountSyncMs");
  accountTimer.add("dbWriteMs", entityTiming.totals.dbWriteMs);
  accountTimer.add("fieldExtractionMs", entityTiming.totals.fieldExtractionMs);
  recordAccountTimings(accountTimer.toObject());

  return {
    accountLabel: accountLabel || "default",
    partialSuccess: warnings.length > 0,
    warnings,
    userMessage: warnings.length > 0 ? joinUserMessages(warnings) : null,
    incrementalFrom: dateRange.start,
    skippedCampaignRefresh: !refreshCampaigns,
    skippedCouponRefresh: !refreshCoupons,
    syncMetadata,
    networkPerformanceFacts: factPromo.upserted,
    mboLinkClickEnrich: mboClickEnrich.updated,
    sourceObjectRuns: resourceResults.map((r) => r.syncRun).filter(Boolean),
    ...savedCounts,
  };
}

async function syncTrackier() {
  const accounts = await listMarketplaceAccounts("trackier");
  const accountLabels = [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))];
  if (accountLabels.length === 0) {
    return {
      skipped: true,
      reason: "No Trackier accounts connected. Connect on the Integrations page.",
    };
  }

  setSyncStage("trackier");
  return syncAccountsWithConcurrency(accountLabels, syncTrackierAccount, { platform: "trackier" });
}

const OPTIMISE_REGIONS = new Set(["sea", "mena", "uk"]);

async function maybePromoteAfterSync(result) {
  const promote =
    shouldPromoteAfterSync() === null ? AUTO_PROMOTE_AFTER_SYNC : shouldPromoteAfterSync();
  if (!promote) return result;

  try {
    setSyncStage("promotion");
    const { runTrackedJob } = await import("../platform/bootstrap.js");
    const promotionJob = await runTrackedJob("promotion", {});
    result.promotion = promotionJob?.result ?? promotionJob ?? null;
  } catch (promoError) {
    logger.warn(
      { err: promoError?.message || String(promoError) },
      "auto-promotion after sync failed",
    );
    result.promotion = {
      failed: true,
      error: promoError?.message || "Promotion failed",
    };
  }

  // GAP-034 — Entity(conversion) → Conversion/Order/attribution after catalog promotion.
  // Truthful counters only; empty Optimise conversion windows promote 0 rows.
  try {
    setSyncStage("conversion-promotion");
    const { runTrackedJob } = await import("../platform/bootstrap.js");
    const conversionPromotionJob = await runTrackedJob("conversion-promotion", {});
    result.conversionPromotion = conversionPromotionJob?.result ?? conversionPromotionJob ?? null;
  } catch (convPromoError) {
    logger.warn(
      { err: convPromoError?.message || String(convPromoError) },
      "auto conversion-promotion after sync failed",
    );
    result.conversionPromotion = {
      failed: true,
      error: convPromoError?.message || "Conversion promotion failed",
    };
  }

  // Pointer 13 — cross-object coupon backfill disabled (PerformanceRecord ≠ OrderConversion).
  try {
    const couponEnrich = await enrichFactsWithConversionCoupons();
    result.conversionCouponEnrich = couponEnrich;
  } catch (couponEnrichError) {
    logger.warn(
      { err: couponEnrichError?.message || String(couponEnrichError) },
      "conversion coupon enrich after sync failed",
    );
    result.conversionCouponEnrich = {
      failed: true,
      error: couponEnrichError?.message || "Coupon enrich failed",
    };
  }

  // DailyReport aggregation from real Click + ATTRIBUTED Conversion only.
  // Empty transactional window → truthful rowsUpserted: 0 (no fabricated performance).
  if (AUTO_AGGREGATE_AFTER_SYNC) {
    try {
      setSyncStage("aggregation");
      const { runTrackedJob } = await import("../platform/bootstrap.js");
      const to = new Date();
      const from = new Date();
      from.setUTCDate(from.getUTCDate() - Math.max(1, AGGREGATION_AFTER_SYNC_DAYS));
      const fromIso = from.toISOString().slice(0, 10);
      const toIso = to.toISOString().slice(0, 10);
      const aggregationJob = await runTrackedJob("aggregation", {
        rebuild: true,
        from: fromIso,
        to: toIso,
      });
      result.aggregation = aggregationJob?.result ?? aggregationJob ?? null;
    } catch (aggError) {
      logger.warn(
        { err: aggError?.message || String(aggError) },
        "auto aggregation after sync failed",
      );
      result.aggregation = {
        failed: true,
        error: aggError?.message || "Aggregation failed",
      };
    }
  }

  return result;
}

export async function syncPlatformAccount(platform, accountLabel, options = {}) {
  const run = async () => {
    resetFieldSyncCaches();
    accountTimingsCollector.length = 0;

    const totalAccounts = await countSyncAccountsForPlatform(platform, accountLabel);
    initSyncProgress({ totalAccounts, currentStage: "starting" });
    setSyncStage(resolvePlatformStage(platform));

    let result;
    if (platform === "boostiny") {
      if (accountLabel) {
        const accountResult = await syncBoostinyAccount(accountLabel);
        recordAccountSyncComplete({ success: !accountResult?.failed && !accountResult?.skipped });
        result = { [accountLabel]: accountResult };
      } else {
        result = await syncBoostiny();
      }
    } else if (platform.startsWith("optimise_")) {
      const region = platform.slice("optimise_".length);
      if (!OPTIMISE_REGIONS.has(region)) {
        throw new Error(`Unsupported platform: ${platform}`);
      }

      if (accountLabel) {
        const accountResult = await syncOptimiseRegion(region, accountLabel);
        recordAccountSyncComplete({
          success: !accountResult?.failed && !accountResult?.skipped,
        });
        result = { [region]: { [accountLabel]: accountResult } };
      } else {
        const accounts = await listMarketplaceAccounts(platform);
        const accountLabels = [...new Set(accounts.map((acc) => acc.accountLabel).filter(Boolean))];
        if (accountLabels.length === 0) {
          result = {
            [region]: {
              skipped: true,
              reason: `No Optimise ${region.toUpperCase()} accounts connected. Connect on the Integrations page.`,
            },
          };
        } else {
          result = {
            [region]: await syncAccountsWithConcurrency(
              accountLabels,
              (label) => syncOptimiseRegion(region, label),
              { platform },
            ),
          };
        }
      }
    } else if (platform === "trackier") {
      if (accountLabel) {
        const accountResult = await syncTrackierAccount(accountLabel);
        recordAccountSyncComplete({
          success: !accountResult?.failed && !accountResult?.skipped,
        });
        result = { [accountLabel]: accountResult };
      } else {
        result = await syncTrackier();
      }
    } else if (platform === "impact") {
      const accountResult = await syncImpactAccount(accountLabel || "default");
      recordAccountSyncComplete({
        success: !accountResult?.failed && !accountResult?.skipped,
      });
      result = { [accountLabel || "default"]: accountResult };
    } else if (platform === "partnerize") {
      const accountResult = await syncPartnerizeAccount(accountLabel || "default");
      recordAccountSyncComplete({
        success: !accountResult?.failed && !accountResult?.skipped,
      });
      result = { [accountLabel || "default"]: accountResult };
    } else if (platform === "awin") {
      const accountResult = await syncAwinAccount(accountLabel || "default");
      recordAccountSyncComplete({
        success: !accountResult?.failed && !accountResult?.skipped,
      });
      result = { [accountLabel || "default"]: accountResult };
    } else if (platform === "admitad") {
      const accountResult = await syncAdmitadAccount(accountLabel || "default");
      recordAccountSyncComplete({
        success: !accountResult?.failed && !accountResult?.skipped,
      });
      result = { [accountLabel || "default"]: accountResult };
    } else if (platform === "rakuten") {
      const accountResult = await syncRakutenAccount(accountLabel || "default");
      recordAccountSyncComplete({
        success: !accountResult?.failed && !accountResult?.skipped,
      });
      result = { [accountLabel || "default"]: accountResult };
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    return maybePromoteAfterSync(result);
  };

  if (options && Object.keys(options).length > 0) {
    return runWithSyncOptions(options, run);
  }
  return run();
}

export async function syncAll(options = {}) {
  const run = async () => {
    const jobName = "syncAll";
    let attempt = 1;
    const jobTimer = createSyncTimer();
    jobTimer.start("totalJobMs");
    accountTimingsCollector.length = 0;
    resetFieldSyncCaches();

    try {
      const totalAccounts = await countAllSyncAccounts();
      initSyncProgress({ totalAccounts, currentStage: "starting" });
      setSyncStage("starting");

      await logJob({ jobName, status: "started", message: "Starting sync", attempt });

      setSyncStage("boostiny");
      jobTimer.start("boostinyMs");
      const boostiny = await syncBoostiny();
      jobTimer.end("boostinyMs");

      setSyncStage("optimise");
      jobTimer.start("optimiseMs");
      const optimise = await syncOptimise();
      jobTimer.end("optimiseMs");

      setSyncStage("trackier");
      jobTimer.start("trackierMs");
      const trackier = await syncTrackier();
      jobTimer.end("trackierMs");

      setSyncStage("impact");
      jobTimer.start("impactMs");
      const impact = await syncImpactAccount("default");
      jobTimer.end("impactMs");

      setSyncStage("partnerize");
      jobTimer.start("partnerizeMs");
      const partnerize = await syncPartnerizeAccount("default");
      jobTimer.end("partnerizeMs");

      setSyncStage("awin");
      jobTimer.start("awinMs");
      const awin = await syncAwinAccount("default");
      jobTimer.end("awinMs");

      setSyncStage("admitad");
      jobTimer.start("admitadMs");
      const admitad = await syncAdmitadAccount("default");
      jobTimer.end("admitadMs");

      setSyncStage("rakuten");
      jobTimer.start("rakutenMs");
      const rakuten = await syncRakutenAccount("default");
      jobTimer.end("rakutenMs");

      const result = { boostiny, optimise, trackier, impact, partnerize, awin, admitad, rakuten };
      jobTimer.end("totalJobMs");

      const timings = mergeTimings(jobTimer.toObject(), drainAccountTimings());
      setSyncTimings(timings);

      // Phase 11 — timings are additive; boostiny/optimise keys unchanged for log consumers.
      await logJob({
        jobName,
        status: "success",
        message: "Sync completed",
        metadata: { ...result, timings },
        attempt,
      });

      return maybePromoteAfterSync(result);
    } catch (error) {
      attempt += 1;
      jobTimer.end("totalJobMs");
      await logJob({
        jobName,
        status: "failed",
        message: error?.message || "Sync failed",
        metadata: { stack: error?.stack, timings: jobTimer.toObject() },
        attempt,
      });
      throw error;
    }
  };

  if (options && Object.keys(options).length > 0) {
    return runWithSyncOptions(options, run);
  }
  return run();
}
