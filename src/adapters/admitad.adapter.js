import { createHttpClient, requestWithRetry } from "../core/httpClient.js";
import { SUPPLIER_CAPABILITIES } from "./contract.js";
import { EXHAUSTION, recordExhaustion } from "../core/paginationExhaustion.js";

const DEFAULT_LIMIT = 500;

/** Certification-only ceiling. Shorter than the shared 30s client default so a probe reports its
 *  own timeout inside the source budget instead of being killed by the runtime. */
export const ADMITAD_CERTIFICATION_TIMEOUT_MS = Number(
  process.env.ADMITAD_CERTIFICATION_TIMEOUT_MS || 15000,
);

/** A field dictionary needs one row. The service bounds this again, independently. */
export const ADMITAD_CERTIFICATION_MAX_ROWS = 1;

/** The page every Admitad certification probe asks for. Not a guess and not smaller than anything
 *  production sends: authenticate() already issues limit=1, offset=0 against /websites/v2/, and
 *  fetchOffsetPaginated sends the same two parameters on every path it walks. */
export const ADMITAD_CERTIFICATION_PAGE_PARAMS = Object.freeze({ limit: 1, offset: 0 });

/**
 * Every Admitad source object certification can sample, and the one path each uses.
 *
 * A frozen registry rather than a path argument: there is no call shape here through which a
 * caller could reach an endpoint this table does not name. Each path is production's own —
 * /websites/v2/ is what authenticate() calls, /advcampaigns/ is what fetchCampaigns calls when no
 * websiteId is supplied (which is how the sync job calls it), and /coupons/ is fetchCoupons'
 * only path, taking no campaign, programme or website scope in production either.
 *
 * The programmes path is deliberately the UNSCOPED one. /advcampaigns/website/{w_id}/ would need a
 * website id, and discovering one to then scope a probe by it is a second request and a second
 * decision; the unscoped path is what production actually runs.
 */
export const ADMITAD_CERTIFICATION_SPECS = Object.freeze({
  websites: Object.freeze({ method: "GET", path: "/websites/v2/" }),
  programs: Object.freeze({ method: "GET", path: "/advcampaigns/" }),
  coupons: Object.freeze({ method: "GET", path: "/coupons/" }),
  actions: Object.freeze({
    method: "GET",
    path: "/statistics/actions/",
    // The only dated Admitad object. The window is the service's, computed from a frozen preset;
    // the sampler refuses to build a request without one rather than silently asking for all time.
    needs: ["window"],
    // Production's own parameter construction, not a reimplementation of it:
    // buildAdmitadActionParams is what fetchConversions runs, so the allowlist and the
    // order_by=datetime default are production's, and the dates use production's serializer.
    params: (window) =>
      buildAdmitadActionParams({
        status_updated_start: admitadActionDateParam(window.from),
        status_updated_end: admitadActionDateParam(window.to),
      }),
  }),
});

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

/**
 * The action-window date serializer.
 *
 * Admitad's Publisher Reports API documents status_updated_start / status_updated_end as
 * %d.%m.%Y %H:%M:%S — "01.05.2012 21:12:01". NOT ISO 8601.
 *
 * This was previously an ISO serializer, and /statistics/actions/ answered 400 to every request
 * production ever made with it. The failure was invisible because fetchAll swallows a failing
 * source object, so the action ingestion had been silently rejected rather than returning nothing
 * legitimately. Certification is what surfaced it: the same request, made in isolation, reported
 * its own 400.
 *
 * Components are read in UTC — getUTCDate and friends, never the local-time getters — so the
 * window MBO computes is the window Admitad is asked for, whatever timezone the runtime happens
 * to be in. Each component is zero-padded to the width the format specifies.
 *
 * One definition, used by production's fetchConversions and by the certification probe alike:
 * a format this specific must not be able to drift between the request we certify and the request
 * we ingest with.
 */
