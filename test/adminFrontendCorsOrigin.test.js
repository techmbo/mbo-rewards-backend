/**
 * ADMIN_FRONTEND_ORIGIN — optional extra CORS origin for the separately hosted
 * admin frontend. These tests pin that:
 *   1. FRONTEND_URL's origin is still allowed,
 *   2. FRONTEND_ORIGINS entries are still allowed (same normalization as before),
 *   3. a valid ADMIN_FRONTEND_ORIGIN is allowed,
 *   4. an absent ADMIN_FRONTEND_ORIGIN leaves the allowlist byte-for-byte unchanged,
 *   5. blank / malformed / non-http(s) / wildcard values never broaden the allowlist.
 *
 * The pure helper is tested directly; the end-to-end cases go through the real
 * corsOptions() in a child process so the module-level constants are built from
 * a controlled environment (urls.js evaluates process.env at import time).
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildFrontendOrigins,
  FRONTEND_ORIGIN,
  normalizeOptionalOrigin,
} from "../src/config/urls.js";
import { corsOptions } from "../src/platform/security/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FRONTEND_URL = "https://www.mborewards.com/mbointegratedPlatform";
const FRONTEND_ORIGINS = "http://localhost:3000, http://127.0.0.1:3000/,https://staging.mborewards.com";
const ADMIN = "https://mbo-rewards-admin.vercel.app";

/**
 * Run the real corsOptions() in a fresh Node process with a controlled env and
 * return { allowlist, decisions } for the probed origins.
 */
