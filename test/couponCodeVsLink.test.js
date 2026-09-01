import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCouponUrlValue,
  resolveCouponCode,
  resolveCouponLink,
  resolveCouponCodeType,
} from "../src/modules/coupons/codeType.js";
import { mapOptimiseCoupon } from "../src/modules/supplier/mappers/optimise.mapper.js";
import { toCouponPoolDto } from "../src/modules/networkPortal/networkPortal.dto.js";

describe("coupon code vs link extraction", () => {
  it("never treats redeem URLs as coupon codes", () => {
    const raw = {
      code: "",
      deepLinkURL: "https://www.atlys.com/en-AE/redeem?partner=assembly&token=abc",
      exclusive: false,
    };
    assert.equal(resolveCouponCode(raw), null);
    assert.equal(resolveCouponLink(raw), raw.deepLinkURL);
    assert.equal(resolveCouponCodeType(raw, "optimise_mena"), "Link");
    assert.equal(isCouponUrlValue(raw.deepLinkURL), true);
  });

  it("keeps real Optimise voucher codes", () => {
    const raw = { code: "MP1543", deepLinkURL: "", exclusive: true };
    assert.equal(resolveCouponCode(raw), "MP1543");
    assert.equal(resolveCouponCodeType(raw, "optimise"), "Coupon");
  });

  it("mapOptimiseCoupon classifies Atlys-style empty code + deep link as LINK", () => {
    const mapped = mapOptimiseCoupon({
      id: "e1",
      networkSource: "optimise_mena",
      externalId: "optimise_mena:default:257864",
      code: "https://www.atlys.com/en-AE/redeem?token=x",
      entityName: "https://www.atlys.com/en-AE/redeem?token=x",
      rawData: {
        id: 257864,
        code: "",
        deepLinkURL: "https://www.atlys.com/en-AE/redeem?token=x",
        campaignId: 7301164,
        productId: 56843,
        exclusive: false,
      },
    });
    assert.equal(mapped.couponCode, null);
    assert.equal(mapped.couponType, "LINK");
    assert.match(String(mapped.couponLink), /^https:\/\//);
  });

  it("toCouponPoolDto blanks URL couponCode and exposes couponLink", () => {
    const dto = toCouponPoolDto({
      id: "ccm-1",
      supplier: "OPTIMISE",
      couponCode: "https://www.atlys.com/redeem?token=1",
      source: "NETWORK_API",
      scope: "UNKNOWN",
      totalQuantity: null,
      assignedQuantity: 0,
      status: "ACTIVE",
      newCodeAlert: true,
      detectedAt: new Date("2026-08-01"),
      lastUpdatedAt: new Date("2026-08-02"),
      supplierCampaign: {
        campaignName: "CPS",
        merchantNameRaw: "Atlys",
        merchant: { displayName: "Atlys" },
      },
      supplierCoupon: {
        couponLink: "https://www.atlys.com/redeem?token=1",
        rawPayload: { companyName: "Atlys", campaignName: "CPS" },
      },
    });
    assert.equal(dto.couponCode, null);
    assert.equal(dto.couponLink, "https://www.atlys.com/redeem?token=1");
    assert.equal(dto.brandName, "Atlys");
    assert.equal(dto.campaignName, "CPS");
    assert.equal(dto.totalQuantity, null);
    assert.equal(dto.remainingQuantity, null);
  });
});
