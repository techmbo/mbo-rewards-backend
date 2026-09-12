import { prisma } from "../../database/prisma.js";
import { fail } from "../../core/apiResponse.js";
import { createOptimiseAdapter } from "../../adapters/optimise.adapter.js";
import { resolveOptimiseCredentials } from "../integrations/optimiseCredentials.js";
import { comparePathSets, summarisePayloads } from "./payloadShape.js";

/**
 * Live supplier certification probe.
 *
 * Answers one question: what does this supplier's API actually send? It samples the smallest
 * response each endpoint will give, reduces it to a field dictionary of paths and structural
 * categories, and compares that against the paths already present in stored RAW rows.
 *
 * Three properties hold by construction rather than by care:
 *
 *  - Read-only against the supplier. Every probe below is declared in a registry with an explicit
 *    method, and `runProbe` refuses to dispatch anything whose declared method is not GET or an
 *    allowlisted read-only POST. There is no generic "call this endpoint" path.
 *  - Read-only against our database. The service reads MarketplaceAccount (through the existing
 *    resolver) and RawPayload, and holds no repository or service that can write.
 *  - Credential-free output. Field dictionaries come from `summarisePayloads`, which builds its
 *    result from path names and categories and never copies a value. Credentials cannot appear in
 *    the output because no value can.
 */

/** Probes whose declared method the dispatcher will run. A POST must also carry a fixed body. */
const READ_ONLY_METHODS = new Set(["GET", "POST_READONLY"]);

/**
 * Wall-clock ceiling for one source object, covering the throttle wait and the request itself.
 * Well inside any serverless runtime limit, so the probe reports its own failure rather than
 * being killed mid-flight with nothing to show.
 */
const SOURCE_BUDGET_MS = Number(process.env.CERTIFICATION_SOURCE_BUDGET_MS || 20000);

/**
 * Certification never makes more than this many supplier requests for one source object.
 *
 * `products` is the one exception at 2, and only as a dependent chain: sample one feed, then sample
 * one item from THAT feed. The second request is derived entirely from the first response.
 */
export const MAX_SUPPLIER_REQUESTS_PER_SOURCE = 1;
export const MAX_SUPPLIER_REQUESTS_PRODUCTS = 2;

/**
 * Commission groups is the one source object allowed more than a couple of requests.
 *
 * A campaign with no commission groups is common and says nothing about the schema, so certifying
 * from a single campaign is a coin flip. The chain looks at up to five campaigns from ONE bounded
 * list request and stops at the first that returns a group: one list + at most five dependent
 * requests, six in total. This bound applies to commission_groups alone.
 */
export const COMMISSION_GROUP_CANDIDATE_LIMIT = 5;
export const MAX_SUPPLIER_REQUESTS_COMMISSION_GROUPS = 1 + COMMISSION_GROUP_CANDIDATE_LIMIT;

/**
 * Floor for one dependent attempt. With less than this left in the source budget the chain stops
 * and says so, rather than firing a request it knows cannot finish.
 */
const MIN_ATTEMPT_MS = 2500;

/**
 * Wall-clock ceiling for the whole run.
 *
 * Per-source budgets alone bound each request but not their sum: a sweep of every source object
 * could still add up towards the runtime limit and be killed with nothing to show. Once this budget
 * is spent the remaining source objects are REPORTED as unattempted rather than tried, so the route
 * always returns a result it chose to return.
 */
const RUN_BUDGET_MS = Number(process.env.CERTIFICATION_RUN_BUDGET_MS || 120000);

/**
 * Optimise probe registry.
 *
 * Each entry names a source object and the endpoint it samples; the call itself goes through the
 * adapter's `fetchCertificationSample`, which issues exactly one bounded request. Nothing here
 * reaches the sync fetchers, which paginate to exhaustion and retry for minutes.
 */
