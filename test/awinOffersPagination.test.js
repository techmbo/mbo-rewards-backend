/**
 * Phase 9A.0b-ii — the Awin offers walk reaches the end of the catalogue, and says how it knows.
 *
 * POST /publisher/{publisherId}/promotions is documented as paginated, and production read one
 * page of it: `page` was pinned at 1, nothing incremented it, and the run reported SUCCESS. Any
 * account with more than 200 promotions staged the first 200 and looked complete.
 *
 * Two claims are pinned here and must not be conflated. A CAP exit is a truncation and is PARTIAL,
 * because the catalogue was still offering pages when we stopped asking. A HEURISTIC exit — a
 * short or empty page — is not a defect and stays SUCCESS; what changes is that the run records
 * that it was an inference, never a supplier confirmation.
 *
 * Awin programmes is deliberately absent from this file. No page parameter is documented on that
 * endpoint, so there is nothing to walk without inventing one. It remains UNKNOWN and is NOT
 * eligible for a reconciliation allow-list; the last describe block pins that it did not change.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { EXHAUSTION } from "../src/core/paginationExhaustion.js";
import { runWithConcurrency } from "../src/core/concurrency.js";
import { resolveDbConcurrency } from "../src/core/dbPermits.js";
import { createFakeConnectionPool } from "./helpers/fakeConnectionPool.js";
import { withSourceOutcome } from "../src/jobs/sourceFetchOutcome.js";
import { resolveTerminalStatus, SYNC_OBS_STATUS } from "../src/modules/networkOps/syncObservability.contract.js";

/**
 * The Awin limiter reads its interval once, at module load, and production's is 3000ms — Awin
 * documents a shared 20-calls-per-minute throttle. Walking to the 25-page cap is the point of this
 * file, and at production pacing that alone is 75 seconds. Static imports are evaluated before any
 * module body runs, so the pacing is collapsed first and the adapter is imported after. Only the
 * spacing changes: the cap, the page size and the walk are untouched, and a separate test asserts
 * the limiter's own default is still 3000.
 */
process.env.AWIN_MIN_INTERVAL_MS = "1";

const {
  AWIN_MAX_OFFER_PAGES,
  AWIN_OFFERS_PAGE_CAP_CODE,
  AWIN_OFFERS_REPEATED_PAGE_CODE,
  AWIN_OFFERS_PAGE_SIZE,
  awinOffersPaginationSignal,
  createAwinAdapter,
} = await import("../src/adapters/awin.adapter.js");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ADAPTER_SRC = read("src/adapters/awin.adapter.js");
const SYNC_SRC = read("src/jobs/waveESupplierSync.js");
const CERT_SRC = read("src/modules/ops/networkCertification.service.js");
const codeOnly = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const TOKEN = "zzawinaccesstokenzz";
const PUBLISHER_ID = "zzpublisheridzz";
const VOUCHER = "zzvouchercodezz";

/* -------------------------------------------------------------------------------- the harness */

/** The status pipeline exactly as SourceObjectSyncService.execute applies it. */
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
      : { recordsFetched: recordCountFrom(result), recordsQuarantined: result.recordsQuarantined ?? 0 };
  return resolveTerminalStatus({ counters, partial: Boolean(result?.partial) });
}

const rowsOf = (r) => (Array.isArray(r) ? r : Array.isArray(r?.rows) ? r.rows : []);
const paginationOf = (r) => r?.metadata?.pagination ?? null;

/** A transport with the two methods the adapter uses. `respond(page)` builds each envelope. */
function spyTransport(respond) {
  const calls = [];
  return {
    calls,
    async get(path, config = {}) {
      calls.push({ method: "get", path, params: config.params });
      return { data: { programmes: [] } };
    },
    async post(path, body) {
      calls.push({ method: "post", path, body });
      const page = body?.pagination?.page;
      const outcome = respond(page, calls.length);
      if (outcome instanceof Error) throw outcome;
      return { data: outcome };
    },
  };
}

const adapterOn = (client) =>
  createAwinAdapter({ accessToken: TOKEN, publisherId: PUBLISHER_ID, httpClient: client });

const promotion = (id) => ({
  promotionId: id,
  advertiser: { id: 998877, name: "zzadvertisernamezz" },
  type: "voucher",
  voucher: { code: VOUCHER },
  url: "https://www.awin1.com/cread.php?zzcreadzz",
  commission: { amount: 6543.21, currency: "GBP" },
});
const fullPage = (offset) => Array.from({ length: AWIN_OFFERS_PAGE_SIZE }, (_, i) => promotion(offset + i));

