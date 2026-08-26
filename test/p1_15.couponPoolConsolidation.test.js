import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toCouponPoolDto, deriveCouponRemainingQuantity } from "../src/modules/networkPortal/networkPortal.dto.js";

describe("Coupon pool consolidation — CouponCodeMaster DTO", () => {
  it("maps network, campaign source, brand/campaign, code, source, scope", () => {
    const dto = toCouponPoolDto({
      id: "ccm-1",
      supplier: "PARTNERIZE",
      sourceAccountLabel: "main",
      campaignSourceId: "cs-abc",
      supplierCampaignId: "sc-row",
      supplierCouponId: "sup-c-1",
      supplierCouponExtId: "ext-99",
      couponCode: "SAVE10",
      source: "NETWORK_API",
      scope: "SHARED_LIMITED",
      totalQuantity: 100,
      assignedQuantity: 12,
      status: "ACTIVE",
      validFrom: new Date("2026-01-01"),
      validUntil: new Date("2026-12-31"),
      newCodeAlert: true,
      detectedAt: new Date("2026-08-01T10:00:00Z"),
      lastUpdatedAt: new Date("2026-08-10T12:00:00Z"),
      rawPayloadId: "raw-1",
      supplierCampaign: {
        supplierCampaignId: "SUP-CAM-1",
        campaignName: "Travel CPS",
        merchantNameRaw: "Klook",
        merchant: { displayName: "Klook" },
      },
    });

    assert.equal(dto.network, "PARTNERIZE");
    assert.equal(dto.campaignSourceId, "cs-abc");
    assert.equal(dto.brandName, "Klook");
    assert.equal(dto.campaignName, "Travel CPS");
    assert.equal(dto.couponCode, "SAVE10");
    assert.equal(dto.couponType, "CODE");
    assert.equal(dto.source, "NETWORK_API");
    assert.equal(dto.scope, "SHARED_LIMITED");
    assert.equal(dto.totalQuantity, 100);
    assert.equal(dto.assignedQuantity, 12);
    assert.equal(dto.remainingQuantity, 88);
    assert.equal(dto.status, "ACTIVE");
    assert.equal(dto.validFrom, "2026-01-01");
    assert.equal(dto.validUntil, "2026-12-31");
    assert.equal(dto.newCodeAlert, true);
    assert.ok(dto.detectedAt);
    assert.ok(dto.lastUpdatedAt);
    assert.equal(dto.rawPayloadId, "raw-1");
    assert.equal(dto.supplierCouponId, "sup-c-1");
  });

  it("prefers live ClientCouponAssignment count for assigned", () => {
    const dto = toCouponPoolDto(
      {
        id: "ccm-2",
        supplier: "TRACKIER",
        couponCode: "X",
        source: "NETWORK_API",
        scope: "UNKNOWN",
        totalQuantity: 50,
        assignedQuantity: 99,
        status: "ACTIVE",
        newCodeAlert: false,
        detectedAt: new Date("2026-07-01"),
        lastUpdatedAt: new Date("2026-07-02"),
      },
      { assignmentCount: 3 },
    );
    assert.equal(dto.assignedQuantity, 3);
    assert.equal(dto.remainingQuantity, 47);
  });

  it("never returns negative remaining", () => {
    assert.equal(deriveCouponRemainingQuantity(5, 9), 0);
    const dto = toCouponPoolDto(
      {
        id: "ccm-3",
        supplier: "OPTIMISE",
        couponCode: "Y",
        source: "MANUAL",
        scope: "UNIQUE_TO_CLIENT",
        totalQuantity: 2,
        assignedQuantity: 0,
        status: "ACTIVE",
        newCodeAlert: false,
        detectedAt: new Date(),
        lastUpdatedAt: new Date(),
      },
      { assignmentCount: 10 },
    );
    assert.equal(dto.remainingQuantity, 0);
  });

  it("leaves total/remaining null when inventory unknown (no invention)", () => {
    const dto = toCouponPoolDto({
      id: "ccm-4",
      supplier: "BOOSTINY",
      couponCode: "Z",
      source: "NETWORK_API",
      scope: "UNKNOWN",
      totalQuantity: null,
      assignedQuantity: 0,
      status: "UNKNOWN",
      newCodeAlert: false,
      detectedAt: new Date("2026-06-01"),
      lastUpdatedAt: new Date("2026-06-02"),
    });
    assert.equal(dto.totalQuantity, null);
    assert.equal(dto.remainingQuantity, null);
    assert.equal(dto.validFrom, null);
    assert.equal(dto.validUntil, null);
  });

  it("does not invent coupon code when absent", () => {
    const dto = toCouponPoolDto({
      id: "ccm-5",
      supplier: "PARTNERIZE",
      couponCode: null,
      source: "NETWORK_API",
      scope: "UNKNOWN",
      totalQuantity: null,
      assignedQuantity: 0,
      status: "DISABLED",
      newCodeAlert: false,
      detectedAt: new Date("2026-05-01"),
      lastUpdatedAt: new Date("2026-05-02"),
    });
    assert.equal(dto.couponCode, null);
    assert.equal(dto.status, "DISABLED");
  });

  it("does not invent timestamps — uses provided dates only", () => {
    const detected = new Date("2026-01-15T08:00:00Z");
    const updated = new Date("2026-01-16T09:00:00Z");
    const dto = toCouponPoolDto({
      id: "ccm-6",
      supplier: "TRACKIER",
      couponCode: "ABC",
      source: "NETWORK_API",
      scope: "SHARED_LIMITED",
      totalQuantity: 1,
      assignedQuantity: 0,
      status: "EXPIRED",
      newCodeAlert: false,
      detectedAt: detected,
      lastUpdatedAt: updated,
    });
    assert.equal(dto.detectedAt, detected.toISOString());
    assert.equal(dto.lastUpdatedAt, updated.toISOString());
    assert.equal(dto.status, "EXPIRED");
  });
});
