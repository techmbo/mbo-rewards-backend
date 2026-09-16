/**
 * A connection pool that behaves like Prisma's: every query takes a connection, a query that
 * cannot get one within the timeout fails with Prisma's own message, and the pool records the
 * deepest concurrency it ever saw.
 */
export function createFakeConnectionPool({ limit = 5, timeoutMs = 10_000, queryMs = 5 } = {}) {
  let inUse = 0;
  let peakInUse = 0;
  let peakWaiting = 0;
  let waitingCount = 0;
  let timeouts = 0;
  let queries = 0;
  const waiters = [];

  function releaseOne() {
    const next = waiters.shift();
    if (next) next.resolve();
    else inUse -= 1;
  }

  async function acquire(now) {
    if (inUse < limit) {
      inUse += 1;
      peakInUse = Math.max(peakInUse, inUse);
      return;
    }
    waitingCount += 1;
    peakWaiting = Math.max(peakWaiting, waitingCount);
    try {
      await new Promise((resolve, reject) => {
        const entry = { resolve: null };
        const timer = setTimeout(() => {
          const at = waiters.indexOf(entry);
          if (at >= 0) waiters.splice(at, 1);
          timeouts += 1;
          const error = new Error(
            "Timed out fetching a new connection from the connection pool. " +
              `Current connection pool timeout: ${Math.round(timeoutMs / 1000)}, connection limit: ${limit}`,
          );
          error.code = "P2024";
          reject(error);
        }, timeoutMs);
        entry.resolve = () => {
          clearTimeout(timer);
          resolve();
        };
        waiters.push(entry);
      });
      peakInUse = Math.max(peakInUse, inUse);
    } finally {
      waitingCount -= 1;
    }
    void now;
  }

  /** Run one query against the pool. */
  async function query() {
    queries += 1;
    await acquire();
    try {
      await new Promise((r) => setTimeout(r, queryMs));
    } finally {
      releaseOne();
    }
  }

  return {
    query,
    stats: () => ({ peakInUse, peakWaiting, timeouts, queries, limit }),
  };
}
