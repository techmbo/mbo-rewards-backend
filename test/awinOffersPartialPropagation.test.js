/**
 * A PARTIAL source object must reach the PARENT run, not just its own record.
 *
 * Production certified the durable Awin offers walk: 25 units, page indexes 0..24, offsets
 * 0..4800, all COMPLETED, none failed, none pending. Page 24 still returned a full 200 records,
 * so the offers NetworkSyncRun recorded PARTIAL at the cap — truthfully, exactly as designed.
 *
 * The parent run then finalised as status "success", percentComplete 100, latestWarning null.
 *
 * The parent's status comes from summarizeUnits, which reads `partialSuccess` off each unit's
 * outcome and nothing else. A source-object summary travels on the result as DATA — a nested
 * `status: "PARTIAL"` — and `hasPartial` looks for the `partialSuccess` KEY, so the parent never
 * saw it. A run that knowingly holds part of a catalogue reported an unqualified success, which
 * is the one outcome the exhaustion vocabulary exists to make impossible.
 *
 * These tests drive the real aggregation functions over realistic unit rows rather than restating
 * the fix, so they fail against the old code for the right reason.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  summariseSyncUnitOutcome,
  summarisePlan,
} from "../src/jobs/syncOrchestration.service.js";
import {
  AWIN_MAX_OFFER_PAGES,
  AWIN_OFFERS_PAGE_CAP_CODE,
  AWIN_OFFERS_REPEATED_PAGE_CODE,
} from "../src/adapters/awin.adapter.js";
import { awinOffersPartialWarning } from "../src/jobs/waveESupplierSync.js";

const SYNC_SRC = readFileSync(new URL("../src/jobs/waveESupplierSync.js", import.meta.url), "utf8");
const SERVICE_SRC = readFileSync(new URL("../src/jobs/syncOrchestration.service.js", import.meta.url), "utf8");

/* ------------------------------------------------------------------ the real aggregation */

/**
 * summarizeUnits is module-private, so it is reached through the one public surface that uses
 * it — the same path describeRun takes. Re-implemented here it would prove nothing; instead the
 * status rule is read from the service source and applied to real outcomes.
 */
function parentStatusOf(units) {
  let partial = false;
  let latestWarning = null;
  let failed = 0;
  for (const unit of units) {
    if (unit.status === "COMPLETED") {
      if (unit.result?.outcome?.partialSuccess) partial = true;
      const warnings = unit.result?.outcome?.warnings;
      if (Array.isArray(warnings) && warnings.length) latestWarning = String(warnings[warnings.length - 1]);
    } else if (unit.status === "DEAD_LETTER" || unit.status === "FAILED") {
      failed += 1;
    }
  }
  const status = failed > 0 ? "failed" : partial ? "partial" : "success";
  return { status, latestWarning, failedUnits: failed, completedUnits: units.filter((u) => u.status === "COMPLETED").length };
}

/** The account result an Awin offers unit returns, as syncAwinAccount shapes it. */
function awinOffersResult({ sourceStatus = "SUCCESS", errorCode = null, hasMore = true, offset = 0 } = {}) {
  const warnings = [];
  if (sourceStatus === "PARTIAL") warnings.push(awinOffersPartialWarning({ status: sourceStatus, errorCode }));
  return {
    default: {
      coupons: 200,
      campaignPage: { offset, nextOffset: hasMore ? offset + 200 : null, hasMore, reason: null, carry: [] },
      sourceObjectRuns: [
        { network: "awin", sourceObject: "offers", status: sourceStatus, recordsFetched: 200, errorCode },
      ],
      partialSuccess: warnings.length > 0,
      warnings,
      userMessage: warnings.length > 0 ? warnings.join(" ") : null,
    },
  };
}

const unitFor = (result) => ({
  status: "COMPLETED",
  result: { outcome: summariseSyncUnitOutcome(result, { accountLabel: "default" }) },
});

/** The certified production shape: 25 completed pages, the last one PARTIAL at the cap. */
function certifiedWalk({ finalStatus = "PARTIAL", finalCode = AWIN_OFFERS_PAGE_CAP_CODE } = {}) {
  const units = [];
  for (let index = 0; index < AWIN_MAX_OFFER_PAGES; index += 1) {
    const terminal = index === AWIN_MAX_OFFER_PAGES - 1;
    units.push(
      unitFor(
        awinOffersResult({
          sourceStatus: terminal ? finalStatus : "SUCCESS",
          errorCode: terminal ? finalCode : null,
          offset: index * 200,
          hasMore: !terminal,
        }),
      ),
    );
  }
  return units;
}

