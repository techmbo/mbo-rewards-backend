/**
 * Phase 9A.0a-iii — remaining pagination honesty, and evidence for why a walk stopped.
 *
 * 9A.0a-i made four proven truncations truthful. 9A.0a-ii then audited the rest and found two more
 * silent caps — CJ's 1000-page loop bound and Impact's `page > 500` guard — plus six catalog walks
 * that terminate on a heuristic and report the same SUCCESS as a walk the supplier confirmed had
 * ended. Nothing downstream could tell the two apart, which is exactly the ambiguity that would
 * later let a reconciliation pass mark live rows missing.
 *
 * Two separate claims are pinned here, and they must not be conflated:
 *
 *   1. A CAP exit is a truncation. It is PARTIAL, because we stopped asking while the supplier was
 *      still offering pages.
 *   2. A HEURISTIC exit is not a defect. It stays SUCCESS. What changes is that the run now records
 *      WHY the pager stopped, and a short or empty page is never recorded as supplier-confirmed.
 *
 * Downgrading (2) to PARTIAL would flood the signal with runs that are almost certainly fine and
 * teach operators to ignore it — the same trade 9A.0a-i refused for empty results.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import axios from "axios";
import {
  EXHAUSTION,
  EXHAUSTION_STATS_KEY,
  pagedOutcome,
  recordExhaustion,
  withSourceOutcome,
} from "../src/jobs/sourceFetchOutcome.js";
import { resolveTerminalStatus, SYNC_OBS_STATUS } from "../src/modules/networkOps/syncObservability.contract.js";

/**
 * Every one of these adapters reads its minimum request interval from the environment ONCE, at
 * module load, and production's intervals are measured in seconds — Optimise pauses 12.5s between
 * pages. Walking to a 500- or 1000-page cap is the whole point of this file, so the pacing is
 * collapsed first and the adapters are imported after. Static imports are evaluated before any
 * module body runs, which is why these six are dynamic and the rest are not. Only the spacing
 * changes: no bound, limiter or retry policy is touched.
 */
process.env.BOOSTINY_MIN_INTERVAL_MS = "1";
process.env.OPTIMISE_MIN_INTERVAL_MS = "1";
process.env.IMPACT_MIN_INTERVAL_MS = "1";
process.env.TRACKIER_CAMPAIGN_MIN_INTERVAL_MS = "1";

const { createCjAdapter } = await import("../src/adapters/cj.adapter.js");
const { createBoostinyAdapter } = await import("../src/adapters/boostiny.adapter.js");
const { createTrackierAdapter } = await import("../src/adapters/trackier.adapter.js");
const { createAdmitadAdapter } = await import("../src/adapters/admitad.adapter.js");
const { createOptimiseAdapter } = await import("../src/adapters/optimise.adapter.js");
const { createImpactAdapter } = await import("../src/adapters/impact.adapter.js");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const OUTCOME_SRC = read("src/jobs/sourceFetchOutcome.js");
const VOCABULARY_SRC = read("src/core/paginationExhaustion.js");
const CJ_SYNC_SRC = read("src/jobs/cjSupplierSync.js");
const WAVEE_SRC = read("src/jobs/waveESupplierSync.js");
const ADMITAD_SYNC_SRC = read("src/jobs/admitadSupplierSync.js");
const SYNC_JOB_SRC = read("src/jobs/sync.job.js");
const RUNS_SRC = read("src/jobs/sourceObjectRuns.js");
const CJ_SRC = read("src/adapters/cj.adapter.js");
const IMPACT_SRC = read("src/adapters/impact.adapter.js");

/* ------------------------------------------------------------------------- the status pipeline */

/** countersFromResult + resolveTerminalStatus, exactly as SourceObjectSyncService.execute runs them. */
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
  return resolveTerminalStatus({ counters, partial: Boolean(result?.partial || result?.warnings?.length) });
}

/** resultRows, as sourceObjectSync exports it: both shapes must still yield the rows. */
const rowsOf = (result) => (Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : []);
const paginationOf = (result) => result?.metadata?.pagination ?? null;

/* ------------------------------------------------------------------------------- fake transport */

/** A stub with the axios surface these adapters use: get(path, config) -> { data }. */
function stubClient(pages) {
  const calls = [];
  const queue = [...pages];
  return {
    calls,
    async get(path, config = {}) {
      calls.push({ path, params: config.params ?? {} });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      const data = typeof next === "function" ? next(calls.length) : next;
      return { data, status: 200, headers: {}, config };
    },
  };
}

/**
 * Impact builds its client inside the factory and exposes no seam, so the transport is replaced at
 * the axios default — which axios.create() copies at construction — and restored immediately.
 * Nothing in the adapter is modified, which is the point: the production pager is what runs.
 */
