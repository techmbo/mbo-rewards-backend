/**
 * GET /ops/imported-records freshness — All Network Data always reads the current database.
 *
 * The list used to sit behind two module-level Maps (rows and totals, five-minute TTL). Under
 * multi-instance serverless execution an entry populated on one warm instance outlived every
 * write made on another, so these tests pin the replacement contract: the SAME service instance,
 * called twice with the SAME filters, reflects every store mutation made in between, with no
 * sleeps, no clock, and no re-instantiation. Fixtures are synthetic; no live values.
 */
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const serviceModule = await import("../src/modules/ops/importedRecords.service.js");
const { ImportedRecordsService } = serviceModule;
const controller = await import("../src/controllers/importedRecords.controller.js");
const { getPermissionsForRole } = await import("../src/auth/permissions.js");

// ── where evaluator (same subset the sibling imported-record suites evaluate) ─────────────────
const OPERATORS = new Set(["equals", "contains", "startsWith", "endsWith", "in", "not", "mode", "gte", "lte", "gt", "lt", "has", "hasSome", "hasEvery", "isEmpty"]);
const cmp = (v) => (v instanceof Date ? v.getTime() : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? Date.parse(v) : v);
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

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────
const D = (s) => new Date(s);
const S = {
  trackingUrl: "https://track.sentinel.example/c?t=TOK_SENTINEL",
  sourceOnly: "SENTINEL_SOURCE_ONLY_FIELD",
  mapperText: "MAPPER_ERROR_TEXT_SENTINEL",
};
const TEXT_SENTINELS = ["track.sentinel.example", "TOK_SENTINEL", S.sourceOnly, S.mapperText];

function openError(id, status = "OPEN") {
  return { id, status, message: S.mapperText, errorCode: "MAPPER_FAILED", attempts: 1, createdAt: D("2026-09-10T00:00:00Z") };
}

