import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from "prom-client";

export const metricsRegistry = new Registry();

collectDefaultMetrics({
  register: metricsRegistry,
  prefix: "mbo_",
});

export const httpRequestTotal = new Counter({
  name: "mbo_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [metricsRegistry],
});

export const httpRequestDuration = new Histogram({
  name: "mbo_http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const httpErrorsTotal = new Counter({
  name: "mbo_http_errors_total",
  help: "HTTP 5xx responses",
  labelNames: ["method", "route"],
  registers: [metricsRegistry],
});

export const jobDuration = new Histogram({
  name: "mbo_job_duration_seconds",
  help: "Background job duration",
  labelNames: ["job"],
  buckets: [0.5, 1, 5, 15, 30, 60, 120, 300, 600],
  registers: [metricsRegistry],
});

export const promotionDuration = new Histogram({
  name: "mbo_promotion_duration_seconds",
  help: "Promotion job duration",
  registers: [metricsRegistry],
});

export const matchingDuration = new Histogram({
  name: "mbo_merchant_matching_duration_seconds",
  help: "Merchant matching duration",
  registers: [metricsRegistry],
});

export const aggregationDuration = new Histogram({
  name: "mbo_aggregation_duration_seconds",
  help: "Aggregation job duration",
  registers: [metricsRegistry],
});

export const dbQueryDuration = new Histogram({
  name: "mbo_db_query_duration_seconds",
  help: "Database query duration",
  labelNames: ["model", "action"],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [metricsRegistry],
});

export const cacheHits = new Counter({
  name: "mbo_cache_hits_total",
  help: "Cache hits",
  labelNames: ["cache"],
  registers: [metricsRegistry],
});

export const cacheMisses = new Counter({
  name: "mbo_cache_misses_total",
  help: "Cache misses",
  labelNames: ["cache"],
  registers: [metricsRegistry],
});

export const queueDepth = new Gauge({
  name: "mbo_queue_depth",
  help: "Pending jobs in queue",
  labelNames: ["queue"],
  registers: [metricsRegistry],
});

export const activeWorkers = new Gauge({
  name: "mbo_active_workers",
  help: "Active background workers",
  labelNames: ["worker"],
  registers: [metricsRegistry],
});

export const openConnections = new Gauge({
  name: "mbo_open_connections",
  help: "Open HTTP connections",
  registers: [metricsRegistry],
});

export function observeJobDuration(jobName, seconds) {
  jobDuration.labels(jobName).observe(seconds);
  if (jobName === "promotion") promotionDuration.observe(seconds);
  if (jobName === "merchant-matching") matchingDuration.observe(seconds);
  if (jobName === "aggregation") aggregationDuration.observe(seconds);
}

export function recordCacheHit(cache = "default") {
  cacheHits.labels(cache).inc();
}

export function recordCacheMiss(cache = "default") {
  cacheMisses.labels(cache).inc();
}

export function metricsMiddleware() {
  return (req, res, next) => {
    openConnections.inc();
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
      openConnections.dec();
      const route = req.route?.path || req.path || "unknown";
      const labels = { method: req.method, route, status: String(res.statusCode) };
      httpRequestTotal.inc(labels);
      end(labels);
      if (res.statusCode >= 500) {
        httpErrorsTotal.inc({ method: req.method, route });
      }
    });
    next();
  };
}

export async function metricsHandler(_req, res) {
  res.setHeader("Content-Type", metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
}
