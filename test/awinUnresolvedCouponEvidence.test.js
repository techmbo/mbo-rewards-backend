/**
 * An Awin promotion we cannot name is still a promotion Awin sent us.
 *
 * The identity fix made an unresolvable Awin coupon fail closed, which was right for the Entity:
 * a positional index is remapped by supplier ordering, and a bare voucher code is shared between
 * advertisers, so either one silently merges or churns real promotions. But failing closed dropped
 * the row entirely, and RawPayload is the append-only supplier evidence store. A payload that
 * reached us and was then refused is exactly the payload an operator needs to see.
 *
 * So: no Entity, but one immutable RawPayload row, FAILED, unlinked, under an id derived from the
 * payload rather than guessed from it. Nothing is invented — not the voucher code, not a position,
 * not an advertiser id.
 *
 * These tests drive the REAL staging path with stubbed Prisma delegates, so every assertion is
 * about rows actually written and Entities actually created.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entityStagingBarrier } from "../src/jobs/entityStagingBarrier.js";
import { prisma } from "../src/database/prisma.js";
import {
  upsertManyRawEntities,
  buildAwinCouponExternalId,
  buildUnresolvedAwinCouponEvidenceExternalId,
  isUnresolvedAwinCouponEvidenceId,
} from "../src/modules/raw/raw.service.js";

/* ------------------------------------------------------------------------------- the harness */

function countingBarrierDb() {
  const calls = { created: 0, released: 0 };
  return {
    calls,
    jobRun: {
      async create({ data }) {
        calls.created += 1;
        return { id: `ticket-${calls.created}`, ...data };
      },
      async findMany() {
        return [];
      },
      async findFirst() {
        return null;
      },
      async updateMany() {
        calls.released += 1;
        return { count: 1 };
      },
      async update() {
        return {};
      },
    },
  };
}

function stubPrisma() {
  const state = { entities: new Map(), raws: new Map(), rawById: new Map(), rawCreates: 0 };
  const ekey = (e, n, t) => `${e}|${n}|${t}`;
  const rkey = (w) =>
    [w.supplier, w.sourceAccountLabel, w.resourceKey, w.externalId, w.payloadHash].join("\u0000");

  const entity = {
    async findUnique({ where }) {
      const k = where.externalId_networkSource_entityType;
      return state.entities.get(ekey(k.externalId, k.networkSource, k.entityType)) ?? null;
    },
    async findFirst({ where }) {
      if (!where?.externalId) return null;
      return state.entities.get(ekey(where.externalId, where.networkSource, where.entityType)) ?? null;
    },
    async findMany({ where }) {
      const wanted = new Set(where?.externalId?.in ?? []);
      return [...state.entities.values()]
        .filter((r) => wanted.has(r.externalId))
        .map((r) => ({ id: r.id, externalId: r.externalId }));
    },
    async create({ data }) {
      const row = { id: `entity-${state.entities.size + 1}`, ...data };
      state.entities.set(ekey(data.externalId, data.networkSource, data.entityType), row);
      return row;
    },
    async update({ where, data }) {
      for (const [k, r] of state.entities) {
        if (r.id === where.id) {
          const next = { ...r, ...data };
          state.entities.set(k, next);
          return next;
        }
      }
      return { id: where.id, ...data };
    },
    async upsert({ where, create }) {
      const k = where.externalId_networkSource_entityType;
      const existing = state.entities.get(ekey(k.externalId, k.networkSource, k.entityType));
      if (existing) return existing;
      const row = { id: `entity-${state.entities.size + 1}`, ...create };
      state.entities.set(ekey(k.externalId, k.networkSource, k.entityType), row);
      return row;
    },
  };

  const rawPayload = {
    async findUnique({ where }) {
      const k = where.supplier_sourceAccountLabel_resourceKey_externalId_payloadHash;
      return state.raws.get(rkey(k)) ?? null;
    },
    async findFirst() {
      return null;
    },
    async create({ data }) {
      state.rawCreates += 1;
      const row = { id: `raw-${state.rawCreates}`, ...data };
      state.raws.set(
        rkey({
          supplier: data.supplier,
          sourceAccountLabel: data.sourceAccountLabel,
          resourceKey: data.resourceKey,
          externalId: data.externalId,
          payloadHash: data.payloadHash,
        }),
        row,
      );
      state.rawById.set(row.id, row);
      return row;
    },
    async update({ where, data }) {
      const row = state.rawById.get(where.id);
      if (row) Object.assign(row, data);
      return row ?? { id: where.id, ...data };
    },
    async updateMany() {
      return { count: 0 };
    },
  };

  const sourceSchemaStats = { async upsert() { return { id: "s" }; } };
  const fieldRegistry = { async upsert() { return { id: "f" }; } };
  const $executeRaw = async () => 1;

  return { state, delegates: { entity, rawPayload, sourceSchemaStats, fieldRegistry, $executeRaw } };
}

