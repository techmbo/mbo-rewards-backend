/**
 * ClientProductAssignment ↔ ProductTrackingLink state consistency.
 *
 * Invariant: an assignment and its ACTIVE tracking link agree on clientId, productId,
 * clientCampaignAssignmentId and publication state. ACTIVE may hold exactly one ACTIVE link;
 * PAUSED and EXPIRED hold none. A same-client campaign reassignment repairs the existing ACTIVE
 * link in place (same id, token and MBO URL) instead of leaving a stale campaign id that the
 * redirect would attribute clicks to.
 *
 * The service runs against an in-memory Prisma double that records every delegate call in order,
 * so each case proves both the final state and which mutations happened (and did not happen).
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
import { describe, it } from "node:test";

const { ClientProductService } = await import("../src/modules/product/productFeed.service.js");
const { ProductTrackingRedirectService } = await import(
  "../src/modules/product/productTrackingRedirect.service.js"
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_SOURCE = fs.readFileSync(path.join(HERE, "../src/modules/product/productFeed.service.js"), "utf8");

const PRODUCT = {
  id: "prod-1",
  title: "Shoe",
  url: "https://brand.example/shoe",
  supplierProductTrackingUrl: "https://goto.impact.com/c?mid=1",
  feedStatus: "ACTIVE",
  status: "ACTIVE",
};
const ASG_A = { id: "asg-a", clientId: "client-a", published: true, status: "ACTIVE" };
const ASG_B = { id: "asg-b", clientId: "client-a", published: true, status: "ACTIVE" };
const ASG_OTHER = { id: "asg-other", clientId: "client-b", published: true, status: "ACTIVE" };

// ─── recording Prisma double ────────────────────────────────────────────────────────────────

function makeDb({ products = { "prod-1": PRODUCT }, campaigns = { "asg-a": ASG_A, "asg-b": ASG_B, "asg-other": ASG_OTHER } } = {}) {
  const ops = [];
  const assignments = new Map();
  const links = new Map();
  let linkSeq = 0;
  let assignmentSeq = 0;
  const record = (op, extra) => ops.push({ op, ...extra });

  const db = {
    ops,
    assignments,
    links,
    product: {
      async findUnique({ where }) {
        record("product.findUnique", { id: where.id });
        return products[where.id] ?? null;
      },
    },
    clientCampaignAssignment: {
      async findUnique({ where }) {
        record("clientCampaignAssignment.findUnique", { id: where.id });
        return campaigns[where.id] ?? null;
      },
    },
    clientProductAssignment: {
      async findUnique({ where }) {
        const k = where.clientId_productId;
        record("clientProductAssignment.findUnique", { clientId: k.clientId, productId: k.productId });
        return [...assignments.values()].find((a) => a.clientId === k.clientId && a.productId === k.productId) ?? null;
      },
      async create({ data }) {
        assignmentSeq += 1;
        const row = { id: `cpa-${assignmentSeq}`, ...data };
        assignments.set(row.id, row);
        record("clientProductAssignment.create", { id: row.id, status: data.status, campaign: data.clientCampaignAssignmentId });
        return row;
      },
      async update({ where, data }) {
        const row = { ...assignments.get(where.id), ...data };
        assignments.set(where.id, row);
        record("clientProductAssignment.update", { id: where.id, status: data.status, campaign: data.clientCampaignAssignmentId });
        return row;
      },
    },
    productTrackingLink: {
      async findFirst({ where }) {
        record("productTrackingLink.findFirst", { status: where.status });
        return [...links.values()].find((l) => l.clientId === where.clientId && l.productId === where.productId && l.status === where.status) ?? null;
      },
      async create({ data }) {
        linkSeq += 1;
        const row = { id: `ptl-${linkSeq}`, ...data };
        links.set(row.id, row);
        record("productTrackingLink.create", { id: row.id, token: data.token, campaign: data.clientCampaignAssignmentId });
        return row;
      },
      async update({ where, data }) {
        const row = { ...links.get(where.id), ...data };
        links.set(where.id, row);
        record("productTrackingLink.update", { id: where.id, data: { ...data } });
        return row;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const [id, l] of links) {
          if (l.clientId === where.clientId && l.productId === where.productId && l.status === where.status) {
            links.set(id, { ...l, ...data });
            count += 1;
          }
        }
        record("productTrackingLink.updateMany", { from: where.status, to: data.status, count });
        return { count };
      },
      async findUnique({ where }) {
        const link = [...links.values()].find((l) => l.token === where.token) ?? null;
        if (!link) return null;
        return { ...link, product: { ...products[link.productId], sources: [{ supplier: "IMPACT" }], campaignSource: null } };
      },
    },
    trackingLink: {
      async findFirst({ where }) {
        record("trackingLink.findFirst", { assignmentId: where.assignmentId });
        return { id: `tl-${where.assignmentId}`, assignmentId: where.assignmentId };
      },
    },
  };
  return db;
}

const svc = (db) => new ClientProductService({ prisma: db, exceptions: { report: async () => ({}) } });
const activeLinks = (db) => [...db.links.values()].filter((l) => l.status === "ACTIVE");
const opsOf = (db, name) => db.ops.filter((o) => o.op === name);
const seedLink = (db, overrides = {}) => {
  const id = overrides.id ?? `seed-${db.links.size + 1}`;
  const row = {
    id,
    clientId: "client-a",
    productId: "prod-1",
    clientProductAssignmentId: null,
    clientCampaignAssignmentId: null,
    token: `TOKEN-${id}`,
    supplierProductTrackingUrl: PRODUCT.supplierProductTrackingUrl,
    mboProductTrackingUrl: `https://backend.test/t/product/TOKEN-${id}`,
    status: "ACTIVE",
    ...overrides,
  };
  db.links.set(id, row);
  return row;
};
const seedAssignment = (db, overrides = {}) => {
  const row = { id: "cpa-seed", clientId: "client-a", productId: "prod-1", clientCampaignAssignmentId: "asg-a", status: "ACTIVE", publishedAt: new Date("2026-01-01"), ...overrides };
  db.assignments.set(row.id, row);
  return row;
};
const call = (db, extra = {}) => svc(db).assignProductToClient({ clientId: "client-a", productId: "prod-1", ...extra });

// ─── 1. ACTIVE / PAUSED / EXPIRED state machine ─────────────────────────────────────────────

describe("tracking-link state consistency — status paths", () => {
  it("1. create ACTIVE assignment with no link -> exactly one ACTIVE link created", async () => {
    const db = makeDb();
    const result = await call(db, { clientCampaignAssignmentId: "asg-a" });
    assert.equal(result.ok, true);
    assert.equal(result.assignment.status, "ACTIVE");
    assert.ok(result.assignment.publishedAt instanceof Date);
    assert.equal(activeLinks(db).length, 1);
    assert.equal(result.trackingLink.status, "ACTIVE");
    assert.equal(result.trackingLink.clientProductAssignmentId, result.assignment.id);
    assert.equal(result.trackingLink.clientCampaignAssignmentId, "asg-a");
    assert.ok(result.trackingLink.mboProductTrackingUrl.includes("/t/product/"));
    assert.equal(opsOf(db, "productTrackingLink.create").length, 1);
    assert.equal(opsOf(db, "productTrackingLink.update").length, 0);
    assert.equal(opsOf(db, "productTrackingLink.updateMany").length, 0);
  });

  it("2. repeated ACTIVE call -> reuses the existing ACTIVE link, no duplicate, no update", async () => {
    const db = makeDb();
    const first = await call(db, { clientCampaignAssignmentId: "asg-a" });
    db.ops.length = 0;
    const second = await call(db, { clientCampaignAssignmentId: "asg-a" });
    assert.equal(second.trackingLink.id, first.trackingLink.id);
    assert.equal(second.trackingLink.token, first.trackingLink.token);
    assert.equal(activeLinks(db).length, 1);
    assert.equal(db.links.size, 1);
    assert.equal(opsOf(db, "productTrackingLink.create").length, 0);
    assert.equal(opsOf(db, "productTrackingLink.update").length, 0);
    assert.equal(opsOf(db, "productTrackingLink.updateMany").length, 0);
  });

  for (const status of ["PAUSED", "EXPIRED"]) {
    it(`${status === "PAUSED" ? 3 : 4}. create ${status} assignment -> no ACTIVE link created, trackingLink null`, async () => {
      const db = makeDb();
      const result = await call(db, { clientCampaignAssignmentId: "asg-a", status });
      assert.equal(result.ok, true);
      assert.equal(result.assignment.status, status);
      assert.equal(result.assignment.publishedAt, null);
      assert.equal(result.trackingLink, null);
      assert.ok(Object.hasOwn(result, "trackingLink"));
      assert.equal(db.links.size, 0);
      assert.equal(opsOf(db, "productTrackingLink.create").length, 0);
      assert.equal(opsOf(db, "productTrackingLink.findFirst").length, 0);
      assert.deepEqual(opsOf(db, "productTrackingLink.updateMany"), [{ op: "productTrackingLink.updateMany", from: "ACTIVE", to: "REVOKED", count: 0 }]);
    });
  }

  for (const status of ["PAUSED", "EXPIRED"]) {
    it(`${status === "PAUSED" ? 5 : 6}. ACTIVE -> ${status}: assignment ${status}, ACTIVE link REVOKED, no new link, trackingLink null, publishedAt kept`, async () => {
      const db = makeDb();
      const active = await call(db, { clientCampaignAssignmentId: "asg-a" });
      const publishedAt = active.assignment.publishedAt;
      db.ops.length = 0;
      const result = await call(db, { status });
      assert.equal(result.assignment.status, status);
      assert.equal(result.assignment.publishedAt, publishedAt);
      assert.equal(result.trackingLink, null);
      assert.equal(db.links.get(active.trackingLink.id).status, "REVOKED");
      assert.equal(activeLinks(db).length, 0);
      assert.equal(db.links.size, 1);
      assert.equal(opsOf(db, "productTrackingLink.create").length, 0);
      assert.equal(opsOf(db, "productTrackingLink.findFirst").length, 0);
      assert.deepEqual(opsOf(db, "productTrackingLink.updateMany"), [{ op: "productTrackingLink.updateMany", from: "ACTIVE", to: "REVOKED", count: 1 }]);
    });
  }

  for (const status of ["PAUSED", "EXPIRED"]) {
    it(`${status === "PAUSED" ? 7 : 8}. ${status} -> ACTIVE: assignment ACTIVE, fresh ACTIVE link with a NEW token, revoked link untouched`, async () => {
      const db = makeDb();
      const first = await call(db, { clientCampaignAssignmentId: "asg-a" });
      await call(db, { status });
      assert.equal(activeLinks(db).length, 0);
      db.ops.length = 0;
      const reactivated = await call(db, { status: "ACTIVE" });
      assert.equal(reactivated.assignment.status, "ACTIVE");
      assert.ok(reactivated.assignment.publishedAt > first.assignment.publishedAt || reactivated.assignment.publishedAt >= first.assignment.publishedAt);
      assert.equal(reactivated.trackingLink.status, "ACTIVE");
      assert.notEqual(reactivated.trackingLink.id, first.trackingLink.id);
      assert.notEqual(reactivated.trackingLink.token, first.trackingLink.token);
      assert.notEqual(reactivated.trackingLink.mboProductTrackingUrl, first.trackingLink.mboProductTrackingUrl);
      assert.equal(reactivated.trackingLink.clientCampaignAssignmentId, "asg-a");
      assert.equal(reactivated.trackingLink.clientProductAssignmentId, reactivated.assignment.id);
      assert.equal(db.links.get(first.trackingLink.id).status, "REVOKED");
      assert.equal(activeLinks(db).length, 1);
      assert.equal(db.links.size, 2);
      assert.equal(opsOf(db, "productTrackingLink.create").length, 1);
      assert.equal(opsOf(db, "productTrackingLink.update").length, 0);
    });
  }

  for (const status of ["PAUSED", "EXPIRED"]) {
    it(`${status === "PAUSED" ? 9 : 10}. multiple pre-existing ACTIVE links -> ${status} revokes ALL via one updateMany`, async () => {
      const db = makeDb();
      seedAssignment(db);
      seedLink(db, { id: "dup-1", clientProductAssignmentId: "cpa-seed", clientCampaignAssignmentId: "asg-a" });
      seedLink(db, { id: "dup-2", clientProductAssignmentId: "cpa-seed", clientCampaignAssignmentId: "asg-a" });
      seedLink(db, { id: "dup-3", clientProductAssignmentId: "cpa-seed", clientCampaignAssignmentId: "asg-a" });
      seedLink(db, { id: "other-product", productId: "prod-2" });
      const result = await call(db, { status });
      assert.equal(result.trackingLink, null);
      for (const id of ["dup-1", "dup-2", "dup-3"]) assert.equal(db.links.get(id).status, "REVOKED", id);
      assert.equal(db.links.get("other-product").status, "ACTIVE", "other product untouched");
      assert.deepEqual(opsOf(db, "productTrackingLink.updateMany"), [{ op: "productTrackingLink.updateMany", from: "ACTIVE", to: "REVOKED", count: 3 }]);
      assert.equal(opsOf(db, "productTrackingLink.create").length, 0);
      assert.equal(opsOf(db, "productTrackingLink.update").length, 0);
    });
  }

  it("18/19/20. return shape: ACTIVE has the link object, PAUSED and EXPIRED have trackingLink === null", async () => {
    const db = makeDb();
    const active = await call(db, { clientCampaignAssignmentId: "asg-a" });
    assert.deepEqual(Object.keys(active).sort(), ["assignment", "ok", "trackingLink"]);
    assert.equal(typeof active.trackingLink, "object");
    assert.notEqual(active.trackingLink, null);
    const paused = await call(db, { status: "PAUSED" });
    assert.deepEqual(Object.keys(paused).sort(), ["assignment", "ok", "trackingLink"]);
    assert.equal(paused.trackingLink, null);
    const expired = await call(db, { status: "EXPIRED" });
    assert.deepEqual(Object.keys(expired).sort(), ["assignment", "ok", "trackingLink"]);
    assert.equal(expired.trackingLink, null);
  });

  it("14b. ACTIVE repeated call after reactivation still never yields two ACTIVE links", async () => {
    const db = makeDb();
    await call(db, { clientCampaignAssignmentId: "asg-a" });
    await call(db, { status: "PAUSED" });
    await call(db, { status: "ACTIVE" });
    await call(db, { status: "ACTIVE" });
    await call(db, { status: "ACTIVE", clientCampaignAssignmentId: "asg-a" });
    assert.equal(activeLinks(db).length, 1);
    assert.equal(db.links.size, 2);
  });
});

// ─── 2. same-client campaign reassignment and metadata repair ───────────────────────────────

describe("tracking-link state consistency — campaign relation", () => {
  it("11. same-client asg-a -> asg-b while ACTIVE: link repaired in place, same id/token/URL, no new link", async () => {
    const db = makeDb();
    const first = await call(db, { clientCampaignAssignmentId: "asg-a" });
    const { id, token, mboProductTrackingUrl } = first.trackingLink;
    db.ops.length = 0;
    const second = await call(db, { clientCampaignAssignmentId: "asg-b", status: "ACTIVE" });
    assert.equal(second.assignment.clientCampaignAssignmentId, "asg-b");
    assert.equal(second.trackingLink.id, id);
    assert.equal(second.trackingLink.token, token);
    assert.equal(second.trackingLink.mboProductTrackingUrl, mboProductTrackingUrl);
    assert.equal(second.trackingLink.clientCampaignAssignmentId, "asg-b");
    assert.equal(second.trackingLink.status, "ACTIVE");
    assert.equal(db.links.size, 1);
    assert.equal(activeLinks(db).length, 1);
    assert.equal(db.links.get(id).clientCampaignAssignmentId, "asg-b");
    assert.equal(db.links.get(id).token, token);
    assert.deepEqual(opsOf(db, "productTrackingLink.update"), [
      { op: "productTrackingLink.update", id, data: { clientProductAssignmentId: second.assignment.id, clientCampaignAssignmentId: "asg-b" } },
    ]);
    assert.equal(opsOf(db, "productTrackingLink.create").length, 0);
    assert.equal(opsOf(db, "productTrackingLink.updateMany").length, 0);
  });

  it("12. same-client campaign unchanged -> existing link reused, no link update", async () => {
    const db = makeDb();
    const first = await call(db, { clientCampaignAssignmentId: "asg-a" });
    db.ops.length = 0;
    const again = await call(db, { clientCampaignAssignmentId: "asg-a" });
    assert.equal(again.trackingLink.id, first.trackingLink.id);
    assert.equal(opsOf(db, "productTrackingLink.update").length, 0);
    assert.equal(opsOf(db, "productTrackingLink.create").length, 0);
  });

  it("13. ACTIVE link pointing at a stale clientProductAssignmentId -> repaired in place to assignment.id, token unchanged", async () => {
    const db = makeDb();
    seedAssignment(db, { id: "cpa-current", clientCampaignAssignmentId: "asg-a" });
    const stale = seedLink(db, { id: "stale-link", clientProductAssignmentId: "cpa-old", clientCampaignAssignmentId: "asg-a" });
    const result = await call(db, { clientCampaignAssignmentId: "asg-a" });
    assert.equal(result.trackingLink.id, "stale-link");
    assert.equal(result.trackingLink.token, stale.token);
    assert.equal(result.trackingLink.clientProductAssignmentId, "cpa-current");
    assert.equal(result.trackingLink.clientCampaignAssignmentId, "asg-a");
    assert.equal(db.links.size, 1);
    assert.deepEqual(opsOf(db, "productTrackingLink.update"), [
      { op: "productTrackingLink.update", id: "stale-link", data: { clientProductAssignmentId: "cpa-current", clientCampaignAssignmentId: "asg-a" } },
    ]);
  });

  it("16. no campaign assignment on a new assignment -> ACTIVE link has null campaign id", async () => {
    const db = makeDb();
    const result = await call(db);
    assert.equal(result.assignment.clientCampaignAssignmentId, null);
    assert.equal(result.trackingLink.clientCampaignAssignmentId, null);
    assert.equal(result.trackingLink.status, "ACTIVE");
    assert.equal(opsOf(db, "clientCampaignAssignment.findUnique").length, 0);
  });

  it("17. omitted campaign id on an existing assignment -> assignment keeps asg-a and the link is synchronized to it", async () => {
    const db = makeDb();
    seedAssignment(db, { clientCampaignAssignmentId: "asg-a" });
    seedLink(db, { id: "seed-link", clientProductAssignmentId: "cpa-seed", clientCampaignAssignmentId: null });
    const result = await call(db);
    assert.equal(result.assignment.clientCampaignAssignmentId, "asg-a", "omitted id does not clear the retained campaign");
    assert.equal(result.trackingLink.id, "seed-link");
    assert.equal(result.trackingLink.clientCampaignAssignmentId, "asg-a", "link follows the final assignment row, not the raw request");
    assert.equal(opsOf(db, "clientCampaignAssignment.findUnique").length, 0);
    assert.equal(db.links.size, 1);
    const explicitNull = makeDb();
    seedAssignment(explicitNull, { clientCampaignAssignmentId: "asg-a" });
    const r2 = await call(explicitNull, { clientCampaignAssignmentId: null });
    assert.equal(r2.assignment.clientCampaignAssignmentId, "asg-a");
    assert.equal(r2.trackingLink.clientCampaignAssignmentId, "asg-a");
  });

  it("stale link on a PAUSED transition is revoked, not repaired", async () => {
    const db = makeDb();
    seedAssignment(db, { clientCampaignAssignmentId: "asg-a" });
    seedLink(db, { id: "stale-link", clientProductAssignmentId: "cpa-old", clientCampaignAssignmentId: "asg-a" });
    const result = await call(db, { clientCampaignAssignmentId: "asg-b", status: "PAUSED" });
    assert.equal(result.assignment.clientCampaignAssignmentId, "asg-b");
    assert.equal(result.trackingLink, null);
    assert.equal(db.links.get("stale-link").status, "REVOKED");
    assert.equal(db.links.get("stale-link").clientCampaignAssignmentId, "asg-a", "revoked rows are not rewritten");
    assert.equal(opsOf(db, "productTrackingLink.update").length, 0);
  });
});

// ─── 3. ownership guard regression ──────────────────────────────────────────────────────────

describe("tracking-link state consistency — ownership guard", () => {
  it("14. campaign_assignment_client_mismatch -> no assignment write, no link find/update/updateMany/create", async () => {
    const db = makeDb();
    seedAssignment(db);
    seedLink(db, { id: "live", clientProductAssignmentId: "cpa-seed", clientCampaignAssignmentId: "asg-a" });
    for (const status of ["ACTIVE", "PAUSED", "EXPIRED"]) {
      db.ops.length = 0;
      const result = await call(db, { clientCampaignAssignmentId: "asg-other", status });
      assert.deepEqual(result, { ok: false, reason: "campaign_assignment_client_mismatch" }, status);
      assert.deepEqual(db.ops.map((o) => o.op), ["product.findUnique", "clientCampaignAssignment.findUnique"], status);
    }
    assert.equal(db.assignments.get("cpa-seed").clientCampaignAssignmentId, "asg-a");
    assert.equal(db.assignments.get("cpa-seed").status, "ACTIVE");
    assert.equal(db.links.get("live").status, "ACTIVE");
    assert.equal(db.links.get("live").clientCampaignAssignmentId, "asg-a");
  });

  it("15. campaign_assignment_not_found -> no link mutation of any kind", async () => {
    const db = makeDb();
    seedAssignment(db);
    seedLink(db, { id: "live", clientProductAssignmentId: "cpa-seed", clientCampaignAssignmentId: "asg-a" });
    for (const status of ["ACTIVE", "PAUSED"]) {
      db.ops.length = 0;
      const result = await call(db, { clientCampaignAssignmentId: "asg-missing", status });
      assert.deepEqual(result, { ok: false, reason: "campaign_assignment_not_found" }, status);
      assert.deepEqual(db.ops.map((o) => o.op), ["product.findUnique", "clientCampaignAssignment.findUnique"], status);
    }
    assert.equal(db.links.get("live").status, "ACTIVE");
  });

  it("mutation ordering: guard -> assignment write -> link work, on every successful path", async () => {
    const db = makeDb();
    await call(db, { clientCampaignAssignmentId: "asg-a" });
    assert.deepEqual(db.ops.map((o) => o.op), [
      "product.findUnique",
      "clientCampaignAssignment.findUnique",
      "clientProductAssignment.findUnique",
      "clientProductAssignment.create",
      "productTrackingLink.findFirst",
      "productTrackingLink.create",
    ]);
    db.ops.length = 0;
    await call(db, { clientCampaignAssignmentId: "asg-b" });
    assert.deepEqual(db.ops.map((o) => o.op), [
      "product.findUnique",
      "clientCampaignAssignment.findUnique",
      "clientProductAssignment.findUnique",
      "clientProductAssignment.update",
      "productTrackingLink.findFirst",
      "productTrackingLink.update",
    ]);
    db.ops.length = 0;
    await call(db, { status: "EXPIRED" });
    assert.deepEqual(db.ops.map((o) => o.op), [
      "product.findUnique",
      "clientProductAssignment.findUnique",
      "clientProductAssignment.update",
      "productTrackingLink.updateMany",
    ]);
  });
});

// ─── 4. redirect attribution regression ─────────────────────────────────────────────────────

describe("tracking-link state consistency — redirect attribution after same-client reassignment", () => {
  it("after asg-a -> asg-b the redirect attributes the SAME token to asg-b", async () => {
    const db = makeDb();
    const first = await call(db, { clientCampaignAssignmentId: "asg-a" });
    const token = first.trackingLink.token;
    const clicks = [];
    const redirect = new ProductTrackingRedirectService({
      prisma: db,
      attribution: { recordClick: async (args) => { clicks.push(args); return { id: "click-1" }; } },
    });

    db.ops.length = 0;
    const before = await redirect.redirect(token);
    assert.equal(new URL(before.destination).searchParams.get("subId2"), "asg-a");
    assert.deepEqual(opsOf(db, "trackingLink.findFirst").map((o) => o.assignmentId), ["asg-a"]);
    assert.equal(clicks[0].trackingLinkId, "tl-asg-a");
    assert.equal(clicks[0].subId, token);

    await call(db, { clientCampaignAssignmentId: "asg-b" });
    db.ops.length = 0;
    const after = await redirect.redirect(token);
    assert.equal(after.productTrackingLinkId, first.trackingLink.id);
    assert.equal(new URL(after.destination).searchParams.get("subId2"), "asg-b");
    assert.equal(new URL(after.destination).searchParams.get("subId1"), "client-a");
    assert.deepEqual(opsOf(db, "trackingLink.findFirst").map((o) => o.assignmentId), ["asg-b"]);
    assert.equal(clicks[1].trackingLinkId, "tl-asg-b");
    assert.equal(clicks[1].subId, token);
    assert.equal(clicks[1].metadata.productTrackingLinkId, first.trackingLink.id);
  });

  it("after PAUSED the distributed token is dead (404) and reactivation issues a different live token", async () => {
    const db = makeDb();
    const first = await call(db, { clientCampaignAssignmentId: "asg-a" });
    const redirect = new ProductTrackingRedirectService({ prisma: db, attribution: { recordClick: async () => ({ id: "c" }) } });
    await call(db, { status: "PAUSED" });
    await assert.rejects(() => redirect.redirect(first.trackingLink.token), /Product tracking link not found\./);
    const reactivated = await call(db, { status: "ACTIVE" });
    await assert.rejects(() => redirect.redirect(first.trackingLink.token), /Product tracking link not found\./);
    const live = await redirect.redirect(reactivated.trackingLink.token);
    assert.equal(live.productTrackingLinkId, reactivated.trackingLink.id);
    assert.equal(new URL(live.destination).searchParams.get("subId2"), "asg-a");
  });
});

// ─── 5. static proofs ───────────────────────────────────────────────────────────────────────

describe("tracking-link state consistency — static proofs", () => {
  const body = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf("async assignProductToClient("), SERVICE_SOURCE.indexOf("async unassignProduct("));

  it("ownership guard precedes every assignment and link operation", () => {
    const guard = body.indexOf('reason: "campaign_assignment_client_mismatch"');
    const firstAssignmentOp = body.indexOf("clientProductAssignment.findUnique(");
    const firstLinkOp = Math.min(
      ...["productTrackingLink.findFirst(", "productTrackingLink.create(", "productTrackingLink.update(", "productTrackingLink.updateMany("].map((s) => body.indexOf(s)),
    );
    assert.ok(guard > 0 && guard < firstAssignmentOp && guard < firstLinkOp);
  });

  it("link state follows the final assignment row, PAUSED/EXPIRED revoke via updateMany and cannot create, ACTIVE creates or repairs in place", () => {
    assert.match(body, /const effectiveCampaignAssignmentId = assignment\.clientCampaignAssignmentId \?\? null;/);
    const inactive = body.slice(body.indexOf('if (assignment.status !== "ACTIVE")'), body.indexOf("let link = await db.productTrackingLink.findFirst("));
    assert.match(inactive, /productTrackingLink\.updateMany\(\{\s*where: \{ clientId, productId, status: "ACTIVE" \},\s*data: \{ status: "REVOKED" \},/);
    assert.match(inactive, /return \{ ok: true, assignment, trackingLink: null \};/);
    assert.doesNotMatch(inactive, /productTrackingLink\.create|generateProductTrackingToken|productTrackingLink\.findFirst/);
    const active = body.slice(body.indexOf("let link = await db.productTrackingLink.findFirst("));
    assert.match(active, /clientCampaignAssignmentId: effectiveCampaignAssignmentId,\s*token,/);
    assert.match(active, /productTrackingLink\.update\(\{\s*where: \{ id: link\.id \},\s*data: \{\s*clientProductAssignmentId: assignment\.id,\s*clientCampaignAssignmentId: effectiveCampaignAssignmentId,\s*\},\s*\}\)/);
    assert.doesNotMatch(active.slice(active.indexOf("} else if")), /token:|mboProductTrackingUrl:|status:/);
    assert.match(active, /return \{ ok: true, assignment, trackingLink: link \};/);
    assert.equal((body.match(/generateProductTrackingToken\(\)/g) || []).length, 1);
  });

  it("unassignProduct is unchanged and shares the revoke semantics", () => {
    const unassign = SERVICE_SOURCE.slice(SERVICE_SOURCE.indexOf("async unassignProduct("), SERVICE_SOURCE.indexOf("async listClientProducts("));
    assert.match(unassign, /data: \{ status: "PAUSED" \}/);
    assert.match(unassign, /productTrackingLink\.updateMany\(\{\s*where: \{ clientId, productId, status: "ACTIVE" \},\s*data: \{ status: "REVOKED" \},/);
  });
});
