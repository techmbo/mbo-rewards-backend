import { createHttpClient, requestWithRetry } from "../core/httpClient.js";
import { createRateLimiter } from "../core/rateLimiter.js";
import { asArray } from "../core/normalize.js";
import { SUPPLIER_CAPABILITIES } from "./contract.js";

/**
 * Awin Publisher API adapter.
 *
 * Auth: Authorization: Bearer <token> (user-level; may span multiple publisherIds).
 * Throttle: 20 calls/min/user (shared limiter).
 * Transactions: max 31-day windows; dateType = transaction | validation | amendment.
 *
 * Does NOT create finance, assignments, or client commission.
 * Sources: Awin publisher API docs (help.awin.com/apidocs).
 */

const AWIN_MIN_INTERVAL_MS = Number(process.env.AWIN_MIN_INTERVAL_MS || 3000); // ~20/min
const awinRateLimiter = createRateLimiter(AWIN_MIN_INTERVAL_MS);

function extractCollection(data, keys = []) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (data && typeof data === "object") {
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && value.length && typeof value[0] === "object") {
        return value;
      }
    }
  }
  return [];
}

/**
 * @param {object} opts
 * @param {string} opts.accessToken — OAuth2 Bearer token
 * @param {string|number} opts.publisherId — explicit publisher account
 * @param {string} [opts.baseURL]
 */
