import { prisma } from "../../database/prisma.js";
import { isRedisEnabled } from "../cache/redis.js";
import { JobRepository } from "../jobs/jobRunner.js";
import { queueDepth } from "../metrics/prometheus.js";
import { eventDispatcher } from "../events/eventDispatcher.js";

export class OpsService {
  constructor(deps = {}) {
    this.jobRepo = deps.jobRepo ?? new JobRepository();
  }

  async getSystemMetrics() {
    const [jobCounts, outboxPending] = await Promise.all([
      this.jobRepo.countByStatus(),
      prisma.eventOutbox.count({ where: { status: "PENDING" } }),
    ]);

    return {
      uptimeSeconds: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      jobs: jobCounts,
      outboxPending,
      redisEnabled: isRedisEnabled(),
      nodeVersion: process.version,
    };
  }

  async getQueueStatus() {
    const statuses = await this.jobRepo.countByStatus();
    for (const [queue, count] of Object.entries(statuses)) {
      queueDepth.labels(queue).set(count);
    }
    return statuses;
  }

  async getFailedJobs({ skip = 0, take = 50 } = {}) {
    return this.jobRepo.list({ status: "FAILED", skip, take });
  }

  async getDeadLetterJobs({ skip = 0, take = 50 } = {}) {
    return this.jobRepo.list({ status: "DEAD_LETTER", skip, take });
  }

  async getAggregationStatus() {
    const latest = await prisma.jobRun.findFirst({
      where: { jobName: "aggregation" },
      orderBy: { createdAt: "desc" },
    });
    const reportCount = await prisma.dailyReport.count();
    return { latestJob: latest, dailyReportRows: reportCount };
  }

  async getPromotionStatus() {
    const latest = await prisma.jobRun.findFirst({
      where: { jobName: "promotion" },
      orderBy: { createdAt: "desc" },
    });
    const pendingOutbox = await prisma.eventOutbox.count({ where: { status: "PENDING" } });
    return { latestJob: latest, pendingOutbox };
  }

  async getMatchingQueue() {
    return this.jobRepo.list({ jobName: "merchant-matching", status: "PENDING", take: 20 });
  }

  async getStorageUsage() {
    return { provider: "local", configured: false, message: "Object storage not configured" };
  }

  async getDatabaseStatistics() {
    const tables = await prisma.$queryRaw`
      SELECT relname AS table_name, n_live_tup AS row_estimate
      FROM pg_stat_user_tables
      ORDER BY n_live_tup DESC
      LIMIT 20
    `;
    return { tables };
  }

  async getWorkerStatus() {
    const running = await this.jobRepo.list({ status: "RUNNING", take: 50 });
    return { running: running.rows, count: running.total };
  }

  async dispatchOutbox({ take = 50 } = {}) {
    return eventDispatcher.dispatchPending({ take });
  }
}

export const opsService = new OpsService();
