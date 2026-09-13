import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.LOG_LEVEL = "silent";

const {
  BYPASS_ELIGIBLE_VERCEL_ENVS,
  DEV_AUTH_BYPASS_ENV,
  DEV_BYPASS_USER,
  applyDevBypassIdentity,
  devAuthBypassStatus,
  isBypassEligibleEnvironment,
  isBypassFlagSet,
  isDevAuthBypassActive,
  resetDevAuthBypassWarning,
} = await import("../src/middleware/devAuthBypass.js");

const { getPermissionsForRole, PERMISSIONS } = await import("../src/auth/permissions.js");

const env = (overrides) => ({ ...overrides });

/* ------------------------------------------------------- production refusal */

test("PRODUCTION REFUSES the bypass even when the flag is set", () => {
  resetDevAuthBypassWarning();
  for (const base of [
    { VERCEL_ENV: "production" },
    { VERCEL_ENV: "production", NODE_ENV: "production" },
    { VERCEL_ENV: "Production" },
    { VERCEL_ENV: " PRODUCTION " },
    { NODE_ENV: "production" },
  ]) {
    assert.equal(
      isDevAuthBypassActive(env({ ...base, [DEV_AUTH_BYPASS_ENV]: "true" })),
      false,
      JSON.stringify(base),
    );
  }
});

test("an unrecognised deployment environment refuses — absence of evidence is not Preview", () => {
  for (const value of ["staging", "prod", "live", "", "   ", "unknown", "PREVIEWX"]) {
    assert.equal(
      isBypassEligibleEnvironment(env({ VERCEL_ENV: value })),
      value.trim() === "" ? true : false,
      JSON.stringify(value),
    );
  }
  // An empty VERCEL_ENV falls through to NODE_ENV, which must then not be production.
  assert.equal(isBypassEligibleEnvironment(env({ VERCEL_ENV: "", NODE_ENV: "production" })), false);
});

test("NODE_ENV alone can never enable the bypass on Vercel", () => {
  // Vercel sets NODE_ENV=production for EVERY deployment, Preview included. If NODE_ENV were the
  // discriminator, Preview would be indistinguishable from Production.
  assert.equal(
    isDevAuthBypassActive(
      env({ [DEV_AUTH_BYPASS_ENV]: "true", VERCEL_ENV: "production", NODE_ENV: "development" }),
    ),
    false,
    "VERCEL_ENV must win over NODE_ENV",
  );
  assert.equal(
    isDevAuthBypassActive(
      env({ [DEV_AUTH_BYPASS_ENV]: "true", VERCEL_ENV: "preview", NODE_ENV: "production" }),
    ),
    true,
    "Preview with NODE_ENV=production is the normal Vercel Preview shape",
  );
});

/* ------------------------------------------------------------ activation */

test("the bypass activates only in Preview or Development with the exact flag", () => {
  assert.deepEqual([...BYPASS_ELIGIBLE_VERCEL_ENVS], ["preview", "development"]);
  for (const vercelEnv of BYPASS_ELIGIBLE_VERCEL_ENVS) {
    assert.equal(isDevAuthBypassActive(env({ VERCEL_ENV: vercelEnv, [DEV_AUTH_BYPASS_ENV]: "true" })), true, vercelEnv);
  }
  // Local development, no VERCEL_ENV at all.
  assert.equal(isDevAuthBypassActive(env({ NODE_ENV: "development", [DEV_AUTH_BYPASS_ENV]: "true" })), true);
});

test("the flag must be exactly \"true\"", () => {
  for (const value of ["1", "yes", "TRUE", "True", "on", " true", "true ", "", undefined]) {
    assert.equal(isBypassFlagSet(env({ [DEV_AUTH_BYPASS_ENV]: value })), false, JSON.stringify(value));
    assert.equal(
      isDevAuthBypassActive(env({ VERCEL_ENV: "preview", [DEV_AUTH_BYPASS_ENV]: value })),
      false,
      JSON.stringify(value),
    );
  }
  assert.equal(isBypassFlagSet(env({ [DEV_AUTH_BYPASS_ENV]: "true" })), true);
});

