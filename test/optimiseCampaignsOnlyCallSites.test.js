import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { functionBody, guardsFor } from "./helpers/jsGuardScan.js";

const source = await readFile(new URL("../src/jobs/sync.job.js", import.meta.url), "utf8");
const body = functionBody(source, "syncOptimiseRegion");

/**
 * The production failure this pins: a bounded campaigns unit reached its 300s limit because every
 * downstream write ran regardless of which source object the unit named. Each entry below is a
 * call the unit must not reach, and the flag that must control it.
 */
const GUARDED_CALLS = [
  ["externalIdPrefix: `${networkSource}-campaign`", "persistCampaigns"],
  ["cleanupOptimiseCampaignDuplicates(", "walkedWholeCampaignCatalog"],
  ["externalIdPrefix: `${networkSource}-report`", "wantsReporting"],
  ["externalIdPrefix: `${networkSource}-invoice-report`", "wantsInvoiceReporting"],
  ["promotePerformanceRowsToFacts(", "touchedPerformance"],
  ["enrichFactsWithMboLinkClicks(", "touchedPerformance"],
  ["externalIdPrefix: `${networkSource}-conversion`", "wantsConversions"],
  ["externalIdPrefix: `${networkSource}-conversion-by-payment`", "wantsConversionsByPayment"],
  ["enrichFactsWithConversionCoupons(", "touchedConversions"],
  ["externalIdPrefix: `${networkSource}-payment`", "wantsPayments"],
  ["externalIdPrefix: `${networkSource}-invoice`", "wantsInvoices"],
  ["externalIdPrefix: `${networkSource}-voucher`", "persistVouchers"],
  ["resolveDetailedPrecedence(", "needsDetailedPrecedence"],
];

for (const [needle, flag] of GUARDED_CALLS) {
  test(`${needle.trim()} runs only under ${flag}`, () => {
    const guards = guardsFor(body, needle);
    assert.equal(guards.length, 1, `${needle} should have exactly one call site`);
    assert.ok(
      guards[0].includes(flag),
      `${needle} must be controlled by ${flag}; controlling conditions were:\n${guards[0]}`,
    );
  });
}

test("the scanner really can tell a guarded call from an unguarded one", () => {
  const sample = `async function f() {
  const tag = \`{ not a block }\`;
  await always();
  if (allowed) {
    await sometimes();
  }
  const x = flagged ? await ternary() : null;
}`;
  const sampleBody = functionBody(sample, "f");
  assert.ok(!guardsFor(sampleBody, "always(")[0].includes("allowed"));
  assert.ok(guardsFor(sampleBody, "sometimes(")[0].includes("allowed"));
  assert.ok(guardsFor(sampleBody, "ternary(")[0].includes("flagged"));
});

test("a template literal's ${} is not mistaken for a block", () => {
  const sample = `async function f() {
  if (allowed) {
    await inner(\`\${a}-\${b}\`);
  }
  await outer();
}`;
  const sampleBody = functionBody(sample, "f");
  assert.ok(guardsFor(sampleBody, "inner(")[0].includes("allowed"));
  assert.ok(!guardsFor(sampleBody, "outer(")[0].includes("allowed"));
});

test("the incremental watermark is computed, not asserted, at the call site", () => {
  const guards = guardsFor(body, "advanceLastSuccessfulSync:");
  assert.equal(guards.length, 1);
  assert.ok(
    body.includes("optimiseAdvanceWatermark({ requested, warningCount: warnings.length })"),
    "the watermark decision must stay in the tested pure helper",
  );
});

test("the campaign catalog stamp is computed by the tested pure helper", () => {
  assert.ok(body.includes("optimiseCampaignCatalogWalked({"));
  assert.ok(
    body.includes("refreshedCampaigns: walkedWholeCampaignCatalog"),
    "lastCampaignSyncAt must be stamped from the whole-catalog decision, not from the TTL flag",
  );
});

test("the duplicate sweep and the catalog stamp share one decision", () => {
  const occurrences = body.split("optimiseCampaignCatalogWalked({").length - 1;
  assert.equal(occurrences, 1, "the whole-catalog decision must be made once, not re-derived");
  assert.ok(
    guardsFor(body, "cleanupOptimiseCampaignDuplicates(")[0].includes("walkedWholeCampaignCatalog"),
    "the account-wide sweep must not fire on a partial slice",
  );
});

// ---------------------------------------------------------------------------
// Two latent defects this patch removed. Both lived in a local of an
// un-exported function, so they are pinned where they were written.
// ---------------------------------------------------------------------------

test("syncOptimiseRegion never touches an undeclared `result`", () => {
  // The function declares no `result`, so any bare `result` token in it is a free variable and
  // throws a ReferenceError under ESM strict mode. It did, on every Optimise sync, right after
  // coupon enrichment and before payments persistence, the timestamp write and the return.
  assert.equal(
    /(^|[^.\w$])result\s*(\.|=[^=]|\[)/.test(body),
    false,
    "syncOptimiseRegion must not read or assign a free `result`",
  );
  // The regex must be able to see the defect it guards against.
  assert.equal(/(^|[^.\w$])result\s*(\.|=[^=]|\[)/.test("  result.x = 1;"), true);
  // ...without tripping over the locals whose names merely end in "Result".
  assert.equal(/(^|[^.\w$])result\s*(\.|=[^=]|\[)/.test("  campaignsResult.rows;"), false);
});

function objectLiteral(text, declaration) {
  const start = text.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} not found`);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error(`${declaration} is unbalanced`);
}

test("savedCounts holds only row counts, so totalSaved stays a number", () => {
  // campaignPage is an object. While it lived in savedCounts, the totalSaved reduce produced a
  // string for every bounded slice, and the "every resource failed" guard could never fire.
  const literal = objectLiteral(body, "const savedCounts = {");
  assert.equal(
    literal.includes("campaignPage"),
    false,
    "campaignPage must not be summed with the row counts",
  );
  assert.ok(
    body.includes("const totalSaved = Object.values(savedCounts).reduce("),
    "totalSaved must still sum savedCounts",
  );
  assert.ok(
    body.includes("campaignPage: campaignPagination"),
    "the slice pagination must still reach the orchestrator on the result",
  );
});
