import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  destinationFromCouponCmsEntity,
  looksLikeHttpUrl,
} from "../src/modules/commercial/resolveSupplierDestination.js";
import { TrackingRedirectService } from "../src/modules/reporting/services/trackingRedirect.service.js";

describe("resolveSupplierDestination helpers", () => {
  it("extracts Coupon CMS tracking URL as the canonical destination", () => {
    const result = destinationFromCouponCmsEntity({
      id: "e1",
      campaignName: "Ajio CPS",
      advertiserName: "Ajio",
      normalizedData: { code_type: "Link" },
      rawData: {
        trackingURL: "https://track.vcommission.com/click?campaign_id=10364&pub_id=130062",
        deepLinkURL: "https://www.ajio.com/offer",
      },
    });

    assert.equal(
      result.url,
      "https://track.vcommission.com/click?campaign_id=10364&pub_id=130062",
    );
    assert.equal(result.source, "couponCms.trackingUrl");
  });

  it("falls back to offer link when tracking URL is absent", () => {
    const result = destinationFromCouponCmsEntity({
      id: "e1",
      campaignName: "Ajio CPS",
      normalizedData: { link: "https://www.ajio.com/offer", code_type: "Link" },
      rawData: {},
    });
    assert.equal(result.url, "https://www.ajio.com/offer");
    assert.ok(looksLikeHttpUrl(result.url));
  });

  it("uses website/preview for CODE coupons even when a tracking link exists on the parent campaign", () => {
    const result = destinationFromCouponCmsEntity(
      {
        id: "deal1",
        campaignName: "Klook.com Travel CPS - Worldwide",
        networkSource: "trackier",
        normalizedData: { code_type: "Coupon" },
        rawData: {
          type: "deal",
          record_source: "deal",
          campaign_id: 10132,
          campaign_name: "Klook.com Travel CPS - Worldwide",
        },
      },
      {
        campaignEntity: {
          id: "camp1",
          entityType: "campaign",
          externalId: "10132",
          rawData: {
            preview_url: "https://www.klook.com/",
            tracking_link: "https://track.vcommission.com/click?campaign_id=10132&pub_id=130062",
          },
        },
      },
      { couponType: "CODE" },
    );

    assert.equal(result.url, "https://www.klook.com/");
    assert.equal(result.source, "couponCms.websiteUrl");
  });
});

