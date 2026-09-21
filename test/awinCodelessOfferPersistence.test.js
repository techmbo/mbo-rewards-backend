import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SupplierCouponPromotionService,
  canAdoptCouponByNaturalKey,
} from "../src/modules/supplier/services/supplierCouponPromotion.service.js";
import { mapEntityToSupplierCoupon } from "../src/modules/supplier/mappers/index.js";

/**
 * Phase 21 — a code-less Awin offer is still a coupon, and still gets its own row.
 *
 * Production: 5,011 staged Awin offers, 1,418 parents, every mapper error RESOLVED — and only
 * 4,243 SupplierCoupon rows. 768 entities promoted "successfully" and ended with no row.
 *
 * The cause is not couponCode, which is nullable and mapped correctly. It is the natural-key
 * fallback: (parent, couponType, couponCode | couponLink) carries no supplier identity, so two
 * DIFFERENT Awin promotions sharing an advertiser's generic tracking link resolve to the same
 * coupon. The later one overwrote the earlier one's entityId and supplierCouponId and reported
 * "updated", which is a success — which is why the orphaned entities' errors were resolved.
 */

const PARENT = "parent-1";
const SHARED_LINK = "https://www.awin1.com/cread.php?awinmid=6349";

function awinOffer(promotionId, raw = {}) {
  const externalId = `awin-coupon-${raw.advertiserId ?? 6349}-${promotionId}`;
  return {
    id: `e-${externalId}`,
    externalId,
    networkSource: "awin",
    entityType: "coupon",
    entityName: "Offer",
    campaignName: null,
    entityStatus: raw.status ?? null,
    code: null,
    discount: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    normalizedData: {},
    rawData: {
      promotionId,
      advertiser: { id: raw.advertiserId ?? 6349, name: raw.advertiserName ?? "A Ltd" },
      type: raw.type ?? "promotion",
      voucherCode: raw.voucherCode ?? null,
      status: raw.status ?? "active",
      title: raw.title ?? "20% off everything",
      ...(raw.url === undefined ? {} : { url: raw.url }),
      ...(raw.extra ?? {}),
    },
  };
}

/** The real service, over an in-memory coupon table that honours the real natural-key rules. */
function harness({ parent = { id: PARENT }, seed = [] } = {}) {
  const rows = [...seed];
  const statusCalls = [];
  let seq = 0;

  const couponRepo = {
    findByEntityId: async (entityId) => rows.find((r) => r.entityId === entityId) ?? null,
    findByNaturalKey: async ({ supplierCampaignId, couponType, couponCode, couponLink }) => {
      if (couponType === "CODE" && couponCode) {
        return rows.find(
          (r) => r.supplierCampaignId === supplierCampaignId && r.couponType === "CODE" && r.couponCode === couponCode,
        ) ?? null;
      }
      if (couponType === "LINK" && couponLink) {
        return rows.find(
          (r) => r.supplierCampaignId === supplierCampaignId && r.couponType === "LINK" && r.couponLink === couponLink,
        ) ?? null;
      }
      return null;
    },
    create: async (data) => {
      seq += 1;
      const row = {
        id: `sc-${seq}`, ...data,
        supplierCampaignId: data.supplierCampaign?.connect?.id ?? null,
        entityId: data.entity?.connect?.id ?? null,
      };
      rows.push(row);
      return row;
    },
    update: async (id, data) => {
      const row = rows.find((r) => r.id === id);
      Object.assign(row, data, {
        supplierCampaignId: data.supplierCampaign?.connect?.id ?? row.supplierCampaignId,
        entityId: data.entity?.connect?.id ?? row.entityId,
      });
      return row;
    },
  };

  const service = new SupplierCouponPromotionService({
    runInTransaction: async (fn) => fn({}),
    campaignRepo: {
      findByBusinessKey: async () => parent,
      findByCampaignName: async () => parent,
    },
    couponRepo,
    outboxWriter: { append: async () => ({ id: "outbox" }) },
    mapperErrorRepo: {
      findOpenByEntityId: async (entityId) => ({ id: `me-${entityId}`, message: "SupplierCampaign not found" }),
      updateStatus: async (id, status, extra) => { statusCalls.push({ id, status, extra }); return { id, status }; },
      create: async (data) => { statusCalls.push({ id: "new", status: data.status }); return { id: "new" }; },
    },
  });

  return {
    rows, statusCalls, service,
    promote: (entity) => service.promoteEntity(entity),
    orphans: (entities) => entities.filter((e) => !rows.some((r) => r.entityId === e.id)).map((e) => e.id),
  };
}