/** Walk the offers catalogue the way the sync run does, on one stats bag. */
async function walk(respond) {
  const client = spyTransport(respond);
  const adapter = adapterOn(client);
  const stats = { requestCount: 0 };
  const outcome = await withSourceOutcome(stats, () => adapter.fetchCoupons({}, stats), {
    truncationCode: AWIN_OFFERS_PAGE_CAP_CODE,
    repeatedPageCode: AWIN_OFFERS_REPEATED_PAGE_CODE,
    endpoint: "POST /publisher/{publisherId}/promotions",
  });
  return { client, stats, outcome };
}

/* ============================================================== termination, in precedence order */

describe("9A.0b-ii — Awin offers walks, and labels how the walk ended", () => {
  it("one short page: SUCCESS, short_page, and it is NOT supplier-confirmed", async () => {
    const { client, outcome } = await walk(() => ({ data: [promotion(1), promotion(2)] }));
    assert.equal(client.calls.length, 1, "a short first page must not be followed");
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
    assert.equal(rowsOf(outcome).length, 2);
    assert.deepEqual(paginationOf(outcome), {
      exhausted: true,
      exhaustionReason: EXHAUSTION.SHORT_PAGE,
      supplierAssertedExhaustion: false,
      pagesFetched: 1,
    });
  });

  it("one empty page: SUCCESS, empty_page, zero rows still means zero rows", async () => {
    const { client, outcome } = await walk(() => ({ data: [] }));
    assert.equal(client.calls.length, 1);
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS, "an empty catalogue is not a defect");
    assert.equal(rowsOf(outcome).length, 0);
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.EMPTY_PAGE);
    assert.equal(paginationOf(outcome).supplierAssertedExhaustion, false);
  });

  it("a full page IS followed: 200 then a short page", async () => {
    const { client, outcome } = await walk((page) =>
      page === 1 ? { data: fullPage(1000) } : { data: [promotion(9001), promotion(9002)] },
    );
    assert.equal(client.calls.length, 2, "the second page was never requested");
    assert.equal(rowsOf(outcome).length, AWIN_OFFERS_PAGE_SIZE + 2, "page 2 rows were dropped");
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.SHORT_PAGE);
    assert.equal(paginationOf(outcome).pagesFetched, 2);
  });

  it("200 then an empty page: SUCCESS, empty_page, first page preserved", async () => {
    const { client, outcome } = await walk((page) => (page === 1 ? { data: fullPage(2000) } : { data: [] }));
    assert.equal(client.calls.length, 2);
    assert.equal(rowsOf(outcome).length, AWIN_OFFERS_PAGE_SIZE);
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.EMPTY_PAGE);
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
  });

  it("supplier metadata OUTRANKS the heuristics and is the only thing that may claim confirmation", async () => {
    // total=350 at pageSize 200: page 1 continues (200 < 350), page 2 is terminal (400 >= 350).
    const { client, outcome } = await walk((page) =>
      page === 1
        ? { data: fullPage(3000), pagination: { page: 1, pageSize: 200, total: 350 } }
        : { data: Array.from({ length: 150 }, (_, i) => promotion(3200 + i)), pagination: { page: 2, pageSize: 200, total: 350 } },
    );
    assert.equal(client.calls.length, 2);
    assert.equal(rowsOf(outcome).length, 350);
    assert.deepEqual(paginationOf(outcome), {
      exhausted: true,
      exhaustionReason: EXHAUSTION.SUPPLIER_TOTAL_REACHED,
      supplierAssertedExhaustion: true,
      pagesFetched: 2,
    });
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
  });

  it("a thrown supplier error still propagates, so the run is FAILED", async () => {
    const boom = Object.assign(new Error("zzupstreamzz"), { response: { status: 403, data: {} } });
    const client = spyTransport(() => boom);
    await assert.rejects(() => adapterOn(client).fetchCoupons({}, { requestCount: 0 }));
  });
});

/* ================================================================== the positive-metadata parser */