export function createAwinAdapter({
  accessToken,
  publisherId,
  baseURL = process.env.AWIN_BASE_URL || "https://api.awin.com",
} = {}) {
  if (!accessToken) throw new Error("Awin adapter requires accessToken");
  if (publisherId == null || String(publisherId).trim() === "") {
    throw new Error("Awin adapter requires publisherId (explicit NetworkAccount mapping)");
  }

  const pubId = encodeURIComponent(String(publisherId));
  const root = String(baseURL).replace(/\/$/, "");
  const httpClient = createHttpClient({
    baseURL: root,
    apiKey: `Bearer ${accessToken}`,
    headers: { Accept: "application/json" },
  });

  async function get(path, params = {}, stats = null) {
    await awinRateLimiter.acquireSlot();
    if (stats) stats.requestCount = (stats.requestCount || 0) + 1;
    const response = await requestWithRetry(
      () => httpClient.get(path, { params }),
      { retries: 3, delayMs: 1000 },
    );
    return response?.data;
  }

  async function post(path, body = {}, stats = null) {
    await awinRateLimiter.acquireSlot();
    if (stats) stats.requestCount = (stats.requestCount || 0) + 1;
    const response = await requestWithRetry(
      () => httpClient.post(path, body),
      { retries: 3, delayMs: 1000 },
    );
    return response?.data;
  }

  return {
    supplierKey: "AWIN",
    publisherId: String(publisherId),

    getCapabilities() {
      return {
        capabilities: [
          SUPPLIER_CAPABILITIES.CAMPAIGNS,
          SUPPLIER_CAPABILITIES.COUPONS,
          SUPPLIER_CAPABILITIES.CONVERSIONS,
          SUPPLIER_CAPABILITIES.PRODUCTS,
          SUPPLIER_CAPABILITIES.DEEP_LINK,
          SUPPLIER_CAPABILITIES.ORDER_ITEMS,
          SUPPLIER_CAPABILITIES.TRACKING_SUBID,
          SUPPLIER_CAPABILITIES.REPORTING,
        ],
        pagination: "page",
        notes: [
          "OAuth2 Bearer; publisherId must be mapped explicitly (token may span accounts).",
          "Throttle 20 req/min/user — shared rate limiter.",
          "Transactions max 31-day window; poll transaction + validation + amendment dateTypes.",
        ],
      };
    },

    async authenticate() {
      try {
        await get(`/publishers/${pubId}/accounts`);
        return { ok: true };
      } catch (error) {
        return { ok: false, detail: error?.message || "Awin auth failed" };
      }
    },

    async healthCheck() {
      return this.authenticate();
    },

    /**
     * Programmes = NetworkCampaign layer.
     * relationship = joined | pending | suspended | rejected | notjoined
     */
    async fetchCampaigns(params = {}, stats = null) {
      const data = await get(
        `/publishers/${pubId}/programmes`,
        {
          relationship: params.relationship ?? "joined",
          ...(params.countryCode ? { countryCode: params.countryCode } : {}),
        },
        stats,
      );
      return asArray(extractCollection(data, ["programmes", "data"]));
    },

    async fetchCommissionGroups({ advertiserId, effectiveDate, extraConditionsDetails = true } = {}, stats = null) {
      if (!advertiserId) throw new Error("Awin commission groups require advertiserId");
      const data = await get(
        `/publishers/${pubId}/commissiongroups`,
        {
          advertiserId,
          ...(effectiveDate ? { effectiveDate } : {}),
          extraConditionsDetails: Boolean(extraConditionsDetails),
        },
        stats,
      );
      return asArray(extractCollection(data, ["commissionGroups", "data"]));
    },

    /** Offers / vouchers */
    async fetchCoupons(params = {}, stats = null) {
      const body = {
        filters: params.filters ?? {},
        pagination: params.pagination ?? { page: 1, pageSize: 200 },
      };
      const data = await post(`/publisher/${pubId}/promotions`, body, stats);
      return asArray(extractCollection(data, ["data", "promotions", "offers"]));
    },

    /**
     * Transactions — primary individual order source.
     * Must partition into <=31-day windows externally for historical backfill.
     */
    async fetchConversions(params = {}, stats = null) {
      const startDate = params.startDate;
      const endDate = params.endDate;
      if (!startDate || !endDate) {
        throw new Error("Awin transactions require startDate and endDate (<=31 days)");
      }
      const start = new Date(startDate);
      const end = new Date(endDate);
      const days = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
      if (days > 31.0001) {
        throw new Error("Awin transaction window cannot exceed 31 days");
      }

      const data = await get(
        `/publishers/${pubId}/transactions/`,
        {
          startDate,
          endDate,
          dateType: params.dateType ?? "transaction",
          ...(params.status ? { status: params.status } : {}),
          ...(params.timezone ? { timezone: params.timezone } : {}),
          showBasketProducts: params.showBasketProducts !== false,
        },
        stats,
      );
      return asArray(extractCollection(data, ["transactions", "data"]));
    },

    async fetchPayments() {
      // Awin finance/payment evidence is mapped separately from transaction approval.
      return [];
    },

    /**
     * Performance rows for NetworkPerformanceFact.
     * Awin has no standalone clicks report here — derive daily grain from transactions.
     * networkClicks stay null unless the transaction payload explicitly includes clicks.
     */
    async fetchPerformance(params = {}, stats = null) {
      const conversions = Array.isArray(params.prefetchedConversions)
        ? params.prefetchedConversions
        : await this.fetchConversions(params.conversions || params, stats);
      return conversions.map((row) => {
        const status = String(row.commissionStatus || row.status || row.State || "").toLowerCase();
        return {
          ...row,
          date:
            row.transactionDate ||
            row.transactionDateTime ||
            row.validationDate ||
            row.date ||
            null,
          campaign_id: row.advertiserId ?? row.programmeId ?? row.campaignId ?? null,
          campaign_name:
            row.advertiserName ?? row.programmeName ?? row.campaignName ?? row.advertiser?.name ?? null,
          advertiser_name: row.advertiserName ?? row.advertiser?.name ?? null,
          clicks: row.clicks ?? row.clickCount ?? null,
          orders: 1,
          totalConversions: 1,
          validatedConversions:
            status === "approved" || status.includes("approv") ? 1 : null,
          pendingConversions: status === "pending" || status.includes("pend") ? 1 : null,
          rejectedConversions:
            status === "declined" || status.includes("reject") || status.includes("declin")
              ? 1
              : null,
          commissionAmount: row.commissionAmount ?? null,
          saleAmount: row.saleAmount ?? null,
          currency:
            row.commissionAmount?.currency ??
            row.saleAmount?.currency ??
            row.currency ??
            row.currencyCode ??
            null,
          country: row.customerCountry ?? row.advertiserCountry ?? row.countryCode ?? row.country ?? null,
          coupon_code: row.voucherCode ?? row.voucherCodeUsed ?? row.couponCode ?? null,
          click_id: row.clickRef ?? row.clickRef1 ?? row.click_id ?? null,
          report_type: "awin_transaction_derived",
        };
      });
    },

    async fetchAll(options = {}) {
      const stats = { requestCount: 0 };
      const [campaigns, coupons] = await Promise.all([
        this.fetchCampaigns(options.campaigns ?? {}, stats),
        this.fetchCoupons(options.coupons ?? {}, stats).catch(() => []),
      ]);
      let conversions = [];
      if (options.conversions?.startDate && options.conversions?.endDate) {
        conversions = await this.fetchConversions(options.conversions, stats);
      }
      const performance = options.skipPerformance
        ? []
        : await this.fetchPerformance(
            { prefetchedConversions: conversions, conversions: options.conversions ?? {} },
            stats,
          );
      return { campaigns, coupons, conversions, performance, stats };
    },
  };
}