describe("Phase 21 — a code-less Awin offer persists", () => {
  it("A. type 'promotion' with no voucherCode persists, and couponCode stays null", async () => {
    const h = harness();
    const entity = awinOffer(4105429, { type: "promotion", url: SHARED_LINK });

    const out = await h.promote(entity);

    assert.equal(out.result, "created");
    assert.equal(h.rows.length, 1);
    assert.equal(h.rows[0].couponCode, null, "no code was invented");
    assert.equal(h.rows[0].entityId, entity.id);
    assert.equal(h.rows[0].supplierCampaignId, PARENT);
    assert.equal(h.rows[0].networkSource, "awin");
    assert.ok(h.rows[0].supplierCouponId, "the supplier identity is carried");
    assert.ok(h.rows[0].mapperVersion, "lineage is preserved");
    assert.equal(h.rows[0].rawPayload.promotionId, 4105429, "the raw payload is preserved");
  });

  it("B. type 'voucher' with no voucherCode persists the same way", async () => {
    const h = harness();
    const entity = awinOffer(4115715, { type: "voucher", status: "expiringSoon", url: SHARED_LINK });

    const out = await h.promote(entity);

    assert.equal(out.result, "created");
    assert.equal(h.rows[0].couponCode, null);
    assert.equal(h.rows[0].entityId, entity.id);
  });

  it("a code-less offer with NO link at all also persists", async () => {
    const h = harness();
    const entity = awinOffer(4113055, { type: "voucher" });
    const mapped = mapEntityToSupplierCoupon(entity);

    assert.equal(mapped.couponCode, null);
    assert.equal(mapped.couponLink, null);
    assert.equal(mapped.couponType, "UNKNOWN", "no code and no link is UNKNOWN, a real enum member");

    const out = await h.promote(entity);
    assert.equal(out.result, "created");
    assert.equal(h.rows.length, 1);
  });

  it("C. distinct promotionIds sharing one advertiser link do NOT collapse", async () => {
    const h = harness();
    const entities = [
      awinOffer(4105429, { type: "promotion", url: SHARED_LINK }),
      awinOffer(4105430, { type: "voucher", url: SHARED_LINK }),
      awinOffer(4105431, { type: "voucher", status: "expiringSoon", url: SHARED_LINK }),
    ];

    for (const entity of entities) {
      const out = await h.promote(entity);
      assert.equal(out.result, "created", `${entity.externalId} did not get its own row`);
    }

    assert.equal(h.rows.length, 3, "three distinct supplier offers, three rows");
    assert.deepEqual(h.orphans(entities), [], "every entity owns a row");
    assert.equal(new Set(h.rows.map((r) => r.supplierCouponId)).size, 3, "identities are distinct");
    assert.equal(new Set(h.rows.map((r) => r.entityId)).size, 3);
    for (const row of h.rows) assert.equal(row.couponCode, null);
  });

  it("distinct promotionIds sharing one CODE also do not collapse", async () => {
    // The same defect reaches the CODE branch: two promotions can carry the same voucher code.
    const h = harness();
    const entities = [
      awinOffer(4200001, { voucherCode: "SAVE20" }),
      awinOffer(4200002, { voucherCode: "SAVE20" }),
    ];
    for (const entity of entities) await h.promote(entity);

    assert.equal(h.rows.length, 2);
    assert.deepEqual(h.orphans(entities), []);
    assert.equal(new Set(h.rows.map((r) => r.supplierCouponId)).size, 2);
  });

  it("re-promoting the SAME entity still updates its own row, never duplicates", async () => {
    const h = harness();
    const entity = awinOffer(4105429, { type: "promotion", url: SHARED_LINK });

    const first = await h.promote(entity);
    const second = await h.promote(entity);

    assert.equal(first.result, "created");
    assert.equal(second.result, "updated");
    assert.equal(h.rows.length, 1, "the same offer must not create a second row");
  });

  it("D. an offer with a real voucherCode behaves exactly as before", async () => {
    const h = harness();
    const entity = awinOffer(9999999, { voucherCode: "SAVE20" });
    const mapped = mapEntityToSupplierCoupon(entity);

    assert.equal(mapped.couponCode, "SAVE20");
    assert.equal(mapped.couponType, "CODE");

    const out = await h.promote(entity);
    assert.equal(out.result, "created");
    assert.equal(h.rows[0].couponCode, "SAVE20");
    assert.equal(h.rows[0].couponType, "CODE");
  });

  it("E. a missing parent still fails closed", async () => {
    const h = harness({ parent: null });
    const out = await h.promote(awinOffer(4105429, { url: SHARED_LINK }));

    assert.equal(out.result, "failed");
    assert.equal(out.error.code, "PARENT_CAMPAIGN_NOT_FOUND");
    assert.equal(h.rows.length, 0, "a parentless offer must never persist");
  });

  it("F. an offer with no derivable identity is refused, never fabricated", async () => {
    const h = harness();
    const entity = awinOffer(4105429);
    entity.rawData = { type: "voucher", status: "active" };
    entity.externalId = "awin-coupon-unresolved-abc";

    const out = await h.promote(entity);
    assert.equal(out.result, "failed");
    assert.equal(out.error.code, "MISSING_PARENT_CAMPAIGN");
    assert.equal(h.rows.length, 0);
  });

  it("G. Awin statuses normalize to enum members, never a raw string", async () => {
    const members = ["ACTIVE", "EXPIRED", "SCHEDULED", "UNKNOWN", "DISABLED"];
    const cases = [["active", "ACTIVE"], ["expired", "EXPIRED"], ["expiringSoon", "UNKNOWN"], ["", "UNKNOWN"]];
    for (const [raw, expected] of cases) {
      const mapped = mapEntityToSupplierCoupon(awinOffer(4105429, { status: raw }));
      assert.equal(mapped.couponStatus, expected, `status ${raw}`);
      assert.ok(members.includes(mapped.couponStatus));
    }
  });
});