describe("9A.0b-ii — the positive-metadata parser", () => {
  const at = (envelope, page = 1) => awinOffersPaginationSignal(envelope, { page, pageSize: AWIN_OFFERS_PAGE_SIZE });

  it("total: continues while pages remain and asserts the end when they do not", () => {
    assert.deepEqual(at({ total: 350 }, 1), { hasMore: true, reason: null });
    assert.deepEqual(at({ total: 350 }, 2), { hasMore: false, reason: EXHAUSTION.SUPPLIER_TOTAL_REACHED });
    // The spelling variants, all of which mean the size of the result set.
    for (const key of ["total", "totalItems", "total_items", "totalCount", "total_count"]) {
      assert.equal(at({ [key]: 350 }, 2).reason, EXHAUSTION.SUPPLIER_TOTAL_REACHED, key);
    }
    assert.equal(at({ pagination: { total: 350 } }, 2).reason, EXHAUSTION.SUPPLIER_TOTAL_REACHED, "nested");
    assert.equal(at({ meta: { total: 350 } }, 2).reason, EXHAUSTION.SUPPLIER_TOTAL_REACHED, "meta");
    assert.equal(at({ metadata: { total: 350 } }, 2).reason, EXHAUSTION.SUPPLIER_TOTAL_REACHED, "metadata");
  });

  it("totalPages: page 2 of 2 is terminal, page 1 of 2 is not", () => {
    assert.equal(at({ totalPages: 2 }, 1).hasMore, true);
    assert.deepEqual(at({ totalPages: 2 }, 2), { hasMore: false, reason: EXHAUSTION.SUPPLIER_TOTAL_REACHED });
    for (const key of ["totalPages", "total_pages", "pageCount", "page_count", "lastPage", "last_page"]) {
      assert.equal(at({ [key]: 2 }, 2).reason, EXHAUSTION.SUPPLIER_TOTAL_REACHED, key);
    }
  });

  it("hasNext:false is the supplier saying so; hasNext:true keeps the walk going", () => {
    assert.deepEqual(at({ hasNext: false }), { hasMore: false, reason: EXHAUSTION.SUPPLIER_HAS_NEXT_FALSE });
    assert.equal(at({ hasNext: true }).hasMore, true);
    for (const key of ["hasNext", "hasNextPage", "has_next", "has_next_page", "hasMore", "has_more"]) {
      assert.equal(at({ [key]: false }).reason, EXHAUSTION.SUPPLIER_HAS_NEXT_FALSE, key);
    }
  });

  it("a cursor is read for PRESENCE only — its value is never inspected", () => {
    assert.deepEqual(at({ next: null }), { hasMore: false, reason: EXHAUSTION.SUPPLIER_HAS_NEXT_FALSE });
    assert.equal(at({ next: `https://api.awin.com/publisher/${PUBLISHER_ID}/promotions?page=2` }).hasMore, true);
    assert.equal(at({ nextPageToken: "" }).hasMore, false);
  });

  it("unrecognised metadata yields NO verdict, so the heuristics decide", () => {
    for (const envelope of [{ data: [] }, { status: "ok" }, { paging: { cursorish: 3 } }, {}, null, [], "text", 7]) {
      assert.equal(at(envelope).hasMore, null, JSON.stringify(envelope));
    }
  });

  it("an ambiguous `count` is IGNORED, because a page count and a result count share a name", () => {
    // count <= pageSize could be this page's row count. Reading it as a total would end the walk
    // early AND call it supplier-confirmed — the exact failure this phase exists to prevent.
    assert.equal(at({ count: 200 }, 1).hasMore, null, "an ambiguous count asserted completion");
    assert.equal(at({ count: 12 }, 1).hasMore, null);
    // Above the page size it cannot be a per-page count, so it is usable.
    assert.deepEqual(at({ count: 350 }, 2), { hasMore: false, reason: EXHAUSTION.SUPPLIER_TOTAL_REACHED });
    assert.equal(at({ count: 350 }, 1).hasMore, true);
    // An explicit total always wins over count.
    assert.equal(at({ total: 350, count: 200 }, 1).hasMore, true);
  });

  it("CONFLICTING signals assert nothing at all — fail safe, never fail complete", () => {
    const conflicted = at({ hasNext: true, totalPages: 1 }, 1);
    assert.equal(conflicted.hasMore, null, "a conflict produced a verdict");
    assert.equal(conflicted.conflicted, true);
    assert.equal(at({ hasNext: false, total: 5000 }, 1).hasMore, null);
    assert.equal(at({ pagination: { hasNext: true }, totalPages: 1 }, 1).hasMore, null);
    // Agreeing signals are still a verdict.
    assert.equal(at({ hasNext: false, totalPages: 1 }, 1).reason, EXHAUSTION.SUPPLIER_HAS_NEXT_FALSE);
  });

  it("a conflict at the supplier falls through to the heuristics, and is labelled as one", async () => {
    const { outcome } = await walk(() => ({ data: [promotion(1)], hasNext: true, totalPages: 1 }));
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.SHORT_PAGE);
    assert.equal(paginationOf(outcome).supplierAssertedExhaustion, false);
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
  });
});

/* ========================================================================= the repeated-page guard */

