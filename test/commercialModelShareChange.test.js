import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";

// The onboarding service's import graph reads the public URL config at load time. Same pattern as
// productAssignmentTransaction.test.js: default the two URLs, then import.
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const { ClientOnboardingService } = await import(
  "../src/modules/client/services/clientOnboarding.service.js"
);
const { ClientCommercialRuntimeService } = await import(
  "../src/modules/commercial/services/clientCommercialRuntime.service.js"
);
const { applyCommissionRuleToGross } = await import("../src/modules/reporting/attributionMath.js");

/**
 * setCommercialModel lifecycle invariant: an assignment that had an EFFECTIVE ClientCommissionRule
 * before a valid client share/model change has exactly one EFFECTIVE rule, carrying the new
 * split, after the change completes — never a DRAFT-only gap that waits for provision().
 *
 * The store below behaves like the Prisma rows the service really sees: money columns are
 * Prisma.Decimal instances, whose String() form drops trailing zeros ("70", not "70.0000").
 * Writes go through a transaction shim with snapshot/rollback so partial-failure behaviour is
 * observable.
 */

const CLIENT_ID = "client-1";

function money(value) {
  return new Prisma.Decimal(String(value));
}

function decimalise(data) {
  const out = { ...data };
  for (const key of ["grossCommission", "clientCommission", "mboCommission"]) {
    if (out[key] != null) out[key] = money(out[key]);
  }
  return out;
}

function rule(id, assignmentId, clientShare, status, overrides = {}) {
  return {
    id,
    assignmentId,
    status,
    commissionType: "PERCENT",
    grossCommission: money("100.0000"),
    clientCommission: money(`${clientShare}.0000`),
    mboCommission: money(`${100 - clientShare}.0000`),
    effectiveFrom: new Date("2026-08-01T00:00:00Z"),
    effectiveUntil: null,
    ...overrides,
  };
}

function matchesWhere(row, where = {}) {
  for (const [key, cond] of Object.entries(where)) {
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !cond.in.includes(row[key])) return false;
      if ("not" in cond && row[key] === cond.not) return false;
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

function store({ share = 70, assignments = [], rules = [], failOnCreateForAssignment = null } = {}) {
  const state = {
    client: {
      id: CLIENT_ID,
      status: "ACTIVE",
      commercialModel: "OFFERS_PLUS_COMMISSION",
      clientSharePercent: money(`${share}.00`),
    },
    assignments: assignments.map((a) => ({
      clientId: CLIENT_ID,
      status: "ACTIVE",
      createdAt: new Date("2026-08-01T00:00:00Z"),
      ...a,
    })),
    rules: [...rules],
  };
  let seq = 0;
  const calls = { txStarted: 0, txCommitted: 0, txRolledBack: 0, ruleCreates: 0, ruleUpdates: 0 };

  const db = {
    client: {
      update: async ({ where, data }) => {
        assert.equal(where.id, CLIENT_ID);
        state.client = { ...state.client, ...data, clientSharePercent: money(String(data.clientSharePercent)) };
        return state.client;
      },
    },
    clientCampaignAssignment: {
      findMany: async ({ where, select }) => {
        assert.deepEqual(select, { id: true }, "only assignment ids are loaded");
        return state.assignments
          .filter((a) => matchesWhere(a, where))
          .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1))
          .map((a) => ({ id: a.id }));
      },
    },
    clientCommissionRule: {
      findFirst: async ({ where }) => {
        const rows = state.rules
          .filter((r) => matchesWhere(r, where))
          .sort((x, y) => (x.status < y.status ? 1 : x.status > y.status ? -1 : y.effectiveFrom - x.effectiveFrom));
        return rows[0] ?? null;
      },
      update: async ({ where, data }) => {
        calls.ruleUpdates += 1;
        const idx = state.rules.findIndex((r) => r.id === where.id);
        assert.ok(idx >= 0, `update of unknown rule ${where.id}`);
        state.rules[idx] = { ...state.rules[idx], ...decimalise(data) };
        return state.rules[idx];
      },
      create: async ({ data }) => {
        calls.ruleCreates += 1;
        if (failOnCreateForAssignment && data.assignmentId === failOnCreateForAssignment) {
          throw new Error(`simulated failure creating rule for ${data.assignmentId}`);
        }
        seq += 1;
        const row = { id: `new-${seq}`, ...decimalise(data) };
        state.rules.push(row);
        return row;
      },
    },
  };

  const runInTransaction = async (fn) => {
    calls.txStarted += 1;
    const snapshot = { client: state.client, assignments: [...state.assignments], rules: [...state.rules] };
    try {
      const out = await fn(db);
      calls.txCommitted += 1;
      return out;
    } catch (error) {
      state.client = snapshot.client;
      state.assignments = snapshot.assignments;
      state.rules = snapshot.rules;
      calls.txRolledBack += 1;
      throw error;
    }
  };

  const service = new ClientOnboardingService({
    clientRepo: {
      findById: async (id) => (id === CLIENT_ID ? state.client : null),
      update: async (id, data, tx) => {
        assert.ok(tx, "client update must run inside the transaction");
        return tx.client.update({ where: { id }, data });
      },
    },
    runInTransaction,
  });

  const rulesFor = (assignmentId, status = null) =>
    state.rules.filter((r) => r.assignmentId === assignmentId && (status == null || r.status === status));

  return { state, calls, service, rulesFor };
}

