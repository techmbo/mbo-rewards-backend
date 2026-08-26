import { createHttpClient, getRateLimitWaitMs, requestWithRetry } from "../core/httpClient.js";
import { createRateLimiter } from "../core/rateLimiter.js";
import {
  firstNonEmpty,
  pickTrackierCampaignName,
  pickTrackierCategory,
  pickTrackierMerchantName,
  pickTrackierCampaignStatusRaw,
  pickTrackierApplicationStatusRaw,
  pickTrackierLandingUrl,
  pickTrackierTrackingUrl,
  pickTrackierLogoUrl,
} from "../modules/supplier/mappers/trackierFieldContract.js";

// Campaign endpoints: 5 req/sec
const TRACKIER_CAMPAIGN_MIN_INTERVAL_MS = Number(process.env.TRACKIER_CAMPAIGN_MIN_INTERVAL_MS || 200);
// Reports endpoints: 200 req/min (~3.3 req/sec)
const TRACKIER_REPORT_MIN_INTERVAL_MS = Number(process.env.TRACKIER_REPORT_MIN_INTERVAL_MS || 300);
const TRACKIER_PAGE_LIMIT = Number(process.env.TRACKIER_PAGE_LIMIT || 100);
const TRACKIER_CONVERSIONS_MAX_DAYS = Number(process.env.TRACKIER_CONVERSIONS_MAX_DAYS || 31);
const TRACKIER_REPORTS_MAX_DAYS = Number(process.env.TRACKIER_REPORTS_MAX_DAYS || 90);

const trackierCampaignRateLimiter = createRateLimiter(TRACKIER_CAMPAIGN_MIN_INTERVAL_MS);
const trackierReportRateLimiter = createRateLimiter(TRACKIER_REPORT_MIN_INTERVAL_MS);

const DEFAULT_REPORT_KPIS = ["clicks", "approvedConversions", "payout", "saleAmount"];

function normalizeKpiList(kpis) {
  if (!kpis) return DEFAULT_REPORT_KPIS;
  const list = Array.isArray(kpis) ? kpis : [kpis];
  const normalized = list
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        return entry.key ?? entry.name ?? entry.id ?? entry.value ?? null;
      }
      return null;
    })
    .filter(Boolean);
  return normalized.length > 0 ? normalized : DEFAULT_REPORT_KPIS;
}

/** Trackier docs use YYYY-MM-DD (startDate/endDate). Accept DD/MM/YYYY from env too. */
export function toTrackierApiDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const [, day, month, year] = dmy;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return raw;
}

function parseIsoDate(value) {
  const normalized = toTrackierApiDate(value);
  if (!normalized) return null;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoDateString(date) {
  return date.toISOString().slice(0, 10);
}

function splitDateRange(startDate, endDate, maxDays) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (!start || !end) {
    throw new Error("Trackier date range requires valid startDate and endDate");
  }
  if (start > end) {
    throw new Error("Trackier date range startDate must be before endDate");
  }

  const ranges = [];
  let cursor = new Date(start);

  while (cursor <= end) {
    const chunkStart = new Date(cursor);
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + Math.max(maxDays, 1) - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    ranges.push({
      startDate: toIsoDateString(chunkStart),
      endDate: toIsoDateString(chunkEnd),
    });

    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return ranges;
}

function getResponseBody(responseData) {
  if (!responseData || typeof responseData !== "object") return responseData;
  if (responseData.data && typeof responseData.data === "object" && !Array.isArray(responseData.data)) {
    return responseData.data;
  }
  return responseData;
}

function extractRows(responseData, collectionKeys = []) {
  if (Array.isArray(responseData)) return responseData;

  const body = getResponseBody(responseData);

  for (const key of collectionKeys) {
    if (Array.isArray(body?.[key])) return body[key];
  }

  if (Array.isArray(responseData?.[collectionKeys[0]])) {
    return responseData[collectionKeys[0]];
  }

  if (Array.isArray(body?.response)) return body.response;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.items)) return body.items;

  return [];
}

