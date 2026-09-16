import test from "node:test";
import assert from "node:assert/strict";

import {
  OPTIMISE_WORK_RESOURCES,
  optimiseAdvanceWatermark,
  optimiseCampaignCatalogWalked,
  optimiseWorkScope,
} from "../src/jobs/optimiseWorkScope.js";
import {
  OPTIMISE_RESOURCE_IDENTITY,
  includeOptimiseResource,
} from "../src/jobs/sourceObjectRuns.js";

const ALL_ON = { refreshCampaigns: true, refreshCoupons: true };

// ---------------------------------------------------------------------------
// The predicate itself: one table, one answer, for fetching and for writing.
// ---------------------------------------------------------------------------

test("every Optimise resource the sync job works on has a source-object identity", () => {
  for (const resource of OPTIMISE_WORK_RESOURCES) {
    assert.ok(
      OPTIMISE_RESOURCE_IDENTITY[resource],
      `${resource} must map to a source object so fetch and write agree`,
    );
  }
});

test("an unrequested source object leaves every resource in scope", () => {
  const scope = optimiseWorkScope(null, ALL_ON);
  for (const resource of OPTIMISE_WORK_RESOURCES) {
    assert.equal(scope[resource], true, `${resource} must stay in scope for a whole-account run`);
  }
});

test("a requested source object keeps exactly the resources that map to it", () => {
  for (const resource of OPTIMISE_WORK_RESOURCES) {
    const requested = OPTIMISE_RESOURCE_IDENTITY[resource].sourceObject;
    const scope = optimiseWorkScope(requested, ALL_ON);
    for (const other of OPTIMISE_WORK_RESOURCES) {
      const shouldBeInScope =
        OPTIMISE_RESOURCE_IDENTITY[other].sourceObject === requested;
      assert.equal(
        scope[other],
        shouldBeInScope,
        `requesting ${requested} must ${shouldBeInScope ? "keep" : "drop"} ${other}`,
      );
    }
  }
});

