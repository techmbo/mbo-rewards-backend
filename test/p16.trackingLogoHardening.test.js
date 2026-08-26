/**
 * P1.6 — tracking URL base + repair + logo backfill.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  getTrackingBaseUrl,
  buildMboTrackingUrl,
  rewriteTrackingUrlOrigin,
} from "../src/modules/commercial/trackingUrl.js";
import { repairTrackingLinkHosts } from "../scripts/repair-tracking-link-hosts.js";
import { backfillMerchantLogos } from "../scripts/backfill-merchant-logos.js";
import { projectBrandIdentity } from "../src/modules/merchant/brandIdentity.js";
import { prisma } from "../src/database/prisma.js";

describe("P1.6 canonical tracking URL generation", () => {
  let originalTracking;
  let originalBackend;

  before(() => {
    originalTracking = process.env.TRACKING_BASE_URL;
    originalBackend = process.env.BACKEND_URL;
  });

  after(() => {
    if (originalTracking === undefined) delete process.env.TRACKING_BASE_URL;
    else process.env.TRACKING_BASE_URL = originalTracking;
    if (originalBackend === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = originalBackend;
  });

  it("uses TRACKING_BASE_URL without hardcoded localhost ports", () => {
    process.env.TRACKING_BASE_URL = "https://go.example.test";
    delete process.env.BACKEND_URL;
    assert.equal(getTrackingBaseUrl(), "https://go.example.test");
    const built = buildMboTrackingUrl({ slug: "hello-1-klook-staycation", token: "ABC23456" });
    assert.equal(
      built.mboTrackingUrl,
      "https://go.example.test/r/hello-1-klook-staycation/ABC23456",
    );
    assert.doesNotMatch(built.mboTrackingUrl, /localhost:\d+/);
  });

  it("falls back to BACKEND_URL when TRACKING_BASE_URL unset", () => {
    delete process.env.TRACKING_BASE_URL;
    process.env.BACKEND_URL = "http://api.example.test:4001";
    assert.equal(getTrackingBaseUrl(), "http://api.example.test:4001");
  });

  it("throws when neither TRACKING_BASE_URL nor BACKEND_URL is set", () => {
    delete process.env.TRACKING_BASE_URL;
    delete process.env.BACKEND_URL;
    assert.throws(() => getTrackingBaseUrl(), /TRACKING_BASE_URL/);
  });
});

describe("P1.6 obsolete tracking URL rewrite", () => {
  it("rewrites only the origin and preserves path/token", () => {
    const next = rewriteTrackingUrlOrigin(
      "http://localhost:4000/r/hello-1-klook-staycation/Y8QCUUCV",
      "http://localhost:4001",
    );
    assert.equal(next, "http://localhost:4001/r/hello-1-klook-staycation/Y8QCUUCV");
  });

  it("returns null when already on canonical origin (idempotent)", () => {
    const next = rewriteTrackingUrlOrigin(
      "http://localhost:4001/r/hello-1-klook-staycation/Y8QCUUCV",
      "http://localhost:4001",
    );
    assert.equal(next, null);
  });
});

describe("P1.6 logo projection", () => {
  it("backfills via projectBrandIdentity from supplier when merchant empty", () => {
    const brand = projectBrandIdentity(
      { id: "m1", displayName: "Ajio", logoUrl: null },
      { campaignLogoUrl: "https://cdn.example/ajio.png" },
    );
    assert.equal(brand.logoUrl, "https://cdn.example/ajio.png");
  });

  it("missing logo stays null for honest fallback", () => {
    const brand = projectBrandIdentity({ id: "m2", displayName: "NoLogo Co", logoUrl: null }, null);
    assert.equal(brand.logoUrl, null);
  });
});

describe("P1.6 live repair + logo backfill idempotency", () => {
  it("repairTrackingLinkHosts is idempotent against current DB", async () => {
    // Ensure canonical env points at configured base (from .env after fix).
    assert.ok(process.env.TRACKING_BASE_URL || process.env.BACKEND_URL);

    const first = await repairTrackingLinkHosts({ dryRun: false });
    const second = await repairTrackingLinkHosts({ dryRun: false });

    assert.equal(second.updated, 0);
    assert.ok(first.scanned >= 0);
    assert.equal(second.alreadyCorrect, first.scanned);
    // After first run, all scanned rows must be on canonical origin.
    const leftover = await prisma.trackingLink.count({
      where: {
        deletedAt: null,
        mboTrackingUrl: { contains: "localhost:4000" },
      },
    });
    assert.equal(leftover, 0);
  });

  it("backfillMerchantLogos is idempotent", async () => {
    const first = await backfillMerchantLogos({ dryRun: false });
    const second = await backfillMerchantLogos({ dryRun: false });
    assert.equal(second.updated, 0);
    assert.ok(first.scanned >= second.alreadyHadLogo);
  });
});
