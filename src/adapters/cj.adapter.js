import { createHttpClient, requestWithRetry } from "../core/httpClient.js";
import { SUPPLIER_CAPABILITIES } from "./contract.js";

const DEFAULT_RECORDS_PER_PAGE = 100;
const MAX_PAGE_COUNT = 1000;

function decodeXml(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tagText(xml, tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml ?? "").match(
    new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"),
  );
  if (!match) return null;
  const value = decodeXml(match[1]).trim();
  return value === "" || value.toLowerCase() === "null" ? null : value;
}

function tagBlocks(xml, tag) {
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "gi");
  const blocks = [];
  let match;
  while ((match = regex.exec(String(xml ?? ""))) !== null) blocks.push(match[1]);
  return blocks;
}

function numeric(value) {
  if (value == null || value === "" || String(value).toUpperCase() === "N/A") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) return true;
  if (["false", "no", "0"].includes(normalized)) return false;
  return null;
}

function parseAction(block) {
  const commission = tagText(tagText(block, "commission") ?? block, "default");
  return {
    id: tagText(block, "id"),
    name: tagText(block, "name"),
    type: tagText(block, "type"),
    commission: commission ? { default: commission } : null,
  };
}

function parseAdvertiser(block) {
  const primaryCategoryBlock = tagText(block, "primary-category") ?? "";
  const actionsBlock = tagText(block, "actions") ?? "";
  const linkTypesBlock = tagText(block, "link-types") ?? "";
  return {
    advertiser_id: tagText(block, "advertiser-id"),
    advertiser_name: tagText(block, "advertiser-name"),
    account_status: tagText(block, "account-status"),
    program_url: tagText(block, "program-url"),
    relationship_status: tagText(block, "relationship-status"),
    language: tagText(block, "language"),
    seven_day_epc: numeric(tagText(block, "seven-day-epc")),
    three_month_epc: numeric(tagText(block, "three-month-epc")),
    mobile_tracking_certified: booleanValue(tagText(block, "mobile-tracking-certified")),
    network_rank: numeric(tagText(block, "network-rank")),
    performance_incentives: booleanValue(tagText(block, "performance-incentives")),
    primary_category: {
      parent: tagText(primaryCategoryBlock, "parent"),
      child: tagText(primaryCategoryBlock, "child"),
    },
    actions: tagBlocks(actionsBlock, "action").map(parseAction),
    link_types: tagBlocks(linkTypesBlock, "link-type")
      .map((item) => decodeXml(item).trim())
      .filter(Boolean),
    record_source: "cj_advertiser_lookup",
  };
}

export function extractCjAdvertisers(xml) {
  return tagBlocks(xml, "advertiser")
    .map(parseAdvertiser)
    .filter((row) => row.advertiser_id);
}

function parseLink(block) {
  return {
    advertiser_id: tagText(block, "advertiser-id"),
    advertiser_name: tagText(block, "advertiser-name"),
    category: tagText(block, "category"),
    click_commission: tagText(block, "click-commission"),
    lead_commission: tagText(block, "lead-commission"),
    sale_commission: tagText(block, "sale-commission"),
    destination: tagText(block, "destination"),
    click_url: tagText(block, "clickUrl") ?? tagText(block, "click-url"),
    link_id: tagText(block, "link-id"),
    link_name: tagText(block, "link-name"),
    link_type: tagText(block, "link-type"),
    description: tagText(block, "description"),
    allow_deep_linking: booleanValue(tagText(block, "allow-deep-linking")),
    performance_incentive: booleanValue(tagText(block, "performance-incentive")),
    promotion_start_date: tagText(block, "promotion-start-date"),
    promotion_end_date: tagText(block, "promotion-end-date"),
    promotion_type: tagText(block, "promotion-type"),
    coupon_code: tagText(block, "coupon-code"),
    relationship_status: tagText(block, "relationship-status"),
    language: tagText(block, "language"),
    targeted_countries: tagText(block, "targeted-countries"),
    event_name: tagText(block, "event-name"),
    last_updated: tagText(block, "last-updated"),
    seven_day_epc: tagText(block, "seven-day-epc"),
    three_month_epc: tagText(block, "three-month-epc"),
    record_source: "cj_link_search",
  };
}

