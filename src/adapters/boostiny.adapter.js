import { createHttpClient, getRateLimitWaitMs, requestWithRetry } from "../core/httpClient.js";
import { createRateLimiter } from "../core/rateLimiter.js";
import { asArray } from "../core/normalize.js";

// Boostiny uses Laravel-style throttling. Account lockouts ("Retry after 10 minutes") happen
// when too many requests are made in a short window — spacing must be conservative.
const BOOSTINY_MIN_INTERVAL_MS = Number(process.env.BOOSTINY_MIN_INTERVAL_MS || 6000);
const boostinyRateLimiter = createRateLimiter(BOOSTINY_MIN_INTERVAL_MS);

function extractRows(responseData) {
  if (Array.isArray(responseData)) return responseData;
  if (Array.isArray(responseData?.data)) return responseData.data;
  if (Array.isArray(responseData?.payload?.data)) return responseData.payload.data;
  if (Array.isArray(responseData?.payload?.rows)) return responseData.payload.rows;
  if (Array.isArray(responseData?.payload?.report)) return responseData.payload.report;
  if (Array.isArray(responseData?.payload?.reports)) return responseData.payload.reports;
  if (Array.isArray(responseData?.results)) return responseData.results;
  if (Array.isArray(responseData?.items)) return responseData.items;
  return [];
}

function extractSummary(responseData) {
  const payload = responseData?.payload ?? {};
  const summary = payload.summary ?? payload.totals ?? responseData?.summary ?? responseData?.totals;
  if (Array.isArray(summary)) return summary;
  if (summary && typeof summary === "object") return [summary];
  return [];
}

function hasMorePages(responseData, page, pageSize, rowsCount) {
  const pagination = responseData?.pagination ?? responseData?.payload?.pagination;

  if (pagination?.hasNext !== undefined) {
    return Boolean(pagination.hasNext);
  }

  if (pagination?.has_next !== undefined) {
    return Boolean(pagination.has_next);
  }

  if (pagination?.totalPages !== undefined) {
    return page < Number(pagination.totalPages);
  }

  if (responseData?.totalPages !== undefined) {
    return page < Number(responseData.totalPages);
  }

  return rowsCount === pageSize;
}

function isSummaryPerformanceRow(row) {
  if (!row || typeof row !== "object") return false;
  if (row.report_type === "summary") return true;
  return Boolean(row.period_from && row.period_to && !row.campaign_id && !row.campaign_name && !row.campaign?.id);
}

function hasCampaignDetailRows(rows) {
  return asArray(rows).some((row) => {
    if (isSummaryPerformanceRow(row)) return false;
    return (
      row?.campaign_id != null ||
      row?.campaignId != null ||
      row?.campaign_name ||
      row?.campaignName ||
      row?.campaign?.name ||
      row?.campaign?.id != null
    );
  });
}

function tagDetailRows(rows) {
  return asArray(rows)
    .filter((row) => !isSummaryPerformanceRow(row))
    .map((row) => ({
      ...row,
      campaign_id: row?.campaign_id ?? row?.campaignId ?? row?.campaign?.id ?? null,
      campaign_name: row?.campaign_name ?? row?.campaignName ?? row?.campaign?.name ?? null,
      report_type: row.report_type || "detail",
    }));
}

/** The campaigns path, as the adapter resolves it when no endpoint override is given. */
export const BOOSTINY_CAMPAIGNS_PATH = "/publisher/campaigns";

/** The dedicated coupons path. A SEPARATE listing from the coupons[] embedded in campaign rows:
 *  certification reads each on its own and never substitutes one for the other. */
export const BOOSTINY_COUPONS_PATH = "/publisher/coupons";