test("optimiseWorkScope answers exactly what the fetch layer's predicate answers", () => {
  const requests = [null, "campaigns", "conversions", "reporting", "payments", "voucher_codes", "commission_groups"];
  for (const requested of requests) {
    const scope = optimiseWorkScope(requested, ALL_ON);
    for (const resource of OPTIMISE_WORK_RESOURCES) {
      assert.equal(
        scope[resource],
        includeOptimiseResource(requested, resource),
        `${resource} must not disagree with the fetch layer for ${requested}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// A campaigns unit does campaigns work and nothing else.
// ---------------------------------------------------------------------------

test("a campaigns unit performs no reporting, conversion, payment or voucher work", () => {
  const scope = optimiseWorkScope("campaigns", ALL_ON);

  assert.equal(scope.campaigns, true);
  assert.equal(scope.persistCampaigns, true);

  assert.equal(scope.reporting, false);
  assert.equal(scope.invoiceReporting, false);
  assert.equal(scope.conversions, false);
  assert.equal(scope.conversionsByPayment, false);
  assert.equal(scope.payments, false);
  assert.equal(scope.invoices, false);
  assert.equal(scope.voucherCodes, false);
  assert.equal(scope.persistVouchers, false);

  // The two account-wide passes: fact promotion + MBO click enrichment, and coupon enrichment.
  assert.equal(scope.touchedPerformance, false);
  assert.equal(scope.touchedConversions, false);
});

test("a conversions unit performs no campaign, performance, payment or voucher work", () => {
  const scope = optimiseWorkScope("conversions", ALL_ON);
  assert.equal(scope.conversions, true);
  assert.equal(scope.touchedConversions, true);

  assert.equal(scope.campaigns, false);
  assert.equal(scope.persistCampaigns, false);
  assert.equal(scope.reporting, false);
  assert.equal(scope.invoiceReporting, false);
  assert.equal(scope.touchedPerformance, false);
  assert.equal(scope.payments, false);
  assert.equal(scope.invoices, false);
  assert.equal(scope.persistVouchers, false);
});

test("a reporting unit is the only one that runs fact promotion and click enrichment", () => {
  assert.equal(optimiseWorkScope("reporting", ALL_ON).touchedPerformance, true);
  assert.equal(optimiseWorkScope(null, ALL_ON).touchedPerformance, true);
  for (const requested of ["campaigns", "conversions", "payments", "voucher_codes", "commission_groups"]) {
    assert.equal(
      optimiseWorkScope(requested, ALL_ON).touchedPerformance,
      false,
      `${requested} must not trigger the account-wide fact passes`,
    );
  }
});

/**
 * `touchedPerformance` and `touchedConversions` are ORs over resource pairs that today share one
 * source object, so an AND would behave identically. The OR is the rule that survives the pairs
 * being split, and this test records the coupling that makes the two forms equivalent right now.
 */
test("the paired resources that share a source object are pinned", () => {
  assert.equal(
    OPTIMISE_RESOURCE_IDENTITY.reporting.sourceObject,
    OPTIMISE_RESOURCE_IDENTITY.invoiceReporting.sourceObject,
  );
  assert.equal(
    OPTIMISE_RESOURCE_IDENTITY.conversions.sourceObject,
    OPTIMISE_RESOURCE_IDENTITY.conversionsByPayment.sourceObject,
  );
  for (const requested of [null, "reporting", "conversions"]) {
    const scope = optimiseWorkScope(requested, ALL_ON);
    assert.equal(scope.touchedPerformance, scope.reporting || scope.invoiceReporting);
    assert.equal(scope.touchedConversions, scope.conversions || scope.conversionsByPayment);
  }
});

test("a commission_groups unit persists no other Optimise resource", () => {
  const scope = optimiseWorkScope("commission_groups", ALL_ON);
  for (const resource of OPTIMISE_WORK_RESOURCES) {
    assert.equal(scope[resource], false, `${resource} must stay out of a commission-group unit`);
  }
  assert.equal(scope.persistCampaigns, false);
  assert.equal(scope.persistVouchers, false);
  assert.equal(scope.touchedPerformance, false);
  assert.equal(scope.touchedConversions, false);
});

// ---------------------------------------------------------------------------
// Cache TTL still gates, and never widens, the scope.
// ---------------------------------------------------------------------------

test("a warm cache suppresses campaign and voucher writes without widening scope", () => {
  const scope = optimiseWorkScope(null, { refreshCampaigns: false, refreshCoupons: false });
  assert.equal(scope.campaigns, true, "the resource is still in scope");
  assert.equal(scope.persistCampaigns, false, "but a warm cache means nothing is written");
  assert.equal(scope.voucherCodes, true);
  assert.equal(scope.persistVouchers, false);
});

test("a cold cache cannot put an out-of-scope resource back in", () => {
  const scope = optimiseWorkScope("conversions", { refreshCampaigns: true, refreshCoupons: true });
  assert.equal(scope.persistCampaigns, false);
  assert.equal(scope.persistVouchers, false);
});

// ---------------------------------------------------------------------------
// lastCampaignSyncAt: a partial slice must never claim the whole catalog.
// ---------------------------------------------------------------------------

test("a bounded slice with more pages left does not stamp the campaign catalog", () => {
  assert.equal(
    optimiseCampaignCatalogWalked({
      persistCampaigns: true,
      campaignPage: { offset: 0, limit: 100, maxPages: 8 },
      campaignPagination: { offset: 0, nextOffset: 800, hasMore: true },
    }),
    false,
  );
});

test("the last bounded slice stamps the campaign catalog", () => {
  assert.equal(
    optimiseCampaignCatalogWalked({
      persistCampaigns: true,
      campaignPage: { offset: 800, limit: 100, maxPages: 8 },
      campaignPagination: { offset: 800, nextOffset: null, hasMore: false },
    }),
    true,
  );
});

test("a bounded slice that reported no pagination at all does not stamp the catalog", () => {
  assert.equal(
    optimiseCampaignCatalogWalked({
      persistCampaigns: true,
      campaignPage: { offset: 0, limit: 100, maxPages: 8 },
      campaignPagination: null,
    }),
    false,
  );
});

test("an unbounded campaign walk stamps the catalog as it always did", () => {
  assert.equal(
    optimiseCampaignCatalogWalked({ persistCampaigns: true, campaignPage: null, campaignPagination: null }),
    true,
  );
});

test("a failed campaign fetch never stamps the catalog", () => {
  assert.equal(
    optimiseCampaignCatalogWalked({ persistCampaigns: true, campaignsFailed: true }),
    false,
  );
  assert.equal(
    optimiseCampaignCatalogWalked({
      persistCampaigns: true,
      campaignsFailed: true,
      campaignPage: { offset: 800 },
      campaignPagination: { hasMore: false },
    }),
    false,
  );
});

test("a unit that never persists campaigns never stamps the catalog", () => {
  assert.equal(
    optimiseCampaignCatalogWalked({ persistCampaigns: false, campaignPage: null, campaignPagination: null }),
    false,
  );
});

// ---------------------------------------------------------------------------
// lastSuccessfulSync: the incremental watermark belongs to a whole-account run.
// ---------------------------------------------------------------------------

test("a whole-account run with no warnings advances the incremental watermark", () => {
  assert.equal(optimiseAdvanceWatermark({ requested: null, warningCount: 0 }), true);
});

test("a whole-account run with warnings does not advance the watermark", () => {
  assert.equal(optimiseAdvanceWatermark({ requested: null, warningCount: 1 }), false);
});

test("a bounded unit never advances the incremental watermark", () => {
  for (const requested of ["campaigns", "conversions", "reporting", "payments", "voucher_codes", "commission_groups"]) {
    assert.equal(
      optimiseAdvanceWatermark({ requested, warningCount: 0 }),
      false,
      `${requested} covers one source object and must not move the shared window`,
    );
  }
});