export function extractCjLinks(xml) {
  return tagBlocks(xml, "link")
    .map(parseLink)
    .filter((row) => row.link_id && row.advertiser_id);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function pageStats(xml, containerTag) {
  const escaped = String(containerTag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml ?? "").match(new RegExp(`<${escaped}([^>]*)>`, "i"));
  const attributes = match?.[1] ?? "";
  const attr = (name) => {
    const found = attributes.match(new RegExp(`${name}=["']([^"']*)["']`, "i"));
    return found ? numeric(found[1]) : null;
  };
  return {
    totalMatched: attr("total-matched") ?? attr("total-results"),
    recordsReturned: attr("records-returned"),
    pageNumber: attr("page-number"),
  };
}

function cleanParams(input = {}) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

export function createCjAdapter({
  accessToken,
  requestorCid,
  websiteId,
  advertiserLookupBaseURL = process.env.CJ_ADVERTISER_LOOKUP_BASE_URL || "https://advertiser-lookup.api.cj.com",
  linkSearchBaseURL = process.env.CJ_LINK_SEARCH_BASE_URL || "https://link-search.api.cj.com",
} = {}) {
  if (!accessToken) throw new Error("CJ adapter requires accessToken");
  const authorization = `Bearer ${accessToken}`;
  const advertiserClient = createHttpClient({
    baseURL: String(advertiserLookupBaseURL).replace(/\/$/, ""),
    apiKey: authorization,
    headers: { Accept: "application/xml,text/xml" },
  });
  const linkClient = createHttpClient({
    baseURL: String(linkSearchBaseURL).replace(/\/$/, ""),
    apiKey: authorization,
    headers: { Accept: "application/xml,text/xml" },
  });

  async function getXml(client, path, params, stats = null) {
    if (stats) stats.requestCount = (stats.requestCount || 0) + 1;
    const response = await requestWithRetry(
      () => client.get(path, { params, responseType: "text" }),
      { retries: 3, delayMs: 1000 },
    );
    return String(response?.data ?? "");
  }

  async function fetchPaged({ client, path, params, extractor, containerTag, stats }) {
    const base = { ...params };
    let page = positiveInteger(base["page-number"], 1);
    const recordsPerPage = positiveInteger(base["records-per-page"], DEFAULT_RECORDS_PER_PAGE);
    delete base["page-number"];
    delete base["records-per-page"];
    const out = [];

    for (let i = 0; i < MAX_PAGE_COUNT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const xml = await getXml(client, path, {
        ...base,
        "page-number": page,
        "records-per-page": recordsPerPage,
      }, stats);
      const rows = extractor(xml);
      out.push(...rows);
      const meta = pageStats(xml, containerTag);
      if (!rows.length) break;
      if (meta.totalMatched != null && out.length >= meta.totalMatched) break;
      if (meta.recordsReturned != null && meta.recordsReturned < recordsPerPage) break;
      if (rows.length < recordsPerPage) break;
      page += 1;
    }
    return out;
  }

  return {
    supplierKey: "CJ",

    getCapabilities() {
      return {
        capabilities: [
          SUPPLIER_CAPABILITIES.CAMPAIGNS,
          SUPPLIER_CAPABILITIES.COUPONS,
          SUPPLIER_CAPABILITIES.DEEP_LINK,
        ],
        pagination: "page",
        notes: [
          "Publisher discovery foundation only: Advertiser Lookup and Link Search REST/XML.",
          "Personal Access Token Bearer authentication is required; legacy developer keys are deprecated.",
          "Advertiser Lookup default commissions are program-term discovery/display facts only; they are not promoted into payable SupplierCommissionRule by this adapter.",
          "Commission Detail GraphQL remains VERIFY_LIVE until the connected publisher schema and a real fixture are captured.",
          "Product Search GraphQL is documented but intentionally not declared live in this foundation.",
        ],
      };
    },

    async authenticate(stats = null) {
      if (!requestorCid) return { ok: false, detail: "CJ requestorCid is required for Advertiser Lookup" };
      try {
        await getXml(advertiserClient, "/v2/advertiser-lookup", {
          "requestor-cid": requestorCid,
          "advertiser-ids": "joined",
          "records-per-page": 1,
          "page-number": 1,
        }, stats);
        return { ok: true };
      } catch (error) {
        return { ok: false, detail: error?.message || "CJ authentication failed" };
      }
    },

    async healthCheck(stats = null) {
      return this.authenticate(stats);
    },

    async fetchCampaigns(params = {}, stats = null) {
      const cid = params["requestor-cid"] ?? params.requestorCid ?? requestorCid;
      if (!cid) throw new Error("CJ Advertiser Lookup requires requestor-cid");
      const query = cleanParams({
        ...params,
        requestorCid: undefined,
        "requestor-cid": cid,
        "advertiser-ids": params["advertiser-ids"] ?? params.advertiserIds ?? "joined",
        advertiserIds: undefined,
      });
      return fetchPaged({
        client: advertiserClient,
        path: "/v2/advertiser-lookup",
        params: query,
        extractor: extractCjAdvertisers,
        containerTag: "advertisers",
        stats,
      });
    },

    async fetchLinks(params = {}, stats = null) {
      const pid = params["website-id"] ?? params.websiteId ?? websiteId;
      if (!pid) throw new Error("CJ Link Search requires website-id / PID");
      const query = cleanParams({
        ...params,
        websiteId: undefined,
        advertiserIds: undefined,
        "website-id": pid,
        "advertiser-ids": params["advertiser-ids"] ?? params.advertiserIds ?? "joined",
      });
      return fetchPaged({
        client: linkClient,
        path: "/v2/link-search",
        params: query,
        extractor: extractCjLinks,
        containerTag: "links",
        stats,
      });
    },

    async fetchCoupons(params = {}, stats = null) {
      return this.fetchLinks({ ...params, "promotion-type": params["promotion-type"] ?? "coupon" }, stats);
    },

    async fetchAll(options = {}) {
      const stats = { requestCount: 0 };
      const campaigns = options.skipCampaigns ? [] : await this.fetchCampaigns(options.campaigns ?? {}, stats);
      const links = options.skipLinks ? [] : await this.fetchLinks(options.links ?? {}, stats);
      const coupons = options.skipCoupons ? [] : await this.fetchCoupons(options.coupons ?? {}, stats);
      return { campaigns, links, coupons, stats };
    },
  };
}
