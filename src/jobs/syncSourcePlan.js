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
  // A catalog whose size is only known by walking the supplier's paging. The plan emits the FIRST
  // slice (offset 0, which is always knowable) and each completed slice plans the next while the
  // supplier says there is more.
  paged = false,
  pagesPerUnit = null,
  pageLimit = null,
  // A source object whose unit scope is only knowable after another source object of the same
  // account has run. It is not planned at enqueue time and is NOT an exclusion: the named unit's
  // completion materialises it.
  materialisedAfter = null,
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
    materialisedAfter,
    paged: Boolean(paged),
    pagesPerUnit: paged ? pagesPerUnit : null,
    pageLimit: paged ? pageLimit : null,
  });
}

/** Why a planned unit may not be executed. Explicit, never silent. */
export const UNBOUNDED_FANOUT_REASON = "unbounded_per_campaign_fanout";

/**
 * Supplier pages per bounded Optimise campaigns unit, and the rows per page.
 *
 * Optimise holds requests OPTIMISE_MIN_INTERVAL_MS (12.5s) apart and that pacing MULTIPLIES across
 * pagination: N pages cost at least (N-1) x 12.5s of waiting before any response time or staging.
 * A 300s invocation therefore affords ~24 requests in total, which is why the whole-catalog walk
 * timed out. Eight pages is ~87.5s of pacing — roughly a third of the budget — leaving ample room
 * for response time, row staging and a slow page. 100 rows per page is the adapter's own default.
 */
export const OPTIMISE_CAMPAIGN_PAGES_PER_UNIT = 8;
export const OPTIMISE_CAMPAIGN_PAGE_LIMIT = 100;

/**
 * Awin offers: ONE supplier page per unit, 200 offers wide.
 *
 * Optimise takes 8 pages per unit because its cost is the 12.5s limiter and its pages are small.
 * Awin's cost is the opposite — the fetch is cheap and STAGING is what exhausts the invocation, at
 * roughly 11s per 200 coupons measured in the database's own region. One page per unit keeps a
 * slice near that proven figure instead of extrapolating past it.
 *
 * The width is the adapter's page size, restated here rather than imported: syncSourcePlan is
 * planning vocabulary and must not pull an HTTP adapter into every planner import. A test pins
 * the two together so they cannot drift.
 */
