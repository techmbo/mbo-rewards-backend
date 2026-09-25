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

const { ImportedRecordsService, invalidateImportedRecordsListCache } = await import("../src/modules/ops/importedRecords.service.js");

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
function makeDb(rows, { facetModels = false } = {}) {
  const calls = [];
  const wheres = []; // { op, where } in call order — lets tests assert the exact predicate sent
  const record = (op, where) => {
    calls.push(op);
    wheres.push({ op, where });
  };
  const matched = (where) => rows.filter((e) => matchWhere(e, where));
  const entity = {
    count: async ({ where } = {}) => (record("entity.count", where), matched(where).length),
    groupBy: async ({ by, where } = {}) => {
      record("entity.groupBy", where);
      const groups = new Map();
      for (const e of matched(where)) {
        const key = JSON.stringify(by.map((k) => e[k]));
        const g = groups.get(key) ?? Object.fromEntries([...by.map((k) => [k, e[k]]), ["_count", 0]]);
        g._count += 1;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
    findUnique: async ({ where } = {}) => {
      record("entity.findUnique", where);
      return rows.find((e) => e.id === where?.id) ?? null;
    },
    findMany: async ({ where, skip = 0, take } = {}) => {
      record("entity.findMany", where);
      const all = matched(where).sort((a, b) => b.updatedAt - a.updatedAt);
      return take != null ? all.slice(skip, skip + take) : all.slice(skip);
    },
  };
  const mapperError = {
    count: async ({ where } = {}) => {
      record("mapperError.count", where);
      const { entity: entityWhere, ...rest } = where || {};
      let n = 0;
      for (const e of entityWhere ? matched(entityWhere) : rows) n += (e.mapperErrors || []).filter((m) => matchWhere(m, rest)).length;
      return n;
    },
  };
  const models = { entity, mapperError };
  if (facetModels) {
    // facets() only: capture the predicate, return no rows — the summary must never reach these.
    models.supplierCampaign = {
      groupBy: async ({ where } = {}) => (record("supplierCampaign.groupBy", where), []),
      findMany: async ({ where } = {}) => (record("supplierCampaign.findMany", where), []),
    };
    models.campaignSource = { groupBy: async ({ where } = {}) => (record("campaignSource.groupBy", where), []) };
  }
  const db = new Proxy(models, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string") throw new Error(`summary must not touch prisma.${prop}`);
      return undefined;
    },
  });
  return { db, calls, wheres };
}

