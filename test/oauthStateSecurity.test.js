/**
 * BLOCKER-1 — the marketplace OAuth callback is public, so its `state` is attacker-supplied text.
 *
 * These tests pin the boundary: a callback may only write supplier credentials when it carries a
 * state THIS server issued, has not already used, and has not let expire — and the platform and
 * accountLabel written under come from the stored row, never from the inbound string.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, beforeEach, afterEach } from "node:test";
import axios from "axios";
import crypto from "node:crypto";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";

// One configured platform is enough to exercise the gate; assertPlatformConfig refuses the rest.
process.env.BOOSTINY_OAUTH_AUTH_URL = "https://supplier.test/authorize";
process.env.BOOSTINY_OAUTH_TOKEN_URL = "https://supplier.test/token";
process.env.BOOSTINY_OAUTH_CLIENT_ID = "zzclientidzz";
process.env.BOOSTINY_OAUTH_CLIENT_SECRET = "zzclientsecretzz";

const { prisma } = await import("../src/database/prisma.js");
const {
  getOAuthConnectUrl,
  handleOAuthCallback,
  hashOAuthNonce,
  extractStateNonce,
  OAUTH_STATE_TTL_MS,
  OAUTH_STATE_REFUSAL,
} = await import("../src/modules/integrations/oauth.service.js");

/* ----------------------------------------------------------------------------- prisma double */

let states;
let upserts;
let originals;
let originalPost;

/** A store that behaves like the real one on the two things the guard depends on. */
function makeDelegates() {
  return {
    oAuthState: {
      create: async ({ data }) => {
        const row = { id: `st_${states.length}`, consumedAt: null, ...data };
        states.push(row);
        return row;
      },
      findUnique: async ({ where }) =>
        states.find((r) => r.nonceHash === where.nonceHash) || null,
      // The conditional update IS the compare-and-swap the replay guard relies on.
      updateMany: async ({ where, data }) => {
        const now = where.expiresAt?.gt ?? new Date();
        const hit = states.filter(
          (r) =>
            r.nonceHash === where.nonceHash &&
            r.consumedAt === null &&
            r.expiresAt.getTime() > now.getTime(),
        );
        for (const r of hit) r.consumedAt = data.consumedAt;
        return { count: hit.length };
      },
    },
    marketplaceAccount: {
      upsert: async (args) => {
        upserts.push(args);
        return { id: "acct_1", platform: args.where.platform_accountLabel.platform };
      },
      update: async () => ({
        id: "acct_1",
        environment: "PRODUCTION",
        credentialHealth: "HEALTHY",
        secretRef: null,
      }),
    },
    $transaction: async (fn) => fn(makeDelegates()),
  };
}

beforeEach(() => {
  states = [];
  upserts = [];
  const delegates = makeDelegates();
  originals = {};
  for (const n of Object.keys(delegates)) originals[n] = prisma[n];
  for (const [n, d] of Object.entries(delegates)) prisma[n] = d;
  originalPost = axios.post;
  axios.post = async () => ({
    data: { access_token: "zzaccesstokenzz", refresh_token: "zzrefreshtokenzz", expires_in: 3600 },
  });
});

afterEach(() => {
  for (const [n, o] of Object.entries(originals)) prisma[n] = o;
  axios.post = originalPost;
});

/** Issue a real state and hand back the string a supplier would redirect with. */
async function issue(accountLabel = "default") {
  const { state } = await getOAuthConnectUrl("boostiny", accountLabel, { userId: "user_1" });
  return state;
}

const callback = (state, platformFromPath = "boostiny") =>
  handleOAuthCallback({ code: "zzauthcodezz", state, platformFromPath });

/* ------------------------------------------------------------------------------------ tests */

