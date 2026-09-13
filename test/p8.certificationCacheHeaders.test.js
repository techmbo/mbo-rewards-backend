import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
// One request per window, so the second request in a test is always the rate-limited one.
process.env.CERTIFICATION_RATE_LIMIT_MAX = "1";

const express = (await import("express")).default;
const { noStoreHeaders, certificationRateLimiter } = await import("../src/platform/security/index.js");
const { networkCertificationCatalogHandler, networkCertificationRunHandler } = await import(
  "../src/controllers/networkCertification.controller.js"
);
const routesSource = (await import("node:fs")).readFileSync("src/routes/index.js", "utf8");

/** Starts an app on an ephemeral port and returns a `request` helper plus a stop function. */
async function serve(build) {
  const app = express();
  app.use(express.json());
  build(app);
  // Mirrors how the real app surfaces a thrown fail(): status from the error, controlled body.
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode ?? error.status ?? 500).json({ ok: false, message: error.message });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    async request(path, init = {}) {
      const res = await fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A stand-in for the run handler that records whether it was reached and never calls a supplier. */
function spyHandler() {
  const calls = [];
  const handler = (req, res) => {
    calls.push({ body: req.body });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.json({ ok: true, data: { ran: true } });
  };
  return { calls, handler };
}

/** Stands in for anything that would talk to a supplier. Reaching it is the failure. */
function forbiddenAdapter() {
  throw new Error("a supplier call was made on a request that must never reach the supplier");
}

const RUN_PATH = "/ops/admin/network-certification/optimise/run";
const BODY = { sourceObjects: ["campaigns"], region: "sea", accountLabel: "hdrtest" };

describe("certification cache headers — a 429 is not cacheable either", () => {
  /** The real ordering: noStoreHeaders, then the real limiter, then a terminal handler. */
  async function limitedApp(scopeSuffix) {
    const spy = spyHandler();
    const app = await serve((a) => {
      a.post(
        "/ops/admin/network-certification/:network/run",
        noStoreHeaders,
        certificationRateLimiter,
        spy.handler,
      );
    });
    return { ...app, spy, body: { ...BODY, accountLabel: `hdr-${scopeSuffix}` } };
  }

  it("1 — a 429 carries Cache-Control: no-store", async () => {
    const app = await limitedApp("a");
    try {
      const first = await app.request(RUN_PATH, { method: "POST", body: app.body });
      const second = await app.request(RUN_PATH, { method: "POST", body: app.body });
      assert.equal(first.status, 200);
      assert.equal(second.status, 429);
      assert.equal(second.headers.get("cache-control"), "no-store");
    } finally {
      await app.stop();
    }
  });

  it("2 — a 429 carries Pragma: no-cache", async () => {
    const app = await limitedApp("b");
    try {
      await app.request(RUN_PATH, { method: "POST", body: app.body });
      const second = await app.request(RUN_PATH, { method: "POST", body: app.body });
      assert.equal(second.status, 429);
      assert.equal(second.headers.get("pragma"), "no-cache");
      // And it is not the platform default the bug produced.
      assert.ok(
        !String(second.headers.get("cache-control")).includes("must-revalidate"),
        "the default cache header must not survive",
      );
    } finally {
      await app.stop();
    }
  });

  it("3 — nothing downstream of the limiter runs on a 429", async () => {
    const app = await limitedApp("c");
    try {
      await app.request(RUN_PATH, { method: "POST", body: app.body });
      await app.request(RUN_PATH, { method: "POST", body: app.body });
      await app.request(RUN_PATH, { method: "POST", body: app.body });
      assert.equal(app.spy.calls.length, 1, "only the first request reached the handler");
    } finally {
      await app.stop();
    }
  });

  it("3b — a supplier factory placed after the limiter is never invoked on a 429", async () => {
    // Proves the limiter short-circuit precedes anything that could talk to a supplier.
    const app = await serve((a) => {
      a.post(
        "/ops/admin/network-certification/:network/run",
        noStoreHeaders,
        certificationRateLimiter,
        (_req, res) => {
          forbiddenAdapter();
          res.json({ ok: true });
        },
      );
    });
    try {
      const body = { ...BODY, accountLabel: "hdr-d" };
      const first = await app.request(RUN_PATH, { method: "POST", body });
      assert.equal(first.status, 500, "the forbidden factory throws on the one request that gets through");
      const second = await app.request(RUN_PATH, { method: "POST", body });
      assert.equal(second.status, 429, "and the second never reaches it at all");
      assert.equal(second.headers.get("cache-control"), "no-store");
    } finally {
      await app.stop();
    }
  });

  it("4 — the limiter's own RateLimit headers are intact", async () => {
    const app = await limitedApp("e");
    try {
      const first = await app.request(RUN_PATH, { method: "POST", body: app.body });
      const second = await app.request(RUN_PATH, { method: "POST", body: app.body });
      assert.equal(first.headers.get("ratelimit-limit"), "1");
      assert.equal(second.headers.get("ratelimit-limit"), "1");
      assert.equal(second.headers.get("ratelimit-remaining"), "0");
      assert.ok(Number(second.headers.get("ratelimit-reset")) > 0, "reset seconds present");
      assert.ok(second.headers.get("ratelimit-policy"), "policy header present");
      // And the controlled 429 body is unchanged.
      assert.equal(second.body.ok, false);
      assert.match(second.body.message, /Try again shortly/);
    } finally {
      await app.stop();
    }
  });

  it("5 — a successful 200 is still no-store", async () => {
    const app = await limitedApp("f");
    try {
      const first = await app.request(RUN_PATH, { method: "POST", body: app.body });
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("cache-control"), "no-store");
      assert.equal(first.headers.get("pragma"), "no-cache");
    } finally {
      await app.stop();
    }
  });

  it("6 — a 400 for an invalid windowPreset is no-store, and reaches no supplier", async () => {
    // The real run handler: parseRunBody throws before the service is touched.
    const app = await serve((a) => {
      a.post("/ops/admin/network-certification/:network/run", noStoreHeaders, networkCertificationRunHandler);
    });
    try {
      const res = await app.request(RUN_PATH, {
        method: "POST",
        body: { sourceObjects: ["campaigns"], windowPreset: "365d" },
      });
      assert.equal(res.status, 400);
      assert.match(res.body.message, /windowPreset must be one of/);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("pragma"), "no-cache");
    } finally {
      await app.stop();
    }
  });

  it("6b — a 400 for an unknown body key is no-store too", async () => {
    const app = await serve((a) => {
      a.post("/ops/admin/network-certification/:network/run", noStoreHeaders, networkCertificationRunHandler);
    });
    try {
      const res = await app.request(RUN_PATH, { method: "POST", body: { fromDate: "2020-01-01" } });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("cache-control"), "no-store");
    } finally {
      await app.stop();
    }
  });

  it("7 — authenticate and requirePermission still precede the header middleware", () => {
    const start = routesSource.indexOf('"/ops/admin/network-certification/:network/run"');
    const block = routesSource.slice(start, routesSource.indexOf(");", start));
    const order = ["authenticate", "requirePermission", "noStoreHeaders", "certificationRateLimiter"];
    const positions = order.map((name) => block.indexOf(name));
    for (const [i, position] of positions.entries()) {
      assert.ok(position >= 0, `${order[i]} missing from the route`);
    }
    for (let i = 1; i < positions.length; i += 1) {
      assert.ok(
        positions[i] > positions[i - 1],
        `${order[i]} must come after ${order[i - 1]}`,
      );
    }
    // Auth behaviour itself is untouched: no auth middleware was added, removed or reordered.
    assert.match(block, /authenticate,\s*\n\s*requirePermission\(PERMISSIONS\.INTEGRATIONS_MANAGE\),/);
  });

  it("8 — the catalog GET is unchanged apart from the header middleware", async () => {
    const start = routesSource.indexOf('"/ops/admin/network-certification"');
    const block = routesSource.slice(start, routesSource.indexOf(");", start));
    assert.match(block, /authenticate,/);
    assert.match(block, /requirePermission\(PERMISSIONS\.INTEGRATIONS_MANAGE\),/);
    assert.match(block, /noStoreHeaders,/);
    assert.match(block, /networkCertificationCatalogHandler,/);
    assert.ok(!block.includes("certificationRateLimiter"), "the catalog is still not rate limited");

    // And it still answers with the same metadata, no supplier call.
    const app = await serve((a) => {
      a.get("/ops/admin/network-certification", noStoreHeaders, networkCertificationCatalogHandler);
    });
    try {
      const res = await app.request("/ops/admin/network-certification");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.body.data.execution.method, "POST");
      assert.ok(Array.isArray(res.body.data.networks));
    } finally {
      await app.stop();
    }
  });

  it("9 — no route gained the header middleware except the ones that should have it", () => {
    // Count uses only, not the import that brings the symbol in. The set is pinned by path rather
    // than by number alone, so adding the middleware to an unrelated route fails here even if some
    // other route stopped using it on the same commit.
    const allowed = [
      "/ops/admin/network-certification",
      "/ops/admin/network-certification/:network/run",
    ];
    const uses = [...routesSource.matchAll(/^\s*noStoreHeaders,\s*$/gm)];
    assert.equal(uses.length, allowed.length, "one use per approved route");
    for (const match of uses) {
      const preceding = routesSource.slice(Math.max(0, match.index - 700), match.index);
      const owner = allowed.find((path) => preceding.includes(`"${path}"`));
      assert.ok(owner, "noStoreHeaders on a route that is not on the approved list");
    }
    // And each approved route really does carry it.
    for (const path of allowed) {
      const start = routesSource.indexOf(`"${path}"`);
      const block = routesSource.slice(start, routesSource.indexOf(");", start));
      assert.match(block, /noStoreHeaders,/, `${path} lost the header middleware`);
    }
  });

  it("9b — the middleware only sets headers and passes control on", async () => {
    const securitySource = (await import("node:fs")).readFileSync("src/platform/security/index.js", "utf8");
    const start = securitySource.indexOf("export function noStoreHeaders");
    const body = securitySource.slice(start, securitySource.indexOf("\n}", start));
    assert.match(body, /Cache-Control", "no-store"/);
    assert.match(body, /Pragma", "no-cache"/);
    assert.match(body, /next\(\)/);
    for (const token of ["res.json", "res.send", "res.status", "await", "fetch("]) {
      assert.ok(!body.includes(token), `middleware does more than set headers: ${token}`);
    }
  });

  it("9c — the limiter itself is unchanged", async () => {
    const securitySource = (await import("node:fs")).readFileSync("src/platform/security/index.js", "utf8");
    const block = securitySource.slice(securitySource.indexOf("export const certificationRateLimiter"));
    assert.match(block, /300_000/);
    assert.match(block, /CERTIFICATION_RATE_LIMIT_MAX \|\| 1/);
    assert.match(block, /params\?\.network/);
    assert.match(block, /body\?\.region/);
    assert.match(block, /body\?\.accountLabel/);
    assert.match(block, /Try again shortly/);
  });
});
