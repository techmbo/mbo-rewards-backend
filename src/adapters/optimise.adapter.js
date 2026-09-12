import { createHttpClient, requestWithRetry } from "../core/httpClient.js";
import { createRateLimiter } from "../core/rateLimiter.js";
import { buildBoundedFeedUrl, parseFirstFeedRecord } from "./optimiseFeedSample.js";
import {
  FeedUrlNotAllowedError,
  MAX_FEED_REDIRECTS,
  assertAllowedFeedUrl,
  isAllowedFeedUrl,
} from "./feedUrlPolicy.js";

const OPTIMISE_MIN_INTERVAL_MS = Number(process.env.OPTIMISE_MIN_INTERVAL_MS || 12500);
const OPTIMISE_PAGE_LIMIT = Number(process.env.OPTIMISE_PAGE_LIMIT || 100);
const optimiseRateLimiter = createRateLimiter(OPTIMISE_MIN_INTERVAL_MS);

/**
 * Certification paces itself on its own limiter, NOT the sync one above.
 *
 * The 12.5s sync interval exists to pace fetchOffsetPaginated, which issues hundreds of requests in
 * a run. Certification issues one request per source object, at most once per five minutes per
 * network+region+account (enforced at the route). Queueing it behind the sync interval is what
 * makes a bounded route budget unsatisfiable — the second source object would wait 12.5s before its
 * request even started — while buying no real protection: this limiter is per-process, so it never
 * constrained concurrent serverless instances in the first place.
 *
 * A separate limiter keeps the property that matters: probes are sequential and spaced, never a
 * burst against the supplier.
 */
const CERTIFICATION_MIN_INTERVAL_MS = Number(process.env.CERTIFICATION_MIN_INTERVAL_MS || 1000);
const certificationRateLimiter = createRateLimiter(CERTIFICATION_MIN_INTERVAL_MS);

const DEFAULT_REPORTING_MEASURES = [
  "totalConversions",
  "validatedConversions",
  "pendingConversions",
  "rejectedConversions",
  "validatedCommission",
  "pendingCommission",
  "originalOrderValue",
  "clicks",
];

// campaignId + advertiserName required for NetworkPerformanceFact join (brand / tracking / MBO clicks).
const DEFAULT_REPORTING_DIMENSIONS = ["campaignId", "campaignName", "advertiserName", "date"];

const INVOICE_REPORTING_MEASURES = [
  "validatedCommission",
  "pendingCommission",
  "validatedConversions",
  "totalConversions",
  "originalOrderValue",
  "clicks",
];

const INVOICE_REPORTING_DIMENSIONS = ["campaignId", "campaignName", "advertiserName", "invoiceDate", "date"];

function extractRows(responseData) {
  if (Array.isArray(responseData)) return responseData;
  if (Array.isArray(responseData?.response)) return responseData.response;
  if (Array.isArray(responseData?.data)) return responseData.data;
  if (Array.isArray(responseData?.payload?.data)) return responseData.payload.data;
  if (Array.isArray(responseData?.results)) return responseData.results;
  if (Array.isArray(responseData?.items)) return responseData.items;
  if (responseData?.data && typeof responseData.data === "object") return [responseData.data];
  if (responseData && typeof responseData === "object") {
    const keys = Object.keys(responseData);
    if (keys.includes("id") || keys.includes("campaignId") || keys.includes("productId")) {
      return [responseData];
    }
  }
  return [];
}