describe("oauth state — only a state we issued is usable", () => {
  it("rejects a nonce that was never issued", async () => {
    const forged = `boostiny.${crypto.randomBytes(32).toString("hex")}`;
    await assert.rejects(() => callback(forged), new RegExp(OAUTH_STATE_REFUSAL));
    assert.equal(upserts.length, 0, "no credential may be written for an unissued state");
  });

  it("rejects a state with no parseable nonce", async () => {
    for (const bad of ["", "boostiny", "boostiny.", "boostiny.not-hex", "....."]) {
      await assert.rejects(() => callback(bad), new RegExp(OAUTH_STATE_REFUSAL));
    }
    assert.equal(upserts.length, 0);
  });

  it("rejects an expired state", async () => {
    const state = await issue();
    states[0].expiresAt = new Date(Date.now() - 1);
    await assert.rejects(() => callback(state), new RegExp(OAUTH_STATE_REFUSAL));
    assert.equal(upserts.length, 0, "an expired state must not write credentials");
  });

  it("rejects an already-consumed state", async () => {
    const state = await issue();
    states[0].consumedAt = new Date();
    await assert.rejects(() => callback(state), new RegExp(OAUTH_STATE_REFUSAL));
    assert.equal(upserts.length, 0);
  });

  it("rejects replay: the second use of a successful state writes nothing", async () => {
    const state = await issue();
    await callback(state);
    assert.equal(upserts.length, 1, "the first callback writes exactly once");

    await assert.rejects(() => callback(state), new RegExp(OAUTH_STATE_REFUSAL));
    assert.equal(upserts.length, 1, "replay must not write a second time");
  });

  it("marks the state consumed exactly once", async () => {
    const state = await issue();
    await callback(state);
    assert.ok(states[0].consumedAt instanceof Date, "a used state must be stamped consumed");

    const firstConsumedAt = states[0].consumedAt.getTime();
    await assert.rejects(() => callback(state), new RegExp(OAUTH_STATE_REFUSAL));
    assert.equal(states[0].consumedAt.getTime(), firstConsumedAt, "consumedAt must not move");
  });

  it("stores the nonce hashed, never in the clear", async () => {
    const state = await issue();
    const nonce = extractStateNonce(state);
    assert.ok(nonce, "the issued state must carry a parseable nonce");
    assert.equal(states[0].nonceHash, hashOAuthNonce(nonce));
    assert.ok(
      !JSON.stringify(states[0]).includes(nonce),
      "a read of the state row must not reveal the nonce",
    );
  });

  it("issues a state that expires within the declared TTL", async () => {
    await issue();
    const ttl = states[0].expiresAt.getTime() - Date.now();
    assert.ok(ttl > 0 && ttl <= OAUTH_STATE_TTL_MS, `ttl ${ttl} outside (0, ${OAUTH_STATE_TTL_MS}]`);
  });
});

describe("oauth state — authorization comes from the row, not the inbound text", () => {
  it("rejects a path platform that does not match the stored platform", async () => {
    const state = await issue();
    await assert.rejects(() => callback(state, "optimise_uk"), /state\/platform mismatch/);
    assert.equal(upserts.length, 0, "a mismatched platform must not write credentials");
  });

  it("ignores an accountLabel injected into the inbound state", async () => {
    const state = await issue("alpha");
    const nonce = extractStateNonce(state);

    // What an attacker would send: a label of their choosing spliced in ahead of the nonce.
    await callback(`boostiny.beta.${nonce}`);

    assert.equal(upserts.length, 1);
    assert.deepEqual(upserts[0].where.platform_accountLabel, {
      platform: "boostiny",
      accountLabel: "alpha",
    });
  });

  it("writes credentials only under the stored platform and accountLabel", async () => {
    const state = await issue("alpha");
    const result = await callback(state);

    assert.equal(upserts.length, 1);
    assert.deepEqual(upserts[0].where.platform_accountLabel, {
      platform: "boostiny",
      accountLabel: "alpha",
    });
    assert.equal(result.platform, "boostiny");
    assert.equal(result.accountLabel, "alpha");
  });

  it("does not carry the accountLabel in the issued state at all", async () => {
    const state = await issue("alpha");
    assert.ok(!state.includes("alpha"), "the label must not be in a string the caller can edit");
  });
});

/* ------------------------------------------------------------------------- route gate pinning */

const ROUTES = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");

/** The full router.<method>(...) call for a path, by paren depth rather than the first ");". */
function blockFor(path) {
  const at = ROUTES.indexOf(path);
  assert.ok(at > -1, `route ${path} is not mounted`);
  const start = ROUTES.lastIndexOf("router.", at);
  let depth = 0;
  for (let i = start; i < ROUTES.length; i += 1) {
    if (ROUTES[i] === "(") depth += 1;
    else if (ROUTES[i] === ")") {
      depth -= 1;
      if (depth === 0) return ROUTES.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated route block for ${path}`);
}

const CONNECT = '"/auth/connect/:platform"';
const CALLBACK = '"/auth/callback/marketplace/:platform"';

describe("oauth routes — gates", () => {
  it("the connect route requires staff authentication", () => {
    assert.match(blockFor(CONNECT), /\bauthenticate\b/);
  });

  it("the connect route requires the integrations-manage permission", () => {
    assert.match(blockFor(CONNECT), /requirePermission\(PERMISSIONS\.INTEGRATIONS_MANAGE\)/);
  });

  it("both OAuth routes are rate-limited", () => {
    assert.match(blockFor(CONNECT), /\bauthRateLimiter\b/);
    assert.match(blockFor(CALLBACK), /\bauthRateLimiter\b/);
  });

  it("the callback stays public — the supplier redirects a browser to it", () => {
    const block = blockFor(CALLBACK);
    assert.ok(!/\bauthenticate\b/.test(block), "the callback cannot require a session");
    assert.ok(!/requirePermission/.test(block));
  });
});
