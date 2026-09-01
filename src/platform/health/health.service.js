import { prisma } from "../../database/prisma.js";
import { getRedisClient, isRedisEnabled } from "../cache/redis.js";
import { logger } from "../logging/logger.js";
import { getSchedulerStatus } from "../../jobs/syncScheduler.js";

async function checkDatabase() {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "up", latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { status: "down", error: error.message, latencyMs: Date.now() - startedAt };
  }
}

async function checkRedis() {
  if (!isRedisEnabled()) {
    return { status: "disabled", message: "REDIS_URL not configured" };
  }
  const startedAt = Date.now();
  try {
    const client = await getRedisClient();
    const pong = await client.ping();
    return { status: pong === "PONG" ? "up" : "degraded", latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { status: "down", error: error.message, latencyMs: Date.now() - startedAt };
  }
}

async function checkQueue() {
  try {
    const pending = await prisma.jobRun.count({ where: { status: "PENDING" } });
    const deadLetter = await prisma.jobRun.count({ where: { status: "DEAD_LETTER" } });
    return { status: "up", pending, deadLetter };
  } catch {
    return { status: "unknown", pending: 0, deadLetter: 0 };
  }
}

async function checkStorage() {
  return { status: "up", provider: "local", message: "No external object storage configured" };
}

async function checkSmtp() {
  const hasSes = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SES_REGION);
  const hasResend = Boolean(process.env.RESEND_API_KEY);
  if (hasSes || hasResend) return { status: "configured", provider: hasSes ? "ses" : "resend" };
  if (process.env.NODE_ENV === "production") {
    return { status: "degraded", message: "No email provider configured" };
  }
  return { status: "dev", message: "OTP logged to console in development" };
}

async function checkScheduler() {
  const scheduler = getSchedulerStatus();
  if (!scheduler.enabled) {
    return {
      status: "manual",
      message: "ENABLE_SCHEDULER=false — sync via API/CLI only",
      ...scheduler,
    };
  }
  return {
    status: scheduler.running ? "enabled" : "configured",
    message: `Auto-fetch every ${scheduler.intervalMinutes} minutes (incremental)`,
    ...scheduler,
  };
}

export async function getHealthSummary() {
  const [database, redis, queue, storage, smtp, scheduler] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
    checkStorage(),
    checkSmtp(),
    checkScheduler(),
  ]);

  const checks = { database, redis, queue, storage, smtp, scheduler };
  const criticalUp = database.status === "up";
  const ready = criticalUp && (redis.status === "up" || redis.status === "disabled");

  return {
    ok: criticalUp,
    ready,
    version: process.env.APP_VERSION || "1.0.0",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks,
  };
}

export async function livenessProbe() {
  return { ok: true, status: "alive" };
}

export async function readinessProbe() {
  const summary = await getHealthSummary();
  return {
    ok: summary.ready,
    checks: summary.checks,
  };
}

export function logHealthFailure(summary) {
  if (!summary.ok) {
    logger.error({ checks: summary.checks }, "health check failed");
  }
}
