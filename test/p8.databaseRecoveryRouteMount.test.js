import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

/**
 * The one test that would have caught the reported bug.
 *
 * Every other test in this area asserts on a middleware in isolation or on the shape of a source
 * file. This one boots the REAL app — the same `createApp()` the deployment runs — with a
 * production-shaped broken DATABASE_URL, and drives the real path over HTTP. Only that can answer
 * "does anything mounted before this route intercept it".
 */

// Set before importing app.js: modules read these at construction.
process.env.DATABASE_URL = "not-a-postgres-url"; // exactly the incident's malformation
process.env.DIRECT_URL = "postgresql://zzuserzz:zzpasswordzz@zzhostzz.proxy.rlwy.net:41234/zzdbzz";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.LOG_LEVEL = "silent";
process.env.DB_RECOVERY_DIAGNOSTIC_TOKEN = "zzmountedglasszz-0123456789abcdef-0123456789";

const TOKEN = process.env.DB_RECOVERY_DIAGNOSTIC_TOKEN;
const WRONG = "zzwrongmountzz-0123456789abcdef-0123456789ab";

const { createApp } = await import("../src/app.js");
const {
  DATABASE_RECOVERY_MARKER_HEADER,
  DATABASE_RECOVERY_MARKER_VALUE,
  DATABASE_RECOVERY_ROUTE_PATH,
} = await import("../src/routes/databaseRecoveryRoute.js");

const appSource = readFileSync("src/app.js", "utf8");
const routesSource = readFileSync("src/routes/index.js", "utf8");

const PATH = DATABASE_RECOVERY_ROUTE_PATH;
const MARKER = DATABASE_RECOVERY_MARKER_HEADER.toLowerCase();

const app = createApp();
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((resolve) => server.close(resolve)));

async function get(path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe("database recovery route — mounted ahead of everything, on the real app", () => {
  it("1 — a missing token is answered by the break-glass gate, not by authenticate", async () => {
    const res = await get(PATH);
    assert.equal(res.status, 401);
    // The marker is the whole point: the two 401 bodies are deliberately identical, so the header
    // is the only way to tell which layer answered.
    assert.equal(res.headers.get(MARKER), DATABASE_RECOVERY_MARKER_VALUE);
  });

  it("2 — a wrong token is answered by the break-glass gate, not by authenticate", async () => {
    const res = await get(PATH, { "x-db-recovery-token": WRONG });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get(MARKER), DATABASE_RECOVERY_MARKER_VALUE);
    assert.ok(!res.text.includes("zzwrongmount"), "the presented token was echoed");
  });

  it("3 — the correct token runs the diagnostic through the whole real stack", async () => {
    const res = await get(PATH, { "x-db-recovery-token": TOKEN });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(MARKER), DATABASE_RECOVERY_MARKER_VALUE);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("pragma"), "no-cache");

    const body = JSON.parse(res.text);
    assert.equal(body.ok, true);
    assert.equal(body.data.directUrlPresent, true);
    assert.equal(body.data.directUrlValidPostgresScheme, true);
    assert.equal(body.data.providerClass, "railway");
    // DATABASE_URL is broken here, exactly as in production, and the diagnostic still ran.
    for (const secret of ["zzuserzz", "zzpasswordzz", "zzhostzz", "41234", "zzdbzz", "rlwy"]) {
      assert.ok(!res.text.includes(secret), `${secret} leaked through the real stack`);
    }
    assert.ok(!res.text.includes("zzmountedglass"), "the break-glass token leaked");
  });

  it("4 — normal /api/ops routes still require normal authentication", async () => {
    for (const path of [
      "/api/ops/raw-payloads",
      "/api/ops/admin/network-certification",
      "/api/ops/products",
    ]) {
      const res = await get(path);
      assert.equal(res.status, 401, `${path} is no longer protected`);
      assert.equal(res.headers.get(MARKER), null, `${path} carries the break-glass marker`);
    }
  });

  it("5 — the break-glass token opens no other route", async () => {
    for (const path of [
      "/api/ops/raw-payloads",
      "/api/ops/admin/network-certification",
      "/api/ops/products",
      "/api/auth/me",
      "/api/clients",
    ]) {
      const res = await get(path, { "x-db-recovery-token": TOKEN });
      assert.ok(
        res.status === 401 || res.status === 403 || res.status === 404,
        `${path} answered ${res.status} to a break-glass token`,
      );
      assert.equal(res.headers.get(MARKER), null, `${path} carries the break-glass marker`);
    }
  });

  it("5b — the marker appears on no other path, with or without a token", async () => {
    for (const path of ["/health/live", "/api/ops/diagnostics", "/api/ops/diagnostics/other"]) {
      const res = await get(path, { "x-db-recovery-token": TOKEN });
      assert.equal(res.headers.get(MARKER), null, `${path} carries the break-glass marker`);
    }
  });

  it("6 — the route is mounted before the /api router, and only there", () => {
    const mount = appSource.indexOf("registerDatabaseRecoveryRoute(app);");
    const apiRouter = appSource.indexOf('app.use("/api", routes);');
    assert.ok(mount > 0, "the emergency route is not mounted");
    assert.ok(apiRouter > 0, "the api router is not mounted");
    assert.ok(mount < apiRouter, "the emergency route must be mounted before the /api router");

    // It left the main router entirely: exactly one definition exists.
    assert.ok(
      !routesSource.includes("database-recovery"),
      "the route is still defined in the main router as well",
    );
    assert.ok(!routesSource.includes("requireDatabaseRecoveryToken"));
  });

  it("6b — the marker middleware runs before the token gate so refusals carry it too", () => {
    const source = readFileSync("src/routes/databaseRecoveryRoute.js", "utf8");
    const order = [
      "databaseRecoveryMarker",
      "requireDatabaseRecoveryToken",
      "noStoreHeaders",
      "databaseRecoveryDiagnosticHandler",
    ];
    const block = source.slice(source.indexOf("app.get("), source.indexOf("  );", source.indexOf("app.get(")));
    const positions = order.map((name) => block.indexOf(name));
    for (const [i, position] of positions.entries()) {
      assert.ok(position >= 0, `${order[i]} missing`);
      if (i > 0) assert.ok(position > positions[i - 1], `${order[i]} must follow ${order[i - 1]}`);
    }
    // The marker value is a constant and carries nothing about the request.
    assert.match(source, /DATABASE_RECOVERY_MARKER_VALUE = "break-glass-v1"/);
    assert.ok(!/setHeader\([^)]*\$\{/.test(source), "the marker is interpolated from something");
  });

  it("6c — no global authentication is mounted on /api or /api/ops", () => {
    // The reported diagnosis. Recorded as a test so a future `router.use(authenticate)` — which
    // would silently break this route again — fails here instead of in production.
    assert.ok(!/app\.use\(\s*["']\/api[^"']*["']\s*,\s*authenticate/.test(appSource));
    assert.ok(!/router\.use\(/.test(routesSource), "the main router gained a blanket middleware");
    assert.equal(appSource.split('app.use("/api"').length - 1, 1, "one /api mount only");
  });
});