export function admitadActionDateParam(value) {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const day = pad(date.getUTCDate());
  const month = pad(date.getUTCMonth() + 1);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${day}.${month}.${year} ${time}`;
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
  httpClient: injectedHttpClient = null,
} = {}) {
  if (!accessToken) throw new Error("Admitad adapter requires accessToken");

  const root = String(baseURL).replace(/\/$/, "");
  const httpClient =
    injectedHttpClient ??
    createHttpClient({
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
    // Admitad's walk has no page cap: every exit below is a break, so the initial value is only
    // reachable if a branch ever stops naming its reason.
    let reason = EXHAUSTION.UNKNOWN;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const payload = await get(path, { ...baseParams, limit, offset }, stats);
      const pageRows = extractAdmitadCollection(payload);
      const meta = extractAdmitadMeta(payload, { limit, offset });
      rows.push(...pageRows);
      pages.push({ payload, meta });

      if (!pageRows.length) {
        reason = EXHAUSTION.EMPTY_PAGE;
        break;
      }
      const nextOffset = meta.offset + meta.limit;
      if (meta.count != null && nextOffset >= meta.count) {
        // `count` is Admitad's own size for the whole result set, so walking past it is the
        // supplier asserting the end rather than an inference from this page.
        reason = EXHAUSTION.SUPPLIER_TOTAL_REACHED;
        break;
      }
      if (pageRows.length < meta.limit) {
        // A short page is OUR inference that nothing follows. Usually right; wrong in the one
        // direction that matters, because it ends the walk early and looks complete.
        reason = EXHAUSTION.SHORT_PAGE;
        break;
      }
      offset = nextOffset;
    }

    recordExhaustion(stats, reason, { pagesFetched: pages.length });
    return { rows, pages };
  }

  return {
    supplierKey: "ADMITAD",

    getCapabilities() {
      return {
        // DEEP_LINK removed: this integration has no Admitad deeplink builder, endpoint, method,
        // production caller or output path — zero references anywhere in src/. The capability was
        // declared and never implemented, and it survived because DEEP_LINK is descriptive rather
        // than method-backed, so assertAdapterContract had nothing to check it against.
        //
        // A programme's allow_deeplink field does NOT re-justify it. That field says the SUPPLIER
        // permits deeplinks for that programme; it says nothing about whether MBO can build one.
        // Reading capability out of it would be exactly the inference this cleanup exists to undo.
        capabilities: [
          SUPPLIER_CAPABILITIES.CAMPAIGNS,
          SUPPLIER_CAPABILITIES.COUPONS,
          SUPPLIER_CAPABILITIES.CONVERSIONS,
          // TRACKING_SUBID is KEPT, and it is implemented: buildAdmitadActionParams allowlists
          // subid and subid1-4 as request filters, and normalizeAdmitadActionEvidence extracts all
          // five onto every action row fetchConversions returns.
          SUPPLIER_CAPABILITIES.TRACKING_SUBID,
          SUPPLIER_CAPABILITIES.REPORTING,
        ],
        pagination: "offset",
        notes: [
          "OAuth2 Bearer token; credential refresh belongs to NetworkAccount credential state.",
          "Programmes, coupons and action reporting use verified publisher API endpoints.",
          "status, processed and paid remain separate source facts.",
          "Product CSV/XML feed ingestion is deferred until a live feed fixture is captured.",
          "Deeplink generation is NO_ENDPOINT_IN_INTEGRATION: no builder, endpoint or caller exists. A programme's allow_deeplink flag is supplier permission, not MBO capability.",
          "TRACKING_SUBID is read-only here: subids are filterable and are preserved on action rows, but nothing in this integration injects one into an outbound link.",
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

    /**
     * One bounded certification request for any source object in ADMITAD_CERTIFICATION_SPECS.
     *
     * GET /websites/v2/ with limit=1, offset=0 — the exact request authenticate() already makes in
     * production, so certification asks the supplier for nothing new and nothing smaller. That is
     * the point the Awin coupons 500 made: asking for LESS than production ever asks for is still
     * asking for something unevidenced. Here the bounded form IS the evidenced form.
     *
     * fetchOffsetPaginated is deliberately NOT used — it loops until the meta count is exhausted,
     * and a probe has no business paginating. The private get() helper is also skipped, because it
     * wraps requestWithRetry with three retries, which would turn one supplier rejection into
     * three.
     *
     * Neither object certified here is scoped to joined programmes. websites lists this
     * publisher's own registered sites; the unscoped /advcampaigns/ may return catalogue-wide
     * programmes rather than only joined ones. So an empty result from either is OK_NO_ROWS and
     * never an account-state blocker — reading "no joined campaigns" out of a query that does not
     * ask about joins would be inventing a finding.
     *
     * The collection is read with extractAdmitadCollection, production's own extractor, so what is
     * sampled is a ROW and never the {results, _meta} envelope around it.
     */
    async fetchCertificationSample(sourceObject, { timeoutMs, window = null } = {}) {
      // Object.hasOwn, not a bare lookup: a plain property read would follow the prototype chain
      // and let a name like "constructor" resolve to something that is not a spec.
      const spec = Object.hasOwn(ADMITAD_CERTIFICATION_SPECS, String(sourceObject))
        ? ADMITAD_CERTIFICATION_SPECS[String(sourceObject)]
        : null;
      if (!spec) {
        throw new Error(`No Admitad certification sample is defined for "${sourceObject}"`);
      }

      // Checked BEFORE the request: a dated object with no window costs no supplier call and is
      // reported as its own failure, never as an unbounded query the supplier happens to accept.
      const ctx = { window };
      for (const need of spec.needs ?? []) {
        if (!ctx[need]) {
          throw new Error(`Admitad certification sample "${sourceObject}" requires ${need}`);
        }
      }
      if (spec.needs?.includes("window") && (!window.from || !window.to)) {
        throw new Error(`Admitad certification sample "${sourceObject}" requires a bounded window`);
      }

      const response = await httpClient.get(spec.path, {
        params: { ...ADMITAD_CERTIFICATION_PAGE_PARAMS, ...(spec.params?.(window) ?? {}) },
        timeout: Number(timeoutMs || ADMITAD_CERTIFICATION_TIMEOUT_MS),
      });

      return extractAdmitadCollection(response?.data).slice(0, ADMITAD_CERTIFICATION_MAX_ROWS);
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
