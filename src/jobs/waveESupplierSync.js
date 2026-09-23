import { createSupplierAdapter } from "../adapters/registry.js";
import { PartnerizePaymentsUnavailableError } from "../adapters/partnerize.adapter.js";
import { upsertManyRawEntities } from "../modules/raw/raw.service.js";
import {
  getMarketplaceApiKey,
  getMarketplaceExternalId,
  getMarketplaceRefreshToken,
  getOAuthAccessToken,
  getNetworkAccountSyncFlags,
} from "../modules/integrations/oauth.service.js";
import {
  enrichFactsWithMboLinkClicks,
  promotePerformanceRowsToFacts,
} from "../modules/networkPortal/networkPerformanceFact.ingestion.js";
import { updateAccountSyncTimestamps } from "./syncTimestamps.js";
import { explicitSyncWindow } from "./syncContext.js";
import { CREDENTIAL_HEALTH } from "../modules/networkOps/networkAccount.contract.js";
import {
  includeSourceObject,
  requestedSourceObject,
  resolveNetworkAccountId,
  runLiveSourceObject,
  runUnavailableIfRequested,
  summarizeSourceObjectRun,
  evidenceFromRunSummary,
} from "./sourceObjectRuns.js";
import {
  AWIN_MAX_OFFER_PAGES,
  AWIN_OFFERS_PAGE_CAP_CODE,
  AWIN_OFFERS_REPEATED_PAGE_CODE,
} from "../adapters/awin.adapter.js";
import { stageAwinOfferRows, stagedCompletely } from "./awinOffersStaging.js";
import { boundedCampaignPage } from "./syncContext.js";
import { AWIN_OFFERS_PAGE_LIMIT } from "./syncSourcePlan.js";
import { joinUserMessages } from "./syncErrors.js";

/**
 * Refusal code for an Awin offers sync asked for outside the durable orchestration.
 *
 * Not an error the supplier or the database produced — a refusal this service makes on purpose,
 * before either is touched, because the honest answer to "sync the offers catalogue now, in one
 * request" is that it does not fit in one request.
 */
export const AWIN_OFFERS_DURABLE_SYNC_REQUIRED = "AWIN_OFFERS_DURABLE_SYNC_REQUIRED";

/**
 * A bounded offers page whose supplier fetch succeeded but whose staging did not finish.
 *
 * Deliberately NOT one of the pagination reasons. page_cap, repeated_page, short_page and
 * empty_page all describe how much of the CATALOGUE we have; this describes a failure to write
 * down a page we already hold, which is a different thing and gets a different word. Reporting it
 * as a truncation would tell an operator the supplier cut us short when it did not.
 */
export const AWIN_OFFERS_STAGING_FAILED = "AWIN_OFFERS_STAGING_FAILED";

/**
 * What to tell an operator about an Awin offers walk that ended PARTIAL.
 *
 * Keyed off the error code the run already carries, because the two truncations mean different
 * things and the operator's next move differs: a cap means the catalogue had more and we stopped
 * asking, a repeated page means the supplier stopped honouring `page`. Anything else is reported
 * as partial without guessing at a cause.
 */
