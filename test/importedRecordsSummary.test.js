/**
 * ImportedRecordsService.summary() — Network Operations → All Network Data aggregates.
 *
 * Runs the real service (real buildWhere, real needs-review predicate, real summary()) over a fake
 * Prisma that EVALUATES every `where` it is given (AND / OR / NOT, relation some / none, equals /
 * contains / startsWith / in / not, gte / lte on dates) and groups for real. Any access to a model
 * the summary must no longer touch (SupplierCampaign, CampaignSource) throws.
 */
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const { ImportedRecordsService } = await import("../src/modules/ops/importedRecords.service.js");

// ── where evaluator ──────────────────────────────────────────────────────────
const OPERATORS = new Set(["equals", "contains", "startsWith", "endsWith", "in", "not", "mode", "gte", "lte", "gt", "lt", "has", "hasSome", "hasEvery", "isEmpty"]);
const cmp = (v) => (v instanceof Date ? v.getTime() : typeof v === "string" && !Number.isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}/.test(v) ? Date.parse(v) : v);
function matchValue(value, cond) {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) return cmp(value) === cmp(cond);
  const keys = Object.keys(cond);
  if (!keys.every((k) => OPERATORS.has(k))) return value && typeof value === "object" ? matchWhere(value, cond) : false;
  const ci = cond.mode === "insensitive";
  const norm = (v) => (ci && typeof v === "string" ? v.toLowerCase() : v);
  const v = norm(value);
  if ("equals" in cond && v !== norm(cond.equals)) return false;
  if ("contains" in cond && !(typeof v === "string" && v.includes(norm(cond.contains)))) return false;
  if ("startsWith" in cond && !(typeof v === "string" && v.startsWith(norm(cond.startsWith)))) return false;
  if ("endsWith" in cond && !(typeof v === "string" && v.endsWith(norm(cond.endsWith)))) return false;
  if ("in" in cond && !cond.in.map(norm).includes(v)) return false;
  if ("not" in cond && matchValue(value, cond.not)) return false;
  if ("has" in cond && !(Array.isArray(value) && value.includes(cond.has))) return false;
  if ("hasSome" in cond && !(Array.isArray(value) && cond.hasSome.some((x) => value.includes(x)))) return false;
  if ("hasEvery" in cond && !(Array.isArray(value) && cond.hasEvery.every((x) => value.includes(x)))) return false;
  if ("isEmpty" in cond && !(Array.isArray(value) && (value.length === 0) === cond.isEmpty)) return false;
  if ("gte" in cond && !(cmp(value) >= cmp(cond.gte))) return false;
  if ("lte" in cond && !(cmp(value) <= cmp(cond.lte))) return false;
  if ("gt" in cond && !(cmp(value) > cmp(cond.gt))) return false;
  if ("lt" in cond && !(cmp(value) < cmp(cond.lt))) return false;
  return true;
}
function matchWhere(obj, where = {}) {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === "AND") {
      if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matchWhere(obj, w))) return false;
    } else if (key === "OR") {
      if (!cond.some((w) => matchWhere(obj, w))) return false;
    } else if (key === "NOT") {
      if ((Array.isArray(cond) ? cond : [cond]).some((w) => matchWhere(obj, w))) return false;
    } else {
      const value = obj?.[key];
      if (Array.isArray(value) && cond && typeof cond === "object" && ("some" in cond || "none" in cond || "every" in cond)) {
        if ("some" in cond && !value.some((item) => matchWhere(item, cond.some))) return false;
        if ("none" in cond && value.some((item) => matchWhere(item, cond.none))) return false;
        if ("every" in cond && !value.every((item) => matchWhere(item, cond.every))) return false;
      } else if (!matchValue(value, cond)) {
        return false;
      }
    }
  }
  return true;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const D = (s) => new Date(s);
const OPEN_ERROR = { id: "me", status: "OPEN", message: "MAPPER_TEXT_SENTINEL", errorCode: "MAPPER_FAILED", attempts: 1, createdAt: D("2026-09-10T00:00:00Z") };