/** Parse Optimise product-feed CSV/TSV into row objects (header → values). */
export function parseOptimiseFeedCsv(text, maxRows = 100) {
  const raw = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length);
  if (lines.length < 2) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const headers = splitCsvLine(lines[0], delim).map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length && rows.length < maxRows; i += 1) {
    const cells = splitCsvLine(lines[i], delim).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (!cells.some((c) => c)) continue;
    const row = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      row[header] = cells[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line, delim = ",") {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delim && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Best-effort XML product feed parse (Optimise native Product* tags + Google Shopping). */
export function parseOptimiseFeedXml(text, maxRows = 100) {
  const raw = String(text || "");
  if (!raw.includes("<")) return [];
  const items = [];
  const itemBlocks =
    raw.match(/<item[\s>][\s\S]*?<\/item>/gi) || raw.match(/<product[\s>][\s\S]*?<\/product>/gi) || [];
  for (const block of itemBlocks) {
    if (items.length >= maxRows) break;
    const get = (tag) => {
      const m =
        block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i")) ||
        block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")) ||
        block.match(new RegExp(`<g:${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/g:${tag}>`, "i")) ||
        block.match(new RegExp(`<g:${tag}[^>]*>([\\s\\S]*?)<\\/g:${tag}>`, "i"));
      return m ? String(m[1]).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() : "";
    };
    // Prefer Optimise native field names so products.mapping.json COALESCE sources match.
    const row = {
      ProductSKU: get("ProductSKU") || get("sku") || get("id") || get("productId"),
      ProductName: get("ProductName") || get("title") || get("name"),
      ProductDescription: get("ProductDescription") || get("description"),
      ProductURL: get("ProductURL") || get("link") || get("url"),
      ProductPrice: get("ProductPrice") || get("price"),
      DiscountedPrice: get("DiscountedPrice") || get("sale_price"),
      WasPrice: get("WasPrice"),
      ProductPriceCurrency: get("ProductPriceCurrency") || get("currency"),
      ProductImageLargeURL: get("ProductImageLargeURL") || get("ProductLargeImageURL") || get("image_link") || get("image"),
      ProductImageMediumURL: get("ProductImageMediumURL") || get("ProductMediumImageURL"),
      ProductImageSmallURL: get("ProductImageSmallURL") || get("ProductSmallImageURL"),
      StockAvailability: get("StockAvailability") || get("availability"),
      Brand: get("Brand") || get("brand"),
      CategoryName: get("CategoryName") || get("product_type"),
      CategoryPathAsString: get("CategoryPathAsString"),
      PID: get("PID") || get("pid") || get("campaignId"),
      MID: get("MID") || get("mid"),
      MPN: get("MPN") || get("mpn"),
      // Google Shopping aliases retained for mapping COALESCE fallbacks
      id: get("id") || get("ProductSKU") || get("sku"),
      title: get("title") || get("ProductName") || get("name"),
      description: get("description") || get("ProductDescription"),
      link: get("link") || get("ProductURL") || get("url"),
      image_link: get("image_link") || get("ProductImageLargeURL"),
      price: get("price") || get("ProductPrice"),
      sale_price: get("sale_price") || get("DiscountedPrice"),
      availability: get("availability") || get("StockAvailability"),
      brand: get("brand") || get("Brand"),
      gtin: get("gtin"),
      mpn: get("mpn") || get("MPN"),
      product_type: get("product_type") || get("CategoryName"),
    };
    if (row.ProductSKU || row.ProductName || row.id || row.title) items.push(row);
  }
  return items;
}

/** Optimise reporting API expects DD/MM/YYYY (see docs.optimisemedia.com/api). */
export function toOptimiseReportingDate(isoDate) {
  const [year, month, day] = String(isoDate || "").split("-");
  if (!year || !month || !day) {
    throw new Error(`Invalid ISO date for Optimise reporting: ${isoDate}`);
  }
  return `${day}/${month}/${year}`;
}

/**
 * One rate-limited Optimise request with the shared retry policy and 429 back-off.
 * Every Optimise API call (paginated or campaign-scoped) goes through this path.
 */
async function requestWithOptimiseLimits(fn) {
  await optimiseRateLimiter.acquireSlot();
  try {
    return await requestWithRetry(fn, { retries: 6, delayMs: 2000 });
  } catch (error) {
    if (error?.response?.status === 429) {
      const retryAfterHeader = error?.response?.headers?.["retry-after"];
      const retryAfterSeconds = Number(retryAfterHeader);
      const waitMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 60000;
      optimiseRateLimiter.resetAfterRateLimit(waitMs);
    }
    throw error;
  }
}

/**
 * Certification sampling — deliberately separate from the sync fetchers above.
 *
 * The sync path is built to be exhaustive and patient: fetchOffsetPaginated loops until a short
 * page arrives, requestWithOptimiseLimits queues on a 12.5s minimum interval and retries up to six
 * times with backoff. That is correct for a nightly sync and catastrophic for a probe.
 *
 * Worse, asking the sync path for a small sample makes it behave at its worst. Its termination
 * test is `pageRows.length < limit`, so limit=1 never terminates on a full page: it walks the whole
 * collection one row per request, each 12.5s apart. That is what produced the 300s runtime timeout.
 *
 * This path therefore does not reuse any of it: one HTTP request, offset 0, limit 1, a hard
 * per-request timeout, and no retry. The endpoint is chosen from this table by source-object name,
 * so no caller can supply a path, query or body.
 */
export const CERTIFICATION_SAMPLE_TIMEOUT_MS = Number(process.env.CERTIFICATION_SAMPLE_TIMEOUT_MS || 10000);

/**
 * Byte window for a product-item sample. Large enough that a CSV header plus one row, or one XML
 * <item> block, comfortably fits; far too small to be a feed download. A feed whose single record
 * exceeds this is reported as unbounded rather than fetched more generously.
 */
export const CERTIFICATION_FEED_SAMPLE_BYTES = Number(process.env.CERTIFICATION_FEED_SAMPLE_BYTES || 65536);

const SINGLE_ROW = { offset: 0, limit: 1 };

/**
 * Date parameters are per-endpoint, never shared.
 *
 * Optimise uses three different date vocabularies across one API, and the sync fetchers above are
 * the evidence for which is which: /conversions takes fromDate/toDate (plus dateField,
 * targetCurrencyCode and conversionType), /payments and /invoices take startDate/endDate, and the
 * POST /reporting/ endpoint takes fromDate/toDate in DD/MM/YYYY rather than ISO.
 *
 * Certification previously spread one window carrying all four aliases into every dated endpoint.
 * /payments and /invoices happened to contain their correct pair; /conversions received none of
 * its own, which is what the supplier rejected. Each sample now names only the parameters its
 * endpoint actually takes, mirroring the fetcher that is known to work in production.
 */
const CONVERSIONS_DATE_FIELD = String(process.env.OPTIMISE_CONVERSIONS_DATE_FIELD || "conversion").trim();
const TARGET_CURRENCY_CODE = String(process.env.OPTIMISE_TARGET_CURRENCY_CODE || "USD").trim();

const CERTIFICATION_SAMPLES = Object.freeze({
  campaigns: { method: "GET", path: () => "/campaigns", params: () => ({ ...SINGLE_ROW }) },
  voucher_codes: { method: "GET", path: () => "/vouchercodes", params: () => ({ ...SINGLE_ROW }) },
  conversions: {
    method: "GET",
    path: () => "/conversions",
    // Mirrors fetchConversions: the same five parameters, the same ISO dates, the same defaults.
    params: (ctx) => ({
      ...SINGLE_ROW,
      fromDate: ctx.window.from,
      toDate: ctx.window.to,
      dateField: CONVERSIONS_DATE_FIELD,
      targetCurrencyCode: TARGET_CURRENCY_CODE,
      conversionType: "conversions",
    }),
  },
  payment_overview: {
    method: "GET",
    path: () => "/payments",
    // Mirrors fetchPayments: startDate/endDate, not fromDate/toDate.
    params: (ctx) => ({ ...SINGLE_ROW, startDate: ctx.window.from, endDate: ctx.window.to }),
  },
  invoices: {
    method: "GET",
    path: () => "/invoices",
    // Mirrors fetchInvoices: startDate/endDate.
    params: (ctx) => ({ ...SINGLE_ROW, startDate: ctx.window.from, endDate: ctx.window.to }),
  },
  products: { method: "GET", path: () => "/product-feeds/", params: () => ({ ...SINGLE_ROW }) },
  commission_groups: {
    method: "GET",
    needs: "campaignId",
    path: (ctx) => `/campaigns/${encodeURIComponent(ctx.campaignId)}/commission-groups`,
    params: () => ({}),
  },
  campaign_detail: {
    method: "GET",
    needs: "campaignId",
    path: (ctx) => `/campaigns/${encodeURIComponent(ctx.campaignId)}`,
    params: () => ({}),
  },
});

export function listCertificationSamples() {
  return Object.keys(CERTIFICATION_SAMPLES);
}

/** Raised when the probe's own budget expires, so the caller can report a controlled category. */
export class CertificationTimeoutError extends Error {
  constructor(message = "certification sample timed out") {
    super(message);
    this.name = "CertificationTimeoutError";
    this.certificationTimeout = true;
  }
}

/** Raised when the certification throttle cannot admit the request inside the probe budget. */
export class CertificationThrottledError extends Error {
  constructor(message = "certification sample could not be scheduled within budget") {
    super(message);
    this.name = "CertificationThrottledError";
    this.certificationThrottled = true;
  }
}

/**
 * Rejects with `error` if `promise` has not settled within `ms`.
 *
 * The losing promise is abandoned, not cancelled — neither a queued throttle slot nor an in-flight
 * axios request is retracted. That is acceptable here because the deadline only bounds what the
 * ROUTE waits for: an abandoned slot belongs to the certification limiter alone, and an abandoned
 * request carries its own axios timeout. Its rejection is swallowed so a late supplier failure
 * cannot surface as an unhandled rejection after the probe has already reported.
 */
function withDeadline(promise, ms, error) {
  let timer;
  Promise.resolve(promise).catch(() => {});
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(error), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const COMMISSION_GROUP_ARRAY_KEYS = [
  "response",
  "data",
  "results",
  "items",
  "commissionGroups",
  "commission_groups",
  "commissionGroup",
  "groups",
];

/**
 * Rows of GET /campaigns/{campaignId}/commission-groups.
 *
 * Unlike the generic extractRows(), an unrecognised non-empty object is never
 * reported as "zero groups": that would silently turn a broken envelope into a
 * campaign with no commission rules. Recognised shapes: a bare array, or an object
 * whose response/data/results/items/commissionGroups/commission_groups/commissionGroup/
 * groups member is an array (one level of payload.data / data.commissionGroups nesting).
 *
 * @returns {{ groups: object[], envelopeKind: string }}
 */
export function extractCommissionGroupRows(responseData) {
  if (responseData == null || responseData === "") return { groups: [], envelopeKind: "empty" };
  if (Array.isArray(responseData)) return { groups: responseData, envelopeKind: "array" };
  if (typeof responseData !== "object") {
    const error = new Error("Optimise commission-groups response is not JSON");
    error.code = "optimise_commission_groups_unrecognised_envelope";
    throw error;
  }

  const candidates = [responseData, responseData.payload, responseData.data].filter(
    (value) => value && typeof value === "object" && !Array.isArray(value),
  );
  for (const container of candidates) {
    for (const key of COMMISSION_GROUP_ARRAY_KEYS) {
      if (Array.isArray(container[key])) {
        return {
          groups: container[key],
          envelopeKind: container === responseData ? key : `${container === responseData.payload ? "payload" : "data"}.${key}`,
        };
      }
    }
  }

  // A single commission-group object (has an id) is one row.
  const single = responseData.data && typeof responseData.data === "object" ? responseData.data : responseData;
  if (single && typeof single === "object" && !Array.isArray(single)) {
    const keys = Object.keys(single);
    if (!keys.length) return { groups: [], envelopeKind: "empty_object" };
    if (keys.includes("id") || keys.includes("commissionGroupId") || keys.includes("groupId")) {
      return { groups: [single], envelopeKind: "single_object" };
    }
  }

  const error = new Error(
    `Optimise commission-groups response envelope not recognised (keys: ${Object.keys(responseData).slice(0, 8).join(", ")})`,
  );
  error.code = "optimise_commission_groups_unrecognised_envelope";
  error.responseKeys = Object.keys(responseData).slice(0, 20);
  throw error;
}

function assertCampaignId(campaignId) {
  const text = campaignId == null ? "" : String(campaignId).trim();
  if (!text || /[\/\s?#]/.test(text)) {
    const error = new Error(`Invalid Optimise campaignId for commission-groups: ${JSON.stringify(campaignId)}`);
    error.code = "optimise_commission_groups_invalid_campaign_id";
    throw error;
  }
  return text;
}

async function fetchOffsetPaginated(httpClient, endpoint, baseParams) {
  const rows = [];
  let offset = 0;
  const limit = Number(baseParams.limit ?? OPTIMISE_PAGE_LIMIT);

  for (;;) {
    const response = await requestWithOptimiseLimits(() =>
      httpClient.get(endpoint, {
        params: {
          ...baseParams,
          offset,
          limit,
        },
      }),
    );

    const pageRows = extractRows(response.data);
    rows.push(...pageRows);

    if (pageRows.length < limit) {
      break;
    }
    offset += limit;
  }

  return rows;
}


/**
 * Downloads a feed body, byte-capped, without ever leaving the allowed host.
 *
 * Redirects are followed MANUALLY. Node's fetch follows them automatically by default, across hosts
 * and down to any port — so validating only the URL we pass in would leave a one-hop bypass: a 302
 * from the feed host to a loopback or link-local address would be followed, and its body returned
 * to us as feed content. Each hop is revalidated against the same policy as the first.
 *
 * No MBO credential is ever sent. This uses the global fetch with an Accept header, not the
 * Optimise httpClient, so the apikey / x-agency-id / x-contact-id headers do not exist on this
 * request. Only the `aid` already inside the feed URL is sent, which is the affiliate identifier
 * the feed host itself issued.
 */
async function fetchFeedTextLimited(url, { timeoutMs = 25000, maxBytes = 2_000_000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = assertAllowedFeedUrl(url).toString();
    let res = null;

    for (let hop = 0; ; hop += 1) {
      res = await fetch(target, {
        signal: controller.signal,
        redirect: "manual",
        headers: { Accept: "text/csv,application/xml,text/plain,*/*", ...headers },
      });
      if (res.status < 300 || res.status > 399) break;

      const location = res.headers.get("location");
      if (!location) break;
      if (hop >= MAX_FEED_REDIRECTS) throw new FeedUrlNotAllowedError("TOO_MANY_REDIRECTS");
      // Relative redirects resolve against the current target, which is already allowlisted.
      target = assertAllowedFeedUrl(new URL(location, target).toString()).toString();
      await res.body?.cancel().catch(() => {});
    }

    if (!res.ok) {
      // The status is reported; the body is not. A response body reached through a redirect may be
      // internal, and this error is surfaced in an admin API response.
      const err = new Error(`Optimise product feed download failed with status ${res.status}`);
      err.response = { status: res.status };
      throw err;
    }
    // Stream and cap bytes so multi-GB feeds do not hang res.text()
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let text = "";
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (bytes >= maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          controller.abort();
          break;
        }
      }
      text += decoder.decode();
      return { text, truncated: bytes >= maxBytes, status: res.status, url };
    }
    const text = await res.text();
    return { text, truncated: false, status: res.status, url };
  } finally {
    clearTimeout(timer);
  }
}

export function createOptimiseAdapter({
  apiKey,
  baseURL = "https://public.api.optimisemedia.com/v1",
  agencyId,
  contactId,
  httpClient: injectedHttpClient = null,
  certificationRateLimiter: injectedCertificationLimiter = null,
}) {
  if (!agencyId || !contactId) {
    throw new Error("Optimise adapter requires agencyId and contactId");
  }

  const httpClient =
    injectedHttpClient ??
    createHttpClient({
      baseURL,
      apiKey,
      headers: {
        apikey: String(apiKey),
        "x-agency-id": String(agencyId),
        "x-contact-id": String(contactId),
      },
    });

  const certLimiter = injectedCertificationLimiter ?? certificationRateLimiter;

  const commonParams = { agencyId, contactId };

  return {
    supplierKey: "OPTIMISE",
    getCapabilities() {
      return {
        capabilities: [
          "CAMPAIGNS",
          "COUPONS",
          "CONVERSIONS",
          "PAYMENTS",
          "INVOICES",
          "REPORTING",
          "COMMISSION_GROUPS",
          "MULTI_CURRENCY",
          "TRACKING_SUBID",
        ],
        pagination: "page",
      };
    },
    /**
     * One supplier request for certification. Never paginates, never retries, always bounded.
     *
     * The throttle is respected but not waited on indefinitely: if a slot cannot be obtained
     * inside the budget the request is not sent at all and the caller is told it was throttled.
     */
    async fetchCertificationSample(sourceObject, ctx = {}) {
      const spec = CERTIFICATION_SAMPLES[sourceObject];
      if (!spec) throw new Error(`No certification sample is defined for "${sourceObject}"`);
      if (spec.needs === "campaignId" && !ctx.campaignId) {
        throw new Error(`Certification sample "${sourceObject}" requires a campaign id`);
      }

      const timeoutMs = Number(ctx.timeoutMs || CERTIFICATION_SAMPLE_TIMEOUT_MS);
      const throttleBudgetMs = Number(ctx.throttleBudgetMs ?? Math.min(timeoutMs, 5000));

      // Pace against other probes, but never queue behind them for minutes.
      await withDeadline(
        certLimiter.acquireSlot(),
        throttleBudgetMs,
        new CertificationThrottledError(),
      );

      const response = await withDeadline(
        httpClient.get(spec.path(ctx), {
          params: { ...commonParams, ...spec.params(ctx) },
          timeout: timeoutMs,
        }),
        timeoutMs,
        new CertificationTimeoutError(),
      );

      // At most one row is summarised, whatever the supplier chose to return.
      return extractRows(response.data).slice(0, 1);
    },

    /**
     * One bounded product-item sample, derived from an already-sampled feed row.
     *
     * This is the second and last request of the products chain. It cannot download a catalog:
     * `fetchFeedTextLimited` streams, and at CERTIFICATION_FEED_SAMPLE_BYTES it cancels the reader
     * and aborts the request, so the transfer stops at the window whatever the feed's real size is.
     * A Range header asks the CDN to send only that window in the first place — an optimisation, not
     * the guarantee, since a CDN that ignores Range still hits the streaming cap.
     *
     * Exactly one URL is tried. The sync path walks up to three candidate URLs on failure; here a
     * failure is a result to report, not something to retry against another host.
     */
    async fetchCertificationFeedItemSample(feedRow, ctx = {}) {
      const url = buildBoundedFeedUrl(feedRow, { aid: contactId, format: "csv" });
      const maxBytes = Number(ctx.maxBytes || CERTIFICATION_FEED_SAMPLE_BYTES);
      const timeoutMs = Number(ctx.timeoutMs || CERTIFICATION_SAMPLE_TIMEOUT_MS);

      await withDeadline(
        certLimiter.acquireSlot(),
        Number(ctx.throttleBudgetMs ?? Math.min(timeoutMs, 5000)),
        new CertificationThrottledError(),
      );

      const { text, truncated } = await withDeadline(
        fetchFeedTextLimited(url, {
          timeoutMs,
          maxBytes,
          headers: { Range: `bytes=0-${maxBytes - 1}` },
        }),
        timeoutMs,
        new CertificationTimeoutError(),
      );

      const { record, feedFormat } = parseFirstFeedRecord(text, { truncated });
      return { rows: [record], feedFormat, truncated };
    },
    fetchCampaigns(params = {}) {
      return fetchOffsetPaginated(httpClient, "/campaigns", {
        ...commonParams,
        extendedData: true,
        // Master Field Mapping: relationship from publishers[].campaignSubStatus
        returnPublishersForCampaign: true,
        ...params,
      });
    },
    fetchCampaignDetail(campaignId) {
      return requestWithRetry(() =>
        httpClient.get(`/campaigns/${campaignId}`, {
          params: commonParams,
        }),
      ).then((res) => res.data);
    },
    /**
     * Detailed supplier commission groups for one campaign:
     * GET /campaigns/{campaignId}/commission-groups (apikey / x-agency-id / x-contact-id).
     * Campaign-scoped: callers issue one request per campaign through the shared
     * rate limiter; failures propagate (never an invented empty success).
     *
     * @returns {Promise<{ campaignId: string, groups: object[], envelopeKind: string, httpStatus: number|null, fetchedAt: Date }>}
     */
    async fetchCommissionGroups(campaignId) {
      const id = assertCampaignId(campaignId);
      const response = await requestWithOptimiseLimits(() =>
        httpClient.get(`/campaigns/${encodeURIComponent(id)}/commission-groups`, {
          params: commonParams,
        }),
      );
      const { groups, envelopeKind } = extractCommissionGroupRows(response?.data);
      return {
        campaignId: id,
        groups,
        envelopeKind,
        httpStatus: response?.status ?? null,
        fetchedAt: new Date(),
      };
    },
    fetchConversions(params = {}) {
      const {
        fromDate,
        toDate,
        dateField = "conversion",
        targetCurrencyCode = "USD",
        conversionType = "conversions",
        limit,
        offset,
        ...rest
      } = params;

      if (!fromDate || !toDate) {
        throw new Error("Optimise conversions requires fromDate and toDate (YYYY-MM-DD)");
      }

      return fetchOffsetPaginated(httpClient, "/conversions", {
        ...commonParams,
        ...rest,
        fromDate,
        toDate,
        dateField,
        targetCurrencyCode,
        conversionType,
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      });
    },
    fetchPayments(params = {}) {
      const { startDate, endDate, ...rest } = params;
      if (!startDate || !endDate) {
        throw new Error("Optimise payments requires startDate and endDate (YYYY-MM-DD)");
      }

      return fetchOffsetPaginated(httpClient, "/payments", {
        ...commonParams,
        ...rest,
        startDate,
        endDate,
      });
    },
    fetchInvoices(params = {}) {
      const { startDate, endDate, ...rest } = params;
      if (!startDate || !endDate) {
        throw new Error("Optimise invoices requires startDate and endDate (YYYY-MM-DD)");
      }

      return fetchOffsetPaginated(httpClient, "/invoices", {
        ...commonParams,
        ...rest,
        startDate,
        endDate,
      });
    },
    async fetchReporting(params = {}) {
      const {
        fromDate,
        toDate,
        targetCurrency = "USD",
        dateType = "conversionDate",
        dateGroupBy = "daily",
        measures = DEFAULT_REPORTING_MEASURES,
        dimensions = DEFAULT_REPORTING_DIMENSIONS,
        conditions = [],
        orderBys = [{ direction: "desc", field: "date" }],
      } = params;

      if (!fromDate || !toDate) {
        throw new Error("Optimise reporting requires fromDate and toDate (YYYY-MM-DD)");
      }

      const body = {
        measures,
        dimensions,
        conditions,
        orderBys,
        dateType,
        fromDate: toOptimiseReportingDate(fromDate),
        toDate: toOptimiseReportingDate(toDate),
        targetCurrency,
        dateGroupBy,
        includeOriginalCurrency: true,
        includeTargetCurrency: true,
      };

      await optimiseRateLimiter.acquireSlot();
      const response = await requestWithRetry(
        () =>
          httpClient.post("/reporting/", body, {
            params: commonParams,
          }),
        { retries: 6, delayMs: 2000 },
      );

      return extractRows(response.data);
    },
    fetchInvoiceReporting(params = {}) {
      return this.fetchReporting({
        measures: INVOICE_REPORTING_MEASURES,
        dimensions: INVOICE_REPORTING_DIMENSIONS,
        dateType: "invoiceDate",
        ...params,
      });
    },
    fetchVoucherCodes(params = {}) {
      return fetchOffsetPaginated(httpClient, "/vouchercodes", { ...commonParams, ...params });
    },
    fetchCoupons(params = {}) {
      return this.fetchVoucherCodes(params);
    },
    /**
     * List product feeds for campaigns the publisher is promoting.
     * feedId + AID builds the download URL (docs.optimisemedia.com publishers/tools).
     */
    fetchProductFeeds(params = {}) {
      return fetchOffsetPaginated(httpClient, "/product-feeds/", { ...commonParams, ...params });
    },
    /**
     * Download product feed rows. Prefer list API feedUrl (already includes AID).
     * Does not use the Optimise API rate limiter — product-feeds host is separate.
     */
    async fetchProductFeedItems({
      feedId,
      feedUrl = null,
      aid = contactId,
      format = "csv",
      maxRows = 100,
    } = {}) {
      const affiliateId = aid || contactId;
      const candidates = [];
      const pushUnique = (u) => {
        const s = String(u || "").trim();
        if (s && !candidates.includes(s)) candidates.push(s);
      };
      // CDN requires lowercase `aid` (uppercase AID → 400). Prefer csv over huge xml list URLs.
      const rewriteFeedUrl = (raw, fmt) => {
        try {
          const u = new URL(String(raw));
          const aidVal = u.searchParams.get("aid") || u.searchParams.get("AID") || affiliateId;
          if (aidVal) {
            u.searchParams.delete("AID");
            u.searchParams.set("aid", String(aidVal));
          }
          u.searchParams.delete("Format");
          u.searchParams.set("format", String(fmt || format || "csv"));
          return u.toString();
        } catch {
          return null;
        }
      };
      if (feedUrl) {
        const asCsv = rewriteFeedUrl(feedUrl, format);
        if (asCsv) pushUnique(asCsv);
        // keep original list URL as fallback (may be xml)
        pushUnique(feedUrl);
      }
      if (feedId && affiliateId) {
        const id = encodeURIComponent(String(feedId));
        const a = encodeURIComponent(String(affiliateId));
        const fmt = encodeURIComponent(format);
        // lowercase aid/format — Optimise CDN is case-sensitive on query keys
        pushUnique(`https://product-feeds.optimisemedia.com/feeds/${id}?aid=${a}&format=${fmt}`);
        pushUnique(`https://product-feeds.optimisemedia.com/${id}?aid=${a}&format=${fmt}`);
      }
      // Every generated candidate is revalidated, not just the supplier's original URL: the
      // rewrite above copies the supplier's host into a new URL, so a rewritten candidate is
      // exactly as untrusted as the one it came from.
      const safeCandidates = candidates.filter((candidate) => isAllowedFeedUrl(candidate));
      if (!safeCandidates.length) {
        if (candidates.length) throw new FeedUrlNotAllowedError("HOST_NOT_ALLOWED");
        return [];
      }

      let lastError = null;
      // ~64KB per product is generous; cap keeps huge BliBli-style feeds usable
      const maxBytes = Math.min(8_000_000, Math.max(256_000, Number(maxRows || 100) * 64_000));
      for (const full of safeCandidates.slice(0, 3)) {
        try {
          const { text } = await fetchFeedTextLimited(full, { timeoutMs: 25000, maxBytes });
          const rows = parseOptimiseFeedCsv(text, maxRows);
          if (rows.length) return rows;
          if (text.includes("<")) {
            const xmlRows = parseOptimiseFeedXml(text, maxRows);
            if (xmlRows.length) return xmlRows;
          }
          lastError = new Error(`empty_feed_body:${full.slice(0, 120)}`);
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      return [];
    },
    async fetchAll(params = {}) {
      const campaigns = await this.fetchCampaigns(params.campaigns);
      const conversions = await this.fetchConversions(params.conversions);
      const conversionsByPayment = await this.fetchConversions({
        ...params.conversions,
        conversionType: "conversionsByPayment",
      });
      const reporting = await this.fetchReporting(params.reporting);
      const invoiceReporting = await this.fetchInvoiceReporting(params.invoiceReporting ?? params.reporting);
      const payments = await this.fetchPayments(params.payments);
      const invoices = await this.fetchInvoices(params.invoices ?? params.payments);
      const voucherCodes = await this.fetchVoucherCodes(params.voucherCodes);

      return {
        campaigns,
        campaignDetails: [],
        conversions,
        conversionsByPayment,
        reporting,
        invoiceReporting,
        payments,
        invoices,
        voucherCodes,
      };
    },
  };
}