async function withStubs(fn) {
  const barrierDb = countingBarrierDb();
  const { state, delegates } = stubPrisma();
  const originalBarrierDb = entityStagingBarrier.db;
  const originals = {};
  for (const n of Object.keys(delegates)) originals[n] = prisma[n];
  entityStagingBarrier.db = barrierDb;
  for (const [n, d] of Object.entries(delegates)) prisma[n] = d;
  try {
    const returned = await fn({ state });
    return { state, barrier: barrierDb.calls, returned };
  } finally {
    entityStagingBarrier.db = originalBarrierDb;
    for (const [n, o] of Object.entries(originals)) prisma[n] = o;
  }
}

/* ------------------------------------------------------------------------------------ rows */

/** A well-formed Awin promotion: nested advertiser.id and a promotionId. */
const promotion = (advertiserId, promotionId) => ({
  promotionId,
  advertiser: { id: advertiserId, name: "ZZADVERTISERZZ" },
  voucher: { code: "ZZSAVE10ZZ" },
  type: "voucher",
});

/** An Awin promotion missing one half of the identity. */
const unresolvable = (overrides = {}) => ({
  advertiser: { name: "ZZADVERTISERZZ" },
  voucher: { code: "ZZSAVE10ZZ" },
  type: "voucher",
  ...overrides,
});

const stageAwin = (rows, sourceAccountKey = null) =>
  upsertManyRawEntities({
    networkSource: "awin",
    entityType: "coupon",
    rows,
    externalIdPrefix: "awin-coupon",
    sourceAccountKey,
  });

const raws = (state) => [...state.raws.values()];

/* ================================================== 1. evidence is written, Entity is not */