function sc(id, extra = {}) {
  return {
    id: `sc-${id}`,
    supplier: "OPTIMISE",
    supplierCampaignId: `EXT-${id}`,
    sourceAccountLabel: "default",
    campaignName: `Campaign ${id}`,
    merchantNameRaw: "Brand One",
    merchantId: "m-1",
    merchant: { id: "m-1", displayName: "Brand One" },
    trackingUrl: "https://track.sentinel.example/c?t=TOK_SENTINEL",
    defaultCommissionValue: 987654.321,
    commissionCurrency: "AED",
    currencyCode: "AED",
    countryCodes: ["AE"],
    categoryName: "Fashion",
    campaignType: "CPS",
    campaignStatus: "ACTIVE",
    participationStatus: "JOINED",
    isJoined: true,
    lastSyncedAt: D("2026-09-11T00:00:00Z"),
    normalizedPayload: {},
    coupons: [],
    _count: { coupons: 0, supplierCommissionRules: 0 },
    campaignSources: [{ id: `cs-${id}`, canonicalCampaignId: `cc-${id}`, isActive: true, status: "LINKED", relationshipStatus: "JOINED", trackingLinks: [], _count: { productFeeds: 0 } }],
    ...extra,
  };
}

function ent(id, entityType, networkSource, extra = {}) {
  return {
    id,
    entityType,
    networkSource,
    externalId: `default:${id}`,
    entityName: `Entity ${id}`,
    campaignName: `Campaign ${id}`,
    advertiserName: "Brand Generic",
    rawData: {},
    normalizedData: {},
    createdAt: D("2026-09-10T00:00:00Z"),
    updatedAt: D("2026-09-11T00:00:00Z"),
    supplierCampaigns: [],
    supplierCoupons: [],
    mapperErrors: [],
    rawPayloads: [],
    ...extra,
  };
}

const FIXTURE = [
  // campaigns: 5 (optimise 3 across two regions, trackier 1, boostiny 1)
  ent("c1", "campaign", "optimise_sea", { advertiserName: "Brand One", supplierCampaigns: [sc("c1")] }), // MAPPED
  ent("c2", "campaign", "optimise_sea", { advertiserName: "Brand Two", createdAt: D("2026-08-01T00:00:00Z") }), // NEEDS_REVIEW (not promoted), old
  ent("c3", "campaign", "optimise_mena", { advertiserName: "Brand One", mapperErrors: [{ ...OPEN_ERROR, id: "me-c3" }] }), // ERROR
  ent("c4", "campaign", "trackier", { supplierCampaigns: [sc("c4", { merchantId: null, merchant: null, merchantNameRaw: "", countryCodes: ["SA"], campaignSources: [] })] }), // NEEDS_REVIEW (no merchant)
  ent("c5", "campaign", "boostiny", { campaignName: "Summer Sale", supplierCampaigns: [sc("c5", { supplier: "BOOSTINY" })] }), // MAPPED
  // coupons: 4 (optimise 2 across two regions, boostiny 2)
  ent("k1", "coupon", "optimise_sea", { supplierCoupons: [{ id: "cp-k1", couponCode: "SAVE10", couponStatus: "ACTIVE", supplierCampaign: sc("k1") }] }), // MAPPED
  ent("k2", "coupon", "boostiny", { mapperErrors: [{ ...OPEN_ERROR, id: "me-k2" }] }), // ERROR
  ent("k3", "coupon", "boostiny", { createdAt: D("2026-08-01T00:00:00Z") }), // NEEDS_REVIEW, old
  ent("k4", "coupon", "optimise_uk", { supplierCoupons: [{ id: "cp-k4", couponCode: "SAVE40", couponStatus: "ACTIVE", supplierCampaign: sc("k4") }] }), // MAPPED
  // commission rules: 3 (rakuten 2, optimise 1); groups: 2 (optimise 2 across two regions)
  ent("r1", "commission_rule", "rakuten"),
  ent("r2", "commission_rule", "rakuten", { createdAt: D("2026-08-01T00:00:00Z") }),
  ent("r3", "commission_rule", "optimise_sea"),
  ent("g1", "commission_group", "optimise_sea"),
  ent("g2", "commission_group", "optimise_mena"),
  // other staged types: never part of this summary
  ent("p1", "performance", "optimise_sea", { mapperErrors: [{ ...OPEN_ERROR, id: "me-p1" }] }),
  ent("pay1", "payment", "boostiny"),
  ent("conv1", "conversion", "trackier"),
];

