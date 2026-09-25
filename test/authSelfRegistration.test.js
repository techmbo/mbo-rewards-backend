/**
 * Public self-registration is a bootstrap door, not an onboarding path.
 *
 * It may create the FIRST administrator of an empty platform. Once any User exists, both
 * POST /auth/send-otp and POST /auth/register answer 403 with one generic message for every email
 * address, registerUser() itself refuses even a caller holding a valid verification token, and two
 * concurrent first signups cannot both become ADMIN. Admin and invitation flows are untouched.
 *
 * The Prisma client is the real exported instance with its delegates replaced by an in-memory store
 * that models what the guard relies on: a users table, OTP rows, an interactive transaction, and a
 * Postgres advisory transaction lock that serializes competing transactions.
 */
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import express from "express";

const { prisma } = await import("../src/database/prisma.js");
const auth = await import("../src/modules/auth/auth.service.js");
const otp = await import("../src/modules/auth/otp.service.js");
const controller = await import("../src/controllers/auth.controller.js");
const { getPermissionsForRole, PERMISSIONS } = await import("../src/auth/permissions.js");

const CLOSED = "Public registration is closed. Ask an administrator for an invitation.";
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

// ─── in-memory Prisma double ─────────────────────────────────────────────────────────────────

/**
 * @param {object} [options]
 * @param {boolean} [options.advisoryLock] honour pg_advisory_xact_lock (false = harness self-check)
 * @param {number} [options.rendezvous] how many transactions must have STARTED before any
 *   transaction-scoped user.count returns. With 2, two concurrent registrations are guaranteed to
 *   be inside their transactions at the same time, so only the lock can serialize them; without a
 *   rendezvous, bcrypt timing alone could let one commit before the other even begins.
 */
function makeStore({ advisoryLock = true, rendezvous = 1 } = {}) {
  const users = [];
  const otps = [];
  const accessLogs = [];
  const calls = [];
  let nextId = 1;
  let txStarted = 0;
  // One waiter chain per lock key: pg_advisory_xact_lock semantics, released at transaction end.
  const lockChains = new Map();

  const p2002 = () => {
    const error = new Error("Unique constraint failed on the fields: (`email`)");
    error.code = "P2002";
    return error;
  };

  const userDelegate = {
    count: async () => {
      calls.push("user.count");
      await yieldTurn(); // let a competing request interleave here, exactly where the race lives
      return users.length;
    },
    findUnique: async ({ where }) => {
      calls.push("user.findUnique");
      if (where.email) return users.find((u) => u.email === where.email) ?? null;
      if (where.id) return users.find((u) => u.id === where.id) ?? null;
      return null;
    },
    create: async ({ data }) => {
      calls.push("user.create");
      await yieldTurn();
      if (users.some((u) => u.email === data.email)) throw p2002();
      const row = {
        id: `user-${nextId++}`,
        isActive: true,
        clientId: null,
        inviteTokenHash: null,
        createdAt: new Date(),
        ...data,
      };
      users.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = users.find((u) => u.id === where.id);
      Object.assign(row, data);
      return row;
    },
  };
  const emailOtpDelegate = {
    findFirst: async ({ where }) => {
      calls.push("emailOtp.findFirst");
      const rows = otps.filter((r) => r.email === where.email && (where.verifiedAt === undefined || r.verifiedAt === where.verifiedAt));
      return rows.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
    },
    create: async ({ data }) => {
      calls.push("emailOtp.create");
      const row = { id: `otp-${otps.length + 1}`, attempts: 0, verifiedAt: null, createdAt: new Date(), ...data };
      otps.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      const row = otps.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
    deleteMany: async ({ where }) => {
      calls.push("emailOtp.deleteMany");
      const before = otps.length;
      for (let i = otps.length - 1; i >= 0; i -= 1) if (otps[i].email === where.email) otps.splice(i, 1);
      return { count: before - otps.length };
    },
  };
  const accessLogDelegate = {
    create: async ({ data }) => {
      accessLogs.push(data);
      return data;
    },
  };

  /** Blocks until every earlier holder of `key` has released; returns the release function. */
  function acquire(key) {
    const previous = lockChains.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((resolve) => {
      release = resolve;
    });
    lockChains.set(key, previous.then(() => mine));
    return previous.then(() => release);
  }

  const txUserDelegate = {
    ...userDelegate,
    count: async () => {
      calls.push("tx.user.count");
      while (txStarted < rendezvous) await yieldTurn(); // eslint-disable-line no-await-in-loop
      await yieldTurn();
      return users.length;
    },
  };

  const $transaction = async (fn) => {
    calls.push("$transaction");
    txStarted += 1;
    const releases = [];
    const tx = {
      user: txUserDelegate,
      emailOtp: emailOtpDelegate,
      accessLog: accessLogDelegate,
      $executeRaw: async (strings, ...values) => {
        const sql = strings.join("?");
        calls.push(`$executeRaw:${sql.trim()}`);
        if (advisoryLock && sql.includes("pg_advisory_xact_lock")) {
          releases.push(await acquire(String(values[0])));
        }
        return 1;
      },
    };
    try {
      return await fn(tx);
    } finally {
      for (const release of releases) release();
    }
  };

  return {
    delegates: { user: userDelegate, emailOtp: emailOtpDelegate, accessLog: accessLogDelegate, $transaction },
    users,
    otps,
    accessLogs,
    calls,
  };
}

const ORIGINALS = {};
let store;
function install(options) {
  store = makeStore(options);
  for (const [key, value] of Object.entries(store.delegates)) {
    if (!(key in ORIGINALS)) ORIGINALS[key] = prisma[key];
    prisma[key] = value;
  }
  return store;
}
beforeEach(() => install());
after(() => {
  for (const [key, value] of Object.entries(ORIGINALS)) prisma[key] = value;
});

const token = (email) => otp.signEmailVerificationToken(email);
const seedAdmin = async () =>
  store.users.push({ id: "user-seed", email: "first@example.com", passwordHash: "x", name: "First", role: "ADMIN", isActive: true, clientId: null, inviteTokenHash: null, createdAt: new Date() });

async function expectClosed(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.message, CLOSED);
    return true;
  });
}