describe("Phase 21 — the adoption rule", () => {
  it("adopts only an unowned, non-contradicting row", () => {
    const ctx = { entityId: "e-1", supplierCouponId: "6349-1" };
    assert.equal(canAdoptCouponByNaturalKey(null, ctx), false);
    assert.equal(canAdoptCouponByNaturalKey({ entityId: null, supplierCouponId: null }, ctx), true, "legacy unowned row");
    assert.equal(canAdoptCouponByNaturalKey({ entityId: "e-1", supplierCouponId: "6349-1" }, ctx), true, "our own row");
    assert.equal(canAdoptCouponByNaturalKey({ entityId: "e-2", supplierCouponId: "6349-2" }, ctx), false, "another entity's row");
    assert.equal(canAdoptCouponByNaturalKey({ entityId: null, supplierCouponId: "6349-2" }, ctx), false, "a different supplier coupon");
    assert.equal(canAdoptCouponByNaturalKey({ entityId: null, supplierCouponId: "6349-1" }, ctx), true, "same supplier coupon, unowned");
  });

  it("a legacy row with no entityId is still adopted and linked, not duplicated", async () => {
    const h = harness({
      seed: [{
        id: "sc-legacy", supplierCampaignId: PARENT, couponType: "LINK",
        couponCode: null, couponLink: SHARED_LINK, entityId: null, supplierCouponId: null,
      }],
    });
    const entity = awinOffer(4105429, { type: "promotion", url: SHARED_LINK });

    const out = await h.promote(entity);
    assert.equal(out.result, "updated", "the unowned legacy row is adopted");
    assert.equal(h.rows.length, 1, "no duplicate was created");
    assert.equal(h.rows[0].id, "sc-legacy");
    assert.equal(h.rows[0].entityId, entity.id, "and it is now linked to its entity");
  });
});

