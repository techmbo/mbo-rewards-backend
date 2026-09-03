import { createSupplierAdapter } from "../adapters/registry.js";
import { upsertManyRawEntities } from "../modules/raw/raw.service.js";
import {
  getMarketplaceApiKey,
  getMarketplaceRefreshToken,
  getOAuthAccessToken,
  getNetworkAccountSyncFlags,
} from "../modules/integrations/oauth.service.js";
import { CREDENTIAL_HEALTH } from "../modules/networkOps/networkAccount.contract.js";
import {
  getAccountSyncTimestamps,
  shouldRefreshCampaigns,
  updateAccountSyncTimestamps,
} from "./syncTimestamps.js";
import { DEFAULT_DAYS_BACK, SYNC_OVERLAP_DAYS } from "./syncConfig.js";
import {
  includeSourceObject,
  requestedSourceObject,
  resolveNetworkAccountId,
  runLiveSourceObject,
  runUnavailableIfRequested,
  summarizeSourceObjectRun,
  evidenceFromRunSummary,
} from "./sourceObjectRuns.js";
import { resultRows } from "../modules/networkOps/sourceObjectSync.service.js";

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampPositiveInt(value, fallback, max = Number.POSITIVE_INFINITY) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function utcEventDateTime(date) {
  const d = validDate(date);
  if (!d) return null;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function yyyymmdd(date) {
  const d = validDate(date);
  if (!d) return null;
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Rakuten Events keeps only recent directional data. Start from the last
 * successful sync with overlap, or a bounded recent bootstrap window. Never
 * request a process-date range larger than 30 days.
 */
export function buildRakutenEventWindow({
  lastSuccessfulSync = null,
  now = new Date(),
  overlapDays = SYNC_OVERLAP_DAYS,
  initialDaysBack = Number(process.env.RAKUTEN_EVENTS_DAYS_BACK) || 14,
} = {}) {
  const end = validDate(now) || new Date();
  const previous = validDate(lastSuccessfulSync);
  const start = previous ? new Date(previous) : new Date(end);

  if (previous) {
    start.setUTCDate(start.getUTCDate() - Math.max(0, Number(overlapDays) || 0));
  } else {
    start.setUTCDate(start.getUTCDate() - clampPositiveInt(initialDaysBack, 14, 30));
  }

  const earliestAllowed = new Date(end);
  earliestAllowed.setUTCDate(earliestAllowed.getUTCDate() - 30);
  if (start < earliestAllowed) start.setTime(earliestAllowed.getTime());

  return {
    process_date_start: utcEventDateTime(start),
    process_date_end: utcEventDateTime(end),
  };
}

export function buildRakutenPaymentHistoryWindow({
  now = new Date(),
  daysBack = Number(process.env.RAKUTEN_PAYMENT_DAYS_BACK) || DEFAULT_DAYS_BACK,
} = {}) {
  const end = validDate(now) || new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - clampPositiveInt(daysBack, DEFAULT_DAYS_BACK, 3650));
  return { bdate: yyyymmdd(start), edate: yyyymmdd(end) };
}

async function resolveRakutenCredentials(accountLabel = "default") {
  const accessToken =
    process.env.RAKUTEN_ACCESS_TOKEN ||
    (await getOAuthAccessToken("rakuten", accountLabel)) ||
    (await getMarketplaceApiKey("rakuten", accountLabel)) ||
    null;

  // NetworkAccount has one secondary encrypted secret slot today. For Rakuten
  // it is used for the Advanced Reports web security token, never as Bearer auth.
  const securityToken =
    process.env.RAKUTEN_WEB_SECURITY_TOKEN ||
    (await getMarketplaceRefreshToken("rakuten", accountLabel)) ||
    null;

  return accessToken ? { accessToken, securityToken } : null;
}

async function stampRakutenSync(
  accountLabel,
  { campaigns = 0, offers = 0, events = 0, payments = 0 } = {},
) {
  const now = new Date();
  const data = {
    lastSuccessfulSync: now,
    lastSyncError: null,
    credentialHealth: CREDENTIAL_HEALTH.HEALTHY,
  };
  if (campaigns > 0 || offers > 0) data.lastCampaignSyncAt = now;
  if (events > 0) data.lastOrderSyncAt = now;
  if (payments > 0) data.lastPaymentSyncAt = now;
  await updateAccountSyncTimestamps("rakuten", accountLabel || "default", data);
}

function advertiserId(row = {}) {
  return row?.id ?? row?.advertiser_id ?? row?.advertiser?.id ?? null;
}

function normalizedAdvertiser(row = {}) {
  const id = advertiserId(row);
  return {
    ...row,
    id,
    campaign_id: id,
    campaignName: row?.name ?? null,
    advertiserName: row?.name ?? null,
    source_object: "advertisers",
  };
}

function normalizedPartnership(row = {}) {
  const id = row?.id ?? row?.advertiser?.id ?? row?.advertiser_id ?? null;
  return {
    ...row,
    id,
    advertiser_id: row?.advertiser_id ?? row?.advertiser?.id ?? id,
    source_object: "partnerships",
  };
}

function normalizedOffer(row = {}) {
  const id = row?.goid ?? row?.offer_number ?? row?.id ?? null;
  return {
    ...row,
    id,
    advertiser_id: row?.advertiser_id ?? row?.advertiser?.id ?? null,
    source_object: "offers",
  };
}

function normalizedCommissionList(row = {}) {
  const id = row?.id ?? row?.commissioning_list_id ?? row?.commission_list_id ?? null;
  return {
    ...row,
    id,
    source_object: "commissioning_lists",
  };
}

/**
 * Rakuten sync foundation:
 * - Advertiser/program master
 * - Partnerships
 * - Offers and commissioning-list source economics
 * - Recent Events transaction components
 * - Advanced Reports payment summary/history/detail, with a bounded call budget
 *
 * Safety boundaries:
 * - Events are not used as historical/expected commission truth.
 * - etransaction_id is a component identity; order_id remains advertiser order identity.
 * - Transaction Payment Status / Advertiser Payment Date remain network evidence.
 * - No Advanced Report field creates MBO receipt automatically.
 */
export async function syncRakutenAccount(accountLabel = "default") {
  const flags = await getNetworkAccountSyncFlags("rakuten", accountLabel);
  if (flags.exists && flags.syncEnabled === false) {
    return {
      skipped: true,
      reason: `Catalog sync is disabled for Rakuten account [${accountLabel}].`,
    };
  }

  const creds = await resolveRakutenCredentials(accountLabel);
  if (!creds) {
    return {
      skipped: true,
      reason: `No Rakuten Bearer access token [${accountLabel}]. Set RAKUTEN_ACCESS_TOKEN or connect the network account.`,
    };
  }

  const networkAccountId = await resolveNetworkAccountId("rakuten", accountLabel);
  const requested = requestedSourceObject();
  const unavailable = await runUnavailableIfRequested({
    network: "rakuten",
    networkAccountId,
    requested,
  });
  if (unavailable) return unavailable;

  const timestamps = await getAccountSyncTimestamps("rakuten", accountLabel);
  const refreshCampaigns = shouldRefreshCampaigns(timestamps?.lastCampaignSyncAt);
  const eventWindow = buildRakutenEventWindow({ lastSuccessfulSync: timestamps?.lastSuccessfulSync });
  const paymentWindow = buildRakutenPaymentHistoryWindow();

  const adapter = createSupplierAdapter("RAKUTEN", {
    accessToken: creds.accessToken,
    securityToken: creds.securityToken,
  });
  const stats = { requestCount: 0, advancedReportRequestCount: 0 };
  const runCtx = { network: "rakuten", networkAccountId };
  const sourceObjectRuns = [];

  let advertisers = [];
  if (refreshCampaigns && includeSourceObject(requested, "advertisers")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "advertisers",
      endpoint: "GET /v2/advertisers",
      execute: () => adapter.fetchAdvertisers({}, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    advertisers = resultRows(run).map(normalizedAdvertiser);
  }

  let partnerships = [];
  if (refreshCampaigns && includeSourceObject(requested, "partnerships")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "partnerships",
      endpoint: "GET /v1/partnerships",
      execute: () => adapter.fetchPartnerships({}, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    partnerships = resultRows(run).map(normalizedPartnership);
  }

  let offers = [];
  if (refreshCampaigns && includeSourceObject(requested, "offers")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "offers",
      endpoint: "GET /v1/offers",
      execute: () => adapter.fetchOffers({}, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    offers = resultRows(run).map(normalizedOffer);
  }

  let commissioningLists = [];
  if (refreshCampaigns && includeSourceObject(requested, "commissioning_lists")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "commissioning_lists",
      endpoint: "GET /v1/commissioninglists",
      execute: () => adapter.fetchCommissioningLists({}, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    commissioningLists = resultRows(run).map(normalizedCommissionList);
  }

  let events = [];
  if (includeSourceObject(requested, "events")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "events",
      endpoint: "GET /events/1.0/transactions",
      execute: () => adapter.fetchConversions(eventWindow, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    events = resultRows(run);
  }

  let paymentSummary = [];
  let advertiserPaymentHistory = [];
  let paymentDetails = [];
  const canFetchFinance = flags.financeSyncEnabled !== false && Boolean(creds.securityToken);
  if (canFetchFinance && includeSourceObject(requested, "advanced_reports")) {
    const maxPayments = clampPositiveInt(process.env.RAKUTEN_ADVANCED_REPORT_MAX_PAYMENTS, 10, 50);
    const maxInvoices = clampPositiveInt(process.env.RAKUTEN_ADVANCED_REPORT_MAX_INVOICES, 25, 100);
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "advanced_reports",
      endpoint: "GET /advancedreports/1.0",
      execute: async () => {
        const summary = await adapter.fetchPaymentHistory(paymentWindow, stats);
        const histories = [];
        const details = [];
        for (const payment of summary.slice(0, maxPayments)) {
          if (!payment?.payment_id) continue;
          // eslint-disable-next-line no-await-in-loop
          const history = await adapter.fetchAdvertiserPaymentHistory(
            { reportId: 22, payid: payment.payment_id },
            stats,
          );
          histories.push(...history.map((row) => ({ ...row, parent_payment_id: payment.payment_id })));
          if (details.length >= maxInvoices) continue;
          for (const invoice of history) {
            if (!invoice?.invoice_number || details.length >= maxInvoices) continue;
            // eslint-disable-next-line no-await-in-loop
            const rows = await adapter.fetchPaymentDetails(
              { reportId: 23, invoiceid: invoice.invoice_number },
              stats,
            );
            details.push(
              ...rows.map((row) => ({
                ...row,
                parent_payment_id: payment.payment_id,
                parent_invoice_number: invoice.invoice_number,
              })),
            );
          }
        }
        return {
          rows: summary,
          paymentSummary: summary,
          advertiserPaymentHistory: histories,
          paymentDetails: details,
          recordsFetched: summary.length + histories.length + details.length,
        };
      },
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    paymentSummary = run?.result?.paymentSummary ?? resultRows(run);
    advertiserPaymentHistory = run?.result?.advertiserPaymentHistory ?? [];
    paymentDetails = run?.result?.paymentDetails ?? [];
  }

  const evidenceFor = (sourceObject, extras = {}) =>
    evidenceFromRunSummary(sourceObjectRuns.find((run) => run?.sourceObject === sourceObject), extras);

  if (advertisers.length) {
    await upsertManyRawEntities({
      networkSource: "rakuten",
      entityType: "campaign",
      rows: advertisers,
      externalIdPrefix: "rakuten-advertiser",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFor("advertisers"),
    });
  }

  if (partnerships.length) {
    await upsertManyRawEntities({
      networkSource: "rakuten",
      entityType: "partnership",
      rows: partnerships,
      externalIdPrefix: "rakuten-partnership",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFor("partnerships"),
    });
  }

  if (offers.length) {
    await upsertManyRawEntities({
      networkSource: "rakuten",
      entityType: "offer",
      rows: offers,
      externalIdPrefix: "rakuten-offer",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFor("offers"),
    });
  }

  if (commissioningLists.length) {
    await upsertManyRawEntities({
      networkSource: "rakuten",
      entityType: "commission_rule",
      rows: commissioningLists,
      externalIdPrefix: "rakuten-commission-list",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFor("commissioning_lists"),
    });
  }

  if (events.length) {
    await upsertManyRawEntities({
      networkSource: "rakuten",
      entityType: "conversion",
      rows: events,
      externalIdPrefix: "rakuten-event",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFor("events", { requestWindow: eventWindow }),
    });
  }

  if (paymentSummary.length) {
    await upsertManyRawEntities({
      networkSource: "rakuten",
      entityType: "payment",
      rows: paymentSummary,
      externalIdPrefix: "rakuten-payment",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFor("advanced_reports", { requestWindow: paymentWindow }),
    });
  }

  if (advertiserPaymentHistory.length) {
    await upsertManyRawEntities({
      networkSource: "rakuten",
      entityType: "payment_invoice",
      rows: advertiserPaymentHistory,
      externalIdPrefix: "rakuten-payment-invoice",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFor("advanced_reports", { requestWindow: paymentWindow }),
    });
  }

  if (paymentDetails.length) {
    await upsertManyRawEntities({
      networkSource: "rakuten",
      entityType: "payment_detail",
      rows: paymentDetails,
      externalIdPrefix: "rakuten-payment-detail",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFor("advanced_reports", { requestWindow: paymentWindow }),
    });
  }

  const hadFailure = sourceObjectRuns.some((run) => run?.status === "FAILED");
  if (!hadFailure) {
    await stampRakutenSync(accountLabel, {
      campaigns: advertisers.length + partnerships.length,
      offers: offers.length + commissioningLists.length,
      events: events.length,
      payments: paymentSummary.length,
    });
  }

  return {
    skipped: false,
    partial: hadFailure,
    advertisers: advertisers.length,
    partnerships: partnerships.length,
    offers: offers.length,
    commissioningLists: commissioningLists.length,
    events: events.length,
    paymentSummary: paymentSummary.length,
    advertiserPaymentHistory: advertiserPaymentHistory.length,
    paymentDetails: paymentDetails.length,
    financeAvailable: canFetchFinance,
    eventWindow,
    paymentWindow,
    stats,
    sourceObjectRuns: sourceObjectRuns.filter(Boolean),
  };
}
