/**
 * Phase 19 — one PAGE of Awin advertiser-parent materialization as one durable executable unit.
 *
 * Awin's programmes endpoint returns nothing, so its campaign parents are derived from the offers
 * already staged. Doing that for the whole estate in one call is what timed out: 5,011 offers,
 * ~1,418 parents, then ~1,418 campaign promotions and 5,011 coupon promotions is tens of thousands
 * of serial queries, and a Vercel invocation has 300 seconds.
 *
 * This unit is shaped exactly like a promotion page and for the same reasons:
 *
 * 1. Keyset by PRIMARY KEY ONLY. `id` is immutable, so `id > cursor` ordered `id asc` is a stable
 *    total order across two invocations minutes apart. A row re-staged between pages bumps
 *    updatedAt but cannot move the page boundary.
 *
 * 2. It promotes NOTHING and it calls no supplier. It reads staged Entities and stages derived
 *    campaign Entities, which is why an estate staged by an earlier sync can be backfilled with no
 *    refetch at all.
 *
 * 3. It never drains. One page, then a single continuation appended to the tail of the run.
 *
 * The whole walk must finish before the Awin campaign walk is seeded — not merely before the
 * coupon walk. A campaign page only ever sees the campaign Entities that existed when it ran, so a
 * parent staged after that walk resolved would never be promoted and its coupons would fail again.
 * postSyncStages owns that barrier.
 */

/**
 * The offers ONE durable materialization unit reads.
 *
 * Bounded by what the page WRITES, not what it reads: scanning rows is one query, but every
 * advertiser the page finds is staged through the raw-payload path, which costs a few queries per
 * parent. At 200 a page stages at most 200 parents — order 800 queries — which sits beside the
 * 600-900 a promotion page costs and inside the same 300s invocation. In production 5,011 offers
 * carry 1,418 advertisers, so a page stages far fewer than its ceiling.
 *
 * Larger than PROMOTION_PAGE_SIZE on purpose: staging a parent is much cheaper than promoting an
 * entity, which holds an interactive transaction and may create a merchant.
 *
 * It lives HERE, with the unit, for the same reason PROMOTION_PAGE_SIZE lives with the promotion
 * unit: the planner has to know a page's width to seed one, and it must be able to learn that
 * without importing a service that reaches the database.
 */
export const AWIN_MATERIALIZATION_PAGE_SIZE = 200;

/** The one network this unit exists for. An advertiser-derived parent is an Awin-only idea. */
export const AWIN_MATERIALIZATION_NETWORK_SOURCE = "awin";

/** Descriptor fields that would make this something other than one page of one walk. */
const FORBIDDEN_FIELDS = Object.freeze([
  "from",
  "to",
  "windowStart",
  "windowEnd",
  "day",
  "days",
  // An explicit id list bypasses the cursor: the page would no longer be "the next N after
  // cursorId", so the continuation could skip or repeat rows.
  "entityIds",
  // This unit walks staged coupons and stages campaigns. Naming an entityType would suggest the
  // caller gets to choose one of those, and neither is a choice.
  "entityType",
  "entityTypes",
]);

export const AWIN_MATERIALIZATION_REFUSAL_CODE = "invalid_awin_materialization_unit";

function refuse(message) {
  const error = new Error(message);
  error.code = AWIN_MATERIALIZATION_REFUSAL_CODE;
  error.statusCode = 422;
  return error;
}

/**
 * Resolve the page a unit names, or throw the refusal a worker surfaces. Every check happens
 * BEFORE any database work: an invalid unit must cost nothing.
 */