describe("Phase 21 — mapper error lifecycle is now truthful", () => {
  it("H. every entity reported successful owns a row, so RESOLVED means persisted", async () => {
    const h = harness();
    const entities = [
      awinOffer(4105429, { type: "promotion", url: SHARED_LINK }),
      awinOffer(4105430, { type: "voucher", url: SHARED_LINK }),
      awinOffer(4105431, { type: "voucher", url: SHARED_LINK }),
    ];
    for (const entity of entities) await h.promote(entity);

    const resolved = h.statusCalls.filter((c) => c.status === "RESOLVED");
    assert.equal(resolved.length, 3, "three successes, three resolutions");
    assert.deepEqual(h.orphans(entities), [], "no entity was resolved without a row of its own");
    assert.equal(h.rows.length, resolved.length, "one persisted row per resolution");
  });

  it("a failing coupon keeps its error OPEN and persists nothing", async () => {
    const h = harness({ parent: null });
    await h.promote(awinOffer(4105429, { url: SHARED_LINK }));

    const resolved = h.statusCalls.filter((c) => c.status === "RESOLVED");
    assert.equal(resolved.length, 0);
    assert.equal(h.statusCalls.filter((c) => c.status === "OPEN").length, 1);
    assert.equal(h.rows.length, 0);
  });
});

describe("Phase 21 — other networks are untouched", () => {
  it("I. Trackier coupon promotion behaves exactly as before", async () => {
    const h = harness();
    const entity = {
      id: "t-1", externalId: "trackier-coupon-coupon-1", networkSource: "trackier",
      entityType: "coupon", entityName: "Offer", entityStatus: "Active", code: "TATA100",
      createdAt: new Date(), updatedAt: new Date(), normalizedData: {},
      rawData: { campaign_id: 10240, code: "TATA100", status: "active" },
    };

    const mapped = mapEntityToSupplierCoupon(entity);
    assert.equal(mapped.parentSupplierCampaignId, "10240");
    assert.equal(mapped.couponStatus, "ACTIVE");
    assert.equal(mapped.couponType, "CODE");

    const out = await h.promote(entity);
    assert.equal(out.result, "created");
    assert.equal(h.rows[0].couponCode, "TATA100");
  });

  it("two Trackier coupons sharing a code under one campaign each keep their own row", async () => {
    // The shared service changed, so the property has to hold for every network, not just Awin.
    const h = harness();
    const base = {
      networkSource: "trackier", entityType: "coupon", entityName: "Offer", entityStatus: "Active",
      createdAt: new Date(), updatedAt: new Date(), normalizedData: {},
    };
    const a = { ...base, id: "t-a", externalId: "trackier-coupon-coupon-a", code: "SAVE", rawData: { id: "a", campaign_id: 10240, code: "SAVE" } };
    const b = { ...base, id: "t-b", externalId: "trackier-coupon-coupon-b", code: "SAVE", rawData: { id: "b", campaign_id: 10240, code: "SAVE" } };

    await h.promote(a);
    await h.promote(b);

    assert.equal(h.rows.length, 2);
    assert.deepEqual(h.orphans([a, b]), []);
  });
});