// ── fake Prisma ──────────────────────────────────────────────────────────────
function makeDb(rows) {
  const calls = [];
  const matched = (where) => rows.filter((e) => matchWhere(e, where));
  const entity = {
    count: async ({ where } = {}) => (calls.push("entity.count"), matched(where).length),
    groupBy: async ({ by, where } = {}) => {
      calls.push("entity.groupBy");
      const groups = new Map();
      for (const e of matched(where)) {
        const key = JSON.stringify(by.map((k) => e[k]));
        const g = groups.get(key) ?? Object.fromEntries([...by.map((k) => [k, e[k]]), ["_count", 0]]);
        g._count += 1;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
    findMany: async ({ where, skip = 0, take } = {}) => {
      calls.push("entity.findMany");
      const all = matched(where).sort((a, b) => b.updatedAt - a.updatedAt);
      return take != null ? all.slice(skip, skip + take) : all.slice(skip);
    },
  };
  const mapperError = {
    count: async ({ where } = {}) => {
      calls.push("mapperError.count");
      const { entity: entityWhere, ...rest } = where || {};
      let n = 0;
      for (const e of entityWhere ? matched(entityWhere) : rows) n += (e.mapperErrors || []).filter((m) => matchWhere(m, rest)).length;
      return n;
    },
  };
  const models = { entity, mapperError };
  const db = new Proxy(models, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string") throw new Error(`summary must not touch prisma.${prop}`);
      return undefined;
    },
  });
  return { db, calls };
}

let db;
let calls;
let service;
beforeEach(() => {
  ({ db, calls } = makeDb(FIXTURE));
  service = new ImportedRecordsService({ prisma: db, promotionJob: {}, normalization: {} });
});

const summary = (filters) => service.summary(filters);
const legacyNull = (s) => {
  assert.equal(s.normalizedCampaigns, null);
  assert.equal(s.promotedSupplierCampaigns, null);
  assert.equal(s.linkedCampaigns, null);
  assert.equal(s.unlinkedCampaigns, null);
};
const net = (s) => Object.fromEntries(s.byNetwork.map((r) => [r.networkSource, r.importedRecords]));
const sumNet = (s) => s.byNetwork.reduce((n, r) => n + r.importedRecords, 0);
const ALLOWED_KEYS = ["importedRecords", "normalizedCampaigns", "promotedSupplierCampaigns", "needsReview", "mappingErrors", "importedCampaigns", "linkedCampaigns", "unlinkedCampaigns", "recordTypeCounts", "byNetwork", "supportedRecordTypes"];

