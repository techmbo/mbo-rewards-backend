import { metricsHandler } from "../metrics/prometheus.js";
import { getHealthSummary, livenessProbe, readinessProbe } from "./health.service.js";

export function registerPlatformRoutes(app) {
  app.get("/health", async (_req, res) => {
    const summary = await getHealthSummary();
    res.status(summary.ok ? 200 : 503).json(summary);
  });

  app.get("/health/live", async (_req, res) => {
    res.json(await livenessProbe());
  });

  app.get("/health/ready", async (_req, res) => {
    const result = await readinessProbe();
    res.status(result.ok ? 200 : 503).json(result);
  });

  app.get("/metrics", metricsHandler);
}