describe("9A.0b-ii — an endpoint that ignores `page` is a TRUNCATION, not a healthy read", () => {
  it("an immediate repeat stops the walk, drops the duplicate, and reports PARTIAL", async () => {
    const stuck = fullPage(5000);
    const { client, outcome } = await walk(() => ({ data: stuck }));
    assert.equal(client.calls.length, 2, "the guard must fire on the FIRST repeat");
    assert.equal(rowsOf(outcome).length, AWIN_OFFERS_PAGE_SIZE, "the re-delivered page was staged twice");
    assert.deepEqual(paginationOf(outcome), {
      exhausted: false,
      exhaustionReason: EXHAUSTION.REPEATED_PAGE,
      supplierAssertedExhaustion: false,
      pagesFetched: 2,
    });
    // Part of a catalogue is not a SUCCESS: the supplier is not honouring `page`, so whatever
    // remains is unreachable by this walk.
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.PARTIAL);
    assert.equal(outcome.metadata.truncated, true);
    assert.equal(outcome.metadata.fetchFailed, false);
    assert.equal(outcome.metadata.errorCode, AWIN_OFFERS_REPEATED_PAGE_CODE);
  });

  it("a NON-ADJACENT repeat is caught too: A -> B -> A", async () => {
    const a = fullPage(1000);
    const b = fullPage(2000);
    const { client, outcome } = await walk((page) => ({ data: page === 2 ? b : a }));
    assert.equal(client.calls.length, 3, "the walk did not stop on the re-seen page");
    assert.equal(rowsOf(outcome).length, AWIN_OFFERS_PAGE_SIZE * 2, "the repeated page was appended again");
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.REPEATED_PAGE);
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.PARTIAL);
    assert.equal(outcome.metadata.truncated, true);
  });

  it("a deeper non-adjacent repeat is caught: A -> B -> C -> B", async () => {
    const pages = { 1: fullPage(1000), 2: fullPage(2000), 3: fullPage(3000), 4: fullPage(2000) };
    const { client, outcome } = await walk((page) => ({ data: pages[page] ?? fullPage(9000) }));
    assert.equal(client.calls.length, 4);
    assert.equal(rowsOf(outcome).length, AWIN_OFFERS_PAGE_SIZE * 3, "the repeated page was appended again");
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.REPEATED_PAGE);
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.PARTIAL);
  });

  it("an alternating A/B endpoint stops on the first re-seen page, not at the cap", async () => {
    const a = fullPage(1000);
    const b = fullPage(2000);
    const { client, outcome } = await walk((page) => ({ data: page % 2 === 1 ? a : b }));
    // Under the previous adjacent-only guard this walked all 25 pages and reported PAGE_CAP.
    assert.equal(client.calls.length, 3, "the alternating pattern was not detected");
    assert.ok(client.calls.length < AWIN_MAX_OFFER_PAGES, "the walk ran to the cap");
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.REPEATED_PAGE);
    assert.equal(outcome.metadata.errorCode, AWIN_OFFERS_REPEATED_PAGE_CODE);
    assert.notEqual(outcome.metadata.errorCode, AWIN_OFFERS_PAGE_CAP_CODE, "a repeat was reported as a cap");
  });

  it("a repeated page is never appended twice, at any depth", async () => {
    const a = fullPage(1000);
    const { outcome } = await walk((page) => ({ data: page === 1 || page === 3 ? a : fullPage(2000) }));
    const ids = rowsOf(outcome).map((row) => row.promotionId);
    assert.equal(new Set(ids).size, ids.length, "a duplicate row reached the caller");
  });

  it("genuinely different pages are NOT mistaken for a repeat", async () => {
    const { client, outcome } = await walk((page) =>
      page < 3 ? { data: fullPage(page * 1000) } : { data: [promotion(77)] },
    );
    assert.equal(client.calls.length, 3);
    assert.equal(rowsOf(outcome).length, AWIN_OFFERS_PAGE_SIZE * 2 + 1);
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.SHORT_PAGE);
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
  });

  it("two empty pages are not a 'repeat' — the empty-page rule ends the walk first", async () => {
    const { client, outcome } = await walk(() => ({ data: [] }));
    assert.equal(client.calls.length, 1);
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.EMPTY_PAGE);
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
  });

  it("rows with no stable id still compare, via a fingerprint that never leaves the adapter", async () => {
    const anonymous = Array.from({ length: AWIN_OFFERS_PAGE_SIZE }, () => ({ type: "voucher", voucher: { code: VOUCHER } }));
    const { client, outcome } = await walk(() => ({ data: anonymous }));
    assert.equal(client.calls.length, 2, "identical anonymous pages were not detected");
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.REPEATED_PAGE);
    assert.ok(!JSON.stringify(outcome.metadata).includes(VOUCHER));
  });

  it("the seen-page set is local to one walk and cannot leak between them", async () => {
    const a = fullPage(1000);
    const first = await walk((page) => (page === 1 ? { data: a } : { data: [] }));
    const second = await walk((page) => (page === 1 ? { data: a } : { data: [] }));
    // The same page in a SEPARATE walk is new, not a repeat.
    for (const outcome of [first.outcome, second.outcome]) {
      assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.EMPTY_PAGE);
      assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
      assert.equal(rowsOf(outcome).length, AWIN_OFFERS_PAGE_SIZE);
    }
  });
});