describe("summary: selected record type", () => {
  it("1 campaign — counts only campaigns; importedCampaigns mirrors; legacy campaign counts null", async () => {
    const s = await summary({ recordType: "campaign" });
    assert.equal(s.importedRecords, 5);
    assert.equal(s.importedCampaigns, 5);
    assert.equal(s.mappingErrors, 1);
    assert.equal(s.needsReview, 2); // c2 (not promoted) + c4 (no merchant); c3 has an open error
    legacyNull(s);
    assert.deepEqual(net(s), { optimise: 3, trackier: 1, boostiny: 1 });
    assert.equal(sumNet(s), s.importedRecords);
  });

  it("2 coupon — counts coupons only; importedCampaigns null; legacy campaign counts null", async () => {
    const s = await summary({ recordType: "coupon" });
    assert.equal(s.importedRecords, 4);
    assert.equal(s.importedCampaigns, null);
    assert.equal(s.mappingErrors, 1);
    assert.equal(s.needsReview, 1); // k3
    legacyNull(s);
    assert.deepEqual(net(s), { optimise: 2, boostiny: 2 });
    assert.equal(sumNet(s), 4);
  });

  it("3 commission_rule — type count, mappingErrors 0, needsReview null", async () => {
    const s = await summary({ recordType: "commission_rule" });
    assert.equal(s.importedRecords, 3);
    assert.equal(s.mappingErrors, 0);
    assert.equal(s.needsReview, null);
    assert.equal(s.importedCampaigns, null);
    legacyNull(s);
    assert.deepEqual(net(s), { rakuten: 2, optimise: 1 });
  });

  it("4 commission_group — same semantics; optimise regions collapse", async () => {
    const s = await summary({ recordType: "commission_group" });
    assert.equal(s.importedRecords, 2);
    assert.equal(s.mappingErrors, 0);
    assert.equal(s.needsReview, null);
    legacyNull(s);
    assert.deepEqual(s.byNetwork, [{ network: "Optimise", networkSource: "optimise", importedRecords: 2 }]);
  });

  it("5 mappingErrors follows the selected type (campaign 1, coupon 1, commission 0; performance error never counted)", async () => {
    assert.equal((await summary({ recordType: "campaign" })).mappingErrors, 1);
    assert.equal((await summary({ recordType: "coupon" })).mappingErrors, 1);
    assert.equal((await summary({ recordType: "commission_rule" })).mappingErrors, 0);
    assert.equal((await summary({ recordType: "commission_group" })).mappingErrors, 0);
  });
});

describe("summary: filter parity with the list", () => {
  const CASES = [
    { recordType: "campaign", mappingStatus: "MAPPED" },
    { recordType: "campaign", mappingStatus: "NEEDS_REVIEW" },
    { recordType: "campaign", mappingStatus: "ERROR" },
    { recordType: "campaign", sourceStatus: "FAILED" },
    { recordType: "campaign", sourceStatus: "PROCESSED" },
    { recordType: "campaign", brand: "Brand One" },
    { recordType: "campaign", campaign: "Summer" },
    { recordType: "campaign", search: "Summer" },
    { recordType: "campaign", search: "https://evil.example/r/x" },
    { recordType: "campaign", issue: "CAMPAIGN_NOT_PROMOTED" },
    { recordType: "campaign", issue: "MISSING_MERCHANT_IDENTIFIER" },
    { recordType: "campaign", country: "AE" },
    { recordType: "campaign", campaignStatus: "ACTIVE" },
    { recordType: "campaign", relationshipStatus: "JOINED" },
    { recordType: "campaign", campaignType: "CPS" },
    { recordType: "campaign", category: "Fashion" },
    { recordType: "campaign", currency: "AED" },
    { recordType: "campaign", preset: "mapping_errors" },
    { recordType: "campaign", networkSource: "optimise" },
    { recordType: "campaign", networkSource: "boostiny", brand: "Brand One" },
    { recordType: "campaign", fromDate: "2026-09-01T00:00:00.000Z" },
    { recordType: "campaign", toDate: "2026-08-31T23:59:59.999Z" },
    { recordType: "coupon", mappingStatus: "MAPPED" },
    { recordType: "coupon", networkSource: "boostiny", sourceStatus: "IMPORTED" },
    { recordType: "coupon", search: "SAVE10" },
    { recordType: "commission_rule", networkSource: "rakuten", fromDate: "2026-09-01T00:00:00.000Z" },
  ];
  for (const filters of CASES) {
    it(`6 importedRecords equals list total for ${JSON.stringify(filters)}`, async () => {
      const s = await summary(filters);
      const list = await service.list({ ...filters, page: 1, pageSize: 100 });
      assert.equal(s.importedRecords, list.total, "summary.importedRecords != list.total");
      assert.equal(sumNet(s), s.importedRecords, "byNetwork does not sum to importedRecords");
    });
  }

  it("6b hand-checked filter values", async () => {
    assert.equal((await summary({ recordType: "campaign", mappingStatus: "MAPPED" })).importedRecords, 2); // c1, c5
    assert.equal((await summary({ recordType: "campaign", brand: "Brand One" })).importedRecords, 3); // c1, c3, c5 (merchantNameRaw)
    assert.equal((await summary({ recordType: "campaign", search: "https://evil.example/r/x" })).importedRecords, 0);
    assert.equal((await summary({ recordType: "campaign", issue: "CAMPAIGN_NOT_PROMOTED" })).importedRecords, 2); // c2, c3 (no SupplierCampaign; c3 also has an open error)
    assert.equal((await summary({ recordType: "campaign", country: "AE" })).importedRecords, 2); // c1, c5
    assert.equal((await summary({ recordType: "coupon", search: "SAVE10" })).importedRecords, 1);
  });
});

