import { prisma } from "../../database/prisma.js";
import { queueDepth, activeWorkers, observeJobDuration } from "../metrics/prometheus.js";
import { logger } from "../logging/logger.js";
import { getRequestContext } from "../logging/context.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

export class JobRepository {
  async create(data, client = null) {
    const db = client ?? prisma;
    return db.jobRun.create({ data });
  }

  async update(id, data, client = null) {
    const db = client ?? prisma;
    return db.jobRun.update({ where: { id }, data });
  }

  async findById(id) {
    return prisma.jobRun.findUnique({ where: { id } });
  }

  async findNextPending(jobName, client = null) {
    const db = client ?? prisma;
    return db.jobRun.findFirst({
      where: {
        jobName,
        status: "PENDING",
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
  }

  async list({ status, jobName, skip = 0, take = 50 } = {}) {
    const where = {};
    if (status) where.status = status;
    if (jobName) where.jobName = jobName;
    const [rows, total] = await Promise.all([
      prisma.jobRun.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.jobRun.count({ where }),
    ]);
    return { rows, total };
  }

  async countByStatus() {
    const groups = await prisma.jobRun.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    return Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
  }
}

const concurrencyLimits = new Map();
const runningJobs = new Map();

export class JobRunner {
  constructor(deps = {}) {
    this.repo = deps.repo ?? new JobRepository();
    this.sleep = deps.sleep ?? sleep;
    this.handlers = new Map();
    this.defaultMaxAttempts = Number(process.env.JOB_MAX_ATTEMPTS || 3);
  }

  register(jobName, handler, { concurrency = 1, maxAttempts } = {}) {
    this.handlers.set(jobName, { handler, concurrency, maxAttempts });
    concurrencyLimits.set(jobName, concurrency);
  }

  async enqueue(jobName, payload = {}, { priority = 100, maxAttempts, correlationId } = {}) {
    const ctx = getRequestContext();
    const job = await this.repo.create({
      jobName,
      status: "PENDING",
      priority,
      payload,
      maxAttempts: maxAttempts ?? this.handlers.get(jobName)?.maxAttempts ?? this.defaultMaxAttempts,
      correlationId: correlationId ?? ctx.traceId ?? ctx.requestId ?? null,
    });
    queueDepth.labels(jobName).inc();
    return job;
  }

  async run(jobName, payload = {}, options = {}) {
    const job = await this.enqueue(jobName, payload, options);
    return this.execute(job.id);
  }

  async execute(jobId) {
    const job = await this.repo.findById(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status === "CANCELLED") return job;

    const registration = this.handlers.get(job.jobName);
    if (!registration) throw new Error(`No handler registered for job ${job.jobName}`);

    const limit = concurrencyLimits.get(job.jobName) ?? 1;
    const running = runningJobs.get(job.jobName) ?? 0;
    if (running >= limit) {
      return job;
    }

    runningJobs.set(job.jobName, running + 1);
    activeWorkers.labels(job.jobName).inc();
    queueDepth.labels(job.jobName).dec();

    const startedAt = Date.now();
    let current = job;

    try {
      current = await this.repo.update(job.id, {
        status: "RUNNING",
        attempt: { increment: 1 },
        startedAt: new Date(),
      });

      const result = await registration.handler(current.payload ?? {}, {
        job: current,
        setProgress: async (progress) => {
          await this.repo.update(current.id, { progress: Math.min(100, Math.max(0, progress)) });
        },
        isCancelled: async () => {
          const latest = await this.repo.findById(current.id);
          return latest?.status === "CANCELLED";
        },
      });

      current = await this.repo.update(current.id, {
        status: "COMPLETED",
        result: result ?? null,
        progress: 100,
        completedAt: new Date(),
        lastError: null,
      });
      observeJobDuration(current.jobName, (Date.now() - startedAt) / 1000);
      return current;
    } catch (error) {
      // `current.attempt` was already incremented by the RUNNING update above, so
      // it IS the number of the execution that just failed. maxAttempts is the
      // maximum number of handler executions: retry only while fewer have run.
      const attempt = current.attempt;
      const maxAttempts = current.maxAttempts;
      const shouldRetry = attempt < maxAttempts;

      if (shouldRetry) {
        const delay = backoffMs(attempt);
        logger.warn({ jobId: current.id, attempt, delay }, "job failed, scheduling retry");
        await this.sleep(delay);
        current = await this.repo.update(current.id, {
          status: "PENDING",
          lastError: error.message,
        });
        queueDepth.labels(current.jobName).inc();
        return this.execute(current.id);
      }

      current = await this.repo.update(current.id, {
        status: "DEAD_LETTER",
        lastError: String(error.message).slice(0, 2000),
        completedAt: new Date(),
      });
      logger.error({ jobId: current.id, err: error.message }, "job moved to dead letter queue");
      observeJobDuration(current.jobName, (Date.now() - startedAt) / 1000);
      return current;
    } finally {
      runningJobs.set(job.jobName, (runningJobs.get(job.jobName) ?? 1) - 1);
      activeWorkers.labels(job.jobName).dec();
    }
  }

  async cancel(jobId) {
    return this.repo.update(jobId, { status: "CANCELLED", completedAt: new Date() });
  }
}

export const jobRunner = new JobRunner();
