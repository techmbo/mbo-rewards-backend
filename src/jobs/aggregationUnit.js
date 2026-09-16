/**
 * Phase 6a — one aggregation DAY as one durable executable unit.
 *
 * The audited reason this module exists at all: a day unit must run
 * `AggregationJob.rebuild({ from: day, to: day })`, never `runForDate(day)`.
 * `AggregationService.rebuild` deletes the DailyReport rows in the range and then re-aggregates;
 * `runForDate` only upserts. A day rebuilt with `runForDate` alone keeps every DailyReport
 * dimension that existed before but no longer has source rows — stale finance-visible numbers
 * that nothing later removes. Verified again against the current implementation before this was
 * written, and pinned by a test.
 *
 * A unit executes exactly one day. It never widens to a range, never walks to the next day, and
 * makes no supplier calls: aggregation reads Click and Conversion and writes DailyReport.
 */

/** A calendar day, and nothing else: no time, no offset, no range. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Descriptor fields that would make a unit a RANGE. Their presence is a refusal, not a hint. */
const RANGE_FIELDS = Object.freeze(["from", "to", "windowStart", "windowEnd", "days"]);

export const AGGREGATION_UNIT_REFUSAL_CODE = "invalid_aggregation_unit";

function refuse(message) {
  const error = new Error(message);
  error.code = AGGREGATION_UNIT_REFUSAL_CODE;
  error.statusCode = 422;
  return error;
}

/**
 * Whether a string is a real calendar day, not merely digit-shaped.
 * "2026-02-30" and "2026-13-01" match the pattern and are still not days.
 */
function isRealCalendarDay(day) {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === day;
}

/**
 * Resolve the single day an aggregation unit names, or throw the refusal a worker surfaces.
 *
 * Refuses a missing day, a malformed or impossible day, a day carrying a time or offset, and a
 * descriptor that names a range instead of a day.
 */
export function resolveAggregationDay(descriptor = {}) {
  const present = RANGE_FIELDS.filter(
    (field) => descriptor[field] !== undefined && descriptor[field] !== null && descriptor[field] !== "",
  );
  if (present.length) {
    throw refuse(
      `An aggregation unit is one day; it must not carry a range (${present.join(", ")}).`,
    );
  }

  const { day } = descriptor;
  if (day === undefined || day === null || day === "") {
    throw refuse("An aggregation unit requires a day.");
  }
  if (typeof day !== "string" || !DAY_PATTERN.test(day)) {
    throw refuse("An aggregation unit's day must be a YYYY-MM-DD calendar day.");
  }
  if (!isRealCalendarDay(day)) {
    throw refuse(`An aggregation unit's day must be a real calendar day; "${day}" is not.`);
  }
  return day;
}

/**
 * Execute one aggregation unit.
 *
 * `runRebuild` receives exactly `{ from: day, to: day }` — the equality is asserted here rather
 * than assumed, so a future caller cannot widen a unit into a range without a test failing.
 */
export async function executeAggregationUnit(descriptor = {}, { runRebuild } = {}) {
  if (typeof runRebuild !== "function") {
    throw refuse("An aggregation unit needs a rebuild function to execute.");
  }
  const day = resolveAggregationDay(descriptor);

  // The literal that makes this one day and not a range. Pinned by a test that asserts the exact
  // argument, so widening it here fails loudly rather than quietly rebuilding a window.
  const result = await runRebuild({ from: day, to: day });
  return { day, result: result ?? null };
}

/**
 * Safe outcome for the durable unit record: counts and the day only.
 * Never a client id, a merchant, a campaign or a monetary value.
 */
export function summariseAggregationUnitOutcome({ day, result } = {}) {
  // The bare outcome: completeUnit stores it as `result.outcome`, so returning a wrapper here
  // would nest it twice and hide the day from the status API.
  const source = result ?? {};
  return {
    kind: "aggregation",
    day: day ?? null,
    counts: {
      daysProcessed: Number.isFinite(source.daysProcessed) ? source.daysProcessed : null,
      rowsUpserted: Number.isFinite(source.rowsUpserted) ? source.rowsUpserted : null,
      rowsDeleted: Number.isFinite(source.rowsDeleted) ? source.rowsDeleted : null,
    },
    grain: typeof source.grain === "string" ? source.grain : null,
  };
}