// ─── service level ───────────────────────────────────────────────────────────────────────────

describe("registerUser: bootstrap only", () => {
  it("1. empty table: a verified signup creates exactly one user, role ADMIN", async () => {
    const user = await auth.registerUser({ email: "Owner@Example.com", password: "correct horse", name: " Owner ", verificationToken: token("owner@example.com") });
    assert.equal(user.role, "ADMIN");
    assert.equal(user.email, "owner@example.com");
    assert.equal(user.name, "Owner");
    assert.equal(store.users.length, 1);
    assert.ok(store.calls.includes("$transaction"), "the decision runs in a transaction");
    assert.ok(store.calls.some((c) => c.startsWith("$executeRaw:SELECT pg_advisory_xact_lock")), "under the advisory lock");
  });

  it("2. second public registration with a valid token: 403, no user created, no SUPPORT", async () => {
    await seedAdmin();
    await expectClosed(auth.registerUser({ email: "second@example.com", password: "correct horse", verificationToken: token("second@example.com") }));
    assert.equal(store.users.length, 1);
    assert.ok(!store.users.some((u) => u.role === "SUPPORT"));
    assert.ok(!store.calls.includes("user.create"));
  });

  it("5. direct service bypass with a valid token is blocked after bootstrap", async () => {
    await seedAdmin();
    // No controller, no OTP-send gate: the token alone is valid and the service still refuses.
    const valid = token("bypass@example.com");
    assert.equal(otp.verifyEmailVerificationToken(valid).email, "bypass@example.com");
    await expectClosed(auth.registerUser({ email: "bypass@example.com", password: "correct horse", verificationToken: valid }));
    assert.equal(store.users.length, 1);
  });

  it("6. the public path never creates SUPPORT: only ADMIN when open, nothing when closed", async () => {
    const first = await auth.registerUser({ email: "a@example.com", password: "correct horse", verificationToken: token("a@example.com") });
    assert.equal(first.role, "ADMIN");
    for (const email of ["b@example.com", "c@example.com"]) {
      // eslint-disable-next-line no-await-in-loop
      await expectClosed(auth.registerUser({ email, password: "correct horse", verificationToken: token(email) }));
    }
    assert.deepEqual(store.users.map((u) => u.role), ["ADMIN"]);
  });

  it("9. verification email mismatch is still a 400 and reaches no database write", async () => {
    await assert.rejects(
      auth.registerUser({ email: "one@example.com", password: "correct horse", verificationToken: token("other@example.com") }),
      (error) => error.statusCode === 400 && /does not match/.test(error.message),
    );
    assert.equal(store.users.length, 0);
    assert.ok(!store.calls.includes("user.create"));
  });

  it("an invalid or expired token is still a 401 before any bootstrap check", async () => {
    await assert.rejects(
      auth.registerUser({ email: "one@example.com", password: "correct horse", verificationToken: "not-a-token" }),
      (error) => error.statusCode === 401,
    );
    assert.deepEqual(store.calls, []);
  });

  it("verification OTP rows are consumed inside the successful bootstrap transaction and untouched on refusal", async () => {
    store.otps.push({ id: "otp-a", email: "owner@example.com", otpHash: "h", expiresAt: new Date(Date.now() + 60_000), verifiedAt: new Date(), attempts: 0, createdAt: new Date() });
    store.otps.push({ id: "otp-b", email: "second@example.com", otpHash: "h", expiresAt: new Date(Date.now() + 60_000), verifiedAt: new Date(), attempts: 0, createdAt: new Date() });
    await auth.registerUser({ email: "owner@example.com", password: "correct horse", verificationToken: token("owner@example.com") });
    assert.deepEqual(store.otps.map((r) => r.id), ["otp-b"], "winner's OTP rows consumed");
    await expectClosed(auth.registerUser({ email: "second@example.com", password: "correct horse", verificationToken: token("second@example.com") }));
    assert.deepEqual(store.otps.map((r) => r.id), ["otp-b"], "a refused registration consumes nothing");
  });
});