async function withImpactTransport(respond, fn) {
  const previous = axios.defaults.adapter;
  let count = 0;
  axios.defaults.adapter = async (config) => {
    count += 1;
    const data = respond(count, config);
    if (data instanceof Error) throw Object.assign(data, { response: { status: 403, data: {} }, config });
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  try {
    const adapter = createImpactAdapter({ accountSid: "zzsidzz", authToken: "zztokzz" });
    return await fn(adapter, () => count);
  } finally {
    axios.defaults.adapter = previous;
  }
}

/* ============================================================== CJ: the 1000-page cap speaks up */

const cjAdvertiser = (id) => `<advertiser><advertiser-id>${id}</advertiser-id></advertiser>`;
const cjLink = (id) => `<link><link-id>${id}</link-id><advertiser-id>a${id}</advertiser-id></link>`;
const cjPage = (tag, body, attrs = "") => `<cj-api><${tag}${attrs}>${body}</${tag}></cj-api>`;

function cjAdapterOn(pages) {
  const client = stubClient(pages);
  return {
    client,
    adapter: createCjAdapter({
      accessToken: "zztokenzz",
      requestorCid: "zzcidzz",
      websiteId: "zzpidzz",
      httpClient: client,
    }),
  };
}

describe("9A.0a-iii — CJ: the page cap is a truncation, and says so", () => {
  it("MAX_PAGE_COUNT is 1000 and is the loop's own bound, unchanged by this phase", () => {
    const code = codeOnly(CJ_SRC);
    assert.match(code, /const MAX_PAGE_COUNT = 1000;/);
    assert.match(code, /for \(let i = 0; i < MAX_PAGE_COUNT; i \+= 1\) \{/);
  });

  it("the cap exit keeps every row already fetched and reports PARTIAL truncation", async () => {
    // records-per-page=1 makes each page full at one row, so the walk runs to the bound without
    // parsing 100k rows. The cap is the adapter's; only the page size is the test's.
    const { adapter, client } = cjAdapterOn([cjPage("advertisers", cjAdvertiser("zz1zz"), ' records-returned="1"')]);
    const stats = { requestCount: 0 };
    const bare = await adapter.fetchCampaigns({ "advertiser-ids": "joined", "records-per-page": 1 }, stats);
    assert.ok(Array.isArray(bare), "the adapter's return type is unchanged: still an array");
    assert.equal(bare.length, 1000, "every row fetched before the cap survives");
    assert.equal(client.calls.length, 1000, "the bound is still 1000 pages, not 1001");

    // The run wraps the SAME call on the SAME bag: that is what turns the cap into a verdict.
    const runStats = { requestCount: 0 };
    const outcome = await withSourceOutcome(
      runStats,
      () => adapter.fetchCampaigns({ "advertiser-ids": "joined", "records-per-page": 1 }, runStats),
      { truncationCode: "CJ_ADVERTISER_LOOKUP_PAGE_CAP" },
    );
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.PARTIAL);
    assert.equal(outcome.metadata.truncated, true);
    assert.equal(outcome.metadata.fetchFailed, false, "a cap is not a supplier refusal");
    assert.equal(outcome.metadata.errorCode, "CJ_ADVERTISER_LOOKUP_PAGE_CAP");
    assert.equal(rowsOf(outcome).length, 1000, "PARTIAL still carries its rows downstream");
    assert.deepEqual(paginationOf(outcome), {
      exhausted: false,
      exhaustionReason: EXHAUSTION.PAGE_CAP,
      supplierAssertedExhaustion: false,
      pagesFetched: 1000,
    });
  });

  it("total-matched is the supplier asserting the end; a short page is only our inference", async () => {
    const full = cjPage("advertisers", cjAdvertiser("zz1zz"), ' records-returned="1" total-matched="2"');
    const last = cjPage("advertisers", cjAdvertiser("zz2zz"), ' records-returned="1" total-matched="2"');
    const totalled = cjAdapterOn([full, last]);
    const totalStats = { requestCount: 0 };
    await totalled.adapter.fetchCampaigns({ "records-per-page": 1 }, totalStats);
    assert.equal(totalStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.SUPPLIER_TOTAL_REACHED);
    assert.equal(totalStats[EXHAUSTION_STATS_KEY].supplierAsserted, true);
    assert.equal(totalled.client.calls.length, 2);

    const short = cjAdapterOn([cjPage("advertisers", cjAdvertiser("zz1zz"), ' records-returned="1"')]);
    const shortStats = { requestCount: 0 };
    await short.adapter.fetchCampaigns({ "records-per-page": 2 }, shortStats);
    assert.equal(shortStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.SHORT_PAGE);
    assert.equal(shortStats[EXHAUSTION_STATS_KEY].supplierAsserted, false, "a short page is not confirmation");
    assert.equal(short.client.calls.length, 1);

    const empty = cjAdapterOn([cjPage("advertisers", "", ' records-returned="0"')]);
    const emptyStats = { requestCount: 0 };
    await empty.adapter.fetchCampaigns({ "records-per-page": 1 }, emptyStats);
    assert.equal(emptyStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.EMPTY_PAGE);
    assert.equal(emptyStats[EXHAUSTION_STATS_KEY].supplierAsserted, false);
  });

  it("a healthy walk stays SUCCESS and carries its evidence, never `partial`", async () => {
    const { adapter } = cjAdapterOn([
      cjPage("advertisers", cjAdvertiser("zz1zz"), ' records-returned="1" total-matched="1"'),
    ]);
    const stats = { requestCount: 0 };
    const outcome = await withSourceOutcome(
      stats,
      () => adapter.fetchCampaigns({ "records-per-page": 1 }, stats),
      { truncationCode: "CJ_ADVERTISER_LOOKUP_PAGE_CAP" },
    );
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
    assert.equal(outcome.partial, undefined);
    assert.equal(paginationOf(outcome).supplierAssertedExhaustion, true);
    assert.equal(paginationOf(outcome).exhausted, true);
  });

  it("coupons delegates to links, and is signalled ONCE — at the run, not inside the adapter", async () => {
    const code = codeOnly(CJ_SRC);
    // fetchCoupons hands straight to fetchLinks with the same stats bag. If the adapter wrapped
    // either of them, the coupon walk's single cap would be reported twice.
    assert.match(code, /async fetchCoupons\(params = \{\}, stats = null\) \{\s*return this\.fetchLinks\(/);
    assert.ok(!code.includes("withSourceOutcome"), "the adapter records evidence; it does not judge it");

    const sync = codeOnly(CJ_SYNC_SRC);
    for (const object of ['sourceObject: "advertisers"', 'sourceObject: "links"', 'sourceObject: "coupons"']) {
      const block = sync.split(object)[1].split("});")[0];
      assert.match(block, /withSourceOutcome\(stats, \(\) => adapter\.fetch/, object);
    }
    assert.equal((sync.match(/withSourceOutcome\(stats, \(\) => adapter\./g) ?? []).length, 3, "three runs, three wraps");
  });

  it("the links walk's record cannot be read back as the coupons walk's", async () => {
    // One stats bag, two sequential source objects — production's exact shape. The links walk hits
    // the cap; the coupons walk ends naturally. The second must not inherit the first's verdict.
    const client = stubClient([
      (n) => (n <= 1000 ? cjPage("links", cjLink(`zz${n}zz`), ' records-returned="1"') : cjPage("links", "", ' records-returned="0"')),
    ]);
    const adapter = createCjAdapter({
      accessToken: "zztokenzz",
      requestorCid: "zzcidzz",
      websiteId: "zzpidzz",
      httpClient: client,
    });
    const stats = { requestCount: 0 };

    const links = await withSourceOutcome(stats, () => adapter.fetchLinks({ "records-per-page": 1 }, stats), {
      truncationCode: "CJ_LINK_SEARCH_PAGE_CAP",
    });
    assert.equal(terminalStatusFor(links), SYNC_OBS_STATUS.PARTIAL, "the links walk hit the cap");

    const coupons = await withSourceOutcome(stats, () => adapter.fetchCoupons({ "records-per-page": 1 }, stats), {
      truncationCode: "CJ_LINK_SEARCH_PAGE_CAP",
    });
    assert.equal(terminalStatusFor(coupons), SYNC_OBS_STATUS.SUCCESS, "the coupons walk ended on its own page");
    assert.equal(paginationOf(coupons).exhaustionReason, EXHAUSTION.EMPTY_PAGE);
    assert.equal(paginationOf(coupons).exhausted, true);
  });
});

/* ====================================================== Impact: two ways to come back short */

describe("9A.0a-iii — Impact: the 500-page cap and the swallowed failure are different defects", () => {
  it("the cap is named, not an anonymous `page > 500`", () => {
    const code = codeOnly(IMPACT_SRC);
    assert.match(code, /const IMPACT_MAX_PAGE_COUNT = 500;/);
    assert.match(code, /if \(page > IMPACT_MAX_PAGE_COUNT\) \{/);
    assert.ok(!/page > 500/.test(code), "the bare literal is gone");
  });

  it("the cap exit keeps its rows and reports PARTIAL truncation", async () => {
    await withImpactTransport(
      () => ({ Campaigns: [{ Id: "zz1zz" }], "@numpages": 99999 }),
      async (adapter, count) => {
        const stats = { requestCount: 0 };
        const outcome = await withSourceOutcome(
          stats,
          () => adapter.fetchCampaigns({ PageSize: 1 }, stats),
          { truncationCode: "IMPACT_CAMPAIGNS_PAGE_CAP" },
        );
        assert.equal(rowsOf(outcome).length, 500, "every row fetched before the cap survives");
        assert.equal(count(), 500, "the bound is still 500 pages");
        assert.ok(Array.isArray(await adapter.fetchCampaigns({ PageSize: 1 })), "still an array without a bag");
        assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.PARTIAL);
        assert.equal(outcome.metadata.truncated, true);
        assert.equal(outcome.metadata.errorCode, "IMPACT_CAMPAIGNS_PAGE_CAP");
        assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.PAGE_CAP);
        assert.equal(paginationOf(outcome).supplierAssertedExhaustion, false);
        assert.equal(paginationOf(outcome).exhausted, false, "our own limit is not the end of the catalog");
      },
    );
  });

  it("catalogs is PARTIAL for EITHER a swallowed hard failure OR a cap exit, with distinct codes", async () => {
    // (a) the 9A.0a-i case: fetchProducts catches and answers [], recording productFetchSkipped.
    await withImpactTransport(
      () => new Error("zzforbiddenzz"),
      async (adapter) => {
        const stats = { requestCount: 0 };
        const outcome = await withSourceOutcome(stats, () => adapter.fetchProducts({}, stats), {
          failureKeys: ["productFetchSkipped"],
          errorCode: "IMPACT_CATALOGS_FETCH_FAILED",
          truncationCode: "IMPACT_CATALOGS_PAGE_CAP",
          endpoint: "GET /Catalogs/Items",
        });
        assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.PARTIAL);
        assert.equal(outcome.metadata.fetchFailed, true);
        assert.equal(outcome.metadata.errorCode, "IMPACT_CATALOGS_FETCH_FAILED");
        assert.equal(outcome.metadata.truncated, undefined, "a refusal is not a truncation");
        assert.equal(rowsOf(outcome).length, 0);
      },
    );

    // (b) 9A.0a-ii's finding: the cap exit returns NORMALLY, so the 9A.0a-i wrapper never saw it.
    await withImpactTransport(
      () => ({ Catalogs: [{ Id: "zz1zz" }], "@numpages": 99999 }),
      async (adapter) => {
        const stats = { requestCount: 0 };
        const outcome = await withSourceOutcome(stats, () => adapter.fetchProducts({ PageSize: 1 }, stats), {
          failureKeys: ["productFetchSkipped"],
          errorCode: "IMPACT_CATALOGS_FETCH_FAILED",
          truncationCode: "IMPACT_CATALOGS_PAGE_CAP",
          endpoint: "GET /Catalogs/Items",
        });
        assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.PARTIAL);
        assert.equal(outcome.metadata.fetchFailed, false);
        assert.equal(outcome.metadata.truncated, true);
        assert.equal(outcome.metadata.errorCode, "IMPACT_CATALOGS_PAGE_CAP");
        assert.equal(rowsOf(outcome).length, 500, "a truncated catalog still delivers what it read");
      },
    );
  });

  it("a swallowed failure outranks any exhaustion record the dying walk left behind", async () => {
    // Page 1 succeeds and pages 2 onward fail: the pager throws, fetchProducts swallows it, and a
    // stale exhaustion record could still be sitting on the bag. The failure must win.
    const stats = { requestCount: 0 };
    recordExhaustion(stats, EXHAUSTION.SHORT_PAGE, { pagesFetched: 1 });
    stats.productFetchSkipped = undefined;
    const outcome = await withSourceOutcome(
      stats,
      async () => {
        recordExhaustion(stats, EXHAUSTION.EMPTY_PAGE, { pagesFetched: 2 });
        stats.productFetchSkipped = 403;
        return [];
      },
      {
        failureKeys: ["productFetchSkipped"],
        errorCode: "IMPACT_CATALOGS_FETCH_FAILED",
        truncationCode: "IMPACT_CATALOGS_PAGE_CAP",
      },
    );
    assert.equal(outcome.metadata.fetchFailed, true);
    assert.equal(outcome.metadata.errorCode, "IMPACT_CATALOGS_FETCH_FAILED");
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.PARTIAL);
  });

  it("the programs and catalogs runs are both wrapped, and 9A.0a-i's swallow key is preserved", () => {
    const wave = codeOnly(WAVEE_SRC);
    const programs = wave.split('sourceObject: "programs"')[1].split("});")[0];
    assert.match(programs, /withSourceOutcome\(stats, \(\) => adapter\.fetchCampaigns\(\{\}, stats\)/);
    assert.match(programs, /truncationCode: "IMPACT_CAMPAIGNS_PAGE_CAP"/);

    const catalogs = wave.split('sourceObject: "catalogs"')[1].split("});")[0];
    assert.match(catalogs, /failureKeys: \["productFetchSkipped"\]/, "the 9A.0a-i signal is still read");
    assert.match(catalogs, /errorCode: "IMPACT_CATALOGS_FETCH_FAILED"/);
    assert.match(catalogs, /truncationCode: "IMPACT_CATALOGS_PAGE_CAP"/);
  });
});

/* ============================================ every remaining catalog walk names its exit */

describe("9A.0a-iii — exhaustion evidence, per source object", () => {
  const boostiny = (pages) => {
    const client = stubClient(pages);
    return { client, adapter: createBoostinyAdapter({ apiKey: "zzkeyzz", httpClient: client }) };
  };

  it("Boostiny campaigns: hasNext:false is supplier-confirmed", async () => {
    const { adapter } = boostiny([{ data: [{ id: "zz1zz" }], pagination: { hasNext: false } }]);
    const stats = { requestCount: 0 };
    await adapter.fetchCampaigns({ limit: 2 }, stats);
    assert.deepEqual(stats[EXHAUSTION_STATS_KEY], {
      reason: EXHAUSTION.SUPPLIER_HAS_NEXT_FALSE,
      exhausted: true,
      supplierAsserted: true,
      pagesFetched: 1,
    });
  });

  it("Boostiny coupons: snake_case has_next and totalPages are supplier-confirmed too", async () => {
    const snake = boostiny([{ data: [{ id: "zz1zz" }], pagination: { has_next: false } }]);
    const snakeStats = { requestCount: 0 };
    await snake.adapter.fetchCoupons({ limit: 2 }, snakeStats);
    assert.equal(snakeStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.SUPPLIER_HAS_NEXT_FALSE);

    const totals = boostiny([{ data: [{ id: "zz1zz" }, { id: "zz2zz" }], pagination: { totalPages: 1 } }]);
    const totalStats = { requestCount: 0 };
    await totals.adapter.fetchCoupons({ limit: 2 }, totalStats);
    assert.equal(totalStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.SUPPLIER_TOTAL_REACHED);
    assert.equal(totalStats[EXHAUSTION_STATS_KEY].supplierAsserted, true);
  });

  it("Boostiny with no pagination metadata at all falls back to a labelled heuristic", async () => {
    const short = boostiny([{ data: [{ id: "zz1zz" }] }]);
    const shortStats = { requestCount: 0 };
    await short.adapter.fetchCampaigns({ limit: 2 }, shortStats);
    assert.equal(shortStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.SHORT_PAGE);
    assert.equal(shortStats[EXHAUSTION_STATS_KEY].supplierAsserted, false);

    const empty = boostiny([{ data: [] }]);
    const emptyStats = { requestCount: 0 };
    await empty.adapter.fetchCampaigns({ limit: 2 }, emptyStats);
    assert.equal(emptyStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.EMPTY_PAGE);
    assert.equal(emptyStats[EXHAUSTION_STATS_KEY].supplierAsserted, false);
  });

  it("Trackier campaigns: `count` is supplier-confirmed, a short page is not", async () => {
    const counted = stubClient([{ campaigns: [{ _id: "zz1zz" }, { _id: "zz2zz" }], count: 2 }]);
    const stats = {};
    await createTrackierAdapter({ apiKey: "zzkeyzz", httpClient: counted }).fetchCampaigns(
      { limit: 2 },
      { stats },
    );
    assert.equal(stats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.SUPPLIER_TOTAL_REACHED);
    assert.equal(stats[EXHAUSTION_STATS_KEY].supplierAsserted, true);

    const uncounted = stubClient([{ campaigns: [{ _id: "zz1zz" }] }]);
    const shortStats = {};
    await createTrackierAdapter({ apiKey: "zzkeyzz", httpClient: uncounted }).fetchCampaigns(
      { limit: 2 },
      { stats: shortStats },
    );
    assert.equal(shortStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.SHORT_PAGE);
    assert.equal(shortStats[EXHAUSTION_STATS_KEY].supplierAsserted, false);
  });

  it("Trackier coupons: an absent page token IS the supplier asserting the end", async () => {
    // The strongest evidence any of these pagers gets, and the reason this source object is the
    // first candidate for a reconciliation allow-list. SUCCESS is unchanged; no cap was added.
    const client = stubClient([{ coupons: [{ _id: "zz1zz" }] }]);
    const stats = {};
    const adapter = createTrackierAdapter({ apiKey: "zzkeyzz", httpClient: client });
    const outcome = await withSourceOutcome(stats, () => adapter.fetchCoupons({}, { stats }), {});
    assert.equal(rowsOf(outcome).length, 1);
    assert.deepEqual(stats[EXHAUSTION_STATS_KEY], {
      reason: EXHAUSTION.SUPPLIER_NEXT_TOKEN_ABSENT,
      exhausted: true,
      supplierAsserted: true,
      pagesFetched: 1,
    });
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS, "evidence never downgrades a healthy run");
    assert.equal(paginationOf(outcome).supplierAssertedExhaustion, true);
  });

  it("Trackier coupons: a REPEATED token is a defensive stop with no evidence, not an end", async () => {
    const client = stubClient([
      { coupons: [{ _id: "zz1zz" }], nextPageToken: "zzsamezz" },
      { coupons: [{ _id: "zz2zz" }], nextPageToken: "zzsamezz" },
    ]);
    const stats = {};
    await createTrackierAdapter({ apiKey: "zzkeyzz", httpClient: client }).fetchCoupons(
      { pageToken: "zzsamezz" },
      { stats },
    );
    assert.equal(stats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.UNKNOWN);
    assert.equal(stats[EXHAUSTION_STATS_KEY].supplierAsserted, false);
    assert.equal(stats[EXHAUSTION_STATS_KEY].exhausted, false, "a loop guard claims nothing");
  });

  it("Admitad programs and coupons: `_meta.count` is supplier-confirmed, a short page is not", async () => {
    const counted = stubClient([{ results: [{ id: 1 }, { id: 2 }], _meta: { count: 2, limit: 2, offset: 0 } }]);
    const countStats = { requestCount: 0 };
    await createAdmitadAdapter({ accessToken: "zztokzz", httpClient: counted }).fetchCampaigns(
      { limit: 2 },
      countStats,
    );
    assert.equal(countStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.SUPPLIER_TOTAL_REACHED);
    assert.equal(countStats[EXHAUSTION_STATS_KEY].supplierAsserted, true);

    const short = stubClient([{ results: [{ id: 1 }], _meta: { limit: 2, offset: 0 } }]);
    const shortStats = { requestCount: 0 };
    await createAdmitadAdapter({ accessToken: "zztokzz", httpClient: short }).fetchCoupons(
      { limit: 2 },
      shortStats,
    );
    assert.equal(shortStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.SHORT_PAGE);
    assert.equal(shortStats[EXHAUSTION_STATS_KEY].supplierAsserted, false);

    const empty = stubClient([{ results: [], _meta: { limit: 2, offset: 0 } }]);
    const emptyStats = { requestCount: 0 };
    await createAdmitadAdapter({ accessToken: "zztokzz", httpClient: empty }).fetchCoupons(
      { limit: 2 },
      emptyStats,
    );
    assert.equal(emptyStats[EXHAUSTION_STATS_KEY].reason, EXHAUSTION.EMPTY_PAGE);
  });

  it("Optimise voucher_codes: the short page is the ONLY signal there is, and is labelled as one", async () => {
    // Traced before editing: /vouchercodes walks fetchOffsetPaginated, which sends no cursor, reads
    // no total and consults no has-next. `pageRows.length < limit` is the entire termination rule.
    const client = stubClient([
      { response: [{ id: "zz1zz" }, { id: "zz2zz" }] },
      { response: [{ id: "zz3zz" }] },
    ]);
    const adapter = createOptimiseAdapter({
      apiKey: "zzkeyzz",
      agencyId: "zzagzz",
      contactId: "zzcozz",
      httpClient: client,
    });
    const stats = {};
    const outcome = await withSourceOutcome(stats, () => adapter.fetchVoucherCodes({ limit: 2 }, { stats }), {});
    assert.equal(rowsOf(outcome).length, 3);
    assert.equal(client.calls.length, 2);
    assert.deepEqual(stats[EXHAUSTION_STATS_KEY], {
      reason: EXHAUSTION.SHORT_PAGE,
      exhausted: true,
      supplierAsserted: false,
      pagesFetched: 2,
    });

    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS, "a heuristic stop is not a defect");
    assert.equal(paginationOf(outcome).supplierAssertedExhaustion, false);
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.SHORT_PAGE);
  });

  it("Optimise voucher_codes takes its bag through an added option, leaving every other caller alone", async () => {
    const client = stubClient([{ response: [] }]);
    const adapter = createOptimiseAdapter({
      apiKey: "zzkeyzz",
      agencyId: "zzagzz",
      contactId: "zzcozz",
      httpClient: client,
    });
    // No second argument: production's other callers, fetchProductFeeds included, are unchanged
    // and record nothing rather than writing to a bag they were never given.
    const rows = await adapter.fetchVoucherCodes({ limit: 2 });
    assert.deepEqual(rows, []);
    assert.match(codeOnly(read("src/adapters/optimise.adapter.js")), /fetchVoucherCodes\(params = \{\}, options = \{\}\)/);
  });
});

