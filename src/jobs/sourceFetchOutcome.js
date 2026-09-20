/**
 * Phase 9A.0a-i — turning an adapter's side-channel evidence into a truthful run outcome.
 *
 * `resolveTerminalStatus` answers SUCCESS for any execute() that returns without throwing, and
 * PARTIAL only when the result carries `partial` or a quarantined row. Several adapters already
 * KNOW they failed or truncated — Impact's /Catalogs catch, Partnerize's campaign catch, Rakuten's
 * page-cap exit — and record it on the `stats` object they are handed. Nothing ever read it back,
 * so a 403 and a healthy empty catalog produced the same SUCCESS.
 *
 * These helpers close that gap at the execute() boundary rather than by changing adapter return
 * types. fetchCampaigns and fetchProducts are shared contract methods (see adapters/contract.js)
 * that the certification service also calls, so widening their return shape would ripple far past
 * the four cases this phase is allowed to touch.
 *
 * The signal is read by SNAPSHOT: a key's value is captured before the call and compared after, so
 * one source object can never inherit a flag another one left on the shared per-account stats.
 */
import { EXHAUSTION, EXHAUSTION_STATS_KEY, TRUNCATION_REASONS } from "../core/paginationExhaustion.js";


/**
 * Wrap one adapter call, reporting PARTIAL only when `statsKey` changed during THIS call.
 *
 * An empty result is NOT partial by itself: a catalog with no rows is a legitimate SUCCESS, and
 * `recordsFetched: 0` must keep meaning "zero rows", not "something went wrong".
 */
export async function withFetchFailureSignal(stats, statsKey, fetch, { errorCode, endpoint = null } = {}) {
  const before = stats ? stats[statsKey] : undefined;
  const rows = await fetch();
  const after = stats ? stats[statsKey] : undefined;
  if (after === undefined || after === before) return rows;
  return {
    rows: Array.isArray(rows) ? rows : [],
    partial: true,
    metadata: {
      fetchFailed: true,
      errorCode,
      // The adapters store an HTTP status or a message here. Neither is a credential, a request
      // body or a response body, and nothing else from the error is copied.
      detail: safeDetail(after),
      ...(endpoint ? { endpoint } : {}),
    },
  };
}

/**
 * A state that is neither a failure nor a defect: the account is not configured for this object.
 *
 * Reported as a healthy SUCCESS carrying metadata, NOT as PARTIAL. Treating a configuration state
 * as an operational failure would train operators to ignore PARTIAL, which is the signal this
 * phase exists to make meaningful.
 */
export function unavailableOutcome(rows, { reason, code, endpoint = null }) {
  return {
    rows: Array.isArray(rows) ? rows : [],
    metadata: {
      unavailable: true,
      unavailableCode: code,
      reason: safeDetail(reason),
      ...(endpoint ? { endpoint } : {}),
    },
  };
}

/** Pagination completeness evidence for one slice of a walk. Never partial: slicing is expected. */
export function pagedOutcome(rows, pagination = {}) {
  return {
    rows: Array.isArray(rows) ? rows : [],
    metadata: {
      pagination: {
        hasMore: pagination.hasMore === true,
        terminalPage: pagination.hasMore !== true,
        pagesFetched: Number.isFinite(pagination.pagesFetched) ? pagination.pagesFetched : null,
        nextOffset: Number.isFinite(pagination.nextOffset) ? pagination.nextOffset : null,
      },
    },
  };
}

/* ------------------------------------------------------------------ exhaustion evidence ----- */

// The vocabulary itself lives in core, because the adapters that record it cannot import from
// jobs/. Re-exported here so the record and the helper that reads it stay one import apart.
export {
  EXHAUSTION,
  EXHAUSTION_STATS_KEY,
  TRUNCATION_REASONS,
  recordExhaustion,
} from "../core/paginationExhaustion.js";