const OPTIMISE_PROBES = Object.freeze({
  campaigns: { method: "GET", endpointKey: "GET /campaigns" },
  voucher_codes: { method: "GET", endpointKey: "GET /vouchercodes" },
  conversions: { method: "GET", endpointKey: "GET /conversions" },
  payment_overview: { method: "GET", endpointKey: "GET /payments" },
  invoices: { method: "GET", endpointKey: "GET /invoices" },
  products: {
    method: "GET",
    endpointKey: "GET /product-feeds/",
    // Emits two result rows so feed metadata and item fields are never mixed into one dictionary.
    emits: ["product_feeds", "product_items"],
  },
  reporting: { method: "POST_READONLY", endpointKey: "POST /reporting/", unsupportedForSampling: true },
  invoiceReporting: { method: "POST_READONLY", endpointKey: "POST /reporting/ (invoiceDate)", unsupportedForSampling: true },
  commission_groups: {
    method: "GET",
    endpointKey: "GET /campaigns/{campaignId}/commission-groups",
    // Its own bounded chain: a campaign list, then up to five campaigns tried in turn.
    chain: "commissionGroups",
  },
  campaign_detail: {
    method: "GET",
    endpointKey: "GET /campaigns/{productId}",
    needs: "campaignDetailId",
    skipCategory: "SKIPPED_NO_CAMPAIGN_DETAIL_ID",
  },
  basket_items: {
    method: "GET",
    endpointKey: "GET /conversions (basket items)",
    unsupported: "Optimise exposes no basket-item endpoint; the catalog entry is marked live=false and no adapter call exists.",
  },
});

const PROBE_REGISTRY = Object.freeze({ optimise: OPTIMISE_PROBES });

export function listProbeSourceObjects(network) {
  const probes = PROBE_REGISTRY[String(network || "").toLowerCase()];
  return probes ? Object.keys(probes) : [];
}

/** HTTP status reduced to a category. The supplier's error body is never read or returned. */
export function statusCategory(error) {
  if (error?.certificationTimeout) return "SUPPLIER_TIMEOUT";
  if (error?.certificationThrottled) return "SUPPLIER_RATE_LIMITED";
  // axios reports its own timeout this way; it is the same condition seen from a lower layer.
  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") return "SUPPLIER_TIMEOUT";
  const status = Number(error?.response?.status ?? error?.status ?? 0);
  if (!status) return "NETWORK_ERROR";
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_ERROR";
  if (status >= 400) return "REQUEST_REJECTED";
  return "OK";
}

/**
 * Lookback presets the caller may choose between.
 *
 * A preset, not a number of days and not a date pair. The caller picks a token; the service alone
 * turns it into dates. That keeps the request body free of anything resembling a date parameter, so
 * there is no path by which a caller could steer the supplier query — the reason the conversions
 * contract is pinned in the first place. Ninety days is the ceiling because a wider lookback is a
 * bigger ask of the supplier for no extra certification value: the probe reads one row either way.
 */
export const WINDOW_PRESETS = Object.freeze({ "7d": 7, "30d": 30, "90d": 90 });
export const DEFAULT_WINDOW_PRESET = "7d";

/** Days for a preset token. Unknown tokens never reach here; the controller rejects them with 400. */
export function windowPresetDays(preset) {
  return WINDOW_PRESETS[preset] ?? WINDOW_PRESETS[DEFAULT_WINDOW_PRESET];
}

/**
 * A neutral date window in ISO YYYY-MM-DD.
 *
 * Deliberately NOT named after any endpoint's parameters. An earlier version returned
 * startDate/endDate/dateFrom/dateTo together and every dated sample spread all four, which sent
 * /conversions four parameters and none of the two it takes. Naming the window `from`/`to` makes
 * that impossible: each sample must map it onto its own endpoint's parameter names explicitly.
 */
function defaultDateWindow(days = 7) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

/**
 * Whether a probe failure was the item sampler reporting that no bounded sample exists.
 * A distinct outcome from a supplier error: nothing went wrong, the feed simply cannot be sampled
 * one record at a time within the byte window.
 */
const NOT_BOUNDED_NOTES = Object.freeze({
  NO_FEED_URL: "The sampled feed carries no feed URL, so there is nothing to take an item sample from.",
  DISALLOWED_HOST: "The sampled feed's URL is not on the allowed product-feed host, so it was not fetched.",
  NO_COMPLETE_RECORD_IN_WINDOW:
    "No complete product record fitted in the bounded byte window. Certification does not widen the window, because that would begin downloading the feed.",
  UNRECOGNISED_FEED_FORMAT: "The bounded window held no recognisable CSV or XML product record.",
  UNKNOWN: "A bounded single product-item sample could not be taken.",
});

