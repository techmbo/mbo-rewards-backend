import { createHttpClient, requestWithRetry } from "../core/httpClient.js";
import { createRateLimiter } from "../core/rateLimiter.js";
import { asArray } from "../core/normalize.js";
import { SUPPLIER_CAPABILITIES } from "./contract.js";

/**
 * Impact Publisher (MediaPartner) adapter — Wave E.
 *
 * Auth: HTTP Basic AccountSID:AuthToken (Impact docs).
 * Base: https://api.impact.com/Mediapartners/{AccountSID}/...
 *
 * Does NOT create finance, assignments, or commissions.
 * Sources: Impact Partner API auth + Campaigns/Actions references.
 */

const IMPACT_MIN_INTERVAL_MS = Number(process.env.IMPACT_MIN_INTERVAL_MS || 500);
const impactRateLimiter = createRateLimiter(IMPACT_MIN_INTERVAL_MS);

function extractCollection(data, keys = []) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  // Impact often nests under pluralized resource name
  if (data && typeof data === "object") {
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && value.length && typeof value[0] === "object") {
        return value;
      }
    }
  }
  return [];
}

function hasNextPage(data, page, pageSize, rowsCount) {
  if (data?.["@nextpageuri"] || data?.nextpageuri || data?.NextPageUri) return true;
  if (data?.["@numpages"] != null) return page < Number(data["@numpages"]);
  if (data?.NumPages != null) return page < Number(data.NumPages);
  return rowsCount >= pageSize;
}

/**
 * @param {object} opts
 * @param {string} opts.accountSid
 * @param {string} opts.authToken
 * @param {string} [opts.baseURL]
 */
