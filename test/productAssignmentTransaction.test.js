/**
 * Atomic + serialized product assignment writes.
 *
 * ClientProductService.assignProductToClient() runs its campaign-ownership guard, assignment
 * upsert and tracking-link work inside one interactive transaction whose first statement is a
 * Postgres advisory transaction lock keyed on (clientId, productId). A caller that already holds a
 * transaction supplies its client and gets no nested transaction but the same lock.
 *
 * The double below is a READ COMMITTED style transactional store: each transaction stages its
 * writes privately, reads see committed rows plus its own staged rows, commit applies the stage,
 * rollback discards it, and the advisory lock is a real per-key FIFO mutex held until commit or
 * rollback. Every delegate call yields to the event loop so concurrent callers interleave
 * deterministically, which makes the races observable when the lock is disabled and proves they
 * are gone when it is enabled.
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
import { afterEach, describe, it } from "node:test";

const { prisma } = await import("../src/database/prisma.js");
const {
  ClientProductService,
  CLIENT_PRODUCT_ASSIGNMENT_TX_OPTIONS,
  clientProductAssignmentLockKey,
} = await import("../src/modules/product/productFeed.service.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_SOURCE = fs.readFileSync(path.join(HERE, "../src/modules/product/productFeed.service.js"), "utf8");

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

const PRODUCT = {
  id: "prod-1",
  title: "Shoe",
  url: "https://brand.example/shoe",
  supplierProductTrackingUrl: "https://goto.impact.com/c?mid=1",
  feedStatus: "ACTIVE",
  status: "ACTIVE",
};
const PRODUCT_2 = { ...PRODUCT, id: "prod-2" };
const CAMPAIGNS = {
  "asg-a": { id: "asg-a", clientId: "client-a" },
  "asg-b": { id: "asg-b", clientId: "client-a" },
  "asg-other": { id: "asg-other", clientId: "client-b" },
};
const LOCK_KEY = clientProductAssignmentLockKey("client-a", "prod-1");

// ─── transactional READ COMMITTED double with a real advisory-lock mutex ────────────────────

function makeTxStore({ lockEnabled = true, failOn = null, withTransaction = true } = {}) {
  const committed = {
    assignments: new Map(),
    links: new Map(),
  };
  const events = [];
  const lockChains = new Map();
  let txSeq = 0;
  let rowSeq = 0;

  function acquireLock(tx, key) {
    const prev = lockChains.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((resolve) => {
      release = resolve;
    });
    lockChains.set(key, prev.then(() => mine));
    tx.releasers.push(release);
    return prev;
  }

  function releaseLocks(tx) {
    for (const release of tx.releasers.splice(0)) release();
  }

  // rows visible to a transaction: committed rows overlaid by its own staged rows
  const visible = (tx, table) => new Map([...committed[table], ...(tx ? tx.staged[table] : [])]);

  function makeDelegates(tx) {
    const record = async (op, extra = {}) => {
      events.push({ tx: tx?.id ?? null, op, ...extra });
      await yieldTurn();
      if (failOn === op) throw new Error(`injected failure: ${op}`);
    };
    const write = (table, row) => {
      if (tx) tx.staged[table].set(row.id, row);
      else committed[table].set(row.id, row);
    };
    return {
      product: {
        async findUnique({ where }) {
          await record("product.findUnique");
          return [PRODUCT, PRODUCT_2].find((p) => p.id === where.id) ?? null;
        },
      },
      clientCampaignAssignment: {
        async findUnique({ where }) {
          await record("clientCampaignAssignment.findUnique", { id: where.id });
          return CAMPAIGNS[where.id] ?? null;
        },
      },
      clientProductAssignment: {
        async findUnique({ where }) {
          await record("clientProductAssignment.findUnique");
          const k = where.clientId_productId;
          return [...visible(tx, "assignments").values()].find((a) => a.clientId === k.clientId && a.productId === k.productId) ?? null;
        },
        async create({ data }) {
          await record("clientProductAssignment.create", { status: data.status });
          rowSeq += 1;
          const row = { id: `cpa-${rowSeq}`, ...data };
          write("assignments", row);
          return row;
        },
        async update({ where, data }) {
          await record("clientProductAssignment.update", { status: data.status, campaign: data.clientCampaignAssignmentId });
          const row = { ...visible(tx, "assignments").get(where.id), ...data };
          write("assignments", row);
          return row;
        },
      },
      productTrackingLink: {
        async findFirst({ where }) {
          await record("productTrackingLink.findFirst");
          return [...visible(tx, "links").values()].find((l) => l.clientId === where.clientId && l.productId === where.productId && l.status === where.status) ?? null;
        },
        async create({ data }) {
          await record("productTrackingLink.create", { token: data.token });
          rowSeq += 1;
          const row = { id: `ptl-${rowSeq}`, ...data };
          write("links", row);
          return row;
        },
        async update({ where, data }) {
          await record("productTrackingLink.update", { id: where.id });
          const row = { ...visible(tx, "links").get(where.id), ...data };
          write("links", row);
          return row;
        },
        async updateMany({ where, data }) {
          await record("productTrackingLink.updateMany", { to: data.status });
          let count = 0;
          for (const l of visible(tx, "links").values()) {
            if (l.clientId === where.clientId && l.productId === where.productId && l.status === where.status) {
              write("links", { ...l, ...data });
              count += 1;
            }
          }
          return { count };
        },
      },
      async $executeRaw(strings, ...values) {
        const sql = strings.join("$");
        events.push({ tx: tx?.id ?? null, op: "advisory_lock", key: values[0], sql });
        if (lockEnabled && tx) await acquireLock(tx, values[0]);
        await yieldTurn();
        return 1;
      },
    };
  }

  function beginTx(label = null) {
    txSeq += 1;
    const tx = { id: txSeq, label, staged: { assignments: new Map(), links: new Map() }, releasers: [] };
    events.push({ tx: tx.id, op: "BEGIN" });
    return tx;
  }
  function commit(tx) {
    for (const table of ["assignments", "links"]) {
      for (const [id, row] of tx.staged[table]) committed[table].set(id, row);
    }
    events.push({ tx: tx.id, op: "COMMIT" });
    releaseLocks(tx);
  }
  function rollback(tx) {
    events.push({ tx: tx.id, op: "ROLLBACK" });
    releaseLocks(tx);
  }

  const root = makeDelegates(null);
  if (withTransaction) {
    root.$transaction = async (fn, options) => {
      const tx = beginTx();
      events[events.length - 1].options = options;
      const client = makeDelegates(tx);
      try {
        const out = await fn(client);
        commit(tx);
        return out;
      } catch (error) {
        rollback(tx);
        throw error;
      }
    };
  } else {
    delete root.$executeRaw; // thin legacy double: no transaction, no raw
  }

  return {
    db: root,
    events,
    committed,
    /** An externally owned transaction client, for the caller-supplied-client path. */
    external() {
      const tx = beginTx("external");
      const client = makeDelegates(tx);
      return { client, commit: () => commit(tx), rollback: () => rollback(tx), id: tx.id };
    },
    seed(table, row) {
      committed[table].set(row.id, row);
      return row;
    },
    activeLinks: () => [...committed.links.values()].filter((l) => l.status === "ACTIVE"),
    assignment: () => [...committed.assignments.values()].find((a) => a.clientId === "client-a" && a.productId === "prod-1") ?? null,
    ops: (txId) => events.filter((e) => txId == null || e.tx === txId).map((e) => e.op),
    count: (op) => events.filter((e) => e.op === op).length,
  };
}