function extractPageToken(responseData) {
  const body = getResponseBody(responseData);
  return (
    responseData?.nextPageToken ??
    responseData?.pageToken ??
    body?.nextPageToken ??
    body?.pageToken ??
    null
  );
}

function hasMoreCampaignPages(responseData, page, pageSize, rowsCount) {
  const body = getResponseBody(responseData);
  const total = body?.count ?? body?.total ?? responseData?.count;
  if (total != null) return page * pageSize < Number(total);
  return rowsCount >= pageSize;
}

function hasMoreNumberedPages(responseData, page, pageSize, rowsCount) {
  const body = getResponseBody(responseData);
  const pagination = body?.pagination ?? responseData?.pagination;

  if (pagination?.currentPage != null && pagination?.total != null) {
    const perPage = Number(pagination.perPage ?? pageSize);
    return Number(pagination.currentPage) * perPage < Number(pagination.total);
  }

  if (pagination?.hasNext !== undefined) return Boolean(pagination.hasNext);

  const total = pagination?.total ?? body?.total;
  if (total != null) return page * pageSize < Number(total);

  return rowsCount >= pageSize;
}

async function requestWithRateLimit(httpClient, rateLimiter, requestFn, retryOptions = {}) {
  await rateLimiter.acquireSlot();

  try {
    return await requestWithRetry(requestFn, { retries: 6, delayMs: 2000, ...retryOptions });
  } catch (error) {
    if (error?.response?.status === 429) {
      const waitMs = getRateLimitWaitMs(error);
      rateLimiter.resetAfterRateLimit(waitMs ?? 60000);
    }
    throw error;
  }
}

async function fetchCampaignPages(httpClient, endpoint, baseParams = {}) {
  const rows = [];
  let page = Number(baseParams.page ?? 1);
  const limit = Number(baseParams.limit ?? TRACKIER_PAGE_LIMIT);
  const staticParams = { ...baseParams };
  delete staticParams.page;
  delete staticParams.limit;

  for (;;) {
    const response = await requestWithRateLimit(httpClient, trackierCampaignRateLimiter, () =>
      httpClient.get(endpoint, {
        params: {
          ...staticParams,
          page,
          limit,
        },
      }),
    );

    const pageRows = extractRows(response.data, ["campaigns"]);
    rows.push(...pageRows);

    if (!hasMoreCampaignPages(response.data, page, limit, pageRows.length)) {
      break;
    }
    page += 1;
  }

  return rows;
}

async function fetchPageNumberPaginated(httpClient, endpoint, baseParams = {}, options = {}) {
  const {
    rateLimiter = trackierCampaignRateLimiter,
    collectionKeys = [],
    pageParam = "page",
    limitParam = "limit",
  } = options;

  const rows = [];
  let page = Number(baseParams[pageParam] ?? 1);
  const limit = Number(baseParams[limitParam] ?? TRACKIER_PAGE_LIMIT);
  const staticParams = { ...baseParams };
  delete staticParams[pageParam];
  delete staticParams[limitParam];

  for (;;) {
    const response = await requestWithRateLimit(httpClient, rateLimiter, () =>
      httpClient.get(endpoint, {
        params: {
          ...staticParams,
          [pageParam]: page,
          [limitParam]: limit,
        },
      }),
    );

    const pageRows = extractRows(response.data, collectionKeys);
    rows.push(...pageRows);

    if (!hasMoreNumberedPages(response.data, page, limit, pageRows.length)) {
      break;
    }
    page += 1;
  }

  return rows;
}

async function fetchPageTokenPaginated(httpClient, endpoint, baseParams = {}, options = {}) {
  const { rateLimiter = trackierCampaignRateLimiter, collectionKeys = [] } = options;

  const rows = [];
  let pageToken = baseParams.pageToken ?? null;
  const staticParams = { ...baseParams };
  delete staticParams.pageToken;

  for (;;) {
    const params = { ...staticParams };
    if (pageToken) params.pageToken = pageToken;

    const response = await requestWithRateLimit(httpClient, rateLimiter, () =>
      httpClient.get(endpoint, { params }),
    );

    const pageRows = extractRows(response.data, collectionKeys);
    rows.push(...pageRows);

    const nextToken = extractPageToken(response.data);
    if (!nextToken || nextToken === pageToken || pageRows.length === 0) break;
    pageToken = nextToken;
  }

  return rows;
}

