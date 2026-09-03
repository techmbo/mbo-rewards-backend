import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { buildAdmitadIncrementalActionParams } from "../src/jobs/admitadSupplierSync.js";
import { getSourceObject } from "../src/modules/networkOps/sourceObjects.catalog.js";
import { parseNetworkSource } from "../src/modules/supplier/entityIdentity.js";

describe("Admitad sync persistence wiring", () => {
  it("marks only verified Admitad API objects live", () => {
    assert.equal(getSourceObject("admitad", "programs")?.live, true);
    assert.equal(getSourceObject("admitad", "programs")?.endpoint, "GET /advcampaigns/");
    assert.equal(getSourceObject("admitad", "coupons")?.live, true);
    assert.equal(getSourceObject("admitad", "coupons")?.endpoint, "GET /coupons/");
    assert.equal(getSourceObject("admitad", "actions")?.live, true);
    assert.equal(getSourceObject("admitad", "actions")?.endpoint, "GET /statistics/actions/");
    assert.equal(getSourceObject("admitad", "product_feeds")?.live, false);
  });

  it("uses status-updated incremental windows with overlap", () => {
    const params = buildAdmitadIncrementalActionParams({
      lastSuccessfulSync: "2026-09-03T06:00:00Z",
      now: new Date("2026-09-04T06:00:00Z"),
      overlapDays: 2,
    });
    assert.equal(params.status_updated_start, "2026-09-01T06:00:00Z");
    assert.equal(params.status_updated_end, "2026-09-04T06:00:00Z");
    assert.equal(params.order_by, "datetime");
  });

  it("honors explicit Admitad status-update boundaries", () => {
    const params = buildAdmitadIncrementalActionParams({
      lastSuccessfulSync: "2026-01-01T00:00:00Z",
      now: new Date("2026-09-04T06:00:00Z"),
      explicit: {
        status_updated_start: "2026-08-10T00:00:00Z",
        status_updated_end: "2026-08-12T00:00:00Z",
      },
    });
    assert.equal(params.status_updated_start, "2026-08-10T00:00:00Z");
    assert.equal(params.status_updated_end, "2026-08-12T00:00:00Z");
  });

  it("recognizes all expanded raw network identities without conflating aliases", () => {
    assert.deepEqual(parseNetworkSource("awin"), { supplier: "AWIN", supplierRegion: "GLOBAL" });
    assert.deepEqual(parseNetworkSource("admitad"), { supplier: "ADMITAD", supplierRegion: "GLOBAL" });
    assert.deepEqual(parseNetworkSource("cj"), { supplier: "CJ", supplierRegion: "GLOBAL" });
    assert.deepEqual(parseNetworkSource("rakuten"), { supplier: "RAKUTEN", supplierRegion: "GLOBAL" });
    assert.deepEqual(parseNetworkSource("vcommission"), { supplier: "TRACKIER", supplierRegion: "GLOBAL" });
  });

  it("keeps Prisma SupplierKey aligned with the nine-network registry", () => {
    const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
    const match = schema.match(/enum SupplierKey \{([\s\S]*?)\}/);
    assert.ok(match, "SupplierKey enum must exist");
    for (const key of ["BOOSTINY", "OPTIMISE", "TRACKIER", "PARTNERIZE", "IMPACT", "AWIN", "ADMITAD", "CJ", "RAKUTEN"]) {
      assert.match(match[1], new RegExp(`\\b${key}\\b`));
    }
  });
});
