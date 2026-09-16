/**
 * Phase 5 — what one bounded network unit IS.
 *
 * Until now a unit was a whole account: "sync everything Boostiny/default has, 180 days back".
 * That cannot fit a serverless invocation, and production proved it (run c9e3e699, sequence 2,
 * FUNCTION_INVOCATION_TIMEOUT). A unit is now
 *
 *     platform + accountLabel + sourceObject [+ windowStart..windowEnd]
 *
 * This table is an AUDIT RESULT, not a design wish: every source object below is one the account
 * sync already fetches today, under the name the sync layer already filters on
 * (`includeSourceObject` / the adapter resource→identity maps), and `windowed` is true only where
 * the fetch actually takes a supplier date filter that the sync layer now forwards. Nothing here
 * invents an endpoint, a parameter or a KPI.
 *
 * Windows are chosen from ADAPTER PACING, not from throughput ambition: a unit must finish well
 * inside one invocation, so the slower the supplier's rate limiter and the heavier its paging, the
 * shorter the window. Supplier hard caps (Awin 31d, Rakuten events 30d) are never exceeded.
 *
 * A source object that cannot be bounded is marked `executable: false` with a reason and REFUSED
 * by the worker. It is never silently widened back to an unbounded pull.
 */

import { DEFAULT_DAYS_BACK, SYNC_OVERLAP_DAYS } from "./syncConfig.js";

/** A source object planned as its own unit. */
function source({
  sourceObject,
  windowed = false,
  windowDays = null,
  maxWindowDays = null,
  companions = null,
  executable = true,
  blockedReason = null,
  notes = null,
  // Set only where THIS source object's own lookback differs from the platform's (Rakuten
  // advanced reports pull a fixed payment history, not the events window).
  spanDaysBack = null,
  spanIncremental = null,
}) {
  return Object.freeze({
    sourceObject,
    windowed: Boolean(windowed),
    windowDays: windowed ? windowDays : null,
    maxWindowDays: windowed ? (maxWindowDays ?? windowDays) : null,
    companions: companions ? Object.freeze([...companions]) : null,
    executable,
    blockedReason,
    notes,
    spanDaysBack,
    spanIncremental,
  });
}

/** Why a planned unit may not be executed. Explicit, never silent. */
export const UNBOUNDED_FANOUT_REASON = "unbounded_per_campaign_fanout";

/**
 * Per-network span behaviour, read from the sync layer as it stands:
 *   incremental — the range builder narrows to lastSuccessfulSync − overlap when a previous
 *                 successful sync exists (boostiny/optimise/trackier/admitad/rakuten events);
 *                 false means the network always pulls a fixed trailing window.
 *   initialDaysBack — the lookback used when there is no previous successful sync.
 */
const SPAN = Object.freeze({
  boostiny: { incremental: true, initialDaysBack: DEFAULT_DAYS_BACK },
  optimise: { incremental: true, initialDaysBack: DEFAULT_DAYS_BACK },
  trackier: { incremental: true, initialDaysBack: DEFAULT_DAYS_BACK },
  impact: { incremental: false, initialDaysBack: 90 },
  partnerize: { incremental: false, initialDaysBack: 90 },
  awin: { incremental: false, initialDaysBack: 30 },
  admitad: { incremental: true, initialDaysBack: DEFAULT_DAYS_BACK },
  rakuten: { incremental: true, initialDaysBack: 14 },
  cj: { incremental: false, initialDaysBack: 0 },
});

/**
 * The ordered source objects of each network family. Order is the execution order inside an
 * account: catalog objects first (they warm the staged campaign rows that the windowed objects
 * fall back on), then the windowed ones.
 */
