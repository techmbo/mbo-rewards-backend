import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { mapEntityToSupplierCoupon } from "../src/modules/supplier/mappers/index.js";
import { normalizeCouponStatus } from "../src/modules/supplier/mappers/status.js";

/**
 * Phase 17 — a coupon mapper may only ever produce a value the Prisma enum accepts.
 *
 * SupplierCoupon.couponStatus and .couponType are enum columns. A mapper that passes a supplier's
 * raw string through does not write a lenient value, it writes a REJECTED one: Prisma throws on
 * create, the whole coupon fails, and the generic catch reports it as PROMOTION_FAILED rather than
 * as the enum problem it is. That is exactly how every Trackier coupon failed in production while
 * its parent campaign resolved perfectly.
 *
 * The enum members are read from schema.prisma rather than restated here, so this test cannot
 * drift away from the column it is protecting.
 */

const SCHEMA = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

function enumMembers(name) {
  const block = SCHEMA.split(`enum ${name} {`)[1].split("}")[0];
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("/"));
}

const COUPON_STATUS = enumMembers("CouponStatus");
const COUPON_TYPE = enumMembers("CouponType");

// Every supplier that has a coupon mapper, plus the ones that fall through to the shared base.
const NETWORK_SOURCES = [
  "boostiny",
  "optimise_sea",
  "trackier",
  "partnerize",
  "impact",
  "awin",
  "cj",
  "admitad",
  "rakuten",
];

// Shapes a supplier payload plausibly carries, including the hostile ones. None of these may
// escape into an enum column.
const STATUS_CASES = [
  ["absent", {}],
  ["active", { status: "active" }],
  ["Active", { status: "Active" }],
  ["ACTIVE", { status: "ACTIVE" }],
  ["  Active  ", { status: "  Active  " }],
  ["expired", { status: "expired" }],
  ["scheduled", { status: "scheduled" }],
  ["pending", { status: "pending" }],
  ["paused", { status: "paused" }],
  ["disabled", { status: "disabled" }],
  ["inactive", { status: "inactive" }],
  ["unrecognised", { status: "wat-is-this" }],
  ["empty string", { status: "" }],
  ["null", { status: null }],
  ["numeric", { status: 1 }],
  ["boolean", { status: true }],
  ["coupon_status active", { coupon_status: "active", status: null }],
  ["coupon_status disabled", { coupon_status: "disabled", status: "active" }],
  // Not every supplier expresses status through a `status` field. Partnerize derives it from an
  // active flag, and that path is exactly where it used to emit the non-member "INACTIVE", so the
  // shared contract has to drive it too or it is not a shared contract.
  ["active: y", { active: "y" }],
  ["active: n", { active: "n" }],
  ["active: true", { active: true }],
  ["active: false", { active: false }],
  ["active: unparseable", { active: "maybe" }],
];

// couponType is driven by code/link presence, so vary that independently of status.
const SHAPE_CASES = [
  ["code", { code: "SAVE10" }, "SAVE10"],
  ["link only", { url: "https://example.test/offer", link: "https://example.test/offer" }, null],
  ["neither", {}, null],
];

function couponEntity(networkSource, rawExtra, code) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    networkSource,
    entityType: "coupon",
    externalId: `${networkSource}-coupon-abc123`,
    entityName: "Offer",
    campaignName: "Brand Campaign",
    entityStatus: "Active",
    code,
    createdAt: new Date(),
    updatedAt: new Date(),
    normalizedData: {},
    rawData: {
      id: "abc123",
      campaign_id: 10240,
      campaign_name: "Brand Campaign",
      ...rawExtra,
    },
  };
}

describe("Phase 17 — every coupon mapper stays inside the Prisma enums", () => {
  it("the enum members were actually read from schema.prisma", () => {
    assert.deepEqual(COUPON_STATUS, ["ACTIVE", "EXPIRED", "SCHEDULED", "UNKNOWN", "DISABLED"]);
    assert.deepEqual(COUPON_TYPE, ["CODE", "LINK", "UNKNOWN"]);
  });

  for (const networkSource of NETWORK_SOURCES) {
    it(`${networkSource}: couponStatus and couponType are always enum members`, () => {
      for (const [statusLabel, statusRaw] of STATUS_CASES) {
        for (const [shapeLabel, shapeRaw, code] of SHAPE_CASES) {
          const entity = couponEntity(networkSource, { ...statusRaw, ...shapeRaw }, code);
          const mapped = mapEntityToSupplierCoupon(entity);
          const where = `${networkSource} / status=${statusLabel} / shape=${shapeLabel}`;

          assert.ok(
            COUPON_STATUS.includes(mapped.couponStatus),
            `${where}: couponStatus ${JSON.stringify(mapped.couponStatus)} is not a CouponStatus member`,
          );
          assert.ok(
            COUPON_TYPE.includes(mapped.couponType),
            `${where}: couponType ${JSON.stringify(mapped.couponType)} is not a CouponType member`,
          );
        }
      }
    });
  }

  it("the normalizer itself can never return a non-member, whatever it is handed", () => {
    const hostile = [
      "active", "ACTIVE", " Active ", "live", "enabled", "running",
      "expired", "ended", "closed", "scheduled", "upcoming", "pending",
      "disabled", "inactive", "paused", "suspended", "deactivated", "stopped",
      "wat", "", null, undefined, 0, 1, true, false, {}, [], "ACTIVE\n",
    ];
    for (const value of hostile) {
      const out = normalizeCouponStatus(value);
      assert.ok(
        COUPON_STATUS.includes(out),
        `normalizeCouponStatus(${JSON.stringify(value)}) returned ${JSON.stringify(out)}`,
      );
    }
    assert.equal(normalizeCouponStatus(), "UNKNOWN", "no candidates at all is UNKNOWN");
  });

  it("an already-canonical value round-trips, so a mapper may pass its own fallback in", () => {
    for (const member of COUPON_STATUS) {
      assert.equal(normalizeCouponStatus(member), member, `${member} did not round-trip`);
    }
  });
});

