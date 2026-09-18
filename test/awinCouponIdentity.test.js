/**
 * Phase 9A.0b-v1 — Awin coupon Entity identity, and the migration of the rows that predate it.
 *
 * Production FieldRegistry settled what Awin promotion rows actually carry: `promotionId` and
 * nested `advertiser.id`, both non-null on 100% of observed rows, and no top-level `id`, `_id`,
 * `advertiserId`, `voucherCode` or `code` at all. `voucher.code` exists on 28.25% and is nullable.
 *
 * So every staged Awin coupon took resolveExternalId's positional `awin-coupon-${index}` fallback,
 * which any change in supplier ordering remaps onto a different promotion — or, where a flat code
 * had been assumed, the bare voucher code, which two advertisers can share and which therefore
 * collapses two promotions into one Entity under @@unique([externalId, networkSource, entityType]).
 *
 * The identity is now the composite. These tests pin both halves of that claim: that the composite
 * is stable under the things that used to move it, and that nothing weak is left as a fallback.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  buildAwinCouponExternalId,
  resolveExternalId,
  usesAwinCouponIdentity,
} from "../src/modules/raw/raw.service.js";
import {
  migrateAwinCouponIdentity,
  planRow,
  splitAccountLabel,
} from "../scripts/migrate-awin-coupon-identity.mjs";

const RAW_SRC = readFileSync(new URL("../src/modules/raw/raw.service.js", import.meta.url), "utf8");
const MIGRATION_SRC = readFileSync(
  new URL("../scripts/migrate-awin-coupon-identity.mjs", import.meta.url),
  "utf8",
);

/** An Awin promotion row in the shape production observes: nested advertiser, top-level promotionId. */
const promotion = ({ advertiserId = 998877, promotionId = 556677, code = "ZZCODEZZ" } = {}) => ({
  promotionId,
  advertiser: { id: advertiserId, name: "zzadvertisernamezz" },
  type: "voucher",
  ...(code === null ? {} : { voucher: { code } }),
  url: "https://www.awin1.com/cread.php?zzcreadzz",
});

/* ======================================================================= the identity itself */

