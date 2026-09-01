/**
 * Pointer 13 — PerformanceRecord contract tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANTI_FABRICATION_METRICS,
  collectSourceOnlyFields,
  extractPerformanceCouponCode,
  hydratePerformanceRecordFact,
  normalizeCustomerType,
  resolvePerformanceChannelType,
  resolvePerformanceCustomerType,
  resolvePerformanceDevicePlatform,
  resolvePerformanceEpc,
  resolvePerformanceImpressions,
} from "../src/modules/networkPortal/performanceRecord.contract.js";
import {
  enrichFactsWithConversionCoupons,
  mapPerformanceRowToFactInput,
} from "../src/modules/networkPortal/networkPerformanceFact.ingestion.js";
import { hydrateNetworkPerformanceFact, toNetworkPerformanceDto } from "../src/modules/networkPortal/networkPortal.dto.js";

describe("Pointer 13 — PerformanceRecord contract", () => {
  it("never fabricates impressions, device, customer type, coupon, or EPC when absent", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-15",
        clicks: 42,
        orders: 3,
        campaign_name: "Test",
      },
      { networkSource: "boostiny" },
    );
    assert.equal(input.impressions, null);
    assert.equal(input.devicePlatform, null);
    assert.equal(input.customerType, null);
    assert.equal(input.couponCode, null);
    assert.equal(input.epc, null);
    assert.equal(input.mboLinkClicks, null);
  });

  it("maps explicit anti-fabrication metrics only from source fields", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-15",
        impressions: 1200,
        device: "mobile",
        customer_type: "returning",
        epc: 0.42,
        coupon_code: "SAVE10",
        clicks: 10,
      },
      { networkSource: "optimise_sea" },
    );
    assert.equal(input.impressions, 1200);
    assert.equal(input.devicePlatform, "mobile");
    assert.equal(input.customerType, "EXISTING");
    assert.equal(input.epc, 0.42);
    assert.equal(input.couponCode, "SAVE10");
  });

  it("collectSourceOnlyFields preserves extra network keys", () => {
    const sourceOnly = collectSourceOnlyFields({
      date: "2026-08-01",
      clicks: 5,
      publisher_segment: "gold",
      custom_metric: 99,
    });
    assert.deepEqual(sourceOnly, {
      publisher_segment: "gold",
      custom_metric: 99,
    });
  });

  it("stores source-only fields in performance metadata", () => {
    const input = mapPerformanceRowToFactInput(
      {
        date: "2026-08-01",
        clicks: 2,
        publisher_segment: "gold",
      },
      { networkSource: "trackier" },
    );
    assert.ok(input.metadata?.sourceOnly?.publisher_segment, "gold");
    assert.equal(input.metadata?.mboCanonicalObject, "PerformanceRecord");
  });

  it("hydratePerformanceRecordFact does not backfill metrics from campaign catalog", () => {
    const hydrated = hydratePerformanceRecordFact({
      impressions: null,
      devicePlatform: null,
      customerType: null,
      epc: null,
      couponCode: null,
      networkTrackingLink: null,
      campaignChannelType: "UNKNOWN",
      supplierCampaign: {
        campaignName: "Catalog Campaign",
        trackingUrl: "https://network.example/catalog-link",
        categoryName: "Retail",
        campaignType: "CPS",
        merchant: { displayName: "Catalog Brand" },
        campaignSources: [{ id: "src-1", isPrimary: true, supportsLink: true, supportsCoupon: true }],
        couponCodeMasters: [{ couponCode: "CAT10", id: "c1", source: "network", scope: "UNLIMITED" }],
      },
    });
    assert.equal(hydrated.brandName, "Catalog Brand");
    assert.equal(hydrated.campaignName, "Catalog Campaign");
    assert.equal(hydrated.impressions, null);
    assert.equal(hydrated.devicePlatform, null);
    assert.equal(hydrated.customerType, null);
    assert.equal(hydrated.epc, null);
    assert.equal(hydrated.couponCode, null);
    assert.equal(hydrated.couponId, null);
    assert.equal(hydrated.networkTrackingLink, null);
    assert.equal(hydrated.campaignChannelType, "UNKNOWN");
  });

  it("derive channel type from performance row evidence only", () => {
    assert.equal(
      resolvePerformanceChannelType({ coupon_code: "X", trackingUrl: "https://t.example/a" }),
      "COUPON_AND_LINK",
    );
    assert.equal(resolvePerformanceChannelType({ clicks: 1 }), "UNKNOWN");
  });

  it("normalizeCustomerType never invents labels", () => {
    assert.equal(normalizeCustomerType(null), null);
    assert.equal(normalizeCustomerType("returning"), "EXISTING");
    assert.equal(normalizeCustomerType("VIP"), "VIP");
  });

  it("extractPerformanceCouponCode rejects bare ISO-2 without code_id", () => {
    assert.equal(extractPerformanceCouponCode({ code: "SA" }), null);
    assert.equal(extractPerformanceCouponCode({ code: "AFM106", code_id: 1 }), "AFM106");
  });

  it("toNetworkPerformanceDto exposes PerformanceRecord + source-only fields", () => {
    const dto = toNetworkPerformanceDto({
      id: "fact-1",
      supplier: "BOOSTINY",
      sourceAccountLabel: "default",
      reportDate: new Date("2026-08-01T00:00:00.000Z"),
      networkClicks: 3,
      metadata: {
        sourceOnly: { publisher_segment: "gold" },
        mboCanonicalObject: "PerformanceRecord",
      },
    });
    assert.equal(dto.mboCanonicalObject, "PerformanceRecord");
    assert.deepEqual(dto.sourceOnlyFields, { publisher_segment: "gold" });
    assert.deepEqual(dto.sourceOnlyFieldNames, ["publisher_segment"]);
    assert.ok(Array.isArray(dto.antiFabricationMetrics));
    assert.ok(dto.antiFabricationMetrics.includes("impressions"));
  });

  it("hydrateNetworkPerformanceFact delegates to performance contract", () => {
    const out = hydrateNetworkPerformanceFact({
      campaignName: null,
      supplierCampaign: { campaignName: "From Catalog" },
    });
    assert.equal(out.campaignName, "From Catalog");
  });

  it("enrichFactsWithConversionCoupons is disabled (performance ≠ conversion)", async () => {
    const result = await enrichFactsWithConversionCoupons();
    assert.equal(result.skipped, true);
    assert.equal(result.updated, 0);
    assert.match(result.reason, /POINTER_13/);
  });

  it("lists anti-fabrication metrics", () => {
    assert.ok(ANTI_FABRICATION_METRICS.includes("epc"));
    assert.ok(ANTI_FABRICATION_METRICS.includes("devicePlatform"));
  });

  it("resolve helpers return null for missing source values", () => {
    assert.equal(resolvePerformanceImpressions({}), null);
    assert.equal(resolvePerformanceDevicePlatform({}), null);
    assert.equal(resolvePerformanceEpc({}), null);
    assert.equal(resolvePerformanceCustomerType({}), null);
  });
});