describe("TrackingRedirectService", () => {
  function liveLink(overrides = {}) {
    return {
      id: "tl1",
      assignmentId: "a1",
      slug: "nova-benefits-ajio",
      subId: "8V5DAXR6",
      status: "ACTIVE",
      deletedAt: null,
      supplierTrackingUrl: null,
      assignment: {
        status: "ACTIVE",
        published: true,
        client: { status: "ACTIVE", deletedAt: null },
        canonicalCampaign: { status: "PUBLISHED", visibility: "ASSIGNABLE", deletedAt: null },
      },
      ...overrides,
    };
  }

  it("redirects to the exact supplier tracking URL and records the click first", async () => {
    const attribution = { recordClick: mock.fn(async () => ({ id: "click1" })) };
    const trackingRepo = {
      findBySlugAndToken: mock.fn(async () =>
        liveLink({
          supplierTrackingUrl: "https://track.vcommission.com/click?campaign_id=10364&pub_id=130062",
        }),
      ),
      findBySubId: mock.fn(async () => null),
      update: mock.fn(async (id, data) => ({ id, ...data })),
    };

    const service = new TrackingRedirectService({ trackingRepo, attribution });
    const result = await service.redirect(
      { slug: "nova-benefits-ajio", token: "8V5DAXR6" },
      { ip: "1.1.1.1", userAgent: "test-agent" },
    );

    assert.equal(
      result.destination,
      "https://track.vcommission.com/click?campaign_id=10364&pub_id=130062",
    );
    assert.equal(attribution.recordClick.mock.calls.length, 1);
    assert.equal(attribution.recordClick.mock.calls[0].arguments[0].trackingLinkId, "tl1");
  });

  it("live-resolves and backfills when supplierTrackingUrl was never persisted", async () => {
    const attribution = { recordClick: mock.fn(async () => ({ id: "click1" })) };
    const trackingRepo = {
      findBySlugAndToken: mock.fn(async () => liveLink({ supplierTrackingUrl: null })),
      findBySubId: mock.fn(async () => null),
      update: mock.fn(async (id, data) => ({ id, ...data })),
    };
    const resolveDestinationFn = mock.fn(async () => ({
      url: "https://track.vcommission.com/click?campaign_id=99",
      source: "couponCms.trackingUrl",
      reason: null,
    }));

    const service = new TrackingRedirectService({ trackingRepo, attribution, resolveDestinationFn });
    const result = await service.redirect({ slug: "nova-benefits-ajio", token: "8V5DAXR6" });

    assert.equal(result.destination, "https://track.vcommission.com/click?campaign_id=99");
    assert.equal(trackingRepo.update.mock.calls.length, 1);
    assert.equal(
      trackingRepo.update.mock.calls[0].arguments[1].supplierTrackingUrl,
      "https://track.vcommission.com/click?campaign_id=99",
    );
  });

  it("returns a specific error when supplier destination cannot be resolved", async () => {
    const service = new TrackingRedirectService({
      trackingRepo: {
        findBySlugAndToken: mock.fn(async () => liveLink({ supplierTrackingUrl: null })),
        update: mock.fn(async () => ({})),
      },
      attribution: { recordClick: mock.fn(async () => ({})) },
      resolveDestinationFn: mock.fn(async () => ({
        url: null,
        source: null,
        reason:
          "Supplier tracking URL is missing for this campaign. Ensure the Coupon CMS entry has a tracking URL.",
      })),
    });

    await assert.rejects(
      () => service.redirect({ slug: "nova-benefits-ajio", token: "8V5DAXR6" }),
      (error) =>
        error.statusCode === 409 && String(error.message).includes("Supplier tracking URL is missing"),
    );
  });

  it("rejects revoked tracking links", async () => {
    const service = new TrackingRedirectService({
      trackingRepo: {
        findBySlugAndToken: mock.fn(async () =>
          liveLink({ status: "REVOKED", supplierTrackingUrl: "https://supplier.example/go" }),
        ),
      },
      attribution: { recordClick: mock.fn(async () => ({})) },
    });

    await assert.rejects(
      () => service.redirect({ slug: "nova-benefits-ajio", token: "8V5DAXR6" }),
      (error) => error.statusCode === 410,
    );
  });

  it("supports legacy token-only redirects", async () => {
    const attribution = { recordClick: mock.fn(async () => ({ id: "click1" })) };
    const trackingRepo = {
      findBySubId: mock.fn(async () =>
        liveLink({
          slug: null,
          subId: "mbo_token",
          supplierTrackingUrl: "https://supplier.example/legacy",
        }),
      ),
      update: mock.fn(async (id, data) => ({ id, ...data })),
    };

    const service = new TrackingRedirectService({ trackingRepo, attribution });
    const result = await service.redirect("mbo_token", { ip: "1.1.1.1" });
    assert.equal(result.destination, "https://supplier.example/legacy");
  });

  it("rejects unpublished assignments", async () => {
    const service = new TrackingRedirectService({
      trackingRepo: {
        findBySubId: mock.fn(async () =>
          liveLink({
            slug: null,
            subId: "mbo_token",
            supplierTrackingUrl: "https://supplier.example/go",
            assignment: {
              status: "ASSIGNED",
              published: false,
              client: { status: "PROSPECT", deletedAt: null },
              canonicalCampaign: { status: "PUBLISHED", visibility: "ASSIGNABLE", deletedAt: null },
            },
          }),
        ),
      },
      attribution: { recordClick: mock.fn(async () => ({})) },
    });

    await assert.rejects(() => service.redirect("mbo_token"), (error) => error.statusCode === 409);
  });

  it("rejects wrong slug for slug-bearing links", async () => {
    const service = new TrackingRedirectService({
      trackingRepo: {
        findBySlugAndToken: mock.fn(async () => null),
        findBySubId: mock.fn(async () =>
          liveLink({
            slug: "correct-slug",
            subId: "8V5DAXR6",
            supplierTrackingUrl: "https://supplier.example/go",
          }),
        ),
      },
      attribution: { recordClick: mock.fn(async () => ({})) },
    });

    await assert.rejects(
      () => service.redirect({ slug: "wrong-slug", token: "8V5DAXR6" }),
      (error) => error.statusCode === 404,
    );
  });
});