/** A promoted SupplierCampaign; pass `linked: false` for one that has no merchant and no source yet. */
function sc(id, { linked = true, ...extra } = {}) {
  return {
    id: `sc-${id}`,
    supplier: "OPTIMISE",
    supplierCampaignId: `EXT-${id}`,
    sourceAccountLabel: "default",
    campaignName: `Promoted ${id}`,
    merchantNameRaw: "Brand One",
    merchantId: linked ? "m-1" : null,
    merchant: linked ? { id: "m-1", displayName: "Brand One", logoUrl: null, website: null } : null,
    trackingUrl: S.trackingUrl,
    defaultCommissionValue: 12.5,
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
    mappingCertification: null,
    coupons: [],
    _count: { coupons: 0, supplierCommissionRules: 0 },
    campaignSources: linked
      ? [{ id: `cs-${id}`, canonicalCampaignId: `cc-${id}`, isActive: true, isPrimary: true, priority: 1, status: "LINKED", relationshipStatus: "JOINED", trackingLinks: [], _count: { productFeeds: 0 } }]
      : [],
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
    advertiserName: `Advertiser ${id}`,
    rawData: { secret_source_field: S.sourceOnly },
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

function fixture() {
  return [
    ent("a", "campaign", "optimise_sea", { supplierCampaigns: [sc("a")], updatedAt: D("2026-09-13T00:00:00Z") }), // MAPPED
    ent("b", "campaign", "optimise_sea", { updatedAt: D("2026-09-12T00:00:00Z") }), // not promoted
    ent("c", "campaign", "boostiny", { supplierCampaigns: [sc("c", { linked: false })], updatedAt: D("2026-09-11T00:00:00Z") }), // promoted, unlinked
    ent("k", "coupon", "boostiny", { supplierCoupons: [{ id: "cp-k", couponCode: "SAVE10", couponStatus: "ACTIVE", supplierCampaign: sc("k") }] }),
    ent("r", "commission_rule", "rakuten"),
  ];
}

// ── fake Prisma over a LIVE, mutable row array ───────────────────────────────────────────────
function makeDb(rows) {
  const calls = [];
  const record = (op, where) => calls.push({ op, where });
  const matched = (where) => rows.filter((e) => matchWhere(e, where));
  const sortLatest = (list) => [...list].sort((a, b) => b.updatedAt - a.updatedAt || String(b.id).localeCompare(String(a.id)));
  /** Applies the include's relation filters the way Prisma would (active mapper errors only). */
  const withIncludes = (e, include) => {
    const out = { ...e };
    const meWhere = include?.mapperErrors?.where;
    if (meWhere) {
      out.mapperErrors = (e.mapperErrors || []).filter((m) => matchWhere(m, meWhere));
      const take = include.mapperErrors.take;
      if (take != null) out.mapperErrors = out.mapperErrors.slice(0, take);
    }
    return out;
  };
  const groupBy = (model) => async ({ by, where, _count, _max } = {}) => {
    record(`${model}.groupBy`, where);
    const groups = new Map();
    for (const e of matched(where)) {
      const key = JSON.stringify(by.map((k) => e[k]));
      let g = groups.get(key);
      if (!g) {
        g = Object.fromEntries(by.map((k) => [k, e[k]]));
        if (_count) g._count = 0;
        if (_max) g._max = {};
        groups.set(key, g);
      }
      if (_count) g._count += 1;
      if (_max) for (const k of Object.keys(_max)) if (!g._max[k] || e[k] > g._max[k]) g._max[k] = e[k];
    }
    return [...groups.values()];
  };
  const db = {
    entity: {
      count: async ({ where } = {}) => (record("entity.count", where), matched(where).length),
      findMany: async ({ where, skip = 0, take, include } = {}) => {
        record("entity.findMany", where);
        const all = sortLatest(matched(where)).map((e) => withIncludes(e, include));
        return take != null ? all.slice(skip, skip + take) : all.slice(skip);
      },
      findUnique: async ({ where, include } = {}) => {
        record("entity.findUnique", where);
        const e = rows.find((r) => r.id === where?.id);
        return e ? withIncludes(e, include) : null;
      },
      groupBy: groupBy("entity"),
    },
    mapperError: {
      count: async ({ where } = {}) => {
        record("mapperError.count", where);
        const { entity: entityWhere, ...rest } = where || {};
        let n = 0;
        for (const e of entityWhere ? matched(entityWhere) : rows) n += (e.mapperErrors || []).filter((m) => matchWhere(m, rest)).length;
        return n;
      },
    },
  };
  const count = (op) => calls.filter((c) => c.op === op).length;
  return { db, calls, count };
}

const byId = (result, id) => result.rows.find((r) => r.id === id);
const CAMPAIGN = { recordType: "campaign" };

let rows;
let db;
let calls;
let count;
let service;
beforeEach(() => {
  rows = fixture();
  ({ db, calls, count } = makeDb(rows));
  // ONE instance for the whole test: freshness must come from the service, not from a new object.
  service = new ImportedRecordsService({ prisma: db, promotionJob: {}, normalization: {} });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("freshness: rows and counts", () => {
  it("1. the first read reflects the fixture", async () => {
    const r = await service.list(CAMPAIGN);
    assert.equal(r.total, 3);
    assert.deepEqual(r.rows.map((x) => x.id), ["a", "b", "c"]);
    assert.equal(byId(r, "a").mappingStatus, "MAPPED");
    assert.equal(byId(r, "b").mappingStatus, "NEEDS_REVIEW");
    assert.equal(byId(r, "c").mappingStatus, "NEEDS_REVIEW");
  });

  it("2. an entity mutation is visible on the immediate next identical call", async () => {
    const first = await service.list(CAMPAIGN);
    assert.equal(byId(first, "b").campaign, "Campaign b");
    rows.find((e) => e.id === "b").campaignName = "Renamed by sync";
    const second = await service.list(CAMPAIGN);
    assert.equal(byId(second, "b").campaign, "Renamed by sync");
  });

  it("3. the standard path queries the database on every call: two lists, two findMany, two count", async () => {
    await service.list(CAMPAIGN);
    await service.list(CAMPAIGN);
    assert.equal(count("entity.findMany"), 2);
    assert.equal(count("entity.count"), 2);
  });

  it("9. a new entity changes the total immediately", async () => {
    assert.equal((await service.list(CAMPAIGN)).total, 3);
    rows.push(ent("d", "campaign", "trackier"));
    assert.equal((await service.list(CAMPAIGN)).total, 4);
  });

  it("10. pagination total and hasMore follow the current store", async () => {
    const filters = { ...CAMPAIGN, pageSize: 2, page: 1 };
    const first = await service.list(filters);
    assert.equal(first.total, 3);
    assert.equal(first.hasMore, true);

    rows.push(ent("d", "campaign", "trackier"));
    const grown = await service.list(filters);
    assert.equal(grown.total, 4);
    assert.equal(grown.hasMore, true);

    rows.splice(0, rows.length, ...rows.filter((e) => e.id === "a" || e.id === "b" || e.entityType !== "campaign"));
    const shrunk = await service.list(filters);
    assert.equal(shrunk.total, 2);
    assert.equal(shrunk.rows.length, 2);
    assert.equal(shrunk.hasMore, false);
  });

  it("11. a newly written campaign is found by the same search immediately", async () => {
    const filters = { ...CAMPAIGN, search: "Winter" };
    assert.equal((await service.list(filters)).total, 0);
    rows.push(ent("w", "campaign", "optimise_sea", { campaignName: "Winter Clearance" }));
    const found = await service.list(filters);
    assert.equal(found.total, 1);
    assert.equal(found.rows[0].id, "w");
  });
});

describe("freshness: mapper error lifecycle", () => {
  it("4. an OPEN mapper error turns a mapped row into ERROR / FAILED on the next call", async () => {
    const before = byId(await service.list(CAMPAIGN), "a");
    assert.equal(before.mappingStatus, "MAPPED");
    assert.equal(before.sourceStatus, "PROCESSED");
    assert.equal(before.openMapperErrorId, null);

    rows.find((e) => e.id === "a").mapperErrors.push(openError("me-a"));

    const after = byId(await service.list(CAMPAIGN), "a");
    assert.equal(after.mappingStatus, "ERROR");
    assert.equal(after.sourceStatus, "FAILED");
    assert.equal(after.openMapperErrorId, "me-a");
  });

  it("5. RETRYING stays an active error on the next call", async () => {
    const error = openError("me-a");
    rows.find((e) => e.id === "a").mapperErrors.push(error);
    assert.equal(byId(await service.list(CAMPAIGN), "a").mappingStatus, "ERROR");

    error.status = "RETRYING";

    const after = byId(await service.list(CAMPAIGN), "a");
    assert.equal(after.mappingStatus, "ERROR");
    assert.equal(after.sourceStatus, "FAILED");
    assert.equal(after.openMapperErrorId, "me-a");
  });

  it("6. RESOLVED drops out on the next call and the joined state returns", async () => {
    const error = openError("me-a", "RETRYING");
    rows.find((e) => e.id === "a").mapperErrors.push(error);
    assert.equal(byId(await service.list(CAMPAIGN), "a").mappingStatus, "ERROR");

    error.status = "RESOLVED";

    const after = byId(await service.list(CAMPAIGN), "a");
    assert.equal(after.mappingStatus, "MAPPED");
    assert.equal(after.sourceStatus, "PROCESSED");
    assert.equal(after.openMapperErrorId, null);
  });

  it("12. preset=mapping_errors membership follows the error status immediately", async () => {
    const filters = { ...CAMPAIGN, preset: "mapping_errors" };
    assert.equal((await service.list(filters)).total, 0);

    const error = openError("me-b");
    rows.find((e) => e.id === "b").mapperErrors.push(error);
    const entered = await service.list(filters);
    assert.deepEqual(entered.rows.map((r) => r.id), ["b"]);
    assert.equal(entered.total, 1);

    error.status = "RETRYING";
    assert.equal((await service.list(filters)).total, 1, "RETRYING is still active");

    error.status = "RESOLVED";
    const left = await service.list(filters);
    assert.equal(left.total, 0);
    assert.deepEqual(left.rows, []);
  });
});

describe("freshness: promotion and normalization", () => {
  it("7. a SupplierCampaign written between calls appears on the next call", async () => {
    const before = byId(await service.list(CAMPAIGN), "b");
    assert.equal(before.supplierCampaignId, null);
    assert.equal(before.issueCode, "CAMPAIGN_NOT_PROMOTED");

    rows.find((e) => e.id === "b").supplierCampaigns.push(sc("b", { linked: false }));

    const after = byId(await service.list(CAMPAIGN), "b");
    assert.equal(after.supplierCampaignId, "sc-b");
    assert.equal(after.supplierCampaignExtId, "EXT-b");
    assert.equal(after.campaign, "Promoted b");
    assert.equal(after.mappingStatus, "NEEDS_REVIEW", "promoted but not yet merchant-linked");
    assert.notEqual(after.issueCode, "CAMPAIGN_NOT_PROMOTED");
  });

  it("8. merchant link and active CampaignSource written between calls appear on the next call", async () => {
    const before = byId(await service.list(CAMPAIGN), "c");
    assert.equal(before.merchantId, null);
    assert.equal(before.campaignSourceId, null);
    assert.equal(before.mappingStatus, "NEEDS_REVIEW");

    const stored = rows.find((e) => e.id === "c").supplierCampaigns[0];
    stored.merchantId = "m-9";
    stored.merchant = { id: "m-9", displayName: "Brand Nine", logoUrl: null, website: null };
    stored.campaignSources = [
      { id: "cs-c", canonicalCampaignId: "cc-c", isActive: true, isPrimary: true, priority: 1, status: "LINKED", relationshipStatus: "JOINED", trackingLinks: [], _count: { productFeeds: 0 } },
    ];

    const after = byId(await service.list(CAMPAIGN), "c");
    assert.equal(after.brand, "Brand Nine");
    assert.equal(after.merchantId, "m-9");
    assert.equal(after.campaignSourceId, "cs-c");
    assert.equal(after.canonicalCampaignId, "cc-c");
    assert.equal(after.relationshipStatus, "JOINED");
    assert.equal(after.mappingStatus, "MAPPED");
    assert.equal(after.sourceStatus, "PROCESSED");
    assert.equal(typeof after.mboReady, "boolean", "readiness is derived from the current joins");
  });

  it("13. list and summary agree immediately after a mutation", async () => {
    const agree = async () => {
      const [list, summary] = await Promise.all([service.list(CAMPAIGN), service.summary(CAMPAIGN)]);
      assert.equal(list.total, summary.importedRecords);
      const listErrors = list.rows.filter((r) => r.mappingStatus === "ERROR").length;
      assert.equal(listErrors, summary.mappingErrors);
      return { list, summary };
    };
    const base = await agree();
    assert.equal(base.summary.mappingErrors, 0);

    rows.find((e) => e.id === "a").mapperErrors.push(openError("me-a"));
    rows.push(ent("d", "campaign", "trackier"));
    const after = await agree();
    assert.equal(after.summary.mappingErrors, 1);
    assert.equal(after.list.total, 4);
  });
});

describe("freshness: grouped and exact-boolean paths", () => {
  it("15. groupBy brand queries fresh state on every call and reflects a mutation", async () => {
    const filters = { ...CAMPAIGN, groupBy: "brand" };
    const first = await service.list(filters);
    assert.equal(first.total, 3, "one group per fixture advertiser");
    assert.equal(count("entity.groupBy"), 1);

    rows.push(ent("d", "campaign", "trackier", { advertiserName: "Advertiser d" }));

    const second = await service.list(filters);
    assert.equal(second.total, 4);
    assert.equal(count("entity.groupBy"), 2);
    assert.equal(count("entity.findMany"), 2);
  });

  it("16. exact isAssignable and mboReady filters re-evaluate the current store", async () => {
    // Rows without a SupplierCampaign derive isAssignable / mboReady false, which the exact filter
    // recomputes in memory from whatever the database returns on THIS call.
    const notAssignable = { ...CAMPAIGN, isAssignable: "false" };
    const notReady = { ...CAMPAIGN, mboReady: "false" };
    const a0 = await service.list(notAssignable);
    const m0 = await service.list(notReady);
    assert.ok(a0.rows.some((r) => r.id === "b"));
    assert.ok(m0.rows.some((r) => r.id === "b"));
    assert.ok(a0.rows.every((r) => r.isAssignable === false));
    assert.ok(m0.rows.every((r) => r.mboReady === false));

    rows.push(ent("d", "campaign", "trackier"));
    const a1 = await service.list(notAssignable);
    const m1 = await service.list(notReady);
    assert.equal(a1.total, a0.total + 1);
    assert.equal(m1.total, m0.total + 1);
    assert.ok(a1.rows.some((r) => r.id === "d"));
    assert.ok(m1.rows.some((r) => r.id === "d"));

    rows.splice(rows.findIndex((e) => e.id === "d"), 1);
    assert.equal((await service.list(notAssignable)).total, a0.total);
    assert.equal((await service.list(notReady)).total, m0.total);
    assert.ok(typeof a1.note === "string");
  });
});

// ── security boundary through the real handler, consecutive callers ─────────────────────────

describe("freshness: security boundary is unchanged", () => {
  const proto = ImportedRecordsService.prototype;
  const originalList = proto.list;
  let routed;
  before(() => {
    // The controller's module-level service must read our fake store: route its prototype to the
    // instance under test, exactly as the response-boundary suite does.
    proto.list = function list(filters) {
      return originalList.call(routed, filters);
    };
  });
  after(() => {
    proto.list = originalList;
  });

  async function invoke(role, query) {
    routed = service;
    const req = { query, user: { id: `user-${role}`, role, isActive: true }, permissions: getPermissionsForRole(role) };
    let status = 200;
    let body = null;
    const res = {
      set() {},
      status(code) {
        status = code;
        return res;
      },
      json(payload) {
        body = payload;
        return res;
      },
    };
    let failure = null;
    await controller.listImportedRecordsHandler(req, res, (err) => {
      failure = err;
    });
    assert.equal(failure, null);
    return { status, body, text: JSON.stringify(body) };
  }

  it("14. privileged then restricted caller: identical projected rows, no raw / source-only / sentinel leak, and the second caller reads fresh state", async () => {
    const query = { recordType: "campaign", q: "EXT-a" };
    const admin = await invoke("ADMIN", query);
    assert.equal(admin.status, 200);
    assert.equal(admin.body.data.length, 1);
    for (const s of TEXT_SENTINELS) assert.ok(!admin.text.includes(s), `privileged: ${s} leaked`);

    const tech = await invoke("TECH", query);
    assert.equal(tech.status, 200);
    assert.equal(tech.text, admin.text, "identical projected output for both callers");
    for (const s of TEXT_SENTINELS) assert.ok(!tech.text.includes(s), `restricted: ${s} leaked`);
    assert.equal(tech.body.data[0].hasMapperError, false);
    assert.equal(count("entity.findMany"), 2, "no shared cache between the two callers");

    // A write between the callers is visible to the restricted caller, still without leaks.
    rows.find((e) => e.id === "a").mapperErrors.push(openError("me-a"));
    const techAgain = await invoke("TECH", query);
    assert.equal(techAgain.body.data[0].hasMapperError, true);
    assert.equal(techAgain.body.data[0].mappingStatus, "ERROR");
    for (const s of TEXT_SENTINELS) assert.ok(!techAgain.text.includes(s), `restricted after write: ${s} leaked`);
  });
});

// ── no cache remains ─────────────────────────────────────────────────────────────────────────

describe("freshness: the cache is gone", () => {
  it("17. the service module no longer exports invalidateImportedRecordsListCache and holds no cache symbols", () => {
    assert.equal(serviceModule.invalidateImportedRecordsListCache, undefined);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "..", "src", "modules", "ops", "importedRecords.service.js"), "utf8");
    for (const symbol of ["listCache", "countCache", "COUNT_CACHE_TTL_MS", "LIST_CACHE_TTL_MS", "cachedEntityCount", "invalidateImportedRecordsListCache"]) {
      assert.ok(!src.includes(symbol), `${symbol} still present`);
    }
  });
});