function unwrapProfile(responseData) {
  if (responseData?.profile && typeof responseData.profile === "object") {
    return responseData.profile;
  }
  return getResponseBody(responseData);
}

export function createTrackierAdapter({ apiKey, baseURL = "https://api.trackier.com" }) {
  const httpClient = createHttpClient({
    baseURL,
    apiKey: "",
    headers: {
      "X-Api-Key": String(apiKey),
    },
  });

  return {
    supplierKey: "TRACKIER",
    getCapabilities() {
      return {
        capabilities: ["CAMPAIGNS", "COUPONS", "CONVERSIONS", "TRACKING_SUBID", "REPORTING"],
        pagination: "page",
        notes: ["vCommission aliases to TRACKIER."],
      };
    },
    fetchProfile() {
      return requestWithRateLimit(httpClient, trackierCampaignRateLimiter, () =>
        httpClient.get("/v2/publishers/profile"),
      ).then((res) => unwrapProfile(res.data));
    },

    fetchCategories(params = {}) {
      return requestWithRateLimit(httpClient, trackierCampaignRateLimiter, () =>
        httpClient.get("/v2/publishers/categories", { params }),
      ).then((res) => extractRows(res.data, ["categories"]));
    },

    fetchCampaignsCount(pubId) {
      if (!pubId) {
        throw new Error("Trackier campaignsCount requires publisher id from profile");
      }
      return requestWithRateLimit(httpClient, trackierCampaignRateLimiter, () =>
        httpClient.get(`/v2/publishers/${pubId}/campaignsCount`),
      ).then((res) => getResponseBody(res.data));
    },

    fetchCampaigns(params = {}) {
      const query = {
        limit: TRACKIER_PAGE_LIMIT,
        ...params,
      };
      return fetchCampaignPages(httpClient, "/v2/publisher/campaigns", query);
    },

    fetchCampaignDetail(campaignId) {
      return requestWithRateLimit(httpClient, trackierCampaignRateLimiter, () =>
        httpClient.get(`/v2/publisher/campaign/${campaignId}`),
      ).then((res) => getResponseBody(res.data));
    },

    fetchCoupons(params = {}) {
      return fetchPageTokenPaginated(httpClient, "/v2/publishers/coupons", params, {
        collectionKeys: ["coupons"],
        rateLimiter: trackierCampaignRateLimiter,
      });
    },

    fetchDeals(params = {}) {
      return fetchPageTokenPaginated(httpClient, "/v2/publishers/deals", params, {
        collectionKeys: ["deals"],
        rateLimiter: trackierCampaignRateLimiter,
      });
    },

    async fetchConversions(params = {}) {
      const {
        start,
        end,
        startDate,
        endDate,
        from,
        to,
        status,
        click_id,
        clickId,
        p1,
        p2,
        p3,
        p4,
        p5,
        limit,
        ...rest
      } = params;

      const rangeStart = toTrackierApiDate(start ?? startDate ?? from);
      const rangeEnd = toTrackierApiDate(end ?? endDate ?? to);

      if (!rangeStart || !rangeEnd) {
        throw new Error("Trackier conversions requires startDate and endDate (YYYY-MM-DD)");
      }

      const chunks = splitDateRange(rangeStart, rangeEnd, TRACKIER_CONVERSIONS_MAX_DAYS);
      const rows = [];
      const filterParams = {
        ...(status ? { status } : {}),
        ...(click_id || clickId ? { click_id: click_id ?? clickId } : {}),
        ...(p1 ? { p1 } : {}),
        ...(p2 ? { p2 } : {}),
        ...(p3 ? { p3 } : {}),
        ...(p4 ? { p4 } : {}),
        ...(p5 ? { p5 } : {}),
        limit: limit ?? TRACKIER_PAGE_LIMIT,
        ...rest,
      };

      for (const chunk of chunks) {
        // eslint-disable-next-line no-await-in-loop
        const chunkRows = await fetchPageNumberPaginated(
          httpClient,
          "/v2/publishers/conversions",
          {
            ...filterParams,
            startDate: chunk.startDate,
            endDate: chunk.endDate,
          },
          {
            collectionKeys: ["conversions"],
            rateLimiter: trackierReportRateLimiter,
          },
        );
        rows.push(...chunkRows);
      }

      return rows;
    },

    async fetchReportsKpi() {
      const response = await requestWithRateLimit(httpClient, trackierReportRateLimiter, () =>
        httpClient.get("/v2/publishers/reports-kpi"),
      );
      const payload = response.data ?? {};
      const kpis = payload.allowedKpi ?? payload.kpis ?? payload.kpi ?? [];
      return Array.isArray(kpis) ? kpis : [];
    },

    async fetchReports(params = {}) {
      const {
        start,
        end,
        startDate,
        endDate,
        from,
        to,
        kpis = DEFAULT_REPORT_KPIS,
        grouping = ["campaign_name", "created"],
        groupBy,
        campaignId,
        campaignIds,
        ...rest
      } = params;

      const rangeStart = toTrackierApiDate(start ?? startDate ?? from);
      const rangeEnd = toTrackierApiDate(end ?? endDate ?? to);

      if (!rangeStart || !rangeEnd) {
        throw new Error("Trackier reports requires startDate and endDate (YYYY-MM-DD)");
      }

      const kpiList = normalizeKpiList(kpis);
      const groupingValue = groupBy ?? grouping;
      const chunks = splitDateRange(rangeStart, rangeEnd, TRACKIER_REPORTS_MAX_DAYS);
      const rows = [];

      for (const chunk of chunks) {
        const query = {
          startDate: chunk.startDate,
          endDate: chunk.endDate,
          kpis: kpiList.join(","),
          grouping: Array.isArray(groupingValue) ? groupingValue.join(",") : groupingValue,
          ...rest,
        };

        if (campaignId) query.campaignId = campaignId;
        if (campaignIds) {
          query.campaignIds = Array.isArray(campaignIds) ? campaignIds.join(",") : campaignIds;
        }

        // eslint-disable-next-line no-await-in-loop
        const chunkRows = await fetchPageNumberPaginated(httpClient, "/v2/publishers/reports", query, {
          collectionKeys: ["records"],
          rateLimiter: trackierReportRateLimiter,
        });
        rows.push(...chunkRows);
      }

      return rows;
    },
  };
}