function probeCors(env, origins) {
  const script = `
    import { corsOptions } from "./src/platform/security/index.js";
    import { FRONTEND_ORIGINS, ADMIN_FRONTEND_ORIGIN } from "./src/config/urls.js";
    const opts = corsOptions();
    const probe = (o) => new Promise((r) => opts.origin(o, (err, ok) => r(err ? "blocked" : ok ? "allowed" : "blocked")));
    const origins = ${JSON.stringify(origins)};
    const decisions = {};
    // JSON serializes the trailing undefined probe as null: treat null as "no Origin header".
    for (const o of origins) decisions[o == null ? "<no-origin>" : o] = await probe(o ?? undefined);
    console.log(JSON.stringify({ allowlist: FRONTEND_ORIGINS, adminOrigin: ADMIN_FRONTEND_ORIGIN, decisions }));
  `;
  const base = {
    PATH: process.env.PATH,
    NODE_ENV: "test",
    BACKEND_URL: "https://mbo-rewards-backend.vercel.app",
    FRONTEND_URL,
    FRONTEND_ORIGINS,
  };
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    env: { ...base, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

describe("normalizeOptionalOrigin", () => {
  it("normalizes a valid http(s) URL to its origin (path, trailing slash, whitespace dropped)", () => {
    assert.equal(normalizeOptionalOrigin(" https://mbo-rewards-admin.vercel.app/ "), ADMIN);
    assert.equal(normalizeOptionalOrigin("https://mbo-rewards-admin.vercel.app/login?x=1"), ADMIN);
    assert.equal(normalizeOptionalOrigin("http://localhost:5173"), "http://localhost:5173");
  });

  it("returns null for blank, malformed, wildcard, opaque and non-http(s) values", () => {
    for (const bad of [undefined, null, "", "   ", "not a url", "*", "null", "mbo-rewards-admin.vercel.app", "https://", "javascript:alert(1)", "file:///etc/passwd", "ftp://x.example", "https://a.example, https://b.example"]) {
      assert.equal(normalizeOptionalOrigin(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("buildFrontendOrigins", () => {
  const legacyList = () => buildFrontendOrigins({ frontendUrl: FRONTEND_URL, frontendOrigins: FRONTEND_ORIGINS });

  it("1. keeps FRONTEND_URL's origin first", () => {
    assert.equal(legacyList()[0], "https://www.mborewards.com");
  });

  it("2. keeps FRONTEND_ORIGINS entries with the original normalization (trim, origin, raw fallback, dedupe)", () => {
    assert.deepEqual(
      buildFrontendOrigins({ frontendUrl: "https://a.example/app", frontendOrigins: " http://localhost:3000 ,http://127.0.0.1:3000/,not-a-url/,https://a.example,https://a.example" }),
      ["https://a.example", "http://localhost:3000", "http://127.0.0.1:3000", "not-a-url"],
    );
  });

  it("3. appends a valid ADMIN_FRONTEND_ORIGIN after the existing entries", () => {
    assert.deepEqual(
      buildFrontendOrigins({ frontendUrl: FRONTEND_URL, frontendOrigins: FRONTEND_ORIGINS, adminFrontendOrigin: `${ADMIN}/` }),
      [...legacyList(), ADMIN],
    );
  });

  it("3b. a duplicate ADMIN_FRONTEND_ORIGIN is deduplicated, not appended twice", () => {
    assert.deepEqual(
      buildFrontendOrigins({ frontendUrl: FRONTEND_URL, frontendOrigins: FRONTEND_ORIGINS, adminFrontendOrigin: "https://www.mborewards.com" }),
      legacyList(),
    );
  });

  it("4. absent ADMIN_FRONTEND_ORIGIN produces exactly the legacy list", () => {
    assert.deepEqual(buildFrontendOrigins({ frontendUrl: FRONTEND_URL, frontendOrigins: FRONTEND_ORIGINS, adminFrontendOrigin: undefined }), legacyList());
    assert.deepEqual(buildFrontendOrigins({ frontendUrl: FRONTEND_URL, frontendOrigins: FRONTEND_ORIGINS, adminFrontendOrigin: "" }), legacyList());
  });

  it("5. malformed / wildcard / opaque ADMIN_FRONTEND_ORIGIN never broadens the list", () => {
    for (const bad of ["   ", "not a url", "*", "null", "javascript:alert(1)", "https://", "admin.example.com"]) {
      assert.deepEqual(
        buildFrontendOrigins({ frontendUrl: FRONTEND_URL, frontendOrigins: FRONTEND_ORIGINS, adminFrontendOrigin: bad }),
        legacyList(),
        `expected unchanged list for ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe("corsOptions() end-to-end with ADMIN_FRONTEND_ORIGIN (child process, controlled env)", () => {
  const probes = ["https://www.mborewards.com", "http://localhost:3000", "http://127.0.0.1:3000", "https://staging.mborewards.com", ADMIN, "https://evil.example", undefined];

  it("1+2. FRONTEND_URL and FRONTEND_ORIGINS are allowed; unknown origins are blocked; no-Origin requests pass", () => {
    const { allowlist, adminOrigin, decisions } = probeCors({}, probes);
    assert.equal(adminOrigin, null);
    assert.deepEqual(allowlist, ["https://www.mborewards.com", "http://localhost:3000", "http://127.0.0.1:3000", "https://staging.mborewards.com"]);
    assert.equal(decisions["https://www.mborewards.com"], "allowed");
    assert.equal(decisions["http://localhost:3000"], "allowed");
    assert.equal(decisions["http://127.0.0.1:3000"], "allowed");
    assert.equal(decisions["https://staging.mborewards.com"], "allowed");
    assert.equal(decisions["https://evil.example"], "blocked");
    assert.equal(decisions["<no-origin>"], "allowed");
    assert.equal(decisions[ADMIN], "blocked", "admin origin must NOT be allowed when the variable is absent");
  });

  it("3. a valid ADMIN_FRONTEND_ORIGIN is accepted alongside the existing origins", () => {
    const { allowlist, adminOrigin, decisions } = probeCors({ ADMIN_FRONTEND_ORIGIN: `${ADMIN}/` }, probes);
    assert.equal(adminOrigin, ADMIN);
    assert.deepEqual(allowlist, ["https://www.mborewards.com", "http://localhost:3000", "http://127.0.0.1:3000", "https://staging.mborewards.com", ADMIN]);
    assert.equal(decisions[ADMIN], "allowed");
    assert.equal(decisions["https://www.mborewards.com"], "allowed");
    assert.equal(decisions["https://staging.mborewards.com"], "allowed");
    assert.equal(decisions["https://evil.example"], "blocked");
  });

  it("4. absent ADMIN_FRONTEND_ORIGIN leaves the allowlist identical to the no-variable case", () => {
    const without = probeCors({}, probes);
    const blank = probeCors({ ADMIN_FRONTEND_ORIGIN: "" }, probes);
    assert.deepEqual(blank.allowlist, without.allowlist);
    assert.deepEqual(blank.decisions, without.decisions);
  });

  it("5. blank / malformed / wildcard values do not broaden CORS", () => {
    const baseline = probeCors({}, probes);
    for (const bad of ["   ", "not a url", "*", "null", "javascript:alert(1)", "https://"]) {
      const result = probeCors({ ADMIN_FRONTEND_ORIGIN: bad }, probes);
      assert.equal(result.adminOrigin, null, `expected null admin origin for ${JSON.stringify(bad)}`);
      assert.deepEqual(result.allowlist, baseline.allowlist, `allowlist changed for ${JSON.stringify(bad)}`);
      assert.equal(result.decisions["https://evil.example"], "blocked");
      assert.equal(result.decisions[ADMIN], "blocked");
    }
  });
});

describe("corsOptions() in this test process still honours FRONTEND_URL", () => {
  it("allows the configured FRONTEND_URL origin and keeps credentials/headers unchanged", async () => {
    const opts = corsOptions();
    const allowed = await new Promise((r) => opts.origin(FRONTEND_ORIGIN, (err, ok) => r(!err && ok === true)));
    assert.equal(allowed, true);
    assert.equal(opts.credentials, true);
    assert.ok(opts.allowedHeaders.includes("Authorization"));
    assert.ok(opts.allowedHeaders.includes("X-Api-Key"));
    assert.deepEqual(opts.methods, ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
  });
});