describe("summary: needsReview", () => {
  it("7 uses AND(baseWhere, needsReview) — user filters are never replaced", async () => {
    assert.equal((await summary({ recordType: "campaign", mappingStatus: "MAPPED" })).needsReview, 0);
    assert.equal((await summary({ recordType: "campaign", mappingStatus: "ERROR" })).needsReview, 0);
    assert.equal((await summary({ recordType: "campaign", sourceStatus: "FAILED" })).needsReview, 0);
    assert.equal((await summary({ recordType: "campaign", mappingStatus: "NEEDS_REVIEW" })).needsReview, 2);
    assert.equal((await summary({ recordType: "campaign", issue: "CAMPAIGN_NOT_PROMOTED" })).needsReview, 1);
    assert.equal((await summary({ recordType: "campaign", networkSource: "trackier" })).needsReview, 1);
    assert.equal((await summary({ recordType: "coupon", networkSource: "boostiny" })).needsReview, 1);
    assert.equal((await summary({ recordType: "coupon", mappingStatus: "MAPPED" })).needsReview, 0);
  });

  it("7b commission types return null, never a false 0", async () => {
    assert.equal((await summary({ recordType: "commission_rule" })).needsReview, null);
    assert.equal((await summary({ recordType: "commission_group", networkSource: "optimise" })).needsReview, null);
  });

  it("7c the list's NEEDS_REVIEW filter still uses the same predicate (refactor is behaviour-preserving)", async () => {
    for (const recordType of ["campaign", "coupon"]) {
      const s = await summary({ recordType });
      const list = await service.list({ recordType, mappingStatus: "NEEDS_REVIEW", page: 1, pageSize: 100 });
      assert.equal(list.total, s.needsReview);
      const preset = await service.list({ recordType, preset: "needs_review", page: 1, pageSize: 100 });
      assert.equal(preset.total, s.needsReview);
      const notNormalized = await service.list({ recordType, preset: "imported_not_normalized", page: 1, pageSize: 100 });
      assert.equal(notNormalized.total, s.needsReview);
    }
  });
});