export function enrichTrackierCampaignsWithCategories(campaigns, categories) {
  const categoryById = new Map();
  for (const category of categories) {
    const id = category?.id ?? category?._id ?? category?.category_id ?? category?.categoryId;
    const name = category?.name ?? category?.category_name ?? category?.categoryName;
    if (id != null) categoryById.set(String(id), name ?? null);
    if (name) categoryById.set(String(name).toLowerCase(), name);
  }

  return campaigns.map((campaign) => mapTrackierCampaignRow(campaign, categoryById));
}

export function mapTrackierCampaignRow(row, categoryById = new Map()) {
  // Preserve the full supplier payload (...row). Only fill aliases when absent.
  // NEVER invent status (no default "approved").
  const categoryFromLookup =
    row?.category_id != null ? categoryById.get(String(row.category_id)) : null;
  const categoryName = firstNonEmpty(
    pickTrackierCategory(row),
    categoryFromLookup,
  );
  const campaignName = pickTrackierCampaignName(row);
  const advertiserName = pickTrackierMerchantName(row);
  const status = pickTrackierCampaignStatusRaw(row);
  const applicationStatus = pickTrackierApplicationStatusRaw(row);
  const landing = pickTrackierLandingUrl(row);
  const tracking = pickTrackierTrackingUrl(row);
  const logo = pickTrackierLogoUrl(row);

  return {
    ...row,
    ...(campaignName && !firstNonEmpty(row?.campaign_name) ? { campaign_name: campaignName } : {}),
    ...(campaignName && !firstNonEmpty(row?.name) ? { name: campaignName } : {}),
    ...(campaignName && !firstNonEmpty(row?.title) ? { title: campaignName } : {}),
    ...(categoryName && !firstNonEmpty(row?.category_name) ? { category_name: categoryName } : {}),
    ...(advertiserName && !firstNonEmpty(row?.advertiser_name)
      ? { advertiser_name: advertiserName }
      : {}),
    ...(applicationStatus && !firstNonEmpty(row?.application_status)
      ? { application_status: applicationStatus }
      : {}),
    ...(landing && !firstNonEmpty(row?.preview_url) ? { preview_url: landing } : {}),
    ...(tracking && !firstNonEmpty(row?.tracking_link) ? { tracking_link: tracking } : {}),
    ...(logo && !firstNonEmpty(row?.logo) ? { logo } : {}),
    // Keep supplier status as-is when present; do not invent.
    ...(status != null && row?.status == null ? { status } : {}),
  };
}