export function createImpactAdapter({
  accountSid,
  authToken,
  baseURL = process.env.IMPACT_BASE_URL || "https://api.impact.com",
} = {}) {
  if (!accountSid || !authToken) {
    throw new Error("Impact adapter requires accountSid and authToken");
  }

  const sid = String(accountSid);
  const root = `${String(baseURL).replace(/\/$/, "")}/Mediapartners/${encodeURIComponent(sid)}`;

  // createHttpClient sets Authorization to apiKey string; pass Basic token.
  const basic = Buffer.from(`${sid}:${authToken}`).toString("base64");
  const httpClient = createHttpClient({
    baseURL: root,
    apiKey: `Basic ${basic}`,
    headers: {
      Accept: "application/json",
    },
  });

  async function fetchPaginated(endpoint, query = {}, { collectionKeys = [], stats = null } = {}) {
    const all = [];
    const pages = [];
    let page = Number(query.Page ?? query.page ?? 1);
    const pageSize = Number(query.PageSize ?? query.pageSize ?? query.limit ?? 100);

    for (;;) {
      await impactRateLimiter.acquireSlot();
      if (stats) stats.requestCount = (stats.requestCount || 0) + 1;

      const response = await requestWithRetry(
        () =>
          httpClient.get(endpoint, {
            params: {
              ...query,
              Page: page,
              PageSize: pageSize,
            },
          }),
        { retries: 3, delayMs: 800 },
      );

      const data = response?.data ?? {};
      const rows = extractCollection(data, collectionKeys);
      pages.push({ page, count: rows.length });
      all.push(...rows);

      if (!hasNextPage(data, page, pageSize, rows.length) || rows.length === 0) break;
      page += 1;
      // Safety: hard cap to avoid infinite loops on malformed pagination
      if (page > 500) break;
    }

    return { rows: all, pages };
  }

  const adapter = {
    supplierKey: "IMPACT",

    getCapabilities() {
      return {
        capabilities: [
          SUPPLIER_CAPABILITIES.CAMPAIGNS,
          SUPPLIER_CAPABILITIES.CONVERSIONS,
          SUPPLIER_CAPABILITIES.ADS,
          SUPPLIER_CAPABILITIES.DEEP_LINK,
          SUPPLIER_CAPABILITIES.ORDER_ITEMS,
          SUPPLIER_CAPABILITIES.VALIDATION_STATUS,
          SUPPLIER_CAPABILITIES.TRACKING_SUBID,
          SUPPLIER_CAPABILITIES.PRODUCTS,
          SUPPLIER_CAPABILITIES.PAYMENTS,
          SUPPLIER_CAPABILITIES.REPORTING,
        ],
        pagination: "page",
        fetchProducts: true,
        notes: [
          "Publisher/MediaPartner path only.",
          "Product catalog fetch is foundation only — full Product Feed = Wave F.",
          "Payment/payout endpoints remain best-effort; unresolved fields stay raw.",
          "Performance Facts derived from Actions (orders/commission). Dedicated click/impression reports via /Reports are best-effort.",
          "COUPONS capability NOT_APPLICABLE — Impact Promotions are deal/promo content, not voucher codes for CouponCodeMaster.",
        ],
      };
    },

    async authenticate() {
      try {
        await impactRateLimiter.acquireSlot();
        await requestWithRetry(() => httpClient.get("/Campaigns", { params: { PageSize: 1, Page: 1 } }), {
          retries: 1,
        });
        return { ok: true };
      } catch (error) {
        const status = error?.response?.status;
        return {
          ok: false,
          detail: status === 401 || status === 403 ? "auth_failed" : error?.message || "health_failed",
        };
      }
    },

    async healthCheck() {
      return this.authenticate();
    },

    async fetchCampaigns(params = {}, stats = null) {
      const { rows } = await fetchPaginated(
        "/Campaigns",
        params,
        { collectionKeys: ["Campaigns", "campaigns"], stats },
      );
      return asArray(rows);
    },

    async fetchAds(params = {}, stats = null) {
      const { rows } = await fetchPaginated(
        "/Ads",
        params,
        { collectionKeys: ["Ads", "ads"], stats },
      );
      return asArray(rows);
    },

    async fetchConversions(params = {}, stats = null) {
      // Actions = conversions/orders in Impact Publisher API.
      const { rows } = await fetchPaginated(
        "/Actions",
        params,
        { collectionKeys: ["Actions", "actions"], stats },
      );
      return asArray(rows);
    },

    async fetchPayments(params = {}, stats = null) {
      // Payouts — endpoint may vary by account; treat failures as empty + leave raw unresolved.
      try {
        const { rows } = await fetchPaginated(
          "/Payouts",
          params,
          { collectionKeys: ["Payouts", "payouts"], stats },
        );
        return asArray(rows);
      } catch (error) {
        if (stats) stats.paymentFetchSkipped = error?.response?.status || error?.message;
        return [];
      }
    },

    async fetchProducts(params = {}, stats = null) {
      // Catalogs foundation only — Wave F owns Product Feed domain.
      try {
        const { rows } = await fetchPaginated(
          "/Catalogs",
          params,
          { collectionKeys: ["Catalogs", "catalogs"], stats },
        );
        return asArray(rows);
      } catch (error) {
        if (stats) stats.productFetchSkipped = error?.response?.status || error?.message;
        return [];
      }
    },

    /**
     * Impact Promotions = deal/promo text (v15 13I), not voucher CouponCodeMaster codes.
     * Intentionally returns [] — do not manufacture coupon codes.
     */
    async fetchCoupons(_params = {}, stats = null) {
      if (stats) stats.couponCapability = "NOT_APPLICABLE_IMPACT_PROMOTIONS_ARE_DEAL_CONTENT";
      return [];
    },

    /**
     * Best-effort report catalog. Row download is account-specific; empty on failure.
     */
    async fetchReports(params = {}, stats = null) {
      try {
        const { rows } = await fetchPaginated(
          "/Reports",
          params,
          { collectionKeys: ["Reports", "reports"], stats },
        );
        return asArray(rows);
      } catch (error) {
        if (stats) stats.reportFetchSkipped = error?.response?.status || error?.message;
        return [];
      }
    },

    /**
     * Performance rows for NetworkPerformanceFact.
     * Primary SoT: Actions (conversions). Clicks/impressions stay null unless Action payload has them.
     * Never invent MBO link clicks.
     */
    async fetchPerformance(params = {}, stats = null) {
      const actions = Array.isArray(params.prefetchedConversions)
        ? params.prefetchedConversions
        : await this.fetchConversions(params.conversions || params, stats);
      return actions.map((row) => {
        const status = String(row.State || row.Status || row.state || row.status || "").toLowerCase();
        return {
          ...row,
          date:
            row.EventDate ||
            row.CreationDate ||
            row.LockingDate ||
            row.eventDate ||
            row.creationDate ||
            row.date ||
            null,
          campaign_id: row.CampaignId ?? row.campaignId ?? row.ProgramId ?? null,
          campaign_name: row.CampaignName ?? row.campaignName ?? row.ProgramName ?? null,
          advertiser_name: row.AdvertiserName ?? row.advertiserName ?? row.AdvertiserId ?? null,
          clicks: row.Clicks ?? row.clicks ?? null,
          impressions: row.Impressions ?? row.impressions ?? null,
          orders: 1,
          totalConversions: 1,
          validatedConversions:
            status.includes("approved") || status.includes("locked") || status === "confirmed"
              ? 1
              : null,
          pendingConversions: status.includes("pending") || status.includes("open") ? 1 : null,
          rejectedConversions:
            status.includes("revers") || status.includes("reject") || status.includes("declin")
              ? 1
              : null,
          commission: row.Payout ?? row.ActionEarnings ?? row.Commission ?? row.payout ?? null,
          originalOrderValue: row.Amount ?? row.SaleAmount ?? row.amount ?? null,
          currency: row.Currency ?? row.currency ?? null,
          country: row.Country ?? row.CustomerCountry ?? row.country ?? null,
          coupon_code: row.PromoCode ?? row.CouponCode ?? row.promoCode ?? null,
          click_id: row.ClickId ?? row.Oid ?? row.clickId ?? null,
          report_type: "impact_action_derived",
        };
      });
    },

    async fetchAll(params = {}, options = {}) {
      const stats = { requestCount: 0 };
      const campaigns = options.skipCampaigns ? [] : await this.fetchCampaigns(params.campaigns || {}, stats);
      const conversions = options.skipConversions
        ? []
        : await this.fetchConversions(params.conversions || {}, stats);
      const ads = options.skipAds ? [] : await this.fetchAds(params.ads || {}, stats);
      const payments = options.skipPayments ? [] : await this.fetchPayments(params.payments || {}, stats);
      const performance = options.skipPerformance
        ? []
        : await this.fetchPerformance({ conversions: params.conversions || {} }, stats);
      return { campaigns, conversions, ads, payments, performance, stats };
    },
  };

  return adapter;
}