/**
 * The one Boostiny pager.
 *
 * options are OPTIONAL and default to production's behaviour, so a call that passes none is
 * byte-for-byte what it was — same rate limiter slot, same two retries, same page-1/limit-100
 * start, same hasNext / has_next / totalPages / full-page continuation. Certification passes:
 *   singlePage  stops after the FIRST response, before hasMorePages is consulted at all. At
 *               limit=1 a one-row page IS a full page, so the full-page heuristic would keep
 *               asking for page 2, 3, 4 — and Boostiny locks accounts out for exactly that.
 *   retries     pins the attempt count. Production allows two.
 *   timeoutMs   bounds the one request inside the caller's own budget.
 * The shared rate limiter is neither reduced nor bypassed: the one request still takes its slot,
 * and a 429 still resets the limiter for every other caller in this process.
 */
async function fetchPaginated(
  httpClient,
  endpoint,
  query = {},
  stats = null,
  { singlePage = false, retries, timeoutMs } = {},
) {
  const all = [];
  const pages = [];
  let page = 1;
  const pageSize = Number(query.limit ?? 100);

  for (;;) {
    await boostinyRateLimiter.acquireSlot();
    if (stats) stats.requestCount += 1;

    let response;
    try {
      response = await requestWithRetry(
        () =>
          httpClient.get(endpoint, {
            params: {
              page,
              limit: pageSize,
              ...query,
            },
            ...(timeoutMs ? { timeout: Number(timeoutMs) } : {}),
          }),
        { retries: 2, delayMs: 2000, ...(retries ? { retries } : {}) },
      );
    } catch (error) {
      if (error?.response?.status === 429) {
        const waitMs = getRateLimitWaitMs(error);
        if (waitMs != null) {
          boostinyRateLimiter.resetAfterRateLimit(waitMs);
        }
      }
      throw error;
    }

    const responseData = response.data;
    pages.push(responseData);
    const rows = extractRows(responseData);
    all.push(...rows);

    if (singlePage) break;

    if (!hasMorePages(responseData, page, pageSize, rows.length)) {
      break;
    }
    page += 1;
  }

  return { rows: all, pages };
}

