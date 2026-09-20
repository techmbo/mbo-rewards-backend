/**
 * An unbounded manual Awin offers sync is refused, not partly served.
 *
 * POST /api/sync/awin/default?sourceObject=offers used to walk 25 pages and stage 5,000 coupons
 * in one request, and timed out doing it. Making offers a durable paged source fixed the
 * orchestrated path — but left a trap on the manual one: with no slice supplied it would have
 * staged the first 200 offers and answered 200 OK, telling an operator who asked for the offers
 * catalogue that it had synced.
 *
 * So the manual call fails closed, before the supplier is called and before anything is staged.
 * The orchestrated call, which arrives carrying a page, is untouched.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AWIN_MIN_INTERVAL_MS = "1";

import { runWithSyncOptions } from "../src/jobs/syncContext.js";
import {
  syncAwinAccount,
  AWIN_OFFERS_DURABLE_SYNC_REQUIRED,
} from "../src/jobs/waveESupplierSync.js";

const SRC = new URL("../src/jobs/waveESupplierSync.js", import.meta.url);
const { readFileSync } = await import("node:fs");
const SYNC_SRC = readFileSync(SRC, "utf8");

/** The bounded slice an orchestrated unit carries. */
const boundedOptions = (offset = 0) => ({
  sourceObject: "offers",
  campaignPageOffset: offset,
  campaignPageLimit: 200,
  campaignPageBudget: 1,
});

/* ============================================================ the refusal itself */