export function mapTrackierCouponRow(row) {
  const nestedCode = Array.isArray(row?.coupons)
    ? row.coupons.map((c) => c?.code).find((c) => c != null && String(c).trim() !== "")
    : null;
  return {
    ...row,
    id: row?.id,
    campaign_id: row?.campaign_id ?? row?.campaignId,
    campaign_name: row?.campaign_name ?? row?.campaignName,
    code: row?.code ?? nestedCode ?? null,
    description: row?.description,
    status: row?.coupon_status ?? row?.status,
    type: row?.type,
    start_date: row?.start ?? row?.startDate ?? row?.start_date,
    expiry: row?.end ?? row?.endDate ?? row?.expiry,
    created_at: row?.created ?? row?.createdAt ?? row?.created_at,
    record_source: "coupon",
  };
}

export function mapTrackierDealRow(row) {
  return {
    ...row,
    id: row?.id,
    campaign_id: row?.campaign_id ?? row?.campaignId,
    campaign_name: row?.campaign_name ?? row?.campaignName,
    code: row?.code ?? row?.coupon ?? row?.deal_code ?? null,
    // deals[].title / description — do not invent coupon codes from deals
    description: row?.description ?? null,
    title: row?.title ?? row?.name ?? null,
    status: row?.status,
    type: row?.type ?? "deal",
    start_date: row?.start ?? row?.startDate ?? row?.start_date,
    expiry: row?.end ?? row?.endDate ?? row?.expiry,
    created_at: row?.created ?? row?.createdAt ?? row?.created_at,
    record_source: "deal",
  };
}

export function mapTrackierReportRow(row) {
  // reports[].clicks → clicks; reports[].conversions → conversions; reports[].payout → gross_commission
  // Keep as performance/reporting rows — do not fold into campaign metadata.
  return {
    ...row,
    campaign_name: row?.campaign_name ?? row?.campaignName ?? row?.campaign?.name ?? null,
    date: row?.created ?? row?.date ?? row?.day ?? row?.reportDate ?? null,
    clicks: row?.clicks ?? null,
    conversions: row?.conversions ?? row?.approvedConversions ?? null,
    payout: row?.payout ?? null,
    totalConversions: row?.approvedConversions ?? row?.conversions ?? row?.totalConversions ?? null,
    validatedConversions: row?.approvedConversions ?? row?.validatedConversions ?? null,
    validatedCommission: row?.payout ?? row?.validatedCommission ?? row?.commission ?? null,
    originalOrderValue: row?.saleAmount ?? row?.revenue ?? row?.originalOrderValue ?? null,
    revenue: row?.saleAmount ?? row?.revenue ?? null,
    profit: row?.profit ?? null,
    report_type: "conversion_date",
  };
}