describe("registerUser: concurrent bootstrap", () => {
  it("7. two simultaneous first signups: exactly one ADMIN, the loser gets a controlled 403", async () => {
    install({ rendezvous: 2 });
    const attempts = [
      auth.registerUser({ email: "one@example.com", password: "correct horse", verificationToken: token("one@example.com") }),
      auth.registerUser({ email: "two@example.com", password: "correct horse", verificationToken: token("two@example.com") }),
    ];
    const settled = await Promise.allSettled(attempts);
    const winners = settled.filter((r) => r.status === "fulfilled");
    const losers = settled.filter((r) => r.status === "rejected");
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.statusCode, 403);
    assert.equal(losers[0].reason.message, CLOSED);
    assert.ok(!/at .*\.js/.test(losers[0].reason.message), "no stack in the message");
    assert.equal(store.users.length, 1);
    assert.equal(store.users.filter((u) => u.role === "ADMIN").length, 1);
    assert.equal(winners[0].value.role, "ADMIN");
    // Both callers reached the locked section; the loser's in-transaction count saw the winner.
    assert.equal(store.calls.filter((c) => c === "$transaction").length, 2);
    assert.equal(store.calls.filter((c) => c === "tx.user.count").length, 2);
    assert.equal(store.calls.filter((c) => c === "user.create").length, 1);
  });

  it("8. two simultaneous first signups for the SAME email: one ADMIN, one controlled refusal", async () => {
    install({ rendezvous: 2 });
    const settled = await Promise.allSettled([
      auth.registerUser({ email: "same@example.com", password: "correct horse", verificationToken: token("same@example.com") }),
      auth.registerUser({ email: "same@example.com", password: "other horse", verificationToken: token("same@example.com") }),
    ]);
    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
    const loser = settled.find((r) => r.status === "rejected");
    assert.equal(loser.reason.statusCode, 403);
    assert.equal(store.users.length, 1);
  });

  it("harness self-check: without the advisory lock the same interleaving would create two admins", async () => {
    // Proves the concurrency tests above are decided by the lock, not by accidental serialization.
    install({ advisoryLock: false, rendezvous: 2 });
    await Promise.allSettled([
      auth.registerUser({ email: "one@example.com", password: "correct horse", verificationToken: token("one@example.com") }),
      auth.registerUser({ email: "two@example.com", password: "correct horse", verificationToken: token("two@example.com") }),
    ]);
    assert.equal(store.users.length, 2, "the unguarded race reproduces in the harness");
  });
});

// ─── HTTP boundary ───────────────────────────────────────────────────────────────────────────