/**
 * One adapter call, reported truthfully: hard failure, cap truncation, or healthy with evidence.
 *
 * Supersedes withFetchFailureSignal for sources that also carry exhaustion evidence; the older
 * helper stays for the 9A.0a-i call sites that only need the failure half.
 *
 * Precedence is deliberate. A swallowed hard failure outranks any exhaustion record, because a
 * pager that died mid-walk may still have written one. A TRUNCATION_REASONS exhaustion — our own
 * page cap, or a page the supplier re-delivered — is itself a truncation and reports PARTIAL.
 * Every other reason is healthy: a heuristic stop is still a complete-looking read, and
 * downgrading it would flood PARTIAL with runs that are probably fine.
 */
export async function withSourceOutcome(
  stats,
  fetch,
  {
    failureKeys = [],
    errorCode,
    truncationCode = null,
    /**
     * The code a REPEATED_PAGE truncation carries. Separate from truncationCode because the two
     * say different things: a cap means we stopped asking, a repeat means the supplier stopped
     * listening. Falls back to truncationCode, so a pager that never records REPEATED_PAGE needs
     * no change at all.
     */
    repeatedPageCode = null,
    endpoint = null,
  } = {},
) {
  const failureBefore = new Map(failureKeys.map((key) => [key, stats ? stats[key] : undefined]));
  const exhaustionBefore = stats ? stats[EXHAUSTION_STATS_KEY] : undefined;

  const fetched = await fetch();

  for (const key of failureKeys) {
    const after = stats ? stats[key] : undefined;
    if (after !== undefined && after !== failureBefore.get(key)) {
      const base = asOutcome(fetched);
      return {
        rows: base.rows,
        partial: true,
        metadata: {
          ...base.metadata,
          fetchFailed: true,
          errorCode,
          detail: safeDetail(after),
          ...(endpoint ? { endpoint } : {}),
        },
      };
    }
  }

  const record = stats ? stats[EXHAUSTION_STATS_KEY] : undefined;
  // Identity, not truthiness: a record left by the PREVIOUS source object on a shared stats bag is
  // the same object reference, so it is not this call's evidence and must not be reported as it.
  if (!record || record === exhaustionBefore) return fetched;

  const pagination = {
    exhausted: record.exhausted === true,
    exhaustionReason: record.reason ?? EXHAUSTION.UNKNOWN,
    supplierAssertedExhaustion: record.supplierAsserted === true,
    ...(Number.isFinite(record.pagesFetched) ? { pagesFetched: record.pagesFetched } : {}),
  };
  const base = asOutcome(fetched);
  if (TRUNCATION_REASONS.has(record.reason)) {
    return {
      rows: base.rows,
      partial: true,
      metadata: {
        ...base.metadata,
        fetchFailed: false,
        truncated: true,
        // A truncation is a DIFFERENT defect from a swallowed error, so it carries its own code:
        // "we stopped asking", or "the supplier stopped honouring `page`", must never be read back
        // as "the supplier refused us". The two truncations are told apart as well, because the
        // operator response to them is not the same.
        errorCode:
          record.reason === EXHAUSTION.REPEATED_PAGE
            ? (repeatedPageCode ?? truncationCode ?? errorCode)
            : (truncationCode ?? errorCode),
        pagination,
        ...(endpoint ? { endpoint } : {}),
      },
    };
  }
  return {
    rows: base.rows,
    ...(base.partial ? { partial: true } : {}),
    metadata: { ...base.metadata, pagination, ...(endpoint ? { endpoint } : {}) },
  };
}

/**
 * Read a fetch() return value as an outcome without losing what it already carried.
 *
 * execute() may legitimately answer a bare array OR an outcome object a nested helper already
 * built — Optimise's sliced walk returns pagedOutcome(). Flattening that to `rows` would discard
 * the slice evidence 9A.0a-i added, so the existing metadata is merged rather than replaced.
 */
function asOutcome(value) {
  if (Array.isArray(value)) return { rows: value, partial: false, metadata: {} };
  if (value && typeof value === "object" && Array.isArray(value.rows)) {
    return {
      rows: value.rows,
      partial: value.partial === true,
      metadata: value.metadata && typeof value.metadata === "object" ? value.metadata : {},
    };
  }
  return { rows: [], partial: false, metadata: {} };
}

/** A short, safe string. Adapters store an HTTP status or a message; nothing else is copied. */
function safeDetail(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  return String(value).slice(0, 300);
}
