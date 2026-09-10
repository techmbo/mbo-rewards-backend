/**
 * JobRunner retry accounting.
 *
 * execute() increments `attempt` in the RUNNING update, so the returned row's
 * `attempt` is already the number of the execution in progress. The catch block
 * previously added 1 again before comparing with maxAttempts, so maxAttempts=3
 * dead-lettered after only 2 handler executions (production DLQ: 75/75 rows with
 * attempt=2, maxAttempts=3). These tests pin the corrected contract:
 * maxAttempts is the maximum number of handler executions.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JobRunner } from "../src/platform/jobs/jobRunner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(here, "..", "src", "platform", "jobs", "jobRunner.js");

/** In-memory JobRepository honouring Prisma's `{ increment }` update semantics. */
class MemoryJobRepository {
  constructor() {
    this.rows = new Map();
    this.sequence = 0;
    this.updates = [];
  }

  async create(data) {
    const id = `job-${++this.sequence}`;
    const row = {
      id,
      status: "PENDING",
      priority: 100,
      attempt: 0,
      maxAttempts: 3,
      progress: 0,
      payload: null,
      result: null,
      lastError: null,
      correlationId: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    this.rows.set(id, row);
    return { ...row };
  }

  async update(id, data) {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    const next = { ...row, updatedAt: new Date() };
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
        next[key] = (row[key] ?? 0) + value.increment;
      } else {
        next[key] = value;
      }
    }
    this.rows.set(id, next);
    this.updates.push({ id, status: next.status, attempt: next.attempt, keys: Object.keys(data) });
    return { ...next };
  }

  async findById(id) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
}

let jobCounter = 0;
function uniqueJobName(prefix) {
  jobCounter += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${jobCounter}`;
}

/** Runner with a recording no-op sleep so backoff is asserted, not waited for. */
function makeRunner() {
  const repo = new MemoryJobRepository();
  const sleeps = [];
  const runner = new JobRunner({ repo, sleep: async (ms) => sleeps.push(ms) });
  return { runner, repo, sleeps };
}

async function runFailingJob(maxAttempts, { failTimes = Infinity } = {}) {
  const { runner, repo, sleeps } = makeRunner();
  const jobName = uniqueJobName(`retry-max${maxAttempts}`);
  let executions = 0;
  runner.register(
    jobName,
    async () => {
      executions += 1;
      if (executions <= failTimes) throw new Error(`boom #${executions}`);
      return { done: true, executions };
    },
    { concurrency: 1, maxAttempts },
  );
  const final = await runner.run(jobName, { some: "payload" });
  return { final, executions, sleeps, repo, jobName };
}

const statusTrail = (repo) => repo.updates.map((u) => `${u.status}@${u.attempt}`);

test("8. maxAttempts=3: exactly three handler executions, persisted attempt 1→2→3, then DEAD_LETTER — no 4th execution", async () => {
  const { final, executions, sleeps, repo } = await runFailingJob(3);

  assert.equal(executions, 3);
  assert.equal(final.status, "DEAD_LETTER");
  assert.equal(final.attempt, 3);
  assert.equal(final.maxAttempts, 3);
  assert.equal(final.lastError, "boom #3");
  assert.ok(final.completedAt instanceof Date);
  assert.deepEqual(statusTrail(repo), ["RUNNING@1", "PENDING@1", "RUNNING@2", "PENDING@2", "RUNNING@3", "DEAD_LETTER@3"]);
  // Backoff uses the number of the execution that actually failed.
  assert.deepEqual(sleeps, [1000, 2000]);
  // The pre-fix signature (attempt = maxAttempts - 1 on a DEAD_LETTER row) no longer occurs.
  assert.notEqual(final.attempt, final.maxAttempts - 1);
});

