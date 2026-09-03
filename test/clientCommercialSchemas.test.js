import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCommissionRuleBodySchema } from "../src/modules/commercial/validators/schemas.js";

const lineage = {
  agreementRef: "IO-2026-001",
  agreementApprovedAt: "2026-08-01T00:00:00.000Z",
  agreementApprovedBy: "commercial-admin",
};

describe("client commercial API schemas", () => {
  it("allows an activated persisted TIERED rule when tier and agreement lineage are complete", () => {
    const parsed = createCommissionRuleBodySchema.parse({
      assignmentId: "assignment-1",
      commissionType: "TIERED",
      currency: "INR",
      tierMetric: "ORDER_COUNT",
      tierPeriod: "MONTHLY",
      tiers: [
        {
          minInclusive: 0,
          maxExclusive: 100,
          payoutType: "PERCENT_OF_SUPPLIER_COMMISSION",
          sharePercent: 50,
        },
        {
          minInclusive: 100,
          payoutType: "PERCENT_OF_SUPPLIER_COMMISSION",
          sharePercent: 70,
        },
      ],
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      activate: true,
      ...lineage,
    });

    assert.equal(parsed.commissionType, "TIERED");
    assert.equal(parsed.tiers.length, 2);
    assert.equal(parsed.activate, true);
  });

  it("rejects activation without agreement/IO/SOW approval lineage", () => {
    const result = createCommissionRuleBodySchema.safeParse({
      assignmentId: "assignment-1",
      grossCommission: 100,
      clientCommission: 70,
      commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      activate: true,
    });

    assert.equal(result.success, false);
    const paths = result.error.issues.map((issue) => issue.path[0]);
    assert.ok(paths.includes("agreementRef"));
    assert.ok(paths.includes("agreementApprovedAt"));
    assert.ok(paths.includes("agreementApprovedBy"));
  });

  it("rejects incomplete subsidy approval metadata", () => {
    const result = createCommissionRuleBodySchema.safeParse({
      assignmentId: "assignment-1",
      grossCommission: 100,
      clientCommission: 70,
      commissionType: "PERCENT_OF_ACTUAL_SUPPLIER_COMMISSION",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      subsidyApproved: true,
      subsidyApprovalRef: "SUB-1",
      ...lineage,
    });

    assert.equal(result.success, false);
    assert.ok(result.error.issues.some((issue) => issue.path[0] === "subsidyApproved"));
  });

  it("rejects invalid or empty tier configuration", () => {
    const result = createCommissionRuleBodySchema.safeParse({
      assignmentId: "assignment-1",
      commissionType: "TIERED",
      tierMetric: "ORDER_COUNT",
      tierPeriod: "MONTHLY",
      tiers: [],
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      ...lineage,
    });

    assert.equal(result.success, false);
    assert.ok(result.error.issues.some((issue) => issue.path[0] === "tiers"));
  });

  it("rejects a manual approval boolean without explicit approval date and approver", () => {
    const result = createCommissionRuleBodySchema.safeParse({
      assignmentId: "assignment-1",
      commissionType: "MANUAL_APPROVED_CLIENT_COMMISSION",
      manualAmount: 50,
      manualApproved: true,
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      activate: true,
      ...lineage,
    });

    assert.equal(result.success, false);
    assert.ok(result.error.issues.some((issue) => issue.path[0] === "manualApproved"));
  });

  it("accepts manual activation only with explicit approval evidence and commercial lineage", () => {
    const parsed = createCommissionRuleBodySchema.parse({
      assignmentId: "assignment-1",
      commissionType: "MANUAL_APPROVED_CLIENT_COMMISSION",
      manualAmount: 50,
      manualApproved: true,
      manualApprovedAt: "2026-08-20T10:30:00.000Z",
      manualApprovedBy: "finance-admin",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      activate: true,
      ...lineage,
    });

    assert.equal(parsed.manualApproved, true);
    assert.equal(parsed.manualApprovedBy, "finance-admin");
    assert.ok(parsed.manualApprovedAt instanceof Date);
  });
});
