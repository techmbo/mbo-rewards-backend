/**
 * Phase 9A.0a-i — truncation and swallowed-failure honesty.
 *
 * `resolveTerminalStatus` answers SUCCESS for any execute() that returns without throwing. Four
 * proven cases exploited that: Rakuten's 1000-page cap exit, Impact's /Catalogs catch, Partnerize's
 * campaign catch, and Optimise slices that discarded their own `hasMore`. Six distinct states —
 * healthy, empty, unavailable, permission failure, truncation, sliced — all read SUCCESS.
 *
 * What this phase does NOT do, and these tests pin: an empty result is not partial by itself, and a
 * configuration state is not an operational failure. Making `recordsFetched === 0` mean PARTIAL
 * would trade one untruth for another and train operators to ignore the signal.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  pagedOutcome,
  unavailableOutcome,
  withFetchFailureSignal,
} from "../src/jobs/sourceFetchOutcome.js";
import { resolveTerminalStatus, SYNC_OBS_STATUS } from "../src/modules/networkOps/syncObservability.contract.js";

const RAKUTEN_SRC = readFileSync(new URL("../src/adapters/rakuten.adapter.js", import.meta.url), "utf8");
const RAKUTEN_SYNC_SRC = readFileSync(new URL("../src/jobs/rakutenSupplierSync.js", import.meta.url), "utf8");
const WAVEE_SRC = readFileSync(new URL("../src/jobs/waveESupplierSync.js", import.meta.url), "utf8");
const RUNS_SRC = readFileSync(new URL("../src/jobs/sourceObjectRuns.js", import.meta.url), "utf8");
const PLAN_SRC = readFileSync(new URL("../src/jobs/syncSourcePlan.js", import.meta.url), "utf8");

/**
 * The status pipeline exactly as SourceObjectSyncService.execute applies it. countersFromResult is
 * module-private, so its two behaviours that matter here are reproduced: recordCountFrom, and the
 * `partial || recordsQuarantined` rule.
 */
const recordCountFrom = (r) =>
  r == null ? 0
  : typeof r.recordCount === "number" ? r.recordCount
  : typeof r.recordsFetched === "number" ? r.recordsFetched
  : Array.isArray(r.rows) ? r.rows.length
  : Array.isArray(r) ? r.length
  : 0;

function terminalStatusFor(result) {
  const counters =
    !result || typeof result !== "object"
      ? {}
      : {
          recordsFetched: recordCountFrom(result),
          recordsQuarantined: result.recordsQuarantined ?? result.counters?.recordsQuarantined ?? 0,
        };
  const partial = Boolean(result?.partial || result?.warnings?.length);
  return resolveTerminalStatus({ counters, partial });
}

/** resultRows, as sourceObjectSync exports it: both shapes must still yield the rows. */
const rowsOf = (result) => (Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : []);

