function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRateLimiter(minIntervalMs) {
  let lastRequestAt = 0;
  let chain = Promise.resolve();

  async function acquireSlot() {
    const run = async () => {
      const now = Date.now();
      const waitMs = Math.max(0, lastRequestAt + minIntervalMs - now);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      lastRequestAt = Date.now();
    };

    chain = chain.then(run, run);
    return chain;
  }

  function resetAfterRateLimit(waitMs) {
    lastRequestAt = Date.now() + Math.max(0, waitMs);
  }

  return { acquireSlot, resetAfterRateLimit };
}
