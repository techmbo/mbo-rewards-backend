import { createHttpClient, requestWithRetry } from "../core/httpClient.js";
import { createRateLimiter } from "../core/rateLimiter.js";

const OPTIMISE_MIN_INTERVAL_MS = Number(process.env.OPTIMISE_MIN_INTERVAL_MS || 12500);
const OPTIMISE_PAGE_LIMIT = Number(process.env.OPTIMISE_PAGE_LIMIT || 100);
const optimiseRateLimiter = createRateLimiter(OPTIMISE_MIN_INTERVAL_MS);

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

/**
 * Validate a value destined for a URL path segment.
 *
 * Optimise keys its endpoints by DIFFERENT identifiers — detail by productId,
 * commission-groups by campaignId — so the label is required: an error must name
 * the identifier that was actually wrong, not a generic "campaignId".
 */
function assertPathIdentifier(value, { label, code }) {
  const text = value == null ? "" : String(value).trim();
  if (!text || /[\/\s?#]/.test(text)) {
    const error = new Error(`Invalid Optimise ${label}: ${JSON.stringify(value)}`);
    error.code = code;
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


async function fetchFeedTextLimited(url, { timeoutMs = 25000, maxBytes = 2_000_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/csv,application/xml,text/plain,*/*" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`Optimise product feed download failed: ${res.status} ${body.slice(0, 120)}`);
      err.response = { status: res.status, url, body: body.slice(0, 300) };
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
    fetchCampaigns(params = {}) {
      return fetchOffsetPaginated(httpClient, "/campaigns", {
        ...commonParams,
        extendedData: true,
        // Master Field Mapping: relationship from publishers[].campaignSubStatus
        returnPublishersForCampaign: true,
        ...params,
      });
    },
    /**
     * Campaign detail: GET /campaigns/{productId}.
     *
     * Optimise keys this endpoint by productId, NOT by campaignId. Callers must
     * pass an explicit productId; a campaignId or a generic `id` addresses a
     * different namespace and must never be substituted here.
     */
    fetchCampaignDetail(productId) {
      const id = assertPathIdentifier(productId, {
        label: "productId for campaign detail",
        code: "optimise_campaign_detail_invalid_product_id",
      });
      return requestWithRetry(() =>
        httpClient.get(`/campaigns/${encodeURIComponent(id)}`, {
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
      const id = assertPathIdentifier(campaignId, {
        label: "campaignId for commission-groups",
        code: "optimise_commission_groups_invalid_campaign_id",
      });
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
      if (!candidates.length) return [];

      let lastError = null;
      // ~64KB per product is generous; cap keeps huge BliBli-style feeds usable
      const maxBytes = Math.min(8_000_000, Math.max(256_000, Number(maxRows || 100) * 64_000));
      for (const full of candidates.slice(0, 3)) {
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
