import Redis from "ioredis";
import { logger } from "../logging/logger.js";

let client = null;
let connectPromise = null;

export function isRedisEnabled() {
  return Boolean(process.env.REDIS_URL);
}

export async function getRedisClient() {
  if (!isRedisEnabled()) {
    throw new Error("Redis is not configured.");
  }
  if (client) return client;
  if (!connectPromise) {
    connectPromise = new Promise((resolve, reject) => {
      client = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
      });
      client.on("error", (error) => {
        logger.warn({ err: error.message }, "redis connection error");
      });
      client.connect().then(() => resolve(client)).catch(reject);
    });
  }
  return connectPromise;
}

export async function closeRedis() {
  if (client) {
    await client.quit();
    client = null;
    connectPromise = null;
  }
}
