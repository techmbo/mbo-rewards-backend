/**
 * Concurrency limits expressed against the database connection pool.
 *
 * Every Prisma call needs a pooled connection, and production runs a connection limit of 5 with a
 * 10 second acquisition timeout, so a fan-out wider than the pool does not go faster — it queues,
 * and once the queue ahead of a call exceeds the timeout the call fails with "Timed out fetching a
 * new connection from the connection pool".
 *
 * Fan-outs sized in isolation are the hazard: an outer fan-out of N rows whose per-row work itself
 * fans out M ways puts N * M calls in the queue. Limits therefore come from here, and nested
 * fan-out on one path is removed rather than merely reduced.
 */

/** Connections a single fan-out may draw, leaving headroom in a pool of 5 for everything else. */
export const DB_WORK_CONCURRENCY_DEFAULT = 4;

/** No configured value may exceed this, whatever the environment says. */
export const DB_WORK_CONCURRENCY_CEILING = 4;

/**
 * Resolve a requested concurrency to a pool-safe one. An unset, empty or unparseable value falls
 * back to the default, so safe behaviour never depends on an environment variable being present;
 * anything above the ceiling is clamped rather than honoured, and anything below one becomes one.
 */
export function resolveDbConcurrency(requested, fallback = DB_WORK_CONCURRENCY_DEFAULT) {
  const safeFallback = Math.min(Math.max(Math.floor(fallback) || 1, 1), DB_WORK_CONCURRENCY_CEILING);
  if (requested === undefined || requested === null || requested === "") return safeFallback;
  const value = Number(requested);
  if (!Number.isFinite(value)) return safeFallback;
  return Math.min(Math.max(Math.floor(value), 1), DB_WORK_CONCURRENCY_CEILING);
}

/**
 * A fixed number of permits, handed straight to the next waiter on release.
 *
 * Module-level state, so the cap is what a whole process may hold at once rather than what one
 * call may hold. Acquire at exactly one level of a call chain: a permit holder that waits for
 * another permit from the same pool can deadlock.
 */
export function createPermitPool(size) {
  let available = Math.max(1, Math.floor(size));
  const waiting = [];
  return {
    async acquire() {
      if (available > 0) {
        available -= 1;
        return;
      }
      await new Promise((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else available += 1;
    },
    available: () => available,
  };
}