describe("9A.0b-v1 — the canonical Awin coupon identity", () => {
  it("is advertiser.id + promotionId, from the two fields production always sends", () => {
    assert.equal(buildAwinCouponExternalId(promotion()), "awin-coupon-998877-556677");
  });

  it("is stable when the supplier reorders its rows", () => {
    const rows = [promotion({ promotionId: 1 }), promotion({ promotionId: 2 }), promotion({ promotionId: 3 })];
    const first = rows.map((row) => buildAwinCouponExternalId(row));
    const reordered = [rows[2], rows[0], rows[1]].map((row) => buildAwinCouponExternalId(row));
    assert.deepEqual(first, ["awin-coupon-998877-1", "awin-coupon-998877-2", "awin-coupon-998877-3"]);
    // The positional identity moved promotion 1 from index 0 to index 1 and renamed it. This must not.
    assert.equal(reordered[1], first[0], "promotion 1 changed identity when the order changed");
    assert.equal(reordered[2], first[1]);
    assert.equal(reordered[0], first[2]);
  });

  it("is stable when a promotion moves to another page of the walk", () => {
    // Page 1 index 199 and page 2 index 0 are the same promotion on two different syncs.
    const row = promotion({ promotionId: 4242 });
    assert.equal(buildAwinCouponExternalId(row), buildAwinCouponExternalId({ ...row }));
    assert.equal(buildAwinCouponExternalId(row), "awin-coupon-998877-4242");
  });

  it("keeps two advertisers sharing one voucher code APART", () => {
    // The defect this replaces: both of these resolved to the bare string "SAVE10", so the second
    // overwrote the first under the Entity unique key.
    const a = promotion({ advertiserId: 111, promotionId: 1, code: "SAVE10" });
    const b = promotion({ advertiserId: 222, promotionId: 2, code: "SAVE10" });
    assert.equal(buildAwinCouponExternalId(a), "awin-coupon-111-1");
    assert.equal(buildAwinCouponExternalId(b), "awin-coupon-222-2");
    assert.notEqual(buildAwinCouponExternalId(a), buildAwinCouponExternalId(b));

    // Both ways the old rule could go, and both were wrong. On the shape production actually
    // sends — code nested under `voucher` — it fell to the POSITIONAL id, so the two promotions
    // swap identity whenever the supplier reorders.
    assert.equal(resolveExternalId(a, "awin-coupon", 0, "coupon"), "awin-coupon-0");
    assert.equal(resolveExternalId(b, "awin-coupon", 0, "coupon"), "awin-coupon-0", "same index, same id");
    // And on the flat shape the mapper had assumed, it fell to the bare code, which collapses two
    // advertisers' promotions into ONE Entity under @@unique([externalId, networkSource, entityType]).
    const flatA = { advertiserId: 111, promotionId: 1, voucherCode: "SAVE10" };
    const flatB = { advertiserId: 222, promotionId: 2, voucherCode: "SAVE10" };
    assert.equal(resolveExternalId(flatA, "awin-coupon", 0, "coupon"), "SAVE10");
    assert.equal(resolveExternalId(flatB, "awin-coupon", 1, "coupon"), "SAVE10", "the old rule collapsed them");
  });

  it("gives a code-less promotion a real identity, not a positional one", () => {
    const deal = promotion({ promotionId: 909, code: null });
    assert.equal(deal.voucher, undefined);
    assert.equal(buildAwinCouponExternalId(deal), "awin-coupon-998877-909");
    assert.equal(resolveExternalId(deal, "awin-coupon", 7, "coupon"), "awin-coupon-7", "the old rule was positional");
  });

  it("the code is content and is never part of the identity", () => {
    const before = promotion({ code: "ZZFIRSTZZ" });
    const after = promotion({ code: "ZZSECONDZZ" });
    assert.equal(buildAwinCouponExternalId(before), buildAwinCouponExternalId(after));
    assert.ok(!buildAwinCouponExternalId(before).includes("ZZFIRSTZZ"));
  });

  it("fails CLOSED when either half is missing — no positional, code or generic fallback", () => {
    for (const row of [
      { promotionId: 556677 },
      { promotionId: 556677, advertiser: {} },
      { promotionId: 556677, advertiser: { id: null } },
      { promotionId: 556677, advertiser: { id: "  " } },
      { advertiser: { id: 998877 } },
      { advertiser: { id: 998877 }, promotionId: null },
      { advertiser: { id: 998877 }, promotionId: "" },
      {},
      null,
      undefined,
    ]) {
      assert.equal(buildAwinCouponExternalId(row), null, JSON.stringify(row));
    }
    // Specifically: a row with a code but no promotionId must NOT fall back to the code.
    assert.equal(buildAwinCouponExternalId({ advertiser: { id: 1 }, voucher: { code: "SAVE10" } }), null);
    // And one with neither must NOT fall back to an index.
    assert.equal(buildAwinCouponExternalId({ type: "deal" }), null);
  });

  it("ids are stringified, and only an ABSENT or blank one fails closed", () => {
    // 0 is a legal identifier. Failing it closed would drop a real row on a cosmetic judgement,
    // which is the opposite of what fail-closed is for — that guards MISSING identity, not odd
    // identity. Emptiness is the test, not truthiness of the number.
    assert.equal(buildAwinCouponExternalId(promotion({ advertiserId: 0, promotionId: 1 })), "awin-coupon-0-1");
    assert.equal(buildAwinCouponExternalId(promotion({ advertiserId: 1, promotionId: 0 })), "awin-coupon-1-0");
    assert.equal(buildAwinCouponExternalId(promotion({ advertiserId: "998877", promotionId: "556677" })),
      "awin-coupon-998877-556677", "string ids resolve the same as numbers");
    assert.equal(buildAwinCouponExternalId(promotion({ advertiserId: "  998877  ", promotionId: 556677 })),
      "awin-coupon-998877-556677", "surrounding whitespace is not part of the identity");
  });
});

/* =================================================== which rows the rule applies to, and where */

