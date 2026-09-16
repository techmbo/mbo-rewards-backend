/**
 * Phase 6b — one PAGE of conversion promotion as one durable executable unit.
 *
 * A unit names a networkSource and an exclusive id cursor. It promotes at most one page and then
 * stops: the continuation is a separate durable unit, appended to the tail, not a loop.
 *
 * The boundary is the service's own: ConversionPromotionService.run already walks
 * Entity(entityType:"conversion") by `id: { gt: cursor }` ordered `id asc`, taking `batchSize`.
 * Nothing about a date window is invented here — the service has no date parameter, and giving it
 * one would mean choosing a field it never filters on.
 *
 * The one behaviour this module must override is the service's `for (;;)` loop: run() drains every
 * page before returning. A unit therefore calls run() with an explicit page size and compares the
 * processed count against it, which is exactly the service's own `batch.length < batchSize` stop
 * condition — see PAGE_SIZE below for why that comparison is sound.
 */

/**
 * The page a unit promotes. Fixed, not caller-supplied: it is part of the durable identity, and a
 * per-unit size would make two units for the same cursor mean different work.
 *
 * It matches the service's own default so a unit's page is the page the service would have taken.
 */
export const CONVERSION_PROMOTION_PAGE_SIZE = 100;

/** Descriptor fields that would make a unit something other than one page of one network. */
const FORBIDDEN_FIELDS = Object.freeze([
  // No date window: the service filters on no date field, so any of these would be inert at best
  // and a silent lie about what the unit covers at worst.
  "from",
  "to",
  "windowStart",
  "windowEnd",
  "day",
  "days",
  // An explicit id list bypasses the cursor: the page would no longer be "the next N after
  // cursorId", so the continuation could skip or repeat rows.
  "entityIds",
]);

export const CONVERSION_PROMOTION_REFUSAL_CODE = "invalid_conversion_promotion_unit";

function refuse(message) {
  const error = new Error(message);
  error.code = CONVERSION_PROMOTION_REFUSAL_CODE;
  error.statusCode = 422;
  return error;
}

/**
 * Resolve the page a unit names, or throw the refusal a worker surfaces.
 *
 * `cursorId` is absent or null for the first page and a non-empty string thereafter. It is
 * EXCLUSIVE: the service filters `id > cursor`, so a continuation carries the last id of the page
 * that produced it and no entity is promoted twice.
 */
export function resolveConversionPromotionPage(descriptor = {}) {
  const present = FORBIDDEN_FIELDS.filter(
    (field) => descriptor[field] !== undefined && descriptor[field] !== null && descriptor[field] !== "",
  );
  if (present.length) {
    throw refuse(
      `A conversion-promotion unit is one cursor page of one network; it must not carry ${present.join(", ")}.`,
    );
  }

  const { networkSource } = descriptor;
  if (typeof networkSource !== "string" || networkSource.trim() === "") {
    throw refuse("A conversion-promotion unit requires a networkSource.");
  }

  const { cursorId } = descriptor;
  if (cursorId !== undefined && cursorId !== null) {
    if (typeof cursorId !== "string" || cursorId.trim() === "") {
      throw refuse("A conversion-promotion unit's cursorId must be a non-empty id, or absent for the first page.");
    }
  }

  // A stored pageSize is honoured only if it equals the fixed size; anything else would make two
  // units for the same cursor cover different rows.
  const { pageSize } = descriptor;
  if (pageSize !== undefined && pageSize !== null && pageSize !== CONVERSION_PROMOTION_PAGE_SIZE) {
    throw refuse(`A conversion-promotion unit's pageSize is fixed at ${CONVERSION_PROMOTION_PAGE_SIZE}.`);
  }

  return {
    networkSource: networkSource.trim(),
    cursorId: cursorId == null ? null : cursorId.trim(),
    pageSize: CONVERSION_PROMOTION_PAGE_SIZE,
  };
}

/**
 * Whether the page that just ran leaves more work.
 *
 * `processed` counts every entity the page took, promoted or skipped alike, which is the page's
 * row count — the service increments it once per row before branching on the outcome. A full page
 * means there may be more; a short page is the end of the walk, which is the same condition the
 * service's own loop uses to stop.
 */
export function pageHasMore({ processed, pageSize = CONVERSION_PROMOTION_PAGE_SIZE } = {}) {
  return Number.isFinite(processed) && processed >= pageSize;
}

/**
 * Execute one page.
 *
 * `runPage` receives exactly the service's parameters for ONE page. `entityIds` is never passed:
 * the page is defined by the cursor alone.
 */
export async function executeConversionPromotionUnit(descriptor = {}, { runPage } = {}) {
  if (typeof runPage !== "function") {
    throw refuse("A conversion-promotion unit needs a page runner to execute.");
  }
  const page = resolveConversionPromotionPage(descriptor);

  const summary = await runPage({
    networkSource: page.networkSource,
    cursorId: page.cursorId ?? undefined,
    batchSize: page.pageSize,
  });

  const processed = Number.isFinite(summary?.processed) ? summary.processed : 0;
  const lastCursor = typeof summary?.lastCursor === "string" && summary.lastCursor !== "" ? summary.lastCursor : null;
  const hasMore = pageHasMore({ processed, pageSize: page.pageSize }) && lastCursor != null;

  return {
    networkSource: page.networkSource,
    cursorId: page.cursorId,
    pageSize: page.pageSize,
    processed,
    promoted: Number.isFinite(summary?.promoted) ? summary.promoted : 0,
    skipped: Number.isFinite(summary?.skipped) ? summary.skipped : 0,
    failed: Number.isFinite(summary?.failed) ? summary.failed : 0,
    lastCursor,
    nextCursor: hasMore ? lastCursor : null,
    hasMore,
  };
}

/**
 * The continuation, or null when the walk is finished.
 *
 * Exactly one unit, carrying the last id of the page that produced it as its exclusive cursor.
 * Never more than one, and never one that repeats this unit's own cursor.
 */
export function nextConversionPromotionUnit(result = {}, { kind } = {}) {
  if (!result?.hasMore) return null;
  const nextCursor = result.nextCursor;
  if (typeof nextCursor !== "string" || nextCursor === "") return null;
  if (nextCursor === result.cursorId) return null;
  return {
    kind,
    networkSource: result.networkSource,
    cursorId: nextCursor,
    pageSize: result.pageSize ?? CONVERSION_PROMOTION_PAGE_SIZE,
    options: {},
  };
}

/**
 * Safe outcome for the durable unit record: the page's position and its counts.
 * Never an entity id, a supplier conversion id, an order, a currency or an amount.
 */
export function summariseConversionPromotionUnitOutcome(result = {}) {
  return {
    kind: "conversion-promotion",
    networkSource: result.networkSource ?? null,
    counts: {
      processed: Number.isFinite(result.processed) ? result.processed : 0,
      promoted: Number.isFinite(result.promoted) ? result.promoted : 0,
      skipped: Number.isFinite(result.skipped) ? result.skipped : 0,
      failed: Number.isFinite(result.failed) ? result.failed : 0,
    },
    pageSize: result.pageSize ?? CONVERSION_PROMOTION_PAGE_SIZE,
    hasMore: Boolean(result.hasMore),
  };
}