/* ================================================================= the vocabulary's one rule */

describe("9A.0a-iii — a heuristic is never recorded as supplier-confirmed", () => {
  const SUPPLIER_REASONS = new Set([
    EXHAUSTION.SUPPLIER_HAS_NEXT_FALSE,
    EXHAUSTION.SUPPLIER_TOTAL_REACHED,
    EXHAUSTION.SUPPLIER_NEXT_TOKEN_ABSENT,
  ]);

  it("supplierAsserted is true for exactly the three upstream-metadata reasons", () => {
    for (const reason of Object.values(EXHAUSTION)) {
      const stats = {};
      recordExhaustion(stats, reason);
      assert.equal(
        stats[EXHAUSTION_STATS_KEY].supplierAsserted,
        SUPPLIER_REASONS.has(reason),
        reason,
      );
    }
  });

  it("no cap, repeat or unknown stop may claim the walk reached the end", () => {
    // A repeated page joins the cap and the unknown stop: the supplier is not honouring `page`,
    // so the walk plainly did not reach the end of the catalog.
    const notExhausted = new Set([EXHAUSTION.PAGE_CAP, EXHAUSTION.REPEATED_PAGE, EXHAUSTION.UNKNOWN]);
    for (const reason of Object.values(EXHAUSTION)) {
      const stats = {};
      recordExhaustion(stats, reason);
      assert.equal(stats[EXHAUSTION_STATS_KEY].exhausted, !notExhausted.has(reason), reason);
    }
  });

  it("the vocabulary lives where the adapters can reach it, and jobs re-exports it", () => {
    // No adapter in this codebase imports from jobs/, and this phase does not make the first one.
    for (const network of ["cj", "impact", "boostiny", "trackier", "admitad", "optimise"]) {
      const src = read(`src/adapters/${network}.adapter.js`);
      assert.match(
        src,
        /import \{ EXHAUSTION, recordExhaustion \} from "\.\.\/core\/paginationExhaustion\.js";/,
        network,
      );
      assert.ok(!src.includes('from "../jobs/'), `${network} must not reach into jobs/`);
    }
    // Names, not line shape: the re-export gained TRUNCATION_REASONS and wrapped.
    const reexport = OUTCOME_SRC.match(/export \{([^}]*)\} from "\.\.\/core\/paginationExhaustion\.js";/);
    assert.ok(reexport, "jobs/ no longer re-exports the vocabulary");
    const names = reexport[1].split(",").map((n) => n.trim()).filter(Boolean);
    for (const required of ["EXHAUSTION", "EXHAUSTION_STATS_KEY", "recordExhaustion"]) {
      assert.ok(names.includes(required), `${required} is no longer re-exported`);
    }
    assert.ok(!VOCABULARY_SRC.includes("import "), "the vocabulary depends on nothing");
  });

  it("nothing in the vocabulary calls a heuristic complete", () => {
    assert.deepEqual(Object.values(EXHAUSTION).filter((r) => /complete|confirmed|final/i.test(r)), []);
    assert.deepEqual(Object.keys(EXHAUSTION), [
      "SUPPLIER_HAS_NEXT_FALSE",
      "SUPPLIER_TOTAL_REACHED",
      "SUPPLIER_NEXT_TOKEN_ABSENT",
      "SHORT_PAGE",
      "EMPTY_PAGE",
      "PAGE_CAP",
      "REPEATED_PAGE",
      "UNKNOWN",
    ]);
  });

  it("only a truncation turns an otherwise healthy walk PARTIAL", async () => {
    // Two reasons are truncations: our own cap, and a page the supplier re-delivered. UNKNOWN is
    // deliberately NOT one — it is a defensive stop that asserts nothing either way.
    const truncations = new Set([EXHAUSTION.PAGE_CAP, EXHAUSTION.REPEATED_PAGE]);
    for (const reason of Object.values(EXHAUSTION)) {
      const stats = {};
      const outcome = await withSourceOutcome(stats, async () => {
        recordExhaustion(stats, reason, { pagesFetched: 1 });
        return [{ id: "zz1zz" }];
      });
      const expected = truncations.has(reason) ? SYNC_OBS_STATUS.PARTIAL : SYNC_OBS_STATUS.SUCCESS;
      assert.equal(terminalStatusFor(outcome), expected, reason);
      assert.equal(rowsOf(outcome).length, 1, `${reason} keeps its rows`);
      assert.equal(outcome?.metadata?.truncated === true, truncations.has(reason), reason);
      if (truncations.has(reason)) assert.equal(outcome.metadata.fetchFailed, false, reason);
    }
  });

  it("a repeat and a cap are told apart by their codes, not merged", async () => {
    const codes = {};
    for (const reason of [EXHAUSTION.PAGE_CAP, EXHAUSTION.REPEATED_PAGE]) {
      const stats = {};
      // eslint-disable-next-line no-await-in-loop
      const outcome = await withSourceOutcome(
        stats,
        async () => {
          recordExhaustion(stats, reason, { pagesFetched: 1 });
          return [{ id: "zz1zz" }];
        },
        { truncationCode: "ZZ_CAP", repeatedPageCode: "ZZ_REPEAT" },
      );
      codes[reason] = outcome.metadata.errorCode;
    }
    assert.equal(codes[EXHAUSTION.PAGE_CAP], "ZZ_CAP");
    assert.equal(codes[EXHAUSTION.REPEATED_PAGE], "ZZ_REPEAT", "a repeat was reported as a cap");
  });

  it("a pager that never records a repeat needs no new code", async () => {
    // repeatedPageCode falls back to truncationCode, so every existing call site is unchanged.
    const stats = {};
    const outcome = await withSourceOutcome(
      stats,
      async () => {
        recordExhaustion(stats, EXHAUSTION.REPEATED_PAGE, { pagesFetched: 1 });
        return [{ id: "zz1zz" }];
      },
      { truncationCode: "ZZ_CAP_ONLY" },
    );
    assert.equal(outcome.metadata.errorCode, "ZZ_CAP_ONLY");
  });
});