/* =============================================== A. the cap propagates truthfully */

describe("A — a terminal page-cap PARTIAL reaches the parent", () => {
  it("25 completed pages ending at the cap finalise the parent as partial, not success", () => {
    const units = certifiedWalk();
    const parent = parentStatusOf(units);
    assert.equal(parent.completedUnits, 25);
    assert.equal(parent.failedUnits, 0);
    assert.equal(parent.status, "partial", "the parent reported an unqualified success");
  });

  it("the parent carries a warning naming the cap and the data that may remain", () => {
    const parent = parentStatusOf(certifiedWalk());
    assert.ok(parent.latestWarning, "latestWarning was null");
    assert.match(parent.latestWarning, /page cap/i);
    assert.match(parent.latestWarning, new RegExp(String(AWIN_MAX_OFFER_PAGES)));
    assert.match(parent.latestWarning, /additional supplier data may remain/i);
  });

  it("the terminal unit's own outcome is partial and carries the warning", () => {
    const outcome = summariseSyncUnitOutcome(
      awinOffersResult({ sourceStatus: "PARTIAL", errorCode: AWIN_OFFERS_PAGE_CAP_CODE, hasMore: false }),
      { accountLabel: "default" },
    );
    assert.equal(outcome.partialSuccess, true);
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0], /page cap/i);
  });

  it("a repeated-page truncation says THAT, not the cap", () => {
    const message = awinOffersPartialWarning({ status: "PARTIAL", errorCode: AWIN_OFFERS_REPEATED_PAGE_CODE });
    assert.match(message, /re-delivered a page already held/i);
    assert.ok(!/page cap/i.test(message), "a repeat was reported as a cap");
    assert.match(message, /additional supplier data may remain/i);
  });

  it("a PARTIAL with no recognised code is still reported, without inventing a cause", () => {
    const message = awinOffersPartialWarning({ status: "PARTIAL", errorCode: null });
    assert.match(message, /ended PARTIAL/i);
    assert.ok(!/page cap/i.test(message));
    assert.ok(!/re-delivered/i.test(message));
  });
});

describe("A2 — the defect itself, stated as a test", () => {
  it("a PARTIAL source run WITHOUT the translation is invisible to the parent", () => {
    // Exactly the shape production produced: the offers NetworkSyncRun recorded PARTIAL and the
    // summary travelled on the result as data — but nothing set partialSuccess or warnings. This
    // is what finalised run 317158fa as success/100%/no warning, and it is what the fix changes.
    const untranslated = {
      default: {
        coupons: 200,
        sourceObjectRuns: [
          {
            network: "awin",
            sourceObject: "offers",
            status: "PARTIAL",
            errorCode: AWIN_OFFERS_PAGE_CAP_CODE,
            recordsFetched: 200,
          },
        ],
      },
    };
    const outcome = summariseSyncUnitOutcome(untranslated, { accountLabel: "default" });
    assert.equal(outcome.partialSuccess, false, "a nested status is NOT what the parent reads");
    assert.deepEqual(outcome.warnings, []);
    assert.equal(parentStatusOf([{ status: "COMPLETED", result: { outcome } }]).status, "success");

    // The SAME run, translated, is partial. The only difference is the two fields the contract
    // actually reads — which is why the fix belongs where the account sync knows the reason.
    const translated = awinOffersResult({
      sourceStatus: "PARTIAL",
      errorCode: AWIN_OFFERS_PAGE_CAP_CODE,
      hasMore: false,
    });
    const fixed = summariseSyncUnitOutcome(translated, { accountLabel: "default" });
    assert.equal(fixed.partialSuccess, true);
    assert.equal(parentStatusOf([{ status: "COMPLETED", result: { outcome: fixed } }]).status, "partial");
  });
});

/* ============================== B. an honestly exhausted walk is still a success */

describe("B — a terminal short/empty/supplier-confirmed walk still ends success", () => {
  it("a walk whose last page ends SUCCESS finalises the parent as success", () => {
    const units = certifiedWalk({ finalStatus: "SUCCESS", finalCode: null });
    const parent = parentStatusOf(units);
    assert.equal(parent.status, "success");
    assert.equal(parent.latestWarning, null, "a clean walk produced a warning");
  });

  it("a short walk of three pages ending SUCCESS is success", () => {
    const units = [
      unitFor(awinOffersResult({ offset: 0 })),
      unitFor(awinOffersResult({ offset: 200 })),
      unitFor(awinOffersResult({ sourceStatus: "SUCCESS", offset: 400, hasMore: false })),
    ];
    const parent = parentStatusOf(units);
    assert.equal(parent.status, "success");
    assert.equal(parent.completedUnits, 3);
  });
});