describe("an unbounded manual offers sync is refused before any work", () => {
  it("returns the durable-sync code and does not fetch or stage", async () => {
    // No DATABASE_URL and no credentials exist in this environment, so ANY work at all would
    // throw or skip. Getting a clean refusal instead proves it happens FIRST — before the first
    // database read, before credentials, before the adapter, before the supplier.
    const result = await runWithSyncOptions({ sourceObject: "offers" }, () =>
      syncAwinAccount("default"),
    );
    assert.equal(result.skipped, true, "the call was not refused");
    assert.equal(result.code, AWIN_OFFERS_DURABLE_SYNC_REQUIRED);
    assert.match(result.reason, /durable sync orchestration/i);
    assert.match(result.reason, /one supplier page per unit/i);
    assert.match(result.reason, /Nothing was fetched or staged/i);
    // Nothing that would indicate work happened.
    assert.equal(result.coupons, undefined, "a refused sync reported coupon counts");
    assert.equal(result.offersStaging, undefined, "a refused sync reported staging");
    assert.equal(result.campaignPage, undefined, "a refused sync named a next page");
  });

  it("the refusal names a stable code an operator can match on", () => {
    assert.equal(AWIN_OFFERS_DURABLE_SYNC_REQUIRED, "AWIN_OFFERS_DURABLE_SYNC_REQUIRED");
  });

  it("the refusal is gated on the ABSENCE of a slice, not on the platform being Awin", () => {
    const code = SYNC_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.match(code, /if \(requestedSourceObject\(\) === "offers" && !boundedCampaignPage\(\)\) \{/);
    // And the guard sits before the adapter is created, so a refusal costs zero supplier calls.
    const guardAt = code.indexOf('requestedSourceObject() === "offers" && !boundedCampaignPage()');
    const flagsAt = code.indexOf('getNetworkAccountSyncFlags("awin"');
    const adapterAt = code.indexOf('createSupplierAdapter("AWIN"');
    assert.ok(guardAt > 0 && flagsAt > 0 && adapterAt > 0);
    assert.ok(guardAt < flagsAt, "the refusal happens after a database read");
    assert.ok(guardAt < adapterAt, "the refusal happens after the adapter is built");
  });

  it("the offers source object is skipped — never silently page-1'd — inside a full sync too", () => {
    const code = SYNC_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // The offers block runs only when a slice exists; the fallback to page 1 is gone.
    assert.match(code, /if \(includeSourceObject\(requested, "offers"\) && offersPage &&/);
    assert.ok(
      !/boundedCampaignPage\(\) \?\? \{ offset: 0/.test(code),
      "the silent first-page fallback is still present",
    );
    // A full sync that cannot do offers says so on the result rather than omitting it.
    assert.match(code, /offersRefused: offersRefusal/);
  });
});

/* ===================================================== the orchestrated path is untouched */

describe("a bounded durable unit still runs normally", () => {
  it("a slice-carrying call is NOT refused by the durable-sync guard", async () => {
    const result = await runWithSyncOptions(boundedOptions(0), () =>
      syncAwinAccount("default").catch((error) => ({ threw: error.message })),
    );
    // It goes on to meet this environment's own limits — no database, no credentials — which is
    // the point: it was allowed THROUGH the guard rather than refused by it.
    assert.notEqual(result.code, AWIN_OFFERS_DURABLE_SYNC_REQUIRED, "a bounded unit was refused");
  });

  it("a continuation slice at a later offset is equally allowed through", async () => {
    const result = await runWithSyncOptions(boundedOptions(4800), () =>
      syncAwinAccount("default").catch((error) => ({ threw: error.message })),
    );
    assert.notEqual(result.code, AWIN_OFFERS_DURABLE_SYNC_REQUIRED);
  });
});

/* ========================================================= other sources and platforms */

describe("nothing else is refused", () => {
  it("other Awin source objects are unaffected by the offers guard", async () => {
    for (const sourceObject of ["programmes", "transactions"]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await runWithSyncOptions({ sourceObject }, () =>
        syncAwinAccount("default").catch((error) => ({ threw: error.message })),
      );
      // Whatever happens next is this environment's business — what matters is that it is NOT
      // the offers refusal, i.e. the guard did not widen beyond the source object it names.
      assert.notEqual(
        result.code,
        AWIN_OFFERS_DURABLE_SYNC_REQUIRED,
        `${sourceObject} was refused by the offers guard`,
      );
    }
  });

  it("a full Awin sync is not refused outright — only its offers source object is held back", async () => {
    const result = await runWithSyncOptions({}, () =>
      syncAwinAccount("default").catch((error) => ({ threw: error.message })),
    );
    assert.notEqual(result.code, AWIN_OFFERS_DURABLE_SYNC_REQUIRED, "a full sync was refused");
  });

  it("no other platform's sync gained the guard", () => {
    for (const file of ["src/jobs/waveESupplierSync.js"]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      // Four LINES mention it: the export, the early refusal, the in-run refusal, the log
      // field. Counted by line rather than by match, because the export line names it twice.
      const lines = src.split("\n").filter((line) => line.includes("AWIN_OFFERS_DURABLE_SYNC_REQUIRED"));
      assert.equal(lines.length, 4, "the guard spread beyond the Awin offers path");
      // And every one of them sits at or after the export — none leaks into another network's
      // account sync earlier in the file.
      const exportAt = src.indexOf("export const AWIN_OFFERS_DURABLE_SYNC_REQUIRED");
      assert.ok(exportAt > 0);
      for (const line of lines.slice(1)) {
        assert.ok(src.indexOf(line) > exportAt, "the guard is referenced before it is declared");
      }
    }
    for (const file of [
      "src/jobs/trackierResourceSync.js",
      "src/jobs/admitadSupplierSync.js",
      "src/jobs/cjSupplierSync.js",
      "src/jobs/rakutenSupplierSync.js",
    ]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      assert.ok(!src.includes("AWIN_OFFERS_DURABLE_SYNC_REQUIRED"), `${file} gained the guard`);
      assert.ok(!src.includes("boundedCampaignPage"), `${file} became page-bounded`);
    }
  });
});

/* ====================================== the outer run must not read as success */

describe("an unscoped manual Awin sync is PARTIAL, not SUCCESS", () => {
  /** syncState's own partial rule and warning collector, applied to a result tree. */
  const hasPartialSuccess = (result) =>
    !!result &&
    typeof result === "object" &&
    (result.partialSuccess === true || Object.values(result).some(hasPartialSuccess));
  const collectWarnings = (result, out = []) => {
    if (!result || typeof result !== "object") return out;
    if (Array.isArray(result.warnings)) out.push(...result.warnings.filter(Boolean));
    for (const value of Object.values(result)) collectWarnings(value, out);
    return out;
  };

  it("the account result carries partialSuccess and a warning when offers are withheld", () => {
    // The shape syncAwinAccount returns once offers are refused inside an unscoped run.
    const accountResult = {
      programmes: 3,
      coupons: 0,
      offersRefused: { code: AWIN_OFFERS_DURABLE_SYNC_REQUIRED, reason: "…" },
      partialSuccess: true,
      warnings: ["Awin offers were not synced: …durable sync orchestration…"],
      userMessage: "Awin offers were not synced: …durable sync orchestration…",
    };
    assert.equal(accountResult.partialSuccess, true);
    assert.ok(accountResult.warnings.length > 0);
    assert.equal(hasPartialSuccess({ default: accountResult }), true);
  });

  it("the source sets all three fields together, from one warnings bag", () => {
    const code = SYNC_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.match(code, /partialSuccess: warnings\.length > 0,/);
    assert.match(code, /warnings,/);
    assert.match(code, /userMessage: warnings\.length > 0 \? joinUserMessages\(warnings\) : null,/);
    // And the withheld source object is what pushes into it.
    assert.match(code, /warnings\.push\(\s*"Awin offers were not synced/);
  });

  it("runExclusiveSync's own rules resolve such a result to partial, and surface the warning", () => {
    const result = {
      awin: {
        default: {
          programmes: 3,
          coupons: 0,
          offersRefused: { code: AWIN_OFFERS_DURABLE_SYNC_REQUIRED, reason: "…" },
          partialSuccess: true,
          warnings: ["Awin offers were not synced: durable sync orchestration required."],
        },
      },
    };
    assert.equal(hasPartialSuccess(result), true, "the outer run would have reported success");
    const warnings = collectWarnings(result);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /offers were not synced/i);
    assert.match(warnings[0], /durable sync orchestration/i);
  });

  it("a run with nothing withheld is NOT partial", () => {
    const clean = { awin: { default: { programmes: 3, coupons: 200, partialSuccess: false, warnings: [] } } };
    assert.equal(hasPartialSuccess(clean), false);
    assert.deepEqual(collectWarnings(clean), []);
  });

  it("a bounded durable unit is not made partial merely by being one page", () => {
    const code = SYNC_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Two things may push a warning, and NEITHER can fire for a mid-walk slice:
    //   the durable-sync refusal, which requires there to be NO bounded page at all; and
    //   a PARTIAL offers source run, which only a TERMINAL page can produce — a mid-walk slice
    //   records no exhaustion, so its run is SUCCESS.
    const pushes = [...code.matchAll(/warnings\.push\(/g)];
    assert.equal(pushes.length, 2, "an unguarded warning source appeared");
    const refusalGuard = code.indexOf('includeSourceObject(requested, "offers") && !offersPage');
    const partialGuard = code.indexOf('offersSummary?.status === "PARTIAL"');
    assert.ok(refusalGuard > 0 && partialGuard > 0, "a guard is missing");
    // Each push sits after one of the two guards, and nowhere else.
    for (const push of pushes) {
      const guarded = push.index > refusalGuard || push.index > partialGuard;
      assert.ok(guarded, "a warning is pushed outside both guards");
    }
    assert.ok(pushes[0].index > refusalGuard, "the refusal warning left its branch");
    assert.ok(pushes[1].index > partialGuard, "the partial warning left its branch");
  });

  it("the offers-only refusal still reports skipped, not partial", async () => {
    const result = await runWithSyncOptions({ sourceObject: "offers" }, () =>
      syncAwinAccount("default"),
    );
    assert.equal(result.skipped, true);
    assert.equal(result.code, AWIN_OFFERS_DURABLE_SYNC_REQUIRED);
    // A refused offers-only call did no work at all; it is not a partly-completed sync.
    assert.equal(result.partialSuccess, undefined, "a zero-work refusal reported partial success");
    assert.equal(result.warnings, undefined);
  });
});
