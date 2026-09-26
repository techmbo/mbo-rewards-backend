import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SupplierCouponPromotionService } from "../src/modules/supplier/services/supplierCouponPromotion.service.js";

/**
 * SupplierCoupon identity under the database invariant recorded by
 * 20260927090000_supplier_coupons_entity_identity: one row per staged Entity
 * (supplier_coupons_entityId_key, a plain unique index on entityId).
 *
 * The harness is the real SupplierCouponPromotionService over an in-memory coupon table that now
 * behaves like PostgreSQL does with that index: a second row for the same non-null entityId is
 * rejected with a P2002-shaped error. The retired link/code partial indexes are deliberately NOT
 * simulated — distinct offers sharing a link or a code are legitimate and must each keep a row.
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
      advertiser: { id: raw.advertiserId ?? 6349, name: "A Ltd" },
      type: raw.type ?? "promotion",
      voucherCode: raw.voucherCode ?? null,
      status: raw.status ?? "active",
      title: raw.title ?? "20% off everything",
      ...(raw.url === undefined ? {} : { url: raw.url }),
    },
  };
}

function uniqueViolation(target) {
  const error = new Error(`Unique constraint failed on the fields: (${target.join(",")})`);
  error.code = "P2002";
  error.meta = { target };
  return error;
}

/**
 * @param {object} opts
 * @param {number} [opts.gateInitialLookups] hold the first N findByEntityId calls until all N have
 *   arrived, then answer each from the store as it was BEFORE any of them wrote — the interleaving
 *   in which two workers both decide to create.
 * @param {string[]} [opts.missFirstLookupFor] entity ids whose FIRST findByEntityId returns null even
 *   if a row exists — a row committed between the lookup and the create.
 * @param {number} [opts.forceViolationsOnCreate] make the next N creates throw P2002 without writing.
 */
function harness({ seed = [], gateInitialLookups = 0, missFirstLookupFor = [], forceViolationsOnCreate = 0 } = {}) {
  const rows = [...seed];
  const calls = { findByEntityId: 0, findByNaturalKey: 0, create: 0, update: 0 };
  const failures = [];
  let seq = 0;
  let forcedViolations = forceViolationsOnCreate;
  const missed = new Set();

  const gate = { waiting: [], arrived: 0, snapshot: null };
  function gatedLookup(entityId) {
    gate.arrived += 1;
    if (gate.snapshot == null) gate.snapshot = rows.map((r) => ({ ...r }));
    return new Promise((resolve) => {
      gate.waiting.push(() => resolve(gate.snapshot.find((r) => r.entityId === entityId) ?? null));
      if (gate.arrived === gateInitialLookups) {
        for (const release of gate.waiting.splice(0)) release();
      }
    });
  }

  const couponRepo = {
    findByEntityId: async (entityId) => {
      calls.findByEntityId += 1;
      if (gateInitialLookups && gate.arrived < gateInitialLookups) return gatedLookup(entityId);
      if (missFirstLookupFor.includes(entityId) && !missed.has(entityId)) {
        missed.add(entityId);
        return null;
      }
      return rows.find((r) => r.entityId === entityId) ?? null;
    },
    findByNaturalKey: async ({ supplierCampaignId, couponType, couponCode, couponLink }) => {
      calls.findByNaturalKey += 1;
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
      calls.create += 1;
      if (forcedViolations > 0) {
        forcedViolations -= 1;
        throw uniqueViolation(["entityId"]);
      }
      const entityId = data.entity?.connect?.id ?? null;
      // supplier_coupons_entityId_key: NULLs are distinct, non-null entityIds are unique.
      if (entityId != null && rows.some((r) => r.entityId === entityId)) {
        throw uniqueViolation(["entityId"]);
      }
      seq += 1;
      const row = {
        id: `sc-${seq}`,
        ...data,
        supplierCampaignId: data.supplierCampaign?.connect?.id ?? null,
        entityId,
      };
      rows.push(row);
      return row;
    },
    update: async (id, data) => {
      calls.update += 1;
      const row = rows.find((r) => r.id === id);
      assert.ok(row, `update of unknown row ${id}`);
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
      findByBusinessKey: async () => ({ id: PARENT }),
      findByCampaignName: async () => ({ id: PARENT }),
    },
    couponRepo,
    outboxWriter: { append: async () => ({ id: "outbox" }) },
    mapperErrorRepo: {
      findOpenByEntityId: async () => null,
      updateStatus: async (id, status) => ({ id, status }),
      create: async (data) => {
        failures.push(data);
        return { id: `me-${failures.length}`, ...data };
      },
    },
  });

  return {
    rows,
    calls,
    failures,
    promote: (entity) => service.promoteEntity(entity),
    rowsFor: (entity) => rows.filter((r) => r.entityId === entity.id),
  };
}