test("9. maxAttempts=2: exactly two handler executions, then DEAD_LETTER", async () => {
  const { final, executions, sleeps, repo } = await runFailingJob(2);
  assert.equal(executions, 2);
  assert.equal(final.status, "DEAD_LETTER");
  assert.equal(final.attempt, 2);
  assert.deepEqual(statusTrail(repo), ["RUNNING@1", "PENDING@1", "RUNNING@2", "DEAD_LETTER@2"]);
  assert.deepEqual(sleeps, [1000]);
});

test("10. maxAttempts=1: exactly one handler execution, then DEAD_LETTER, no backoff", async () => {
  const { final, executions, sleeps, repo } = await runFailingJob(1);
  assert.equal(executions, 1);
  assert.equal(final.status, "DEAD_LETTER");
  assert.equal(final.attempt, 1);
  assert.deepEqual(statusTrail(repo), ["RUNNING@1", "DEAD_LETTER@1"]);
  assert.deepEqual(sleeps, []);
});

test("11. a retry that succeeds completes normally: COMPLETED, attempt=2, result stored, lastError cleared", async () => {
  const { final, executions, sleeps, repo } = await runFailingJob(3, { failTimes: 1 });
  assert.equal(executions, 2);
  assert.equal(final.status, "COMPLETED");
  assert.equal(final.attempt, 2);
  assert.deepEqual(final.result, { done: true, executions: 2 });
  assert.equal(final.lastError, null);
  assert.equal(final.progress, 100);
  assert.ok(final.completedAt instanceof Date);
  assert.deepEqual(statusTrail(repo), ["RUNNING@1", "PENDING@1", "RUNNING@2", "COMPLETED@2"]);
  assert.deepEqual(sleeps, [1000]);
});

test("a third-execution success under maxAttempts=3 still completes (the last allowed execution is a real one)", async () => {
  const { final, executions, sleeps } = await runFailingJob(3, { failTimes: 2 });
  assert.equal(executions, 3);
  assert.equal(final.status, "COMPLETED");
  assert.equal(final.attempt, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("12. no regression to job statuses: first-time success, cancelled skip, payload delivery, and only the existing status vocabulary", async () => {
  const { runner, repo } = makeRunner();
  const jobName = uniqueJobName("success");
  const seenPayloads = [];
  runner.register(jobName, async (payload, ctx) => {
    seenPayloads.push(payload);
    await ctx.setProgress(50);
    return { ok: true };
  });

  const done = await runner.run(jobName, { hello: "world" });
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.attempt, 1);
  assert.deepEqual(done.result, { ok: true });
  assert.deepEqual(seenPayloads, [{ hello: "world" }]);
  assert.equal(done.maxAttempts, Number(process.env.JOB_MAX_ATTEMPTS || 3), "default maxAttempts unchanged");

  // Cancelled before execution: returned untouched, handler never runs.
  const cancelledName = uniqueJobName("cancelled");
  let ran = 0;
  runner.register(cancelledName, async () => {
    ran += 1;
  });
  const queued = await runner.enqueue(cancelledName, {});
  await runner.cancel(queued.id);
  const skipped = await runner.execute(queued.id);
  assert.equal(skipped.status, "CANCELLED");
  assert.equal(ran, 0);

  const statuses = new Set(repo.updates.map((u) => u.status));
  for (const status of statuses) assert.ok(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "DEAD_LETTER"].includes(status), status);
  assert.ok(!statuses.has("FAILED"), "the runner never writes FAILED (unchanged)");
});

test("retry eligibility is computed from the persisted post-increment attempt, without a second +1", () => {
  const source = fs.readFileSync(RUNNER_PATH, "utf8");
  const catchBlock = source.slice(source.indexOf("} catch (error) {"), source.indexOf("} finally {"));
  assert.match(catchBlock, /const attempt = current\.attempt;/);
  assert.ok(!/current\.attempt \+ 1/.test(catchBlock), "no double count");
  assert.match(catchBlock, /const shouldRetry = attempt < maxAttempts;/);
  assert.match(catchBlock, /backoffMs\(attempt\)/, "backoff uses the actual failed attempt number");
  // The RUNNING update still performs the single increment.
  assert.match(source, /attempt: \{ increment: 1 \}/);
});
