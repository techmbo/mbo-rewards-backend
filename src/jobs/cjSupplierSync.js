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

async function resolveCjCredentials(accountLabel = "default") {
  const accessToken =
    process.env.CJ_ACCESS_TOKEN ||
    (await getOAuthAccessToken("cj", accountLabel)) ||
    (await getMarketplaceApiKey("cj", accountLabel)) ||
    null;

  // These are identifiers, not secrets. Keep them configurable per deployment.
  const requestorCid = process.env.CJ_PUBLISHER_CID || process.env.CJ_REQUESTOR_CID || null;
  const websiteId = process.env.CJ_WEBSITE_ID || process.env.CJ_PID || null;

  if (!accessToken || !requestorCid || !websiteId) return null;
  return { accessToken, requestorCid, websiteId };
}

async function stampCjSync(accountLabel, { campaigns = 0, coupons = 0 } = {}) {
  const now = new Date();
  const data = {
    lastSuccessfulSync: now,
    lastSyncError: null,
    credentialHealth: CREDENTIAL_HEALTH.HEALTHY,
  };
  if (campaigns > 0) data.lastCampaignSyncAt = now;
  if (coupons > 0) data.lastCouponSyncAt = now;
  // No Commission Detail or payment source is active in this job.
  // Never stamp lastOrderSyncAt / lastPaymentSyncAt from advertiser or link discovery.
  await updateAccountSyncTimestamps("cj", accountLabel || "default", data);
}

/**
 * CJ publisher discovery sync.
 *
 * LIVE sources in this phase:
 * - Advertiser Lookup -> campaign staging
 * - Link Search -> link staging
 * - Link Search promotion-type=coupon -> coupon staging
 *
 * Financial boundaries:
 * - Advertiser Lookup default commission strings remain display/discovery evidence.
 * - Link Search commission strings remain display/link evidence.
 * - Expected commissions come from Program Terms.
 * - Actual commissions come from Commission Detail after live publisher-schema verification.
 */
export async function syncCjAccount(accountLabel = "default") {
  const flags = await getNetworkAccountSyncFlags("cj", accountLabel);
  if (flags.exists && flags.syncEnabled === false) {
    return { skipped: true, reason: `Catalog sync is disabled for CJ account [${accountLabel}].` };
  }

  const creds = await resolveCjCredentials(accountLabel);
  if (!creds) {
    return {
      skipped: true,
      reason:
        `CJ account [${accountLabel}] requires CJ_ACCESS_TOKEN, CJ_PUBLISHER_CID and CJ_WEBSITE_ID ` +
        `(or an encrypted MarketplaceAccount token plus the two identifiers).`,
    };
  }

  const networkAccountId = await resolveNetworkAccountId("cj", accountLabel);
  const requested = requestedSourceObject();
  const unavailable = await runUnavailableIfRequested({
    network: "cj",
    networkAccountId,
    requested,
  });
  if (unavailable) return unavailable;

  const timestamps = await getAccountSyncTimestamps("cj", accountLabel);
  const refreshCampaigns = shouldRefreshCampaigns(timestamps?.lastCampaignSyncAt);
  const refreshCoupons = shouldRefreshCoupons(timestamps?.lastCouponSyncAt);
  const adapter = createSupplierAdapter("CJ", creds);
  const stats = { requestCount: 0 };
  const runCtx = { network: "cj", networkAccountId };
  const sourceObjectRuns = [];

  let campaigns = [];
  if (refreshCampaigns && includeSourceObject(requested, "advertisers")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "advertisers",
      endpoint: "GET /v2/advertiser-lookup",
      execute: () => adapter.fetchCampaigns({ "advertiser-ids": "joined" }, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    campaigns = resultRows(run);
  }

  let links = [];
  if (includeSourceObject(requested, "links")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "links",
      endpoint: "GET /v2/link-search",
      execute: () => adapter.fetchLinks({ "advertiser-ids": "joined" }, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    links = resultRows(run);
  }

  let coupons = [];
  if (refreshCoupons && includeSourceObject(requested, "coupons")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "coupons",
      endpoint: "GET /v2/link-search?promotion-type=coupon",
      execute: () => adapter.fetchCoupons({ "advertiser-ids": "joined" }, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    coupons = resultRows(run);
  }

  if (campaigns.length) {
    await upsertManyRawEntities({
      networkSource: "cj",
      entityType: "campaign",
      rows: campaigns,
      externalIdPrefix: "cj-advertiser",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((run) => run?.sourceObject === "advertisers"),
      ),
    });
  }

  if (links.length) {
    await upsertManyRawEntities({
      networkSource: "cj",
      entityType: "link",
      rows: links,
      externalIdPrefix: "cj-link",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((run) => run?.sourceObject === "links"),
      ),
    });
  }

  if (coupons.length) {
    await upsertManyRawEntities({
      networkSource: "cj",
      entityType: "coupon",
      rows: coupons,
      externalIdPrefix: "cj-coupon",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((run) => run?.sourceObject === "coupons"),
      ),
    });
  }

  const hadFailure = sourceObjectRuns.some((run) => run?.status === "FAILED");
  if (!hadFailure) {
    await stampCjSync(accountLabel, {
      campaigns: campaigns.length,
      coupons: coupons.length,
    });
  }

  return {
    skipped: false,
    partial: hadFailure,
    campaigns: campaigns.length,
    links: links.length,
    coupons: coupons.length,
    programTerms: 0,
    conversions: 0,
    payments: 0,
    stats,
    sourceObjectRuns: sourceObjectRuns.filter(Boolean),
  };
}
