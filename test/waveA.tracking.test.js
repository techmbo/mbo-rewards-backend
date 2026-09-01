import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  appendTrackingParams,
  buildAttributionQueryParams,
  getTrackingParamRule,
} from "../src/modules/tracking/index.js";
import { TrackingRedirectService } from "../src/modules/reporting/services/trackingRedirect.service.js";

describe("trackingUrlBuilder", () => {
  it("appends params to a clean URL", () => {
    const result = appendTrackingParams("https://example.com/path", {
      p1: "client-1",
      p2: "assign-1",
    });
    assert.equal(result.url, "https://example.com/path?p1=client-1&p2=assign-1");
    assert.deepEqual(result.applied, { p1: "client-1", p2: "assign-1" });
  });

  it("preserves existing query params and does not overwrite by default", () => {
    const result = appendTrackingParams("https://example.com/path?foo=bar&p1=existing", {
      p1: "new",
      p2: "assign-1",
    });
    const url = new URL(result.url);
    assert.equal(url.searchParams.get("foo"), "bar");
    assert.equal(url.searchParams.get("p1"), "existing");
    assert.equal(url.searchParams.get("p2"), "assign-1");
    assert.deepEqual(result.skipped, ["p1"]);
  });

  it("preserves URL fragments", () => {
    const result = appendTrackingParams("https://example.com/path?foo=bar#section", {
      UID: "client-1",
    });
    assert.ok(result.url.includes("#section"));
    assert.ok(result.url.includes("UID=client-1"));
    assert.ok(result.url.includes("foo=bar"));
  });

  it("encodes values safely", () => {
    const result = appendTrackingParams("https://example.com/go", {
      p1: "a b/c",
    });
    assert.equal(new URL(result.url).searchParams.get("p1"), "a b/c");
  });
});

describe("trackingParamRules", () => {
  it("uses different params per supplier", () => {
    const optimise = buildAttributionQueryParams({
      supplier: "OPTIMISE",
      clientId: "c1",
      assignmentId: "a1",
      mboClickId: "click1",
    });
    assert.equal(optimise.params.UID, "c1");
    assert.equal(optimise.params.UID2, "a1");
    assert.equal(optimise.params.p1, undefined);
    assert.equal(optimise.params.click_id, undefined);

    const trackier = buildAttributionQueryParams({
      supplier: "TRACKIER",
      clientId: "c1",
      assignmentId: "a1",
      mboClickId: "click1",
    });
    assert.equal(trackier.params.p1, "c1");
    assert.equal(trackier.params.p2, "a1");
    assert.equal(trackier.params.p3, "click1");
    assert.equal(trackier.params.click_id, "click1");
  });

  it("does not invent Boostiny params", () => {
    const boostiny = buildAttributionQueryParams({
      supplier: "BOOSTINY",
      clientId: "c1",
      assignmentId: "a1",
      mboClickId: "click1",
    });
    assert.equal(boostiny.injected, false);
    assert.deepEqual(boostiny.params, {});
    assert.equal(getTrackingParamRule("BOOSTINY").confirmation, "UNCONFIRMED");
  });

  it("does not inject for unknown suppliers", () => {
    const unknown = buildAttributionQueryParams({
      supplier: "UNKNOWN",
      clientId: "c1",
      assignmentId: "a1",
      mboClickId: "click1",
    });
    assert.equal(unknown.injected, false);
    assert.deepEqual(unknown.params, {});
  });
});