function notBoundedReason(error) {
  return error?.productItemSampleNotBounded ? String(error.reason || "UNKNOWN") : null;
}

/**
 * The identifier each campaign-scoped endpoint requires, read off a sampled campaign row.
 *
 * Two namespaces, two selectors, no shared fallback. `id` is not consulted by either: it was the
 * fallback removed from commission-group selection once the identifier audit showed campaignId and
 * productId are separate namespaces on the same row, and reinstating it here would repeat that bug.
 * A row lacking the identifier an endpoint needs yields null, and the caller skips that endpoint
 * rather than dispatching a foreign identifier to it.
 */
function firstUsableId(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    // A value carrying path or query syntax would escape the path segment it is interpolated into.
    return /[\\/\s?#]/.test(text) ? null : text;
  }
  return null;
}

/** GET /campaigns/{productId} — campaign detail. Never id, never campaignId. */
export function campaignDetailIdOf(row = {}) {
  return firstUsableId(row, ["productId", "product_id"]);
}

/** GET /campaigns/{campaignId}/commission-groups. Never id, never productId. */
export function commissionGroupCampaignIdOf(row = {}) {
  return firstUsableId(row, ["campaignId", "campaign_id"]);
}

function asRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  if (Array.isArray(result?.data)) return result.data;
  if (result && typeof result === "object") return [result];
  return [];
}

export class NetworkCertificationService {
  // Read-only by construction: a prisma client for RawPayload lookups and nothing else.
  constructor(deps = {}) {
    this.db = deps.prisma ?? prisma;
    this.adapterFactory = deps.adapterFactory ?? null;
    this.credentialResolver = deps.credentialResolver ?? resolveOptimiseCredentials;
  }

  /**
   * Paths already present in stored RAW rows for this source object. Only keys are collected;
   * `summarisePayloads` is applied to the stored bodies exactly as it is to live ones, so no
   * stored value reaches the result either.
   */
  async rawPathsFor({ networkSource, sourceObject, limit = 5 }) {
    const rows = await this.db.rawPayload.findMany({
      where: { supplier: String(networkSource).toUpperCase(), resourceKey: sourceObject },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { payload: true },
    });
    const bodies = rows.flatMap((r) => asRows(r.payload));
    return summarisePayloads(bodies).map((f) => f.path);
  }

  async buildOptimiseAdapter({ region, accountLabel }) {
    const credentials = await this.credentialResolver(region, accountLabel);
    if (!credentials?.apiKey || !credentials?.agencyId || !credentials?.contactId) {
      // Nothing about the credential is reported beyond whether it resolved.
      throw fail("Optimise credentials are not configured for this region and account label.", 424);
    }
    const factory = this.adapterFactory ?? createOptimiseAdapter;
    return factory({
      apiKey: credentials.apiKey,
      baseURL: credentials.baseURL,
      agencyId: credentials.agencyId,
      contactId: credentials.contactId,
    });
  }

