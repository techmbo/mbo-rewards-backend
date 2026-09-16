/**
 * Phase 5 — what one bounded Optimise unit is allowed to do.
 *
 * A bounded unit names exactly one source object. The fetch layer already refuses to call the
 * supplier for anything else; these helpers give the persistence, promotion and enrichment steps
 * the same answer from the same table, so a unit can never skip a fetch and still write, promote
 * or enrich that resource. Keeping the decision in pure functions also makes the timestamp
 * semantics testable without a supplier or a database.
 */

import { includeOptimiseResource } from "./sourceObjectRuns.js";

/** The Optimise resources syncOptimiseRegion fetches and persists, in fetch order. */
export const OPTIMISE_WORK_RESOURCES = Object.freeze([
  "campaigns",
  "conversions",
  "conversionsByPayment",
  "reporting",
  "invoiceReporting",
  "payments",
  "invoices",
  "voucherCodes",
]);

/**
 * Resolve which resources this invocation may work on.
 *
 * `refreshCampaigns`/`refreshCoupons` stay the pure cache-TTL decision so the fetch layer still
 * records the honest "cache" vs "source_object_filter" skip reason; the `persist*` flags are the
 * conjunction the write sites use.
 */
export function optimiseWorkScope(requested, { refreshCampaigns = true, refreshCoupons = true } = {}) {
  const scope = { requested: requested ?? null };
  for (const resource of OPTIMISE_WORK_RESOURCES) {
    scope[resource] = includeOptimiseResource(requested ?? null, resource);
  }
  scope.persistCampaigns = scope.campaigns && Boolean(refreshCampaigns);
  scope.persistVouchers = scope.voucherCodes && Boolean(refreshCoupons);
  // Promotion and MBO-click enrichment turn performance rows into facts; the click enrichment
  // scans every fact of the account, so it must not run for a unit that fetched no performance.
  scope.touchedPerformance = scope.reporting || scope.invoiceReporting;
  scope.touchedConversions = scope.conversions || scope.conversionsByPayment;
  return scope;
}

/**
 * lastCampaignSyncAt means "the whole catalog was walked" — the TTL gate and Network Health both
 * read it that way. A bounded slice covers part of the catalog, so it stamps only on the slice
 * whose pagination reports no further pages. A failed fetch never stamps.
 */
export function optimiseCampaignCatalogWalked({
  persistCampaigns,
  campaignsFailed = false,
  campaignPage = null,
  campaignPagination = null,
} = {}) {
  if (!persistCampaigns || campaignsFailed) return false;
  if (!campaignPage) return true;
  return campaignPagination != null && campaignPagination.hasMore === false;
}

/**
 * lastSuccessfulSync is the incremental watermark for the conversions, reporting and payments
 * windows. A unit that fetched one source object has not covered that window for the others, so
 * moving the watermark would silently shrink a later window. Only a whole-account run advances
 * it: re-reading an overlapping window is safe, skipping one is not.
 */
export function optimiseAdvanceWatermark({ requested = null, warningCount = 0 } = {}) {
  return !requested && warningCount === 0;
}
