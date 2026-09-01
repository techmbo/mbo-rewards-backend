import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PERMISSIONS } from "../src/auth/permissions.js";
import {
  applyMapperErrorAccess,
  applySupplierCampaignAccess,
  applySupplierCouponAccess,
} from "../src/auth/supplierDataAccess.js";

const sampleCampaign = {
  id: "camp-1",
  campaignName: "Test",
  defaultCommissionValue: "12.5",
  commissionCurrency: "USD",
  commissionGroups: { tier: 1 },
  rawPayload: { secret: "token" },
  normalizedPayload: { name: "Test" },
  entityId: "entity-1",
  supplierRefId: "sup-ref",
  mapperVersion: "1.1.0",
};

describe("supplierDataAccess", () => {
  it("masks commission fields without COMMISSION_READ", () => {
    const analyst = [PERMISSIONS.CAMPAIGNS_READ];
    const masked = applySupplierCampaignAccess(sampleCampaign, analyst);

    assert.equal(masked.defaultCommissionValue, undefined);
    assert.equal(masked.commissionCurrency, undefined);
    assert.equal(masked.commissionGroups, undefined);
    assert.equal(masked.campaignName, "Test");
  });

  it("shows commission fields with COMMISSION_READ", () => {
    const ops = [PERMISSIONS.CAMPAIGNS_READ, PERMISSIONS.COMMISSION_READ];
    const dto = applySupplierCampaignAccess(sampleCampaign, ops);

    assert.equal(dto.defaultCommissionValue, "12.5");
    assert.equal(dto.commissionCurrency, "USD");
  });

  it("hides payloads unless includePayloads and SYSTEM_READ", () => {
    const tech = [PERMISSIONS.CAMPAIGNS_READ, PERMISSIONS.SYSTEM_READ];
    const hidden = applySupplierCampaignAccess(sampleCampaign, tech, { includePayloads: false });
    const shown = applySupplierCampaignAccess(sampleCampaign, tech, { includePayloads: true });

    assert.equal(hidden.rawPayload, undefined);
    assert.equal(shown.rawPayload.secret, "token");
  });

  it("hides mapper error stack traces without SYSTEM_READ", () => {
    const error = { id: "err-1", message: "fail", stackTrace: "Error: fail\n at x" };
    const masked = applyMapperErrorAccess(error, [PERMISSIONS.CAMPAIGNS_READ]);
    assert.equal(masked.stackTrace, undefined);
  });

  it("masks nested campaign summary on coupons", () => {
    const coupon = {
      id: "coupon-1",
      couponCode: "SAVE10",
      supplierCampaign: {
        id: "camp-1",
        campaignName: "Parent",
        defaultCommissionValue: "9",
        rawPayload: { hidden: true },
      },
    };

    const masked = applySupplierCouponAccess(coupon, [PERMISSIONS.COUPONS_READ]);
    assert.equal(masked.supplierCampaign.defaultCommissionValue, undefined);
    assert.equal(masked.supplierCampaign.rawPayload, undefined);
  });
});