describe("9A.0a-i — Rakuten: cap exhaustion is not natural exhaustion", () => {
  it("the adapter distinguishes the two exits and records only the cap one", () => {
    const paged = RAKUTEN_SRC.split("async function fetchPagedJson(")[1].split("\n  }")[0];
    // Every natural termination marks the walk exhausted…
    assert.equal((paged.match(/exhausted = true; break;/g) ?? []).length, 3, "all three natural exits");
    // …and only an unexhausted loop records the cap.
    assert.match(paged, /if \(!exhausted && stats\) \{/);
    assert.match(paged, /stats\.pageCapReached = /);
    assert.match(paged, /page cap/);
    // The return type is unchanged, so every existing caller still receives an array.
    assert.match(paged, /return out;/);
    assert.ok(!paged.includes("return { rows"), "no return-shape change was needed");
  });

  it("the cap itself is untouched", () => {
    assert.match(RAKUTEN_SRC, /const maxPages = finitePositive\(params\?\.maxPages, 1000\);/);
  });

  it("all four catalog source objects report a cap exit", () => {
    for (const source of ['"advertisers"', '"partnerships"', '"offers"', '"commissioning_lists"']) {
      const block = RAKUTEN_SYNC_SRC.split(`sourceObject: ${source},`)[1].split("});")[0];
      assert.match(block, /withFetchFailureSignal\(stats, "pageCapReached"/, `${source} unguarded`);
      assert.match(block, /RAKUTEN_PAGE_CAP_REACHED/, `${source} has no error code`);
    }
  });

  it("natural exhaustion is SUCCESS, empty natural exhaustion is SUCCESS, cap exit is PARTIAL", async () => {
    const stats = { requestCount: 0 };
    const rows = [{ id: 1 }, { id: 2 }];

    const natural = await withFetchFailureSignal(stats, "pageCapReached", async () => rows, { errorCode: "X" });
    assert.equal(terminalStatusFor(natural), SYNC_OBS_STATUS.SUCCESS);
    assert.deepEqual(rowsOf(natural), rows);

    const emptyNatural = await withFetchFailureSignal(stats, "pageCapReached", async () => [], { errorCode: "X" });
    assert.equal(terminalStatusFor(emptyNatural), SYNC_OBS_STATUS.SUCCESS, "an empty catalog is not a truncated one");

    const truncated = await withFetchFailureSignal(
      stats,
      "pageCapReached",
      async () => {
        stats.pageCapReached = "/v2/advertisers stopped at the 1000-page cap";
        return rows;
      },
      { errorCode: "RAKUTEN_PAGE_CAP_REACHED", endpoint: "GET /v2/advertisers" },
    );
    assert.equal(terminalStatusFor(truncated), SYNC_OBS_STATUS.PARTIAL);
    assert.deepEqual(rowsOf(truncated), rows, "the rows fetched before the cap are preserved");
    assert.equal(truncated.metadata.errorCode, "RAKUTEN_PAGE_CAP_REACHED");
    assert.equal(truncated.metadata.fetchFailed, true);
  });

  it("a flag left by an EARLIER source object does not contaminate the next one", async () => {
    // stats is shared across every source object of one account sync.
    const stats = { requestCount: 0, pageCapReached: "/v2/advertisers stopped at the 1000-page cap" };
    const next = await withFetchFailureSignal(stats, "pageCapReached", async () => [{ id: 9 }], { errorCode: "X" });
    assert.equal(terminalStatusFor(next), SYNC_OBS_STATUS.SUCCESS, "snapshot comparison, not truthiness");
  });
});

describe("9A.0a-i — Impact: a swallowed hard failure is no longer a success", () => {
  it("the catalogs run wraps fetchProducts with the failure signal", () => {
    const block = WAVEE_SRC.split('sourceObject: "catalogs",')[1].split("});")[0];
    assert.match(block, /withFetchFailureSignal\(stats, "productFetchSkipped"/);
    assert.match(block, /IMPACT_CATALOGS_FETCH_FAILED/);
  });

  it("healthy rows SUCCESS, healthy empty SUCCESS, swallowed 403 PARTIAL with safe metadata", async () => {
    const stats = { requestCount: 0 };
    const healthy = await withFetchFailureSignal(stats, "productFetchSkipped", async () => [{ id: 1 }], { errorCode: "E" });
    assert.equal(terminalStatusFor(healthy), SYNC_OBS_STATUS.SUCCESS);

    const emptyHealthy = await withFetchFailureSignal(stats, "productFetchSkipped", async () => [], { errorCode: "E" });
    assert.equal(terminalStatusFor(emptyHealthy), SYNC_OBS_STATUS.SUCCESS, "a genuinely empty catalog stays SUCCESS");

    // impact.adapter.js sets stats.productFetchSkipped = status || message, then returns [].
    const swallowed = await withFetchFailureSignal(
      stats,
      "productFetchSkipped",
      async () => {
        stats.productFetchSkipped = 403;
        return [];
      },
      { errorCode: "IMPACT_CATALOGS_FETCH_FAILED", endpoint: "GET /Catalogs/Items" },
    );
    assert.notEqual(terminalStatusFor(swallowed), SYNC_OBS_STATUS.SUCCESS);
    assert.equal(terminalStatusFor(swallowed), SYNC_OBS_STATUS.PARTIAL);
    assert.equal(swallowed.metadata.detail, 403);
    assert.equal(swallowed.metadata.endpoint, "GET /Catalogs/Items");
  });

  it("the metadata carries no credential, request or response body", async () => {
    const stats = {};
    const out = await withFetchFailureSignal(
      stats,
      "productFetchSkipped",
      async () => {
        stats.productFetchSkipped = "x".repeat(5000);
        return [];
      },
      { errorCode: "E" },
    );
    assert.deepEqual(Object.keys(out.metadata).sort(), ["detail", "errorCode", "fetchFailed"]);
    assert.equal(out.metadata.detail.length, 300, "detail is length-capped");
  });

  it("out-of-scope Impact methods are untouched in this phase", () => {
    const impact = readFileSync(new URL("../src/adapters/impact.adapter.js", import.meta.url), "utf8");
    // fetchReports and fetchPayments still swallow; 9A.0a-i deliberately does not widen scope.
    assert.match(impact, /stats\.reportFetchSkipped/);
    assert.match(impact, /stats\.paymentFetchSkipped/);
  });
});

describe("9A.0a-i — Partnerize: three states stay three states", () => {
  it("the campaigns run separates hard failure from an unlinked publisher", () => {
    const block = WAVEE_SRC.split('sourceObject: "campaigns",\n      endpoint: "GET campaigns",')[1].split("\n    });")[0];
    assert.match(block, /withFetchFailureSignal\(\s*stats,\s*"campaignFetchFailed"/);
    assert.match(block, /PARTNERIZE_CAMPAIGNS_FETCH_FAILED/);
    assert.match(block, /unavailableOutcome\(/);
    assert.match(block, /PARTNERIZE_PUBLISHER_NOT_LINKED/);
  });

  it("A hard failure is PARTIAL; B unlinked is SUCCESS; C empty is SUCCESS", async () => {
    // A — adapter catch sets campaignFetchFailed then returns []
    const statsA = {};
    const hard = await withFetchFailureSignal(
      statsA,
      "campaignFetchFailed",
      async () => {
        statsA.campaignFetchFailed = 500;
        return [];
      },
      { errorCode: "PARTNERIZE_CAMPAIGNS_FETCH_FAILED" },
    );
    assert.equal(terminalStatusFor(hard), SYNC_OBS_STATUS.PARTIAL, "a hard failure must not read as success");

    // B — publisher not linked: a configuration state, not a fault
    const unlinked = unavailableOutcome([], {
      reason: "Partnerize campaign list requires Publisher ID …",
      code: "PARTNERIZE_PUBLISHER_NOT_LINKED",
      endpoint: "GET campaigns",
    });
    assert.equal(terminalStatusFor(unlinked), SYNC_OBS_STATUS.SUCCESS, "unavailable is NOT an operational failure");
    assert.equal(unlinked.metadata.unavailable, true);
    assert.equal(unlinked.metadata.unavailableCode, "PARTNERIZE_PUBLISHER_NOT_LINKED");

    // C — genuinely empty
    const empty = await withFetchFailureSignal({}, "campaignFetchFailed", async () => [], { errorCode: "E" });
    assert.equal(terminalStatusFor(empty), SYNC_OBS_STATUS.SUCCESS);

    // A and B are distinguishable from each other, which is the point.
    assert.notDeepEqual(hard.metadata, unlinked.metadata);
    assert.ok(!unlinked.metadata.fetchFailed, "an unavailable state is never marked a fetch failure");
    assert.ok(!hard.metadata.unavailable, "a hard failure is never marked unavailable");
  });
});

describe("9A.0a-i — Optimise: slice completeness survives to the run", () => {
  it("the run reads the pagination ref the walk fills", () => {
    const execute = RUNS_SRC.split("execute: async () => {")[1].split("\n    },")[0];
    assert.match(execute, /const pagination = options\.paginationRef\?\.value \?\? null;/);
    assert.match(execute, /pagination \? pagedOutcome\(result\.rows, pagination\) : result\.rows/);
  });

  it("the campaigns walk publishes its pagination into the ref", () => {
    const job = readFileSync(new URL("../src/jobs/sync.job.js", import.meta.url), "utf8");
    assert.match(job, /const campaignPaginationRef = \{\};/);
    assert.match(job, /campaignPaginationRef\.value = campaignPagination;/);
    assert.match(job, /fetchOptimiseSourceObject\("campaigns", credentials, fetchCampaignRows, \{ paginationRef: campaignPaginationRef \}, srcCtx\)/);
  });

  it("a non-final slice records hasMore, a final slice records terminalPage — both healthy SUCCESS", () => {
    const mid = pagedOutcome([{ id: 1 }, { id: 2 }], { hasMore: true, nextOffset: 200, pagesFetched: 2 });
    assert.equal(mid.metadata.pagination.hasMore, true);
    assert.equal(mid.metadata.pagination.terminalPage, false);
    assert.equal(mid.metadata.pagination.nextOffset, 200);
    assert.equal(mid.metadata.pagination.pagesFetched, 2);
    assert.equal(terminalStatusFor(mid), SYNC_OBS_STATUS.SUCCESS, "slicing is expected, never partial");

    const last = pagedOutcome([{ id: 3 }], { hasMore: false, nextOffset: null, pagesFetched: 1 });
    assert.equal(last.metadata.pagination.hasMore, false);
    assert.equal(last.metadata.pagination.terminalPage, true, "answers: was this the terminal page?");
    assert.equal(terminalStatusFor(last), SYNC_OBS_STATUS.SUCCESS);

    // Rows survive both shapes for resultRows().
    assert.equal(rowsOf(mid).length, 2);
    assert.equal(rowsOf(last).length, 1);
  });

  it("nextPagedUnit is untouched — successor planning still reads the supplier's own signal", () => {
    const fn = PLAN_SRC.split("export function nextPagedUnit(")[1].split("\n}")[0];
    assert.match(fn, /if \(!pagination\?\.hasMore\) return null;/);
    assert.match(fn, /campaignPageIndex: Number\(descriptor\.campaignPageIndex \?\? 0\) \+ 1/);
  });
});

describe("9A.0a-i — what must NOT have changed", () => {
  it("a quarantined row still produces PARTIAL", () => {
    assert.equal(terminalStatusFor({ rows: [1, 2], recordsQuarantined: 1 }), SYNC_OBS_STATUS.PARTIAL);
  });

  it("an error still produces FAILED, and a healthy call still produces SUCCESS", () => {
    assert.equal(resolveTerminalStatus({ hadError: true }), SYNC_OBS_STATUS.FAILED);
    assert.equal(terminalStatusFor([1, 2, 3]), SYNC_OBS_STATUS.SUCCESS);
  });

  it("zero rows is NOT globally partial", () => {
    assert.equal(terminalStatusFor([]), SYNC_OBS_STATUS.SUCCESS);
    assert.equal(terminalStatusFor({ rows: [] }), SYNC_OBS_STATUS.SUCCESS);
    assert.equal(terminalStatusFor({ rows: [], recordsFetched: 0 }), SYNC_OBS_STATUS.SUCCESS);
  });

  it("the helper never invents partial from an absent or unchanged key", async () => {
    const stats = {};
    const untouched = await withFetchFailureSignal(stats, "neverSet", async () => [{ id: 1 }], { errorCode: "E" });
    assert.ok(Array.isArray(untouched), "an untouched key returns the adapter's own array unchanged");
    assert.equal(terminalStatusFor(untouched), SYNC_OBS_STATUS.SUCCESS);
  });

  it("no stale-reconciliation, Entity-lifecycle or planner change rode along", () => {
    const helper = readFileSync(new URL("../src/jobs/sourceFetchOutcome.js", import.meta.url), "utf8");
    for (const forbidden of ["lastSeenAt", "upstreamMissingAt", "archivedAt", "PLANNER_VERSION", "entity.", "deleteMany"]) {
      assert.ok(!helper.includes(forbidden), forbidden);
    }
  });
});
