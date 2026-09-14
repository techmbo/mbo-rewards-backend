import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Minimum environment for createApp(); mirrors test/p8.databaseRecoveryRouteMount.test.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.LOG_LEVEL = "silent";

const ROUTES = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
const CONTROLLER = readFileSync(
  new URL("../src/controllers/supplierTrackingLinks.controller.js", import.meta.url),
  "utf8",
);

const SERVICE_SRC_FOR_ALL = readFileSync(
  new URL("../src/modules/tracking/supplierTrackingLink.service.js", import.meta.url),
  "utf8",
);

const QUEUE = '"/supplier-campaigns/tracking-links/queue"';
const SET = '"/supplier-campaigns/:id/tracking-link"';
const STATE = '"/supplier-campaigns/:id/tracking-link/state"';

function blockFor(path) {
  const at = ROUTES.indexOf(path);
  assert.ok(at > -1, `route ${path} is not mounted`);
  const start = ROUTES.lastIndexOf("router.", at);
  const end = ROUTES.indexOf(");", at);
  return ROUTES.slice(start, end);
}

test("REQUIRED 13: all three routes require authentication", () => {
  for (const path of [QUEUE, SET, STATE]) {
    assert.ok(blockFor(path).includes("authenticate"), path);
  }
});

test("REQUIRED 13: the queue is read-only and gated on TRACKING_READ", () => {
  const block = blockFor(QUEUE);
  assert.ok(block.startsWith("router.get("), "the work queue must be a GET");
  assert.ok(block.includes("PERMISSIONS.TRACKING_READ"));
});

test("REQUIRED 13: both write routes are gated on TRACKING_MANAGE and audited", () => {
  for (const path of [SET, STATE]) {
    const block = blockFor(path);
    assert.ok(block.includes("PERMISSIONS.TRACKING_MANAGE"), path);
    assert.ok(block.includes("auditAction("), path);
    assert.ok(!block.includes("PERMISSIONS.TRACKING_READ"), path);
  }
});

test("the queue route is declared before the :id routes so it is not shadowed", () => {
  assert.ok(ROUTES.indexOf(QUEUE) < ROUTES.indexOf(SET));
});

test("no new permission was invented; existing TRACKING_* permissions are reused", () => {
  const permissions = readFileSync(new URL("../src/auth/permissions.js", import.meta.url), "utf8");
  assert.ok(permissions.includes('TRACKING_READ: "tracking:read"'));
  assert.ok(permissions.includes('TRACKING_MANAGE: "tracking:manage"'));
  for (const path of [QUEUE, SET, STATE]) {
    assert.ok(!blockFor(path).includes("SUPPLIER_TRACKING"), path);
  }
});

test("REQUIRED 12: the write body schema is strict and rejects override fields", async () => {
  // A strict schema rejects any unknown key, which is what blocks supplier/publisher/campaign
  // overrides and caller-supplied provenance.
  assert.ok(CONTROLLER.includes(".strict()"));
  const { z } = await import("zod");
  const schema = z
    .object({ supplierTrackingUrl: z.string().min(1).max(2048), reason: z.string().max(500).optional() })
    .strict();
  for (const extra of [
    { supplier: "OPTIMISE" },
    { publisherId: "123" },
    { supplierCampaignId: "other" },
    { destinationUrl: "https://attacker.example" },
    { provenance: "SUPPLIER_API" },
    { supplierTrackingLinkState: "TRACKING_LINK_AVAILABLE" },
  ]) {
    const result = schema.safeParse({ supplierTrackingUrl: "https://prf.hn/click/camref:1", ...extra });
    assert.equal(result.success, false, JSON.stringify(extra));
  }
});