export function resolveAwinMaterializationPage(descriptor = {}) {
  const present = FORBIDDEN_FIELDS.filter(
    (field) => descriptor[field] !== undefined && descriptor[field] !== null && descriptor[field] !== "",
  );
  if (present.length) {
    throw refuse(
      `An Awin parent materialization unit is one cursor page; it must not carry ${present.join(", ")}.`,
    );
  }

  const { networkSource } = descriptor;
  if (typeof networkSource !== "string" || networkSource.trim() === "") {
    throw refuse("An Awin parent materialization unit requires a networkSource.");
  }
  if (networkSource.trim().toLowerCase() !== AWIN_MATERIALIZATION_NETWORK_SOURCE) {
    throw refuse(
      `Advertiser-derived parents are ${AWIN_MATERIALIZATION_NETWORK_SOURCE} evidence and belong to no other network.`,
    );
  }

  const { cursorId } = descriptor;
  if (cursorId !== undefined && cursorId !== null) {
    if (typeof cursorId !== "string" || cursorId.trim() === "") {
      throw refuse("A materialization unit's cursorId must be a non-empty id, or absent for the first page.");
    }
  }

  // A stored pageSize is honoured only if it equals the fixed size; anything else would make two
  // units for the same cursor cover different rows.
  const { pageSize } = descriptor;
  if (pageSize !== undefined && pageSize !== null && pageSize !== AWIN_MATERIALIZATION_PAGE_SIZE) {
    throw refuse(`An Awin parent materialization unit's pageSize is fixed at ${AWIN_MATERIALIZATION_PAGE_SIZE}.`);
  }

  return {
    networkSource: AWIN_MATERIALIZATION_NETWORK_SOURCE,
    cursorId: cursorId == null ? null : cursorId.trim(),
    pageSize: AWIN_MATERIALIZATION_PAGE_SIZE,
  };
}

/**
 * Whether the page that just ran leaves more work.
 *
 * `offersScanned` counts every staged offer the page took, whether or not it yielded an
 * advertiser. A full page means there may be more; a short page is the end of the walk.
 */
export function awinMaterializationPageHasMore({ offersScanned, pageSize = AWIN_MATERIALIZATION_PAGE_SIZE } = {}) {
  return Number.isFinite(offersScanned) && offersScanned >= pageSize;
}

/** Execute one page. `runPage` receives exactly the parameters for ONE page. */
export async function executeAwinParentMaterializationUnit(descriptor = {}, { runPage } = {}) {
  if (typeof runPage !== "function") {
    throw refuse("An Awin parent materialization unit needs a page runner to execute.");
  }
  const page = resolveAwinMaterializationPage(descriptor);

  const summary = await runPage({
    cursorId: page.cursorId ?? undefined,
    pageSize: page.pageSize,
  });

  const count = (value) => (Number.isFinite(value) ? value : 0);
  const offersScanned = count(summary?.offersScanned);
  const lastCursor =
    typeof summary?.lastCursor === "string" && summary.lastCursor !== "" ? summary.lastCursor : null;
  // Both conditions, exactly as a promotion page decides it: a full page with no cursor cannot
  // continue, and continuing from a null cursor would restart the walk.
  const hasMore =
    awinMaterializationPageHasMore({ offersScanned, pageSize: page.pageSize }) && lastCursor != null;

  return {
    networkSource: page.networkSource,
    cursorId: page.cursorId,
    pageSize: page.pageSize,
    offersScanned,
    advertisersFound: count(summary?.advertisersFound),
    parentsStaged: count(summary?.parentsStaged),
    skippedProgrammeBacked: count(summary?.skippedProgrammeBacked),
    offersWithoutAdvertiser: count(summary?.offersWithoutAdvertiser),
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
export function nextAwinParentMaterializationUnit(result = {}, { kind } = {}) {
  if (!result?.hasMore) return null;
  const nextCursor = result.nextCursor;
  if (typeof nextCursor !== "string" || nextCursor === "") return null;
  if (nextCursor === result.cursorId) return null;
  return {
    kind,
    networkSource: result.networkSource,
    cursorId: nextCursor,
    pageSize: result.pageSize ?? AWIN_MATERIALIZATION_PAGE_SIZE,
    options: {},
  };
}

/**
 * Safe outcome for the durable unit record: the page's position and its counts.
 * Never an entity id, an advertiser name, a campaign name or a payload.
 */
export function summariseAwinParentMaterializationUnitOutcome(result = {}) {
  const count = (value) => (Number.isFinite(value) ? value : 0);
  return {
    kind: "awin-parent-materialization",
    networkSource: result.networkSource ?? null,
    counts: {
      offersScanned: count(result.offersScanned),
      advertisersFound: count(result.advertisersFound),
      parentsStaged: count(result.parentsStaged),
      skippedProgrammeBacked: count(result.skippedProgrammeBacked),
      offersWithoutAdvertiser: count(result.offersWithoutAdvertiser),
    },
    pageSize: result.pageSize ?? AWIN_MATERIALIZATION_PAGE_SIZE,
    hasMore: Boolean(result.hasMore),
  };
}