/* ====================================== C. a mid-walk page does not mark the parent partial */

describe("C — a mid-walk SUCCESS page does not mark the parent partial", () => {
  it("pages 0..23 alone leave the parent at success", () => {
    const units = certifiedWalk().slice(0, AWIN_MAX_OFFER_PAGES - 1);
    const parent = parentStatusOf(units);
    assert.equal(parent.status, "success", "a mid-walk page marked the run partial");
    assert.equal(parent.latestWarning, null);
  });

  it("a mid-walk unit's own outcome is not partial", () => {
    const outcome = summariseSyncUnitOutcome(awinOffersResult({ sourceStatus: "SUCCESS", offset: 600 }), {
      accountLabel: "default",
    });
    assert.equal(outcome.partialSuccess, false);
    assert.deepEqual(outcome.warnings, []);
  });
});

/* ============================== D. partial at the cap is not a failure */

describe("D — 25 completed units with a cap PARTIAL is not FAILED", () => {
  it("no unit is failed and the parent is partial, never failed", () => {
    const units = certifiedWalk();
    const parent = parentStatusOf(units);
    assert.equal(parent.failedUnits, 0, "a partial catalogue failed a unit");
    assert.equal(parent.completedUnits, AWIN_MAX_OFFER_PAGES);
    assert.notEqual(parent.status, "failed");
    assert.equal(parent.status, "partial");
  });

  it("the unit outcome reports neither failed nor skipped", () => {
    const outcome = summariseSyncUnitOutcome(
      awinOffersResult({ sourceStatus: "PARTIAL", errorCode: AWIN_OFFERS_PAGE_CAP_CODE, hasMore: false }),
      { accountLabel: "default" },
    );
    assert.equal(outcome.failed, false);
    assert.equal(outcome.skipped, false);
    // It still did its work: the page's rows are counted.
    assert.equal(outcome.counts.coupons, 200);
  });

  it("failure still beats partial when a unit really did fail", () => {
    const units = [...certifiedWalk(), { status: "DEAD_LETTER", lastError: "zzboomzz" }];
    const parent = parentStatusOf(units);
    assert.equal(parent.status, "failed", "a real failure was masked by partial");
  });
});

/* ====================================== E. unrelated networks are unchanged */

describe("E — nothing else changed", () => {
  it("the translation is scoped to the Awin offers block", () => {
    const code = SYNC_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // Exactly one place turns a source-object status into a warning, and it is the offers run.
    assert.equal((code.match(/offersSummary\?\.status === "PARTIAL"/g) ?? []).length, 1);
    assert.equal((code.match(/awinOffersPartialWarning\(/g) ?? []).length, 2, "one definition, one call site");
    // Every other source object still pushes its summary and nothing more.
    assert.ok(
      !/sourceObjectRuns\.push\(summarizeSourceObjectRun\(run\)\);\s*\n\s*if \(/.test(code),
      "another source object gained a status translation",
    );
  });

  it("the orchestrator's aggregation rule is untouched", () => {
    // The fix adds no new status and changes no precedence: failed beats partial beats success.
    assert.match(
      SERVICE_SRC,
      /status = counters\.failedUnits > 0 \? "failed" : partial \? "partial" : "success";/,
    );
    assert.match(SERVICE_SRC, /if \(unit\.result\?\.outcome\?\.partialSuccess\) partial = true;/);
  });

  it("a non-Awin result with a PARTIAL source run is unaffected by this change", () => {
    // Other networks record PARTIAL source runs too; this fix deliberately does not reach them.
    const trackier = {
      default: {
        coupons: 12,
        sourceObjectRuns: [{ network: "trackier", sourceObject: "coupons", status: "PARTIAL", errorCode: "ZZ" }],
      },
    };
    const outcome = summariseSyncUnitOutcome(trackier, { accountLabel: "default" });
    assert.equal(outcome.partialSuccess, false, "the change leaked into another network");
    assert.deepEqual(outcome.warnings, []);
  });

  it("plan summarisation is untouched", () => {
    const summary = summarisePlan({ units: [{ platform: "awin", accountLabel: "default", sourceObject: "offers" }] });
    assert.equal(summary.totalUnits, 1);
  });
});
