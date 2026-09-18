/**
 * Phase 9A.0a-iii — the vocabulary a pager uses to say WHY it stopped.
 *
 * This lives in core rather than beside the run helpers because the adapters are the only things
 * that can answer the question, and no adapter in this codebase imports from jobs/. The helpers
 * that turn a record into a run outcome are in jobs/sourceFetchOutcome.js, which re-exports
 * everything here so a reader has one place to look.
 *
 * The distinction the whole phase turns on: did the SUPPLIER say there was no more, or did we
 * infer it? A short or empty page is usually the end of the catalog and occasionally is not, and
 * it fails in the one direction that matters — a short page mid-walk ends the read early and looks
 * complete. So a heuristic is recorded as a heuristic, and never as supplier-confirmed.
 */

export const EXHAUSTION = Object.freeze({
  SUPPLIER_HAS_NEXT_FALSE: "supplier_has_next_false",
  SUPPLIER_TOTAL_REACHED: "supplier_total_reached",
  SUPPLIER_NEXT_TOKEN_ABSENT: "supplier_next_token_absent",
  SHORT_PAGE: "short_page",
  EMPTY_PAGE: "empty_page",
  PAGE_CAP: "page_cap",
  UNKNOWN: "unknown",
});

/** Only these three are the supplier positively asserting the end of the catalog. */
const SUPPLIER_ASSERTED = new Set([
  EXHAUSTION.SUPPLIER_HAS_NEXT_FALSE,
  EXHAUSTION.SUPPLIER_TOTAL_REACHED,
  EXHAUSTION.SUPPLIER_NEXT_TOKEN_ABSENT,
]);

/** The key every pager writes its exhaustion record to on the stats object it already receives. */
export const EXHAUSTION_STATS_KEY = "paginationExhaustion";

/**
 * Called by a pager as it breaks, naming the branch it took. Overwrites rather than accumulates:
 * the snapshot comparison in withSourceOutcome is what keeps one source object's record from being
 * read as the next one's.
 *
 * A null bag is a no-op, so every caller that does not want evidence is unchanged.
 */
export function recordExhaustion(stats, reason, extra = {}) {
  if (!stats) return;
  stats[EXHAUSTION_STATS_KEY] = {
    reason,
    // PAGE_CAP is our own limit, not the end of the catalog. UNKNOWN is a defensive stop with no
    // evidence either way. Neither may claim the walk reached the end.
    exhausted: reason !== EXHAUSTION.PAGE_CAP && reason !== EXHAUSTION.UNKNOWN,
    supplierAsserted: SUPPLIER_ASSERTED.has(reason),
    ...extra,
  };
}