let db;
let calls;
let service;
beforeEach(() => {
  invalidateImportedRecordsListCache(); // the list/count cache is module-level and keyed by filters only
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

// ── Trackier / vCommission network family ───────────────────────────────────
// Current Trackier rows are written as "trackier"; legacy rows exist as "vcommission". The facet,
// displayNetwork and byNetwork already treat them as one network — the filter must too.
const V_CAMPAIGN_REVIEW = ent("v1", "campaign", "vcommission", { advertiserName: "Brand V" }); // needs review (not promoted)
const V_CAMPAIGN_ERROR = ent("v2", "campaign", "vcommission", { advertiserName: "Brand V", mapperErrors: [{ ...OPEN_ERROR, id: "me-v2" }] });
const V_COUPON_MAPPED = ent("vk1", "coupon", "vcommission", { supplierCoupons: [{ id: "cp-vk1", couponCode: "VC10", couponStatus: "ACTIVE", supplierCampaign: sc("vk1", { supplier: "TRACKIER" }) }] });
const TRACKIER_FAMILY = ["trackier", "vcommission"];
const withRows = (rows, opts) => {
  invalidateImportedRecordsListCache(); // fixtures differ per test; never serve another fixture's cached total
  const made = makeDb(rows, opts);
  return { ...made, service: new ImportedRecordsService({ prisma: made.db, promotionJob: {}, normalization: {} }) };
};
const listTotal = (svc, filters) => svc.list({ ...filters, page: 1, pageSize: 100 }).then((r) => r.total);
const listSources = (svc, filters) => svc.list({ ...filters, page: 1, pageSize: 100 }).then((r) => r.rows.map((x) => x.networkSource).sort());
const lastWhere = (wheres, op) => [...wheres].reverse().find((w) => w.op === op)?.where;
/** The predicate of the plain base count: summary() issues entity.count(baseWhere) first, before the
 *  needs-review AND(baseWhere, …) count, and list() issues exactly one count — so the first recorded
 *  entity.count after clearing is always the base predicate (which may itself carry AND clauses). */
const baseCountWhere = (wheres) => wheres.find((w) => w.op === "entity.count")?.where;
const captured = async (wheres, fn) => {
  wheres.length = 0;
  await fn();
  return baseCountWhere(wheres);
};

describe("network filter: trackier / vcommission family", () => {
  it("1 trackier-only fixture: network=trackier matches the trackier row in list and summary", async () => {
    const { service: svc } = withRows(FIXTURE);
    assert.equal(await listTotal(svc, { recordType: "campaign", networkSource: "trackier" }), 1);
    assert.deepEqual(await listSources(svc, { recordType: "campaign", networkSource: "trackier" }), ["trackier"]);
    const s = await svc.summary({ recordType: "campaign", networkSource: "trackier" });
    assert.equal(s.importedRecords, 1);
    assert.deepEqual(s.byNetwork, [{ network: "Trackier", networkSource: "trackier", importedRecords: 1 }]);
  });

  it("2 vcommission-only fixture: network=trackier and network=vcommission both match the legacy row", async () => {
    const { service: svc } = withRows([...FIXTURE.filter((e) => e.networkSource !== "trackier"), V_CAMPAIGN_REVIEW]);
    for (const networkSource of TRACKIER_FAMILY) {
      assert.equal(await listTotal(svc, { recordType: "campaign", networkSource }), 1, networkSource);
      assert.deepEqual(await listSources(svc, { recordType: "campaign", networkSource }), ["vcommission"], networkSource);
      const s = await svc.summary({ recordType: "campaign", networkSource });
      assert.equal(s.importedRecords, 1, networkSource);
      assert.deepEqual(s.byNetwork, [{ network: "Trackier", networkSource: "trackier", importedRecords: 1 }], networkSource);
    }
  });

  it("3 mixed family: trackier + vcommission campaign rows → total 2 under either value, one Trackier byNetwork row", async () => {
    const { service: svc } = withRows([...FIXTURE, V_CAMPAIGN_REVIEW]);
    for (const networkSource of TRACKIER_FAMILY) {
      assert.equal(await listTotal(svc, { recordType: "campaign", networkSource }), 2, networkSource);
      assert.deepEqual(await listSources(svc, { recordType: "campaign", networkSource }), ["trackier", "vcommission"], networkSource);
      const s = await svc.summary({ recordType: "campaign", networkSource });
      assert.equal(s.importedRecords, 2, networkSource);
      assert.deepEqual(s.byNetwork, [{ network: "Trackier", networkSource: "trackier", importedRecords: 2 }], networkSource);
    }
  });

  it("3b buildWhere sends the same { in: [trackier, vcommission] } predicate for both values", async () => {
    const { service: svc, wheres } = withRows(FIXTURE);
    for (const networkSource of TRACKIER_FAMILY) {
      const where = await captured(wheres, () => svc.summary({ recordType: "campaign", networkSource }));
      assert.deepEqual(where.networkSource, { in: ["trackier", "vcommission"] }, networkSource);
      // and the mapper-error count carries the identical Entity predicate
      assert.deepEqual(lastWhere(wheres, "mapperError.count").entity.networkSource, { in: ["trackier", "vcommission"] }, networkSource);
    }
  });

  it("4 coupon parity: a coupon stored as vcommission is counted by list and summary under network=trackier", async () => {
    const { service: svc } = withRows([...FIXTURE, V_COUPON_MAPPED]);
    const total = await listTotal(svc, { recordType: "coupon", networkSource: "trackier" });
    const s = await svc.summary({ recordType: "coupon", networkSource: "trackier" });
    assert.equal(total, 1);
    assert.equal(s.importedRecords, total);
    assert.deepEqual(s.byNetwork, [{ network: "Trackier", networkSource: "trackier", importedRecords: 1 }]);
    assert.equal(s.needsReview, 0); // vk1 is mapped
  });

  it("5 mappingErrors: an OPEN error on a vcommission campaign is counted under network=trackier", async () => {
    const { service: svc } = withRows([...FIXTURE, V_CAMPAIGN_REVIEW, V_CAMPAIGN_ERROR, V_COUPON_MAPPED]);
    const s = await svc.summary({ recordType: "campaign", networkSource: "trackier" });
    assert.equal(s.importedRecords, 3); // c4 + v1 + v2
    assert.equal(s.mappingErrors, 1); // v2
    assert.equal((await svc.summary({ recordType: "coupon", networkSource: "trackier" })).mappingErrors, 0);
    assert.equal((await svc.summary({ recordType: "campaign", networkSource: "vcommission" })).mappingErrors, 1);
  });

  it("6 needsReview: a vcommission campaign needing review is counted under network=trackier", async () => {
    const { service: svc } = withRows([...FIXTURE, V_CAMPAIGN_REVIEW, V_CAMPAIGN_ERROR, V_COUPON_MAPPED]);
    const s = await svc.summary({ recordType: "campaign", networkSource: "trackier" });
    assert.equal(s.needsReview, 2); // c4 (no merchant) + v1 (not promoted); v2 has an open error
    assert.equal(await listTotal(svc, { recordType: "campaign", networkSource: "trackier", mappingStatus: "NEEDS_REVIEW" }), 2);
  });

  it("7 recordTypeCounts under network=trackier spans raw trackier and vcommission rows per type", async () => {
    const { service: svc } = withRows([...FIXTURE, V_CAMPAIGN_REVIEW, V_CAMPAIGN_ERROR, V_COUPON_MAPPED]);
    for (const networkSource of TRACKIER_FAMILY) {
      const s = await svc.summary({ recordType: "commission_rule", networkSource });
      assert.deepEqual(s.recordTypeCounts, { campaign: 3, coupon: 1, commission_rule: 0, commission_group: 0 }, networkSource);
      assert.equal(s.importedRecords, 0);
      assert.deepEqual(s.byNetwork, []);
    }
  });

  it("8 facets() scopes with the same family predicate and exposes one canonical Trackier option", async () => {
    const { service: svc, wheres } = withRows([...FIXTURE, V_CAMPAIGN_REVIEW, V_CAMPAIGN_ERROR, V_COUPON_MAPPED], { facetModels: true });
    const facets = await svc.facets({ networkSource: "trackier" });
    const family = { in: ["trackier", "vcommission"] };
    assert.deepEqual(lastWhere(wheres, "entity.groupBy"), { entityType: "campaign", networkSource: family });
    assert.deepEqual(lastWhere(wheres, "supplierCampaign.groupBy"), { entity: { entityType: "campaign", networkSource: family } });
    assert.deepEqual(lastWhere(wheres, "campaignSource.groupBy"), { supplierCampaign: { entity: { entityType: "campaign", networkSource: family } } });
    assert.deepEqual(lastWhere(wheres, "supplierCampaign.findMany"), { entity: { entityType: "campaign", networkSource: family } });
    assert.deepEqual(lastWhere(wheres, "entity.count").networkSource, family);
    assert.deepEqual(facets.network, [{ value: "trackier", label: "Trackier" }]);
    // unfiltered facet: one Trackier option, never a vcommission one
    const all = await svc.facets({});
    assert.deepEqual(all.network.filter((o) => /trackier|vcommission/i.test(o.value)), [{ value: "trackier", label: "Trackier" }]);
    assert.ok(all.network.some((o) => o.value === "optimise" && o.label === "Optimise"));
  });

  it("9 unrelated network unchanged: network=boostiny is still an exact match with the same totals", async () => {
    const base = withRows(FIXTURE);
    const fam = withRows([...FIXTURE, V_CAMPAIGN_REVIEW, V_CAMPAIGN_ERROR, V_COUPON_MAPPED]);
    for (const recordType of ["campaign", "coupon"]) {
      assert.equal(await listTotal(fam.service, { recordType, networkSource: "boostiny" }), await listTotal(base.service, { recordType, networkSource: "boostiny" }));
    }
    assert.equal(await listTotal(fam.service, { recordType: "campaign", networkSource: "boostiny" }), 1);
    assert.equal(await listTotal(fam.service, { recordType: "coupon", networkSource: "boostiny" }), 2);
    assert.equal((await captured(fam.wheres, () => fam.service.summary({ recordType: "coupon", networkSource: "boostiny" }))).networkSource, "boostiny");
    assert.equal(await listTotal(fam.service, { recordType: "commission_rule", networkSource: "rakuten" }), 2);
    assert.equal((await captured(fam.wheres, () => fam.service.summary({ recordType: "commission_rule", networkSource: "rakuten" }))).networkSource, "rakuten");
  });

  it("10 optimise regression: network=optimise is the family, network=optimise_<region> stays exact", async () => {
    const { service: svc, wheres } = withRows([...FIXTURE, V_CAMPAIGN_REVIEW]);
    let total;
    let where = await captured(wheres, async () => { total = await listTotal(svc, { recordType: "campaign", networkSource: "optimise" }); });
    assert.equal(total, 3); // c1, c2, c3
    assert.deepEqual(where.networkSource, { startsWith: "optimise" });
    where = await captured(wheres, async () => { total = await listTotal(svc, { recordType: "campaign", networkSource: "optimise_sea" }); });
    assert.equal(total, 2); // c1, c2
    assert.equal(where.networkSource, "optimise_sea");
    where = await captured(wheres, async () => { total = await listTotal(svc, { recordType: "campaign", networkSource: "optimise_mena" }); });
    assert.equal(total, 1); // c3
    assert.equal(where.networkSource, "optimise_mena");
    where = await captured(wheres, async () => { total = await listTotal(svc, { recordType: "commission_group", networkSource: "optimise_uk" }); });
    assert.equal(total, 0);
    assert.equal(where.networkSource, "optimise_uk");
    const s = await svc.summary({ recordType: "campaign", networkSource: "optimise_sea" });
    assert.equal(s.importedRecords, 2);
    assert.deepEqual(s.byNetwork, [{ network: "Optimise", networkSource: "optimise", importedRecords: 2 }]);
  });

  it("11 canonical display: unfiltered byNetwork collapses trackier + vcommission into one Trackier row", async () => {
    const { service: svc } = withRows([...FIXTURE, V_CAMPAIGN_REVIEW, V_CAMPAIGN_ERROR, V_COUPON_MAPPED]);
    const s = await svc.summary({ recordType: "campaign" });
    assert.equal(s.importedRecords, 7);
    assert.deepEqual(net(s), { optimise: 3, trackier: 3, boostiny: 1 });
    assert.equal(s.byNetwork.filter((r) => r.network === "Trackier").length, 1);
    assert.ok(!JSON.stringify(s).includes("vcommission"), "raw vcommission key leaked into the summary");
    const c = await svc.summary({ recordType: "coupon" });
    assert.deepEqual(net(c), { optimise: 2, boostiny: 2, trackier: 1 });
    assert.ok(!JSON.stringify(c).includes("vcommission"));
  });

  it("12 input normalisation: case / whitespace variants map to the same predicate; empty means no network filter", async () => {
    const { service: svc, wheres } = withRows(FIXTURE);
    for (const raw of ["Trackier", " VCOMMISSION ", "trackier "]) {
      const where = await captured(wheres, () => svc.summary({ recordType: "campaign", networkSource: raw }));
      assert.deepEqual(where.networkSource, { in: ["trackier", "vcommission"] }, JSON.stringify(raw));
    }
    const none = await captured(wheres, () => svc.summary({ recordType: "campaign", networkSource: "  " }));
    assert.equal("networkSource" in none, false);
  });
});

// ── date filters: validation happens in buildWhere, before any Prisma call ───────────────────
const INVALID_DATE_CASES = [
  { filters: { fromDate: "not-a-date" }, message: "Invalid fromDate." },
  { filters: { toDate: "not-a-date" }, message: "Invalid toDate." },
  { filters: { fromDate: "2026-99-99" }, message: "Invalid fromDate." },
  { filters: { fromDate: "2026-09-25+05:30" }, message: "Invalid fromDate." },
  { filters: { fromDate: ["2026-09-01", "2026-09-02"] }, message: "Invalid fromDate." }, // repeated query param
  { filters: { toDate: ["2026-09-01", "2026-09-02"] }, message: "Invalid toDate." },
  { filters: { fromDate: "2026-09-01", toDate: "nope" }, message: "Invalid toDate." },
];
const isDateFilterError = (message) => (e) => e instanceof Error && e.statusCode === 400 && e.message === message;

describe("date filters: valid inputs keep today's predicates", () => {
  it("1 no dates → no createdAt predicate", async () => {
    const { service: svc, wheres } = withRows(FIXTURE);
    const where = await captured(wheres, () => svc.summary({ recordType: "campaign" }));
    assert.equal("createdAt" in where, false);
  });

  it("2 fromDate only → createdAt.gte is a Date, no lte", async () => {
    const { service: svc, wheres } = withRows(FIXTURE);
    const where = await captured(wheres, () => svc.summary({ recordType: "campaign", fromDate: "2026-09-01T00:00:00.000Z" }));
    assert.ok(where.createdAt.gte instanceof Date);
    assert.equal(where.createdAt.gte.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal("lte" in where.createdAt, false);
  });

  it("3 toDate only → createdAt.lte is a Date, no gte", async () => {
    const { service: svc, wheres } = withRows(FIXTURE);
    const where = await captured(wheres, () => svc.summary({ recordType: "coupon", toDate: "2026-08-31T23:59:59.999Z" }));
    assert.ok(where.createdAt.lte instanceof Date);
    assert.equal(where.createdAt.lte.toISOString(), "2026-08-31T23:59:59.999Z");
    assert.equal("gte" in where.createdAt, false);
  });

  it("4 ISO timestamp pair → exact gte / lte Dates (list and summary)", async () => {
    const { service: svc, wheres } = withRows(FIXTURE);
    const filters = { recordType: "campaign", fromDate: "2026-09-01T00:00:00.000Z", toDate: "2026-09-30T23:59:59.999Z" };
    const w1 = await captured(wheres, () => svc.summary(filters));
    assert.deepEqual([w1.createdAt.gte.toISOString(), w1.createdAt.lte.toISOString()], ["2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z"]);
    const w2 = await captured(wheres, () => svc.list({ ...filters, page: 1, pageSize: 100 }));
    assert.deepEqual([w2.createdAt.gte.toISOString(), w2.createdAt.lte.toISOString()], ["2026-09-01T00:00:00.000Z", "2026-09-30T23:59:59.999Z"]);
    assert.notEqual(typeof w2.createdAt.gte, "string");
  });

  it("5 date-only fromDate → midnight UTC (current behaviour, unchanged)", async () => {
    const { service: svc, wheres } = withRows(FIXTURE);
    const where = await captured(wheres, () => svc.summary({ recordType: "campaign", fromDate: "2026-09-25" }));
    assert.equal(where.createdAt.gte.toISOString(), "2026-09-25T00:00:00.000Z");
    const to = await captured(wheres, () => svc.summary({ recordType: "campaign", toDate: "2026-09-25" }));
    assert.equal(to.createdAt.lte.toISOString(), "2026-09-25T00:00:00.000Z"); // date-only toDate stays first-instant (out of scope here)
  });

  it("6 surrounding whitespace trims and stays valid", async () => {
    const { service: svc, wheres } = withRows(FIXTURE);
    const where = await captured(wheres, () => svc.summary({ recordType: "campaign", fromDate: " 2026-09-25 ", toDate: "\t2026-09-30T23:59:59.999Z " }));
    assert.equal(where.createdAt.gte.toISOString(), "2026-09-25T00:00:00.000Z");
    assert.equal(where.createdAt.lte.toISOString(), "2026-09-30T23:59:59.999Z");
  });

  it("7 whitespace-only and empty → treated as absent", async () => {
    const { service: svc, wheres } = withRows(FIXTURE);
    for (const blank of ["   ", "", "\t"]) {
      const where = await captured(wheres, () => svc.summary({ recordType: "campaign", fromDate: blank, toDate: blank }));
      assert.equal("createdAt" in where, false, JSON.stringify(blank));
    }
    const s = await svc.summary({ recordType: "campaign", fromDate: "   " });
    assert.equal(s.importedRecords, 5);
  });

  it("8 reversed valid range → no throw, empty result", async () => {
    const { service: svc } = withRows(FIXTURE);
    const filters = { recordType: "campaign", fromDate: "2026-09-30T00:00:00.000Z", toDate: "2026-09-01T00:00:00.000Z" };
    const s = await svc.summary(filters);
    assert.equal(s.importedRecords, 0);
    assert.deepEqual(s.byNetwork, []);
    assert.equal(s.needsReview, 0);
    assert.equal(await listTotal(svc, filters), 0);
  });
});

describe("date filters: invalid inputs → 400 before any Prisma operation", () => {
  for (const { filters, message } of INVALID_DATE_CASES) {
    for (const recordType of ["campaign", "coupon", "commission_rule"]) {
      it(`${JSON.stringify(filters)} / ${recordType}: list() and summary() reject with 400 '${message}' and issue no DB call`, async () => {
        const { service: svc, calls } = withRows(FIXTURE);
        calls.length = 0;
        await assert.rejects(svc.summary({ recordType, ...filters }), isDateFilterError(message));
        assert.deepEqual(calls, [], `summary issued ${calls.join(",")}`);
        await assert.rejects(svc.list({ recordType, ...filters, page: 1, pageSize: 25 }), isDateFilterError(message));
        assert.deepEqual(calls, [], `list issued ${calls.join(",")}`);
      });
    }
  }

  it("the error is a plain 400 — no Prisma text, no raw value", async () => {
    const { service: svc } = withRows(FIXTURE);
    await assert.rejects(svc.summary({ recordType: "campaign", fromDate: "not-a-date" }), (e) => {
      assert.equal(e.statusCode, 400);
      assert.equal(e.message, "Invalid fromDate.");
      assert.ok(!/prisma|invocation|Invalid Date|not-a-date|createdAt/i.test(e.message));
      return true;
    });
  });

  it("facets() does not consume date filters: a bad date is ignored there (no validation, no createdAt)", async () => {
    const { service: svc, wheres } = withRows(FIXTURE, { facetModels: true });
    wheres.length = 0;
    const facets = await svc.facets({ networkSource: "boostiny", fromDate: "not-a-date", toDate: "also-bad" });
    assert.ok(Array.isArray(facets.network));
    assert.ok(wheres.length > 0);
    for (const { where } of wheres) assert.equal(JSON.stringify(where).includes("createdAt"), false);
  });
});

describe("date filters: an invalid request never touches the list cache", () => {
  it("invalid list → 400; the following valid list runs its own count + findMany and returns the right total; the repeat is served from cache", async () => {
    const { service: svc, calls } = withRows(FIXTURE);
    const valid = { recordType: "campaign", networkSource: "optimise", page: 1, pageSize: 25 };
    calls.length = 0;
    await assert.rejects(svc.list({ ...valid, fromDate: "bad" }), isDateFilterError("Invalid fromDate."));
    assert.deepEqual(calls, []);
    const first = await svc.list(valid);
    assert.equal(first.total, 3);
    assert.equal(first.rows.length, 3);
    assert.deepEqual([...calls].sort(), ["entity.count", "entity.findMany"], "valid request performed its normal DB operations");
    calls.length = 0;
    const second = await svc.list(valid);
    assert.equal(second.total, 3);
    assert.deepEqual(calls, [], "identical valid request is a cache hit (cache works normally after the rejected call)");
    // and the invalid variant is still rejected afterwards — nothing was cached under it
    await assert.rejects(svc.list({ ...valid, fromDate: "bad" }), isDateFilterError("Invalid fromDate."));
    assert.deepEqual(calls, []);
  });
});

// ── active mapper errors: OPEN and RETRYING both block a record; RESOLVED / DISCARDED do not ──
const ACTIVE = { in: ["OPEN", "RETRYING"] };
const merr = (id, status, extra = {}) => ({ id, status, message: `MSG_${id}`, errorCode: "PROMOTION_FAILED", attempts: 1, createdAt: D("2026-09-12T00:00:00Z"), ...extra });
const MAPPER_FIXTURE = [
  ent("ma", "campaign", "awin", { mapperErrors: [merr("me-a", "OPEN")] }), // A: OPEN, unpromoted
  ent("mb", "campaign", "awin", { mapperErrors: [merr("me-b", "RETRYING", { attempts: 3 })] }), // B: RETRYING, unpromoted
  ent("mc", "campaign", "awin", { supplierCampaigns: [sc("mc", { supplier: "AWIN" })], mapperErrors: [merr("me-c", "RESOLVED", { resolvedAt: D("2026-09-13T00:00:00Z") })] }), // C: RESOLVED only, mapped
  ent("md", "campaign", "awin", { mapperErrors: [merr("me-d", "DISCARDED")] }), // D: DISCARDED only, unpromoted
  ent("me", "campaign", "cj", { mapperErrors: [merr("me-e1", "OPEN"), merr("me-e2", "RETRYING")] }), // E: OPEN + RETRYING on one entity
  ent("mf", "campaign", "awin", { supplierCampaigns: [sc("mf", { supplier: "AWIN" })], mapperErrors: [merr("me-f", "RETRYING")] }), // F: RETRYING + mapped
  ent("mg", "coupon", "awin", { mapperErrors: [merr("me-g", "RETRYING")] }), // G: coupon RETRYING, unpromoted
  ent("mh", "coupon", "awin", { supplierCoupons: [{ id: "cp-mh", couponCode: "H10", couponStatus: "ACTIVE", supplierCampaign: sc("mh", { supplier: "AWIN" }) }], mapperErrors: [merr("me-h", "RESOLVED")] }), // H: coupon RESOLVED + mapped
];
const listIds = (svc, filters) => svc.list({ ...filters, page: 1, pageSize: 100 }).then((r) => r.rows.map((x) => x.id).sort());
const rowById = (svc, filters, id) => svc.list({ ...filters, page: 1, pageSize: 100 }).then((r) => r.rows.find((x) => x.id === id));
const hasActive = (where) => JSON.stringify(where).includes(JSON.stringify({ status: ACTIVE }));

describe("active mapper errors: RETRYING is read exactly like OPEN", () => {
  it("1 unfiltered rows: RETRYING renders ERROR / FAILED with an active error id; RESOLVED / DISCARDED do not", async () => {
    const { service: svc } = withRows(MAPPER_FIXTURE);
    const b = await rowById(svc, { recordType: "campaign" }, "mb");
    assert.equal(b.mappingStatus, "ERROR");
    assert.equal(b.sourceStatus, "FAILED");
    assert.equal(b.openMapperErrorId, "me-b");
    assert.equal(Boolean(b.openMapperErrorId), true); // the controller's hasMapperError
    const f = await rowById(svc, { recordType: "campaign" }, "mf");
    assert.equal(f.mappingStatus, "ERROR");
    assert.equal(f.sourceStatus, "FAILED");
    const g = await rowById(svc, { recordType: "coupon" }, "mg");
    assert.equal(g.mappingStatus, "ERROR");
    assert.equal(g.sourceStatus, "FAILED");
    assert.equal(g.openMapperErrorId, "me-g");
    const c = await rowById(svc, { recordType: "campaign" }, "mc");
    assert.equal(c.mappingStatus, "MAPPED");
    assert.equal(c.sourceStatus, "PROCESSED");
    assert.equal(c.openMapperErrorId, null);
    const d = await rowById(svc, { recordType: "campaign" }, "md");
    assert.equal(d.mappingStatus, "NEEDS_REVIEW");
    assert.equal(d.sourceStatus, "IMPORTED");
    assert.equal(d.openMapperErrorId, null);
    const h = await rowById(svc, { recordType: "coupon" }, "mh");
    assert.equal(h.mappingStatus, "MAPPED");
    assert.equal(h.openMapperErrorId, null);
  });

  it("2-4 mappingStatus=ERROR, preset=mapping_errors and sourceStatus=FAILED include OPEN and RETRYING rows only", async () => {
    const { service: svc, wheres } = withRows(MAPPER_FIXTURE);
    for (const filters of [{ mappingStatus: "ERROR" }, { preset: "mapping_errors" }, { sourceStatus: "FAILED" }]) {
      assert.deepEqual(await listIds(svc, { recordType: "campaign", ...filters }), ["ma", "mb", "me", "mf"], JSON.stringify(filters));
      assert.deepEqual(await listIds(svc, { recordType: "coupon", ...filters }), ["mg"], JSON.stringify(filters));
      const where = await captured(wheres, () => svc.summary({ recordType: "campaign", ...filters }));
      assert.ok(hasActive(where), `${JSON.stringify(filters)}: predicate must be ${JSON.stringify(ACTIVE)} → ${JSON.stringify(where)}`);
      assert.ok(!JSON.stringify(where).includes('"status":"OPEN"'), `${JSON.stringify(filters)}: OPEN-only predicate regressed`);
    }
  });

  it("5-6 sourceStatus=PROCESSED excludes mapped-but-RETRYING F; sourceStatus=IMPORTED excludes unpromoted RETRYING B", async () => {
    const { service: svc, wheres } = withRows(MAPPER_FIXTURE);
    assert.deepEqual(await listIds(svc, { recordType: "campaign", sourceStatus: "PROCESSED" }), ["mc"]);
    assert.deepEqual(await listIds(svc, { recordType: "coupon", sourceStatus: "PROCESSED" }), ["mh"]);
    assert.deepEqual(await listIds(svc, { recordType: "campaign", sourceStatus: "IMPORTED" }), ["md"]);
    assert.deepEqual(await listIds(svc, { recordType: "coupon", sourceStatus: "IMPORTED" }), []);
    for (const sourceStatus of ["PROCESSED", "IMPORTED"]) {
      const where = await captured(wheres, () => svc.summary({ recordType: "campaign", sourceStatus }));
      assert.ok(JSON.stringify(where).includes(JSON.stringify({ none: { status: ACTIVE } })), `${sourceStatus}: none-active predicate → ${JSON.stringify(where)}`);
    }
  });

  it("7-9 NEEDS_REVIEW, preset=needs_review and preset=imported_not_normalized exclude every entity with an active error", async () => {
    const { service: svc, wheres } = withRows(MAPPER_FIXTURE);
    for (const filters of [{ mappingStatus: "NEEDS_REVIEW" }, { preset: "needs_review" }, { preset: "imported_not_normalized" }]) {
      assert.deepEqual(await listIds(svc, { recordType: "campaign", ...filters }), ["md"], JSON.stringify(filters));
      assert.deepEqual(await listIds(svc, { recordType: "coupon", ...filters }), [], JSON.stringify(filters));
      const where = await captured(wheres, () => svc.summary({ recordType: "campaign", ...filters }));
      assert.ok(JSON.stringify(where).includes(JSON.stringify({ none: { status: ACTIVE } })), `${JSON.stringify(filters)} → ${JSON.stringify(where)}`);
    }
  });

  it("10-12 summary: mappingErrors counts active rows, needsReview excludes active entities, ERROR parity with the list", async () => {
    const { service: svc, wheres } = withRows(MAPPER_FIXTURE);
    wheres.length = 0;
    const campaign = await svc.summary({ recordType: "campaign" });
    assert.equal(campaign.importedRecords, 6);
    assert.equal(campaign.mappingErrors, 5); // A, B, E×2, F — RESOLVED (C) and DISCARDED (D) never count
    assert.equal(campaign.needsReview, 1); // D only
    assert.deepEqual(lastWhere(wheres, "mapperError.count").status, ACTIVE);
    const needsReviewWhere = wheres.find((w) => w.op === "entity.count" && "AND" in (w.where || {})).where;
    assert.ok(JSON.stringify(needsReviewWhere).includes(JSON.stringify({ none: { status: ACTIVE } })));
    const coupon = await svc.summary({ recordType: "coupon" });
    assert.equal(coupon.importedRecords, 2);
    assert.equal(coupon.mappingErrors, 1); // G
    assert.equal(coupon.needsReview, 0); // G active, H mapped
    for (const recordType of ["campaign", "coupon"]) {
      const s = await svc.summary({ recordType, mappingStatus: "ERROR" });
      assert.equal(s.importedRecords, await listTotal(svc, { recordType, mappingStatus: "ERROR" }), recordType);
      const f = await svc.summary({ recordType, sourceStatus: "FAILED" });
      assert.equal(f.importedRecords, await listTotal(svc, { recordType, sourceStatus: "FAILED" }), recordType);
    }
  });

  it("MAPPED / preset=normalized require no active error: mapped+RETRYING (F) and mapped+OPEN are excluded, mapped+RESOLVED (C, H) included", async () => {
    const MAPPED_OPEN = ent("mo", "campaign", "awin", { supplierCampaigns: [sc("mo", { supplier: "AWIN" })], mapperErrors: [merr("me-o", "OPEN")] });
    const COUPON_RETRYING_MAPPED = ent("mk", "coupon", "awin", { supplierCoupons: [{ id: "cp-mk", couponCode: "K10", couponStatus: "ACTIVE", supplierCampaign: sc("mk", { supplier: "AWIN" }) }], mapperErrors: [merr("me-k", "RETRYING")] });
    const { service: svc, wheres } = withRows([...MAPPER_FIXTURE, MAPPED_OPEN, COUPON_RETRYING_MAPPED]);
    // rows still render ERROR (active error takes precedence over the successful mapping)
    for (const id of ["mf", "mo"]) assert.equal((await rowById(svc, { recordType: "campaign" }, id)).mappingStatus, "ERROR", id);
    assert.equal((await rowById(svc, { recordType: "coupon" }, "mk")).mappingStatus, "ERROR");
    assert.equal((await rowById(svc, { recordType: "campaign" }, "mc")).mappingStatus, "MAPPED");
    for (const filters of [{ mappingStatus: "MAPPED" }, { preset: "normalized" }]) {
      assert.deepEqual(await listIds(svc, { recordType: "campaign", ...filters }), ["mc"], JSON.stringify(filters)); // not mf, not mo
      assert.deepEqual(await listIds(svc, { recordType: "coupon", ...filters }), ["mh"], JSON.stringify(filters)); // not mk
      const where = await captured(wheres, () => svc.summary({ recordType: "campaign", ...filters }));
      const text = JSON.stringify(where);
      assert.ok(text.includes(JSON.stringify({ mapperErrors: { none: { status: ACTIVE } } }).slice(1, -1)), `${JSON.stringify(filters)}: none-active guard missing → ${text}`);
      assert.ok(text.includes('"merchantId":{"not":null}') && text.includes('"campaignSources":{"some":{"isActive":true}}') && text.includes('"supplierCoupons":{"some":{}}'), `${JSON.stringify(filters)}: mapping relation predicate changed → ${text}`);
      for (const recordType of ["campaign", "coupon"]) {
        assert.equal((await svc.summary({ recordType, ...filters })).importedRecords, await listTotal(svc, { recordType, ...filters }), `${recordType} ${JSON.stringify(filters)} parity`);
      }
    }
    // a mapped record whose only errors are RESOLVED / DISCARDED is MAPPED
    const MAPPED_DISCARDED = ent("mq", "campaign", "awin", { supplierCampaigns: [sc("mq", { supplier: "AWIN" })], mapperErrors: [merr("me-q", "DISCARDED")] });
    const { service: svc2 } = withRows([...MAPPER_FIXTURE, MAPPED_DISCARDED]);
    assert.deepEqual(await listIds(svc2, { recordType: "campaign", mappingStatus: "MAPPED" }), ["mc", "mq"]);
    assert.deepEqual(await listIds(svc2, { recordType: "campaign", preset: "normalized" }), ["mc", "mq"]);
    assert.equal((await svc2.summary({ recordType: "campaign", mappingStatus: "MAPPED" })).importedRecords, 2);
  });

  it("row-count semantics: one entity with OPEN + RETRYING → importedRecords 1, mappingErrors 2", async () => {
    const { service: svc } = withRows(MAPPER_FIXTURE);
    const s = await svc.summary({ recordType: "campaign", networkSource: "cj" }); // E only
    assert.equal(s.importedRecords, 1);
    assert.equal(s.mappingErrors, 2);
    assert.equal(s.needsReview, 0);
    assert.deepEqual(await listIds(svc, { recordType: "campaign", networkSource: "cj", mappingStatus: "ERROR" }), ["me"]);
  });

  it("13 OPEN behaviour unchanged: A is treated exactly like B under every predicate", async () => {
    const { service: svc } = withRows(MAPPER_FIXTURE);
    for (const filters of [{ mappingStatus: "ERROR" }, { preset: "mapping_errors" }, { sourceStatus: "FAILED" }]) {
      const ids = await listIds(svc, { recordType: "campaign", networkSource: "awin", ...filters });
      assert.ok(ids.includes("ma") && ids.includes("mb"), JSON.stringify(filters));
    }
    for (const filters of [{ mappingStatus: "NEEDS_REVIEW" }, { sourceStatus: "IMPORTED" }, { sourceStatus: "PROCESSED" }]) {
      const ids = await listIds(svc, { recordType: "campaign", networkSource: "awin", ...filters });
      assert.ok(!ids.includes("ma") && !ids.includes("mb"), JSON.stringify(filters));
    }
    const a = await rowById(svc, { recordType: "campaign" }, "ma");
    assert.equal(a.mappingStatus, "ERROR");
    assert.equal(a.openMapperErrorId, "me-a");
  });

  it("14 RESOLVED / DISCARDED are inactive everywhere", async () => {
    const { service: svc } = withRows(MAPPER_FIXTURE.filter((e) => ["mc", "md", "mh"].includes(e.id)));
    const s = await svc.summary({ recordType: "campaign" });
    assert.equal(s.importedRecords, 2);
    assert.equal(s.mappingErrors, 0);
    assert.equal(s.needsReview, 1); // D
    assert.equal((await svc.summary({ recordType: "coupon" })).mappingErrors, 0);
    for (const filters of [{ mappingStatus: "ERROR" }, { preset: "mapping_errors" }, { sourceStatus: "FAILED" }]) {
      assert.deepEqual(await listIds(svc, { recordType: "campaign", ...filters }), [], JSON.stringify(filters));
      assert.deepEqual(await listIds(svc, { recordType: "coupon", ...filters }), [], JSON.stringify(filters));
    }
    assert.deepEqual(await listIds(svc, { recordType: "campaign", sourceStatus: "PROCESSED" }), ["mc"]);
    assert.deepEqual(await listIds(svc, { recordType: "campaign", sourceStatus: "IMPORTED" }), ["md"]);
    assert.deepEqual(await listIds(svc, { recordType: "campaign", mappingStatus: "NEEDS_REVIEW" }), ["md"]);
    assert.deepEqual(await listIds(svc, { recordType: "coupon", sourceStatus: "PROCESSED" }), ["mh"]);
  });

  it("detail keeps the raw stored status: mapping.mapperError.status === \"RETRYING\" with a Retry action", async () => {
    const { service: svc } = withRows(MAPPER_FIXTURE);
    const detail = await svc.getById("mb");
    assert.equal(detail.mappingStatus, "ERROR");
    assert.equal(detail.sourceStatus, "FAILED");
    assert.equal(detail.mapping.mapperError.status, "RETRYING");
    assert.equal(detail.mapping.mapperError.id, "me-b");
    assert.equal(detail.mapping.mapperError.attempts, 3);
    assert.ok(detail.actions.some((a) => a.key === "retry" && a.mapperErrorId === "me-b"));
    const resolved = await svc.getById("mc");
    assert.equal(resolved.mapping.mapperError, null);
    assert.ok(!resolved.actions.some((a) => a.key === "retry"));
  });

  it("list include and summary count both use the shared active predicate; query budget unchanged", async () => {
    const { service: svc, calls, wheres } = withRows(MAPPER_FIXTURE);
    calls.length = 0;
    await svc.summary({ recordType: "campaign" });
    assert.equal(calls.length, 5);
    await svc.summary({ recordType: "commission_rule" });
    assert.equal(calls.length, 9);
    const count = wheres.filter((w) => w.op === "mapperError.count");
    assert.ok(count.length === 2 && count.every((w) => JSON.stringify(w.where.status) === JSON.stringify(ACTIVE)));
  });
});
