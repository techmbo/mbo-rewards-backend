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

/** Certification never makes more than this many supplier requests for one source object. */
export const MAX_SUPPLIER_REQUESTS_PER_SOURCE = 1;

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
  products: { method: "GET", endpointKey: "GET /product-feeds/" },
  reporting: { method: "POST_READONLY", endpointKey: "POST /reporting/", unsupportedForSampling: true },
  invoiceReporting: { method: "POST_READONLY", endpointKey: "POST /reporting/ (invoiceDate)", unsupportedForSampling: true },
  commission_groups: {
    method: "GET",
    endpointKey: "GET /campaigns/{campaignId}/commission-groups",
    needs: "campaignId",
  },
  campaign_detail: { method: "GET", endpointKey: "GET /campaigns/{campaignId}", needs: "campaignId" },
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

function defaultDateWindow(days = 7) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { startDate: iso(from), endDate: iso(to), dateFrom: iso(from), dateTo: iso(to) };
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
   * Certifies one network.
   *
   * Probes run in sequence, not in parallel: a burst of concurrent calls against a supplier's API
   * is exactly the kind of traffic that gets an affiliate account rate-limited or flagged.
   */
  async certify(network, { sourceObjects = null, region = "sea", accountLabel = "default", compareRaw = false } = {}) {
    const key = String(network || "").toLowerCase();
    const probes = PROBE_REGISTRY[key];
    if (!probes) throw fail(`No certification probe is defined for network "${key}".`, 404);

    const requested = sourceObjects?.length ? sourceObjects : Object.keys(probes);
    const unknown = requested.filter((s) => !probes[s]);
    if (unknown.length) throw fail(`Unknown source objects for ${key}: ${unknown.join(", ")}`, 400);

    const adapter = await this.buildOptimiseAdapter({ region, accountLabel });
    const ctx = { dateWindow: defaultDateWindow(), campaignId: null };
    const results = [];
    const runDeadline = Date.now() + RUN_BUDGET_MS;
    const budgetLeft = () => runDeadline - Date.now();

    // Campaign-scoped probes need an id. Take it from a campaigns sample rather than the caller,
    // so the probe cannot be pointed at an arbitrary campaign. This is the one permitted second
    // call in a source chain: sample a campaign, then read that campaign's dependent endpoint.
    if (requested.some((s) => probes[s]?.needs === "campaignId")) {
      try {
        const sample = await adapter.fetchCertificationSample("campaigns", ctx);
        const first = asRows(sample)[0] || {};
        ctx.campaignId = first.id ?? first.campaignId ?? first.campaign_id ?? null;
      } catch {
        ctx.campaignId = null;
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

      if (probe.needs === "campaignId" && !ctx.campaignId) {
        results.push({
          network: key,
          sourceObject,
          endpointKey: probe.endpointKey,
          httpMethod: probe.method,
          ok: false,
          statusCategory: "SKIPPED_NO_CAMPAIGN_SAMPLE",
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
      probedAt: new Date().toISOString(),
      readOnly: true,
      results,
    };
  }
}
