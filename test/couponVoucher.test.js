import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enrichCouponVoucherRecord,
  inferDiscountType,
  toCouponVoucherDto,
} from "../src/modules/coupons/couponVoucher.contract.js";
import {
  collectEmbeddedCouponsFromCampaigns,
  extractEmbeddedCouponsFromCampaignRaw,
} from "../src/modules/coupons/couponVoucherFanOut.js";
import { mapEntityToSupplierCoupon } from "../src/modules/supplier/mappers/index.js";

describe("coupon / voucher (pointer 10)", () => {
  it("fans out 20 embedded vouchers into 20 individual coupon payloads", () => {
    const vouchers = Array.from({ length: 20 }, (_, i) => ({
      voucher_code_id: `vc-${i + 1}`,
      voucher_code: `SAVE${i + 1}`,
      title: `Offer ${i + 1}`,
      description: `${10 + i}% off`,
    }));

    const raw = { id: "camp-99", campaignId: "camp-99", vouchers };
    const extracted = extractEmbeddedCouponsFromCampaignRaw(raw);
    assert.equal(extracted.length, 20);
    assert.equal(new Set(extracted.map((r) => r.voucher_code_id)).size, 20);
    assert.ok(extracted.every((r) => r._mboSourcePath === "vouchers"));
  });

  it("collectEmbeddedCouponsFromCampaigns merges multiple campaigns without concatenating codes", () => {
    const campaigns = [
      {
        rawData: {
          id: "c1",
          coupons: [{ id: "a1", code: "A" }, { id: "a2", code: "B" }],
        },
      },
      {
        rawData: {
          id: "c2",
          coupons: [{ id: "b1", code: "C" }],
        },
      },
    ];
    const all = collectEmbeddedCouponsFromCampaigns(campaigns);
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((r) => r.code).sort(), ["A", "B", "C"]);
  });

  it("enrichCouponVoucherRecord adds title, promotion, mapping, and source metadata", () => {
    const entity = {
      id: "ent-1",
      networkSource: "optimise_sea",
      entityType: "coupon",
      rawData: {
        title: "Summer Sale",
        promotion_description: "20% off sitewide",
        discount: "20%",
        country_code: "SG",
        _mboSourcePath: "voucher_codes",
      },
    };
    const base = {
      couponCode: "SUMMER20",
      couponLink: null,
      couponDescription: "legacy desc",
      mapperVersion: "OPT-VC-1",
    };
    const enriched = enrichCouponVoucherRecord(base, entity);
    assert.equal(enriched.title, "Summer Sale");
    assert.equal(enriched.promotionDescription, "20% off sitewide");
    assert.equal(enriched.discountType, "PERCENT");
    assert.equal(enriched.country, "SG");
    assert.equal(enriched.networkSource, "optimise_sea");
    assert.equal(enriched.sourcePath, "voucher_codes");
    assert.equal(enriched.mappingStatus, "MAPPED");
    assert.equal(enriched.fieldMappingOutcome, "MAPPED");
  });

  it("inferDiscountType handles percent and fixed values", () => {
    assert.equal(inferDiscountType({ discount: "15%" }), "PERCENT");
    assert.equal(inferDiscountType({ discount_value: "10.00" }), "FIXED");
    assert.equal(inferDiscountType({ discountType: "flat" }), "FLAT");
  });

  it("mapEntityToSupplierCoupon enriches mapped coupon entities", () => {
    const entity = {
      id: "ent-2",
      entityType: "coupon",
      networkSource: "trackier_global",
      externalId: "trackier-coupon-42",
      rawData: {
        id: "42",
        code: "TRACK10",
        title: "Trackier Promo",
        campaign_id: "9001",
        record_source: "coupon",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const mapped = mapEntityToSupplierCoupon(entity);
    assert.equal(mapped.couponCode, "TRACK10");
    assert.equal(mapped.title, "Trackier Promo");
    assert.equal(mapped.networkSource, "trackier_global");
    assert.equal(mapped.mappingStatus, "MAPPED");
  });

  it("toCouponVoucherDto exposes one row per coupon with campaign join", () => {
    const dto = toCouponVoucherDto({
      id: "sc-1",
      networkSource: "boostiny_global",
      supplierCouponId: "b-1",
      couponCode: "BOOST5",
      title: "Boost Deal",
      promotionDescription: "5% back",
      mappingStatus: "MAPPED",
      fieldMappingOutcome: "MAPPED",
      mapperVersion: "1",
      supplierCampaign: {
        id: "camp-db-1",
        supplierCampaignId: "123",
        campaignName: "Boost Brand",
      },
    });
    assert.equal(dto.couponCode, "BOOST5");
    assert.equal(dto.title, "Boost Deal");
    assert.equal(dto.campaign.campaignName, "Boost Brand");
    assert.notEqual(typeof dto.couponCode, "object");
  });
});
