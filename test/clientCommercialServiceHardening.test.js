import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommercialService } from "../src/modules/commercial/services/commercial.service.js";

function activeAssignment() {
  return {
    id: "assignment-1",
    status: "ACTIVE",
    published: true,
    canonicalCampaign: { defaultCurrency: "INR" },
  };
}

function serviceWith({ overlapping = [], existingRule = null } = {}) {
  const calls = { creates: [], updates: [], overlaps: [] };
  const commissionRepo = {
    async findOverlappingEffective(...args) {
      calls.overlaps.push(args);
      return overlapping;
    },
    async create(data) {
      calls.creates.push(data);
      return { id: "created", ...data };
    },
    async update(id, data) {
      calls.updates.push({ id, data });
      return { id, ...(existingRule || {}), ...data };
    },
    async findById() {
      return existingRule;
    },
  };
  const assignmentRepo = {
    async findById() {
      return activeAssignment();
    },
  };
  return {
    calls,
    service: new CommercialService({ commissionRepo, assignmentRepo }),
  };
}

const lineage = {
  agreementRef: "IO-2026-001",
  agreementApprovedAt: new Date("2026-08-01T00:00:00Z"),
  agreementApprovedBy: "commercial-admin",
};

describe("Client Commercial service hardening", () => {
  it("allows different conditional rules to coexist without broad supersede", async () => {
    const { service, calls } = serviceWith({
      overlapping: [{
        id: "existing-ae",
        effectiveFrom: new Date("2026-08-01T00:00:00Z"),
        conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "AE" }],
      }],
    });

    await service.createCommissionRule({
      assignmentId: "assignment-1",
      grossCommission: 100,
      clientCommission: 70,
      commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
      effectiveFrom: new Date("2026-09-01T00:00:00Z"),
      activate: true,
      conditions: [{ conditionType: "COUNTRY", operator: "EQ", value: "IN" }],
      ...lineage,
    }, {});

    assert.equal(calls.creates.length, 1);
    assert.equal(calls.updates.length, 0);
  });

  it("treats IN condition values as set-like for same-lineage successor matching", async () => {
    const { service, calls } = serviceWith({
      overlapping: [{
        id: "existing-country-set",
        effectiveFrom: new Date("2026-08-01T00:00:00Z"),
        conditions: [{ conditionType: "COUNTRY", operator: "IN", value: ["AE", "IN"] }],
      }],
    });

    await service.createCommissionRule({
      assignmentId: "assignment-1",
      grossCommission: 100,
      clientCommission: 75,
      commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
      effectiveFrom: new Date("2026-09-01T00:00:00Z"),
      activate: true,
      conditions: [{ conditionType: "COUNTRY", operator: "IN", value: ["IN", "AE"] }],
      ...lineage,
    }, {});

    assert.deepEqual(calls.updates, [{
      id: "existing-country-set",
      data: {
        status: "SUPERSEDED",
        effectiveUntil: new Date("2026-09-01T00:00:00Z"),
      },
    }]);
  });

  it("rejects same-lineage overlap that starts at the same boundary", async () => {
    const { service } = serviceWith({
      overlapping: [{
        id: "existing",
        effectiveFrom: new Date("2026-09-01T00:00:00Z"),
        conditions: [],
      }],
    });

    await assert.rejects(
      () => service.createCommissionRule({
        assignmentId: "assignment-1",
        grossCommission: 100,
        clientCommission: 70,
        commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
        effectiveFrom: new Date("2026-09-01T00:00:00Z"),
        activate: true,
        conditions: [],
        ...lineage,
      }, {}),
      /overlapping client commercial rule/i,
    );
  });

  it("requires explicit manual approval timestamp and approver before activation", async () => {
    const { service } = serviceWith();

    await assert.rejects(
      () => service.createCommissionRule({
        assignmentId: "assignment-1",
        commissionType: "MANUAL_APPROVED_CLIENT_COMMISSION",
        manualAmount: 50,
        manualApproved: true,
        effectiveFrom: new Date("2026-09-01T00:00:00Z"),
        activate: true,
        ...lineage,
      }, {}),
      /explicit approval evidence/i,
    );
  });

  it("persists the supplied manual approval evidence instead of inventing a timestamp", async () => {
    const { service, calls } = serviceWith();
    const approvedAt = new Date("2026-08-20T10:30:00Z");

    await service.createCommissionRule({
      assignmentId: "assignment-1",
      commissionType: "MANUAL_APPROVED_CLIENT_COMMISSION",
      manualAmount: 50,
      manualApproved: true,
      manualApprovedAt: approvedAt,
      manualApprovedBy: "finance-admin",
      effectiveFrom: new Date("2026-09-01T00:00:00Z"),
      activate: true,
      ...lineage,
    }, {});

    assert.equal(calls.creates[0].manualApprovedAt, approvedAt);
    assert.equal(calls.creates[0].manualApprovedBy, "finance-admin");
  });
});