/* ================================================================================ the safety cap */

describe("9A.0b-ii — the page cap is a truncation, and says so", () => {
  it("the cap is 25 pages, hard-coded, and not raisable by environment", () => {
    assert.equal(AWIN_MAX_OFFER_PAGES, 25);
    assert.match(codeOnly(ADAPTER_SRC), /export const AWIN_MAX_OFFER_PAGES = 25;/);
    const declaration = ADAPTER_SRC.split("export const AWIN_MAX_OFFER_PAGES")[1].split(";")[0];
    assert.ok(!declaration.includes("process.env"), "the cap became env-overridable");
    assert.match(codeOnly(ADAPTER_SRC), /page <= AWIN_MAX_OFFER_PAGES/);
  });

  it("reaching the cap preserves every row and reports PARTIAL truncation", async () => {
    // Every page full and distinct, and no metadata: nothing terminates the walk but the bound.
    const { client, outcome } = await walk((page) => ({ data: fullPage(page * 10_000) }));
    assert.equal(client.calls.length, AWIN_MAX_OFFER_PAGES, "the bound is not 25 pages");
    assert.equal(rowsOf(outcome).length, AWIN_MAX_OFFER_PAGES * AWIN_OFFERS_PAGE_SIZE, "rows were lost at the cap");
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.PARTIAL);
    assert.equal(outcome.metadata.truncated, true);
    assert.equal(outcome.metadata.fetchFailed, false, "a cap is not a supplier refusal");
    assert.equal(outcome.metadata.errorCode, AWIN_OFFERS_PAGE_CAP_CODE);
    assert.equal(AWIN_OFFERS_PAGE_CAP_CODE, "AWIN_OFFERS_PAGE_CAP");
    assert.deepEqual(paginationOf(outcome), {
      exhausted: false,
      exhaustionReason: EXHAUSTION.PAGE_CAP,
      supplierAssertedExhaustion: false,
      pagesFetched: AWIN_MAX_OFFER_PAGES,
    });
  });

  it("the cap fits the bounded unit: 25 pages of pacing plus staging, inside one invocation", async () => {
    // Item 9 of the brief: if 25 pages plus staging cannot fit, Awin offers needs durable sliced
    // pagination instead of an oversized unit. Measured here rather than argued, against the same
    // fake pool and the same per-row shape awinOffersPoolSafety models, so the claim cannot rot.
    const INVOCATION_MS = 300_000;
    const limiterMs = Number(/process\.env\.AWIN_MIN_INTERVAL_MS \|\| (\d+)/.exec(ADAPTER_SRC)[1]);
    assert.equal(limiterMs, 3000, "the Awin limiter interval moved; re-measure the budget");

    // Worst case: every page full and distinct, plus the programmes and transactions calls that
    // share this limiter inside one Awin account sync.
    const supplierMs = (AWIN_MAX_OFFER_PAGES + 2) * limiterMs;
    assert.ok(supplierMs <= INVOCATION_MS * 0.3, `supplier pacing ${supplierMs}ms is over 30% of the invocation`);

    const rows = AWIN_MAX_OFFER_PAGES * AWIN_OFFERS_PAGE_SIZE;
    assert.equal(rows, 5000);
    const pool = createFakeConnectionPool({ limit: 5, timeoutMs: 10_000, queryMs: 0 });
    const stageRow = async () => {
      // persistRawPayload(RECEIVED), upsertCouponFromSync, persistRawPayload(STAGED).
      for (let i = 0; i < 6; i += 1) await pool.query();
    };
    await runWithConcurrency(Array.from({ length: rows }, (_, i) => i), resolveDbConcurrency(50), stageRow);
    const stats = pool.stats();
    assert.equal(stats.timeouts, 0, "staging a full cap of rows exhausted the pool");
    assert.ok(stats.peakInUse <= 5, `peak ${stats.peakInUse} connections`);
    assert.ok(resolveDbConcurrency(50) <= 4, "the staging fan-out is still bounded below the pool");
  });

  it("a walk that ends one page short of the cap is NOT a truncation", async () => {
    const { client, outcome } = await walk((page) =>
      page < AWIN_MAX_OFFER_PAGES ? { data: fullPage(page * 10_000) } : { data: [promotion(1)] },
    );
    assert.equal(client.calls.length, AWIN_MAX_OFFER_PAGES);
    assert.equal(terminalStatusFor(outcome), SYNC_OBS_STATUS.SUCCESS);
    assert.equal(paginationOf(outcome).exhaustionReason, EXHAUSTION.SHORT_PAGE);
  });
});

