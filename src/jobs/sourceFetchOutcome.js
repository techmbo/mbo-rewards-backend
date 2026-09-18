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

/** A short, safe string. Adapters store an HTTP status or a message; nothing else is copied. */
function safeDetail(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  return String(value).slice(0, 300);
}