const FAMILY_SOURCES = Object.freeze({
  // Limiter 6000ms/request (BOOSTINY_MIN_INTERVAL_MS). Campaign staging also writes canonical
  // commission rules, so it stays one unit with the campaign fetch.
  boostiny: Object.freeze([
    source({ sourceObject: "campaigns", notes: "Paged campaign list; also persists SupplierCommissionRule from payout groups." }),
    source({ sourceObject: "coupons", notes: "Paged coupon list, cache-gated by COUPON_REFRESH_HOURS." }),
    source({ sourceObject: "api_reports", windowed: true, windowDays: 14, notes: "GET performance reports, from/to." }),
    source({ sourceObject: "link_reports", windowed: true, windowDays: 14, notes: "GET link performance, from/to." }),
  ]),
  // Limiter 12500ms/request — the slowest supplier in the estate, so the shortest windows.
  optimise: Object.freeze([
    source({ sourceObject: "campaigns", notes: "GET /campaigns, offset-paginated." }),
    source({ sourceObject: "voucher_codes", notes: "GET /vouchercodes, cache-gated." }),
    source({ sourceObject: "conversions", windowed: true, windowDays: 7, notes: "GET /conversions (fromDate/toDate); the conversionsByPayment variant shares this identity and rides with it." }),
    source({ sourceObject: "reporting", windowed: true, windowDays: 7, notes: "POST /reporting/ (fromDate/toDate); the invoice-date variant shares this identity." }),
    source({ sourceObject: "payment_overview", windowed: true, windowDays: 30, notes: "GET /payments (startDate/endDate), low volume." }),
    source({ sourceObject: "invoices", windowed: true, windowDays: 30, notes: "GET /invoices (startDate/endDate), low volume." }),
    // NOT bounded and deliberately not pretended to be: one GET per applicable campaign, up to
    // OPTIMISE_COMMISSION_GROUPS_MAX_CAMPAIGNS (200) requests at 12.5s each ≈ 2500s. No date
    // filter exists for it. Bounding it needs campaign-chunked units, which is its own change.
    source({
      sourceObject: "commission_groups",
      executable: false,
      blockedReason: UNBOUNDED_FANOUT_REASON,
      notes: "GET /campaigns/{campaignId}/commission-groups — one request per campaign, up to 200, at the 12.5s limiter. Cannot fit one invocation and has no date filter.",
    }),
  ]),
  // Limiters 200ms (campaigns) / 300ms (reports).
  trackier: Object.freeze([
    source({ sourceObject: "campaigns", notes: "GET /v2/publisher/campaigns; profile and categories ride with it as supporting resources." }),
    source({ sourceObject: "coupons", notes: "GET /v2/publishers/coupons; deals share this identity." }),
    source({ sourceObject: "conversions", windowed: true, windowDays: 30, notes: "GET /v2/publishers/conversions (start/end)." }),
    source({ sourceObject: "tracking", windowed: true, windowDays: 30, notes: "GET /v2/publishers/reports (start/end); reports-kpi rides with it." }),
  ]),
  // Limiter 500ms. `reports` is DERIVED from the conversions fetched in the same call, so it can
  // never be its own unit — it travels with actions as a companion.
  impact: Object.freeze([
    source({ sourceObject: "programs", notes: "GET /Catalogs." }),
    source({ sourceObject: "catalogs", notes: "GET /Catalogs/Items." }),
    source({ sourceObject: "actions", windowed: true, windowDays: 30, companions: ["reports"], notes: "GET /Actions (StartDate/EndDate); derived performance is computed from the same rows." }),
  ]),
  // Limiter 750ms. `analytics` is derived from the same call's conversions — companion, not unit.
  partnerize: Object.freeze([
    source({ sourceObject: "campaigns", notes: "GET campaigns; vouchers ride with the campaign ids." }),
    source({ sourceObject: "conversions", windowed: true, windowDays: 30, companions: ["analytics"], notes: "GET conversions (start_date/end_date); derived performance is computed from the same rows." }),
    source({ sourceObject: "payment_information", windowed: true, windowDays: 30, notes: "Finance-gated; the supplier answers 404 for this publisher account and the run records that." }),
  ]),
  // Limiter 3000ms. Supplier caps the transactions range at 31 days.
  awin: Object.freeze([
    source({ sourceObject: "programmes", notes: "GET programmes." }),
    source({ sourceObject: "offers", notes: "GET offers / coupons." }),
    source({ sourceObject: "transactions", windowed: true, windowDays: 30, maxWindowDays: 31, notes: "GET transactions (startDate/endDate); supplier hard cap is 31 days." }),
  ]),
  // No client-side limiter.
  admitad: Object.freeze([
    source({ sourceObject: "programs", notes: "GET /advcampaigns/." }),
    source({ sourceObject: "coupons", notes: "GET /coupons/." }),
    source({ sourceObject: "actions", windowed: true, windowDays: 30, notes: "GET /statistics/actions/ (status_updated_start/status_updated_end)." }),
  ]),
  // No client-side limiter; advanced reports fan out one detail request per payment (capped).
  rakuten: Object.freeze([
    source({ sourceObject: "advertisers", notes: "GET /v2/advertisers." }),
    source({ sourceObject: "partnerships", notes: "GET /v1/partnerships." }),
    source({ sourceObject: "offers", notes: "GET /v1/offers." }),
    source({ sourceObject: "commissioning_lists", notes: "GET /v1/commissioninglists." }),
    source({ sourceObject: "events", windowed: true, windowDays: 14, maxWindowDays: 30, notes: "GET /events/1.0/transactions (process_date_start/end); supplier keeps ~30 days." }),
    source({
      sourceObject: "advanced_reports",
      windowed: true,
      windowDays: 30,
      // Payment history is a fixed 180-day pull in the adapter and never narrows to
      // lastSuccessfulSync, unlike events. Planning it on the events span would silently shorten
      // the history this source has always fetched.
      spanDaysBack: DEFAULT_DAYS_BACK,
      spanIncremental: false,
      notes: "GET /advancedreports/1.0 (bdate/edate), finance-gated, plus a capped per-payment detail fan-out.",
    }),
  ]),
  // Catalog lookups only. NOTHING in the live CJ path takes a date filter, so CJ has no windowed
  // source object — stated, not assumed.
  cj: Object.freeze([
    source({ sourceObject: "advertisers", notes: "Advertiser Lookup; no date filter exists in this integration." }),
    source({ sourceObject: "links", notes: "Link Search; no date filter." }),
    source({ sourceObject: "coupons", notes: "Link Search filtered to coupons; no date filter." }),
  ]),
});

