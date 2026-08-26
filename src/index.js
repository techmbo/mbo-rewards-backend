import "dotenv/config";
import { createApp } from "./app.js";
import { prisma } from "./database/prisma.js";
import { logger } from "./platform/logging/logger.js";
import { closeRedis } from "./platform/cache/redis.js";
import { validateEnvironment } from "./platform/config/env.js";
import { startSyncScheduler, stopSyncScheduler } from "./jobs/syncScheduler.js";
import { warmListCaches } from "./platform/cache/warmListCaches.js";

const port = Number(process.env.PORT || 4000);

try {
  validateEnvironment({ exitOnError: true });
} catch (error) {
  logger.fatal({ err: error.message }, "environment validation failed");
  process.exit(1);
}

const app = createApp();
const server = app.listen(port, () => {
  logger.info({ port }, "API server started");
  startSyncScheduler();
  warmListCaches().catch((err) => {
    logger.warn({ err: err?.message }, "list cache warmup skipped");
  });
});

async function shutdown(signal) {
  logger.info({ signal }, "shutting down");
  stopSyncScheduler();
  server.close(async () => {
    await closeRedis();
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