describe("HTTP: /auth/send-otp and /auth/register", () => {
  let server;
  let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    router.post("/auth/send-otp", controller.sendOtpHandler);
    router.post("/auth/verify-otp", controller.verifyOtpHandler);
    router.post("/auth/register", controller.registerHandler);
    router.post("/auth/login", controller.loginHandler);
    app.use("/api", router);
    app.use((err, req, res, _next) => res.status(err.statusCode || 500).json({ ok: false, message: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/api`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function post(path, body) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  it("3. send-otp after bootstrap: 403 closed, no OTP row, no email step reached", async () => {
    await seedAdmin();
    const r = await post("/auth/send-otp", { email: "new@example.com" });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ok: false, message: CLOSED });
    assert.equal(store.otps.length, 0);
    assert.ok(!store.calls.includes("emailOtp.create"));
    assert.ok(!store.calls.includes("emailOtp.findFirst"), "sendSignupOtp was not entered");
  });

  it("4. no email enumeration after bootstrap: existing and unknown addresses get the identical 403", async () => {
    await seedAdmin();
    const existing = await post("/auth/send-otp", { email: "first@example.com" });
    const unknown = await post("/auth/send-otp", { email: "nobody@example.com" });
    assert.equal(existing.status, 403);
    assert.equal(unknown.status, 403);
    assert.deepEqual(existing.body, unknown.body);
    assert.deepEqual(existing.body, { ok: false, message: CLOSED });
    assert.ok(!store.calls.includes("user.findUnique"), "no per-email lookup happens once closed");
  });

  it("register after bootstrap over HTTP: 403 closed, no token, no user", async () => {
    await seedAdmin();
    const r = await post("/auth/register", { email: "new@example.com", password: "correct horse", verificationToken: token("new@example.com") });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ok: false, message: CLOSED });
    assert.equal(store.users.length, 1);
    assert.equal(store.accessLogs.length, 0);
  });

  it("bootstrap over HTTP still works end to end: send-otp, verify-otp, register → 201 ADMIN", async () => {
    const sent = await post("/auth/send-otp", { email: "boot@example.com" });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(store.otps.length, 1);
    // The stored hash is bcrypt of a random code we cannot read back; mint the token the way
    // verify-otp does once the code matches, then register with it.
    const verification = otp.signEmailVerificationToken("boot@example.com");
    const r = await post("/auth/register", { email: "boot@example.com", password: "correct horse", verificationToken: verification });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.user.role, "ADMIN");
    assert.ok(typeof r.body.accessToken === "string" && r.body.accessToken.length > 20);
    assert.match(r.body.message, /first user/i);
    assert.equal(store.users.length, 1);
    assert.equal(store.otps.length, 0, "verification rows consumed");
    assert.equal(store.accessLogs[0]?.action, "auth.register");
    // and the door is now shut for the next caller
    const again = await post("/auth/send-otp", { email: "later@example.com" });
    assert.equal(again.status, 403);
  });

  it("invalid email is still a 400 from validation, before the bootstrap check", async () => {
    await seedAdmin();
    const r = await post("/auth/send-otp", { email: "not-an-email" });
    assert.equal(r.status, 400);
  });
});

// ─── admin / invite / login flows unaffected ─────────────────────────────────────────────────

describe("admin and login flows are unchanged", () => {
  it("10. createUserByAdmin still creates non-ADMIN staff and CLIENT users after bootstrap", async () => {
    await seedAdmin();
    const support = await auth.createUserByAdmin({ email: "support@example.com", password: "correct horse", name: "S", role: "SUPPORT" });
    assert.equal(support.role, "SUPPORT");
    const client = await auth.createUserByAdmin({ email: "client@example.com", password: "correct horse", role: "CLIENT", clientId: "client-1" });
    assert.equal(client.role, "CLIENT");
    assert.equal(client.clientId, "client-1");
    await assert.rejects(auth.createUserByAdmin({ email: "c2@example.com", password: "correct horse", role: "CLIENT" }), (e) => e.statusCode === 400);
    await assert.rejects(auth.createUserByAdmin({ email: "support@example.com", password: "correct horse", role: "SUPPORT" }), (e) => e.statusCode === 409);
    assert.equal(store.users.length, 3);
  });

  it("11. normal login is unchanged", async () => {
    const passwordHash = await auth.hashPassword("correct horse");
    store.users.push({ id: "u1", email: "login@example.com", passwordHash, role: "OPERATIONS", isActive: true, clientId: null, inviteTokenHash: null, createdAt: new Date() });
    const user = await auth.loginUser({ email: "Login@Example.com", password: "correct horse" });
    assert.equal(user.id, "u1");
    await assert.rejects(auth.loginUser({ email: "login@example.com", password: "wrong" }), (e) => e.statusCode === 401);
    store.users[0].isActive = false;
    await assert.rejects(auth.loginUser({ email: "login@example.com", password: "correct horse" }), (e) => e.statusCode === 403);
  });

  it("SUPPORT permissions are unchanged: the creation path is what closed, not the role", () => {
    assert.deepEqual(getPermissionsForRole("SUPPORT"), [
      PERMISSIONS.CAMPAIGNS_READ,
      PERMISSIONS.COUPONS_READ,
      PERMISSIONS.EXCEPTIONS_READ,
      PERMISSIONS.CLIENTS_READ,
    ]);
  });

  it("static: registerUser holds no SUPPORT branch and the controller has no Support welcome", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const service = fs.readFileSync(path.join(here, "..", "src", "modules", "auth", "auth.service.js"), "utf8");
    const registerBody = service.slice(service.indexOf("export async function registerUser"), service.indexOf("export async function loginUser"));
    assert.ok(!registerBody.includes("SUPPORT"), "registerUser must not mention SUPPORT");
    assert.ok(!registerBody.includes('? "ADMIN" :'), "no count-based role ternary");
    assert.ok(registerBody.includes('role: "ADMIN"'));
    assert.ok(registerBody.includes("pg_advisory_xact_lock"));
    const ctrl = fs.readFileSync(path.join(here, "..", "src", "controllers", "auth.controller.js"), "utf8");
    assert.ok(!/Support access/.test(ctrl));
    assert.ok(ctrl.includes("isPublicRegistrationOpen"));
  });
});