function effectiveRuleRepo(state) {
  return {
    findEffectiveRulesForAssignment: async (assignmentId, at = new Date()) =>
      state.rules.filter(
        (r) =>
          r.assignmentId === assignmentId &&
          r.status === "EFFECTIVE" &&
          new Date(r.effectiveFrom).getTime() <= at.getTime() &&
          (r.effectiveUntil == null || new Date(r.effectiveUntil).getTime() > at.getTime()),
      ),
  };
}

function assertSplit(row, clientShare) {
  assert.equal(Number(row.grossCommission), 100);
  assert.equal(Number(row.clientCommission), clientShare);
  assert.equal(Number(row.mboCommission), 100 - clientShare);
}

describe("setCommercialModel — share change keeps EFFECTIVE assignments payable", () => {
  it("6. EFFECTIVE 70% → 60%: old SUPERSEDED, exactly one new EFFECTIVE 60% rule, no DRAFT gap, both engines resolve it", async () => {
    const s = store({
      assignments: [{ id: "a1" }],
      rules: [rule("old-70", "a1", 70, "EFFECTIVE")],
    });

    const updated = await s.service.setCommercialModel(CLIENT_ID, {
      commercialModel: "OFFERS_PLUS_COMMISSION",
      clientSharePercent: 60,
    });

    assert.equal(Number(updated.clientSharePercent), 60);
    assert.equal(Number(s.state.client.clientSharePercent), 60);

    const old = s.state.rules.find((r) => r.id === "old-70");
    assert.equal(old.status, "SUPERSEDED");
    assert.ok(old.effectiveUntil instanceof Date, "superseded rule is closed with effectiveUntil");
    assertSplit(old, 70);

    const effective = s.rulesFor("a1", "EFFECTIVE");
    assert.equal(effective.length, 1, "exactly one EFFECTIVE rule after the change");
    assertSplit(effective[0], 60);
    assert.equal(effective[0].commissionType, "PERCENT");
    assert.notEqual(effective[0].id, "old-70", "the replacement is a new row, history preserved");
    assert.equal(s.rulesFor("a1", "DRAFT").length, 0, "no DRAFT-only gap");
    assert.equal(s.rulesFor("a1").length, 2);
    assert.deepEqual(
      { started: s.calls.txStarted, committed: s.calls.txCommitted, rolledBack: s.calls.txRolledBack },
      { started: 1, committed: 1, rolledBack: 0 },
    );

    // Attribution resolves the new EFFECTIVE rule immediately.
    const split = applyCommissionRuleToGross(100, effective[0]);
    assert.equal(split.ok, true);
    assert.equal(split.clientCommission, "60.0000");
    assert.equal(split.mboCommission, "40.0000");

    // Finance/commercial runtime resolves it immediately (preset rules carry no agreement lineage,
    // so lineage enforcement is switched off here to isolate rule selection + calculation).
    const runtime = new ClientCommercialRuntimeService({ commissionRepo: effectiveRuleRepo(s.state) });
    const result = await runtime.evaluate({
      assignmentId: "a1",
      attributionResolved: true,
      attributionStatus: "ATTRIBUTED",
      networkActualCommission: 100,
      networkActualCurrency: "USD",
      requireAgreementLineage: false,
    });
    assert.equal(result.status, "CALCULATED");
    assert.equal(result.matchedClientCommissionRuleId, effective[0].id);
    assert.equal(result.clientPayable, 60);
    assert.equal(result.mboMargin, 40);
  });

  it("7. same share re-applied: no duplicate rule, EFFECTIVE row untouched (Decimal '70' vs preset '70.0000')", async () => {
    const s = store({
      assignments: [{ id: "a1" }],
      rules: [rule("old-70", "a1", 70, "EFFECTIVE")],
    });
    assert.equal(String(s.state.rules[0].clientCommission), "70", "fixture mirrors Prisma Decimal String() form");

    await s.service.setCommercialModel(CLIENT_ID, {
      commercialModel: "OFFERS_PLUS_COMMISSION",
      clientSharePercent: 70,
    });

    assert.equal(s.rulesFor("a1").length, 1);
    assert.equal(s.rulesFor("a1")[0].status, "EFFECTIVE");
    assert.equal(s.rulesFor("a1")[0].id, "old-70");
    assert.equal(s.calls.ruleCreates, 0);
    assert.equal(s.calls.ruleUpdates, 0);
  });

  it("8. DRAFT assignment: share change updates the DRAFT in place and does not activate it", async () => {
    const s = store({
      assignments: [{ id: "a1" }],
      rules: [rule("draft-70", "a1", 70, "DRAFT")],
    });

    await s.service.setCommercialModel(CLIENT_ID, {
      commercialModel: "OFFERS_PLUS_COMMISSION",
      clientSharePercent: 60,
    });

    const rows = s.rulesFor("a1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "draft-70");
    assert.equal(rows[0].status, "DRAFT");
    assertSplit(rows[0], 60);
    assert.equal(s.calls.ruleCreates, 0);
  });

  it("9. many non-revoked assignments: every previously EFFECTIVE one is EFFECTIVE with the new split; revoked untouched; no page cap", async () => {
    const assignments = [{ id: "a1" }, { id: "a2" }, { id: "a3" }, { id: "a4", status: "REVOKED" }];
    const rules = [
      rule("e1", "a1", 70, "EFFECTIVE"),
      rule("e2", "a2", 70, "EFFECTIVE"),
      rule("d3", "a3", 70, "DRAFT"),
      rule("e4", "a4", 70, "EFFECTIVE"),
    ];
    // 600 further EFFECTIVE assignments: more than the old take:500 page.
    for (let i = 0; i < 600; i += 1) {
      const id = `bulk-${String(i).padStart(3, "0")}`;
      assignments.push({ id, createdAt: new Date(2026, 7, 2, 0, 0, i) });
      rules.push(rule(`eff-${id}`, id, 70, "EFFECTIVE"));
    }
    const s = store({ assignments, rules });

    await s.service.setCommercialModel(CLIENT_ID, {
      commercialModel: "OFFERS_PLUS_COMMISSION",
      clientSharePercent: 60,
    });

    for (const id of ["a1", "a2", ...assignments.filter((a) => a.id.startsWith("bulk-")).map((a) => a.id)]) {
      const effective = s.rulesFor(id, "EFFECTIVE");
      assert.equal(effective.length, 1, `${id} must have exactly one EFFECTIVE rule`);
      assertSplit(effective[0], 60);
      assert.equal(s.rulesFor(id, "SUPERSEDED").length, 1, `${id} keeps its superseded 70% history`);
      assert.equal(s.rulesFor(id, "DRAFT").length, 0, `${id} has no DRAFT gap`);
    }
    assert.equal(s.rulesFor("a3").length, 1);
    assert.equal(s.rulesFor("a3")[0].status, "DRAFT");
    assertSplit(s.rulesFor("a3")[0], 60);

    const revoked = s.rulesFor("a4");
    assert.equal(revoked.length, 1);
    assert.equal(revoked[0].status, "EFFECTIVE");
    assertSplit(revoked[0], 70);

    assert.equal(s.calls.txStarted, 1, "one transaction covers the whole change");
    assert.equal(s.calls.ruleCreates, 602);
  });

  it("10. failure mid-update rolls back: client share and every rule are exactly as before", async () => {
    const s = store({
      assignments: [{ id: "a1" }, { id: "a2" }],
      rules: [rule("e1", "a1", 70, "EFFECTIVE"), rule("e2", "a2", 70, "EFFECTIVE")],
      failOnCreateForAssignment: "a2",
    });

    await assert.rejects(
      s.service.setCommercialModel(CLIENT_ID, {
        commercialModel: "OFFERS_PLUS_COMMISSION",
        clientSharePercent: 60,
      }),
      /simulated failure creating rule for a2/,
    );

    assert.equal(Number(s.state.client.clientSharePercent), 70, "client share not changed");
    assert.equal(s.state.client.commercialModel, "OFFERS_PLUS_COMMISSION");
    assert.equal(s.state.rules.length, 2, "no rule rows added");
    for (const id of ["e1", "e2"]) {
      const row = s.state.rules.find((r) => r.id === id);
      assert.equal(row.status, "EFFECTIVE", `${id} still EFFECTIVE`);
      assert.equal(row.effectiveUntil, null);
      assertSplit(row, 70);
    }
    assert.deepEqual(
      { started: s.calls.txStarted, committed: s.calls.txCommitted, rolledBack: s.calls.txRolledBack },
      { started: 1, committed: 0, rolledBack: 1 },
    );
    // a1 had been superseded and re-created before a2 failed, proving the rollback undid real work.
    assert.ok(s.calls.ruleCreates >= 2, "the failure happened after at least one successful create");
  });

  it("rejects an out-of-range share before touching anything", async () => {
    const s = store({ assignments: [{ id: "a1" }], rules: [rule("e1", "a1", 70, "EFFECTIVE")] });
    await assert.rejects(
      s.service.setCommercialModel(CLIENT_ID, { commercialModel: "OFFERS_PLUS_COMMISSION", clientSharePercent: 140 }),
      /between 0 and 100/,
    );
    assert.equal(s.calls.txStarted, 0);
    assert.equal(s.state.rules[0].status, "EFFECTIVE");
  });
});

describe("ensureCommissionRuleDraft — provisioning paths keep their DRAFT contract", () => {
  it("without activateReplacement an EFFECTIVE rule with another split is superseded and the replacement stays DRAFT", async () => {
    const s = store({ assignments: [{ id: "a1" }], rules: [rule("e1", "a1", 70, "EFFECTIVE")] });
    const db = {
      clientCommissionRule: {
        findFirst: async (args) => s.rulesFor("a1").filter((r) => args.where.status.in.includes(r.status)).sort((x, y) => (x.status < y.status ? 1 : -1))[0] ?? null,
        update: async ({ where, data }) => {
          const idx = s.state.rules.findIndex((r) => r.id === where.id);
          s.state.rules[idx] = { ...s.state.rules[idx], ...decimalise(data) };
          return s.state.rules[idx];
        },
        create: async ({ data }) => {
          const row = { id: "replacement", ...decimalise(data) };
          s.state.rules.push(row);
          return row;
        },
      },
    };

    const created = await s.service.ensureCommissionRuleDraft("a1", "OFFERS_PLUS_COMMISSION", db, {
      clientSharePercent: 60,
    });

    assert.equal(created.status, "DRAFT");
    assertSplit(created, 60);
    assert.equal(s.state.rules.find((r) => r.id === "e1").status, "SUPERSEDED");
  });

  it("recognises an unchanged split on a Prisma Decimal row (String() is '70', preset is '70.0000')", async () => {
    const s = store({ assignments: [{ id: "a1" }], rules: [rule("e1", "a1", 70, "EFFECTIVE")] });
    let created = 0;
    const db = {
      clientCommissionRule: {
        findFirst: async () => s.state.rules[0],
        update: async () => assert.fail("must not update an unchanged rule"),
        create: async () => {
          created += 1;
          return {};
        },
      },
    };
    const result = await s.service.ensureCommissionRuleDraft("a1", "OFFERS_PLUS_COMMISSION", db, {
      clientSharePercent: 70,
    });
    assert.equal(result.id, "e1");
    assert.equal(created, 0);
  });
});
