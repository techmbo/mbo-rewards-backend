/**
 * Bounded staging for the Awin offers catalogue.
 *
 * The page walk works: production fetched 5,000 promotions as 25 full pages and reported PARTIAL
 * at the page cap, truthfully. The invocation then died staging them, because all 5,000 went into
 * one upsertManyRawEntities call.
 *
 * Chunking does NOT make that work smaller — the same rows cost the same round trips either way.
 * What it buys is three things the single call could not give:
 *
 *   PROGRESS SURVIVES. Every chunk commits before the next begins, so an invocation killed at
 *   chunk 12 leaves 12 chunks durably staged instead of nothing. A re-run re-reaches them through
 *   the idempotent path — the payload hash already exists, the Entity already exists — so the work
 *   already done is not repeated in full.
 *
 *   COST BECOMES MEASURABLE. Per-chunk timing turns "staging 5,000 rows is too slow" into a
 *   number per 200 rows, which is what decides whether one request can ever be enough.
 *
 *   FAILURE STAYS LOCAL AND VISIBLE. A chunk that throws is recorded and the walk stops; the
 *   caller learns how many chunks actually completed rather than inferring success from a
 *   resolved promise.
 *
 * Awin only, deliberately. Trackier stages 223 coupons in one batch and is unaffected: this module
 * is reached from the Awin offers path alone.
 */
import { upsertManyRawEntities } from "../modules/raw/raw.service.js";

/**
 * Rows per staging batch.
 *
 * 200 for two independent reasons that happen to agree. It is one supplier page, so a chunk
 * boundary never falls inside a page and a chunk is a unit an operator can reason about. And it is
 * the scale already proven to stage correctly in production — Trackier's 223-coupon batch — so
 * nothing about per-batch behaviour is being extrapolated beyond evidence.
 *
 * Not env-overridable. It bounds how much work one batch attempts; an env knob is how such a bound
 * gets raised quietly until an invocation times out again.
 */
export const AWIN_OFFERS_STAGE_CHUNK_SIZE = 200;

/** Split rows into fixed-size chunks, preserving order. An empty input yields no chunks. */
export function chunkRows(rows, size = AWIN_OFFERS_STAGE_CHUNK_SIZE) {
  const width = Number.isInteger(size) && size > 0 ? size : AWIN_OFFERS_STAGE_CHUNK_SIZE;
  const chunks = [];
  for (let i = 0; i < rows.length; i += width) chunks.push(rows.slice(i, i + width));
  return chunks;
}

/**
 * Stage Awin offer rows in bounded chunks, sequentially.
 *
 * Sequential on purpose. The invocation's problem is total round trips against one connection
 * pool, and running chunks in parallel would multiply the concurrent database work rather than
 * reduce the work — the pool, not the wall clock, is the binding constraint. Each chunk keeps the
 * per-row concurrency the staging path already applies.
 *
 * Every chunk carries the SAME networkSource, entityType, externalIdPrefix, account key and
 * evidence, so identity and lineage cannot differ across a chunk boundary: an Awin coupon's id is
 * derived from advertiser.id and promotionId, which no chunk boundary can move.
 *
 * `finalizeSyncRun` is off for every chunk. The NetworkSyncRun measures the supplier fetch, and
 * that fetch's verdict — PARTIAL at the page cap — must not be recomputed into SUCCESS by a batch
 * that merely finished its own 200 rows.
 */
export async function stageAwinOfferRows({
  rows,
  sourceAccountKey = null,
  evidence = null,
  chunkSize = AWIN_OFFERS_STAGE_CHUNK_SIZE,
  /** Seam for tests and for the benchmark log; receives counts and durations only. */
  onChunk = null,
  stage = upsertManyRawEntities,
} = {}) {
  const chunks = chunkRows(Array.isArray(rows) ? rows : [], chunkSize);
  const summary = {
    rows: Array.isArray(rows) ? rows.length : 0,
    chunksTotal: chunks.length,
    chunksCompleted: 0,
    rowsStaged: 0,
    totalMs: 0,
    failedChunk: null,
    error: null,
  };
  if (!chunks.length) return summary;

  const benchmark = String(process.env.SYNC_UPSERT_BENCHMARK || "").toLowerCase() === "true";

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const startedAt = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      await stage({
        networkSource: "awin",
        entityType: "coupon",
        rows: chunk,
        externalIdPrefix: "awin-coupon",
        sourceAccountKey,
        evidence,
        finalizeSyncRun: false,
      });
    } catch (error) {
      // Stop here rather than pressing on. A chunk that failed usually failed for a reason the
      // next chunk will meet too, and the caller must not read a resolved promise as "all staged".
      summary.failedChunk = index + 1;
      summary.error = error?.message || String(error);
      summary.totalMs += Date.now() - startedAt;
      return summary;
    }
    const ms = Date.now() - startedAt;
    summary.chunksCompleted += 1;
    summary.rowsStaged += chunk.length;
    summary.totalMs += ms;

    if (onChunk) {
      onChunk({
        chunk: index + 1,
        chunks: chunks.length,
        rows: chunk.length,
        ms,
        totalMs: summary.totalMs,
      });
    }
    if (benchmark) {
      // Counts and durations only — never a payload, an externalId or a coupon code. This is what
      // turns "too slow" into a per-200-row number that can be extrapolated honestly.
      // eslint-disable-next-line no-console
      console.info(
        `[sync-chunk] awin:coupon chunk=${index + 1}/${chunks.length} rows=${chunk.length} ms=${ms} totalMs=${summary.totalMs}`,
      );
    }
  }
  return summary;
}

/** True when every chunk completed. The only thing a caller may read as full staging success. */
export function stagedCompletely(summary) {
  return (
    !!summary &&
    summary.failedChunk === null &&
    summary.chunksTotal === summary.chunksCompleted &&
    summary.rowsStaged === summary.rows
  );
}