test("BYPASS OFF: no flag means normal auth in every environment", () => {
  for (const vercelEnv of ["preview", "development", "production", undefined]) {
    assert.equal(isDevAuthBypassActive(env({ VERCEL_ENV: vercelEnv })), false, String(vercelEnv));
  }
});

/* -------------------------------------------------------- synthetic identity */

test("the synthetic identity is ADMIN and resolves full ADMIN permissions", () => {
  const req = applyDevBypassIdentity({});
  assert.equal(req.user.role, "ADMIN");
  assert.equal(req.devAuthBypass, true);
  assert.deepEqual(req.permissions, getPermissionsForRole("ADMIN"));
  // Permission checks keep working unchanged against the synthetic context.
  for (const permission of [
    PERMISSIONS.CAMPAIGNS_READ,
    PERMISSIONS.TRACKING_MANAGE,
    PERMISSIONS.OPS_MANAGE,
    PERMISSIONS.USERS_MANAGE,
  ]) {
    assert.ok(req.permissions.includes(permission), permission);
  }
});

test("the synthetic identity is not a real account and carries no credential", () => {
  const serialised = JSON.stringify(DEV_BYPASS_USER);
  for (const banned of ["password", "passwordHash", "token", "secret", "jwt", "hash"]) {
    assert.ok(!serialised.toLowerCase().includes(banned), banned);
  }
  // An unroutable address, so it can never collide with or impersonate a real user.
  assert.match(DEV_BYPASS_USER.email, /\.local$/);
  assert.equal(DEV_BYPASS_USER.isDevBypass, true);
  assert.equal(DEV_BYPASS_USER.clientId, null);
  assert.ok(Object.isFrozen(DEV_BYPASS_USER));
});

test("applying the identity mutates only the request — no database call is possible", () => {
  const source = readFileSync(new URL("../src/middleware/devAuthBypass.js", import.meta.url), "utf8");
  for (const banned of ["prisma", "findUser", "$queryRaw", "$executeRaw", "create(", "update(", "upsert("]) {
    assert.ok(!source.includes(banned), banned);
  }
  // A fresh object each time: callers cannot mutate the shared constant.
  const a = applyDevBypassIdentity({});
  a.user.role = "CLIENT";
  assert.equal(applyDevBypassIdentity({}).user.role, "ADMIN");
});

/* ------------------------------------------------------------------ status */

test("the status endpoint reports the banner text only when active", () => {
  const active = devAuthBypassStatus(env({ VERCEL_ENV: "preview", [DEV_AUTH_BYPASS_ENV]: "true" }));
  assert.equal(active.active, true);
  assert.equal(active.banner, "DEV AUTH BYPASS ACTIVE");
  assert.equal(active.environment, "preview");

  const off = devAuthBypassStatus(env({ VERCEL_ENV: "production", [DEV_AUTH_BYPASS_ENV]: "true" }));
  assert.equal(off.active, false);
  assert.equal(off.banner, null);
});

test("the status payload never contains a credential", () => {
  const payload = JSON.stringify(devAuthBypassStatus(env({ VERCEL_ENV: "preview", [DEV_AUTH_BYPASS_ENV]: "true" })));
  for (const banned of ["token", "secret", "password", "jwt", "key"]) {
    assert.ok(!payload.toLowerCase().includes(banned), banned);
  }
});

/* --------------------------------------------------------- live middleware */

async function withApp(fn) {
  const { createApp } = await import("../src/app.js");
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  })();
}

