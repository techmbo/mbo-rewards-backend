import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPLIER_TRACKING_LINK_PROVENANCE,
  SUPPLIER_TRACKING_LINK_STATE,
} from "../src/modules/tracking/supplierTrackingLink.contract.js";
import {
  OPERATOR_SETTABLE_STATES,
  SUPPLIER_TRACKING_LINK_AUDIT_ACTION,
  SupplierTrackingLinkService,
} from "../src/modules/tracking/supplierTrackingLink.service.js";

const LINK = "https://prf.hn/click/camref:1101lAbCd";
const DESTINATION = "https://www.merchant-example.com/spring";
const ID = "11111111-1111-4111-8111-111111111111";

function makeRecord(overrides = {}) {
  return {
    id: ID,
    supplier: "PARTNERIZE",
    supplierRegion: "GLOBAL",
    supplierCampaignId: "5001",
    campaignName: "Example Campaign",
    merchantNameRaw: "Example",
    campaignStatus: "ACTIVE",
    participationStatus: "JOINED",
    isJoined: true,
    destinationUrl: DESTINATION,
    trackingUrl: null,
    supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.NOT_GENERATED,
    supplierTrackingLinkProvenance: null,
    supplierTrackingLinkUpdatedAt: null,
    supplierTrackingLinkUpdatedBy: null,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

function makeHarness({ record = makeRecord(), rows = null } = {}) {
  const calls = { update: [], findMany: [], count: 0, audit: [] };
  let current = record;
  const db = {
    supplierCampaign: {
      findUnique: async () => (current ? { ...current } : null),
      findMany: async (args) => {
        calls.findMany.push(args);
        return (rows ?? [current]).map((row) => ({ ...row }));
      },
      count: async () => {
        calls.count += 1;
        return (rows ?? [current]).length;
      },
      update: async (args) => {
        calls.update.push(args);
        current = { ...current, ...args.data };
        return { ...current };
      },
    },
  };
  const audit = { record: async (entry) => calls.audit.push(entry) };
  return { service: new SupplierTrackingLinkService({ db, audit }), calls, get current() { return current; } };
}

/* ------------------------------------------------------------ work queue */

test("REQUIRED 3: the queue lists joined/approved Partnerize campaigns in NOT_GENERATED", async () => {
  const { service, calls } = makeHarness();
  const result = await service.listWorkQueue({ state: SUPPLIER_TRACKING_LINK_STATE.NOT_GENERATED });
  const where = calls.findMany[0].where;
  assert.equal(where.supplier, "PARTNERIZE");
  assert.equal(where.supplierTrackingLinkState, SUPPLIER_TRACKING_LINK_STATE.NOT_GENERATED);
  assert.equal(where.archivedAt, null);
  assert.deepEqual(where.OR, [{ isJoined: true }, { participationStatus: "JOINED" }]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.pagination.total, 1);
});

test("ALL: an omitted state applies no state filter at all", async () => {
  const { service, calls } = makeHarness();
  await service.listWorkQueue();
  const where = calls.findMany[0].where;
  assert.equal(
    "supplierTrackingLinkState" in where,
    false,
    "omitting state must not silently become NOT_GENERATED",
  );
  // Every other constraint still applies — All widens the state, nothing else.
  assert.equal(where.supplier, "PARTNERIZE");
  assert.equal(where.archivedAt, null);
  assert.deepEqual(where.OR, [{ isJoined: true }, { participationStatus: "JOINED" }]);

  for (const state of [null, undefined, ""]) {
    calls.findMany.length = 0;
    await service.listWorkQueue({ state });
    assert.equal("supplierTrackingLinkState" in calls.findMany[0].where, false, JSON.stringify(state));
  }
});

test("ALL: every individual state still filters to exactly that state", async () => {
  const { service, calls } = makeHarness();
  for (const state of Object.values(SUPPLIER_TRACKING_LINK_STATE)) {
    calls.findMany.length = 0;
    await service.listWorkQueue({ state });
    assert.equal(calls.findMany[0].where.supplierTrackingLinkState, state, state);
  }
});

test("unjoined campaigns are not presented as manual-link work by default", async () => {
  const { service, calls } = makeHarness();
  await service.listWorkQueue();
  assert.ok(calls.findMany[0].where.OR, "join filter must be applied by default");

  await service.listWorkQueue({ joinedOnly: false });
  assert.equal(calls.findMany[1].where.OR, undefined);
});

test("the queue never leaks raw payloads and exposes the stored link by host only", async () => {
  const { service, calls } = makeHarness({
    record: makeRecord({
      trackingUrl: `${LINK}?adref=client-9`,
      supplierTrackingLinkState: SUPPLIER_TRACKING_LINK_STATE.AVAILABLE,
    }),
  });
  const result = await service.listWorkQueue({ state: SUPPLIER_TRACKING_LINK_STATE.AVAILABLE });
  const select = calls.findMany[0].select;
  for (const banned of ["rawPayload", "normalizedPayload", "adminOverrides", "fieldPolicies"]) {
    assert.equal(select[banned], undefined, banned);
  }
  const row = result.rows[0];
  assert.equal(row.supplierTrackingUrlHost, "prf.hn");
  assert.equal(row.hasSupplierTrackingUrl, true);
  assert.equal(row.trackingUrl, undefined, "the full attributed URL is not returned in the queue");
  // destinationUrl is exposed for operator reference only, clearly under its own key.
  assert.equal(row.destinationUrl, DESTINATION);
});

test("page size is clamped and pagination is honoured", async () => {
  const { service, calls } = makeHarness();
  await service.listWorkQueue({ page: 3, pageSize: 5000 });
  assert.equal(calls.findMany[0].take, 100);
  assert.equal(calls.findMany[0].skip, 200);

  await service.listWorkQueue({ page: 0, pageSize: 0 });
  assert.equal(calls.findMany[1].skip, 0);
  assert.ok(calls.findMany[1].take >= 1);
});

/* ------------------------------------------------------------ set link */

test("REQUIRED 4+5: a valid link is stored with MANUAL_ADMIN provenance and AVAILABLE state", async () => {
  const { service, calls } = makeHarness();
  const row = await service.setSupplierTrackingLink({
    supplierCampaignId: ID,
    supplierTrackingUrl: LINK,
    actor: { id: "user-1", email: "ops@example.com" },
  });

  const data = calls.update[0].data;
  assert.equal(data.trackingUrl, LINK);
  assert.equal(data.supplierTrackingLinkState, SUPPLIER_TRACKING_LINK_STATE.AVAILABLE);
  assert.equal(data.supplierTrackingLinkProvenance, SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN);
  assert.ok(data.supplierTrackingLinkUpdatedAt instanceof Date);
  assert.equal(data.supplierTrackingLinkUpdatedBy, "user-1");
  assert.equal(row.supplierTrackingLinkState, SUPPLIER_TRACKING_LINK_STATE.AVAILABLE);
});

test("REQUIRED 1: destinationUrl is never written into the supplier tracking link", async () => {
  const { service, calls } = makeHarness();
  await assert.rejects(
    () => service.setSupplierTrackingLink({ supplierCampaignId: ID, supplierTrackingUrl: DESTINATION, actor: { id: "user-1", email: "ops@example.com" }, }),
    (error) => error.code === "TRACKING_HOST_NOT_ALLOWLISTED",
  );
  assert.equal(calls.update.length, 0, "a rejected URL must not write anything");

  // And a successful write never touches destinationUrl.
  await service.setSupplierTrackingLink({ supplierCampaignId: ID, supplierTrackingUrl: LINK, actor: { id: "user-1", email: "ops@example.com" }, });
  assert.equal(calls.update[0].data.destinationUrl, undefined);
});

test("REQUIRED 12: the caller cannot reassign the campaign or override server-controlled fields", async () => {
  const { service, calls } = makeHarness();
  await service.setSupplierTrackingLink({
    supplierCampaignId: ID,
    supplierTrackingUrl: LINK,
    actor: { id: "user-1", email: "ops@example.com" },
    // These are ignored by the service signature entirely.
    supplier: "OPTIMISE",
    provenance: SUPPLIER_TRACKING_LINK_PROVENANCE.SUPPLIER_API,
    destinationUrl: "https://attacker.example",
  });
  const call = calls.update[0];
  assert.deepEqual(call.where, { id: ID });
  assert.equal(call.data.supplier, undefined);
  assert.equal(call.data.supplierCampaignId, undefined);
  assert.equal(call.data.destinationUrl, undefined);
  assert.equal(
    call.data.supplierTrackingLinkProvenance,
    SUPPLIER_TRACKING_LINK_PROVENANCE.MANUAL_ADMIN,
    "provenance is server-set, never caller-supplied",
  );
});

test("a missing campaign is a 404-shaped error and writes nothing", async () => {
  const { service, calls } = makeHarness();
  service.db.supplierCampaign.findUnique = async () => null;
  await assert.rejects(
    () => service.setSupplierTrackingLink({ supplierCampaignId: ID, supplierTrackingUrl: LINK, actor: { id: "user-1", email: "ops@example.com" }, }),
    (error) => error.code === "SUPPLIER_CAMPAIGN_NOT_FOUND",
  );
  assert.equal(calls.update.length, 0);
});

test("the host allowlist is applied against the record's own supplier, not a caller value", async () => {
  const { service } = makeHarness({ record: makeRecord({ supplier: "OPTIMISE" }) });
  await assert.rejects(
    () => service.setSupplierTrackingLink({ supplierCampaignId: ID, supplierTrackingUrl: LINK, actor: { id: "user-1", email: "ops@example.com" }, }),
    (error) => error.code === "NEEDS_TRACKING_HOST_EVIDENCE",
  );
});

/* --------------------------------------------------------------- states */

test("operators may set NEEDS_REVIEW and REVOKED but cannot forge AVAILABLE", async () => {
  assert.deepEqual([...OPERATOR_SETTABLE_STATES], ["TRACKING_LINK_NEEDS_REVIEW", "TRACKING_LINK_REVOKED"]);
  const { service, calls } = makeHarness();
  for (const state of OPERATOR_SETTABLE_STATES) {
    await service.setSupplierTrackingLinkState({ supplierCampaignId: ID, state, actor: { id: "user-1", email: "ops@example.com" }, });
  }
  assert.equal(calls.update.length, 2);

  for (const state of ["TRACKING_LINK_AVAILABLE", "TRACKING_LINK_NOT_GENERATED", "NONSENSE"]) {
    await assert.rejects(
      () => service.setSupplierTrackingLinkState({ supplierCampaignId: ID, state, actor: { id: "user-1", email: "ops@example.com" }, }),
      (error) => error.code === "STATE_NOT_OPERATOR_SETTABLE",
      state,
    );
  }
  assert.equal(calls.update.length, 2, "rejected states must not write");
});

/* ---------------------------------------------------------------- audit */

test("REQUIRED 14: an audit entry is written with actor, states and field, and no attributed URL", async () => {
  const { service, calls } = makeHarness();
  await service.setSupplierTrackingLink({
    supplierCampaignId: ID,
    supplierTrackingUrl: `${LINK}?adref=client-9&pubref=a-7`,
    actor: { id: "user-7", email: "ops@example.com" },
    reason: "Generated in the Partnerize portal.",
  });

  assert.equal(calls.audit.length, 1);
  const entry = calls.audit[0];
  assert.equal(entry.aggregateType, "supplier_campaign");
  assert.equal(entry.aggregateId, ID);
  assert.equal(entry.action, SUPPLIER_TRACKING_LINK_AUDIT_ACTION);
  assert.equal(entry.actorId, "user-7");
  assert.equal(entry.metadata.field, "trackingUrl");
  assert.equal(entry.before.supplierTrackingLinkState, SUPPLIER_TRACKING_LINK_STATE.NOT_GENERATED);
  assert.equal(entry.after.supplierTrackingLinkState, SUPPLIER_TRACKING_LINK_STATE.AVAILABLE);
  assert.equal(entry.after.supplierTrackingUrlHost, "prf.hn");
  assert.ok(String(entry.reason).length > 0);

  const serialised = JSON.stringify(entry);
  for (const secret of ["adref", "pubref", "camref", "client-9", "a-7", "1101lAbCd"]) {
    assert.ok(!serialised.includes(secret), `audit entry leaked ${secret}`);
  }
});

test("state transitions are audited with before and after", async () => {
  const { service, calls } = makeHarness();
  await service.setSupplierTrackingLinkState({
    supplierCampaignId: ID,
    state: "TRACKING_LINK_REVOKED",
    actor: { id: "user-2" },
  });
  const entry = calls.audit[0];
  assert.equal(entry.before.supplierTrackingLinkState, SUPPLIER_TRACKING_LINK_STATE.NOT_GENERATED);
  assert.equal(entry.after.supplierTrackingLinkState, "TRACKING_LINK_REVOKED");
  assert.equal(entry.actorId, "user-2");
});

test("REQUIRED 13/14: an unattributable manual change is refused before any write", async () => {
  const { service, calls } = makeHarness();
  for (const actor of [null, undefined, {}, { id: null, email: null }]) {
    await assert.rejects(
      () => service.setSupplierTrackingLink({ supplierCampaignId: ID, supplierTrackingUrl: LINK, actor }),
      (error) => error.code === "ACTOR_REQUIRED",
    );
    await assert.rejects(
      () =>
        service.setSupplierTrackingLinkState({
          supplierCampaignId: ID,
          state: "TRACKING_LINK_REVOKED",
          actor,
        }),
      (error) => error.code === "ACTOR_REQUIRED",
    );
  }
  assert.equal(calls.update.length, 0, "no write may occur without an identifiable actor");
  assert.equal(calls.audit.length, 0);
});

test("an actor identified only by email is accepted", async () => {
  const { service, calls } = makeHarness();
  await service.setSupplierTrackingLink({
    supplierCampaignId: ID,
    supplierTrackingUrl: LINK,
    actor: { email: "ops@example.com" },
  });
  assert.equal(calls.audit[0].actorEmail, "ops@example.com");
});
