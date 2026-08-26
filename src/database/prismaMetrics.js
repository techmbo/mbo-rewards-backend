import { prisma } from "./prisma.js";
import { dbQueryDuration } from "../platform/metrics/prometheus.js";

export function attachPrismaMetrics(client = prisma) {
  client.$use(async (params, next) => {
    const startedAt = process.hrtime.bigint();
    const result = await next(params);
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    dbQueryDuration.labels(params.model ?? "raw", params.action).observe(seconds);
    return result;
  });
}