const svc = (store) => new ClientProductService({ prisma: store.db, exceptions: { report: async () => ({}) } });
const call = (store, extra = {}) => svc(store).assignProductToClient({ clientId: "client-a", productId: "prod-1", ...extra });

const ORIGINAL_ENV = { BACKEND_URL: process.env.BACKEND_URL, TRACKING_BASE_URL: process.env.TRACKING_BASE_URL };
afterEach(() => {
  if (ORIGINAL_ENV.BACKEND_URL === undefined) delete process.env.BACKEND_URL;
  else process.env.BACKEND_URL = ORIGINAL_ENV.BACKEND_URL;
  if (ORIGINAL_ENV.TRACKING_BASE_URL === undefined) delete process.env.TRACKING_BASE_URL;
  else process.env.TRACKING_BASE_URL = ORIGINAL_ENV.TRACKING_BASE_URL;
});

// ─── 1. transaction structure and lock order ────────────────────────────────────────────────

describe("assignment transaction — structure, lock and order", () => {
  it("ACTIVE create: one transaction, advisory lock first, then guard, assignment, link, COMMIT", async () => {
    const store = makeTxStore();
    const result = await call(store, { clientCampaignAssignmentId: "asg-a" });
    assert.equal(result.ok, true);
    assert.deepEqual(store.ops(), [
      "product.findUnique",
      "BEGIN",
      "advisory_lock",
      "clientCampaignAssignment.findUnique",
      "clientProductAssignment.findUnique",
      "clientProductAssignment.create",
      "productTrackingLink.findFirst",
      "productTrackingLink.create",
      "COMMIT",
    ]);
    const begin = store.events.find((e) => e.op === "BEGIN");
    assert.deepEqual(begin.options, { maxWait: 15_000, timeout: 45_000 });
    assert.deepEqual(CLIENT_PRODUCT_ASSIGNMENT_TX_OPTIONS, { maxWait: 15_000, timeout: 45_000 });
    assert.equal(store.activeLinks().length, 1);
    assert.equal(store.assignment().status, "ACTIVE");
  });

  it("the lock statement is parameter-bound: constant SQL, key passed as a value", () => {
    const store = makeTxStore();
    return call(store).then(() => {
      const lock = store.events.find((e) => e.op === "advisory_lock");
      assert.equal(lock.sql, "SELECT pg_advisory_xact_lock(hashtext($))");
      assert.equal(lock.key, "client_product_assignment:client-a:prod-1");
      assert.equal(lock.key, LOCK_KEY);
      assert.doesNotMatch(lock.sql, /client-a|prod-1/);
    });
  });

  it("PAUSED/EXPIRED: lock, guard, assignment, updateMany, COMMIT — no link find/create, no config need", async () => {
    for (const status of ["PAUSED", "EXPIRED"]) {
      const store = makeTxStore();
      const result = await call(store, { clientCampaignAssignmentId: "asg-a", status });
      assert.equal(result.trackingLink, null);
      assert.deepEqual(store.ops(), [
        "product.findUnique",
        "BEGIN",
        "advisory_lock",
        "clientCampaignAssignment.findUnique",
        "clientProductAssignment.findUnique",
        "clientProductAssignment.create",
        "productTrackingLink.updateMany",
        "COMMIT",
      ]);
    }
  });

  it("no campaign id supplied: no guard lookup, lock still first", async () => {
    const store = makeTxStore();
    await call(store);
    assert.deepEqual(store.ops().slice(0, 4), ["product.findUnique", "BEGIN", "advisory_lock", "clientProductAssignment.findUnique"]);
    assert.equal(store.count("clientCampaignAssignment.findUnique"), 0);
  });

  it("guard failures inside the transaction commit nothing: no assignment or link statements after the guard", async () => {
    const store = makeTxStore();
    const mismatch = await call(store, { clientCampaignAssignmentId: "asg-other" });
    assert.deepEqual(mismatch, { ok: false, reason: "campaign_assignment_client_mismatch" });
    const missing = await call(store, { clientCampaignAssignmentId: "asg-missing" });
    assert.deepEqual(missing, { ok: false, reason: "campaign_assignment_not_found" });
    assert.deepEqual(store.ops(1), ["BEGIN", "advisory_lock", "clientCampaignAssignment.findUnique", "COMMIT"]);
    assert.deepEqual(store.ops(2), ["BEGIN", "advisory_lock", "clientCampaignAssignment.findUnique", "COMMIT"]);
    assert.equal(store.assignment(), null);
    assert.equal(store.committed.links.size, 0);
  });

  it("pre-write checks stay outside: product_not_found and product_not_publishable open no transaction", async () => {
    const store = makeTxStore();
    const missing = await svc(store).assignProductToClient({ clientId: "client-a", productId: "nope" });
    assert.equal(missing.reason, "product_not_found");
    assert.equal(store.count("BEGIN"), 0);
    assert.equal(store.count("advisory_lock"), 0);
  });
});