export function awinOffersPartialWarning(summary) {
  const code = summary?.errorCode ?? null;
  if (code === AWIN_OFFERS_PAGE_CAP_CODE) {
    return (
      `Awin offers ended at the configured page cap of ${AWIN_MAX_OFFER_PAGES} pages `
      + `(${AWIN_OFFERS_PAGE_LIMIT} offers per page). The catalogue was still returning a full page, `
      + "so additional supplier data may remain unsynced."
    );
  }
  if (code === AWIN_OFFERS_REPEATED_PAGE_CODE) {
    return (
      "Awin offers stopped early: the supplier re-delivered a page already held, so it is not "
      + "honouring the page parameter and the rest of the catalogue was unreachable. Additional "
      + "supplier data may remain unsynced."
    );
  }
  return "Awin offers did not complete: the run ended PARTIAL and additional supplier data may remain unsynced.";
}
import { resultRows } from "../modules/networkOps/sourceObjectSync.service.js";
import { unavailableOutcome, withFetchFailureSignal, withSourceOutcome } from "./sourceFetchOutcome.js";

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
  data.lastSyncError = null;
  data.credentialHealth = CREDENTIAL_HEALTH.HEALTHY;
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
    // Accounts connected from the admin store the Auth Token as the second secret.
    (await getMarketplaceRefreshToken("impact", accountLabel)) ||
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
  const flags = await getNetworkAccountSyncFlags("impact", accountLabel);
  if (flags.exists && flags.syncEnabled === false) {
    return {
      skipped: true,
      reason: `Catalog sync is disabled for Impact account [${accountLabel}].`,
    };
  }

  const creds = await resolveImpactCredentials(accountLabel);
  if (!creds) {
    return {
      skipped: true,
      reason: `No Impact credentials [${accountLabel}]. Set IMPACT_ACCOUNT_SID + IMPACT_AUTH_TOKEN or connect Integrations.`,
    };
  }

  const networkAccountId = await resolveNetworkAccountId("impact", accountLabel);
  const requested = requestedSourceObject();
  const unavailable = await runUnavailableIfRequested({
    network: "impact",
    networkAccountId,
    requested,
  });
  if (unavailable) return unavailable;

  const adapter = createSupplierAdapter("IMPACT", creds);
  const stats = { requestCount: 0 };
  const runCtx = { network: "impact", networkAccountId };
  const sourceObjectRuns = [];

  // A bounded orchestration unit supplies its own window; otherwise the existing fixed trailing
  // lookback is unchanged.
  const impactWindow = explicitSyncWindow();
  const impactDaysBack = Number(process.env.IMPACT_SYNC_DAYS_BACK || 90);
  const impactTo = new Date();
  const impactFrom = new Date(impactTo);
  impactFrom.setUTCDate(impactFrom.getUTCDate() - impactDaysBack);
  const impactDateParams = impactWindow
    ? { StartDate: impactWindow.start, EndDate: impactWindow.end }
    : {
        StartDate: impactFrom.toISOString().slice(0, 10),
        EndDate: impactTo.toISOString().slice(0, 10),
      };

  let campaigns = [];
  if (includeSourceObject(requested, "programs")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "programs",
      endpoint: "GET /Catalogs",
      // fetchPaginated caps itself at IMPACT_MAX_PAGE_COUNT pages and returns what it has. That
      // exit means the supplier said another page followed and we declined to ask, so the program
      // list is short — PARTIAL, not a SUCCESS with fewer rows.
      //
      // No endpoint in the metadata: the run row above already declares one, and fetchCampaigns
      // actually addresses GET /Campaigns, so writing the real path here would put two different
      // endpoints on one record. The declared one is wrong and predates this phase; correcting it
      // is an observability fix, not a pagination one.
      execute: () =>
        withSourceOutcome(stats, () => adapter.fetchCampaigns({}, stats), {
          truncationCode: "IMPACT_CAMPAIGNS_PAGE_CAP",
        }),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    campaigns = resultRows(run).map(normalizeImpactCampaign);
  }

  let conversions = [];
  if (includeSourceObject(requested, "actions")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "actions",
      endpoint: "GET /Actions",
      execute: () => adapter.fetchConversions(impactDateParams, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    conversions = resultRows(run).map(normalizeImpactAction);
  }

  let products = [];
  if (includeSourceObject(requested, "catalogs")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "catalogs",
      endpoint: "GET /Catalogs/Items",
      // Catalogs has TWO ways of coming back short, and both used to answer SUCCESS. fetchProducts
      // swallows any transport/auth/server error and answers [] — so a 403 looked like an empty
      // catalog. And fetchPaginated caps itself at IMPACT_MAX_PAGE_COUNT pages and returns what it
      // has — so a truncated read looked like the whole catalog. Either one is PARTIAL now, and
      // they carry different codes because they are different defects.
      execute: () =>
        withSourceOutcome(stats, () => adapter.fetchProducts({}, stats), {
          failureKeys: ["productFetchSkipped"],
          errorCode: "IMPACT_CATALOGS_FETCH_FAILED",
          truncationCode: "IMPACT_CATALOGS_PAGE_CAP",
          endpoint: "GET /Catalogs/Items",
        }),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    products = resultRows(run).map(normalizeImpactCatalogItem);
  }

  let performanceRows = [];
  if (includeSourceObject(requested, "reports") && typeof adapter.fetchPerformance === "function") {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "reports",
      endpoint: "derived /Actions performance",
      execute: () => adapter.fetchPerformance({ prefetchedConversions: conversions }, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    performanceRows = resultRows(run);
  }

  await upsertManyRawEntities({
    networkSource: "impact",
    entityType: "campaign",
    rows: campaigns,
    externalIdPrefix: "impact-campaign",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
    evidence: evidenceFromRunSummary(sourceObjectRuns.find((r) => r?.sourceObject === "programs")),
  });

  await upsertManyRawEntities({
    networkSource: "impact",
    entityType: "conversion",
    rows: conversions,
    externalIdPrefix: "impact-conversion",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
    evidence: evidenceFromRunSummary(sourceObjectRuns.find((r) => r?.sourceObject === "actions"), {
      requestWindow: impactDateParams,
    }),
  });

  let productPromotion = null;
  if (products.length) {
    await upsertManyRawEntities({
      networkSource: "impact",
      entityType: "product",
      rows: products,
      externalIdPrefix: "impact-product",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFromRunSummary(sourceObjectRuns.find((r) => r?.sourceObject === "catalogs")),
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
    sourceObjectRuns: sourceObjectRuns.filter(Boolean),
  };
}

export async function syncPartnerizeAccount(accountLabel = "default") {
  const flags = await getNetworkAccountSyncFlags("partnerize", accountLabel);
  if (flags.exists && flags.syncEnabled === false) {
    return {
      skipped: true,
      reason: `Catalog sync is disabled for Partnerize account [${accountLabel}].`,
    };
  }

  const creds = await resolvePartnerizeCredentials(accountLabel);
  if (!creds) {
    return {
      skipped: true,
      reason: `No Partnerize credentials [${accountLabel}]. Set PARTNERIZE_APPLICATION_KEY + PARTNERIZE_USER_API_KEY or connect Integrations.`,
    };
  }

  const networkAccountId = await resolveNetworkAccountId("partnerize", accountLabel);
  const requested = requestedSourceObject();
  const unavailable = await runUnavailableIfRequested({
    network: "partnerize",
    networkAccountId,
    requested,
  });
  if (unavailable) return unavailable;

  const adapter = createSupplierAdapter("PARTNERIZE", {
    ...creds,
    publisherId: creds.publisherId || process.env.PARTNERIZE_PUBLISHER_ID || null,
  });
  const stats = { requestCount: 0 };
  const runCtx = { network: "partnerize", networkAccountId };
  const sourceObjectRuns = [];

  const partnerizeWindow = explicitSyncWindow();
  const partnerizeDaysBack = Number(process.env.PARTNERIZE_SYNC_DAYS_BACK || 90);
  const partnerizeTo = new Date();
  const partnerizeFrom = new Date(partnerizeTo);
  partnerizeFrom.setUTCDate(partnerizeFrom.getUTCDate() - partnerizeDaysBack);
  const partnerizeDateParams = partnerizeWindow
    ? { start_date: partnerizeWindow.start, end_date: partnerizeWindow.end }
    : {
        start_date: partnerizeFrom.toISOString().slice(0, 10),
        end_date: partnerizeTo.toISOString().slice(0, 10),
      };

  let campaigns = [];
  if (includeSourceObject(requested, "campaigns")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "campaigns",
      endpoint: "GET campaigns",
      // Three states used to collapse into one SUCCESS. They are kept apart here:
      //   A hard API error       -> PARTIAL, because the catalog was NOT read
      //   B publisher not linked -> SUCCESS + unavailable metadata; nothing is broken, it is a
      //     configuration state, and calling it a failure would devalue PARTIAL
      //   C genuinely empty      -> plain SUCCESS with zero rows
      execute: async () => {
        const hintBefore = stats.campaignFetchHint;
        const outcome = await withFetchFailureSignal(
          stats,
          "campaignFetchFailed",
          () => adapter.fetchCampaigns({}, stats),
          { errorCode: "PARTNERIZE_CAMPAIGNS_FETCH_FAILED", endpoint: "GET campaigns" },
        );
        if (outcome?.partial) return outcome;
        const unlinked = stats.campaignFetchHint !== undefined && stats.campaignFetchHint !== hintBefore;
        return unlinked
          ? unavailableOutcome(outcome, {
              reason: stats.campaignFetchHint,
              code: "PARTNERIZE_PUBLISHER_NOT_LINKED",
              endpoint: "GET campaigns",
            })
          : outcome;
      },
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    campaigns = resultRows(run).map(normalizePartnerizeCampaign);
  }

  let conversions = [];
  if (includeSourceObject(requested, "conversions")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "conversions",
      endpoint: "GET conversions",
      execute: () => adapter.fetchConversions(partnerizeDateParams, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    conversions = resultRows(run).map(normalizePartnerizeConversion);
  }

  let payments = [];
  if (includeSourceObject(requested, "payment_information") && flags.financeSyncEnabled !== false) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "payment_information",
      endpoint: "GET payments",
      // fetchPayments stays non-blocking and returns [] on any failure. Without this, a 404 —
      // which is what the live probe actually returns for this account — would be recorded as a
      // successful run of zero payments. Re-raising the recorded skip makes the run FAILED with a
      // safe code, which sourceObjectSync persists and returns rather than rethrowing, so campaign
      // and conversion sync continue untouched.
      execute: async () => {
        const rows = await adapter.fetchPayments(partnerizeDateParams, stats);
        const skip = stats?.paymentFetchSkipped;
        if (skip?.status === "unavailable") {
          throw new PartnerizePaymentsUnavailableError(skip.supplierStatusCode);
        }
        return rows;
      },
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    payments = resultRows(run);
  }

  const campaignIds = campaigns.map((c) => c?.campaign_id ?? c?.id).filter(Boolean);
  let coupons = [];
  if (includeSourceObject(requested, "campaigns") && typeof adapter.fetchCoupons === "function") {
    const couponsRaw = await adapter.fetchCoupons({ campaignIds }, stats).catch(() => []);
    coupons = couponsRaw.map(normalizePartnerizeVoucher).filter((r) => r.voucher_code);
  }

  let performanceRows = [];
  if (includeSourceObject(requested, "analytics") && typeof adapter.fetchPerformance === "function") {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "analytics",
      endpoint: "derived conversion performance",
      execute: () => adapter.fetchPerformance({ prefetchedConversions: conversions }, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    performanceRows = resultRows(run);
  }

  await upsertManyRawEntities({
    networkSource: "partnerize",
    entityType: "campaign",
    rows: campaigns,
    externalIdPrefix: "partnerize-campaign",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
    evidence: evidenceFromRunSummary(sourceObjectRuns.find((r) => r?.sourceObject === "campaigns")),
  });

  await upsertManyRawEntities({
    networkSource: "partnerize",
    entityType: "conversion",
    rows: conversions,
    externalIdPrefix: "partnerize-conversion",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
    evidence: evidenceFromRunSummary(sourceObjectRuns.find((r) => r?.sourceObject === "conversions"), {
      requestWindow: partnerizeDateParams,
    }),
  });

  if (payments.length) {
    await upsertManyRawEntities({
      networkSource: "partnerize",
      entityType: "payment",
      rows: payments,
      externalIdPrefix: "partnerize-payment",
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFromRunSummary(
        sourceObjectRuns.find((r) => r?.sourceObject === "payment_information"),
        { requestWindow: partnerizeDateParams },
      ),
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
    sourceObjectRuns: sourceObjectRuns.filter(Boolean),
    warning: stats?.campaignFetchHint || (campaigns.length === 0 && !creds.publisherId
      ? "Partnerize Publisher ID is missing. Add it from Partnerize console → Partner settings, then reconnect/sync."
      : undefined),
  };
}

/** Awin refuses a transactions range wider than 31 days; never widen past the supplier cap. */
export function clampAwinWindowStart({ start, end }) {
  const earliest = new Date(`${end}T00:00:00.000Z`);
  earliest.setUTCDate(earliest.getUTCDate() - 30);
  const earliestIso = earliest.toISOString().slice(0, 10);
  return start < earliestIso ? earliestIso : start;
}

export async function syncAwinAccount(accountLabel = "default") {
  // FIRST, before any database read, any credential use, any adapter and any supplier call.
  //
  // An offers-ONLY request with no durable slice asks for exactly the one thing this service
  // cannot do in a single invocation: the catalogue is ~5,000 offers, roughly 96s of supplier
  // time and 247s of staging against a 300s cap. Serving the first 200 and answering OK would
  // tell an operator the offers catalogue had synced when it had not, so the request is refused
  // and told which route can honour it. Refusing costs nothing because nothing has happened yet.
  if (requestedSourceObject() === "offers" && !boundedCampaignPage()) {
    return {
      skipped: true,
      code: AWIN_OFFERS_DURABLE_SYNC_REQUIRED,
      reason:
        "Awin offers is paged across multiple invocations and must run through the durable sync orchestration, which plans one supplier page per unit. Nothing was fetched or staged.",
    };
  }

  const flags = await getNetworkAccountSyncFlags("awin", accountLabel);
  if (flags.exists && flags.syncEnabled === false) {
    return {
      skipped: true,
      reason: `Catalog sync is disabled for Awin account [${accountLabel}].`,
    };
  }

  const creds = await resolveAwinCredentials(accountLabel);
  if (!creds) {
    return {
      skipped: true,
      reason:
        `No Awin credentials [${accountLabel}]. Set AWIN_ACCESS_TOKEN + AWIN_PUBLISHER_ID or connect Integrations.`,
    };
  }

  const networkAccountId = await resolveNetworkAccountId("awin", accountLabel);
  const requested = requestedSourceObject();
  /** Operator-facing reasons this run did less than it was asked to. Drives partialSuccess. */
  const warnings = [];

  const unavailable = await runUnavailableIfRequested({
    network: "awin",
    networkAccountId,
    requested,
  });
  if (unavailable) return unavailable;

  const adapter = createSupplierAdapter("AWIN", creds);
  const stats = { requestCount: 0 };
  const runCtx = { network: "awin", networkAccountId };
  const sourceObjectRuns = [];

  // Awin caps the transactions range at 31 days, so a supplied window is clamped to that cap
  // rather than forwarded blindly.
  const awinWindow = explicitSyncWindow();
  const awinDaysBack = Math.min(Number(process.env.AWIN_SYNC_DAYS_BACK || 30), 31);
  const awinTo = new Date();
  const awinFrom = new Date(awinTo);
  awinFrom.setUTCDate(awinFrom.getUTCDate() - awinDaysBack);
  const awinDateParams = awinWindow
    ? { startDate: clampAwinWindowStart(awinWindow), endDate: awinWindow.end }
    : {
        startDate: awinFrom.toISOString().slice(0, 10),
        endDate: awinTo.toISOString().slice(0, 10),
      };

  let campaigns = [];
  if (includeSourceObject(requested, "programmes")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "programmes",
      endpoint: "GET programmes",
      execute: () => adapter.fetchCampaigns({}, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    campaigns = resultRows(run);
  }

  let conversions = [];
  if (includeSourceObject(requested, "transactions")) {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "transactions",
      endpoint: "GET transactions",
      execute: () => adapter.fetchConversions(awinDateParams, stats),
    });
    sourceObjectRuns.push(summarizeSourceObjectRun(run));
    conversions = resultRows(run);
  }

  let couponsRaw = [];
  /**
   * The offers slice this invocation runs, or null when the caller supplied none.
   *
   * Awin offers is a durable paged source: orchestration plans unit 0 at offset 0 and plans each
   * next unit from what the previous one reported, so an orchestrated unit always arrives
   * carrying its slice. Arriving WITHOUT one means the caller is outside that orchestration.
   *
   * Such a caller is REFUSED rather than quietly served the first page. Staging 200 of ~5,000
   * offers and answering 200 OK would report a source sync that did not happen: the operator
   * asked for the offers catalogue and would be told it synced. The catalogue spans invocations
   * now — ~96s of supplier time and ~247s of staging at the rate measured in the database's own
   * region, against a 300s cap — so the only honest answer to an unbounded request is to say so
   * and name the route that can do it.
   */
  const offersPage = boundedCampaignPage();
  let offersPagination = null;
  let offersRefusal = null;
  if (includeSourceObject(requested, "offers") && !offersPage) {
    offersRefusal = {
      code: AWIN_OFFERS_DURABLE_SYNC_REQUIRED,
      reason:
        "Awin offers is paged across multiple invocations and must run through the durable sync orchestration, which plans one supplier page per unit. This request carried no bounded page, so nothing was fetched or staged.",
    };
    // A run that did NOT sync one of the source objects it was asked for is not a success.
    // syncState resolves a run to "partial" from `partialSuccess` on any nested result, and shows
    // the operator whatever `warnings` carries — so the withheld source object has to say so in
    // both, or an unscoped manual Awin sync reports success while its coupons never moved.
    warnings.push(
      "Awin offers were not synced: the offers catalogue is paged across multiple invocations and must run through the durable sync orchestration. Programmes and transactions were unaffected.",
    );
    logger.warn(
      { network: "awin", accountLabel, sourceObject: "offers", code: AWIN_OFFERS_DURABLE_SYNC_REQUIRED },
      "awin offers refused: no durable bounded page context",
    );
  }
  // Refused BEFORE the supplier is called and before anything is staged: the guard is on the
  // gate, not inside the fetcher, so a refusal costs zero requests and zero rows.
  if (includeSourceObject(requested, "offers") && offersPage && typeof adapter.fetchCouponsPage === "function") {
    const run = await runLiveSourceObject({
      ...runCtx,
      sourceObject: "offers",
      endpoint: "GET offers / coupons",
      // programmes above is deliberately NOT wrapped: no page parameter is documented on that
      // endpoint and its response is not read for metadata, so there is nothing truthful to
      // record. It stays UNKNOWN and is not eligible for a reconciliation allow-list.
      // The offers walk stops at AWIN_MAX_OFFER_PAGES and returns what it has. That exit means the
      // catalogue was still offering pages when we stopped asking, so the run is PARTIAL rather
      // than a SUCCESS holding fewer rows. Every other exit is healthy and only carries evidence
      // of WHY it ended — and a short or empty page is recorded as the inference it is.
      //
      // programmes above is deliberately NOT wrapped: no page parameter is documented on that
      // endpoint and its response is not read for metadata, so there is nothing truthful to
      // record. It stays UNKNOWN and is not eligible for a reconciliation allow-list.
      execute: () =>
        withSourceOutcome(
          stats,
          async () => {
            // ONE page, then return. Never the whole-catalogue walk: see offersPage above.
            const page = await adapter.fetchCouponsPage(
              {
                offset: offersPage.offset,
                limit: offersPage.limit ?? undefined,
                seen: Array.isArray(offersPage.carry) ? offersPage.carry : [],
              },
              stats,
            );
            offersPagination = {
              index: Math.floor(page.offset / page.pageSize),
              offset: page.offset,
              pagesFetched: page.pagesFetched,
              rowsFetched: page.rows.length,
              nextOffset: page.nextOffset,
              hasMore: page.hasMore,
              reason: page.reason,
              // Carried into the next unit's descriptor so a re-delivered page is still
              // recognisable after a cold start.
              carry: page.seen,
            };
            return page.rows;
          },
          {
            truncationCode: AWIN_OFFERS_PAGE_CAP_CODE,
            repeatedPageCode: AWIN_OFFERS_REPEATED_PAGE_CODE,
            endpoint: "POST /publisher/{publisherId}/promotions",
          },
        ),
    });
    const offersSummary = summarizeSourceObjectRun(run);
    sourceObjectRuns.push(offersSummary);
    couponsRaw = resultRows(run);

    /**
     * A source object that ended PARTIAL has to reach the PARENT run, not just its own record.
     *
     * The parent's status comes from summarizeUnits, which reads `partialSuccess` off each unit's
     * outcome and nothing else. A NetworkSyncRun that recorded PARTIAL is invisible to it: the
     * source-object summaries travel on the result as data, and `hasPartial` looks for the
     * `partialSuccess` key, not for a nested `status: "PARTIAL"`. So a certified 25-page Awin walk
     * that stopped at its cap finalised the whole run as an unqualified success with no warning —
     * the one outcome the exhaustion vocabulary exists to make impossible.
     *
     * Translating it here rather than in the orchestrator is deliberate. The account sync is what
     * knows which of its source objects ended partial and WHY, and `warnings` + `partialSuccess`
     * is the contract every other account sync in the estate already reports through.
     *
     * The unit itself stays COMPLETED. It did its work: it fetched its page and staged it. What is
     * partial is the CATALOGUE, not this unit's execution.
     */
    if (offersSummary?.status === "PARTIAL") {
      warnings.push(awinOffersPartialWarning(offersSummary));
    }
  }

  const performanceRows =
    typeof adapter.fetchPerformance === "function"
      ? await adapter.fetchPerformance({ prefetchedConversions: conversions }, stats).catch(() => [])
      : [];

  await upsertManyRawEntities({
    networkSource: "awin",
    entityType: "campaign",
    rows: campaigns,
    externalIdPrefix: "awin-campaign",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
    evidence: evidenceFromRunSummary(sourceObjectRuns.find((r) => r?.sourceObject === "programmes")),
  });

  await upsertManyRawEntities({
    networkSource: "awin",
    entityType: "conversion",
    rows: conversions,
    externalIdPrefix: "awin-conversion",
    sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
    evidence: evidenceFromRunSummary(sourceObjectRuns.find((r) => r?.sourceObject === "transactions"), {
      requestWindow: awinDateParams,
    }),
  });

  let offersStaging = null;
  if (couponsRaw.length) {
    // Bounded chunks, not one 5,000-row batch. The walk can return a full catalogue now, and a
    // single batch of it exhausted the invocation while staging. See awinOffersStaging.js.
    offersStaging = await stageAwinOfferRows({
      rows: couponsRaw,
      sourceAccountKey: accountLabel !== "default" ? accountLabel : null,
      evidence: evidenceFromRunSummary(sourceObjectRuns.find((r) => r?.sourceObject === "offers")),
    });
    if (!stagedCompletely(offersStaging)) {
      // Never inferred from a resolved promise: the chunk runner reports how far it actually got.
      logger.warn(
        {
          network: "awin",
          accountLabel,
          rows: offersStaging.rows,
          chunksTotal: offersStaging.chunksTotal,
          chunksCompleted: offersStaging.chunksCompleted,
          rowsStaged: offersStaging.rowsStaged,
          failedChunk: offersStaging.failedChunk,
          err: offersStaging.error,
        },
        "awin offers staging did not complete every chunk",
      );
      /**
       * A page we fetched but did not finish writing down is a UNIT FAILURE, and the unit must
       * throw rather than return.
       *
       * Returning would hand the orchestrator a campaignPage, and a campaignPage is a claim that
       * this page is DONE and the next one may be planned. It is not done: some of its rows are
       * staged and some are not, and planning past it would leave that gap behind permanently,
       * because nothing ever revisits a page the walk has moved beyond.
       *
       * Throwing routes it to failUnit, which returns the unit to PENDING with its descriptor
       * untouched while attempts remain — same offset, same limit, same carry, same identity — so
       * the retry re-runs exactly this page. Nothing already committed is rolled back: the rows
       * staged before the failure stay, and the retry reaches them through the idempotent path.
       *
       * The offers NetworkSyncRun is left exactly as the fetch finalised it. The supplier answered
       * correctly and that record stays true; it is our own write that failed.
       */
      offersPagination = null;
      const failure = new Error(
        `Awin offers page staging did not complete: ${offersStaging.chunksCompleted}/${offersStaging.chunksTotal} chunks, ${offersStaging.rowsStaged}/${offersStaging.rows} rows.`,
      );
      failure.code = AWIN_OFFERS_STAGING_FAILED;
      failure.retryable = true;
      throw failure;
    }
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
    offersStaging,
    // Present only when an offers sync was asked for and refused. Never a silent omission: a
    // caller that requested offers and received none is told which route can deliver them.
    ...(offersRefusal ? { offersRefused: offersRefusal } : {}),
    // Same three fields every other account sync in the estate reports, read by syncState to
    // resolve the outer run to "partial" and to show the operator why.
    partialSuccess: warnings.length > 0,
    warnings,
    userMessage: warnings.length > 0 ? joinUserMessages(warnings) : null,
    // Read by the orchestration's nextPagedUnit to plan the next slice. Only ever set when this
    // invocation ran as a bounded unit; a whole-catalogue walk has no next page to name.
    campaignPage: offersPagination,
    performanceFacts: factPromo,
    mboClickEnrich,
    stats,
    sourceObjectRuns: sourceObjectRuns.filter(Boolean),
  };
}
