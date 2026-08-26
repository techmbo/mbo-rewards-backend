import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyConversionAccess, applyDailyReportAccess } from "../src/auth/reportingDataAccess.js";
import { PERMISSIONS } from "../src/auth/permissions.js";

describe("reportingDataAccess", () => {
  it("masks conversion commission fields without commission:read", () => {
    const dto = applyConversionAccess(
      {
        id: "cv1",
        supplierCommission: "10.0000",
        approvedCommission: "10.0000",
        clientCommission: "7.0000",
        mboCommission: "3.0000",
        status: "APPROVED",
        attributionStatus: "ATTRIBUTED",
        conversionDate: new Date(),
      },
      [PERMISSIONS.CONVERSIONS_READ],
    );

    assert.equal(dto.supplierCommission, undefined);
    assert.equal(dto.clientCommission, undefined);
    assert.equal(dto.mboCommission, undefined);
  });

  it("exposes commission fields with commission:read", () => {
    const dto = applyConversionAccess(
      {
        id: "cv1",
        supplierCommission: "10.0000",
        clientCommission: "7.0000",
        mboCommission: "3.0000",
        status: "APPROVED",
        attributionStatus: "ATTRIBUTED",
        conversionDate: new Date(),
      },
      [PERMISSIONS.COMMISSION_READ],
    );

    assert.equal(dto.clientCommission, "7.0000");
    assert.equal(dto.mboCommission, "3.0000");
  });

  it("masks daily report commission metrics", () => {
    const dto = applyDailyReportAccess(
      {
        id: "dr1",
        clickCount: 10,
        grossCommission: "50.0000",
        clientCommission: "35.0000",
        mboCommission: "15.0000",
        epc: "5.0000",
      },
      [PERMISSIONS.PERFORMANCE_READ],
    );

    assert.equal(dto.grossCommission, undefined);
    assert.equal(dto.epc, undefined);
    assert.equal(dto.clickCount, 10);
  });
});
