/**
 * Sync Optimise product feeds → ProductFeed / Product (real feed rows only).
 */
import { createOptimiseAdapter } from "../adapters/optimise.adapter.js";
import { resolveOptimiseCredentials } from "../modules/integrations/optimiseCredentials.js";
import { listMarketplaceAccounts } from "../modules/integrations/oauth.service.js";
import { ProductFeedService } from "../modules/product/productFeed.service.js";
import { prisma } from "../database/prisma.js";

function pickFeedId(meta) {
  return meta?.feedId ?? meta?.FeedID ?? meta?.id ?? meta?.feed_id ?? null;
}

function pickFeedName(meta) {
  return meta?.feedName ?? meta?.name ?? meta?.FeedName ?? null;
}

/** Extract Optimise publisher PID from tracking / feed URLs (often differs from supplierCampaignId). */
function extractOptimisePid(urlOrValue) {
  if (urlOrValue == null || urlOrValue === "") return null;
  const raw = String(urlOrValue);
  try {
    const u = new URL(raw);
    const pid = u.searchParams.get("PID") || u.searchParams.get("pid");
    if (pid) return String(pid);
  } catch {
    // not a URL — fall through
  }
  const m = raw.match(/(?:^|[?&])PID=([^&]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function resolveCampaignSourceId(meta, row, campaignSourceByExtId) {
  const candidates = [
    meta?.campaignId,
    meta?.campaign_id,
    meta?.pid,
    meta?.PID,
    row?.PID,
    row?.pid,
    row?.campaignId,
    extractOptimisePid(meta?.feedUrl || meta?.experimentalFeedUrl),
    extractOptimisePid(row?.ProductURL || row?.product_url || row?.url),
  ];
  for (const c of candidates) {
    if (c == null || c === "") continue;
    const hit = campaignSourceByExtId.get(String(c));
    if (hit) return hit;
  }
  return null;
}

async function loadCampaignSourceIndex() {
  const rows = await prisma.supplierCampaign.findMany({
    where: { supplier: "OPTIMISE" },
    select: {
      supplierCampaignId: true,
      trackingUrl: true,
      merchantId: true,
      campaignSources: { select: { id: true }, take: 1, orderBy: { priority: "asc" } },
    },
    take: 5000,
  });
  const map = new Map();
  for (const row of rows) {
    const csId = row.campaignSources?.[0]?.id;
    if (!csId) continue;
    const entry = { campaignSourceId: csId, merchantId: row.merchantId || null };
    if (row.supplierCampaignId) map.set(String(row.supplierCampaignId), entry);
    const pid = extractOptimisePid(row.trackingUrl);
    if (pid) map.set(String(pid), entry);
  }
  return map;
}

export async function syncOptimiseProductFeedsForAccount(region, accountLabel = "default", options = {}) {
  const maxFeeds = Number(options.maxFeeds || process.env.OPTIMISE_PRODUCT_FEED_MAX || 3);
  const maxRowsPerFeed = Number(options.maxRowsPerFeed || process.env.OPTIMISE_PRODUCT_FEED_ROWS || 40);
  const credentials = await resolveOptimiseCredentials(region, accountLabel);

  if (!credentials.hasMarketplaceAccount || !credentials.apiKey) {
    return {
      skipped: true,
      region,
      accountLabel: credentials.accountLabel,
      reason: "Optimise account not connected or missing API key",
    };
  }
  if (!credentials.agencyId || !credentials.contactId) {
    return {
      skipped: true,
      region,
      accountLabel: credentials.accountLabel,
      reason: "Missing agencyId or contactId",
    };
  }

  const adapter = createOptimiseAdapter({
    apiKey: credentials.apiKey,
    baseURL: credentials.baseURL,
    agencyId: credentials.agencyId,
    contactId: credentials.contactId,
  });

  const sourceAccountLabel = credentials.accountLabel || "default";
  let feedMetas = [];
  try {
    feedMetas = await adapter.fetchProductFeeds({ limit: Math.max(maxFeeds, 20) });
  } catch (error) {
    return {
      skipped: false,
      region,
      accountLabel: sourceAccountLabel,
      error: error.message || "product-feeds list failed",
      feeds: 0,
      products: 0,
    };
  }

  const campaignSourceByExtId = await loadCampaignSourceIndex().catch(() => new Map());
  const feedsService = new ProductFeedService({ prisma });
  const selected = feedMetas.slice(0, maxFeeds);
  const summaries = [];
  let products = 0;

  for (const meta of selected) {
    const feedId = pickFeedId(meta);
    if (!feedId) continue;
    let rows = [];
    try {
      rows = await adapter.fetchProductFeedItems({
        feedId,
        feedUrl: meta?.feedUrl || meta?.experimentalFeedUrl || null,
        aid: credentials.contactId,
        format: "csv",
        maxRows: maxRowsPerFeed,
      });
    } catch (error) {
      summaries.push({
        feedId: String(feedId),
        feedName: pickFeedName(meta),
        error: error.message || "download_failed",
        processed: 0,
      });
      continue;
    }

    if (!rows.length) {
      summaries.push({
        feedId: String(feedId),
        feedName: pickFeedName(meta),
        processed: 0,
        note: "empty_feed",
      });
      continue;
    }

    const linked = resolveCampaignSourceId(meta, rows[0], campaignSourceByExtId);
    const campaignSourceId = linked?.campaignSourceId || null;
    const merchantId = linked?.merchantId || null;
    const result = await feedsService.ingestFeedBatch({
      supplier: "OPTIMISE",
      sourceAccountLabel,
      campaignSourceId,
      merchantId,
      countryHint: null,
      feedExternalId: String(feedId),
      feedName: pickFeedName(meta) || `Optimise feed ${feedId}`,
      feedUrl: meta?.feedUrl || meta?.experimentalFeedUrl || null,
      feedFormat: "CSV",
      aid: String(credentials.contactId),
      rows,
    });
    products += (result.summary?.created || 0) + (result.summary?.updated || 0);
    summaries.push({
      feedId: String(feedId),
      feedName: pickFeedName(meta),
      campaignSourceId,
      ...result.summary,
    });
  }

  return {
    skipped: false,
    region,
    accountLabel: sourceAccountLabel,
    listedFeeds: feedMetas.length,
    syncedFeeds: summaries.length,
    products,
    summaries,
  };
}

export async function syncAllOptimiseProductFeeds(options = {}) {
  const regions = Array.isArray(options.regions) && options.regions.length ? options.regions : ["sea", "mena"];
  const results = [];
  for (const region of regions) {
    const accounts = await listMarketplaceAccounts(`optimise_${region}`).catch(() => []);
    const labels =
      Array.isArray(accounts) && accounts.length
        ? accounts.map((a) => a.accountLabel || "default")
        : ["default"];
    for (const label of labels) {
      results.push(await syncOptimiseProductFeedsForAccount(region, label, options));
    }
  }
  return {
    ok: true,
    results,
    products: results.reduce((sum, r) => sum + Number(r.products || 0), 0),
    syncedFeeds: results.reduce((sum, r) => sum + Number(r.syncedFeeds || 0), 0),
  };
}
