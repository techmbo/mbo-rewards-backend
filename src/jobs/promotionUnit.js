/**
 * Phase 6c — one PAGE of entity promotion as one durable executable unit.
 *
 * A unit names ONE networkSource, ONE entityType and an exclusive id cursor. It promotes at most
 * one page and then stops: the continuation is a separate durable unit appended to the tail, not
 * a loop.
 *
 * Three things make this different from the conversion-promotion page:
 *
 * 1. The durable walk is keyset by PRIMARY KEY ONLY. The legacy PromotionJob.run walk orders by
 *    [updatedAt asc, id asc] and positions with a Prisma `cursor` plus `skip: 1`, which requires
 *    the cursor ROW to still exist and to still sort where it did. A concurrent re-stage bumps
 *    updatedAt and moves that row to the end of the ordering, and the next page then resumes from
 *    the wrong place. `id` is immutable, so ordering by it alone is a stable total order and a
 *    page boundary that survives anything written between two invocations.
 *
 * 2. entityType is part of the unit, never a list. A multi-type page would interleave campaigns
 *    and coupons under one cursor, and coupon promotion REQUIRES its parent SupplierCampaign to
 *    exist already — it connects to it by id and fails when it does not. One type per unit keeps
 *    that dependency expressible as unit ordering instead of luck.
 *
 * 3. The Rakuten commission work is NOT a once-per-run hook here. Audited, it is a per-OFFER
 *    promotion: it reads Entity(entityType "offer", networkSource "rakuten"), resolves each
 *    offer's promoted SupplierCampaign and writes SupplierCommissionRule. The legacy job merely
 *    invoked it once per call because its walk was internal (and capped at 5000 rows). Bounded, it
 *    is simply a third entityType walked by the same cursor, so it runs exactly once per offer,
 *    can never fire from a campaign or coupon page, and needs no once-only flag to prove it.
 */

/**
 * The page a unit promotes. Fixed, not caller-supplied: it is part of the durable identity, and a
 * per-unit size would make two units for the same cursor mean different work.
 *
 * Half the legacy PROMOTION_BATCH_SIZE, deliberately. A campaign entity costs far more than a
 * conversion row: a supplier lookup, a raw-payload lookup, an interactive transaction holding an
 * upsert plus outbox append plus lineage update, a mapper-error lookup, and then normalisation
 * (merchant matching, possible merchant creation, a campaign update, catalog linking). That is
 * roughly 12 to 18 serial queries per entity. At 50 the page costs order 600 to 900 queries,
 * which leaves real margin inside a 300s invocation even when the database is contended; at 100
 * the margin disappears under contention. Nothing here runs in parallel, so a page occupies one
 * connection plus its transaction, well inside the pool budget.
 */
export const PROMOTION_PAGE_SIZE = 50;

/** The entity types a bounded promotion unit may walk. Exactly one per unit. */
export const PROMOTION_ENTITY_TYPES = Object.freeze(["campaign", "coupon", "offer"]);

/**
 * `offer` exists only as Rakuten commission source evidence. Pinning it to that network is what
 * makes it impossible for another network's page to reach the Rakuten commission writer.
 */
export const OFFER_ENTITY_TYPE = "offer";
export const OFFER_NETWORK_SOURCE = "rakuten";

/** Descriptor fields that would make a unit something other than one page of one type. */
const FORBIDDEN_FIELDS = Object.freeze([
  // No date window: the promotion walk filters on no date field, so any of these would be inert at
  // best and a silent lie about what the unit covers at worst.
  "from",
  "to",
  "windowStart",
  "windowEnd",
  "day",
  "days",
  // An explicit id list bypasses the cursor: the page would no longer be "the next N after
  // cursorId", so the continuation could skip or repeat rows.
  "entityIds",
  // The plural is the legacy multi-type call shape. A durable unit walks ONE type.
  "entityTypes",
]);

export const PROMOTION_REFUSAL_CODE = "invalid_promotion_unit";

function refuse(message) {
  const error = new Error(message);
  error.code = PROMOTION_REFUSAL_CODE;
  error.statusCode = 422;
  return error;
}

/**
 * Resolve the page a unit names, or throw the refusal a worker surfaces. Every check here happens
 * BEFORE any database work: an invalid unit must cost nothing.
 */