export const AWIN_OFFERS_PAGES_PER_UNIT = 1;
export const AWIN_OFFERS_PAGE_LIMIT = 200;

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
    source({
      sourceObject: "campaigns",
      paged: true,
      pagesPerUnit: OPTIMISE_CAMPAIGN_PAGES_PER_UNIT,
      pageLimit: OPTIMISE_CAMPAIGN_PAGE_LIMIT,
      notes: "GET /campaigns, offset-paginated. Every page waits on the 12.5s limiter, so the walk is split into bounded slices of the supplier's own paging.",
    }),
    source({ sourceObject: "voucher_codes", notes: "GET /vouchercodes, cache-gated." }),
    source({ sourceObject: "conversions", windowed: true, windowDays: 7, notes: "GET /conversions (fromDate/toDate); the conversionsByPayment variant shares this identity and rides with it." }),
    source({ sourceObject: "reporting", windowed: true, windowDays: 7, notes: "POST /reporting/ (fromDate/toDate); the invoice-date variant shares this identity." }),
    source({ sourceObject: "payment_overview", windowed: true, windowDays: 30, notes: "GET /payments (startDate/endDate), low volume." }),
    source({ sourceObject: "invoices", windowed: true, windowDays: 30, notes: "GET /invoices (startDate/endDate), low volume." }),
    // Bounded by CAMPAIGN SUBSET, not by date: one GET per applicable campaign at the 12.5s
    // limiter. The campaign slice is only knowable once this account's campaigns unit has staged
    // its rows, so the chunks are materialised then rather than at enqueue time — see
    // `materialisedAfter`. They are never excluded: these rules feed SupplierCommissionRule.
    source({
      sourceObject: "commission_groups",
      materialisedAfter: "campaigns",
      notes: "GET /campaigns/{campaignId}/commission-groups — one request per campaign. Planned as fixed-size campaign chunks once the campaigns unit has staged the campaign list.",
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
    source({
      sourceObject: "offers",
      paged: true,
      // One supplier page per unit. 5,000 offers stage at roughly 11s per 200 rows in the
      // database's own region, so a whole catalogue is ~247s of staging on top of ~96s of
      // fetching — past a 300s invocation before any safety margin. One page in, one page
      // staged, checkpoint, return.
      pagesPerUnit: AWIN_OFFERS_PAGES_PER_UNIT,
      pageLimit: AWIN_OFFERS_PAGE_LIMIT,
      notes: "POST /publisher/{publisherId}/promotions, page-paginated. One page per unit: the catalogue is too large to fetch and stage inside one invocation.",
    }),
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
  if (!sources.length) return { units: [], exclusions: [], deferred: [] };
  const units = [];
  const exclusions = [];
  const deferred = [];
  for (const source of sources) {
    if (source.materialisedAfter) {
      // Planned later, by the completion of the unit it depends on. Deliberately not a unit here
      // and deliberately not an exclusion: nothing about it is dropped.
      deferred.push({
        platform,
        accountLabel,
        sourceObject: source.sourceObject,
        after: source.materialisedAfter,
      });
      continue;
    }
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
    if (source.paged) {
      // Only the first slice is knowable now; completing it plans the next while more remains.
      units.push({
        ...base,
        campaignPageIndex: 0,
        campaignPageOffset: 0,
        campaignPageLimit: source.pageLimit,
        campaignPageBudget: source.pagesPerUnit,
      });
      continue;
    }
    if (!source.windowed) {
      units.push(base);
      continue;
    }
    const size = Math.min(source.windowDays, source.maxWindowDays ?? source.windowDays);
    for (const window of buildDateWindows({ from: span.from, to: span.to, windowDays: size })) {
      units.push({ ...base, windowStart: window.windowStart, windowEnd: window.windowEnd });
    }
  }
  return { units, exclusions, deferred };
}

/**
 * Source objects of a platform that are materialised once `sourceObject` completes for the same
 * account. Empty for every platform with no deferred source.
 */
export function sourcesMaterialisedAfter(platform, sourceObject) {
  const key = String(sourceObject || "").toLowerCase();
  return planSourcesFor(platform)
    .filter((source) => source.materialisedAfter === key)
    .map((source) => source.sourceObject);
}

/**
 * The next slice of a paged source, from the slice that just ran and what the supplier said about
 * having more. Returns null when the supplier reported the last page — which is what makes the
 * chain finite and a zero-row account a single unit.
 */
/**
 * The units for ONE source object of ONE account, for a narrowly scoped durable run.
 *
 * Built from planAccountUnits and then filtered, rather than from a second planning rule: a
 * scoped run must produce byte-identical descriptors to the ones the estate plan would have
 * produced for the same source, or it is certifying something other than what production runs.
 *
 * Returns [] when the source object is unknown to the platform, excluded by the audit, or
 * deferred until another source completes — all three are "there is no unit to plan", and none of
 * them may be papered over with an ad-hoc unit.
 */
export function planScopedSourceUnits({
  platform,
  accountLabel = "default",
  sourceObject,
  lastSuccessfulSync = null,
  now = new Date(),
  networkOptions = {},
} = {}) {
  const key = String(sourceObject ?? "").trim().toLowerCase();
  if (!platform || !key) return [];
  const planned = planAccountUnits({
    platform,
    accountLabel,
    lastSuccessfulSync,
    now,
    networkOptions: { ...networkOptions, promoteAfter: false },
  });
  return planned.units.filter(
    (unit) => String(unit.sourceObject ?? "").toLowerCase() === key,
  );
}

export function nextPagedUnit(descriptor = {}, pagination = null) {
  if (!pagination?.hasMore) return null;
  const nextOffset = Number(pagination.nextOffset);
  if (!Number.isFinite(nextOffset) || nextOffset <= Number(descriptor.campaignPageOffset ?? -1)) return null;
  const source = planSourcesFor(descriptor.platform).find((item) => item.sourceObject === descriptor.sourceObject);
  if (!source?.paged) return null;
  return {
    campaignPageIndex: Number(descriptor.campaignPageIndex ?? 0) + 1,
    campaignPageOffset: nextOffset,
    campaignPageLimit: descriptor.campaignPageLimit ?? source.pageLimit,
    campaignPageBudget: descriptor.campaignPageBudget ?? source.pagesPerUnit,
    // Opaque slice state the SOURCE asked to carry forward, durable in the unit descriptor.
    // Awin uses it for the page identities already accepted: a walk keeps those in a local Set,
    // and a walk split across invocations has no local anything, so without carrying them a
    // re-delivered page could not be recognised after the first slice. Never part of a unit's
    // identity — two attempts at the same offset are the same work whatever they carry.
    ...(pagination.carry === undefined || pagination.carry === null
      ? {}
      : { campaignPageCarry: pagination.carry }),
  };
}

/** Diagnostics for the audit report and the tests: how big a plan is, without building it. */
export function describePlanSources(platform) {
  return planSourcesFor(platform).map((source) => ({ ...source }));
}

export { dayDiff as planDayDiff, addDays as planAddDays };