/** optimise_sea / optimise_mena / optimise_uk share one adapter and one plan. */
export function planFamily(platform) {
  const key = String(platform || "").toLowerCase();
  return key.startsWith("optimise") ? "optimise" : key;
}

/** The audited source objects of a platform, in execution order (empty when unknown). */
export function planSourcesFor(platform) {
  return FAMILY_SOURCES[planFamily(platform)] ?? [];
}

/** The platform's span behaviour, or null when the platform is not in the audit. */
export function planSpanFor(platform) {
  return SPAN[planFamily(platform)] ?? null;
}

export function isoDay(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDiff(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00.000Z`);
  const to = Date.parse(`${toIso}T00:00:00.000Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * The span one source object has to cover, as the sync layer itself would have computed it:
 * lastSuccessfulSync minus the standard overlap when the network syncs incrementally and a
 * previous run exists, otherwise the network's own initial lookback. Inclusive ISO days.
 */
export function resolvePlanSpan({ platform, lastSuccessfulSync = null, now = new Date(), overlapDays = SYNC_OVERLAP_DAYS, source = null } = {}) {
  const span = planSpanFor(platform);
  const to = isoDay(now) ?? isoDay(new Date());
  const daysBack = source?.spanDaysBack ?? span?.initialDaysBack;
  const incremental = source?.spanIncremental ?? span?.incremental;
  const initial = Math.max(1, Number(daysBack) || DEFAULT_DAYS_BACK);
  const previous = incremental ? isoDay(lastSuccessfulSync) : null;
  if (previous) {
    const from = addDays(previous, -Math.max(0, Number(overlapDays) || 0));
    // A clock skew or a future timestamp must never produce an inverted span.
    return { from: from > to ? to : from, to };
  }
  return { from: addDays(to, -initial), to };
}

/**
 * Chop an inclusive day span into chronological windows of at most `windowDays` days.
 * Contiguous by construction: each window starts the day after the previous one ends, the first
 * starts at `from` and the last ends at `to` — no overlap, no gap, no invented day.
 */
export function buildDateWindows({ from, to, windowDays }) {
  const start = isoDay(from);
  const end = isoDay(to);
  if (!start || !end || start > end) return [];
  const size = Math.max(1, Math.floor(Number(windowDays) || 1));
  const windows = [];
  let cursor = start;
  while (cursor <= end) {
    const last = addDays(cursor, size - 1);
    const windowEnd = last > end ? end : last;
    windows.push({ windowStart: cursor, windowEnd });
    cursor = addDays(windowEnd, 1);
  }
  return windows;
}

/**
 * The bounded units of ONE account, in deterministic order:
 *   source-object order (the audited list) → chronological windows inside each windowed object.
 * Unwindowed objects produce exactly one unit and carry no window at all, so nothing pretends a
 * catalog pull is time-filtered.
 *
 * A source object the audit could not bound produces NO unit. It is returned as an EXCLUSION
 * instead — recorded on the run and shown in status — because planning it as a normal unit would
 * either hand a worker an invocation it cannot finish or leave the run permanently unfinished.
 * Excluded is not the same as forgotten, and it is never widened back into an unbounded pull.
 */
export function planAccountUnits({
  platform,
  accountLabel,
  lastSuccessfulSync = null,
  now = new Date(),
  networkOptions = {},
  overlapDays = SYNC_OVERLAP_DAYS,
} = {}) {
  const sources = planSourcesFor(platform);
  if (!sources.length) return { units: [], exclusions: [] };
  const units = [];
  const exclusions = [];
  for (const source of sources) {
    if (source.executable === false) {
      exclusions.push({
        platform,
        accountLabel,
        sourceObject: source.sourceObject,
        reason: source.blockedReason ?? UNBOUNDED_FANOUT_REASON,
        notes: source.notes ?? null,
      });
      continue;
    }
    const span = resolvePlanSpan({ platform, lastSuccessfulSync, now, overlapDays, source });
    const base = {
      platform,
      accountLabel,
      sourceObject: source.sourceObject,
      options: { ...networkOptions },
      ...(source.companions ? { sourceObjectCompanions: [...source.companions] } : {}),
    };
    if (!source.windowed) {
      units.push(base);
      continue;
    }
    const size = Math.min(source.windowDays, source.maxWindowDays ?? source.windowDays);
    for (const window of buildDateWindows({ from: span.from, to: span.to, windowDays: size })) {
      units.push({ ...base, windowStart: window.windowStart, windowEnd: window.windowEnd });
    }
  }
  return { units, exclusions };
}

/** Diagnostics for the audit report and the tests: how big a plan is, without building it. */
export function describePlanSources(platform) {
  return planSourcesFor(platform).map((source) => ({ ...source }));
}

export { dayDiff as planDayDiff, addDays as planAddDays };
