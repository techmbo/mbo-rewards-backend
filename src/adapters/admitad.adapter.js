import { createHttpClient, requestWithRetry } from "../core/httpClient.js";
import { SUPPLIER_CAPABILITIES } from "./contract.js";

const DEFAULT_LIMIT = 500;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function extractAdmitadCollection(payload) {
  if (Array.isArray(payload)) return payload;
  const body = asObject(payload);
  for (const key of ["results", "data", "items"]) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

export function extractAdmitadMeta(payload, fallback = {}) {
  const body = asObject(payload);
  const meta = asObject(body._meta);
  const count = Number(meta.count);
  const limit = Number(meta.limit ?? fallback.limit);
  const offset = Number(meta.offset ?? fallback.offset);
  return {
    count: Number.isFinite(count) ? count : null,
    limit: Number.isFinite(limit) && limit > 0 ? limit : Number(fallback.limit) || DEFAULT_LIMIT,
    offset: Number.isFinite(offset) && offset >= 0 ? offset : Number(fallback.offset) || 0,
  };
}

export function buildAdmitadActionParams(params = {}) {
  const allowed = [
    "action_id_start",
    "date_start",
    "date_end",
    "closing_date_start",
    "closing_date_end",
    "status_updated_start",
    "status_updated_end",
    "website",
    "campaign",
    "subid",
    "subid1",
    "subid2",
    "subid3",
    "subid4",
    "status",
    "action_id",
    "action_type",
    "processed",
    "paid",
    "order_by",
  ];
  const out = {};
  for (const key of allowed) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
      out[key] = params[key];
    }
  }
  if (!out.order_by) out.order_by = "datetime";
  return out;
}

/**
 * Preserve Admitad order state and network payment evidence as separate facts.
 * This helper intentionally performs no canonical order-status mapping; status
 * mapping remains source-scoped and must be backed by verified raw samples.
 */
export function normalizeAdmitadActionEvidence(row = {}) {
  const input = asObject(row);
  return {
    ...input,
    networkRawStatus: input.status ?? null,
    networkProcessed: input.processed ?? null,
    networkPaid: input.paid ?? null,
    actionId: input.action_id ?? input.id ?? null,
    subid: input.subid ?? null,
    subid1: input.subid1 ?? null,
    subid2: input.subid2 ?? null,
    subid3: input.subid3 ?? null,
    subid4: input.subid4 ?? null,
  };
}

/**
 * Admitad Publisher API adapter.
 *
 * Verified source surface used here:
 * - OAuth2 Bearer access token
 * - GET /websites/v2/
 * - GET /advcampaigns/ and /advcampaigns/website/{w_id}/
 * - GET /coupons/
 * - GET /statistics/actions/
 * - global limit/offset pagination with max limit 500
 *
 * Product CSV/XML feed download and account-specific status mappings are kept
 * outside this foundation until live publisher fixtures prove the exact shapes.
 */
export function createAdmitadAdapter({
  accessToken,
  baseURL = process.env.ADMITAD_BASE_URL || "https://api.admitad.com",
} = {}) {
  if (!accessToken) throw new Error("Admitad adapter requires accessToken");

  const root = String(baseURL).replace(/\/$/, "");
  const httpClient = createHttpClient({
    baseURL: root,
    apiKey: `Bearer ${accessToken}`,
    headers: { Accept: "application/json" },
  });

  async function get(path, params = {}, stats = null) {
    if (stats) stats.requestCount = (stats.requestCount || 0) + 1;
    const response = await requestWithRetry(
      () => httpClient.get(path, { params }),
      { retries: 3, delayMs: 1000 },
    );
    return response?.data;
  }

  async function fetchOffsetPaginated(path, params = {}, stats = null) {
    const requestedLimit = Number(params.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(1, requestedLimit), DEFAULT_LIMIT)
      : DEFAULT_LIMIT;
    let offset = Number.isFinite(Number(params.offset)) ? Math.max(0, Number(params.offset)) : 0;
    const baseParams = { ...params };
    delete baseParams.limit;
    delete baseParams.offset;

    const rows = [];
    const pages = [];
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const payload = await get(path, { ...baseParams, limit, offset }, stats);
      const pageRows = extractAdmitadCollection(payload);
      const meta = extractAdmitadMeta(payload, { limit, offset });
      rows.push(...pageRows);
      pages.push({ payload, meta });

      if (!pageRows.length) break;
      const nextOffset = meta.offset + meta.limit;
      if (meta.count != null && nextOffset >= meta.count) break;
      if (pageRows.length < meta.limit) break;
      offset = nextOffset;
    }

    return { rows, pages };
  }

  return {
    supplierKey: "ADMITAD",

    getCapabilities() {
      return {
        capabilities: [
          SUPPLIER_CAPABILITIES.CAMPAIGNS,
          SUPPLIER_CAPABILITIES.COUPONS,
          SUPPLIER_CAPABILITIES.CONVERSIONS,
          SUPPLIER_CAPABILITIES.DEEP_LINK,
          SUPPLIER_CAPABILITIES.TRACKING_SUBID,
          SUPPLIER_CAPABILITIES.REPORTING,
        ],
        pagination: "offset",
        notes: [
          "OAuth2 Bearer token; credential refresh belongs to NetworkAccount credential state.",
          "Programmes, coupons and action reporting use verified publisher API endpoints.",
          "status, processed and paid remain separate source facts.",
          "Product CSV/XML feed ingestion is deferred until a live feed fixture is captured.",
        ],
      };
    },

    async authenticate(stats = null) {
      try {
        await get("/websites/v2/", { limit: 1, offset: 0 }, stats);
        return { ok: true };
      } catch (error) {
        return { ok: false, detail: error?.message || "Admitad auth failed" };
      }
    },

    async healthCheck(stats = null) {
      return this.authenticate(stats);
    },

    async fetchWebsites(params = {}, stats = null) {
      const result = await fetchOffsetPaginated("/websites/v2/", params, stats);
      return result.rows;
    },

    async fetchCampaigns(params = {}, stats = null) {
      const websiteId = params.websiteId ?? params.website ?? null;
      const requestParams = { ...params };
      delete requestParams.websiteId;
      delete requestParams.website;
      const path = websiteId
        ? `/advcampaigns/website/${encodeURIComponent(String(websiteId))}/`
        : "/advcampaigns/";
      const result = await fetchOffsetPaginated(path, requestParams, stats);
      return result.rows;
    },

    async fetchCoupons(params = {}, stats = null) {
      const result = await fetchOffsetPaginated("/coupons/", params, stats);
      return result.rows;
    },

    async fetchConversions(params = {}, stats = null) {
      const actionParams = buildAdmitadActionParams(params);
      if (params.limit != null) actionParams.limit = params.limit;
      if (params.offset != null) actionParams.offset = params.offset;
      const result = await fetchOffsetPaginated("/statistics/actions/", actionParams, stats);
      return result.rows.map(normalizeAdmitadActionEvidence);
    },

    async fetchPerformance(params = {}, stats = null) {
      return this.fetchConversions(params, stats);
    },

    async fetchAll(options = {}) {
      const stats = { requestCount: 0 };
      const campaigns = options.skipCampaigns
        ? []
        : await this.fetchCampaigns(options.campaigns ?? {}, stats);
      const coupons = options.skipCoupons
        ? []
        : await this.fetchCoupons(options.coupons ?? {}, stats);
      const conversions = options.skipConversions
        ? []
        : await this.fetchConversions(options.conversions ?? {}, stats);
      return {
        campaigns,
        coupons,
        conversions,
        performance: conversions,
        stats,
      };
    },
  };
}