/** The exact production shape: parent resolves, create is reached, status is the raw "active". */
function trackierCoupon(rawExtra = {}) {
  return couponEntity("trackier", { code: "TATA100", coupon_status: null, ...rawExtra }, "TATA100");
}

describe("Phase 17 — Trackier coupon/deal status regression", () => {
  const cases = [
    ["active", { status: "active" }, "ACTIVE"],
    ["Active", { status: "Active" }, "ACTIVE"],
    ["ACTIVE", { status: "ACTIVE" }, "ACTIVE"],
    ["expired", { status: "expired" }, "EXPIRED"],
    ["unknown/unrecognised", { status: "no-such-status", coupon_status: null }, "ACTIVE"],
    ["missing status", {}, "ACTIVE"],
  ];

  for (const [label, rawExtra, expected] of cases) {
    it(`status ${label} -> ${expected}`, () => {
      const mapped = mapEntityToSupplierCoupon(trackierCoupon(rawExtra));
      assert.equal(mapped.couponStatus, expected);
      assert.ok(COUPON_STATUS.includes(mapped.couponStatus));
    });
  }

  it("an unrecognised status with no other evidence is UNKNOWN, never the raw string", () => {
    // entityStatus cleared too, so nothing anywhere says the coupon is active.
    const entity = trackierCoupon({ status: "no-such-status" });
    entity.entityStatus = null;
    const mapped = mapEntityToSupplierCoupon(entity);
    assert.equal(mapped.couponStatus, "UNKNOWN");
  });

  it("Trackier's own priority is kept: coupon_status outranks status", () => {
    const mapped = mapEntityToSupplierCoupon(
      trackierCoupon({ coupon_status: "expired", status: "active" }),
    );
    assert.equal(mapped.couponStatus, "EXPIRED");
  });

  it("the raw supplier status is preserved verbatim in rawPayload as evidence", () => {
    const mapped = mapEntityToSupplierCoupon(trackierCoupon({ status: "active" }));
    assert.equal(mapped.couponStatus, "ACTIVE", "canonical column is normalized");
    assert.equal(mapped.rawPayload.status, "active", "raw lineage is NOT rewritten");
  });

  it("parent campaign resolution and coupon identity are untouched by the status fix", () => {
    const mapped = mapEntityToSupplierCoupon(trackierCoupon({ status: "active" }));
    assert.equal(mapped.parentSupplierCampaignId, "10240");
    assert.equal(typeof mapped.parentSupplierCampaignId, "string");
    assert.equal(mapped.supplierCouponId, "abc123");
    assert.equal(mapped.couponCode, "TATA100");
    assert.equal(mapped.couponType, "CODE");
  });

  it("a Trackier DEAL (no code, link only) still maps to a LINK, not a CODE", () => {
    const entity = couponEntity(
      "trackier",
      { record_source: "deal", title: "Sitewide deal", url: "https://example.test/deal", status: "active" },
      null,
    );
    const mapped = mapEntityToSupplierCoupon(entity);
    assert.equal(mapped.couponStatus, "ACTIVE");
    assert.equal(mapped.couponType, "LINK");
    assert.equal(mapped.couponCode, null, "a deal must never invent a coupon code");
  });
});

describe("Phase 17 — Partnerize active/inactive regression", () => {
  function partnerizeCoupon(rawExtra) {
    return couponEntity("partnerize", { voucher_code: "PZ10", ...rawExtra }, "PZ10");
  }

  const cases = [
    ["active: y", { active: "y" }, "ACTIVE"],
    ["active: true", { active: true }, "ACTIVE"],
    ["active: n", { active: "n" }, "DISABLED"],
    ["active: false", { active: false }, "DISABLED"],
  ];

  for (const [label, rawExtra, expected] of cases) {
    it(`${label} -> ${expected}`, () => {
      const mapped = mapEntityToSupplierCoupon(partnerizeCoupon(rawExtra));
      assert.equal(mapped.couponStatus, expected);
      assert.ok(
        COUPON_STATUS.includes(mapped.couponStatus),
        "INACTIVE is not a CouponStatus member and must never be produced",
      );
    });
  }

  it("never emits the literal INACTIVE for any active shape", () => {
    for (const active of ["y", "n", "Y", "N", true, false, null, undefined, "", "maybe"]) {
      const mapped = mapEntityToSupplierCoupon(partnerizeCoupon({ active }));
      assert.notEqual(mapped.couponStatus, "INACTIVE", `active=${JSON.stringify(active)}`);
      assert.ok(COUPON_STATUS.includes(mapped.couponStatus));
    }
  });

  it("falls back to the payload status when the supplier said nothing about active", () => {
    const mapped = mapEntityToSupplierCoupon(partnerizeCoupon({ status: "expired" }));
    assert.equal(mapped.couponStatus, "EXPIRED");
  });
});