describe("supplier coupon entity identity — runtime behaviour under supplier_coupons_entityId_key", () => {
  it("A. the same entity promoted twice: created, then updated, one row", async () => {
    const h = harness();
    const entity = awinOffer(4105429, { url: SHARED_LINK });

    const first = await h.promote(entity);
    const second = await h.promote(entity);

    assert.equal(first.result, "created");
    assert.equal(second.result, "updated");
    assert.equal(h.rows.length, 1);
    assert.equal(h.rowsFor(entity).length, 1);
    assert.equal(h.calls.create, 1);
  });

  it("B. concurrent promotion of one entity: both see no row, the second create hits P2002, re-reads by entityId, updates, one row", async () => {
    const h = harness({ gateInitialLookups: 2 });
    const entity = awinOffer(4105429, { url: SHARED_LINK });

    const [a, b] = await Promise.all([h.promote(entity), h.promote(entity)]);

    const results = [a.result, b.result].sort();
    assert.deepEqual(results, ["created", "updated"], "one create wins, the other converges by update");
    assert.equal(h.rows.length, 1, "the unique index makes the race converge on one row");
    assert.equal(h.rowsFor(entity).length, 1);
    assert.equal(h.calls.create, 2, "both workers attempted a create");
    assert.equal(h.calls.update, 1, "the loser updated after its re-read");
    assert.ok(h.calls.findByEntityId >= 3, "the loser re-read by entityId after the violation");
    assert.equal(h.failures.length, 0, "neither outcome is a failure");
  });

  it("C. two distinct entities under one parent sharing the same couponLink keep two rows", async () => {
    const h = harness();
    const first = awinOffer(4105429, { type: "promotion", url: SHARED_LINK });
    const second = awinOffer(4105430, { type: "voucher", url: SHARED_LINK });

    const a = await h.promote(first);
    const b = await h.promote(second);

    assert.equal(a.result, "created");
    assert.equal(b.result, "created");
    assert.equal(h.rows.length, 2);
    assert.equal(new Set(h.rows.map((r) => r.couponLink)).size, 1, "both rows share the link");
    assert.equal(new Set(h.rows.map((r) => r.entityId)).size, 2, "each entity owns its own row");
    assert.equal(h.failures.length, 0);
  });

  it("D. two distinct entities under one parent sharing the same couponCode keep two rows", async () => {
    const h = harness();
    const first = awinOffer(4200001, { voucherCode: "SAVE20" });
    const second = awinOffer(4200002, { voucherCode: "SAVE20" });

    const a = await h.promote(first);
    const b = await h.promote(second);

    assert.equal(a.result, "created");
    assert.equal(b.result, "created");
    assert.equal(h.rows.length, 2);
    for (const row of h.rows) assert.equal(row.couponCode, "SAVE20");
    assert.equal(new Set(h.rows.map((r) => r.entityId)).size, 2);
    assert.equal(h.failures.length, 0);
  });

  it("E. after P2002 the re-read by entityId updates this entity's own row and never steals another entity's natural-key row", async () => {
    const other = awinOffer(4105429, { url: SHARED_LINK });
    const mine = awinOffer(4105430, { url: SHARED_LINK });
    const h = harness({ missFirstLookupFor: [mine.id] });

    assert.equal((await h.promote(other)).result, "created");
    assert.equal((await h.promote(mine)).result, "created");
    const otherRow = h.rowsFor(other)[0];
    const mineRow = h.rowsFor(mine)[0];
    const otherBefore = { ...otherRow };

    // Re-promote "mine": its first lookup misses its own row (committed between lookup and create),
    // the natural key finds "other"'s row, which is owned by another entity and must not be adopted,
    // the create hits the unique index, and the race branch re-reads by entityId.
    const out = await h.promote(mine);

    assert.equal(out.result, "updated");
    assert.equal(out.record.id, mineRow.id, "the update targets this entity's own row");
    assert.equal(h.rows.length, 2);
    assert.deepEqual(
      { id: otherRow.id, entityId: otherRow.entityId, supplierCouponId: otherRow.supplierCouponId },
      { id: otherBefore.id, entityId: otherBefore.entityId, supplierCouponId: otherBefore.supplierCouponId },
      "the other entity's row is untouched",
    );
    assert.equal(h.failures.length, 0);
  });

  it("F. a P2002 with no entity-owned row and no adoptable natural-key row is not swallowed: PROMOTION_FAILED, nothing persisted", async () => {
    const stranger = awinOffer(4105429, { url: SHARED_LINK });
    const mine = awinOffer(4105430, { url: SHARED_LINK });
    const h = harness();

    assert.equal((await h.promote(stranger)).result, "created");
    // Force the violation on the next create: the store has no row for "mine", and the only
    // natural-key match belongs to "stranger", so nothing may be adopted.
    const h2 = harness({ seed: [...h.rows], forceViolationsOnCreate: 1 });

    const out = await h2.promote(mine);

    assert.equal(out.result, "failed");
    assert.equal(out.error.code, "PROMOTION_FAILED");
    assert.match(out.error.message, /Unique constraint failed/);
    assert.equal(h2.rows.length, 1, "nothing was persisted for the failed entity");
    assert.equal(h2.rowsFor(mine).length, 0);
    assert.equal(h2.rows[0].entityId, stranger.id, "the stranger's row was not overwritten");
    assert.equal(h2.failures.length, 1, "the failure is recorded as a mapper error");
    assert.equal(h2.failures[0].errorCode, "PROMOTION_FAILED");
    assert.equal(h2.failures[0].entityId, mine.id);
    assert.equal(h2.failures[0].status, "OPEN");
  });
});
