import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

const spec = swaggerJsdoc({
  definition: {
    openapi: "3.0.3",
    info: {
      title: "MBO Integrated Platform API",
      version: "1.0.0",
      description:
        "Enterprise affiliate operations API. Authentication via Bearer JWT. RBAC enforced per endpoint.",
    },
    servers: [{ url: "/api", description: "API base path" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        HealthResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            ready: { type: "boolean" },
            version: { type: "string" },
            checks: { type: "object" },
          },
        },
        StandardListResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean", example: true },
            data: { type: "array", items: { type: "object" } },
            pagination: { type: "object" },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Health", description: "Platform health (unauthenticated at /health)" },
      { name: "Auth", description: "Authentication" },
      { name: "Suppliers", description: "Wave 1 supplier foundation" },
      { name: "Merchants", description: "Wave 2A merchant intelligence" },
      { name: "Catalog", description: "Wave 2B catalog intelligence" },
      { name: "Clients", description: "Wave 3 client distribution" },
      { name: "Commercial", description: "Wave 4 commercial foundation" },
      { name: "Reporting", description: "Wave 5 attribution & reporting" },
      { name: "Operations", description: "Phase 6 admin operations (ADMIN only)" },
    ],
    paths: {
      "/health": {
        get: {
          tags: ["Health"],
          summary: "Basic health (also at root /health)",
          security: [],
          responses: { 200: { description: "Service healthy" } },
        },
      },
      "/auth/login": {
        post: {
          tags: ["Auth"],
          summary: "Login",
          security: [],
          responses: { 200: { description: "JWT token" } },
        },
      },
      "/supplier-campaigns": {
        get: {
          tags: ["Suppliers"],
          summary: "List supplier campaigns",
          description: "Requires campaigns:read",
          responses: { 200: { description: "Paged list" } },
        },
      },
      "/reports/daily": {
        get: {
          tags: ["Reporting"],
          summary: "Daily aggregated reports",
          description: "Requires performance:read. Reads pre-aggregated daily_reports only.",
          responses: { 200: { description: "Report rows" } },
        },
      },
      "/aggregation/run": {
        post: {
          tags: ["Reporting"],
          summary: "Run daily aggregation",
          description: "Requires sync:trigger",
          responses: { 200: { description: "Aggregation summary" } },
        },
      },
      "/ops/metrics": {
        get: {
          tags: ["Operations"],
          summary: "System metrics",
          description: "ADMIN only",
          responses: { 200: { description: "Metrics snapshot" } },
        },
      },
    },
  },
  apis: [],
});

export function registerOpenApi(app) {
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(spec, { explorer: true }));
  app.get("/api/openapi.json", (_req, res) => {
    res.json(spec);
  });
}
