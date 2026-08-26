import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PERMISSIONS } from "../src/auth/permissions.js";
import { applyCommissionRuleAccess } from "../src/auth/commercialDataAccess.js";

describe("commercialDataAccess", () => {
  it("masks commission fields without commission:read", () => {
    const masked = applyCommissionRuleAccess(
      {
        id: "r1",
        assignmentId: "a1",
        grossCommission: "10.0000",
        clientCommission: "7.0000",
        mboCommission: "3.0000",
        commissionType: "PERCENT",
        currency: "USD",
        effectiveFrom: new Date(),
        effectiveUntil: null,
        status: "EFFECTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      [],
    );

    assert.equal(masked.grossCommission, undefined);
    assert.equal(masked.clientCommission, undefined);
    assert.equal(masked.mboCommission, undefined);
  });

  it("shows commission fields with commission:read", () => {
    const dto = applyCommissionRuleAccess(
      {
        id: "r1",
        assignmentId: "a1",
        grossCommission: "10.0000",
        clientCommission: "7.0000",
        mboCommission: "3.0000",
        commissionType: "PERCENT",
        currency: "USD",
        effectiveFrom: new Date(),
        effectiveUntil: null,
        status: "EFFECTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      [PERMISSIONS.COMMISSION_READ],
    );

    assert.equal(dto.grossCommission, "10.0000");
    assert.equal(dto.mboCommission, "3.0000");
  });
});