  /**
   * The commission-group chain: one campaign list, then up to five campaigns tried in turn.
   *
   * Control flow, and the reasons for it:
   *
   *  - ONE bounded list request returns up to five campaign rows. Asking five times for one row
   *    each would cost five requests before a single commission-group call.
   *  - Each row yields an identifier through commissionGroupCampaignIdOf only — campaignId or
   *    campaign_id. Rows without one are skipped, never substituted from `id` or `productId`.
   *  - Campaigns are tried SEQUENTIALLY and the loop stops at the first non-empty response. A
   *    burst of five concurrent calls is the traffic that gets an affiliate account flagged.
   *  - Only a recognised EMPTY response continues to the next campaign. Any supplier failure ends
   *    the chain with its category: continuing past a 401 or a 429 would turn one rejection into
   *    five, and an unrecognised envelope is a parse failure, not evidence of zero groups.
   *  - Every attempt is timed against what remains of the source budget, so five attempts cannot
   *    add up to five full timeouts.
   */
  async certifyCommissionGroups({ adapter, key, probe, budgetLeft }) {
    const base = {
      network: key,
      sourceObject: "commission_groups",
      endpointKey: probe.endpointKey,
      httpMethod: probe.method,
      sampleCount: 0,
      fieldPaths: [],
    };

    // The source's own deadline, never longer than what the whole run has left.
    const deadline = Date.now() + Math.max(0, Math.min(SOURCE_BUDGET_MS, budgetLeft()));
    const timeLeft = () => deadline - Date.now();
    const attemptTimeout = () => Math.max(MIN_ATTEMPT_MS, Math.min(SOURCE_BUDGET_MS / 2, timeLeft()));

    let candidates;
    try {
      const rows = asRows(
        await adapter.fetchCertificationSample("campaign_candidates", { timeoutMs: attemptTimeout() }),
      ).slice(0, COMMISSION_GROUP_CANDIDATE_LIMIT);
      candidates = rows.map((row) => commissionGroupCampaignIdOf(row)).filter(Boolean);
    } catch (error) {
      return { ...base, ok: false, statusCategory: statusCategory(error) };
    }

    if (!candidates.length) {
      // No dependent request: not one sampled campaign carries the identifier this endpoint needs.
      return { ...base, ok: false, statusCategory: "SKIPPED_NO_COMMISSION_GROUP_CAMPAIGN_ID" };
    }

    let checked = 0;
    for (const campaignId of candidates) {
      if (timeLeft() < MIN_ATTEMPT_MS) {
        return { ...base, ok: false, statusCategory: "SOURCE_BUDGET_EXHAUSTED", campaignsChecked: checked };
      }

      let sample;
      try {
        sample = await adapter.fetchCertificationCommissionGroupSample(campaignId, {
          timeoutMs: attemptTimeout(),
        });
      } catch (error) {
        // Fail closed. A supplier failure is never a reason to try the next campaign.
        return { ...base, ok: false, statusCategory: statusCategory(error), campaignsChecked: checked };
      }

      checked += 1;
      const rows = asRows(sample?.rows).slice(0, 1);
      if (rows.length) {
        const fieldPaths = summarisePayloads(rows);
        // No campaign id, name or index is reported: which campaign happened to have groups is not
        // part of the schema, and naming it would leak a supplier value into a structural result.
        return {
          ...base,
          ok: true,
          statusCategory: "OK",
          sampleCount: rows.length,
          fieldCount: fieldPaths.length,
          fieldPaths,
        };
      }
    }

    // Every sampled campaign answered, and answered empty. That is a fact about these campaigns,
    // not about Optimise: campaignsChecked says how far the search got.
    return {
      ...base,
      ok: true,
      statusCategory: "OK",
      fieldCount: 0,
      campaignsChecked: checked,
      note: "No commission-group rows in the campaigns sampled; this does not mean the network has none.",
    };
  }