describe("summary: byNetwork", () => {
  it("8 selected type only; optimise variants collapse; label Optimise; sums to importedRecords", async () => {
    const s = await summary({ recordType: "campaign" });
    const optimise = s.byNetwork.find((r) => r.networkSource === "optimise");
    assert.deepEqual(optimise, { network: "Optimise", networkSource: "optimise", importedRecords: 3 });
    assert.ok(!s.byNetwork.some((r) => /optimise_/.test(r.networkSource)), "raw optimise_* variant leaked as a row");
    assert.deepEqual(s.byNetwork.map((r) => r.network), ["Optimise", "Boostiny", "Trackier"]);
    assert.equal(sumNet(s), s.importedRecords);
    for (const row of s.byNetwork) assert.deepEqual(Object.keys(row).sort(), ["importedRecords", "network", "networkSource"]);
  });

  it("9 mixed types across networks never cross-contaminate", async () => {
    const campaign = await summary({ recordType: "campaign" });
    const coupon = await summary({ recordType: "coupon" });
    const rule = await summary({ recordType: "commission_rule" });
    assert.ok(!("rakuten" in net(campaign)) && !("rakuten" in net(coupon)));
    assert.ok(!("trackier" in net(coupon)) && !("trackier" in net(rule)));
    assert.deepEqual(net(coupon), { optimise: 2, boostiny: 2 });
    assert.deepEqual(net(rule), { rakuten: 2, optimise: 1 });
  });

  it("network filter keeps only the matched network rows", async () => {
    const s = await summary({ recordType: "campaign", networkSource: "optimise" });
    assert.deepEqual(s.byNetwork, [{ network: "Optimise", networkSource: "optimise", importedRecords: 3 }]);
    const b = await summary({ recordType: "coupon", networkSource: "boostiny" });
    assert.deepEqual(b.byNetwork, [{ network: "Boostiny", networkSource: "boostiny", importedRecords: 2 }]);
  });
});

describe("summary: recordTypeCounts", () => {
  it("10 cross-type first-release inventory regardless of the selected type; no hidden types computed", async () => {
    for (const recordType of ["campaign", "coupon", "commission_rule", "commission_group"]) {
      const s = await summary({ recordType });
      assert.deepEqual(s.recordTypeCounts, { campaign: 5, coupon: 4, commission_rule: 3, commission_group: 2 });
    }
    assert.deepEqual((await summary({ recordType: "campaign" })).supportedRecordTypes, ["campaign", "coupon", "commission_rule", "commission_group"]);
  });

  it("10b inventory ignores row-level filters (brand, mappingStatus, search, issue, country)", async () => {
    for (const extra of [{ brand: "Brand One" }, { mappingStatus: "ERROR" }, { search: "Summer" }, { issue: "CAMPAIGN_NOT_PROMOTED" }, { country: "AE" }, { preset: "mapping_errors" }]) {
      const s = await summary({ recordType: "campaign", ...extra });
      assert.deepEqual(s.recordTypeCounts, { campaign: 5, coupon: 4, commission_rule: 3, commission_group: 2 }, JSON.stringify(extra));
    }
  });
});

describe("summary: network and date scoping", () => {
  it("11 network filter scopes importedRecords, mappingErrors, needsReview, byNetwork and recordTypeCounts", async () => {
    const s = await summary({ recordType: "campaign", networkSource: "optimise" });
    assert.equal(s.importedRecords, 3);
    assert.equal(s.mappingErrors, 1);
    assert.equal(s.needsReview, 1); // c2
    assert.deepEqual(net(s), { optimise: 3 });
    assert.deepEqual(s.recordTypeCounts, { campaign: 3, coupon: 2, commission_rule: 1, commission_group: 2 });
    const b = await summary({ recordType: "campaign", networkSource: "boostiny" });
    assert.equal(b.importedRecords, 1);
    assert.equal(b.mappingErrors, 0);
    assert.equal(b.needsReview, 0);
    assert.deepEqual(b.recordTypeCounts, { campaign: 1, coupon: 2, commission_rule: 0, commission_group: 0 });
  });

  it("12 date filter scopes the same way", async () => {
    const from = await summary({ recordType: "campaign", fromDate: "2026-09-01T00:00:00.000Z" });
    assert.equal(from.importedRecords, 4); // c2 is older
    assert.equal(from.needsReview, 1); // c4
    assert.equal(from.mappingErrors, 1);
    assert.deepEqual(net(from), { optimise: 2, trackier: 1, boostiny: 1 });
    assert.deepEqual(from.recordTypeCounts, { campaign: 4, coupon: 3, commission_rule: 2, commission_group: 2 });
    const to = await summary({ recordType: "campaign", toDate: "2026-08-31T23:59:59.999Z" });
    assert.equal(to.importedRecords, 1); // c2
    assert.equal(to.needsReview, 1);
    assert.equal(to.mappingErrors, 0);
    assert.deepEqual(to.byNetwork, [{ network: "Optimise", networkSource: "optimise", importedRecords: 1 }]);
    assert.deepEqual(to.recordTypeCounts, { campaign: 1, coupon: 1, commission_rule: 1, commission_group: 0 });
  });
});