/* ============================================================== shared stats cannot contaminate */

describe("9A.0a-iii — one source object's evidence is never read as the next one's", () => {
  it("a record left by a PREVIOUS call is not reported for this one", async () => {
    const stats = { requestCount: 0 };
    recordExhaustion(stats, EXHAUSTION.PAGE_CAP, { pagesFetched: 1000 });
    // This call's fetch records nothing. The stale cap must not make it PARTIAL, and no pagination
    // block may be invented for it.
    const outcome = await withSourceOutcome(stats, async () => [{ id: "zz1zz" }]);
    assert.ok(Array.isArray(outcome), "with no evidence of its own, the return type is untouched");
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
  });

  it("the comparison is by IDENTITY, so an identical re-record still counts as this call's", async () => {
    const stats = {};
    recordExhaustion(stats, EXHAUSTION.PAGE_CAP, { pagesFetched: 1000 });
    const outcome = await withSourceOutcome(stats, async () => {
      recordExhaustion(stats, EXHAUSTION.PAGE_CAP, { pagesFetched: 1000 });
      return [{ id: "zz1zz" }];
    });
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.PARTIAL, "a fresh record, even an equal one");
  });

  it("there is no global truthiness shortcut anywhere in the helper", () => {
    const code = codeOnly(OUTCOME_SRC);
    assert.ok(!/if \(stats\[EXHAUSTION_STATS_KEY\]\)/.test(code), "a bare `if (stats[key])` is the bug");
    assert.ok(!/if \(stats\?\.\[EXHAUSTION_STATS_KEY\]\)/.test(code));
    // Both halves snapshot before the call and compare after.
    assert.match(code, /const exhaustionBefore = stats \? stats\[EXHAUSTION_STATS_KEY\] : undefined;/);
    assert.match(code, /if \(!record \|\| record === exhaustionBefore\) return fetched;/);
    assert.match(code, /const failureBefore = new Map\(failureKeys\.map\(/);
    assert.match(code, /if \(after !== undefined && after !== failureBefore\.get\(key\)\) \{/);
  });

  it("the failure half snapshots per KEY, so an unrelated key already set is not this call's failure", async () => {
    const stats = { productFetchSkipped: 403, requestCount: 0 };
    const outcome = await withSourceOutcome(stats, async () => [{ id: "zz1zz" }], {
      failureKeys: ["productFetchSkipped"],
      errorCode: "E",
    });
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS, "it was already there before the call");
  });

  it("the concurrently-fetched networks get a bag PER SOURCE OBJECT, not per account", () => {
    const job = codeOnly(SYNC_JOB_SRC);
    // Trackier and Optimise await their source objects with Promise.all, so a shared bag would be
    // written by several walks at once and no snapshot could separate them.
    assert.match(job, /const trackierCampaignStats = \{\};/);
    assert.match(job, /const trackierCouponStats = \{\};/);
    assert.match(job, /const optimiseVoucherStats = \{\};/);
    assert.match(job, /adapter\.fetchCampaigns\(\{\}, \{ stats: trackierCampaignStats \}\)/);
    assert.match(job, /adapter\.fetchCoupons\(\{\}, \{ stats: trackierCouponStats \}\)/);
    assert.match(job, /adapter\.fetchVoucherCodes\(\{\}, \{ stats: optimiseVoucherStats \}\)/);
    assert.notEqual(
      job.indexOf("trackierCampaignStats"),
      job.indexOf("trackierCouponStats"),
      "two distinct bags, not one alias",
    );

    const runs = codeOnly(RUNS_SRC);
    assert.equal(
      (runs.match(/withSourceOutcome\(options\.exhaustionStats \?\? null, async \(\) => \{/g) ?? []).length,
      2,
      "both the Optimise and the Trackier run read the per-call bag",
    );
  });

  it("the sequentially-fetched networks share one bag, and the snapshot is what separates them", () => {
    // CJ, Impact, Boostiny and Admitad run their source objects one after another on a single
    // per-account stats object. That is safe BECAUSE of the snapshot, and only because of it.
    for (const [name, source] of [
      ["cj", CJ_SYNC_SRC],
      ["impact", WAVEE_SRC],
      ["admitad", ADMITAD_SYNC_SRC],
    ]) {
      assert.match(codeOnly(source), /const stats = \{ requestCount: 0 \};/, name);
      assert.match(codeOnly(source), /withSourceOutcome\(stats, \(\) => adapter\./, name);
    }
    const boostiny = codeOnly(SYNC_JOB_SRC);
    assert.match(boostiny, /withSourceOutcome\(stats, \(\) => adapter\.fetchCampaigns\(undefined, stats\)/);
    assert.match(boostiny, /withSourceOutcome\(stats, \(\) => adapter\.fetchCoupons\(undefined, stats\)/);
  });
});

/* ================================================================ what must NOT have changed */

describe("9A.0a-iii — the blast radius", () => {
  it("a deliberate single-page slice records nothing at all", async () => {
    const client = stubClient([{ data: [{ id: "zz1zz" }, { id: "zz2zz" }], pagination: { hasNext: true } }]);
    const stats = { requestCount: 0 };
    await createBoostinyAdapter({ apiKey: "zzkeyzz", httpClient: client }).fetchCampaigns({ limit: 2 }, stats, {
      singlePage: true,
    });
    assert.equal(client.calls.length, 1);
    assert.equal(stats[EXHAUSTION_STATS_KEY], undefined, "a bounded probe asserts nothing about the catalog");
  });

  it("9A.0a-i's slice evidence survives being wrapped: metadata is merged, never replaced", async () => {
    const stats = {};
    const outcome = await withSourceOutcome(stats, async () => {
      recordExhaustion(stats, EXHAUSTION.SHORT_PAGE, { pagesFetched: 2 });
      return pagedOutcome([{ id: "zz1zz" }], { hasMore: true, nextOffset: 200, pagesFetched: 2 });
    });
    assert.equal(outcome.metadata.pagination.hasMore, undefined, "the exhaustion block is this phase's");
    assert.equal(rowsOf(outcome).length, 1);
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
  });

  it("an empty result is still SUCCESS, and a quarantined row is still PARTIAL", async () => {
    const stats = {};
    const empty = await withSourceOutcome(stats, async () => {
      recordExhaustion(stats, EXHAUSTION.EMPTY_PAGE, { pagesFetched: 1 });
      return [];
    });
    assert.equal(terminalStatusFor(empty), SYNC_OBS_STATUS.SUCCESS, "zero rows still means zero rows");
    assert.equal(
      resolveTerminalStatus({ counters: { recordsFetched: 1, recordsQuarantined: 1 }, partial: false }),
      SYNC_OBS_STATUS.PARTIAL,
    );
  });

  it("no lifecycle field, no reconciliation, no archive and no schema change rides along", () => {
    for (const [name, source] of [
      ["outcome", OUTCOME_SRC],
      ["cjSync", CJ_SYNC_SRC],
      ["waveE", WAVEE_SRC],
      ["admitadSync", ADMITAD_SYNC_SRC],
      ["runs", RUNS_SRC],
    ]) {
      for (const forbidden of ["archivedAt", "plannerVersion", "ALTER TABLE", "$executeRaw", "refreshGeneration"]) {
        assert.ok(!source.includes(forbidden), `${forbidden} in ${name}`);
      }
    }
  });
});