/* ==================================================================== the request never changes */

describe("9A.0b-ii — only `page` moves", () => {
  it("pageSize is 200 on every request, and filters is what the caller passed", async () => {
    const { client } = await walk((page) => (page < 4 ? { data: fullPage(page * 100) } : { data: [] }));
    assert.equal(client.calls.length, 4);
    for (const call of client.calls) {
      assert.equal(call.method, "post");
      assert.equal(call.path, `/publisher/${PUBLISHER_ID}/promotions`);
      assert.equal(call.body.pagination.pageSize, AWIN_OFFERS_PAGE_SIZE);
      assert.equal(AWIN_OFFERS_PAGE_SIZE, 200);
      assert.deepEqual(call.body.filters, {}, "filters semantics changed");
      assert.deepEqual(Object.keys(call.body).sort(), ["filters", "pagination"]);
      assert.deepEqual(Object.keys(call.body.pagination).sort(), ["page", "pageSize"]);
    }
    assert.deepEqual(client.calls.map((c) => c.body.pagination.page), [1, 2, 3, 4], "page must go 1,2,3,…");
  });

  it("the page size is not a variable a caller or the environment can move", () => {
    const declaration = ADAPTER_SRC.split("export const AWIN_OFFERS_PAGE_SIZE")[1].split(";")[0];
    assert.ok(!declaration.includes("process.env"), "pageSize became env-overridable");
    assert.match(declaration, /= 200/);
    const fetcher = codeOnly(ADAPTER_SRC).split("async fetchCoupons(")[1].split("\n    },")[0];
    assert.ok(!/pageSize: \d/.test(fetcher), "a literal page size reappeared in the fetcher");
    assert.ok(!fetcher.includes("Promise.all"), "pages were fetched in parallel");
  });

  it("requests are sequential and each takes its slot on the shared limiter", async () => {
    // post() acquires the slot before every request, and the walk awaits each one in turn.
    assert.match(ADAPTER_SRC, /async function post\(path, body = \{\}, stats = null\) \{\s*await awinRateLimiter\.acquireSlot\(\);/);
    const fetcher = codeOnly(ADAPTER_SRC).split("async fetchCoupons(")[1].split("\n    },")[0];
    assert.match(fetcher, /await fetchPage\(page\)/);
    assert.ok(!fetcher.includes("acquireSlot"), "the walk manages pacing itself");
    assert.ok(!ADAPTER_SRC.includes("AWIN_MAX_OFFER_PAGES_MS"), "the limiter was retuned for paging");
    assert.match(ADAPTER_SRC, /process\.env\.AWIN_MIN_INTERVAL_MS \|\| 3000/, "the limiter interval moved");

    // Ordering, observed: page N+1 is only requested after page N has answered.
    const seen = [];
    const client = {
      calls: [],
      async get() { return { data: {} }; },
      async post(path, body) {
        seen.push(`start:${body.pagination.page}`);
        await new Promise((resolve) => setImmediate(resolve));
        seen.push(`end:${body.pagination.page}`);
        this.calls.push({ body });
        return { data: { data: body.pagination.page < 3 ? fullPage(body.pagination.page * 10) : [] } };
      },
    };
    await adapterOn(client).fetchCoupons({}, { requestCount: 0 });
    assert.deepEqual(seen, ["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
  });

  it("an explicitly pinned pagination is still ONE page and no walk", async () => {
    const client = spyTransport(() => ({ data: fullPage(1) }));
    const rows = await adapterOn(client).fetchCoupons({ pagination: { page: 4, pageSize: 25 } }, { requestCount: 0 });
    assert.equal(client.calls.length, 1, "a pinned page was walked");
    assert.deepEqual(client.calls[0].body, { filters: {}, pagination: { page: 4, pageSize: 25 } });
    assert.equal(rows.length, AWIN_OFFERS_PAGE_SIZE);
  });

  it("the three collection keys production reads are unchanged", async () => {
    for (const key of ["data", "promotions", "offers"]) {
      const client = spyTransport(() => ({ [key]: [promotion(1)] }));
      const rows = await adapterOn(client).fetchCoupons({}, { requestCount: 0 });
      assert.equal(rows.length, 1, key);
    }
    assert.match(ADAPTER_SRC, /extractCollection\(envelope, \["data", "promotions", "offers"\]\)/);
  });
});

/* ============================================================ nothing sensitive leaves the run */

describe("9A.0b-ii — the run carries evidence, never row data", () => {
  it("no promotion id, voucher code, name, URL, amount or publisher id reaches the metadata", async () => {
    const { outcome } = await walk((page) => ({
      data: page === 1 ? fullPage(6000) : [promotion(6999)],
      pagination: { page, pageSize: 200, total: 201, next: `https://api.awin.com/publisher/${PUBLISHER_ID}/x` },
    }));
    const serialised = JSON.stringify(outcome.metadata);
    for (const secret of [VOUCHER, "zzadvertisernamezz", PUBLISHER_ID, TOKEN, "awin1.com", "6543.21", "6000", "6999", "GBP"]) {
      assert.ok(!serialised.includes(secret), `${secret} escaped into the run`);
    }
    assert.deepEqual(Object.keys(paginationOf(outcome)).sort(), [
      "exhausted", "exhaustionReason", "pagesFetched", "supplierAssertedExhaustion",
    ]);
  });

  it("the page identity is local: it is never recorded, returned or logged", () => {
    const fetcher = codeOnly(ADAPTER_SRC).split("async fetchCoupons(")[1].split("\n    },")[0];
    assert.match(fetcher, /const identity = offersPageIdentity\(rows\);/);
    assert.ok(!/recordExhaustion\([^)]*identity/.test(fetcher), "the fingerprint reached the run");
    assert.ok(!fetcher.includes("console."), "the walk logs");
    assert.match(codeOnly(ADAPTER_SRC), /recordExhaustion\(stats, reason, \{ pagesFetched \}\);/);
    assert.ok(!codeOnly(ADAPTER_SRC).includes("seenPages }"), "the seen-page set is returned");
    assert.ok(!/recordExhaustion\([^)]*seenPages/.test(fetcher), "the seen-page set reached the run");
  });
});

/* =================================================================== certification is untouched */

describe("9A.0b-ii — certification is still one request and cannot inherit the walk", () => {
  it("the Awin certification spec is byte-identical: page 1, pageSize 200, no loop", () => {
    const start = ADAPTER_SRC.indexOf("  coupons: {");
    const spec = ADAPTER_SRC.slice(start, ADAPTER_SRC.indexOf("\n  },", start));
    assert.match(spec, /method: "POST_READONLY"/);
    assert.match(spec, /collectionKeys: \["data", "promotions", "offers"\],/);
    assert.match(spec, /body: \(\) => \(\{ filters: \{\}, pagination: \{ page: 1, pageSize: 200 \} \}\),/);
    assert.ok(!/for \(|while \(|page\+\+|hasMore|nextPage|AWIN_MAX_OFFER_PAGES/.test(spec), "the spec paginates");
  });

  it("the sampler builds its own request and never reaches the walking fetcher", () => {
    const sampler = ADAPTER_SRC.split("async fetchCertificationSample(")[1].split("\n    },")[0];
    for (const token of [
      "fetchCoupons", "fetchCampaigns", "AWIN_MAX_OFFER_PAGES",
      "offersPageIdentity", "awinOffersPaginationSignal",
      "page++", "page += 1", "hasMore", "nextPage", "while (",
    ]) {
      assert.ok(!sampler.includes(token), `${token} in the sampler`);
    }
    // Its ONLY loop validates the required ctx fields. It does not iterate pages.
    const loops = sampler.match(/for \([^)]*\)/g) ?? [];
    assert.deepEqual(loops, ["for (const need of spec.needs ?? [])"], "the sampler grew a loop");
    assert.ok(!sampler.includes("requestWithRetry"), "the probe inherited sync's retries");
    assert.match(sampler, /awinRateLimiter\.acquireSlot\(\)/);
  });

  it("the certification SERVICE still routes Awin through the one-request sampler", () => {
    const awinSample = CERT_SRC.split("async certifyAwinSample(")[1].split("\n  }")[0];
    assert.match(awinSample, /adapter\.fetchCertificationSample\(sourceObject, \{ timeoutMs \}\)/);
    for (const token of ["fetchCoupons", "fetchCampaigns", "AWIN_MAX_OFFER_PAGES"]) {
      assert.ok(!awinSample.includes(token), `${token} in certifyAwinSample`);
    }
  });

  it("a certification sample against a FULL page still makes exactly one request", async () => {
    // The condition that now makes production fetch page 2 must not make the probe do it.
    const client = spyTransport(() => ({ data: fullPage(1) }));
    const rows = await adapterOn(client).fetchCertificationSample("coupons", {});
    assert.equal(client.calls.length, 1, "certification followed the page");
    assert.deepEqual(client.calls[0].body, { filters: {}, pagination: { page: 1, pageSize: 200 } });
    assert.equal(rows.length, 1, "certification kept more than one row");
  });

  it("a certification campaigns sample is still one GET with relationship=joined", async () => {
    const client = spyTransport(() => ({ data: [] }));
    await adapterOn(client).fetchCertificationSample("campaigns", {});
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].method, "get");
    assert.deepEqual(client.calls[0].params, { relationship: "joined" });
  });
});

/* ============================================================ programmes, and the blast radius */

describe("9A.0b-ii — Awin programmes is UNCHANGED and remains UNKNOWN", () => {
  it("fetchCampaigns is still one request with relationship=joined and no pagination", async () => {
    const client = spyTransport(() => ({ programmes: [] }));
    await adapterOn(client).fetchCampaigns({});
    assert.equal(client.calls.length, 1);
    assert.deepEqual(client.calls[0].params, { relationship: "joined" });
    const fetcher = codeOnly(ADAPTER_SRC).split("async fetchCampaigns(")[1].split("\n    },")[0];
    for (const token of ["for (", "while (", "page", "limit", "offset", "cursor", "recordExhaustion"]) {
      assert.ok(!fetcher.includes(token), `${token} was invented on programmes`);
    }
  });

  it("the programmes run is deliberately NOT wrapped, because it has nothing truthful to record", () => {
    const programmes = SYNC_SRC.split('sourceObject: "programmes"')[1].split("});")[0];
    assert.match(programmes, /execute: \(\) => adapter\.fetchCampaigns\(\{\}, stats\),/);
    assert.ok(!programmes.includes("withSourceOutcome"), "programmes was given evidence it does not have");
    // And the reason is written down beside the offers run, not left to be rediscovered.
    const offers = SYNC_SRC.split('sourceObject: "offers"')[1].split("});")[0];
    assert.match(offers, /UNKNOWN and is not eligible for a reconciliation allow-list/);
  });

  it("the offers run is wrapped, with the cap's own stable code", () => {
    const offers = SYNC_SRC.split('sourceObject: "offers"')[1].split("});")[0];
    assert.match(offers, /withSourceOutcome\(stats, \(\) => adapter\.fetchCoupons\(\{\}, stats\), \{/);
    assert.match(offers, /truncationCode: AWIN_OFFERS_PAGE_CAP_CODE,/);
  });

  it("transactions, the 31-day rule and commission groups are untouched", () => {
    assert.match(ADAPTER_SRC, /if \(days > 31\.0001\) \{/);
    assert.match(ADAPTER_SRC, /export const AWIN_MAX_TRANSACTION_WINDOW_DAYS = 31;/);
    assert.match(ADAPTER_SRC, /dateType: params\.dateType \?\? "transaction"/);
    assert.match(ADAPTER_SRC, /showBasketProducts: params\.showBasketProducts !== false,/);
    const conversions = codeOnly(ADAPTER_SRC).split("async fetchConversions(")[1].split("\n    },")[0];
    for (const token of ["AWIN_MAX_OFFER_PAGES", "recordExhaustion", "offersPageIdentity"]) {
      assert.ok(!conversions.includes(token), `${token} reached transactions`);
    }
    const groups = codeOnly(ADAPTER_SRC).split("async fetchCommissionGroups(")[1].split("\n    },")[0];
    assert.ok(!groups.includes("for ("), "commission groups grew a pager");
    assert.match(SYNC_SRC, /execute: \(\) => adapter\.fetchConversions\(awinDateParams, stats\),/);
  });

  it("no schema, lifecycle, planner or orchestration change rides along", () => {
    for (const [name, source] of [["adapter", ADAPTER_SRC], ["sync", SYNC_SRC]]) {
      for (const forbidden of ["archivedAt", "plannerVersion", "PLANNER_VERSION", "ALTER TABLE", "$executeRaw", "JobRun", "refreshGeneration"]) {
        assert.ok(!source.includes(forbidden), `${forbidden} in ${name}`);
      }
    }
  });
});