export function resolvePromotionPage(descriptor = {}) {
  const present = FORBIDDEN_FIELDS.filter(
    (field) => descriptor[field] !== undefined && descriptor[field] !== null && descriptor[field] !== "",
  );
  if (present.length) {
    throw refuse(
      `A promotion unit is one cursor page of one entity type; it must not carry ${present.join(", ")}.`,
    );
  }

  const { networkSource } = descriptor;
  if (typeof networkSource !== "string" || networkSource.trim() === "") {
    throw refuse("A promotion unit requires a networkSource.");
  }

  const { entityType } = descriptor;
  if (Array.isArray(entityType)) {
    throw refuse("A promotion unit walks exactly one entityType, never a list.");
  }
  if (typeof entityType !== "string" || !PROMOTION_ENTITY_TYPES.includes(entityType)) {
    throw refuse(`A promotion unit's entityType must be one of ${PROMOTION_ENTITY_TYPES.join(", ")}.`);
  }

  const network = networkSource.trim();
  if (entityType === OFFER_ENTITY_TYPE && network.toLowerCase() !== OFFER_NETWORK_SOURCE) {
    throw refuse(
      `The ${OFFER_ENTITY_TYPE} entity type is ${OFFER_NETWORK_SOURCE} commission evidence and belongs to no other network.`,
    );
  }

  const { cursorId } = descriptor;
  if (cursorId !== undefined && cursorId !== null) {
    if (typeof cursorId !== "string" || cursorId.trim() === "") {
      throw refuse("A promotion unit's cursorId must be a non-empty id, or absent for the first page.");
    }
  }

  // A stored pageSize is honoured only if it equals the fixed size; anything else would make two
  // units for the same cursor cover different rows.
  const { pageSize } = descriptor;
  if (pageSize !== undefined && pageSize !== null && pageSize !== PROMOTION_PAGE_SIZE) {
    throw refuse(`A promotion unit's pageSize is fixed at ${PROMOTION_PAGE_SIZE}.`);
  }

  return {
    networkSource: network,
    entityType,
    cursorId: cursorId == null ? null : cursorId.trim(),
    pageSize: PROMOTION_PAGE_SIZE,
  };
}

/**
 * Whether the page that just ran leaves more work.
 *
 * `processed` counts every entity the page took, promoted or skipped alike. A full page means
 * there may be more; a short page is the end of the walk.
 */
export function promotionPageHasMore({ processed, pageSize = PROMOTION_PAGE_SIZE } = {}) {
  return Number.isFinite(processed) && processed >= pageSize;
}

/**
 * Execute one page.
 *
 * `runPage` receives exactly the parameters for ONE page. `entityIds` and `entityTypes` are never
 * passed: the page is defined by one type and the cursor alone.
 */
export async function executePromotionUnit(descriptor = {}, { runPage } = {}) {
  if (typeof runPage !== "function") {
    throw refuse("A promotion unit needs a page runner to execute.");
  }
  const page = resolvePromotionPage(descriptor);

  const summary = await runPage({
    networkSource: page.networkSource,
    entityType: page.entityType,
    cursorId: page.cursorId ?? undefined,
    batchSize: page.pageSize,
  });

  const count = (value) => (Number.isFinite(value) ? value : 0);
  const processed = count(summary?.processed);
  const lastCursor =
    typeof summary?.lastCursor === "string" && summary.lastCursor !== "" ? summary.lastCursor : null;
  const hasMore = promotionPageHasMore({ processed, pageSize: page.pageSize }) && lastCursor != null;

  return {
    networkSource: page.networkSource,
    entityType: page.entityType,
    cursorId: page.cursorId,
    pageSize: page.pageSize,
    processed,
    promoted: count(summary?.promoted),
    skipped: count(summary?.skipped),
    failed: count(summary?.failed),
    lastCursor,
    nextCursor: hasMore ? lastCursor : null,
    hasMore,
  };
}

/**
 * The continuation, or null when this type's walk is finished.
 *
 * Exactly one unit, carrying the last id of the page that produced it as its exclusive cursor.
 * Never more than one, and never one that repeats this unit's own cursor. It never crosses into
 * another entityType: moving from campaigns to coupons is a dependency the parent gate owns, not
 * something a page may decide for itself.
 */
export function nextPromotionUnit(result = {}, { kind } = {}) {
  if (!result?.hasMore) return null;
  const nextCursor = result.nextCursor;
  if (typeof nextCursor !== "string" || nextCursor === "") return null;
  if (nextCursor === result.cursorId) return null;
  return {
    kind,
    networkSource: result.networkSource,
    entityType: result.entityType,
    cursorId: nextCursor,
    pageSize: result.pageSize ?? PROMOTION_PAGE_SIZE,
    options: {},
  };
}

/**
 * Safe outcome for the durable unit record: the page's position and its counts.
 * Never an entity id, a campaign name, a coupon code, a currency or an amount.
 */
export function summarisePromotionUnitOutcome(result = {}) {
  const count = (value) => (Number.isFinite(value) ? value : 0);
  return {
    kind: "promotion",
    networkSource: result.networkSource ?? null,
    entityType: result.entityType ?? null,
    counts: {
      processed: count(result.processed),
      promoted: count(result.promoted),
      skipped: count(result.skipped),
      failed: count(result.failed),
    },
    pageSize: result.pageSize ?? PROMOTION_PAGE_SIZE,
    hasMore: Boolean(result.hasMore),
  };
}