  /**
   * The products chain: one feed, then one item from that feed.
   *
   * Two supplier requests, no more. The second is built by the adapter from the first response and
   * a host allowlist, so nothing a caller sends can influence which URL is fetched — the request
   * body cannot name a feed, a feed URL or a path.
   *
   * The two are reported as SEPARATE rows. Feed metadata (feedId, itemCount, lastImportedDate) and
   * product item fields (sku, price, availability) are different vocabularies, and merging them
   * into one dictionary would make the result unreadable as certification of either.
   */
  async certifyProductChain({ adapter, key, probe, compareRaw, budgetLeft }) {
    const rows = [];
    const base = { network: key, httpMethod: "GET" };
    const timeoutFor = () => Math.max(1000, Math.min(SOURCE_BUDGET_MS / 2, budgetLeft()));

    // Request 1 of 2 — one feed row.
    let feedRow = null;
    try {
      const sample = asRows(
        await adapter.fetchCertificationSample("products", { timeoutMs: timeoutFor() }),
      ).slice(0, 1);
      feedRow = sample[0] ?? null;
      const fieldPaths = summarisePayloads(sample);
      const entry = {
        ...base,
        sourceObject: "product_feeds",
        endpointKey: probe.endpointKey,
        ok: true,
        statusCategory: "OK",
        sampleCount: sample.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
      };
      if (compareRaw) {
        const rawPaths = await this.rawPathsFor({ networkSource: key, sourceObject: "products" }).catch(() => []);
        entry.rawComparison = comparePathSets(fieldPaths.map((f) => f.path), rawPaths);
      }
      rows.push(entry);
    } catch (error) {
      rows.push({
        ...base,
        sourceObject: "product_feeds",
        endpointKey: probe.endpointKey,
        ok: false,
        statusCategory: statusCategory(error),
        sampleCount: 0,
        fieldPaths: [],
      });
    }

    const itemBase = {
      ...base,
      sourceObject: "product_items",
      endpointKey: "GET {feedUrl} (bounded byte window)",
      sampleCount: 0,
      fieldPaths: [],
      ok: false,
    };

    if (!feedRow) {
      rows.push({ ...itemBase, statusCategory: "SKIPPED_NO_FEED_SAMPLE" });
      return rows;
    }
    if (budgetLeft() <= 0) {
      rows.push({ ...itemBase, statusCategory: "RUN_BUDGET_EXHAUSTED" });
      return rows;
    }

    // Request 2 of 2 — one item from that feed, bounded by bytes rather than by a row limit,
    // because Optimise exposes no product-item endpoint and the feed URL takes no limit parameter.
    try {
      const sample = await adapter.fetchCertificationFeedItemSample(feedRow, { timeoutMs: timeoutFor() });
      const itemRows = asRows(sample?.rows).slice(0, 1);
      const fieldPaths = summarisePayloads(itemRows);
      rows.push({
        ...itemBase,
        ok: true,
        statusCategory: "OK",
        feedFormat: sample?.feedFormat ?? null,
        sampleCount: itemRows.length,
        fieldCount: fieldPaths.length,
        fieldPaths,
        note: "One record parsed from a bounded byte window; the feed was never downloaded in full.",
      });
    } catch (error) {
      const reason = notBoundedReason(error);
      rows.push({
        ...itemBase,
        statusCategory: reason ? "PRODUCT_ITEM_SAMPLE_NOT_BOUNDED" : statusCategory(error),
        ...(reason ? { reason, note: NOT_BOUNDED_NOTES[reason] ?? NOT_BOUNDED_NOTES.UNKNOWN } : {}),
      });
    }

    return rows;
  }

  /**
   * Certifies one network.
   *
   * Probes run in sequence, not in parallel: a burst of concurrent calls against a supplier's API
   * is exactly the kind of traffic that gets an affiliate account rate-limited or flagged.
   */
  async certify(
    network,
    {
      sourceObjects = null,
      region = "sea",
      accountLabel = "default",
      compareRaw = false,
      windowPreset = DEFAULT_WINDOW_PRESET,
    } = {},
  ) {
    const key = String(network || "").toLowerCase();
    const probes = PROBE_REGISTRY[key];
    if (!probes) throw fail(`No certification probe is defined for network "${key}".`, 404);

    const requested = sourceObjects?.length ? sourceObjects : Object.keys(probes);
    const unknown = requested.filter((s) => !probes[s]);
    if (unknown.length) throw fail(`Unknown source objects for ${key}: ${unknown.join(", ")}`, 400);

    const adapter = await this.buildOptimiseAdapter({ region, accountLabel });
    // Dates are computed here, from a preset token. Nothing the caller sends is used as a date.
    const windowDays = windowPresetDays(windowPreset);
    const ctx = {
      window: defaultDateWindow(windowDays),
      // Separate namespaces, separate fields. Neither is ever supplied by the caller.
      campaignDetailId: null,
      commissionGroupCampaignId: null,
    };
    const results = [];
    const runDeadline = Date.now() + RUN_BUDGET_MS;
    const budgetLeft = () => runDeadline - Date.now();

    // Campaign-scoped probes need an id. Take it from a campaigns sample rather than the caller,
    // so the probe cannot be pointed at an arbitrary campaign. This is the one permitted second
    // call in a source chain: sample a campaign, then read that campaign's dependent endpoint.
    if (requested.some((s) => probes[s]?.needs)) {
      try {
        const sample = await adapter.fetchCertificationSample("campaigns", ctx);
        const first = asRows(sample)[0] || {};
        ctx.campaignDetailId = campaignDetailIdOf(first);
        ctx.commissionGroupCampaignId = commissionGroupCampaignIdOf(first);
      } catch {
        ctx.campaignDetailId = null;
        ctx.commissionGroupCampaignId = null;
      }
    }

    for (const sourceObject of requested) {
      const probe = probes[sourceObject];

      if (probe.unsupported) {
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: "UNSUPPORTED",
          note: probe.unsupported,
          sampleCount: 0,
          fieldPaths: [],
        });
        continue;
      }

