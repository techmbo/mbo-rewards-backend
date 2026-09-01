import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCampaignCapabilities,
  buildCampaignCapabilityEntry,
  CAMPAIGN_CAPABILITY_STATE,
  formatCampaignCapabilitiesSummary,
  resolveCampaignCapabilityState,
} from "../src/modules/ops/campaignCapability.contract.js";
import { buildNetworkCampaignFields } from "../src/modules/ops/importedRecords.service.js";

describe("campaign capability (pointer 9)", () => {
  it("resolves all four capability states", () => {
    assert.equal(
      resolveCampaignCapabilityState({ signal: true, syncedCount: 3 }),
      CAMPAIGN_CAPABILITY_STATE.SUPPORTED,
    );
    assert.equal(
      resolveCampaignCapabilityState({ signal: true, syncedCount: 0 }),
      CAMPAIGN_CAPABILITY_STATE.SUPPORTED_DATA_NOT_SYNCED,
    );
    assert.equal(
      resolveCampaignCapabilityState({ explicitNotSupported: true }),
      CAMPAIGN_CAPABILITY_STATE.NOT_SUPPORTED,
    );
    assert.equal(
      resolveCampaignCapabilityState({ signal: null }),
      CAMPAIGN_CAPABILITY_STATE.UNKNOWN,
    );
  });

  it("never marks supported-but-empty as NOT_SUPPORTED", () => {
    const entry = buildCampaignCapabilityEntry({
      key: "coupon",
      label: "Coupon / Voucher",
      linkedRecordType: "CouponVoucher",
      signal: true,
      syncedCount: 0,
    });
    assert.equal(entry.state, CAMPAIGN_CAPABILITY_STATE.SUPPORTED_DATA_NOT_SYNCED);
    assert.notEqual(entry.state, CAMPAIGN_CAPABILITY_STATE.NOT_SUPPORTED);
  });

  it("builds structured capabilities with synced counts", () => {
    const caps = buildCampaignCapabilities({
      linkSignal: true,
      linkSyncedCount: 1,
      couponSignal: true,
      couponSyncedCount: 0,
      deeplinkSignal: false,
      feedSignal: true,
      feedSyncedCount: 2,
      commissionSignal: true,
      commissionSyncedCount: 4,
    });
    assert.equal(caps.trackingLink.state, CAMPAIGN_CAPABILITY_STATE.SUPPORTED);
    assert.equal(caps.coupon.state, CAMPAIGN_CAPABILITY_STATE.SUPPORTED_DATA_NOT_SYNCED);
    assert.equal(caps.deeplink.state, CAMPAIGN_CAPABILITY_STATE.NOT_SUPPORTED);
    assert.equal(caps.productFeed.syncedCount, 2);
    assert.equal(caps.commissionRules.syncedCount, 4);
  });

  it("formats capability summary for campaign list labels", () => {
    const summary = formatCampaignCapabilitiesSummary(
      buildCampaignCapabilities({
        couponSignal: true,
        couponSyncedCount: 0,
        linkSignal: true,
        linkSyncedCount: 1,
      }),
    );
    assert.ok(summary.includes("not synced"));
    assert.ok(summary.includes("Tracking Link"));
  });

  it("separates coupon capability signal from synced coupon records", () => {
    const fields = buildNetworkCampaignFields({
      entity: {
        entityType: "campaign",
        networkSource: "optimise_sea",
        rawData: {},
        rawPayloads: [],
        mapperErrors: [],
      },
      supplierCampaign: {
        campaignName: "Test",
        campaignSources: [{ id: "cs-1", relationshipStatus: "JOINED", supportsCoupon: true }],
        _count: { coupons: 0, supplierCommissionRules: 0 },
      },
      campaignSource: { id: "cs-1", relationshipStatus: "JOINED", supportsCoupon: true },
      merchant: null,
      statuses: { mappingStatus: "MAPPED" },
    });

    assert.equal(fields.couponSupport, true);
    assert.equal(fields.couponSupportState, CAMPAIGN_CAPABILITY_STATE.SUPPORTED_DATA_NOT_SYNCED);
    assert.equal(fields.capabilities.coupon.syncedCount, 0);
    assert.equal(fields.linkSupport, false);
  });

  it("marks coupon supported when synced records exist", () => {
    const fields = buildNetworkCampaignFields({
      entity: {
        entityType: "campaign",
        networkSource: "optimise_sea",
        rawData: {},
        rawPayloads: [],
        mapperErrors: [],
      },
      supplierCampaign: {
        campaignName: "Test",
        campaignSources: [{ id: "cs-1", supportsCoupon: true }],
        _count: { coupons: 3, supplierCommissionRules: 2 },
      },
      campaignSource: { id: "cs-1", supportsCoupon: true },
      merchant: null,
      statuses: { mappingStatus: "MAPPED" },
    });

    assert.equal(fields.couponSupportState, CAMPAIGN_CAPABILITY_STATE.SUPPORTED);
    assert.equal(fields.commissionRulesState, CAMPAIGN_CAPABILITY_STATE.SUPPORTED);
    assert.equal(fields.capabilities.coupon.syncedCount, 3);
  });
});
