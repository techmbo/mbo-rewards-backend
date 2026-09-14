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

export const AWIN_CERTIFICATION_TIMEOUT_MS = Number(
  process.env.AWIN_CERTIFICATION_TIMEOUT_MS || 15000,
);

/** Certification holds ONE row. The cap is on rows kept in memory, never on rows requested. */
export const AWIN_CERTIFICATION_MAX_ROWS = 1;

/**
 * Awin refuses a transaction window wider than 31 days, and fetchConversions already enforces that
 * before making a request. Certification enforces the same ceiling for the same reason: a 90d
 * preset would otherwise become a request the supplier rejects, reported as a supplier failure
 * when in fact the window was never valid.
 */
export const AWIN_MAX_TRANSACTION_WINDOW_DAYS = 31;

/**
 * The transaction date format Awin actually accepts: YYYY-MM-DDTHH:mm:ss.
 *
 * Established live, not guessed. Sent as bare dates the endpoint answered 400 "Wrong data type for
 * parameter 'endDate'"; with endDate alone as a datetime it answered 400 naming 'startDate'; with
 * both as datetimes it answered 200. Three requests, each moving one thing.
 *
 * ONE function, used by production fetchConversions and by the certification spec, so the two
 * cannot serialise a date differently — the drift that made this take three probes to find.
 *
 * A value that is already a datetime passes through untouched: appending twice would produce
 * exactly the malformed parameter this fixes. Midnight, because that is the instant the date-only
 * value denoted; the window is unchanged in width or position.
 */
export function awinTransactionDateParam(value) {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text;
}

/** Raised when a preset resolves to a window this endpoint cannot accept. Not a supplier error. */
export class AwinWindowTooWideError extends Error {
  constructor(days, maxDays) {
    super("The requested window is wider than this Awin endpoint accepts.");
    this.name = "AwinWindowTooWideError";
    this.awinWindowTooWide = true;
    this.requestedDays = Number.isFinite(days) ? Math.round(days) : null;
    this.maxWindowDays = maxDays;
  }
}

/**
 * The certification request contract, one entry per source object.
 *
 * Every entry's shape is evidenced by production code that already runs. `campaigns` is
 * fetchCampaigns: the same path, and the same single `relationship` parameter with the same
 * default. Nothing is added — no limit, page, offset or cursor is evidenced on this endpoint, and
 * inventing one is the mistake that got an earlier Optimise probe rejected.
 *
 * `path` receives the adapter's RESOLVED values, never a caller's ctx, so the one place an
 * identifier enters a URL is visibly fed from configuration alone.
 */
/**
 * The transactions request, exactly as fetchConversions builds it. Hoisted so the endDate
 * isolation variant can DERIVE from it instead of restating it.
 */
const AWIN_CONVERSIONS_SPEC = Object.freeze({
  method: "GET",
  collectionKeys: ["transactions", "data"],
  needs: ["window"],
  maxWindowDays: AWIN_MAX_TRANSACTION_WINDOW_DAYS,
  path: (resolved) => `/publishers/${resolved.publisherId}/transactions/`,
  params: (resolved) => ({
    startDate: awinTransactionDateParam(resolved.window.from),
    endDate: awinTransactionDateParam(resolved.window.to),
    dateType: "transaction",
    showBasketProducts: true,
  }),
});

const AWIN_CERTIFICATION_SAMPLES = Object.freeze({
  campaigns: {
    method: "GET",
    collectionKeys: ["programmes", "data"],
    path: (resolved) => `/publishers/${resolved.publisherId}/programmes`,
    params: () => ({ relationship: "joined" }),
  },

  // Evidenced: fetchCoupons POSTs to exactly this path with a { filters, pagination } body and
  // reads the same three collection keys. The path is `/publisher/` singular — Awin's promotions
  // endpoint differs from the plural `/publishers/` used everywhere else, and it is copied, not
  // corrected.
  //
  // A POST that READS. It creates nothing: the body carries empty filters and asks for one row, so
  // repeating it changes no supplier state. The verb belongs to the endpoint, not to the intent.
  //
  // pagination IS part of this endpoint's evidenced contract — unlike programmes, where no page
  // parameter exists and sending one would be inventing.
  //
  // pageSize is 200, production's exact value, and that is the whole point: an earlier probe sent
  // pageSize 1 — smaller, and seemingly safer — and the supplier answered HTTP 500. Asking for
  // LESS than production is still asking for something production never asks for, so the body is
  // now byte-identical to what fetchCoupons sends and the pageSize variable is eliminated. If 200
  // also fails, the failure belongs to the endpoint or the account, not to the probe.
  //
  // 200 is what is REQUESTED; it is not what is kept. One row is sliced out of the response for
  // the field dictionary, and the rest of the page is discarded unread. One request, one page, no
  // loop; `page` is fixed at 1 and nothing increments it.
  coupons: {
    // POST_READONLY, the marker the certification service already uses for a POST that reads: its
    // READ_ONLY_METHODS guard admits GET and POST_READONLY and fails everything else closed. A
    // plain "POST" is refused there, and rightly — the guard is not weakened to admit this probe.
    method: "POST_READONLY",
    collectionKeys: ["data", "promotions", "offers"],
    path: (resolved) => `/publisher/${resolved.publisherId}/promotions`,
    body: () => ({ filters: {}, pagination: { page: 1, pageSize: 200 } }),
  },

  // Evidenced: fetchConversions builds exactly this path and sends exactly these parameter names.
  // The trailing slash is production's and is kept.
  //
  // showBasketProducts stays TRUE because the embedded basket structure is the point: it is how
  // ORDER ITEMS arrive on this integration — inside a transaction, not from a product feed. The
  // two must never be read as evidence of each other, and certification is where that distinction
  // gets recorded.
  //
  // dateType "transaction" is production's own default. status and timezone are OPTIONAL in
  // production and omitted here: certification sends the unfiltered default view, so no caller and
  // no default can narrow which transactions the supplier considers.
  //
  // Dates arrive as `resolved.window`, computed by the service from a frozen preset token. No date
  // is ever accepted from a caller. The 31-day ceiling below is production's own rule, enforced
  // here too rather than left to the supplier to reject.
  conversions: AWIN_CONVERSIONS_SPEC,

});

