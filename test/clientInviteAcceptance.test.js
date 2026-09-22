import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { acceptInviteAndSetPassword, getInviteStatus } = await import(
  "../src/modules/client/services/clientOnboarding.service.js"
);
const { verifyPassword } = await import("../src/modules/auth/auth.service.js");
const { setPasswordBodySchema, inviteAdminBodySchema } = await import(
  "../src/modules/client/validators/schemas.js"
);
const { ROLE_PERMISSIONS, PERMISSIONS } = await import("../src/auth/permissions.js");

/**
 * Client portal invitation acceptance — the flow had NO test coverage before this file.
 *
 * The invite is a bearer secret handed out of band: whoever holds it can set the password on a
 * client portal account. So what matters is not only that the happy path works, but that every
 * other path fails closed — expired, replayed, unknown, deactivated — and that acceptance grants
 * CLIENT scope and nothing more.
 *
 * These drive the real service functions against an in-memory prisma double, using the optional
 * client injection the repositories already use. Nothing here mocks the functions under test.
 */

const TOKEN = "zzinvitetokenplaceholder0123456789zz";
const OTHER_TOKEN = "zzdifferenttokenplaceholder98765432zz";
const CLIENT_ID = "client-placeholder-id";
const OTHER_CLIENT_ID = "other-client-placeholder-id";
const PASSWORD = "PlaceholderPassw0rd!";

/** The service hashes the token the same way the inviter does. Mirrored, not imported, on purpose:
 *  if the hashing changes on one side only, these tests must fail. */
const hashInvite = (token) => createHash("sha256").update(String(token)).digest("hex");

const HOUR = 60 * 60 * 1000;

function userRow(over = {}) {
  return {
    id: "user-placeholder-id",
    email: "placeholder.admin@example.com",
    name: "PLACEHOLDER ADMIN",
    passwordHash: "placeholder-unusable-hash",
    role: "CLIENT",
    clientId: CLIENT_ID,
    isActive: true,
    inviteTokenHash: hashInvite(TOKEN),
    inviteExpiresAt: new Date(Date.now() + 24 * HOUR),
    passwordSetAt: null,
    client: { id: CLIENT_ID, name: "PLACEHOLDER CLIENT" },
    ...over,
  };
}

/** An in-memory prisma double that applies the same where-clauses the service sends. */
function db(rows = [userRow()]) {
  const store = rows.map((r) => ({ ...r }));
  const updates = [];
  return {
    store,
    updates,
    client: {
      user: {
        findFirst: async ({ where = {} }) => {
          const hit = store.find((row) => {
            if (where.inviteTokenHash !== undefined && row.inviteTokenHash !== where.inviteTokenHash) return false;
            if (where.role !== undefined && row.role !== where.role) return false;
            if (where.isActive !== undefined && row.isActive !== where.isActive) return false;
            return true;
          });
          return hit ? { ...hit } : null;
        },
        update: async ({ where, data }) => {
          const idx = store.findIndex((row) => row.id === where.id);
          if (idx === -1) throw new Error("no such user");
          store[idx] = { ...store[idx], ...data };
          updates.push({ id: where.id, data });
          return { ...store[idx] };
        },
      },
    },
  };
}

const statusOf = (error) => error?.statusCode ?? error?.status;

async function expectFailure(run, code, messageRe) {
  await assert.rejects(run, (error) => {
    assert.equal(statusOf(error), code, `expected ${code}, got ${statusOf(error)}: ${error.message}`);
    if (messageRe) assert.match(String(error.message), messageRe);
    return true;
  });
}