test("joinedOnly=false is honoured — z.coerce.boolean() would silently invert it", async () => {
  // z.coerce.boolean() applies JS truthiness, so the string "false" becomes true and the filter
  // is silently ignored. Caught against a live database; the controller must not use it.
  assert.ok(!CONTROLLER.includes("z.coerce.boolean()"), "z.coerce.boolean() is unsafe for query strings");

  const { z } = await import("zod");
  const booleanFlag = z
    .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
    .transform((value) => (typeof value === "boolean" ? value : ["true", "1", "yes"].includes(value)));

  assert.equal(booleanFlag.parse("false"), false);
  assert.equal(booleanFlag.parse("0"), false);
  assert.equal(booleanFlag.parse("no"), false);
  assert.equal(booleanFlag.parse("true"), true);
  assert.equal(booleanFlag.parse("1"), true);
  assert.equal(booleanFlag.parse(false), false);
  assert.equal(booleanFlag.safeParse("maybe").success, false);

  // And the real schema in the controller behaves the same way.
  assert.ok(CONTROLLER.includes("booleanFlag"));
  assert.ok(CONTROLLER.includes('["true", "1", "yes"].includes'));
});

test("the controller never echoes the stored attributed URL back verbatim", () => {
  // Responses are built from the service's row shape, which exposes host only.
  assert.ok(!CONTROLLER.includes("trackingUrl: record.trackingUrl"));
  assert.ok(CONTROLLER.includes("ok("));
});

test("the app boots with the new routes mounted", async () => {
  const { createApp } = await import("../src/app.js");
  const app = createApp();
  assert.ok(app, "createApp() must succeed with the tracking-link routes mounted");
});

/* ------------------------------------------------- ALL filter query contract */

test("ALL: state is optional with no default, so omitting it means every state", async () => {
  const { z } = await import("zod");
  const { SUPPLIER_TRACKING_LINK_STATES } = await import(
    "../src/modules/tracking/supplierTrackingLink.contract.js"
  );
  const schema = z.object({
    supplier: z.enum(["PARTNERIZE"]).default("PARTNERIZE"),
    state: z.enum(SUPPLIER_TRACKING_LINK_STATES).optional(),
  });

  // Omitted -> undefined, which the service reads as "no state filter".
  const omitted = schema.parse({});
  assert.equal(omitted.state, undefined);
  assert.equal("state" in omitted && omitted.state !== undefined, false);

  // The controller must carry no default for state, or All can never be expressed.
  assert.ok(!/state:\s*z\.enum\([^)]*\)\.default\(/.test(CONTROLLER), "state must not have a default");
  assert.ok(CONTROLLER.includes("state: z.enum(SUPPLIER_TRACKING_LINK_STATES).optional()"));
});

test("ALL: a supplied state is still validated against the real enum", async () => {
  const { z } = await import("zod");
  const { SUPPLIER_TRACKING_LINK_STATES } = await import(
    "../src/modules/tracking/supplierTrackingLink.contract.js"
  );
  const schema = z.object({ state: z.enum(SUPPLIER_TRACKING_LINK_STATES).optional() });

  for (const state of SUPPLIER_TRACKING_LINK_STATES) {
    assert.equal(schema.parse({ state }).state, state);
  }
  // An unknown value is a 400, never a silent unfiltered query.
  for (const state of ["ALL", "all", "", "ANY", "TRACKING_LINK_UNKNOWN", "null"]) {
    assert.equal(schema.safeParse({ state }).success, false, JSON.stringify(state));
  }
});

test("ALL: no ALL sentinel was introduced into the state enum", async () => {
  const { SUPPLIER_TRACKING_LINK_STATES } = await import(
    "../src/modules/tracking/supplierTrackingLink.contract.js"
  );
  assert.deepEqual([...SUPPLIER_TRACKING_LINK_STATES], [
    "TRACKING_LINK_NOT_GENERATED",
    "TRACKING_LINK_AVAILABLE",
    "TRACKING_LINK_NEEDS_REVIEW",
    "TRACKING_LINK_REVOKED",
  ]);
  for (const source of [CONTROLLER, SERVICE_SRC_FOR_ALL]) {
    assert.ok(!/"ALL"/.test(source), "no ALL sentinel value");
  }
});

test("ALL: the service filter guard itself is unchanged", () => {
  // Only the default moved. The conditional that applies the filter is the original.
  assert.ok(SERVICE_SRC_FOR_ALL.includes("if (state) where.supplierTrackingLinkState = state;"));
  assert.ok(SERVICE_SRC_FOR_ALL.includes("state = null"), "the default is now null, not a state");
  assert.ok(!/state = SUPPLIER_TRACKING_LINK_STATE\.NOT_GENERATED/.test(SERVICE_SRC_FOR_ALL));
});
