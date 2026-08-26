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
  baseURL = process.env.PARTNERIZE_BASE_URL || "https://api.partnerize.com",
} = {}) {
  if (!applicationKey || !userApiKey) {
    throw new Error("Partnerize adapter requires applicationKey and userApiKey");
  }

  const basic = Buffer.from(`${applicationKey}:${userApiKey}`).toString("base64");
  const httpClient = createHttpClient({
    baseURL: String(baseURL).replace(/\/$/, ""),
    apiKey: `Basic ${basic}`,
    headers: { Accept: "application/json" },
  });

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

  const adapter = {
    supplierKey: "PARTNERIZE",
    publisherId,

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
        if (stats) stats.paymentFetchSkipped = error?.response?.status || error?.message;
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