export function listAwinCertificationSamples() {
  return Object.keys(AWIN_CERTIFICATION_SAMPLES);
}

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
  // Same seam the Partnerize adapter exposes. Default unchanged, so no production call site is
  // affected; it exists so the certification probe can be exercised as itself rather than as a
  // reimplementation of itself in a test.
  httpClient: injectedHttpClient = null,
} = {}) {
  if (!accessToken) throw new Error("Awin adapter requires accessToken");
  if (publisherId == null || String(publisherId).trim() === "") {
    throw new Error("Awin adapter requires publisherId (explicit NetworkAccount mapping)");
  }

  const pubId = encodeURIComponent(String(publisherId));
  const root = String(baseURL).replace(/\/$/, "");
  const httpClient =
    injectedHttpClient ??
    createHttpClient({
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
          // PRODUCTS is deliberately absent. Declaring it required fetchProducts(), which this
          // adapter does not have and never had — so assertAdapterContract threw during
          // construction and createSupplierAdapter("AWIN", …) failed outright, taking Awin sync
          // with it. Awin's product feed is not implemented here: no product, feed, catalog or
          // datafeed path is built anywhere in this adapter.
          //
          // ORDER_ITEMS below is a different claim and stays: showBasketProducts on the
          // transactions request returns basket lines INSIDE a conversion. Basket items are not a
          // product feed, and one must never be read as evidence of the other.
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
          "Product feeds are NOT implemented: no feed endpoint or fetcher exists in this adapter.",
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
          // Serialised by the SAME function certification uses. Awin rejects bare dates on this
          // endpoint with "Wrong data type"; this is the format it accepts, proven live.
          startDate: awinTransactionDateParam(startDate),
          endDate: awinTransactionDateParam(endDate),
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

    /**
     * Exactly one bounded certification request. Never a sync fetcher.
     *
     * What is deliberately skipped is the get() helper, not the pacing. get() applies
     * requestWithRetry with three retries, and a probe that retries turns one supplier rejection
     * into three against a 20-calls-per-minute account — so the request goes to httpClient
     * directly, which is what keeps the retry count at zero. The shared rate limiter is still
     * acquired, so certification cannot jump the queue ahead of a running sync.
     *
     * `pubId` is the adapter's own, fixed at construction from configuration. There is no code
     * path by which a caller reaches the path or the query.
     */
    async fetchCertificationSample(sourceObject, ctx = {}) {
      const spec = AWIN_CERTIFICATION_SAMPLES[sourceObject];
      if (!spec) {
        throw new Error(`No Awin certification sample is defined for "${sourceObject}"`);
      }

      for (const need of spec.needs ?? []) {
        if (!ctx[need]) throw new Error(`Awin certification sample "${sourceObject}" requires ${need}`);
      }

      // Checked BEFORE the limiter and before any request: an impossible window costs no supplier
      // call and is reported as its own outcome, never as a supplier failure.
      if (spec.maxWindowDays && ctx.window) {
        const days =
          (new Date(ctx.window.to).getTime() - new Date(ctx.window.from).getTime()) / 86400000;
        if (days > spec.maxWindowDays + 0.0001) {
          throw new AwinWindowTooWideError(days, spec.maxWindowDays);
        }
      }

      await awinRateLimiter.acquireSlot();
      const url = spec.path({ publisherId: pubId, window: ctx.window });
      const timeout = Number(ctx.timeoutMs || AWIN_CERTIFICATION_TIMEOUT_MS);

      // The verb is the spec's, never a caller's, and each branch sends only what its own spec
      // builds: a GET sends query parameters and no body, a POST sends a body and no parameters.
      const response =
        spec.method === "POST_READONLY"
          ? await httpClient.post(url, spec.body(), { timeout })
          : await httpClient.get(url, { params: spec.params({ publisherId: pubId, window: ctx.window }), timeout });

      // The same collection reader production uses, so the probe cannot certify a different shape
      // than sync ingests. One row is kept; the rest of the page is discarded unread.
      return extractCollection(response?.data, spec.collectionKeys).slice(
        0,
        AWIN_CERTIFICATION_MAX_ROWS,
      );
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
