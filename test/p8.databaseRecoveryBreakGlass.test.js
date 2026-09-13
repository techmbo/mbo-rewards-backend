import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const express = (await import("express")).default;
const {
  DB_RECOVERY_TOKEN_ENV,
  DB_RECOVERY_TOKEN_HEADER,
  MIN_TOKEN_LENGTH,
  constantTimeEquals,
  isGateConfigured,
  isTokenReused,
  requireDatabaseRecoveryToken,
} = await import("../src/middleware/databaseRecoveryToken.js");
const { databaseRecoveryDiagnosticHandler } = await import(
  "../src/controllers/databaseRecoveryDiagnostic.controller.js"
);
const { sanitizeForLog } = await import("../src/platform/logging/context.js");

const routesSource = readFileSync("src/routes/index.js", "utf8");
const gateSource = readFileSync("src/middleware/databaseRecoveryToken.js", "utf8");
const authSource = readFileSync("src/middleware/auth.js", "utf8");
const requestLoggerSource = readFileSync("src/platform/logging/requestLogger.js", "utf8");
const recoveryRouteSource = readFileSync("src/routes/databaseRecoveryRoute.js", "utf8");
const appSource = readFileSync("src/app.js", "utf8");
/** The gate with comments stripped: assertions about behaviour must not be satisfied by prose. */
const gateCode = gateSource.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "");

const ROUTE = "/ops/diagnostics/database-recovery";

/** A distinctive secret: it appears nowhere else, so a leak assertion can name the value itself. */
const GOOD_TOKEN = "zzbreakglasszz-0123456789abcdef-0123456789abcdef";
const WRONG_TOKEN = "zzwrongglasszz-0123456789abcdef-0123456789abcdef";

