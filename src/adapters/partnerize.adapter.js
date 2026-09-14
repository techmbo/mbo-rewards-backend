import { createHttpClient, requestWithRetry } from "../core/httpClient.js";
import { createRateLimiter } from "../core/rateLimiter.js";
import { asArray } from "../core/normalize.js";
import { SUPPLIER_CAPABILITIES } from "./contract.js";

/**
 * Partnerize publisher adapter — Wave E.
 *
 * Auth: HTTP Basic application_key:user_api_key (Partnerize docs).
 * Base: https://api.partnerize.com (configurable; legacy host performancehorizon.com).
 *
 * Tracking: v15 12F confirms adref/pubref/clickref → client/assignment/click (see trackingParamRules).
 * Production conversion echo sample remains optional proof (PARTNERIZE_PRODUCTION_ECHO_UNVERIFIED).
 */

const PARTNERIZE_MIN_INTERVAL_MS = Number(process.env.PARTNERIZE_MIN_INTERVAL_MS || 750);
const partnerizeRateLimiter = createRateLimiter(PARTNERIZE_MIN_INTERVAL_MS);

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.advertisers)) return data.advertisers;
  if (Array.isArray(data?.campaigns)) {
    return data.campaigns.map((row) => row?.campaign ?? row);
  }
  if (Array.isArray(data?.conversions)) {
    return data.conversions.map((row) => row?.conversion ?? row);
  }
  if (Array.isArray(data?.payments)) {
    return data.payments.map((row) => row?.payment ?? row);
  }
  if (Array.isArray(data?.publishers)) {
    return data.publishers.map((row) => row?.publisher ?? row);
  }
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

/**
 * Whether the envelope carried a collection extractRows recognises — even an EMPTY one.
 *
 * The distinction matters for certification. extractRows returns [] both when it recognised a
 * collection that happens to be empty and when it recognised nothing at all, and sampleOnce
 * accommodates a non-list endpoint (/user) by reporting the whole object as its single row. Without
 * this check, `{ "conversions": [] }` — a real supplier answer meaning "no rows in this window" —
 * would be reported as ONE row whose fields are the envelope's, certifying a schema that does not
 * exist. An empty recognised collection is zero rows.
 */
export function hasRecognisedCollection(data) {
  if (Array.isArray(data)) return true;
  if (!data || typeof data !== "object") return false;
  return ["data", "advertisers", "campaigns", "conversions", "payments", "publishers", "results"]
    .some((key) => Array.isArray(data[key]));
}

export function partnerizeCampaignListPaths(publisherId, statuses = ["a", "p"]) {
  const id = encodeURIComponent(String(publisherId));
  return statuses.map((status) => `/user/publisher/${id}/campaign/${status}`);
}

export function extractPartnerizePublisherIds(payload) {
  return extractRows(payload)
    .map((row) => row?.publisher_id || row?.partner_id || row?.id)
    .filter(Boolean)
    .map(String);
}

export function extractPartnerizeCampaignIdsFromTerms(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : extractRows(payload);
  return [...new Set(rows.map((row) => row?.campaign_id || row?.campaignId).filter(Boolean).map(String))];
}

/** Discovery API rows: advertisers[] with nested campaigns[]. */
export function extractPartnerizeDiscoveryAdvertisers(payload) {
  if (Array.isArray(payload?.advertisers)) return payload.advertisers;
  if (Array.isArray(payload?.data)) return payload.data;
  return extractRows(payload);
}

/**
 * Index discovery advertisers by campaign id for merge into publisher list rows.
 * @returns {Map<string, { advertiser?: object, campaign?: object }>}
 */
export function buildPartnerizeDiscoveryCampaignIndex(advertisers = []) {
  const index = new Map();
  for (const block of advertisers) {
    const advertiser = block?.advertiser ?? block;
    const campaigns = asArray(block?.campaigns ?? advertiser?.campaigns);
    for (const campaign of campaigns) {
      const campaignId = campaign?.id ?? campaign?.campaign_id ?? campaign?.campaignId;
      if (!campaignId) continue;
      index.set(String(campaignId), { advertiser, campaign });
    }
  }
  return index;
}