      if (!READ_ONLY_METHODS.has(probe.method)) {
        // Unreachable with the current registry; it exists so adding a probe with a mutating
        // method fails closed instead of being dispatched.
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: "BLOCKED_NOT_READ_ONLY",
          sampleCount: 0,
          fieldPaths: [],
        });
        continue;
      }

      if (probe.needs && !ctx[probe.needs]) {
        // No dependent supplier call is made: the identifier this endpoint needs is absent from the
        // sampled row, and another namespace's identifier is not a substitute for it.
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: probe.skipCategory ?? "SKIPPED_NO_CAMPAIGN_SAMPLE",
          sampleCount: 0,
          fieldPaths: [],
        });
        continue;
      }

      if (probe.unsupportedForSampling) {
        // The reporting endpoints are POST aggregate queries with no row-limit parameter, so there
        // is no bounded single-row sample to take. Reported rather than run unbounded.
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: "NO_BOUNDED_SAMPLE",
          note: "This endpoint has no row-limit parameter, so certification cannot take a bounded sample without requesting a full aggregate.",
          sampleCount: 0,
          fieldPaths: [],
        });
        continue;
      }

      if (budgetLeft() <= 0) {
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: "RUN_BUDGET_EXHAUSTED",
          note: "The run budget was spent before this source object was reached; probe it in a smaller batch.",
          sampleCount: 0,
          fieldPaths: [],
        });
        continue;
      }

      if (probe.chain === "commissionGroups") {
        results.push(await this.certifyCommissionGroups({ adapter, key, probe, budgetLeft }));
        continue;
      }

      if (probe.emits) {
        // The one dependent chain: at most two requests, the second derived from the first.
        for (const row of await this.certifyProductChain({ adapter, key, probe, compareRaw, budgetLeft })) {
          results.push(row);
        }
        continue;
      }

      try {
        // Exactly one bounded supplier request. Never a sync fetcher.
        const timeoutMs = Math.max(1000, Math.min(SOURCE_BUDGET_MS / 2, budgetLeft()));
        const rows = asRows(
          await adapter.fetchCertificationSample(sourceObject, { ...ctx, timeoutMs }),
        ).slice(0, 1);
        const fieldPaths = summarisePayloads(rows);
        const entry = {
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: true,
          statusCategory: "OK",
          sampleCount: rows.length,
          fieldCount: fieldPaths.length,
          fieldPaths,
        };
        if (compareRaw) {
          const rawPaths = await this.rawPathsFor({ networkSource: key, sourceObject }).catch(() => []);
          entry.rawComparison = comparePathSets(fieldPaths.map((f) => f.path), rawPaths);
        }
        results.push(entry);
      } catch (error) {
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: statusCategory(error),
          sampleCount: 0,
          fieldPaths: [],
        });
      }
    }

    return {
      network: key,
      region,
      accountLabel,
      // The preset token alone describes the lookback. The day count it resolves to is used to
      // compute the dates and stays internal; reporting both would be two names for one state.
      windowPreset: Object.hasOwn(WINDOW_PRESETS, windowPreset) ? windowPreset : DEFAULT_WINDOW_PRESET,
      probedAt: new Date().toISOString(),
      readOnly: true,
      results,
    };
  }
}