describe("9A.0b-v1 — the rule is scoped to Awin promotion rows only", () => {
  it("applies to awin coupons and to nothing else", () => {
    assert.equal(usesAwinCouponIdentity("awin", promotion()), true);
    assert.equal(usesAwinCouponIdentity("AWIN", promotion()), true, "case must not matter");
    for (const network of ["trackier", "boostiny", "cj", "admitad", "optimise_sea", "impact", "rakuten", "partnerize"]) {
      assert.equal(usesAwinCouponIdentity(network, promotion()), false, network);
    }
  });

  it("does NOT apply to vouchers fanned out of a campaign payload", () => {
    // collectEmbeddedCouponsFromCampaigns stamps record_source and produces a different shape.
    // Failing those closed would drop rows that stage correctly today.
    const embedded = { record_source: "coupon", id: "zz99zz", voucher_code: "ZZZ", campaign_id: 5 };
    assert.equal(usesAwinCouponIdentity("awin", embedded), false);
    assert.equal(resolveExternalId(embedded, "awin-coupon", 0, "coupon"), "awin-coupon-coupon-zz99zz");
  });

  it("both coupon staging paths use ONE resolver, so lineage and the Entity cannot disagree", () => {
    // upsertCouponRows writes the Entity; stageManyRawEntities writes RawPayload lineage. They
    // computed the identity independently, and only one of them was ever passed entityType.
    assert.equal((RAW_SRC.match(/resolveCouponEntityExternalId\(/g) ?? []).length, 3, "one definition, two call sites");
    // Sliced between this declaration and the next top-level one: the parameter list contains its
    // own closing brace, so splitting on it would cut the body off before it starts.
    const start = RAW_SRC.indexOf("async function upsertCouponRows(");
    const next = RAW_SRC.indexOf("\nasync function ", start + 1);
    const coupons = RAW_SRC.slice(start, next > start ? next : undefined);
    assert.ok(coupons.length > 500, "the slice did not capture the function body");
    // Whitespace-tolerant: this call sits one branch deeper than it did when the assertion was
    // written, so it now wraps. The argument order is what matters and is still pinned exactly.
    assert.match(
      coupons,
      /resolveCouponEntityExternalId\(\s*networkSource,\s*row,\s*externalIdPrefix,\s*index,?\s*\)/,
    );
    assert.ok(!/[^y]resolveExternalId\(/.test(coupons), "the Entity path still resolves identity itself");
  });

  it("a row that fails closed is skipped by BOTH paths, and warned about once each", () => {
    assert.equal((RAW_SRC.match(/coupon row skipped — missing supplier identity/g) ?? []).length, 2);
    const staging = RAW_SRC.split("const resolvedId = useOptimiseCampaignIds")[1].split("const externalId")[0];
    assert.match(staging, /if \(entityType === "coupon" && !resolvedId\) \{/);
    assert.match(staging, /if \(entityType === "conversion" && !resolvedId\) \{/, "the conversion guard is untouched");
  });

  it("account-label namespacing is still applied afterwards, unchanged", () => {
    assert.match(RAW_SRC, /withAccountScopedExternalId\(resolvedId, sourceAccountKey\)/);
    assert.match(RAW_SRC, /function withAccountScopedExternalId\(externalId, sourceAccountKey\) \{/);
    assert.deepEqual(splitAccountLabel("uk:awin-coupon-1-2"), { prefix: "uk:", local: "awin-coupon-1-2" });
    assert.deepEqual(splitAccountLabel("awin-coupon-1-2"), { prefix: "", local: "awin-coupon-1-2" });
  });

  it("the supplier payload is never mutated to carry identity", () => {
    const row = promotion();
    const snapshot = JSON.stringify(row);
    buildAwinCouponExternalId(row);
    usesAwinCouponIdentity("awin", row);
    assert.equal(JSON.stringify(row), snapshot, "the raw row was written to");
    assert.ok(!RAW_SRC.includes('rawData.record_source = '), "identity is stamped onto the payload");
  });
});

/* ====================================================================== the legacy migration */

describe("9A.0b-v1 — migrating the rows that predate the identity", () => {
  /** A fake Entity table with just the two operations the migration performs. */
  function fakeDb(rows) {
    const store = rows.map((row) => ({ ...row }));
    const calls = { updates: [], findUnique: 0 };
    return {
      store,
      calls,
      entity: {
        async findMany({ where, select }) {
          assert.deepEqual(where, { networkSource: "awin", entityType: "coupon" }, "scope widened");
          assert.deepEqual(Object.keys(select).sort(), ["externalId", "id", "rawData"]);
          return store
            .filter((row) => row.networkSource === where.networkSource && row.entityType === where.entityType)
            .map((row) => ({ id: row.id, externalId: row.externalId, rawData: row.rawData }));
        },
        async findUnique({ where }) {
          calls.findUnique += 1;
          const key = where.externalId_networkSource_entityType;
          const hit = store.find(
            (row) =>
              row.externalId === key.externalId &&
              row.networkSource === key.networkSource &&
              row.entityType === key.entityType,
          );
          return hit ? { id: hit.id } : null;
        },
        async update({ where, data }) {
          calls.updates.push({ where, data });
          const row = store.find((entry) => entry.id === where.id);
          Object.assign(row, data);
          return row;
        },
      },
    };
  }

  const legacy = (id, externalId, raw, extra = {}) => ({
    id,
    externalId,
    networkSource: "awin",
    entityType: "coupon",
    rawData: raw,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });

  it("dry run is the default and writes nothing", async () => {
    const db = fakeDb([legacy("zzent1zz", "awin-coupon-0", promotion({ promotionId: 1 }))]);
    const summary = await migrateAwinCouponIdentity({ client: db });
    assert.equal(summary.mode, "dry-run");
    assert.equal(summary.updated, 1, "it still reports what it would do");
    assert.deepEqual(db.calls.updates, [], "a dry run wrote to the database");
    assert.equal(db.store[0].externalId, "awin-coupon-0");
    assert.match(MIGRATION_SRC, /const apply = process\.argv\.includes\("--apply"\);/);
  });

  it("--apply updates externalId IN PLACE, preserving id, createdAt and rawData", async () => {
    const raw = promotion({ advertiserId: 111, promotionId: 222 });
    const db = fakeDb([legacy("zzent1zz", "awin-coupon-0", raw)]);
    const summary = await migrateAwinCouponIdentity({ apply: true, client: db });
    assert.equal(summary.updated, 1);
    assert.equal(db.calls.updates.length, 1);
    // Only externalId is written — nothing else may appear in the update payload.
    assert.deepEqual(db.calls.updates[0].data, { externalId: "awin-coupon-111-222" });
    assert.deepEqual(Object.keys(db.calls.updates[0].where), ["id"], "matched by anything but the primary key");
    const row = db.store[0];
    assert.equal(row.id, "zzent1zz", "Entity.id changed — every reference would have been orphaned");
    assert.equal(row.createdAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(row.rawData, raw);
  });

  it("references survive because they point at Entity.id, which never moves", () => {
    // Proven from the schema rather than asserted by hand: no relation targets externalId.
    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    const entity = schema.split("model Entity {")[1].split("\n}")[0];
    assert.match(entity, /id\s+String\s+@id @default\(uuid\(\)\)/);
    assert.match(entity, /@@unique\(\[externalId, networkSource, entityType\]\)/);
    for (const relation of [
      /RawPayload[\s\S]*?entityId\s+String\?[\s\S]*?references: \[id\]/,
      /SupplierCoupon[\s\S]*?entityId\s+String\?[\s\S]*?references: \[id\]/,
      /SupplierCampaign[\s\S]*?entityId\s+String\?[\s\S]*?references: \[id\]/,
    ]) {
      assert.match(schema, relation);
    }
    // And nothing references externalId as a foreign key anywhere.
    assert.ok(!/references: \[externalId\]/.test(schema), "a foreign key targets externalId");
  });

  it("an already-canonical row is skipped, so a re-run is a no-op", async () => {
    const raw = promotion({ advertiserId: 111, promotionId: 222 });
    const db = fakeDb([legacy("zzent1zz", "awin-coupon-0", raw)]);
    await migrateAwinCouponIdentity({ apply: true, client: db });
    const second = await migrateAwinCouponIdentity({ apply: true, client: db });
    assert.equal(second.updated, 0);
    assert.equal(second.alreadyCanonical, 1);
    assert.equal(db.calls.updates.length, 1, "the second run wrote again");
  });

  it("a row missing either identifier is skipped, never given a positional id", async () => {
    const db = fakeDb([
      legacy("zzent1zz", "awin-coupon-0", { type: "deal" }),
      legacy("zzent2zz", "awin-coupon-1", { promotionId: 5 }),
      legacy("zzent3zz", "awin-coupon-2", { advertiser: { id: 9 } }),
    ]);
    const summary = await migrateAwinCouponIdentity({ apply: true, client: db });
    assert.equal(summary.missingIdentifiers, 3);
    assert.equal(summary.updated, 0);
    assert.deepEqual(db.calls.updates, []);
    assert.deepEqual(db.store.map((row) => row.externalId), ["awin-coupon-0", "awin-coupon-1", "awin-coupon-2"]);
  });

  it("a canonical id already held by a DIFFERENT entity is reported, never overwritten", async () => {
    const raw = promotion({ advertiserId: 111, promotionId: 222 });
    const db = fakeDb([
      legacy("zzholderzz", "awin-coupon-111-222", raw),
      legacy("zzlegacyzz", "SAVE10", raw),
    ]);
    const summary = await migrateAwinCouponIdentity({ apply: true, client: db });
    assert.equal(summary.updated, 0);
    assert.deepEqual(summary.conflicts, [{ entityId: "zzlegacyzz", heldBy: "zzholderzz" }]);
    assert.deepEqual(db.calls.updates, [], "a conflicting row was overwritten");
    assert.equal(db.store.find((r) => r.id === "zzlegacyzz").externalId, "SAVE10", "the loser was rewritten");
    assert.equal(db.store.length, 2, "a row was deleted");
  });

  it("a conflict does not stop the rows after it", async () => {
    const collide = promotion({ advertiserId: 111, promotionId: 222 });
    const clean = promotion({ advertiserId: 333, promotionId: 444 });
    const db = fakeDb([
      legacy("zzholderzz", "awin-coupon-111-222", collide),
      legacy("zzlegacyzz", "SAVE10", collide),
      legacy("zzcleanzz", "awin-coupon-9", clean),
    ]);
    const summary = await migrateAwinCouponIdentity({ apply: true, client: db });
    assert.equal(summary.conflicts.length, 1);
    assert.equal(summary.updated, 1);
    assert.equal(db.store.find((r) => r.id === "zzcleanzz").externalId, "awin-coupon-333-444");
  });

  it("an account-scoped row keeps its label prefix", async () => {
    const raw = promotion({ advertiserId: 111, promotionId: 222 });
    const db = fakeDb([legacy("zzent1zz", "uk:awin-coupon-0", raw)]);
    await migrateAwinCouponIdentity({ apply: true, client: db });
    assert.equal(db.store[0].externalId, "uk:awin-coupon-111-222");
  });

  it("no other network and no other entityType is touched", async () => {
    const raw = promotion();
    const db = fakeDb([
      legacy("zzawinzz", "awin-coupon-0", raw),
      { ...legacy("zztrackzz", "awin-coupon-0", raw), networkSource: "trackier" },
      { ...legacy("zzcampzz", "awin-coupon-0", raw), entityType: "campaign" },
      { ...legacy("zzconvzz", "awin-coupon-0", raw), entityType: "conversion" },
    ]);
    const summary = await migrateAwinCouponIdentity({ apply: true, client: db });
    assert.equal(summary.scanned, 1, "the query reached outside awin coupons");
    assert.equal(summary.updated, 1);
    assert.deepEqual(db.calls.updates.map((u) => u.where.id), ["zzawinzz"]);
    for (const id of ["zztrackzz", "zzcampzz", "zzconvzz"]) {
      assert.equal(db.store.find((r) => r.id === id).externalId, "awin-coupon-0", `${id} was modified`);
    }
  });

  it("RawPayload is never written, and nothing is ever deleted", () => {
    for (const forbidden of ["rawPayload", "RawPayload", "delete", "deleteMany", "createMany", "upsert"]) {
      assert.ok(!MIGRATION_SRC.includes(`client.${forbidden}`), `client.${forbidden} in the migration`);
    }
    assert.ok(!MIGRATION_SRC.includes("deleteMany"), "the migration deletes");
    assert.ok(!/\.delete\(/.test(MIGRATION_SRC), "the migration deletes");
    // The only write it makes.
    assert.equal((MIGRATION_SRC.match(/client\.entity\.update\(/g) ?? []).length, 1);
    assert.match(MIGRATION_SRC, /data: \{ externalId: plan\.canonical \}/);
  });

  it("the report carries counts and entity ids only — no external ids, codes or raw rows", async () => {
    const db = fakeDb([
      legacy("zzent1zz", "SAVE10", promotion({ advertiserId: 111, promotionId: 222, code: "ZZSECRETZZ" })),
    ]);
    const summary = await migrateAwinCouponIdentity({ apply: true, client: db });
    const serialised = JSON.stringify(summary);
    for (const value of ["ZZSECRETZZ", "SAVE10", "zzadvertisernamezz", "awin1.com"]) {
      assert.ok(!serialised.includes(value), `${value} escaped into the summary`);
    }
    assert.deepEqual(Object.keys(summary).sort(), [
      "alreadyCanonical", "conflicts", "missingIdentifiers", "mode", "scanned", "updated",
    ]);
  });

  it("planRow is pure: the decision table is testable without a database", () => {
    assert.deepEqual(planRow({ id: "a", externalId: "awin-coupon-0", rawData: promotion({ advertiserId: 1, promotionId: 2 }) }),
      { action: "update", entityId: "a", canonical: "awin-coupon-1-2" });
    assert.equal(planRow({ id: "b", externalId: "awin-coupon-1-2", rawData: promotion({ advertiserId: 1, promotionId: 2 }) }).reason,
      "already_canonical");
    assert.equal(planRow({ id: "c", externalId: "awin-coupon-0", rawData: { type: "deal" } }).reason,
      "missing_identifiers");
  });
});

/* ============================================================= the blast radius of this commit */

describe("9A.0b-v1 — nothing outside identity changed", () => {
  it("the mapper, codeType and coupon promotion are untouched — they are the NEXT commit", () => {
    const mapper = readFileSync(new URL("../src/modules/supplier/mappers/awin.mapper.js", import.meta.url), "utf8");
    // Still reading the flat fields production does not send. Knowingly left for the mapper commit.
    assert.match(mapper, /firstPresent\(raw\.voucherCode, raw\.code, raw\.couponCode\)/);
    assert.match(mapper, /raw\.advertiserId != null \? String\(raw\.advertiserId\) : null/);
    const codeType = readFileSync(new URL("../src/modules/coupons/codeType.js", import.meta.url), "utf8");
    assert.match(codeType, /scalarCode\(rawData\?\.voucherCode\)/);
  });

  it("the other networks' identity rules are byte-for-byte what they were", () => {
    // The generic chain, the Optimise builder and the conversion rule all still decide their own.
    assert.match(RAW_SRC, /export function buildOptimiseCampaignExternalId\(networkSource, rawData, index\)/);
    assert.match(RAW_SRC, /const useOptimiseCampaignIds =\s*entityType === "campaign" && String\(networkSource\)\.startsWith\("optimise_"\);/);
    assert.match(RAW_SRC, /if \(entityType === "conversion"\) \{\s*return resolveConversionEntityExternalId/);
    assert.equal(resolveExternalId({ id: 5 }, "trackier-coupon", 0, "coupon"), "5");
    assert.equal(resolveExternalId({ voucherCode: "X" }, "boostiny-coupon", 0, "coupon"), "X");
    assert.equal(resolveExternalId({}, "cj-coupon", 3, "coupon"), "cj-coupon-3");
  });

  it("no schema change, no planner move, no scheduler touch", () => {
    for (const forbidden of ["ALTER TABLE", "CREATE TABLE", "plannerVersion", "PLANNER_VERSION", "archivedAt"]) {
      assert.ok(!RAW_SRC.includes(forbidden), `${forbidden} in raw.service.js`);
      assert.ok(!MIGRATION_SRC.includes(forbidden), `${forbidden} in the migration`);
    }
  });
});
