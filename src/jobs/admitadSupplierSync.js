import { createSupplierAdapter } from "../adapters/registry.js";
import { upsertManyRawEntities } from "../modules/raw/raw.service.js";
import {
  getMarketplaceApiKey,
  getOAuthAccessToken,
  getNetworkAccountSyncFlags,
} from "../modules/integrations/oauth.service.js";
import { CREDENTIAL_HEALTH } from "../modules/networkOps/networkAccount.contract.js";
import {
  getAccountSyncTimestamps,
  shouldRefreshCampaigns,
  shouldRefreshCoupons,
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

function isoSecond(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Admitad explicitly supports status_updated_start / status_updated_end for
 * incremental action changes. Rewind a small overlap so late status/payment-flag
 * changes are not lost. This builds request filters only; it does not interpret
 * action status, processed, or paid.
 */
export function buildAdmitadIncrementalActionParams({
  lastSuccessfulSync = null,
  now = new Date(),
  overlapDays = SYNC_OVERLAP_DAYS,
  initialDaysBack = DEFAULT_DAYS_BACK,
  explicit = {},
} = {}) {
  const end = validDate(explicit.status_updated_end) || validDate(now) || new Date();
  const explicitStart = validDate(explicit.status_updated_start);
  let start = explicitStart;

  if (!start) {
    const previous = validDate(lastSuccessfulSync);
    if (previous) {
      start = new Date(previous);
      start.setUTCDate(start.getUTCDate() - Math.max(0, Number(overlapDays) || 0));
    } else {
      start = new Date(end);
      start.setUTCDate(start.getUTCDate() - Math.max(1, Number(initialDaysBack) || 1));
    }
  }

  return {
    ...explicit,
    status_updated_start: isoSecond(start),
    status_updated_end: isoSecond(end),
    order_by: explicit.order_by || "datetime",
  };
}

async function resolveAdmitadCredentials(accountLabel = "default") {
  const accessToken =
    process.env.ADMITAD_ACCESS_TOKEN ||
    (await getOAuthAccessToken("admitad", accountLabel)) ||
    (await getMarketplaceApiKey("admitad", accountLabel)) ||
    null;
  return accessToken ? { accessToken } : null;
}

async function stampAdmitadSync(accountLabel, { campaigns = 0, coupons = 0, actions = 0 } = {}) {
  const now = new Date();
  const data = {
    lastSuccessfulSync: now,
    lastSyncError: null,
    credentialHealth: CREDENTIAL_HEALTH.HEALTHY,
  };
  if (campaigns > 0) data.lastCampaignSyncAt = now;
  if (coupons > 0) data.lastCouponSyncAt = now;
  if (actions > 0) data.lastOrderSyncAt = now;
  // Admitad action paid/processed flags are evidence, not a payment endpoint.
  // Never stamp lastPaymentSyncAt from those flags.
  await updateAccountSyncTimestamps("admitad", accountLabel || "default", data);
}

/**
 * Admitad sync foundation.
 *
 * Safe promotion boundary:
 * - Programmes/coupons/actions are persisted as raw + Entity staging.
 * - Action `status`, `processed`, and `paid` stay independent source evidence.
 * - We do not create FinancialTransaction or mark supplier payment received.
 * - We do not hard-map action amount/date/status fields beyond fields verified by
 *   the current MBO source catalog; live publisher fixtures are still required
 *   before freezing the remaining action response paths.
 */
export async function syncAdmitadAccount(accountLabel = "default") {
  const flags = await getNetworkAccountSyncFlags("admitad", accountLabel);
  if (flags.exists && flags.syncEnabled === false) {
    return {
      skipped: true,
      reason: `Catalog sync is disabled for Admitad account [${accountLabel}].`,
    };
  }

  const creds = await resolveAdmitadCredentials(accountLabel);
  if (!creds) {
    return {
      skipped: true,
      reason: `No Admitad access token [${accountLabel}]. Set ADMITAD_ACCESS_TOKEN or connect the network account.`,
    };
  }

  const networkAccountId = await resolveNetworkAccountId("admitad", accountLabel);
  const requested = requestedSourceObject();
  const unavailable = await runUnavailableIfRequested({
    network: "admitad",
    networkAccountId,
    requested,
  });
  if (unavailable) return unavailable;

  const timestamps = await getAccountSyncTimestamps("admitad", accountLabel);
  const refreshCampaigns = shouldRefreshCampaigns(timestamps?.lastCampaignSyncAt);
  const refreshCoupons = shouldRefreshCoupons(timestamps?.lastCouponSyncAt);
  const actionParams = buildAdmitadIncrementalActionParams({
    lastSuccessfulSync: timestamps?.lastSuccessfulSync,
    explicit: {
      ...(process.env.ADMITAD_STATUS_UPDATED_START
        ? { status_updated_start: process.env.ADMITAD_STATUS_UPDATED_START }
        : {}),
      ...(process.env.ADMITAD_STATUS_UPDATED_END
        ? { status_updated_end: process.env.ADMITAD_STATUS_UPDATED_END }
        : {}),
    },
  });

  const adapter = createSupplierAdapter("ADMITAD", creds);
  const stats = { requestCount: 0 };
  const runCtx = { network: "admitad", networkAccountId };
  const sourceObjectRuns = [];

  let campaigns = [];
  if (refreshCampaigns && includeSourceObject(requested, "programs")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "programs",
      endpoint: "GET /advcampaigns/",
      execute: () => adapter.fetchCampaigns({}, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    campaigns = resultRows(run);
  }

  let coupons = [];
  if (refreshCoupons && includeSourceObject(requested, "coupons")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "coupons",
      endpoint: "GET /coupons/",
      execute: () => adapter.fetchCoupons({}, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    coupons = resultRows(run);
  }

  let actions = [];
  if (includeSourceObject(requested, "actions")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "actions",
      endpoint: "GET /statistics/actions/",
      execute: () => adapter.fetchConversions(actionParams, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    actions = resultRows(run);
  }

  if (campaigns.length) {
    await upsertManyRawEntities({
      networkSource: "admitad",
      entityType: "campaign",
      rows: campaigns,
      externalIdPrefix: "admitad-campaign",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((run) => run?.sourceObject === "programs"),
      ),
    });
  }

  if (coupons.length) {
    await upsertManyRawEntities({
      networkSource: "admitad",
      entityType: "coupon",
      rows: coupons,
      externalIdPrefix: "admitad-coupon",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((run) => run?.sourceObject === "coupons"),
      ),
    });
  }

  if (actions.length) {
    await upsertManyRawEntities({
      networkSource: "admitad",
      entityType: "conversion",
      rows: actions,
      externalIdPrefix: "admitad-action",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((run) => run?.sourceObject === "actions"),
        { requestWindow: actionParams },
      ),
    });
  }

  const hadFailure = sourceObjectRuns.some((run) => run?.status === "FAILED");
  if (!hadFailure) {
    await stampAdmitadSync(accountLabel, {
      campaigns: campaigns.length,
      coupons: coupons.length,
      actions: actions.length,
    });
  }

  return {
    skipped: false,
    partial: hadFailure,
    campaigns: campaigns.length,
    coupons: coupons.length,
    actions: actions.length,
    payments: 0,
    actionWindow: actionParams,
    stats,
    sourceObjectRuns: sourceObjectRuns.filter(Boolean),
  };
}