describe("TrackingRedirectService attribution injection", () => {
  function liveLink(overrides = {}) {
    return {
      id: "tl1",
      assignmentId: "a1",
      slug: "nova-benefits-ajio",
      subId: "8V5DAXR6",
      status: "ACTIVE",
      deletedAt: null,
      supplierTrackingUrl: null,
      campaignSource: {
        supplierCampaign: { supplier: "TRACKIER", trackingUrl: "https://track.example/click?campaign_id=1" },
      },
      assignment: {
        id: "a1",
        clientId: "client-1",
        status: "ACTIVE",
        published: true,
        client: { id: "client-1", status: "ACTIVE", deletedAt: null },
        canonicalCampaign: { status: "PUBLISHED", visibility: "ASSIGNABLE", deletedAt: null },
        campaignSource: {
          supplierCampaign: { supplier: "TRACKIER" },
        },
        couponAssignments: [],
      },
      ...overrides,
    };
  }

  it("creates Click before redirect and injects Trackier params", async () => {
    const attribution = {
      recordClick: mock.fn(async () => ({ id: "click-uuid-1" })),
    };
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

    assert.equal(attribution.recordClick.mock.calls.length, 1);
    const dest = new URL(result.destination);
    assert.equal(dest.searchParams.get("campaign_id"), "10364");
    assert.equal(dest.searchParams.get("pub_id"), "130062");
    assert.equal(dest.searchParams.get("p1"), "client-1");
    assert.equal(dest.searchParams.get("p2"), "a1");
    assert.equal(dest.searchParams.get("p3"), "click-uuid-1");
    assert.equal(dest.searchParams.get("click_id"), "click-uuid-1");
    assert.equal(result.clickId, "click-uuid-1");
  });

  it("injects Optimise UID/UID2 without inventing click param", async () => {
    const attribution = { recordClick: mock.fn(async () => ({ id: "click-9" })) };
    const trackingRepo = {
      findBySlugAndToken: mock.fn(async () =>
        liveLink({
          supplierTrackingUrl: "https://go.optimise.com/track?x=1#frag",
          campaignSource: { supplierCampaign: { supplier: "OPTIMISE" } },
          assignment: {
            ...liveLink().assignment,
            campaignSource: { supplierCampaign: { supplier: "OPTIMISE" } },
          },
        }),
      ),
      findBySubId: mock.fn(async () => null),
      update: mock.fn(async (id, data) => ({ id, ...data })),
    };

    const service = new TrackingRedirectService({ trackingRepo, attribution });
    const result = await service.redirect({ slug: "nova-benefits-ajio", token: "8V5DAXR6" });
    const dest = new URL(result.destination);
    assert.equal(dest.hash, "#frag");
    assert.equal(dest.searchParams.get("x"), "1");
    assert.equal(dest.searchParams.get("UID"), "client-1");
    assert.equal(dest.searchParams.get("UID2"), "a1");
    assert.equal(dest.searchParams.get("p3"), null);
  });

  it("does not inject params onto coupon website destinations", async () => {
    const attribution = { recordClick: mock.fn(async () => ({ id: "click-9" })) };
    const trackingRepo = {
      findBySlugAndToken: mock.fn(async () =>
        liveLink({
          supplierTrackingUrl: null,
          assignment: {
            ...liveLink().assignment,
            couponAssignments: [{ status: "ACTIVE", couponType: "CODE", clientCouponCode: "SAVE10" }],
          },
        }),
      ),
      findBySubId: mock.fn(async () => null),
      update: mock.fn(async (id, data) => ({ id, ...data })),
    };
    const resolveDestinationFn = mock.fn(async () => ({
      url: "https://www.merchant.example/",
      source: "couponCms.websiteUrl",
      reason: null,
    }));

    const service = new TrackingRedirectService({
      trackingRepo,
      attribution,
      resolveDestinationFn,
    });
    const result = await service.redirect({ slug: "nova-benefits-ajio", token: "8V5DAXR6" });
    assert.equal(result.destination, "https://www.merchant.example/");
    assert.equal(result.attributionInjection.injected, false);
  });

  it("skips injection for Boostiny (unconfirmed)", async () => {
    const attribution = { recordClick: mock.fn(async () => ({ id: "click-9" })) };
    const trackingRepo = {
      findBySlugAndToken: mock.fn(async () =>
        liveLink({
          supplierTrackingUrl: "https://boostiny.example/go?x=1",
          campaignSource: { supplierCampaign: { supplier: "BOOSTINY" } },
          assignment: {
            ...liveLink().assignment,
            campaignSource: { supplierCampaign: { supplier: "BOOSTINY" } },
          },
        }),
      ),
      findBySubId: mock.fn(async () => null),
      update: mock.fn(async (id, data) => ({ id, ...data })),
    };

    const service = new TrackingRedirectService({ trackingRepo, attribution });
    const result = await service.redirect({ slug: "nova-benefits-ajio", token: "8V5DAXR6" });
    assert.equal(result.destination, "https://boostiny.example/go?x=1");
    assert.equal(result.attributionInjection.injected, false);
  });
});
