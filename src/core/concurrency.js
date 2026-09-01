/**
 * Controlled-concurrency worker pool used by sync orchestration and DB upserts.
 * Limits parallel work instead of unbounded Promise.all.
 */
export async function runWithConcurrency(items, concurrency, worker) {
  if (!items.length) return [];

  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