/** Runs `fn` with a scoped environment, always restoring what was there. */
async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The real gate in front of a terminal handler. `handler` defaults to a reach marker. */
async function serve(handler = (_req, res) => res.json({ ok: true, data: { reached: true } })) {
  const app = express();
  app.get(ROUTE, requireDatabaseRecoveryToken, handler);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async get(headers = {}) {
      const res = await fetch(`${base}${ROUTE}`, { headers });
      return {
        status: res.status,
        headers: res.headers,
        text: await res.clone().text(),
        body: await res.json().catch(() => null),
      };
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("database recovery break-glass — rejection", () => {
  it("1 — a request with no token is denied and never reaches the handler", async () => {
    await withEnv({ [DB_RECOVERY_TOKEN_ENV]: GOOD_TOKEN }, async () => {
      let reached = 0;
      const app = await serve((_req, res) => {
        reached += 1;
        res.json({ ok: true });
      });
      try {
        const res = await app.get();
        assert.equal(res.status, 401);
        assert.equal(res.body.ok, false);
        assert.equal(reached, 0, "the handler must not run");
      } finally {
        await app.stop();
      }
    });
  });

  it("2 — a wrong token is denied, and indistinguishably from a missing one", async () => {
    await withEnv({ [DB_RECOVERY_TOKEN_ENV]: GOOD_TOKEN }, async () => {
      let reached = 0;
      const app = await serve((_req, res) => {
        reached += 1;
        res.json({ ok: true });
      });
      try {
        const missing = await app.get();
        for (const bad of [
          WRONG_TOKEN,
          "",
          " ",
          GOOD_TOKEN.slice(0, -1),
          GOOD_TOKEN.slice(1),
          `x${GOOD_TOKEN}`,
          `${GOOD_TOKEN}x`,
          GOOD_TOKEN.toUpperCase(),
          `${GOOD_TOKEN}${GOOD_TOKEN}`,
          // Not tested: a leading or trailing SPACE. RFC 9110 5.5 makes surrounding whitespace part
          // of the framing rather than the value, and every conforming client strips it, so such a
          // case would exercise the HTTP client rather than this gate.
        ]) {
          const res = await app.get({ [DB_RECOVERY_TOKEN_HEADER]: bad });
          assert.equal(res.status, 401, `accepted a bad token: ${JSON.stringify(bad.slice(0, 8))}`);
          // No oracle: the refusal is byte-identical whether a header was sent or not.
          assert.equal(res.text, missing.text);
        }
        assert.equal(reached, 0, "the handler must not run for any bad token");
      } finally {
        await app.stop();
      }
    });
  });

  it("2b — the gate fails closed when it is not configured", async () => {
    for (const value of [undefined, "", "short", "x".repeat(MIN_TOKEN_LENGTH - 1)]) {
      await withEnv({ [DB_RECOVERY_TOKEN_ENV]: value }, async () => {
        const app = await serve();
        try {
          // Even presenting the "right" value cannot open an unconfigured or weak gate.
          for (const headers of [{}, { [DB_RECOVERY_TOKEN_HEADER]: String(value ?? "") }]) {
            const res = await app.get(headers);
            assert.equal(res.status, 503, `weak/absent secret accepted: ${String(value)}`);
            assert.ok(!res.body.data);
          }
        } finally {
          await app.stop();
        }
      });
    }
  });

  it("2c — a token copied from another environment secret disables the gate", async () => {
    const shared = "zzsharedsecretzz-0123456789abcdef-0123456789";
    for (const other of ["JWT_SECRET", "ADMIN_USER_AUDIT_TOKEN", "OAUTH_TOKEN_ENCRYPTION_KEY", "SOME_SUPPLIER_API_KEY"]) {
      await withEnv({ [DB_RECOVERY_TOKEN_ENV]: shared, [other]: shared }, async () => {
        assert.equal(isGateConfigured(process.env), false, `reuse of ${other} was accepted`);
        const app = await serve();
        try {
          const res = await app.get({ [DB_RECOVERY_TOKEN_HEADER]: shared });
          assert.equal(res.status, 503);
        } finally {
          await app.stop();
        }
      });
    }
  });

  it("2d — a repeated header is refused rather than folded into an accepted value", async () => {
    await withEnv({ [DB_RECOVERY_TOKEN_ENV]: GOOD_TOKEN }, async () => {
      const app = await serve();
      try {
        // Node folds duplicates of an unknown header into "a, b". That must not match.
        const res = await app.get({ [DB_RECOVERY_TOKEN_HEADER]: `${WRONG_TOKEN}, ${GOOD_TOKEN}` });
        assert.equal(res.status, 401);
      } finally {
        await app.stop();
      }
    });
  });
});

describe("database recovery break-glass — acceptance", () => {
  it("3 — the correct token runs the diagnostic", async () => {
    await withEnv({ [DB_RECOVERY_TOKEN_ENV]: GOOD_TOKEN, DIRECT_URL: undefined }, async () => {
      const app = await serve(databaseRecoveryDiagnosticHandler);
      try {
        const res = await app.get({ [DB_RECOVERY_TOKEN_HEADER]: GOOD_TOKEN });
        assert.equal(res.status, 200);
        // The real service ran: DIRECT_URL is absent here, so it reports that and nothing else.
        assert.equal(res.body.data.errorCategory, "MISSING_URL");
        assert.equal(res.body.data.directUrlPresent, false);
        assert.equal(res.body.data.connectionOk, false);
      } finally {
        await app.stop();
      }
    });
  });

  it("3b — the accepted response still carries both cache headers", async () => {
    await withEnv({ [DB_RECOVERY_TOKEN_ENV]: GOOD_TOKEN, DIRECT_URL: undefined }, async () => {
      const app = await serve(databaseRecoveryDiagnosticHandler);
      try {
        const res = await app.get({ [DB_RECOVERY_TOKEN_HEADER]: GOOD_TOKEN });
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("pragma"), "no-cache");
      } finally {
        await app.stop();
      }
    });
  });

  it("3c — comparison is constant-time and exact", () => {
    assert.equal(constantTimeEquals(GOOD_TOKEN, GOOD_TOKEN), true);
    assert.equal(constantTimeEquals(GOOD_TOKEN, WRONG_TOKEN), false);
    // Differing lengths must return false, not throw — throwing would leak the expected length.
    assert.doesNotThrow(() => constantTimeEquals("a", GOOD_TOKEN));
    assert.equal(constantTimeEquals("a", GOOD_TOKEN), false);
    assert.equal(constantTimeEquals(GOOD_TOKEN, undefined), false);
    assert.equal(constantTimeEquals(undefined, undefined), true);
    // The comparison hashes both sides, so it never compares raw secret bytes of unequal length.
    assert.match(gateSource, /createHash\("sha256"\)/);
    assert.match(gateSource, /timingSafeEqual/);
  });

  it("3d — reuse detection ignores the variable's own entry", () => {
    assert.equal(isTokenReused(GOOD_TOKEN, { [DB_RECOVERY_TOKEN_ENV]: GOOD_TOKEN }), false);
    assert.equal(isTokenReused(GOOD_TOKEN, { [DB_RECOVERY_TOKEN_ENV]: GOOD_TOKEN, OTHER: GOOD_TOKEN }), true);
    assert.equal(isTokenReused(GOOD_TOKEN, { OTHER: "different" }), false);
    assert.equal(isTokenReused("", { OTHER: "" }), false);
  });
});

describe("database recovery break-glass — the token never escapes", () => {
  it("4 — the token appears in no response, on any path", async () => {
    await withEnv({ [DB_RECOVERY_TOKEN_ENV]: GOOD_TOKEN, DIRECT_URL: undefined }, async () => {
      const app = await serve(databaseRecoveryDiagnosticHandler);
      try {
        const responses = [
          await app.get(),
          await app.get({ [DB_RECOVERY_TOKEN_HEADER]: WRONG_TOKEN }),
          await app.get({ [DB_RECOVERY_TOKEN_HEADER]: GOOD_TOKEN }),
        ];
        for (const res of responses) {
          assert.ok(!res.text.includes(GOOD_TOKEN), "the expected token leaked into a body");
          assert.ok(!res.text.includes(WRONG_TOKEN), "the presented token was echoed back");
          assert.ok(!res.text.includes("zzbreakglass"), "a token fragment leaked");
          for (const [name, value] of res.headers.entries()) {
            assert.ok(!String(value).includes("zzbreakglass"), `token leaked in header ${name}`);
            assert.ok(!String(value).includes("zzwrongglass"), `token echoed in header ${name}`);
          }
        }
      } finally {
        await app.stop();
      }
    });
  });

  it("5 — the token cannot reach a log line", () => {
    // The gate itself never logs: it imports no logger and calls no console. Prose may discuss
    // logging; code may not do it, so comments are stripped before the check.
    assert.ok(!/\bconsole\./.test(gateCode), "the gate writes to console");
    assert.ok(!/logger/i.test(gateCode), "the gate references a logger");

    // The request logger builds a fixed payload. It does read four correlation headers by name, so
    // the property to hold is that the set is an allowlist and the bag is never spread wholesale.
    const readHeaders = [...requestLoggerSource.matchAll(/req\.headers\["([^"]+)"\]/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(readHeaders)].sort(),
      ["x-client-id", "x-request-id", "x-tenant-id", "x-trace-id"],
      "the request logger reads a header it did not read before",
    );
    const payload = requestLoggerSource.slice(
      requestLoggerSource.indexOf("const logPayload = {"),
      requestLoggerSource.indexOf("};", requestLoggerSource.indexOf("const logPayload = {")),
    );
    for (const banned of ["...req.headers", "req.headers)", "authorization", "x-db-recovery-token"]) {
      assert.ok(!payload.includes(banned), `request log payload includes ${banned}`);
    }
    assert.ok(!requestLoggerSource.includes("x-db-recovery-token"), "request logger names the token header");

    // And if any future code does log a header bag, the sanitiser blanks this one.
    const sanitised = sanitizeForLog({
      [DB_RECOVERY_TOKEN_HEADER]: GOOD_TOKEN,
      nested: { [DB_RECOVERY_TOKEN_HEADER]: GOOD_TOKEN },
      DB_RECOVERY_DIAGNOSTIC_TOKEN: GOOD_TOKEN,
    });
    assert.ok(!JSON.stringify(sanitised).includes(GOOD_TOKEN), "the sanitiser let the token through");
    assert.equal(sanitised[DB_RECOVERY_TOKEN_HEADER], "[redacted]");
  });

  it("5b — the token is never attached to the request object", async () => {
    await withEnv({ [DB_RECOVERY_TOKEN_ENV]: GOOD_TOKEN }, async () => {
      let seen = null;
      const app = await serve((req, res) => {
        // Anything the gate added to `req` other than the raw incoming header.
        seen = Object.entries(req)
          .filter(([, v]) => typeof v === "string" && v.includes("zzbreakglass"))
          .map(([k]) => k);
        res.json({ ok: true });
      });
      try {
        await app.get({ [DB_RECOVERY_TOKEN_HEADER]: GOOD_TOKEN });
        assert.deepEqual(seen, [], `the gate copied the token onto req: ${seen?.join(", ")}`);
      } finally {
        await app.stop();
      }
    });
  });
});

describe("database recovery break-glass — blast radius", () => {
  it("6 — the guarded route is still read-only", () => {
    assert.ok(!recoveryRouteSource.includes("auditAction"), "the route must not write an audit row");
    assert.match(recoveryRouteSource, /app\.get\(/, "still a GET");
    for (const verb of ["app.post(", "app.put(", "app.patch(", "app.delete("]) {
      assert.ok(!recoveryRouteSource.includes(verb), `the module registers a ${verb}`);
    }
    // The gate performs no database work of any kind.
    for (const token of ["prisma", "PrismaClient", "$queryRaw", "findUnique", "await "]) {
      assert.ok(!gateCode.includes(token), `the gate does database or async work: ${token}`);
    }
  });

  it("7 — no other route accepts the break-glass token", () => {
    // The gate is referenced only by the one emergency route module: one import, one use.
    assert.equal(recoveryRouteSource.split("requireDatabaseRecoveryToken").length - 1, 2);
    assert.ok(!routesSource.includes("requireDatabaseRecoveryToken"), "the main router uses the gate");
    assert.ok(!appSource.includes("requireDatabaseRecoveryToken"), "app.js uses the gate directly");
    // And the module registers exactly one path.
    assert.equal(recoveryRouteSource.split("app.get(").length - 1, 1);

    // Nothing outside the gate module reads the header or the variable.
    const readers = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          if (full.endsWith("src/middleware/databaseRecoveryToken.js")) continue;
          // Prose may name them; code may not read them, so comments are stripped first.
          const text = readFileSync(full, "utf8").replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "");
          if (text.includes(DB_RECOVERY_TOKEN_HEADER) || text.includes("DB_RECOVERY_DIAGNOSTIC_TOKEN")) {
            readers.push(full);
          }
        }
      }
    };
    walk("src");
    // Only the log sanitiser may name them, and only as denylist entries.
    assert.deepEqual(readers, ["src/platform/logging/context.js"], `unexpected readers: ${readers}`);
  });

  it("8 — normal authentication elsewhere is unchanged", () => {
    assert.match(authSource, /export async function authenticate\(req, res, next\) \{/);
    assert.match(authSource, /const user = await findUserById\(payload\.sub\);/);
    assert.match(authSource, /export function requirePermission\(\.\.\.requiredPermissions\) \{/);
    assert.match(authSource, /roleHasAnyPermission\(req\.user\.role, requiredPermissions\)/);
    // The break-glass gate is a separate module: auth.js knows nothing about it.
    assert.ok(!authSource.includes("DB_RECOVERY"), "break-glass logic leaked into shared auth");
    assert.ok(!authSource.includes("x-db-recovery-token"));

    // Every other ops route still uses the DB-backed chain.
    for (const path of [
      "/ops/raw-payloads",
      "/ops/admin/network-certification",
      "/ops/admin/network-certification/:network/run",
    ]) {
      const start = routesSource.indexOf(`"${path}"`);
      assert.ok(start > 0, `${path} still registered`);
      const block = routesSource.slice(start, routesSource.indexOf(");", start));
      assert.match(block, /authenticate,/, `${path} lost DB-backed auth`);
      assert.match(block, /requirePermission\(/, `${path} lost its permission gate`);
      assert.ok(!block.includes("requireDatabaseRecoveryToken"), `${path} accepts the break-glass token`);
    }
  });

  it("8b — the gate and its route are documented as temporary", () => {
    assert.match(gateSource, /TEMPORARY/);
    assert.match(recoveryRouteSource, /TEMPORARY/);
    assert.match(appSource, /TEMPORARY break-glass diagnostic/);
  });
});