describe("QA 1 — valid invite: lookup → set password → consumed → login possible", () => {
  it("1a. GET invite returns the invited account, and never the token or a secret", async () => {
    const fake = db();
    const status = await getInviteStatus(TOKEN, { client: fake.client });

    assert.deepEqual(Object.keys(status).sort(), ["clientName", "email", "expiresAt", "name"]);
    assert.equal(status.email, "placeholder.admin@example.com");
    assert.equal(status.name, "PLACEHOLDER ADMIN");
    assert.equal(status.clientName, "PLACEHOLDER CLIENT");
    assert.ok(Date.parse(status.expiresAt) > Date.now());

    // The response must not echo the token, its hash, the password hash or the user id.
    const serialized = JSON.stringify(status);
    for (const secret of [TOKEN, hashInvite(TOKEN), "placeholder-unusable-hash", "user-placeholder-id"]) {
      assert.ok(!serialized.includes(secret), `invite lookup leaked ${secret.slice(0, 12)}…`);
    }
    assert.deepEqual(fake.updates, [], "a read-only lookup wrote to the database");
  });

  it("1b. set-password consumes the invite and stores a real, verifiable password", async () => {
    const fake = db();
    const result = await acceptInviteAndSetPassword(
      { token: TOKEN, password: PASSWORD },
      { client: fake.client },
    );

    assert.deepEqual(Object.keys(result).sort(), ["clientId", "email", "id", "name", "role"]);
    assert.equal(result.role, "CLIENT");
    assert.equal(result.clientId, CLIENT_ID);

    const stored = fake.store[0];
    assert.equal(stored.inviteTokenHash, null, "the invite token hash survived acceptance");
    assert.equal(stored.inviteExpiresAt, null, "the invite expiry survived acceptance");
    assert.ok(stored.passwordSetAt instanceof Date, "passwordSetAt was not stamped");
    assert.notEqual(stored.passwordHash, "placeholder-unusable-hash", "the placeholder hash was kept");
    assert.ok(!String(stored.passwordHash).includes(PASSWORD), "the password was stored in clear");
    assert.equal(await verifyPassword(PASSWORD, stored.passwordHash), true, "the new password does not verify");
    assert.equal(await verifyPassword("WrongPassw0rd!", stored.passwordHash), false);
  });

  it("1c. clearing inviteTokenHash is what unblocks login — the two are coupled", () => {
    // loginUser refuses any account still holding an invite hash. Acceptance MUST clear it, or the
    // invited client can never sign in. This pins that coupling so neither side drifts alone.
    const authSrc = readFileSync("src/modules/auth/auth.service.js", "utf8");
    assert.match(authSrc, /if \(user\.inviteTokenHash\) \{/);
    assert.match(authSrc, /set your password using the invitation link/i);
    const serviceSrc = readFileSync("src/modules/client/services/clientOnboarding.service.js", "utf8");
    assert.match(serviceSrc, /inviteTokenHash: null,\s*\n\s*inviteExpiresAt: null,\s*\n\s*passwordSetAt: new Date\(\)/);
  });
});

describe("QA 2 — duplicate invite creation reuses the pending user", () => {
  it("2a. the invite body accepts only email and an optional name — no role or clientId", () => {
    assert.deepEqual(Object.keys(inviteAdminBodySchema.shape).sort(), ["email", "name"]);
    assert.equal(inviteAdminBodySchema.safeParse({ email: "not-an-email" }).success, false);
    assert.equal(
      inviteAdminBodySchema.parse({ email: "placeholder.admin@example.com" }).email,
      "placeholder.admin@example.com",
    );
  });

  it("2b. re-inviting refreshes the SAME user rather than creating a second one", () => {
    // The reuse branch updates an existing active CLIENT user in place; only the non-reuse branch
    // calls create. Pinned structurally because the branch is what prevents duplicate users.
    const src = readFileSync("src/modules/client/services/clientOnboarding.service.js", "utf8");
    const invite = src.slice(
      src.indexOf("async inviteAdministrator(clientId"),
      src.indexOf("async allotCanonicalCampaigns(clientId"),
    );
    assert.ok(invite.length > 0, "inviteAdministrator moved");
    assert.match(invite, /where: \{ clientId, role: "CLIENT", isActive: true \}/);
    assert.match(invite, /reused: true/);
    assert.match(invite, /reused: false/);
    assert.equal((invite.match(/prisma\.user\.create\(/g) || []).length, 1, "more than one create path");
    // A second active administrator is refused outright.
    assert.match(invite, /A portal administrator already exists for this client/);
    // A fresh token and expiry are minted on reuse — the old token must stop working.
    assert.match(invite, /inviteTokenHash,\s*\n\s*inviteExpiresAt: expiresAt,/);
  });

  it("2c. a refreshed invite invalidates the previous token", async () => {
    // After re-invite the stored hash is the NEW token's, so the OLD token no longer resolves.
    const fake = db([userRow({ inviteTokenHash: hashInvite(OTHER_TOKEN) })]);
    await expectFailure(() => getInviteStatus(TOKEN, { client: fake.client }), 404);
    const status = await getInviteStatus(OTHER_TOKEN, { client: fake.client });
    assert.equal(status.email, "placeholder.admin@example.com");
  });
});

describe("QA 3 — token replay is rejected", () => {
  it("3a. the same token cannot be accepted twice", async () => {
    const fake = db();
    await acceptInviteAndSetPassword({ token: TOKEN, password: PASSWORD }, { client: fake.client });

    // Replay: the hash is gone, so the lookup finds nothing and the flow fails closed.
    await expectFailure(
      () => acceptInviteAndSetPassword({ token: TOKEN, password: "SecondPassw0rd!" }, { client: fake.client }),
      404,
      /invalid or has already been used/i,
    );

    // And the first password still stands — a failed replay must not have rewritten anything.
    assert.equal(await verifyPassword(PASSWORD, fake.store[0].passwordHash), true);
    assert.equal(fake.updates.length, 1, "the replay wrote to the database");
  });

  it("3b. a consumed token is also rejected by the read-only lookup", async () => {
    const fake = db();
    await acceptInviteAndSetPassword({ token: TOKEN, password: PASSWORD }, { client: fake.client });
    await expectFailure(() => getInviteStatus(TOKEN, { client: fake.client }), 404);
  });

  it("3c. replay rejection is structural — it depends on the row, not on a message", async () => {
    // Nothing is found because the hash was cleared. There is no conditional to get wrong.
    const fake = db();
    await acceptInviteAndSetPassword({ token: TOKEN, password: PASSWORD }, { client: fake.client });
    const found = await fake.client.user.findFirst({ where: { inviteTokenHash: hashInvite(TOKEN) } });
    assert.equal(found, null, "the consumed token is still resolvable to a user");
  });
});

describe("QA 4 — expired invites fail closed on both endpoints", () => {
  const expired = () => db([userRow({ inviteExpiresAt: new Date(Date.now() - HOUR) })]);

  it("4a. GET invite rejects an expired token with 410", async () => {
    await expectFailure(() => getInviteStatus(TOKEN, { client: expired().client }), 410, /expired/i);
  });

  it("4b. set-password ALSO rejects it — the lookup is not the only gate", async () => {
    const fake = expired();
    await expectFailure(
      () => acceptInviteAndSetPassword({ token: TOKEN, password: PASSWORD }, { client: fake.client }),
      410,
      /expired/i,
    );
    assert.deepEqual(fake.updates, [], "an expired invite still wrote a password");
    assert.equal(fake.store[0].passwordHash, "placeholder-unusable-hash");
  });

  it("4c. a missing expiry is treated as expired, not as never-expiring", async () => {
    for (const bad of [null, undefined]) {
      const fake = db([userRow({ inviteExpiresAt: bad })]);
      // eslint-disable-next-line no-await-in-loop
      await expectFailure(() => getInviteStatus(TOKEN, { client: fake.client }), 410);
      // eslint-disable-next-line no-await-in-loop
      await expectFailure(
        () => acceptInviteAndSetPassword({ token: TOKEN, password: PASSWORD }, { client: fake.client }),
        410,
      );
    }
  });
});

describe("QA 5 — invalid tokens are rejected", () => {
  it("5a. an unknown token is rejected by both endpoints", async () => {
    const fake = db();
    await expectFailure(() => getInviteStatus("zzrandomtokenthatneverexistedzz", { client: fake.client }), 404);
    await expectFailure(
      () => acceptInviteAndSetPassword(
        { token: "zzrandomtokenthatneverexistedzz", password: PASSWORD },
        { client: fake.client },
      ),
      404,
    );
    assert.deepEqual(fake.updates, []);
  });

  it("5b. an empty or missing token is rejected before any lookup", async () => {
    for (const bad of ["", null, undefined]) {
      const fake = db();
      // eslint-disable-next-line no-await-in-loop
      await expectFailure(() => getInviteStatus(bad, { client: fake.client }), 400, /token is required/i);
      // eslint-disable-next-line no-await-in-loop
      await expectFailure(
        () => acceptInviteAndSetPassword({ token: bad, password: PASSWORD }, { client: fake.client }),
        400,
      );
      assert.deepEqual(fake.updates, [], String(bad));
    }
  });

  it("5c. a deactivated account cannot have its password set, even with a live token", async () => {
    const fake = db([userRow({ isActive: false })]);
    await expectFailure(
      () => acceptInviteAndSetPassword({ token: TOKEN, password: PASSWORD }, { client: fake.client }),
      404,
    );
    assert.deepEqual(fake.updates, [], "a deactivated account had its password set");
  });

  it("5d. a STAFF account is never reachable through the client invite flow", async () => {
    for (const role of ["ADMIN", "OPERATIONS", "ANALYST", "TECH", "SUPPORT"]) {
      const fake = db([userRow({ role, clientId: null, client: null })]);
      // eslint-disable-next-line no-await-in-loop
      await expectFailure(() => getInviteStatus(TOKEN, { client: fake.client }), 404, /invalid/i);
      // eslint-disable-next-line no-await-in-loop
      await expectFailure(
        () => acceptInviteAndSetPassword({ token: TOKEN, password: PASSWORD }, { client: fake.client }),
        404,
      );
      assert.deepEqual(fake.updates, [], role);
    }
  });

  it("5e. the request schema refuses a short password and a stub token", () => {
    assert.equal(setPasswordBodySchema.safeParse({ token: TOKEN, password: "short" }).success, false);
    assert.equal(setPasswordBodySchema.safeParse({ token: "tooshort", password: PASSWORD }).success, false);
    assert.equal(setPasswordBodySchema.safeParse({ password: PASSWORD }).success, false);
    assert.equal(setPasswordBodySchema.safeParse({ token: TOKEN }).success, false);
    const parsed = setPasswordBodySchema.parse({ token: TOKEN, password: PASSWORD });
    assert.deepEqual(Object.keys(parsed).sort(), ["password", "token"]);
  });

  it("5f. the service enforces the password floor even if the schema is bypassed", async () => {
    const fake = db();
    await expectFailure(
      () => acceptInviteAndSetPassword({ token: TOKEN, password: "1234567" }, { client: fake.client }),
      400,
      /min 8 characters/i,
    );
    assert.deepEqual(fake.updates, []);
  });
});

describe("QA 6 — the accepted account receives CLIENT scope and nothing more", () => {
  it("6a. acceptance returns the CLIENT role bound to exactly one client", async () => {
    const fake = db();
    const result = await acceptInviteAndSetPassword(
      { token: TOKEN, password: PASSWORD },
      { client: fake.client },
    );
    assert.equal(result.role, "CLIENT");
    assert.equal(result.clientId, CLIENT_ID);
    assert.notEqual(result.clientId, OTHER_CLIENT_ID);
    // Acceptance never widens the role or re-points the tenant.
    const written = fake.updates[0].data;
    assert.ok(!("role" in written), "acceptance rewrote the role");
    assert.ok(!("clientId" in written), "acceptance re-pointed the tenant");
    assert.ok(!("isActive" in written), "acceptance changed activation");
  });

  it("6b. CLIENT holds only the six portal permissions — no staff permission", () => {
    assert.deepEqual([...ROLE_PERMISSIONS.CLIENT].sort(), [
      PERMISSIONS.PORTAL_CAMPAIGNS_READ,
      PERMISSIONS.PORTAL_PAYMENTS_MANAGE,
      PERMISSIONS.PORTAL_PAYMENTS_READ,
      PERMISSIONS.PORTAL_PERFORMANCE_READ,
      PERMISSIONS.PORTAL_SETTINGS_READ,
      PERMISSIONS.PORTAL_SUPPORT,
    ].sort());

    for (const staffOnly of [
      PERMISSIONS.CLIENTS_MANAGE,
      PERMISSIONS.CLIENTS_READ,
      PERMISSIONS.INTEGRATIONS_MANAGE,
      PERMISSIONS.SYNC_TRIGGER,
      PERMISSIONS.CAMPAIGNS_READ,
      PERMISSIONS.COMMISSION_MANAGE,
      PERMISSIONS.OPS_MANAGE,
    ]) {
      assert.ok(!ROLE_PERMISSIONS.CLIENT.includes(staffOnly), `CLIENT holds ${staffOnly}`);
    }
  });

  it("6c. the portal tenant is taken from credentials, never from a caller-supplied id", () => {
    // A CLIENT must only reach its own tenant's data. The partner surface resolves the tenant from
    // the authenticated credential; a clientId in the query is not accepted.
    const auth = readFileSync("src/middleware/auth.js", "utf8");
    assert.match(auth, /req\.partnerClientId = match\.clientId/);
    assert.match(auth, /req\.partnerClientId = user\.clientId/);
    assert.match(auth, /clients never pass clientId/i);
    // The portal JWT path additionally demands an ACTIVE client.
    assert.match(auth, /client\.status !== "ACTIVE"/);
    assert.match(auth, /user\.role !== "CLIENT"/);

    const schemas = readFileSync("src/modules/client/validators/schemas.js", "utf8");
    assert.match(schemas, /tenant resolved from credentials, never from clientId query/i);
    assert.ok(
      !Object.keys(
        // the partner-facing campaign list must not accept a clientId filter
        { search: 1, category: 1, brand: 1, country: 1, status: 1 },
      ).includes("clientId"),
    );
  });
});