export function createBoostinyAdapter({
  apiKey,
  baseURL = "https://api.boostiny.com",
  endpoints = {},
  // Test seam only: production never passes one, so the shared client with its Authorization
  // header is what every request goes through.
  httpClient: injectedHttpClient = null,
}) {
  const httpClient = injectedHttpClient ?? createHttpClient({ baseURL, apiKey });
  const resolvedEndpoints = {
    campaigns: endpoints.campaigns || BOOSTINY_CAMPAIGNS_PATH,
    performance: endpoints.performance || "/publisher/performance",
    linkPerformance: endpoints.linkPerformance || "/publisher/link-performance",
    coupons: endpoints.coupons || BOOSTINY_COUPONS_PATH,
  };

  return {
    supplierKey: "BOOSTINY",
    getCapabilities() {
      return {
        capabilities: ["CAMPAIGNS", "COUPONS", "REPORTING"],
        pagination: "page",
        notes: [
          "Tracking params UNCONFIRMED.",
          "Conversions/payments derived from performance rows in sync job (not fetchConversions).",
        ],
      };
    },
    /** options are OPTIONAL and reach the pager unchanged; fetchCampaigns(params, stats) — every
     *  production call shape — is byte-for-byte what it was. */
    async fetchCampaigns(params = {}, stats = null, options = {}) {
      const result = await fetchPaginated(httpClient, resolvedEndpoints.campaigns, params, stats, options);
      return result.rows;
    },
    fetchPerformance(params = {}, stats = null) {
      return fetchPaginated(httpClient, resolvedEndpoints.performance, params, stats);
    },
    async fetchLinkPerformance(params = {}, stats = null) {
      const result = await fetchPaginated(httpClient, resolvedEndpoints.linkPerformance, params, stats);
      return result.rows;
    },
    /** options are OPTIONAL and reach the pager unchanged; fetchCoupons(params, stats) — every
     *  production call shape — is byte-for-byte what it was. */
    async fetchCoupons(params = {}, stats = null, options = {}) {
      const result = await fetchPaginated(httpClient, resolvedEndpoints.coupons, params, stats, options);
      return result.rows;
    },
    async fetchPerformanceReport(params = {}, stats = null, { campaigns = [], usePerCampaign = false } = {}) {
      const performance = await this.fetchPerformance(params, stats);
      const performanceSummaries = performance.pages.flatMap((page) => extractSummary(page));
      let performanceRows = tagDetailRows(performance.rows);
      const needsPerCampaign =
        Boolean(campaigns?.length) && (usePerCampaign || !hasCampaignDetailRows(performance.rows));
      if (needsPerCampaign) {
        const campaignPerformance = await this.fetchPerformanceByCampaigns(campaigns, params, stats);
        performanceRows = campaignPerformance.rows;
      }
      return {
        performanceRows,
        performanceSummaries,
        performancePages: performance.pages,
        usedPerCampaignPerformance: needsPerCampaign,
        campaignPerformanceCount: performanceRows.length,
      };
    },
    async fetchPerformanceByCampaigns(campaigns, params = {}, stats = null) {
      const allRows = [];
      const allPages = [];

      for (const campaign of campaigns) {
        const campaignId = campaign?.id;
        if (campaignId === undefined || campaignId === null) continue;

        // eslint-disable-next-line no-await-in-loop
        const result = await fetchPaginated(httpClient, resolvedEndpoints.performance, {
          ...params,
          campaign_id: campaignId,
        }, stats);

        allPages.push(...result.pages);
        for (const row of result.rows) {
          if (isSummaryPerformanceRow(row)) continue;
          allRows.push({
            ...row,
            campaign_id: row?.campaign_id ?? row?.campaignId ?? campaignId,
            campaign_name: row?.campaign_name ?? row?.campaignName ?? campaign?.name ?? null,
            report_type: row.report_type || "detail",
          });
        }
      }

      return { rows: allRows, pages: allPages };
    },
    async fetchAll(params = {}, options = {}) {
      const stats = { requestCount: 0 };
      const performanceParams = params.performance || {};
      const usePerCampaign =
        String(process.env.BOOSTINY_PER_CAMPAIGN_PERFORMANCE || "").toLowerCase() === "true";
      const skipCampaigns = Boolean(options.skipCampaigns);
      const skipCoupons = Boolean(options.skipCoupons);

      // Boostiny uses conservative rate limiting (one slot every 6s) to avoid Laravel lockouts.
      // Resources must be fetched sequentially — concurrent requests race on the same rate limiter
      // slot and cause 429 "Retry after N minutes" lockouts.
      const campaigns = skipCampaigns ? [] : await this.fetchCampaigns(params.campaigns, stats);
      const performance = await this.fetchPerformance(performanceParams, stats);
      const linkPerformance = await this.fetchLinkPerformance(params.linkPerformance, stats);
      const coupons = skipCoupons ? [] : await this.fetchCoupons(params.coupons, stats);

      const performanceSummaries = performance.pages.flatMap((page) => extractSummary(page));
      let performanceRows = tagDetailRows(performance.rows);

      const needsPerCampaign =
        !skipCampaigns && (usePerCampaign || !hasCampaignDetailRows(performance.rows));
      if (needsPerCampaign) {
        const campaignPerformance = await this.fetchPerformanceByCampaigns(
          campaigns,
          performanceParams,
          stats,
        );
        performanceRows = campaignPerformance.rows;
      }

      const linkPerformanceRows = linkPerformance.map((row) => ({
        ...row,
        report_type: "link_performance",
      }));

      return {
        campaigns,
        performanceRows,
        performancePages: performance.pages,
        performanceSummaries,
        linkPerformance: linkPerformanceRows,
        coupons,
        campaignPerformanceCount: performanceRows.length,
        apiRequestCount: stats.requestCount,
        usedPerCampaignPerformance: needsPerCampaign,
      };
    },
    ensureArray(payload) {
      return asArray(payload);
    },
  };
}