describe("an unresolved Awin promotion leaves evidence and no Entity", () => {
  it("writes exactly one RawPayload row and creates no Entity", async () => {
    const { state } = await withStubs(() => stageAwin([unresolvable()]));
    assert.equal(state.entities.size, 0, "an Entity was created for an unnameable promotion");
    assert.equal(raws(state).length, 1, "expected exactly one evidence row");
    assert.equal(state.rawCreates, 1);
  });

  it("the evidence row is FAILED and carries no entity link", async () => {
    const { state } = await withStubs(() => stageAwin([unresolvable()]));
    const [row] = raws(state);
    assert.equal(row.processingStatus, "FAILED", "evidence must not look like work in progress");
    assert.ok(!row.entityId, "evidence was linked to an entity");
  });

  it("the row is missing either half of the identity, and both fail the same way", async () => {
    for (const row of [
      unresolvable(),                                        // no promotionId
      unresolvable({ promotionId: 55 , advertiser: {} }),    // no advertiser.id
      unresolvable({ promotionId: 55, advertiser: null }),
      unresolvable({ promotionId: "", advertiser: { id: 9 } }),
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { state } = await withStubs(() => stageAwin([row]));
      assert.equal(state.entities.size, 0, "an Entity was staged under a weak identity");
      assert.equal(raws(state).length, 1, "the payload was dropped instead of recorded");
      assert.equal(raws(state)[0].processingStatus, "FAILED");
    }
  });

  it("the failure reason is a code, and no row content travels with it", async () => {
    const { state } = await withStubs(() => stageAwin([unresolvable()]));
    const [row] = raws(state);
    const meta = JSON.stringify(row.metadata ?? {});
    assert.match(meta, /identity_resolution_failed/);
    for (const forbidden of ["ZZSAVE10ZZ", "ZZADVERTISERZZ"]) {
      assert.ok(!meta.includes(forbidden), `metadata leaked ${forbidden}`);
    }
  });
});

/* =========================================== 2. the evidence id: deterministic, never colliding */

describe("the evidence-only externalId", () => {
  it("is deterministic for the same payload", async () => {
    const row = unresolvable();
    const a = buildUnresolvedAwinCouponEvidenceExternalId(row);
    const b = buildUnresolvedAwinCouponEvidenceExternalId({ ...row });
    assert.equal(a, b);
    // Key order must not matter: the hash canonicalizes before serializing.
    const reordered = { type: row.type, voucher: row.voucher, advertiser: row.advertiser };
    assert.equal(buildUnresolvedAwinCouponEvidenceExternalId(reordered), a);
  });

  it("differs for different payloads", () => {
    const a = buildUnresolvedAwinCouponEvidenceExternalId(unresolvable());
    const b = buildUnresolvedAwinCouponEvidenceExternalId(unresolvable({ type: "discount" }));
    assert.notEqual(a, b);
  });

  it("can never equal a canonical awin-coupon-<advertiser.id>-<promotionId> id", () => {
    // Structural, not incidental: a canonical id's third segment is always bare digits, and the
    // evidence id's third segment is always the word `unresolved`.
    for (const [adv, promo] of [[1, 2], [999, 1000], [0, 0], ["7", "8"]]) {
      const canonical = buildAwinCouponExternalId({ advertiser: { id: adv }, promotionId: promo });
      assert.ok(canonical, `a legitimate id was refused: ${adv}/${promo}`);
      assert.equal(canonical.split("-")[2], String(adv));
      assert.ok(!isUnresolvedAwinCouponEvidenceId(canonical), "a canonical id read as evidence");
    }
    const evidence = buildUnresolvedAwinCouponEvidenceExternalId(unresolvable());
    assert.equal(evidence.split("-")[2], "unresolved");
    assert.ok(isUnresolvedAwinCouponEvidenceId(evidence));
  });

  it("a payload that tries to forge the evidence prefix is refused, not accepted", () => {
    // The only way to reach `awin-coupon-unresolved-...` canonically would be a non-numeric
    // advertiser id. That is refused outright, so the namespace cannot be entered from outside.
    assert.equal(buildAwinCouponExternalId({ advertiser: { id: "unresolved" }, promotionId: 5 }), null);
    assert.equal(buildAwinCouponExternalId({ advertiser: { id: 5 }, promotionId: "unresolved" }), null);
    assert.equal(buildAwinCouponExternalId({ advertiser: { id: "1-2" }, promotionId: 3 }), null);
    assert.equal(buildAwinCouponExternalId({ advertiser: { id: " 12 " }, promotionId: 3 }), "awin-coupon-12-3");
  });

  it("never carries the voucher code, advertiser name or a row position", async () => {
    const { state } = await withStubs(() => stageAwin([unresolvable(), unresolvable({ type: "x" })]));
    for (const row of raws(state)) {
      assert.ok(!row.externalId.includes("ZZSAVE10ZZ"), "the voucher code became identity");
      assert.ok(!row.externalId.includes("ZZADVERTISERZZ"), "the advertiser name became identity");
      assert.match(row.externalId, /^awin-coupon-unresolved-[0-9a-f]{64}$/);
    }
  });

  it("is still account-namespaced", async () => {
    const { state } = await withStubs(() => stageAwin([unresolvable()], "uk"));
    const [row] = raws(state);
    assert.match(row.externalId, /^uk:awin-coupon-unresolved-[0-9a-f]{64}$/);
    assert.ok(isUnresolvedAwinCouponEvidenceId(row.externalId), "namespacing hid the evidence marker");
  });
});

/* ================================================================= 3. idempotent re-ingestion */

describe("re-ingesting the same unresolved payload", () => {
  it("does not create a second evidence row", async () => {
    const { state } = await withStubs(async () => {
      await stageAwin([unresolvable()]);
      await stageAwin([unresolvable()]);
      await stageAwin([unresolvable()]);
    });
    assert.equal(raws(state).length, 1, "duplicate evidence rows were written");
    assert.equal(state.rawCreates, 1, "the payload was re-created instead of recognised");
    assert.equal(state.entities.size, 0);
  });

  it("two DIFFERENT unresolved payloads each get their own row", async () => {
    const { state } = await withStubs(() =>
      stageAwin([unresolvable(), unresolvable({ type: "discount" })]),
    );
    assert.equal(raws(state).length, 2);
    assert.equal(new Set(raws(state).map((r) => r.externalId)).size, 2);
    assert.equal(state.entities.size, 0);
  });
});

/* ============================================================ 4. valid rows are wholly unaffected */

describe("valid Awin promotions still stage normally", () => {
  it("uses the canonical identity and reaches STAGED with an entityId", async () => {
    const { state } = await withStubs(() => stageAwin([promotion(11, 22)]));
    assert.equal(state.entities.size, 1);
    const [entity] = [...state.entities.values()];
    assert.equal(entity.externalId, "awin-coupon-11-22");
    const [row] = raws(state);
    assert.equal(row.processingStatus, "STAGED");
    assert.equal(row.entityId, entity.id);
  });

  it("a mixed batch stages the good rows and records only the bad ones as evidence", async () => {
    const { state, barrier } = await withStubs(() =>
      stageAwin([promotion(1, 2), unresolvable(), promotion(3, 4)]),
    );
    assert.equal(state.entities.size, 2, "a valid promotion was lost alongside the invalid one");
    const staged = raws(state).filter((r) => r.processingStatus === "STAGED");
    const failed = raws(state).filter((r) => r.processingStatus === "FAILED");
    assert.equal(staged.length, 2);
    assert.equal(failed.length, 1);
    for (const row of staged) assert.ok(row.entityId, "a staged row lost its entity link");
    for (const row of failed) assert.ok(!row.entityId, "an evidence row gained an entity link");
    // Fix A: one participant for the whole batch, invalid rows included.
    assert.equal(barrier.created, 1);
    assert.equal(barrier.released, 1);
  });

  it("the evidence row is never lifted to STAGED by the relink pass", async () => {
    const { state } = await withStubs(() => stageAwin([promotion(5, 6), unresolvable()]));
    const failed = raws(state).find((r) => r.processingStatus === "FAILED");
    assert.ok(failed, "the evidence row vanished");
    assert.ok(!failed.entityId);
    assert.equal(failed.processingStatus, "FAILED");
  });
});

/* ====================================================== 5. non-Awin coupons are untouched */

describe("non-Awin coupon behaviour is unchanged", () => {
  const trackierRow = (i) => ({ id: `zzt${i}`, record_source: "coupon", code: `ZZC${i}`, campaign_id: 7 });

  it("Trackier coupons stage exactly as before, with no evidence path involved", async () => {
    const { state, barrier } = await withStubs(() =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "coupon",
        rows: [trackierRow(1), trackierRow(2), trackierRow(3)],
        externalIdPrefix: "trackier-coupon",
        sourceAccountKey: null,
      }),
    );
    assert.equal(state.entities.size, 3);
    assert.equal(raws(state).length, 3);
    for (const row of raws(state)) {
      assert.equal(row.processingStatus, "STAGED");
      assert.ok(row.entityId);
      assert.ok(!isUnresolvedAwinCouponEvidenceId(row.externalId));
    }
    assert.equal(barrier.created, 1, "Fix A changed for Trackier");
  });

  it("a Trackier row with no obvious id still stages — the Awin rule does not reach it", async () => {
    const { state } = await withStubs(() =>
      upsertManyRawEntities({
        networkSource: "trackier",
        entityType: "coupon",
        rows: [{ record_source: "coupon", code: "ZZONLYCODEZZ" }],
        externalIdPrefix: "trackier-coupon",
        sourceAccountKey: null,
      }),
    );
    assert.equal(state.entities.size, 1, "a Trackier coupon was refused by the Awin rule");
    assert.equal(raws(state)[0].processingStatus, "STAGED");
  });

  it("an Awin voucher fanned out of a campaign payload is not held to the Awin promotion rule", async () => {
    // record_source takes it off the promotion rule, exactly as the identity commit intended.
    const { state } = await withStubs(() =>
      upsertManyRawEntities({
        networkSource: "awin",
        entityType: "coupon",
        rows: [{ record_source: "coupon", id: "zzemb1", code: "ZZEMBZZ" }],
        externalIdPrefix: "awin-coupon",
        sourceAccountKey: null,
      }),
    );
    assert.equal(state.entities.size, 1, "an embedded voucher was failed closed");
    assert.equal(raws(state)[0].processingStatus, "STAGED");
  });
});