// ─── 2. caller-supplied client ──────────────────────────────────────────────────────────────

describe("assignment transaction — caller-supplied transaction client", () => {
  it("no nested $transaction, exactly one advisory lock through the supplied client, all statements on it", async () => {
    const store = makeTxStore();
    let nested = 0;
    const originalTx = store.db.$transaction;
    store.db.$transaction = async (...args) => {
      nested += 1;
      return originalTx(...args);
    };
    const ext = store.external();
    const result = await svc(store).assignProductToClient(
      { clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-a" },
      ext.client,
    );
    assert.equal(result.ok, true);
    assert.equal(nested, 0);
    assert.equal(store.count("advisory_lock"), 1);
    assert.equal(store.events.find((e) => e.op === "advisory_lock").tx, ext.id);
    // the pre-write product lookup also runs on the supplied client (db = client ?? this.db)
    assert.deepEqual(store.ops(ext.id), [
      "BEGIN",
      "product.findUnique",
      "advisory_lock",
      "clientCampaignAssignment.findUnique",
      "clientProductAssignment.findUnique",
      "clientProductAssignment.create",
      "productTrackingLink.findFirst",
      "productTrackingLink.create",
    ]);
    assert.equal(store.assignment(), null, "nothing committed until the caller commits");
    ext.commit();
    assert.equal(store.assignment().status, "ACTIVE");
    assert.equal(store.activeLinks().length, 1);
  });

  it("caller rollback discards the assignment and link together", async () => {
    const store = makeTxStore();
    const ext = store.external();
    await svc(store).assignProductToClient({ clientId: "client-a", productId: "prod-1" }, ext.client);
    ext.rollback();
    assert.equal(store.assignment(), null);
    assert.equal(store.committed.links.size, 0);
  });
});

// ─── 3. partial-failure rollback ────────────────────────────────────────────────────────────

describe("assignment transaction — partial failure rolls back", () => {
  it("A. ACTIVE create succeeds, link create throws -> ROLLBACK, no assignment, no link", async () => {
    const store = makeTxStore({ failOn: "productTrackingLink.create" });
    await assert.rejects(() => call(store, { clientCampaignAssignmentId: "asg-a" }), /injected failure: productTrackingLink\.create/);
    assert.deepEqual(store.ops(1).slice(-2), ["productTrackingLink.create", "ROLLBACK"]);
    assert.equal(store.assignment(), null);
    assert.equal(store.committed.links.size, 0);
    assert.equal(store.count("COMMIT"), 0);
  });

  it("B. ACTIVE -> PAUSED update succeeds, link updateMany throws -> ROLLBACK, assignment stays ACTIVE, link stays ACTIVE", async () => {
    const store = makeTxStore();
    const active = await call(store, { clientCampaignAssignmentId: "asg-a" });
    const failing = makeTxStore({ failOn: "productTrackingLink.updateMany" });
    failing.seed("assignments", { ...active.assignment });
    failing.seed("links", { ...active.trackingLink });
    await assert.rejects(() => call(failing, { status: "PAUSED" }), /injected failure: productTrackingLink\.updateMany/);
    assert.deepEqual(failing.ops(1), ["BEGIN", "advisory_lock", "clientProductAssignment.findUnique", "clientProductAssignment.update", "productTrackingLink.updateMany", "ROLLBACK"]);
    assert.equal(failing.assignment().status, "ACTIVE");
    assert.equal(failing.activeLinks().length, 1);
    assert.equal(failing.activeLinks()[0].token, active.trackingLink.token);
  });

  it("C. asg-a -> asg-b update succeeds, link repair throws -> ROLLBACK, assignment stays asg-a, link stays asg-a", async () => {
    const store = makeTxStore();
    const active = await call(store, { clientCampaignAssignmentId: "asg-a" });
    const failing = makeTxStore({ failOn: "productTrackingLink.update" });
    failing.seed("assignments", { ...active.assignment });
    failing.seed("links", { ...active.trackingLink });
    await assert.rejects(() => call(failing, { clientCampaignAssignmentId: "asg-b" }), /injected failure: productTrackingLink\.update/);
    assert.deepEqual(failing.ops(1).slice(-2), ["productTrackingLink.update", "ROLLBACK"]);
    assert.equal(failing.assignment().clientCampaignAssignmentId, "asg-a");
    assert.equal(failing.activeLinks()[0].clientCampaignAssignmentId, "asg-a");
    assert.equal(failing.activeLinks()[0].token, active.trackingLink.token);
  });

  it("D. assignment create throws -> ROLLBACK, no link statements at all", async () => {
    const store = makeTxStore({ failOn: "clientProductAssignment.create" });
    await assert.rejects(() => call(store), /injected failure: clientProductAssignment\.create/);
    assert.equal(store.count("productTrackingLink.findFirst"), 0);
    assert.equal(store.count("productTrackingLink.create"), 0);
    assert.equal(store.count("ROLLBACK"), 1);
  });
});

// ─── 4. concurrency ─────────────────────────────────────────────────────────────────────────

describe("assignment transaction — concurrency", () => {
  it("harness self-check: with the lock disabled two concurrent ACTIVE calls produce two ACTIVE links", async () => {
    const store = makeTxStore({ lockEnabled: false });
    await Promise.all([call(store, { clientCampaignAssignmentId: "asg-a" }), call(store, { clientCampaignAssignmentId: "asg-a" })]);
    assert.equal(store.activeLinks().length, 2, "the race must be observable when serialization is off");
    assert.equal(store.count("productTrackingLink.create"), 2);
  });

  it("1. two concurrent ACTIVE calls -> one assignment, exactly one ACTIVE link, both succeed", async () => {
    const store = makeTxStore();
    const [a, b] = await Promise.all([call(store, { clientCampaignAssignmentId: "asg-a" }), call(store, { clientCampaignAssignmentId: "asg-a" })]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(store.committed.assignments.size, 1);
    assert.equal(store.activeLinks().length, 1);
    assert.equal(store.count("productTrackingLink.create"), 1);
    assert.equal(store.count("clientProductAssignment.create"), 1);
    assert.equal(store.count("clientProductAssignment.update"), 1);
    assert.equal(a.trackingLink.id, b.trackingLink.id);
    // serialization proof: the second transaction's first statement after the lock happens after the first COMMIT
    const ops = store.events;
    const firstCommit = ops.findIndex((e) => e.op === "COMMIT");
    const secondTxWork = ops.findIndex((e) => e.tx === 2 && e.op === "clientProductAssignment.findUnique");
    assert.ok(secondTxWork > firstCommit, "second call must not read before the first commits");
  });

  it("2. concurrent ACTIVE and PAUSED -> serialized, final assignment status matches final link state", async () => {
    for (const order of [["ACTIVE", "PAUSED"], ["PAUSED", "ACTIVE"]]) {
      const store = makeTxStore();
      const results = await Promise.all(order.map((status) => call(store, { clientCampaignAssignmentId: "asg-a", status })));
      assert.ok(results.every((r) => r.ok));
      const final = store.assignment();
      if (final.status === "ACTIVE") {
        assert.equal(store.activeLinks().length, 1, order.join("->"));
      } else {
        assert.equal(final.status, "PAUSED");
        assert.equal(store.activeLinks().length, 0, order.join("->"));
      }
      const commits = store.events.filter((e) => e.op === "COMMIT").map((e) => e.tx);
      assert.equal(commits.length, 2);
      const lastTx = commits[1];
      const lastStatus = store.events.find((e) => e.tx === lastTx && /clientProductAssignment\.(create|update)/.test(e.op)).status;
      assert.equal(final.status, lastStatus, "last committed transaction decides the state");
    }
  });

  it("3. concurrent ACTIVE asg-a and ACTIVE asg-b -> one ACTIVE link whose campaign equals the assignment's", async () => {
    for (const order of [["asg-a", "asg-b"], ["asg-b", "asg-a"]]) {
      const store = makeTxStore();
      await Promise.all(order.map((campaign) => call(store, { clientCampaignAssignmentId: campaign })));
      const links = store.activeLinks();
      assert.equal(links.length, 1, order.join("/"));
      assert.equal(links[0].clientCampaignAssignmentId, store.assignment().clientCampaignAssignmentId, order.join("/"));
      assert.equal(store.count("productTrackingLink.create"), 1);
      assert.equal(store.count("productTrackingLink.update"), 1, "the second call repairs the first call's link in place");
    }
  });

  it("4. different client/product keys are not serialized against each other", async () => {
    const store = makeTxStore();
    const s = svc(store);
    await Promise.all([
      s.assignProductToClient({ clientId: "client-a", productId: "prod-1" }),
      s.assignProductToClient({ clientId: "client-a", productId: "prod-2" }),
    ]);
    const keys = store.events.filter((e) => e.op === "advisory_lock").map((e) => e.key);
    assert.deepEqual(keys.sort(), ["client_product_assignment:client-a:prod-1", "client_product_assignment:client-a:prod-2"]);
    const firstCommit = store.events.findIndex((e) => e.op === "COMMIT");
    const secondTxWork = store.events.findIndex((e) => e.tx === 2 && e.op === "clientProductAssignment.findUnique");
    assert.ok(secondTxWork < firstCommit, "the second key's work must interleave before the first commit");
    assert.equal(store.committed.assignments.size, 2);
    assert.equal(store.committed.links.size, 2);
  });

  it("same key, three concurrent mixed calls -> invariant holds after all commit", async () => {
    const store = makeTxStore();
    await Promise.all([
      call(store, { clientCampaignAssignmentId: "asg-a" }),
      call(store, { status: "EXPIRED" }),
      call(store, { clientCampaignAssignmentId: "asg-b" }),
    ]);
    const final = store.assignment();
    const links = store.activeLinks();
    if (final.status === "ACTIVE") {
      assert.equal(links.length, 1);
      assert.equal(links[0].clientCampaignAssignmentId, final.clientCampaignAssignmentId);
    } else {
      assert.equal(links.length, 0);
    }
    assert.equal(store.count("COMMIT"), 3);
  });
});

// ─── 5. config nuance and fallbacks ─────────────────────────────────────────────────────────

describe("assignment transaction — config and double compatibility", () => {
  const unsetTrackingConfig = () => {
    delete process.env.BACKEND_URL;
    delete process.env.TRACKING_BASE_URL;
  };

  it("1. ACTIVE + no existing link + no tracking-base config -> throws inside the transaction, rolls back, nothing survives", async () => {
    unsetTrackingConfig();
    const store = makeTxStore();
    await assert.rejects(() => call(store, { clientCampaignAssignmentId: "asg-a" }), /TRACKING_BASE_URL \(or BACKEND_URL\) must be configured/);
    assert.deepEqual(store.ops(1), [
      "BEGIN",
      "advisory_lock",
      "clientCampaignAssignment.findUnique",
      "clientProductAssignment.findUnique",
      "clientProductAssignment.create",
      "productTrackingLink.findFirst",
      "ROLLBACK",
    ]);
    assert.equal(store.count("COMMIT"), 0);
    assert.equal(store.count("productTrackingLink.create"), 0);
    assert.equal(store.assignment(), null, "the staged assignment must not survive the rollback");
    assert.equal(store.committed.links.size, 0);
  });

  it("2. ACTIVE + existing matching ACTIVE link + no config -> succeeds and reuses the link", async () => {
    const seeded = makeTxStore();
    const first = await call(seeded, { clientCampaignAssignmentId: "asg-a" });
    unsetTrackingConfig();
    const store = makeTxStore();
    store.seed("assignments", { ...first.assignment });
    store.seed("links", { ...first.trackingLink });
    const result = await call(store, { clientCampaignAssignmentId: "asg-a" });
    assert.equal(result.ok, true);
    assert.equal(result.trackingLink.id, first.trackingLink.id);
    assert.equal(result.trackingLink.token, first.trackingLink.token);
    assert.equal(store.count("COMMIT"), 1);
    assert.equal(store.count("productTrackingLink.create"), 0);
    assert.equal(store.count("productTrackingLink.update"), 0);
    assert.equal(store.activeLinks().length, 1);
  });

  it("3. ACTIVE + stale existing ACTIVE link + no config -> succeeds, repairs in place, same token", async () => {
    const seeded = makeTxStore();
    const first = await call(seeded, { clientCampaignAssignmentId: "asg-a" });
    unsetTrackingConfig();
    const store = makeTxStore();
    store.seed("assignments", { ...first.assignment });
    store.seed("links", { ...first.trackingLink });
    const result = await call(store, { clientCampaignAssignmentId: "asg-b" });
    assert.equal(result.ok, true);
    assert.equal(result.assignment.clientCampaignAssignmentId, "asg-b");
    assert.equal(result.trackingLink.id, first.trackingLink.id);
    assert.equal(result.trackingLink.token, first.trackingLink.token);
    assert.equal(result.trackingLink.mboProductTrackingUrl, first.trackingLink.mboProductTrackingUrl);
    assert.equal(result.trackingLink.clientCampaignAssignmentId, "asg-b");
    assert.equal(store.count("productTrackingLink.update"), 1);
    assert.equal(store.count("productTrackingLink.create"), 0);
    assert.equal(store.count("COMMIT"), 1);
  });

  it("4/5. PAUSED and EXPIRED with no tracking base configured still succeed (no URL is minted)", async () => {
    unsetTrackingConfig();
    for (const status of ["PAUSED", "EXPIRED"]) {
      const store = makeTxStore();
      const result = await call(store, { status });
      assert.equal(result.ok, true);
      assert.equal(result.trackingLink, null);
      assert.equal(store.count("COMMIT"), 1);
    }
  });

  it("thin legacy double without $transaction/$executeRaw still works (fallback path), with identical state semantics", async () => {
    const store = makeTxStore({ withTransaction: false });
    const active = await call(store, { clientCampaignAssignmentId: "asg-a" });
    assert.equal(active.ok, true);
    assert.equal(store.count("BEGIN"), 0);
    assert.equal(store.count("advisory_lock"), 0);
    const paused = await call(store, { status: "PAUSED" });
    assert.equal(paused.trackingLink, null);
    assert.equal(store.activeLinks().length, 0);
  });

  it("the real Prisma client exposes $transaction and $executeRaw, so production takes the locked transaction path", () => {
    assert.equal(typeof prisma.$transaction, "function");
    assert.equal(typeof prisma.$executeRaw, "function");
  });
});

// ─── 6. static proofs ───────────────────────────────────────────────────────────────────────

describe("assignment transaction — static proofs", () => {
  const body = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf("async assignProductToClient("), SERVICE_SOURCE.indexOf("async unassignProduct("));
  const run = body.slice(body.indexOf("const run = async (tx) => {"), body.indexOf("if (client) return run(client);"));

  it("transaction starts only when no client is supplied; caller client runs run() directly; single $transaction call site", () => {
    assert.match(body, /if \(client\) return run\(client\);\s*if \(typeof this\.db\.\$transaction === "function"\) \{\s*return this\.db\.\$transaction\(run, CLIENT_PRODUCT_ASSIGNMENT_TX_OPTIONS\);/);
    assert.equal((body.match(/\$transaction\(/g) || []).length, 1);
  });

  it("the advisory lock is the first statement inside run(tx), before the guard and every assignment/link operation", () => {
    const lock = run.indexOf("await acquireClientProductAssignmentLock(tx, clientId, productId);");
    assert.ok(lock > 0);
    const firstDbCall = run.search(/tx\.(clientCampaignAssignment|clientProductAssignment|productTrackingLink)\./);
    assert.ok(lock < firstDbCall);
    const helper = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf("async function acquireClientProductAssignmentLock"), SERVICE_SOURCE.indexOf("export class ClientProductService"));
    assert.match(helper, /tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(\$\{key\}\)\)`/);
    assert.match(helper, /typeof tx\?\.\$executeRaw !== "function"/);
    assert.match(SERVICE_SOURCE, /export function clientProductAssignmentLockKey\(clientId, productId\) \{\s*return `\$\{CLIENT_PRODUCT_ASSIGNMENT_LOCK_PREFIX\}:\$\{clientId\}:\$\{productId\}`;/);
  });

  it("every assignment/link/guard statement inside run uses tx; none uses db or this.db or prisma", () => {
    assert.doesNotMatch(run, /\bdb\.|this\.db\.|\bprisma\./);
    for (const op of ["clientCampaignAssignment.findUnique", "clientProductAssignment.findUnique", "clientProductAssignment.update", "clientProductAssignment.create", "productTrackingLink.updateMany", "productTrackingLink.findFirst", "productTrackingLink.create", "productTrackingLink.update"]) {
      assert.match(run, new RegExp(`tx\\.${op.replace(".", "\\.")}\\(`), op);
    }
    assert.doesNotMatch(run, /exceptions\.report/);
  });

  it("no P2002 catch-and-continue inside the transaction", () => {
    assert.doesNotMatch(run, /P2002|isPrismaUniqueViolation|catch \(/);
    assert.doesNotMatch(body, /P2002|isPrismaUniqueViolation/);
  });

  it("pre-write checks stay outside the transaction; getTrackingBaseUrl appears only inside the ACTIVE link-create branch", () => {
    const pre = body.slice(0, body.indexOf("const run = async (tx) => {"));
    assert.match(pre, /db\.product\.findUnique/);
    assert.match(pre, /reason: "product_not_found"/);
    assert.match(pre, /reason: "missing_product_url"/);
    assert.match(pre, /reason: "product_not_publishable"/);
    assert.doesNotMatch(pre, /getTrackingBaseUrl/);
    assert.equal((body.match(/getTrackingBaseUrl\(\)/g) || []).length, 1);
    const createBranch = run.slice(run.indexOf("if (!link) {"), run.indexOf("} else if ("));
    assert.match(createBranch, /const trackingBaseUrl = getTrackingBaseUrl\(\);\s*const token = generateProductTrackingToken\(\);\s*const mboProductTrackingUrl = `\$\{trackingBaseUrl\}\/t\/product\/\$\{token\}`;/);
    const inactive = run.slice(run.indexOf('if (assignment.status !== "ACTIVE")'), run.indexOf("let link = await tx.productTrackingLink.findFirst("));
    assert.doesNotMatch(inactive, /getTrackingBaseUrl/);
    const repairBranch = run.slice(run.indexOf("} else if ("));
    assert.doesNotMatch(repairBranch, /getTrackingBaseUrl/);
    const beforeLink = run.slice(0, run.indexOf("if (!link) {"));
    assert.doesNotMatch(beforeLink, /getTrackingBaseUrl/);
  });

  it("state semantics and return contract are unchanged from the previous patch", () => {
    assert.match(run, /const effectiveCampaignAssignmentId = assignment\.clientCampaignAssignmentId \?\? null;/);
    assert.match(run, /if \(assignment\.status !== "ACTIVE"\) \{[\s\S]*?productTrackingLink\.updateMany\(\{\s*where: \{ clientId, productId, status: "ACTIVE" \},\s*data: \{ status: "REVOKED" \},[\s\S]*?return \{ ok: true, assignment, trackingLink: null \};/);
    assert.match(run, /return \{ ok: true, assignment, trackingLink: link \};/);
    assert.equal((run.match(/generateProductTrackingToken\(\)/g) || []).length, 1);
    assert.match(run, /reason: "campaign_assignment_not_found"/);
    assert.match(run, /reason: "campaign_assignment_client_mismatch"/);
  });
});