/** Merge discovery advertiser/campaign metadata into thin publisher-list rows. */
export function enrichPartnerizeCampaignsWithDiscovery(campaigns = [], discoveryIndex = new Map()) {
  if (!discoveryIndex?.size) return campaigns;
  return campaigns.map((row) => {
    const campaignId = String(row?.campaign_id ?? row?.campaignId ?? row?.id ?? "");
    if (!campaignId) return row;
    const hit = discoveryIndex.get(campaignId);
    if (!hit) return row;

    const { advertiser, campaign } = hit;
    const mergedAdvertiser = {
      ...(row.advertiser && typeof row.advertiser === "object" ? row.advertiser : {}),
      ...(advertiser && typeof advertiser === "object" ? advertiser : {}),
    };
    const icon =
      campaign?.campaign_icon ??
      campaign?.campaign_logo ??
      row.campaign_icon ??
      row.campaign_logo ??
      null;
    const advertiserIcon = advertiser?.advertiser_icon ?? row.advertiser_icon ?? null;

    // Path /campaign/{a|p|r} encodes relationship. Preserve it separately from discovery lifecycle.
    const participationCode = row.publisher_status ?? row.participation_code ?? row.status;
    const nestedCampaignStatus = campaign?.status ?? campaign?.campaign_status ?? null;
    const nestedIsParticipation =
      nestedCampaignStatus != null &&
      ["a", "p", "r"].includes(String(nestedCampaignStatus).trim().toLowerCase());
    const lifecycleStatus =
      nestedCampaignStatus && !nestedIsParticipation
        ? nestedCampaignStatus
        : row.campaign_lifecycle_status ?? null;

    return {
      ...row,
      // Keep publisher join code from list path (Master: status path param a/p/r)
      publisher_status: participationCode,
      participation_code: participationCode,
      status: participationCode,
      ...(lifecycleStatus ? { campaign_lifecycle_status: lifecycleStatus } : {}),
      ...(campaign && typeof campaign === "object" ? { campaign: { ...campaign } } : {}),
      ...(campaign?.title && !row.title ? { title: campaign.title } : {}),
      ...(campaign?.default_destination && !row.destination_url
        ? { destination_url: campaign.default_destination }
        : {}),
      ...(campaign?.vertical?.name && !row.vertical_name ? { vertical_name: campaign.vertical.name } : {}),
      ...(campaign?.vertical && !row.vertical ? { vertical: campaign.vertical } : {}),
      ...(campaign?.currency?.iso && !row.default_currency ? { default_currency: campaign.currency.iso } : {}),
      ...(campaign?.tracking_link && !row.tracking_link ? { tracking_link: campaign.tracking_link } : {}),
      ...(campaign?.tracking_url && !row.tracking_url ? { tracking_url: campaign.tracking_url } : {}),
      ...(campaign?.start_date && !row.start_date ? { start_date: campaign.start_date } : {}),
      ...(campaign?.end_date && !row.end_date ? { end_date: campaign.end_date } : {}),
      ...(campaign?.live_date && !row.live_date ? { live_date: campaign.live_date } : {}),
      ...(icon ? { campaign_icon: icon, campaign_logo: icon } : {}),
      ...(advertiserIcon ? { advertiser_icon: advertiserIcon } : {}),
      advertiser: Object.keys(mergedAdvertiser).length ? mergedAdvertiser : row.advertiser,
    };
  });
}

function hasMore(data, offset, limit, rowsCount) {
  // Explicit false signals — always trust them to stop pagination.
  if (data?.has_more === false || data?.hasMore === false) return false;
  // Explicit total count — paginate until exhausted.
  if (data?.count != null) return offset + rowsCount < Number(data.count);
  // Explicit true signals
  if (data?.has_more === true || data?.hasMore === true) return true;
  // Heuristic: a full page may mean more data, but only when we actually received rows.
  return rowsCount > 0 && rowsCount >= limit;
}

/**
 * Certification sampling — deliberately separate from every fetcher below.
 *
 * The sync fetchers are built to be exhaustive: fetchPaginated loops until a short page, get()
 * retries three times, and fetchCampaigns walks three participation statuses, then a discovery
 * endpoint, then falls back through a second API generation hydrating one campaign per request.
 * All of that is right for a nightly sync and ruinous for a probe.
 *
 * Certification therefore reuses none of it. One HTTP request, no retry, no pagination, no
 * fan-out, no fallback to another API generation, and a hard timeout. The endpoint comes from the
 * frozen table below, keyed by source-object name, so no caller can supply a path, a query, a
 * publisher id or a campaign id.
 *
 * Every entry's request contract is evidenced by code that already runs in production; nothing
 * here was inferred from another endpoint's behaviour.
 */
export const PARTNERIZE_CERTIFICATION_TIMEOUT_MS = Number(
  process.env.CERTIFICATION_SAMPLE_TIMEOUT_MS || 10000,
);

/**
 * Certification paces itself on its own throttle.
 *
 * A single probe cannot burst, but a single RUN can: one request may ask for authenticate,
 * publishers and campaigns, and the service dispatches them one after another with nothing
 * between. Three back-to-back calls is exactly the traffic shape an affiliate API notices.
 *
 * Separate from the sync limiter so a probe never queues behind a sync in flight, and matched to
 * the same 750 ms interval because that is the pace this integration already treats as polite.
 */
export const PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS = Number(
  process.env.PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS || 750,
);
const partnerizeCertificationLimiter = createRateLimiter(PARTNERIZE_CERTIFICATION_MIN_INTERVAL_MS);

/** Raised when admission cannot be granted inside the probe's budget. Carries no supplier detail. */
export class PartnerizeCertificationThrottledError extends Error {
  constructor(message = "Partnerize certification sample could not be scheduled within budget") {
    super(message);
    this.name = "PartnerizeCertificationThrottledError";
    // Reuses the existing sanitized mapping to SUPPLIER_RATE_LIMITED.
    this.certificationThrottled = true;
  }
}

/**
 * Rejects with `error` if `promise` has not settled within `ms`.
 *
 * The loser is abandoned rather than cancelled; an abandoned admission belongs to the
 * certification limiter alone, and its rejection is swallowed so a late settle cannot surface as
 * an unhandled rejection after the probe has reported.
 */