test("PREVIEW + flag: an unauthenticated request reaches the app as ADMIN", async () => {
  await withEnv({ VERCEL_ENV: "preview", [DEV_AUTH_BYPASS_ENV]: "true" }, () =>
    withApp(async (base) => {
      const status = await fetch(`${base}/api/auth/dev-bypass-status`);
      assert.equal(status.status, 200);
      const statusBody = await status.json();
      assert.equal(statusBody.active, true);
      assert.equal(statusBody.banner, "DEV AUTH BYPASS ACTIVE");

      const me = await fetch(`${base}/api/auth/me`);
      assert.equal(me.status, 200);
      const body = await me.json();
      assert.equal(body.user.role, "ADMIN");
      assert.equal(body.devAuthBypass, true);
      assert.ok(body.user.permissions.includes("campaigns:read"));
      // No credential is ever handed to the browser.
      const raw = JSON.stringify(body).toLowerCase();
      for (const banned of ["passwordhash", "token", "secret"]) {
        assert.ok(!raw.includes(banned), banned);
      }
    }),
  );
});

test("PRODUCTION + flag: the same request is still rejected", async () => {
  resetDevAuthBypassWarning();
  await withEnv({ VERCEL_ENV: "production", [DEV_AUTH_BYPASS_ENV]: "true" }, () =>
    withApp(async (base) => {
      const status = await fetch(`${base}/api/auth/dev-bypass-status`);
      assert.equal((await status.json()).active, false);

      const me = await fetch(`${base}/api/auth/me`);
      assert.equal(me.status, 401, "production must refuse the bypass");
    }),
  );
});

test("BYPASS OFF: normal auth is unchanged", async () => {
  await withEnv({ VERCEL_ENV: "preview", [DEV_AUTH_BYPASS_ENV]: undefined }, () =>
    withApp(async (base) => {
      assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
      assert.equal((await fetch(`${base}/api/auth/dev-bypass-status`)).status, 200);
      assert.equal((await (await fetch(`${base}/api/auth/dev-bypass-status`)).json()).active, false);
    }),
  );
});

test("an invalid token is still rejected even while the bypass is active", async () => {
  await withEnv({ VERCEL_ENV: "preview", [DEV_AUTH_BYPASS_ENV]: "true" }, () =>
    withApp(async (base) => {
      // A NON-EMPTY but invalid token must never be upgraded to admin: the bypass applies only
      // where no credential was presented at all.
      for (const value of ["Bearer nonsense", "Bearer eyJhbGciOiJIUzI1NiJ9.x.y", "Bearer mbo_live_fake"]) {
        const res = await fetch(`${base}/api/auth/me`, { headers: { authorization: value } });
        assert.equal(res.status, 401, value);
      }
      // "Bearer " with nothing after it carries no credential, so it is equivalent to sending no
      // header and takes the bypass. That matches readBearerToken's pre-existing empty handling.
      const empty = await fetch(`${base}/api/auth/me`, { headers: { authorization: "Bearer " } });
      assert.equal(empty.status, 200);
      assert.equal((await empty.json()).devAuthBypass, true);
    }),
  );
});

/* ------------------------------------------------------------- source rules */

test("the bypass is confined to the dedicated module and one call site", () => {
  const authSrc = readFileSync(new URL("../src/middleware/auth.js", import.meta.url), "utf8");
  assert.equal((authSrc.match(/isDevAuthBypassActive\(\)/g) || []).length, 1);
  // Only `authenticate` is affected; the partner/API-key path is untouched.
  const partnerSection = authSrc.slice(authSrc.indexOf("authenticatePartner"));
  assert.ok(!partnerSection.includes("isDevAuthBypassActive"));
  assert.ok(!partnerSection.includes("applyDevBypassIdentity"));
});

test("authorization logic itself is untouched", () => {
  const authSrc = readFileSync(new URL("../src/middleware/auth.js", import.meta.url), "utf8");
  for (const guard of ["requirePermission", "requireAdminRole", "requireEntityTypeAccess"]) {
    const at = authSrc.indexOf(`export function ${guard}`);
    assert.ok(at > 0, guard);
    const body = authSrc.slice(at, at + 600);
    assert.ok(!body.includes("DevBypass"), `${guard} must not special-case the bypass`);
  }
});