describe("summary: empty data, safety, query budget", () => {
  it("13 empty data", async () => {
    const empty = new ImportedRecordsService({ prisma: makeDb([]).db, promotionJob: {}, normalization: {} });
    for (const recordType of ["campaign", "coupon"]) {
      const s = await empty.summary({ recordType });
      assert.equal(s.importedRecords, 0);
      assert.equal(s.mappingErrors, 0);
      assert.equal(s.needsReview, 0);
      assert.deepEqual(s.byNetwork, []);
      assert.deepEqual(s.recordTypeCounts, { campaign: 0, coupon: 0, commission_rule: 0, commission_group: 0 });
    }
    for (const recordType of ["commission_rule", "commission_group"]) {
      const s = await empty.summary({ recordType });
      assert.equal(s.importedRecords, 0);
      assert.equal(s.needsReview, null);
      assert.deepEqual(s.byNetwork, []);
    }
  });

  it("14 aggregate-only output: fixed keys, counts and labels, nothing from payloads", async () => {
    for (const recordType of ["campaign", "coupon", "commission_rule", "commission_group"]) {
      const s = await summary({ recordType, brand: "Brand" });
      assert.deepEqual(Object.keys(s).sort(), [...ALLOWED_KEYS].sort());
      const text = JSON.stringify(s);
      for (const bad of ["http", "://", "sentinel", "SENTINEL", "TOK_", "987654", "AED", "SAVE10", "Brand One", "me-c3", "cs-", "sc-", "EXT-", "rawData", "trackingUrl", "defaultCommissionValue", "commissionCurrency", "MAPPER_TEXT"]) {
        assert.ok(!text.includes(bad), `${recordType}: '${bad}' leaked into the summary`);
      }
      for (const [k, v] of Object.entries(s)) {
        if (k === "byNetwork") {
          for (const row of v) {
            assert.deepEqual(Object.keys(row).sort(), ["importedRecords", "network", "networkSource"]);
            assert.equal(typeof row.importedRecords, "number");
            assert.equal(typeof row.network, "string");
            assert.equal(typeof row.networkSource, "string");
          }
        } else if (k === "recordTypeCounts") {
          assert.ok(Object.values(v).every((n) => typeof n === "number"));
        } else if (k === "supportedRecordTypes") {
          assert.ok(v.every((t) => typeof t === "string"));
        } else {
          assert.ok(v === null || typeof v === "number", `${k} must be a count or null`);
        }
      }
    }
  });

  it("query budget: 5 aggregate calls for campaign / coupon, 4 for commission types; no SupplierCampaign / CampaignSource access", async () => {
    for (const [recordType, expected] of [["campaign", 5], ["coupon", 5], ["commission_rule", 4], ["commission_group", 4]]) {
      calls.length = 0;
      await summary({ recordType, networkSource: "optimise", brand: "Brand" });
      assert.equal(calls.length, expected, `${recordType}: ${calls.join(",")}`);
      assert.deepEqual(calls.filter((c) => c === "entity.count").length, recordType === "campaign" || recordType === "coupon" ? 2 : 1);
      assert.equal(calls.filter((c) => c === "mapperError.count").length, 1);
      assert.equal(calls.filter((c) => c === "entity.groupBy").length, 2);
      assert.equal(calls.filter((c) => c === "entity.findMany").length, 0);
    }
  });
});