function withDeadline(promise, ms, error) {
  let timer;
  Promise.resolve(promise).catch(() => {});
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(error), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const PARTNERIZE_SINGLE_ROW = { limit: 1, offset: 0 };

/**
 * How many campaign rows ONE certification request asks for.
 *
 * Certification only. Production sync paginates through fetchPaginated, which derives its own
 * limit from the caller's query and defaults to 100 — it never reads this constant, so widening
 * the sample here cannot change ingestion.
 *
 * Ten, and offset 0, and no loop: still exactly one request against one participation status. The
 * widening exists because a one-row sample of a campaign list cannot answer whether ANY campaign
 * states commission outcomes — the single row it returned had `commissions: []`, which says
 * nothing about the other campaigns on the account.
 */
export const PARTNERIZE_CERTIFICATION_CAMPAIGN_SAMPLE_LIMIT = 10;
const PARTNERIZE_CAMPAIGN_SAMPLE_PAGE = Object.freeze({
  limit: PARTNERIZE_CERTIFICATION_CAMPAIGN_SAMPLE_LIMIT,
  offset: 0,
});

/**
 * Hard ceiling on rows kept from ONE response for an in-memory scan.
 *
 * Not a page size and not a request count: the supplier query is unchanged and still asks for
 * limit 1. This only caps how many rows of a response the certification code will walk, so a
 * supplier that one day returns a large page cannot turn a scan into unbounded work.
 */
export const CERTIFICATION_MAX_SCAN_ROWS = 10;

const PARTNERIZE_CERTIFICATION_SAMPLES = Object.freeze({
  // Evidenced: authenticate() calls get("/user", {}) with no parameters at all.
  authenticate: { method: "GET", path: () => "/user", params: () => ({}) },

  // Evidenced: resolvePublisherId() calls get("/user/publisher", { limit: 100, offset: 0 }) —
  // a direct request to THIS endpoint with these exact parameter names. Only the value changes.
  publishers: { method: "GET", path: () => "/user/publisher", params: () => ({ ...PARTNERIZE_SINGLE_ROW }) },

  // Evidenced: fetchPaginated sends { limit, offset } to exactly this path shape. One
  // participation status only — walking a/p/r is fan-out, which certification does not do.
  // The publisher id comes from the adapter's own credentials, never from a caller.
  campaigns: {
    method: "GET",
    needs: "publisherId",
    // The argument is the adapter's RESOLVED values, never a caller's ctx. Named accordingly so
    // the distinction is visible at the one place an identifier enters a URL path.
    path: (resolved) => `/user/publisher/${encodeURIComponent(resolved.publisherId)}/campaign/a`,
    // Ten rows, offset 0. One request, one participation status, no loop — only the page width
    // changes, and only for certification. Neither value can come from a caller.
    params: () => ({ ...PARTNERIZE_CAMPAIGN_SAMPLE_PAGE }),
  },

  // Evidenced: fetchCoupons builds exactly this path and calls get(path, {}, stats) — with NO
  // query parameters at all. So none are sent here either. There is no evidenced limit, offset,
  // page or cursor on this endpoint, and inventing one is the mistake that cost Optimise a
  // rejected conversions probe; the bound comes from the response being one campaign's voucher
  // list, and from taking a single row out of it for the field dictionary.
  //
  // Both identifiers come from the adapter's own configuration. Neither is discovered with a
  // request — that would be a second call — and neither can be supplied by a caller.
  // Evidenced: fetchConversions builds exactly this path and sends start_date/end_date. It is the
  // PUBLISHER-SCOPED reporting endpoint, and it is the only conversions path certification uses.
  //
  // The adapter also has a non-publisher-scoped fallback, /v3/partner/conversions, reached through
  // fetchPaginated — a PAGINATION LOOP. Certification never touches it: one request means one
  // request, and a fallback after a failure would make two.
  //
  // Parameters are exactly the two dates and nothing else. Production's fetchConversions spreads
  // the caller's `...params` into the query; certification deliberately does not, so no caller can
  // add a filter, a page or an identifier. Both dates are computed by the service from a frozen
  // window preset and arrive as `resolved.window` — never as a caller-supplied date.
  conversions: {
    method: "GET",
    needs: ["publisherId", "window"],
    path: (resolved) =>
      `/reporting/report_publisher/publisher/${encodeURIComponent(resolved.publisherId)}/conversion.json`,
    params: (resolved) => ({ start_date: resolved.window.from, end_date: resolved.window.to }),
  },

  // Evidenced: fetchPayments builds exactly this path, and waveESupplierSync calls it with
  // { start_date, end_date } — the same two parameter names conversions uses, on the same
  // reporting host. Neither the path nor the parameter names are invented here.
  //
  // Unlike conversions there is no second path and no fetchPaginated anywhere in fetchPayments:
  // one request is the endpoint's own shape, not a bound certification imposes.
  //
  // Production passes its params object straight through to get(). Certification sends exactly the
  // two dates, so no caller can add a filter, a page or an account identifier.
  payments: {
    method: "GET",
    needs: ["publisherId", "window"],
    path: (resolved) =>
      `/reporting/report_publisher/publisher/${encodeURIComponent(resolved.publisherId)}/payment.json`,
    params: (resolved) => ({ start_date: resolved.window.from, end_date: resolved.window.to }),
  },

  vouchers: {
    method: "GET",
    needs: ["publisherId", "campaignId"],
    path: (resolved) =>
      `/user/publisher/${encodeURIComponent(resolved.publisherId)}` +
      `/campaign/${encodeURIComponent(resolved.campaignId)}/voucher`,
    params: () => ({}),

    // The voucher response is an ENVELOPE: { commission_fields, count, execution_time,
    // voucher_codes }. The rows are inside voucher_codes[]; the envelope is not a row.
    //
    // The generic extractRows does not know this key, so the envelope fell through to sampleOnce's
    // non-list branch and was certified AS a row — a dictionary of commission_fields / count /
    // execution_time, with the real voucher fields buried one array deep. Teaching extractRows the
    // key is not the fix: it has nine callers, including the fetchPaginated loop that drives
    // hasMore/offset for every other Partnerize endpoint, so a new key there would change
    // production pagination. The knowledge belongs to this one spec instead.
    //
    // Unwrapping mirrors fetchCoupons exactly, which is the only evidence of the row shape: each
    // block is either the voucher itself or a { voucher_code: {...} } wrapper.
    rows: (data) => {
      if (!Array.isArray(data?.voucher_codes)) return null;
      return data.voucher_codes.map((block) =>
        block?.voucher_code && typeof block.voucher_code === "object" ? block.voucher_code : block,
      );
    },
  },
});

/**
 * Raised when the supplier answers a payment report request with a status that means the endpoint
 * is not there for this account — today, a 404.
 *
 * It exists so the outcome stops being indistinguishable from "this publisher had no payments".
 * Returning [] on a 404 is what made Partnerize payment ingestion look like a healthy empty
 * result for as long as the path has existed; the live probe returned NOT_FOUND, not zero rows.
 *
 * Carries a status code and a category only — never a URL, a publisher id, a credential or any
 * part of the supplier's response body.
 */
export class PartnerizePaymentsUnavailableError extends Error {
  constructor(supplierStatusCode) {
    super("Partnerize payment reporting is unavailable for this account.");
    this.name = "PartnerizePaymentsUnavailableError";
    // Consumed by sourceObjectSync as the persisted errorCode.
    this.code = "SUPPLIER_SOURCE_OBJECT_UNAVAILABLE";
    this.partnerizePaymentsUnavailable = true;
    this.supplierStatusCode = supplierStatusCode ?? null;
    this.reasonCategory = supplierStatusCode === 404 ? "NOT_FOUND" : "UNAVAILABLE";
  }
}

/** A safe, structured record of a skipped payment fetch. No URL, id, body or credential. */
export function partnerizePaymentSkipRecord(supplierStatusCode) {
  return Object.freeze({
    sourceObject: "payment_information",
    status: "unavailable",
    supplierStatusCode: typeof supplierStatusCode === "number" ? supplierStatusCode : null,
    reasonCategory: supplierStatusCode === 404 ? "NOT_FOUND" : "UNAVAILABLE",
    at: new Date().toISOString(),
  });
}

/** Raised when no usable publisher id is configured or discoverable. Carries no identifier. */
export class PartnerizeNoPublisherIdError extends Error {
  constructor() {
    super("No usable Partnerize publisher id is configured or discoverable");
    this.name = "PartnerizeNoPublisherIdError";
    this.partnerizeNoPublisherId = true;
  }
}

/** Raised when no campaign id is configured for the voucher probe. Carries no identifier. */
export class PartnerizeNoCampaignIdError extends Error {
  constructor() {
    super("No Partnerize certification campaign id is configured");
    this.name = "PartnerizeNoCampaignIdError";
    this.partnerizeNoCampaignId = true;
  }
}

/**
 * Whether an identifier may be interpolated into a URL path segment.
 *
 * Rejects path, query and whitespace syntax. Both identifiers this adapter puts into a path go
 * through it, so a configured value carrying `../` or `?` cannot reshape the request.
 */
export function isPathSafePartnerizeId(value) {
  const text = String(value ?? "").trim();
  return Boolean(text) && !/[\\/\s?#]/.test(text);
}

/**
 * The first publisher id a response yields that is safe to interpolate into a path.
 *
 * Selection reuses extractPartnerizePublisherIds, the extractor production sync already applies to
 * this endpoint, rather than inventing a second namespace rule for certification to disagree with.
 * The guard on top rejects anything carrying path, query or control syntax: these ids come from a
 * supplier response and are placed into a URL path segment.
 */
export function firstUsablePartnerizePublisherId(payload) {
  for (const candidate of extractPartnerizePublisherIds(payload)) {
    const text = String(candidate).trim();
    if (!text) continue;
    if (/[\\/\s?#]/.test(text)) continue;
    return text;
  }
  return null;
}

export function listPartnerizeCertificationSamples() {
  return Object.keys(PARTNERIZE_CERTIFICATION_SAMPLES);
}

/**
 * @param {object} opts
 * @param {string} opts.applicationKey
 * @param {string} opts.userApiKey
 * @param {string} [opts.publisherId]
 * @param {string} [opts.baseURL]
 */
export function createPartnerizeAdapter({
  applicationKey,
  userApiKey,
  publisherId = process.env.PARTNERIZE_PUBLISHER_ID || null,
  // Certification only. The voucher endpoint is campaign-scoped and there is no campaign id in the
  // ordinary credential set, so one is configured server-side rather than discovered or accepted
  // from a caller. Absent means the voucher probe is skipped, never that it picks a campaign.
  certificationCampaignId = process.env.PARTNERIZE_CERTIFICATION_CAMPAIGN_ID || null,
  baseURL = process.env.PARTNERIZE_BASE_URL || "https://api.partnerize.com",
  httpClient: injectedHttpClient = null,
  certificationRateLimiter: injectedCertificationLimiter = null,
} = {}) {
  if (!applicationKey || !userApiKey) {
    throw new Error("Partnerize adapter requires applicationKey and userApiKey");
  }

  const basic = Buffer.from(`${applicationKey}:${userApiKey}`).toString("base64");
  const httpClient =
    injectedHttpClient ??
    createHttpClient({
      baseURL: String(baseURL).replace(/\/$/, ""),
      apiKey: `Basic ${basic}`,
      headers: { Accept: "application/json" },
    });

  const certLimiter = injectedCertificationLimiter ?? partnerizeCertificationLimiter;

  async function get(path, params = {}, stats = null) {
    await partnerizeRateLimiter.acquireSlot();
    if (stats) stats.requestCount = (stats.requestCount || 0) + 1;
    const response = await requestWithRetry(() => httpClient.get(path, { params }), {
      retries: 3,
      delayMs: 900,
    });
    return response?.data ?? {};
  }

  async function fetchPaginated(path, query = {}, stats = null) {
    const all = [];
    const limit = Number(query.limit ?? query.page_size ?? 100);
    let offset = Number(query.offset ?? 0);
    let page = 1;

    for (;;) {
      const data = await get(path, { ...query, limit, offset }, stats);
      const rows = extractRows(data);
      all.push(...rows);
      if (!hasMore(data, offset, limit, rows.length) || rows.length === 0) break;
      offset += rows.length;
      page += 1;
      if (page > 500) break;
    }
    return all;
  }

  /**
   * Exactly one bounded certification request.
   *
   * `resolved` is always built by this adapter — from its own credentials, or from a supplier
   * response it read itself. It never originates with a caller.
   */
  async function sampleOnce(sourceObject, resolved, ctx = {}) {
    const spec = PARTNERIZE_CERTIFICATION_SAMPLES[sourceObject];
    if (!spec) throw new Error(`No Partnerize certification sample is defined for "${sourceObject}"`);
    const required = Array.isArray(spec.needs) ? spec.needs : spec.needs ? [spec.needs] : [];
    for (const name of required) {
      if (!resolved[name]) {
        throw new Error(`Partnerize certification sample "${sourceObject}" requires ${name}`);
      }
    }

    // The source budget covers admission AND the request. Waiting for a slot spends it, so the
    // request gets what is left rather than a fresh full timeout on top of the wait.
    const timeoutMs = Number(ctx.timeoutMs || PARTNERIZE_CERTIFICATION_TIMEOUT_MS);
    const admissionBudgetMs = Math.min(Number(ctx.throttleBudgetMs ?? timeoutMs), timeoutMs);
    const startedAt = Date.now();

    await withDeadline(
      certLimiter.acquireSlot(),
      admissionBudgetMs,
      new PartnerizeCertificationThrottledError(),
    );

    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw new PartnerizeCertificationThrottledError();

    const response = await httpClient.get(spec.path(resolved), {
      params: spec.params(resolved),
      timeout: remainingMs,
    });

    // One row unless a caller asks for a bounded scan. The bound is on ROWS HELD IN MEMORY from
    // the one response already received — never on requests, and never on what is asked of the
    // supplier: spec.params() is untouched, so the query still says limit 1.
    const maxRows = Math.max(1, Math.min(Number(ctx.maxRows) || 1, CERTIFICATION_MAX_SCAN_ROWS));

    // A spec that NAMES its own collection is answered from that collection and nothing else. No
    // envelope fallback is reachable from here: if the named collection is absent or empty, that
    // is ZERO rows, and the caller reports OK_NO_ROWS with the row schema still unknown. Reporting
    // the envelope instead would certify a schema the rows do not have.
    if (typeof spec.rows === "function") {
      const collected = spec.rows(response?.data);
      return Array.isArray(collected) ? collected.slice(0, maxRows) : [];
    }

    const rows = extractRows(response?.data);
    // A non-list endpoint (/user) returns an object; report it as the single row it is. An empty
    // but RECOGNISED collection is zero rows, not one envelope row — see hasRecognisedCollection.
    if (
      !rows.length &&
      response?.data &&
      typeof response.data === "object" &&
      !hasRecognisedCollection(response.data)
    ) {
      return [response.data];
    }
    return rows.slice(0, maxRows);
  }

  const adapter = {
    supplierKey: "PARTNERIZE",
    publisherId,

    /**
     * One bounded certification sample. Never a sync fetcher.
     *
     * What is skipped is the get() helper, not the pacing. get() applies requestWithRetry, and a
     * probe that retries turns one supplier rejection into three, so the request goes to
     * httpClient directly — which is what keeps the retry count at zero.
     *
     * Pacing is kept, on certification's own limiter at a 750 ms minimum interval. One probe
     * cannot burst, but one RUN can: a single request may ask for authenticate, publishers and
     * campaigns, and the service dispatches them one after another.
     *
     * Admission is bounded and charged against the source budget, so the request receives what is
     * left of it rather than a fresh timeout stacked on top of the wait. If the admission deadline
     * expires, NO supplier HTTP request is sent. The underlying createRateLimiter admission
     * promise is not cancellable and may settle later, which can delay a subsequent probe by up to
     * one interval — safe, and accepted.
     */
    async fetchCertificationSample(sourceObject, ctx = {}) {
      // The publisher id is the adapter's own, resolved at construction from credentials or env.
      // It is never taken from ctx, so a caller cannot point the probe at another publisher.
      // The window is computed by the certification service from a frozen preset (7d/30d/90d).
      // It is passed as an adapter-resolved value alongside the publisher id so a dated sample
      // declares it in `needs` and fails loudly rather than sending undefined dates.
      return sampleOnce(sourceObject, { publisherId, window: ctx.window }, ctx);
    },

    /**
     * The campaigns probe: one request when a publisher id is configured, two when it is not.
     *
     * Production sync resolves the id the same way — configured first, then a bounded discovery
     * call against /user/publisher — so certification mirrors sync rather than requiring a config
     * change that only certification would need. This is the ONLY Partnerize probe allowed a
     * second request, and it is a dependent chain, not a fallback: the second call happens because
     * the first produced an input, never because the first failed.
     *
     * The discovered id stays inside this method. It is never returned, never reported, never
     * written anywhere, and never accepted from a caller.
     */
    async fetchCertificationCampaignSample(ctx = {}) {
      // One deadline for the whole chain, so two calls cannot each take a full timeout.
      const totalMs = Number(ctx.timeoutMs || PARTNERIZE_CERTIFICATION_TIMEOUT_MS);
      const deadline = Date.now() + totalMs;
      const remaining = () => deadline - Date.now();

      let resolvedPublisherId = publisherId;

      if (!resolvedPublisherId) {
        // Request 1 of 2 — the already-certified bounded publishers sample.
        const rows = await sampleOnce("publishers", { publisherId: null }, { timeoutMs: remaining() });
        resolvedPublisherId = firstUsablePartnerizePublisherId(rows);
        if (!resolvedPublisherId) throw new PartnerizeNoPublisherIdError();
      }

      if (remaining() <= 0) throw new PartnerizeCertificationThrottledError();

      // Request 2 of 2 (or 1 of 1 on the configured fast path). Still ONE request; `maxRows` only
      // says how many rows of that one response are kept for the caller to scan.
      return sampleOnce(
        "campaigns",
        { publisherId: resolvedPublisherId },
        { timeoutMs: remaining(), maxRows: CERTIFICATION_MAX_SCAN_ROWS },
      );
    },

    /**
     * One bounded voucher sample. EXACTLY one supplier request, or none.
     *
     * Unlike the campaign probe this has no discovery step. Both identifiers must already be
     * configured server-side: discovering either would mean a second request, and the endpoint is
     * campaign-scoped so a "first campaign" fallback would be this probe choosing which merchant's
     * vouchers to read. An absent identifier is reported as its own outcome and nothing is sent.
     */
    async fetchCertificationVoucherSample(ctx = {}) {
      if (!publisherId || !isPathSafePartnerizeId(publisherId)) {
        throw new PartnerizeNoPublisherIdError();
      }
      if (!certificationCampaignId || !isPathSafePartnerizeId(certificationCampaignId)) {
        throw new PartnerizeNoCampaignIdError();
      }

      return sampleOnce(
        "vouchers",
        { publisherId: String(publisherId), campaignId: String(certificationCampaignId) },
        { timeoutMs: Number(ctx.timeoutMs || PARTNERIZE_CERTIFICATION_TIMEOUT_MS) },
      );
    },

    getCapabilities() {
      return {
        capabilities: [
          SUPPLIER_CAPABILITIES.CAMPAIGNS,
          SUPPLIER_CAPABILITIES.COUPONS,
          SUPPLIER_CAPABILITIES.CONVERSIONS,
          SUPPLIER_CAPABILITIES.PAYMENTS,
          SUPPLIER_CAPABILITIES.TRACKING_SUBID,
          SUPPLIER_CAPABILITIES.REPORTING,
        ],
        pagination: "page",
        notes: [
          "Publisher endpoints preferred; brand-only paths unused.",
          "v15 12F: adref/pubref/clickref CONFIRMED for tracking injection.",
          "Performance Facts derived from conversion reports (no dedicated clicks report in adapter).",
          "Coupons via /user/publisher/{id}/campaign/{campaign_id}/voucher.",
        ],
      };
    },

    async authenticate() {
      try {
        await get("/user", {}, null);
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

    async resolvePublisherId(params = {}, stats = null) {
      const explicit = params.publisherId || publisherId;
      if (explicit) return String(explicit);
      try {
        const payload = await get("/user/publisher", { limit: 100, offset: 0 }, stats);
        const ids = extractPartnerizePublisherIds(payload);
        if (ids.length) {
          if (stats) stats.publisherIdResolved = ids[0];
          return ids[0];
        }
      } catch (error) {
        if (stats) stats.publisherDiscoverFailed = error?.response?.status || error?.message;
      }
      return null;
    },

    async fetchCampaigns(params = {}, stats = null) {
      const pubId = await this.resolvePublisherId(params, stats);
      if (pubId) {
        const collected = [];
        const statuses = asArray(params.participationStatuses).length
          ? params.participationStatuses
          : ["a", "p", "r"];
        for (const path of partnerizeCampaignListPaths(pubId, statuses)) {
          try {
            collected.push(...asArray(await fetchPaginated(path, params, stats)));
          } catch (error) {
            if (stats) {
              stats.campaignPublisherFetchFailed = stats.campaignPublisherFetchFailed || [];
              stats.campaignPublisherFetchFailed.push({
                path,
                status: error?.response?.status || error?.message,
              });
            }
          }
        }
        if (collected.length) {
          try {
            const discoveryPath = `/v2/publishers/${encodeURIComponent(pubId)}/discovery/advertisers`;
            const discoveryPayload = await fetchPaginated(discoveryPath, params, stats);
            const discoveryIndex = buildPartnerizeDiscoveryCampaignIndex(
              extractPartnerizeDiscoveryAdvertisers(discoveryPayload),
            );
            if (stats) stats.campaignDiscoveryMatches = discoveryIndex.size;
            return enrichPartnerizeCampaignsWithDiscovery(collected, discoveryIndex);
          } catch (error) {
            if (stats) {
              stats.campaignDiscoveryFailed = error?.response?.status || error?.message;
            }
            return collected;
          }
        }
      }

      // Fallback: Partnerize has no publisher-agnostic campaign list. GET /campaign times out.
      // Hydrate campaigns referenced by terms the authenticated user can read.
      try {
        const terms = await get("/v3/partner/campaign-terms-and-conditions", {}, stats);
        const campaignIds = extractPartnerizeCampaignIdsFromTerms(terms);
        if (stats) stats.campaignFallbackIds = campaignIds.length;
        const hydrated = [];
        for (const campaignId of campaignIds) {
          try {
            const payload = await get(`/campaign/${encodeURIComponent(campaignId)}`, {}, stats);
            const campaign = payload?.campaign || payload;
            if (campaign?.campaign_id || campaign?.id) hydrated.push(campaign);
          } catch (error) {
            if (stats) {
              stats.campaignHydrateFailed = (stats.campaignHydrateFailed || 0) + 1;
            }
          }
        }
        if (!hydrated.length && stats) {
          stats.campaignFetchHint =
            "Partnerize campaign list requires Publisher ID (Partner settings in the Partnerize console). Keys authenticated, but no publisher account was linked.";
        }
        return hydrated;
      } catch (error) {
        if (stats) stats.campaignFetchFailed = error?.response?.status || error?.message;
        return [];
      }
    },

    async fetchConversions(params = {}, stats = null) {
      const pubId = await this.resolvePublisherId(params, stats);
      if (pubId) {
        try {
          const start = params.start_date || params.startDate;
          const end = params.end_date || params.endDate;
          const path = `/reporting/report_publisher/publisher/${encodeURIComponent(pubId)}/conversion.json`;
          const data = await get(
            path,
            {
              start_date: start,
              end_date: end,
              ...params,
            },
            stats,
          );
          return asArray(extractRows(data));
        } catch (error) {
          if (stats) stats.conversionLegacyFailed = error?.response?.status || error?.message;
        }
      }
      try {
        return asArray(await fetchPaginated("/v3/partner/conversions", params, stats));
      } catch (error) {
        if (stats) stats.conversionFetchFailed = error?.response?.status || error?.message;
        return [];
      }
    },

    async fetchPayments(params = {}, stats = null) {
      const pubId = await this.resolvePublisherId(params, stats);
      if (!pubId) return [];
      try {
        const path = `/reporting/report_publisher/publisher/${encodeURIComponent(pubId)}/payment.json`;
        const data = await get(path, params, stats);
        return asArray(extractRows(data));
      } catch (error) {
        // Still returns [] — this fetcher stays non-blocking, and a 404 is NOT retried
        // (requestWithRetry breaks on any status outside 429/5xx). What changes is that the skip
        // is now a structured record a caller can act on instead of a bare status code that
        // nothing read.
        const supplierStatusCode = Number(error?.response?.status) || null;
        if (stats) stats.paymentFetchSkipped = partnerizePaymentSkipRecord(supplierStatusCode);
        return [];
      }
    },

    /**
     * Voucher codes for a campaign — Partnerize coupon SoT.
     * GET /user/publisher/{publisher_id}/campaign/{campaign_id}/voucher
     */
    async fetchCoupons(params = {}, stats = null) {
      const pubId = await this.resolvePublisherId(params, stats);
      const campaignIds = asArray(params.campaignIds || params.campaign_ids || []);
      if (!pubId || !campaignIds.length) return [];

      const all = [];
      for (const campaignId of campaignIds) {
        if (!campaignId) continue;
        try {
          const path = `/user/publisher/${encodeURIComponent(pubId)}/campaign/${encodeURIComponent(campaignId)}/voucher`;
          const data = await get(path, {}, stats);
          const voucherBlocks = asArray(data?.voucher_codes || data?.vouchers || extractRows(data));
          for (const block of voucherBlocks) {
            const vc = block?.voucher_code && typeof block.voucher_code === "object" ? block.voucher_code : block;
            if (!vc || typeof vc !== "object") continue;
            const code = vc.voucher_code ?? vc.code ?? null;
            if (!code) continue;
            all.push({
              ...vc,
              id: vc.voucher_code_id ?? vc.id ?? `${campaignId}:${code}`,
              voucher_code: String(code),
              voucher_code_id: vc.voucher_code_id ?? vc.id ?? null,
              campaign_id: String(vc.campaign_id ?? campaignId),
              description: vc.description ?? null,
              start_date_time: vc.start_date_time ?? vc.start_date ?? null,
              end_date_time: vc.end_date_time ?? vc.end_date ?? null,
              active: vc.active,
              status: String(vc.active).toLowerCase() === "y" || vc.active === true ? "ACTIVE" : "UNKNOWN",
            });
          }
        } catch (error) {
          if (stats) {
            stats.voucherFetchErrors = stats.voucherFetchErrors || [];
            stats.voucherFetchErrors.push({
              campaignId,
              status: error?.response?.status || error?.message,
            });
          }
        }
      }
      return all;
    },

    /**
     * Performance rows for NetworkPerformanceFact — Partnerize has no standalone clicks report
     * in this adapter. Derive daily grain from conversion rows (orders/commission).
     * networkClicks stay null unless conversion payload explicitly includes clicks.
     */
    async fetchPerformance(params = {}, stats = null) {
      const conversions = Array.isArray(params.prefetchedConversions)
        ? params.prefetchedConversions
        : await this.fetchConversions(params.conversions || params, stats);
      return conversions.map((row) => ({
        ...row,
        date:
          row.conversion_time ||
          row.conversion_date ||
          row.conversionDate ||
          row.date ||
          row.created ||
          null,
        campaign_id: row.campaign_id ?? row.campaignId ?? row.campaign?.id ?? null,
        campaign_name: row.campaign_title ?? row.campaign_name ?? row.campaign?.title ?? null,
        advertiser_name: row.advertiser_name ?? row.publisher_name ?? row.brand_name ?? null,
        clicks: row.clicks ?? row.click_count ?? null,
        orders: 1,
        totalConversions: 1,
        validatedConversions:
          String(row.conversion_status || row.status || "").toLowerCase().includes("approv") ||
          String(row.conversion_status || row.status || "").toLowerCase() === "confirmed"
            ? 1
            : null,
        pendingConversions:
          String(row.conversion_status || row.status || "").toLowerCase().includes("pend") ? 1 : null,
        rejectedConversions:
          String(row.conversion_status || row.status || "").toLowerCase().includes("reject") ||
          String(row.conversion_status || row.status || "").toLowerCase().includes("decline")
            ? 1
            : null,
        commission: row.publisher_commission ?? row.commission ?? row.conversion_value?.publisher ?? null,
        originalOrderValue: row.conversion_value?.value ?? row.order_value ?? row.value ?? null,
        currency: row.currency ?? row.conversion_value?.currency ?? null,
        country: row.country ?? row.customer_country ?? null,
        coupon_code: row.voucher_code ?? row.coupon_code ?? null,
        click_id: row.clickref ?? row.click_ref ?? row.click_id ?? null,
        customer_type: row.customer_type ?? row.customerType ?? row.custType ?? null,
        report_type: "partnerize_conversion_derived",
      }));
    },

    async fetchAll(params = {}, options = {}) {
      const stats = { requestCount: 0 };
      const campaigns = options.skipCampaigns ? [] : await this.fetchCampaigns(params.campaigns || {}, stats);
      const conversions = options.skipConversions
        ? []
        : await this.fetchConversions(params.conversions || {}, stats);
      const payments = options.skipPayments ? [] : await this.fetchPayments(params.payments || {}, stats);
      const campaignIds = campaigns
        .map((c) => c?.campaign_id ?? c?.campaignId ?? c?.id)
        .filter(Boolean);
      const coupons = options.skipCoupons
        ? []
        : await this.fetchCoupons({ ...(params.coupons || {}), campaignIds }, stats);
      const performance = options.skipPerformance
        ? []
        : await this.fetchPerformance({ conversions: params.conversions || {} }, stats);
      return { campaigns, conversions, payments, coupons, performance, stats };
    },
  };

  return adapter;
}
