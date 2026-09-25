/**
 * GET /ops/imported-records (+ /:id, /summary, /columns) — All Network Data response boundary.
 *
 * Drives the real controller handlers through real Express routing, behind the same route guard
 * as production (requirePermission(campaigns:read)). The service runs its real list / detail /
 * summary code — toListRow, toDetailDto, the shared list cache — over a fake Prisma whose rows
 * carry sentinel values in every raw / URL / id / money / error position.
 */
process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import express from "express";

const { ImportedRecordsService } = await import("../src/modules/ops/importedRecords.service.js");
const controller = await import("../src/controllers/importedRecords.controller.js");
const { requirePermission } = await import("../src/middleware/auth.js");
const { PERMISSIONS, getPermissionsForRole } = await import("../src/auth/permissions.js");

const S = {
  srcField: "SENTINEL_SOURCE_ONLY_FIELD",
  trackingUrl: "https://track.sentinel.example/c?token=TOK_SENTINEL",
  mboUrl: "https://go.sentinel.example/r/brand/TOK_REDIRECT_SENTINEL",
  landing: "https://landing.sentinel.example/page",
  deeplink: "https://deeplink.sentinel.example/x",
  couponLink: "https://coupon.sentinel.example/deal",
  networkClickId: "NCLICK_SENTINEL",
  mboClickId: "MCLICK_SENTINEL",
  subId: "SUBID_SENTINEL",
  orderId: "ORDER_SENTINEL",
  conversionId: "CONVERSION_SENTINEL",
  rawPayloadId: "RAWPAYLOAD_SENTINEL",
  mapperText: "MAPPER_ERROR_TEXT_SENTINEL",
  mapperRetryText: "RETRYING_MAPPER_TEXT_SENTINEL",
  commission: 987654.321,
  grossOrderValue: 876543.21,
  grossCommission: 765432.1,
  revenue: 654321.09,
  payout: 543210.98,
  advertiserUrl: "https://advertiser.sentinel.example",
  schemeUrl: "ftp://files.sentinel.example/x",
  redirectPath: "/r/slug/TOKEN_PATH_SENTINEL",
};
const TEXT_SENTINELS = [
  S.srcField,
  S.mapperRetryText,
  "track.sentinel.example",
  "TOK_SENTINEL",
  "TOK_REDIRECT_SENTINEL",
  "landing.sentinel.example",
  "deeplink.sentinel.example",
  "coupon.sentinel.example",
  S.networkClickId,
  S.mboClickId,
  S.subId,
  S.orderId,
  S.conversionId,
  S.rawPayloadId,
  S.mapperText,
  "advertiser.sentinel.example",
  "files.sentinel.example",
  "TOKEN_PATH_SENTINEL",
];
const MONEY_SENTINELS = ["987654.321", "876543.21", "765432.1", "654321.09", "543210.98", "12345.67"];

function rawData(extra = {}) {
  return {
    tracking_url: S.trackingUrl,
    landing_page_url: S.landing,
    deeplink: S.deeplink,
    click_id: S.networkClickId,
    mbo_click_id: S.mboClickId,
    sub_id1: S.subId,
    subid2: S.subId,
    order_id: S.orderId,
    conversion_id: S.conversionId,
    commission: S.commission,
    gross_order_value: S.grossOrderValue,
    gross_commission: S.grossCommission,
    revenue: S.revenue,
    payout: S.payout,
    raw_payload_id: S.rawPayloadId,
    unlisted_supplier_key: S.srcField,
    nested: { deep: S.srcField, url: S.trackingUrl },
    ...extra,
  };
}

const merchant = { id: "merchant-1", displayName: "Brand One", logoUrl: S.landing, website: S.landing };

function supplierCampaign(id) {
  return {
    id: `sc-${id}`,
    supplier: "OPTIMISE",
    supplierCampaignId: `EXT-${id}`,
    sourceAccountLabel: "default",
    campaignName: `Campaign ${id}`,
    merchantNameRaw: "Brand One",
    merchantId: merchant.id,
    merchant,
    trackingUrl: S.trackingUrl,
    mboTrackingUrl: S.mboUrl,
    destinationUrl: S.landing,
    deeplinkUrl: S.deeplink,
    rawPayloadId: S.rawPayloadId,
    defaultCommissionValue: S.commission,
    commissionUnit: "PERCENT",
    commissionCurrency: "USD",
    currencyCode: "USD",
    countryCodes: ["AE", S.schemeUrl],
    categoryName: "Fashion",
    campaignType: "CPS",
    relationshipStatus: "JOINED",
    campaignStatus: "ACTIVE",
    lastSyncedAt: new Date("2026-09-20T00:00:00Z"),
    normalizedPayload: { commission: S.commission, trackingUrl: S.trackingUrl },
    _count: { coupons: 3, supplierCommissionRules: 2 },
    // A related coupon: its code must never make the campaign row match a search.
    coupons: [{ id: `cpn-${id}`, couponCode: "SAVE10" }],
    campaignSources: [
      {
        id: `cs-${id}`,
        canonicalCampaignId: `cc-${id}`,
        status: "ACTIVE",
        trackingLinks: [{ id: "tl-1", mboTrackingUrl: S.mboUrl, supplierTrackingUrl: S.trackingUrl, subId: S.subId }],
        _count: { productFeeds: 1 },
      },
    ],
  };
}

function entity(id, entityType, extra = {}) {
  return {
    id,
    entityType,
    networkSource: "optimise",
    externalId: `default:${id}`,
    entityName: `Entity ${id}`,
    campaignName: `Campaign ${id}`,
    advertiserName: S.advertiserUrl, // URL-shaped value in an otherwise safe-looking field
    rawData: rawData(),
    normalizedData: { commission: S.commission, networkClickId: S.networkClickId },
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-02T00:00:00Z"),
    supplierCampaigns: [],
    supplierCoupons: [],
    mapperErrors: [
      { id: "me-1", status: "OPEN", message: S.mapperText, errorCode: "MISSING_MERCHANT", attempts: 1, createdAt: new Date("2026-09-01T00:00:00Z") },
    ],
    rawPayloads: [{ id: S.rawPayloadId, resourceKey: "campaigns", fetchedAt: new Date(), processingStatus: "PROCESSED", payload: rawData(), payloadText: S.srcField }],
    ...extra,
  };
}

const ENTITIES = {
  "ent-campaign": entity("ent-campaign", "campaign", {
    supplierCampaigns: [supplierCampaign("1")],
    // Punctuated but not URL-shaped: must stay searchable.
    entityName: "Entity campaign_001 abc:def",
  }),
  "ent-coupon": entity("ent-coupon", "coupon", {
    supplierCoupons: [{ id: "cp-1", couponCode: "SAVE10", couponLink: S.couponLink, couponStatus: "ACTIVE", supplierCampaign: supplierCampaign("2") }],
  }),
  "ent-coupon-url": entity("ent-coupon-url", "coupon", {
    supplierCoupons: [{ id: "cp-2", couponCode: S.couponLink, couponLink: S.couponLink, couponStatus: "ACTIVE", supplierCampaign: supplierCampaign("3") }],
  }),
  "ent-rule": entity("ent-rule", "commission_rule", {
    campaignName: S.redirectPath,
    // URL-shaped supplier campaign text columns (bad data): never searchable by any substring.
    supplierCampaigns: [
      {
        ...supplierCampaign("9"),
        campaignName: "https://campaignurl.sentinel.example/path/CAMPTOKEN_SENTINEL",
        merchantNameRaw: "https://merchant.sentinel.example",
        sourceAccountLabel: "https://account.sentinel.example/x",
        coupons: [],
      },
    ],
  }),
  "ent-coupon-20": entity("ent-coupon-20", "coupon", {
    supplierCoupons: [{ id: "cp-20", couponCode: "SAVE20", couponLink: null, couponStatus: "ACTIVE", supplierCampaign: supplierCampaign("4") }],
  }),
  // URL-shaped values sitting in otherwise searchable columns (bad data): hidden by the response,
  // so a search for them must match nothing.
  "ent-group": entity("ent-group", "commission_group", {
    entityName: "www.example.com",
    campaignName: "customscheme://secret",
    externalId: "//example.com/path",
    advertiserName: "/r/test/token123",
  }),
  // A coupon whose promotion retry was interrupted: the only mapper error is RETRYING. It must read
  // as an active error (ERROR / FAILED / hasMapperError) everywhere, and its text must never leave.
  "ent-coupon-retrying": entity("ent-coupon-retrying", "coupon", {
    entityName: "Retrying voucher entity",
    campaignName: "Retrying voucher campaign",
    mapperErrors: [
      { id: "me-retry", status: "RETRYING", message: S.mapperRetryText, errorCode: "PROMOTION_FAILED", attempts: 2, createdAt: new Date("2026-09-03T00:00:00Z") },
    ],
  }),
  "ent-performance": entity("ent-performance", "performance"),
  "ent-conversion": entity("ent-conversion", "conversion"),
  "ent-payment": entity("ent-payment", "payment"),
};

/**
 * Evaluates the subset of a Prisma `where` that buildWhere produces (AND / OR / NOT, relation
 * `some` / `none` / `every`, and equals / contains / startsWith / in with insensitive mode), so
 * the real search predicate decides which rows — and which total — come back.
 */
const OPERATORS = new Set(["equals", "contains", "startsWith", "endsWith", "in", "not", "mode", "gte", "lte", "gt", "lt"]);
function matchValue(value, cond) {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) return value === cond;
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
  const ts = (x) => (x instanceof Date ? x.getTime() : typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x) ? Date.parse(x) : x);
  if ("gte" in cond && !(ts(value) >= ts(cond.gte))) return false;
  if ("lte" in cond && !(ts(value) <= ts(cond.lte))) return false;
  if ("gt" in cond && !(ts(value) > ts(cond.gt))) return false;
  if ("lt" in cond && !(ts(value) < ts(cond.lt))) return false;
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

const dbCalls = [];
const fakeDb = {
  entity: {
    findMany: async (args) => {
      dbCalls.push({ op: "entity.findMany", where: args?.where });
      const all = Object.values(ENTITIES).filter((e) => matchWhere(e, args?.where));
      const skip = args?.skip ?? 0;
      return args?.take != null ? all.slice(skip, skip + args.take) : all.slice(skip);
    },
    count: async (args) => Object.values(ENTITIES).filter((e) => matchWhere(e, args?.where)).length,
    findUnique: async ({ where }) => ENTITIES[where.id] ?? null,
    // Evaluates `where` and groups for real, so the summary's counts reflect the fixture.
    groupBy: async ({ by, where }) => {
      dbCalls.push({ op: "entity.groupBy", where });
      const groups = new Map();
      for (const e of Object.values(ENTITIES).filter((row) => matchWhere(row, where))) {
        const key = JSON.stringify(by.map((k) => e[k]));
        const g = groups.get(key) ?? Object.fromEntries([...by.map((k) => [k, e[k]]), ["_count", 0]]);
        g._count += 1;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
  },
  mapperError: {
    // Counts the fixture entities' mapper errors, honouring the `entity` relation filter.
    count: async ({ where } = {}) => {
      const { entity: entityWhere, ...rest } = where || {};
      const rows = Object.values(ENTITIES).filter((e) => !entityWhere || matchWhere(e, entityWhere));
      return rows.reduce((n, e) => n + (e.mapperErrors || []).filter((m) => matchWhere(m, rest)).length, 0);
    },
  },
  // Hidden-type sentinels: staged objects the summary must never count, not even to drop later.
  get supplierCampaign() {
    throw new Error("summary must not touch prisma.supplierCampaign");
  },
  get campaignSource() {
    throw new Error("summary must not touch prisma.campaignSource");
  },
};

// Route the controller's module-level service through the fake DB, keeping the real methods (and
// the real module-level list cache).
const realService = new ImportedRecordsService({ prisma: fakeDb, promotionJob: {}, normalization: {} });
const proto = ImportedRecordsService.prototype;
const original = { list: proto.list, getById: proto.getById, summary: proto.summary };
proto.list = function list(filters) {
  return original.list.call(realService, filters);
};
proto.getById = function getById(id) {
  return original.getById.call(realService, id);
};
proto.summary = function summary(filters) {
  return original.summary.call(realService, filters);
};

function fakeAuthenticate(req, res, next) {
  const role = req.headers["x-test-role"];
  if (role) {
    req.user = { id: `user-${role}`, role, isActive: true };
    req.permissions = getPermissionsForRole(role);
  }
  next();
}

let server;
let base;
before(async () => {
  const router = express.Router();
  const gate = [fakeAuthenticate, requirePermission(PERMISSIONS.CAMPAIGNS_READ)];
  // Same order and guards as src/routes/index.js.
  router.get("/ops/imported-records", ...gate, controller.listImportedRecordsHandler);
  router.get("/ops/imported-records/summary", ...gate, controller.importedRecordsSummaryHandler);
  router.get("/ops/imported-records/facets", ...gate, controller.importedRecordsFacetsHandler);
  router.get("/ops/imported-records/columns", ...gate, controller.importedRecordsColumnsHandler);
  router.get("/ops/imported-records/:id", ...gate, controller.getImportedRecordHandler);
  const app = express();
  app.use("/api", router);
  app.use((err, req, res, _next) => res.status(err.statusCode || 500).json({ ok: false, message: err.message }));
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  Object.assign(proto, original);
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, role) {
  const res = await fetch(`${base}${path}`, { headers: role ? { "x-test-role": role } : {} });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text, cacheControl: res.headers.get("cache-control") };
}

function assertNoLeak(text, label) {
  for (const s of TEXT_SENTINELS) assert.ok(!text.includes(s), `${label}: ${s} leaked`);
  for (const m of MONEY_SENTINELS) assert.ok(!text.includes(m), `${label}: money ${m} leaked`);
  assert.ok(!/[a-z][a-z0-9+.-]*:\/\//i.test(text), `${label}: a URL survived`);
  assert.ok(!/(^|["/])r\/[^/"\s]+\/[^/"\s]+/.test(text), `${label}: a /r/ redirect path survived`);
  for (const key of ["sourceFields", "sourceData", "supplierTrackingLink", "networkTrackingLink", "mboTrackingLink", "couponLink", "rawPayloadId", "networkClickId", "mboClickId", "subId1", "networkOrderId", "networkConversionId", "commission", "grossCommission", "grossOrderValue", "commissions", "openMapperErrorId", "mapperError", "tracking", "commercial", "normalized", "detected", "brandLogoLink", "brandWebsiteLink"]) {
    assert.ok(!text.includes(`"${key}":`), `${label}: key ${key} present`);
  }
}

describe("imported-records: fixtures really carry the sentinels (control)", () => {
  it("the unprojected service output contains raw fields, URLs and money", async () => {
    const raw = await original.list.call(realService, { recordType: "campaign", page: 1, pageSize: 25, __control: 1 });
    const text = JSON.stringify(raw);
    assert.ok(text.includes(S.srcField) && text.includes("track.sentinel.example") && text.includes(S.rawPayloadId));
    const detail = JSON.stringify(await original.getById.call(realService, "ent-campaign"));
    assert.ok(detail.includes(S.mapperText) && detail.includes("sourceData") && detail.includes("track.sentinel.example"));
  });
});

describe("imported-records: record type is required and authorized per type", () => {
  it("1. no type → 400, service never queried", async () => {
    const before = dbCalls.length;
    const r = await call("/ops/imported-records", "ADMIN");
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, message: "Query parameter 'recordType' is required." });
    assert.equal(dbCalls.length, before);
  });

  it("2. unknown type → 400", async () => {
    for (const t of ["product", "link", "offer", "constructor", "__proto__", "campaign,payment"]) {
      const r = await call(`/ops/imported-records?recordType=${encodeURIComponent(t)}`, "ADMIN");
      assert.equal(r.status, 400, t);
    }
  });

  it("3. campaign with campaigns:read → 200, one campaign row", async () => {
    const r = await call("/ops/imported-records?recordType=campaign", "TECH");
    assert.equal(r.status, 200);
    assert.equal(r.body.data.length, 1);
    assert.equal(r.body.data[0].entityType, "campaign");
    assert.equal(r.body.data[0].id, "ent-campaign");
  });

  it("4. coupon without coupons:read (TECH) → 403", async () => {
    const r = await call("/ops/imported-records?recordType=coupon", "TECH");
    assert.equal(r.status, 403);
  });

  it("5. coupon with coupons:read (SUPPORT) → 200, coupon rows only", async () => {
    const r = await call("/ops/imported-records?type=coupon", "SUPPORT");
    assert.equal(r.status, 200);
    assert.ok(r.body.data.length >= 1);
    assert.ok(r.body.data.every((row) => row.entityType === "coupon"));
  });

  it("6/7/8. commission_rule and commission_group need commission:read", async () => {
    for (const t of ["commission_rule", "commission_group"]) {
      assert.equal((await call(`/ops/imported-records?recordType=${t}`, "ANALYST")).status, 403, t);
      assert.equal((await call(`/ops/imported-records?recordType=${t}`, "SUPPORT")).status, 403, t);
      const ok = await call(`/ops/imported-records?recordType=${t}`, "OPERATIONS");
      assert.equal(ok.status, 200, t);
      assert.ok(ok.body.data.every((row) => row.entityType === t));
    }
  });

  it("9. performance / conversion / payment are not served, even to ADMIN", async () => {
    for (const t of ["performance", "conversion", "payment", "order", "click", "payment_invoice"]) {
      for (const alias of ["recordType", "record_type", "type", "entityType"]) {
        const r = await call(`/ops/imported-records?${alias}=${t}`, "ADMIN");
        assert.equal(r.status, 400, `${alias}=${t}`);
      }
    }
  });

  it("10. CLIENT cannot retrieve staged records (route gate), with or without type", async () => {
    for (const path of ["/ops/imported-records", "/ops/imported-records?recordType=campaign", "/ops/imported-records/ent-campaign", "/ops/imported-records/summary?recordType=campaign", "/ops/imported-records/columns?recordType=campaign"]) {
      const r = await call(path, "CLIENT");
      assert.equal(r.status, 403, path);
      assertNoLeak(r.text, path);
    }
  });

  it("unauthenticated → 401", async () => {
    assert.equal((await call("/ops/imported-records?recordType=campaign")).status, 401);
  });

  it("the type is authorized on the same alias the query uses (no alias split)", async () => {
    // readFilters precedence: recordType > record_type > type > entityType
    const r = await call("/ops/imported-records?recordType=campaign&type=payment", "TECH");
    assert.equal(r.status, 200);
    assert.ok(r.body.data.every((row) => row.entityType === "campaign"));
    const denied = await call("/ops/imported-records?recordType=coupon&type=campaign", "TECH");
    assert.equal(denied.status, 403);
  });
});

describe("imported-records: list response boundary", () => {
  it("no sentinel, URL, raw key or money survives in any list response — ADMIN included", async () => {
    for (const [role, t] of [
      ["ADMIN", "campaign"],
      ["ADMIN", "coupon"],
      ["ADMIN", "commission_rule"],
      ["ADMIN", "commission_group"],
      ["OPERATIONS", "campaign"],
      ["SUPPORT", "coupon"],
      ["TECH", "campaign"],
    ]) {
      const r = await call(`/ops/imported-records?recordType=${t}`, role);
      assert.equal(r.status, 200, `${role} ${t}`);
      assertNoLeak(r.text, `${role} list ${t}`);
    }
  });

  it("safe fields remain, with a boolean mapper-error flag only", async () => {
    const r = await call("/ops/imported-records?recordType=campaign", "ADMIN");
    const row = r.body.data[0];
    assert.equal(row.network, "Optimise");
    assert.equal(row.recordType != null, true);
    assert.equal(row.sourceRecordId, "default:ent-campaign");
    assert.equal(row.supplierCampaignId, "sc-1");
    assert.equal(row.campaignSourceId, "cs-1");
    assert.equal(row.canonicalCampaignId, "cc-1");
    assert.equal(row.merchantId, "merchant-1");
    assert.equal(row.campaign, "Campaign 1");
    assert.equal(row.hasMapperError, true);
    assert.equal(row.sourceAdvertiserName, null, "URL-shaped advertiser name must be dropped");
    assert.ok(Object.keys(row).every((k) => controller.IMPORTED_RECORD_ROW_FIELDS.includes(k) || k === "hasMapperError"));
  });

  it("coupon rows carry the code only; a URL stored as the code is dropped", async () => {
    const r = await call("/ops/imported-records?recordType=coupon", "SUPPORT");
    const byId = Object.fromEntries(r.body.data.map((row) => [row.id, row]));
    assert.equal(byId["ent-coupon"].couponCode, "SAVE10");
    assert.equal(byId["ent-coupon"].couponStatus, "ACTIVE");
    assert.equal(byId["ent-coupon-url"].couponCode, null);
    assert.ok(!("couponLink" in byId["ent-coupon"]));
  });

  it("URL-shaped and /r/ values in otherwise safe fields do not survive", async () => {
    const r = await call("/ops/imported-records?recordType=commission_rule", "ADMIN");
    assert.equal(r.body.data[0].campaign, null);
    const c = await call("/ops/imported-records?recordType=campaign", "ADMIN");
    assert.ok(!c.text.includes("files.sentinel.example"));
  });

  it("Cache-Control: no-store on list", async () => {
    assert.equal((await call("/ops/imported-records?recordType=campaign", "ADMIN")).cacheControl, "no-store");
  });
});

describe("imported-records: detail response boundary", () => {
  it("detail uses the same boundary: no raw payload, mapper text, URLs, ids or money", async () => {
    for (const [role, id] of [
      ["ADMIN", "ent-campaign"],
      ["ADMIN", "ent-coupon"],
      ["OPERATIONS", "ent-rule"],
      ["TECH", "ent-campaign"],
    ]) {
      const r = await call(`/ops/imported-records/${id}`, role);
      assert.equal(r.status, 200, `${role} ${id}`);
      assertNoLeak(r.text, `${role} detail ${id}`);
      assert.equal(r.cacheControl, "no-store");
      assert.equal(r.body.data.hasMapperError, true);
    }
  });

  it("detail keeps safe relationship / pipeline metadata only", async () => {
    const r = await call("/ops/imported-records/ent-campaign", "ADMIN");
    const d = r.body.data;
    assert.ok(Array.isArray(d.pipeline) && d.pipeline.length > 0);
    for (const stage of d.pipeline) assert.deepEqual(Object.keys(stage).sort(), ["detail", "key", "label", "state"]);
    if (d.linkedRecords) {
      assert.ok(!("sourceData" in d.linkedRecords));
      for (const v of Object.values(d.linkedRecords)) assert.deepEqual(Object.keys(v).sort(), ["state", "syncedCount", "type"]);
    }
  });

  it("detail enforces the type permission and hides unsupported types", async () => {
    assert.equal((await call("/ops/imported-records/ent-coupon", "TECH")).status, 403);
    assert.equal((await call("/ops/imported-records/ent-rule", "ANALYST")).status, 403);
    for (const id of ["ent-performance", "ent-conversion", "ent-payment"]) {
      const r = await call(`/ops/imported-records/${id}`, "ADMIN");
      assert.equal(r.status, 404, id);
      assertNoLeak(r.text, id);
    }
    assert.equal((await call("/ops/imported-records/missing", "ADMIN")).status, 404);
  });
});

describe("imported-records: shared cache", () => {
  it("a privileged caller first, a restricted caller second: same cached rows, nothing extra leaks", async () => {
    const path = "/ops/imported-records?recordType=campaign&q=EXT-1";
    const callsBefore = dbCalls.length;
    const admin = await call(path, "ADMIN");
    const afterFirst = dbCalls.length;
    const tech = await call(path, "TECH");
    assert.equal(dbCalls.length, afterFirst, "second call is served from the shared cache");
    assert.ok(afterFirst > callsBefore);
    assert.equal(admin.text, tech.text, "identical projected output for both callers");
    assertNoLeak(tech.text, "cached");
    // And the cached object itself was not mutated by projection.
    const rawAgain = JSON.stringify(await original.list.call(realService, { ...controllerFilters(path), recordType: "campaign" }));
    assert.ok(rawAgain.includes("track.sentinel.example"), "cache still holds the unprojected service rows");
  });
});

describe("imported-records: search matches safe fields only (no existence oracle)", () => {
  async function search(q, recordType = "campaign", role = "ADMIN") {
    const r = await call(`/ops/imported-records?recordType=${recordType}&q=${encodeURIComponent(q)}`, role);
    assert.equal(r.status, 200, `${recordType} q=${q}`);
    return r;
  }
  function assertEmpty(r, label) {
    assert.equal(r.body.data.length, 0, `${label}: rows`);
    assert.equal(r.body.pagination.total, 0, `${label}: total`);
    assert.equal(r.body.pagination.totalPages, 1, `${label}: totalPages`);
    assert.equal(r.body.pagination.hasMore, false, `${label}: hasMore`);
  }
  const ids = (r) => r.body.data.map((row) => row.id);

  it("1-5. safe brand, campaign, source record id, supplier campaign id and campaign source id match", async () => {
    for (const q of ["Brand One", "Campaign 1", "default:ent-campaign", "EXT-1", "sc-1", "cs-1"]) {
      const r = await search(q);
      assert.deepEqual(ids(r), ["ent-campaign"], q);
      assert.equal(r.body.pagination.total, 1, q);
    }
  });

  it("6/7. a coupon code matches the coupon row, never the campaign that has that coupon", async () => {
    const coupon = await search("SAVE10", "coupon", "SUPPORT");
    assert.ok(ids(coupon).includes("ent-coupon"));
    assertEmpty(await search("SAVE10", "campaign"), "campaign by related coupon code");
  });

  it("8. supplier tracking URL sentinel: 0 rows, total 0", async () => {
    assertEmpty(await search("track.sentinel.example"), "tracking url host");
    assertEmpty(await search(S.trackingUrl), "tracking url");
    assertEmpty(await search("TOK_SENTINEL"), "tracking url token");
    assertEmpty(await search("TOK_SENTINEL", "coupon"), "tracking url token (coupon)");
  });

  it("9. raw payload id sentinel: 0 rows, total 0", async () => {
    for (const t of ["campaign", "coupon", "commission_rule", "commission_group"]) {
      assertEmpty(await search(S.rawPayloadId, t), `rawPayloadId ${t}`);
    }
  });

  it("10-15. click / sub / order / conversion ids, mapper text and money strings: 0 rows", async () => {
    for (const q of [S.networkClickId, S.mboClickId, S.subId, S.orderId, S.conversionId, S.mapperText, "987654.321", "876543.21", "765432.1", "654321.09", "543210.98"]) {
      for (const t of ["campaign", "coupon", "commission_rule", "commission_group"]) {
        assertEmpty(await search(q, t), `${q} ${t}`);
      }
    }
  });

  it("other hidden URLs (landing, deeplink, MBO redirect) are not searchable", async () => {
    for (const q of ["landing.sentinel.example", "deeplink.sentinel.example", "go.sentinel.example", "TOK_REDIRECT_SENTINEL"]) {
      assertEmpty(await search(q), `${q} campaign`);
      assertEmpty(await search(q, "coupon"), `${q} coupon`);
    }
  });

  it("URL-shaped search terms match nothing, even where a searchable column holds that value", async () => {
    // 1. a coupon whose couponCode is an https URL
    const coupon = await search(S.couponLink, "coupon", "SUPPORT");
    assertEmpty(coupon, "https URL stored as coupon code");
    // 2. URL-shaped advertiser name (every fixture entity carries one)
    for (const t of ["campaign", "coupon", "commission_rule"]) assertEmpty(await search(S.advertiserUrl, t), `advertiser url ${t}`);
    // 3. URL-shaped campaign name (commission_rule fixture holds a /r/ path as its campaign name)
    assertEmpty(await search(S.redirectPath, "commission_rule"), "redirect-path campaign name");
    // 4-7. www., custom scheme, protocol-relative and /r/ values held by the commission_group fixture
    for (const q of ["www.example.com", "customscheme://secret", "//example.com/path", "/r/test/token123"]) {
      assertEmpty(await search(q, "commission_group"), q);
    }
  });

  it("stored URL values are not matchable by a non-URL substring (hostname, path or token)", async () => {
    // 1/2. couponCode holding an https URL: hostname and path substrings
    for (const q of ["coupon.sentinel.example", "coupon.sentinel", "deal"]) assertEmpty(await search(q, "coupon", "SUPPORT"), `couponCode ${q}`);
    // 3. advertiserName URL (on every fixture entity): hostname substring
    for (const t of ["campaign", "coupon", "commission_rule", "commission_group"]) assertEmpty(await search("advertiser.sentinel", t), `advertiserName ${t}`);
    // 4. supplier campaignName URL: hostname, path and token substrings
    for (const q of ["campaignurl.sentinel", "path/CAMPTOKEN", "CAMPTOKEN_SENTINEL"]) assertEmpty(await search(q, "commission_rule"), `campaignName ${q}`);
    // 5. merchantNameRaw URL: hostname substring
    assertEmpty(await search("merchant.sentinel", "commission_rule"), "merchantNameRaw");
    // 6. sourceAccountLabel URL: hostname substring
    assertEmpty(await search("account.sentinel", "commission_rule"), "sourceAccountLabel");
    // 7. customscheme:// value searched by an inner substring
    for (const q of ["secret", "customscheme"]) assertEmpty(await search(q, "commission_group"), `customscheme ${q}`);
    // 8. /r/<slug>/<token> searched by the token only (entity campaignName on commission_rule,
    //    advertiserName on commission_group)
    assertEmpty(await search("TOKEN_PATH_SENTINEL", "commission_rule"), "/r/ token (campaignName)");
    assertEmpty(await search("token123", "commission_group"), "/r/ token (advertiserName)");
    // www. and // values by inner substring
    assertEmpty(await search("example.com", "commission_group"), "www. / // values by host");
  });

  it("8. safe values, including punctuated ids, still search normally", async () => {
    assert.deepEqual(ids(await search("SAVE20", "coupon", "SUPPORT")), ["ent-coupon-20"]);
    // The commission_rule row is still found by its safe values despite its URL-shaped columns.
    assert.deepEqual(ids(await search("EXT-9", "commission_rule")), ["ent-rule"]);
    assert.deepEqual(ids(await search("Fashion", "commission_rule")), ["ent-rule"]);
    for (const q of ["EXT-1", "Brand One", "Campaign 1", "campaign_001", "abc:def", "default:ent-campaign"]) {
      assert.deepEqual(ids(await search(q)), ["ent-campaign"], q);
    }
    assert.ok(ids(await search("SAVE10", "coupon", "SUPPORT")).includes("ent-coupon"));
    // The commission_group fixture is still found by a safe value.
    assert.deepEqual(ids(await search("ent-group", "commission_group")), ["ent-group"]);
  });

  it("the coupon link column is not searched", async () => {
    // ent-coupon holds the URL only in couponLink: it must not match. (ent-coupon-url stores the
    // same URL in its couponCode column — see the known residual in the task report.)
    assertEmpty(await search("coupon.sentinel.example"), "coupon link, campaign rows");
    const r = await search("coupon.sentinel.example", "coupon", "SUPPORT");
    assert.ok(!ids(r).includes("ent-coupon"), "matched through couponLink");
  });
});

function controllerFilters(path) {
  const q = new URL(`http://x${path}`).searchParams;
  return { recordType: q.get("recordType"), search: q.get("q") };
}

describe("imported-records: summary / columns / facets", () => {
  it("summary requires a permitted type and only counts permitted, supported types", async () => {
    assert.equal((await call("/ops/imported-records/summary", "ADMIN")).status, 400);
    assert.equal((await call("/ops/imported-records/summary?recordType=payment", "ADMIN")).status, 400);
    assert.equal((await call("/ops/imported-records/summary?recordType=coupon", "TECH")).status, 403);
    const admin = await call("/ops/imported-records/summary?recordType=campaign", "ADMIN");
    assert.equal(admin.status, 200);
    assert.equal(admin.cacheControl, "no-store");
    // Cross-type first-release inventory (real fixture counts); performance / conversion / payment
    // rows exist in the fixture but are never counted.
    assert.deepEqual(admin.body.data.recordTypeCounts, { campaign: 1, coupon: 4, commission_rule: 1, commission_group: 1 });
    assert.ok(!("performance" in admin.body.data.recordTypeCounts) && !("payment" in admin.body.data.recordTypeCounts));
    // Selected-type aggregates: only the campaign's own open mapper error, only campaign rows per network.
    assert.equal(admin.body.data.importedRecords, 1);
    assert.equal(admin.body.data.mappingErrors, 1);
    assert.equal(admin.body.data.importedCampaigns, 1);
    assert.deepEqual(admin.body.data.byNetwork, [{ network: "Optimise", networkSource: "optimise", importedRecords: 1 }]);
    for (const k of ["normalizedCampaigns", "promotedSupplierCampaigns", "linkedCampaigns", "unlinkedCampaigns"]) assert.equal(admin.body.data[k], null, k);
    const coupon = await call("/ops/imported-records/summary?recordType=coupon", "ADMIN");
    assert.equal(coupon.body.data.importedRecords, 4);
    assert.equal(coupon.body.data.mappingErrors, 4); // three OPEN + one RETRYING: both are active
    assert.equal(coupon.body.data.importedCampaigns, null);
    const tech = await call("/ops/imported-records/summary?recordType=campaign", "TECH");
    assert.deepEqual(Object.keys(tech.body.data.recordTypeCounts), ["campaign"]);
    assert.deepEqual(tech.body.data.supportedRecordTypes, ["campaign"]);
    // A campaigns-only caller never receives the coupon rows' mapper errors in the count.
    assert.equal(tech.body.data.mappingErrors, 1);
  });

  it("columns only advertise fields the endpoint can return", async () => {
    const r = await call("/ops/imported-records/columns?recordType=campaign", "ADMIN");
    assert.equal(r.status, 200);
    assert.equal(r.cacheControl, "no-store");
    const keys = r.body.data.columns.map((c) => c.key);
    assert.ok(keys.length > 0);
    for (const k of keys) {
      assert.ok(controller.IMPORTED_RECORD_ROW_FIELDS.includes(k) || k === "hasMapperError", k);
    }
    for (const k of ["supplierTrackingLink", "mboTrackingLink", "rawPayloadId", "commission", "networkClickId", "grossCommission"]) {
      assert.ok(!keys.includes(k), k);
    }
    assert.ok(r.body.data.defaultKeys.every((k) => keys.includes(k)));
    assert.equal((await call("/ops/imported-records/columns", "ADMIN")).status, 400);
    assert.equal((await call("/ops/imported-records/columns?recordType=commission_rule", "ANALYST")).status, 403);
  });

  it("route wiring unchanged", () => {
    const routes = fs.readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
    for (const [path, handler] of [
      ["/ops/imported-records", "listImportedRecordsHandler"],
      ["/ops/imported-records/summary", "importedRecordsSummaryHandler"],
      ["/ops/imported-records/facets", "importedRecordsFacetsHandler"],
      ["/ops/imported-records/columns", "importedRecordsColumnsHandler"],
      ["/ops/imported-records/:id", "getImportedRecordHandler"],
    ]) {
      const block = routes.slice(routes.indexOf(`"${path}",`), routes.indexOf(`"${path}",`) + 260);
      assert.ok(block.includes("requirePermission(PERMISSIONS.CAMPAIGNS_READ)"), path);
      assert.ok(block.includes(handler), path);
    }
  });
});

describe("imported-records: date filter validation (400 before Prisma, after auth)", () => {
  const PRISMA_TEXT = ["prisma", "Prisma", "invocation", "Invalid Date", "createdAt", "where:"];
  const assertDateRejection = (r, message, label) => {
    assert.equal(r.status, 400, label);
    assert.deepEqual(r.body, { ok: false, message }, label);
    assert.equal(r.cacheControl, "no-store", label);
    for (const s of PRISMA_TEXT) assert.ok(!r.text.includes(s), `${label}: '${s}' in response`);
  };

  it("1-2 list: bad fromDate / bad toDate → 400 with the field-specific message", async () => {
    assertDateRejection(await call("/ops/imported-records?recordType=campaign&fromDate=bad", "ADMIN"), "Invalid fromDate.", "list fromDate");
    assertDateRejection(await call("/ops/imported-records?recordType=campaign&toDate=bad", "ADMIN"), "Invalid toDate.", "list toDate");
    assertDateRejection(await call("/ops/imported-records?recordType=coupon&fromDate=2026-99-99", "ADMIN"), "Invalid fromDate.", "list impossible date");
  });

  it("3-4 summary: bad fromDate / bad toDate → 400 with the field-specific message", async () => {
    assertDateRejection(await call("/ops/imported-records/summary?recordType=campaign&fromDate=bad", "ADMIN"), "Invalid fromDate.", "summary fromDate");
    assertDateRejection(await call("/ops/imported-records/summary?recordType=campaign&toDate=bad", "ADMIN"), "Invalid toDate.", "summary toDate");
    assertDateRejection(await call("/ops/imported-records/summary?recordType=commission_rule&toDate=2026-09-25%2B05:30", "ADMIN"), "Invalid toDate.", "summary offset-only");
  });

  it("5 a repeated date parameter (array) is rejected the same way", async () => {
    assertDateRejection(await call("/ops/imported-records?recordType=campaign&fromDate=2026-09-01&fromDate=2026-09-02", "ADMIN"), "Invalid fromDate.", "list array");
  });

  it("6 authorization order: an unpermitted type keeps its 403 even with a bad date; a permitted type then gets the date 400", async () => {
    assert.equal((await call("/ops/imported-records?recordType=coupon&fromDate=bad", "TECH")).status, 403);
    assert.equal((await call("/ops/imported-records/summary?recordType=coupon&fromDate=bad", "TECH")).status, 403);
    assert.equal((await call("/ops/imported-records?recordType=commission_rule&toDate=bad", "ANALYST")).status, 403);
    assertDateRejection(await call("/ops/imported-records?recordType=campaign&fromDate=bad", "TECH"), "Invalid fromDate.", "TECH campaign");
  });

  it("7 missing recordType + bad date → the existing recordType 400", async () => {
    for (const path of ["/ops/imported-records?fromDate=bad", "/ops/imported-records/summary?toDate=bad"]) {
      const r = await call(path, "ADMIN");
      assert.equal(r.status, 400, path);
      assert.equal(r.body.message, "Query parameter 'recordType' is required.", path);
    }
  });

  it("8 unauthenticated + bad date → 401 (route gate runs first)", async () => {
    assert.equal((await call("/ops/imported-records?recordType=campaign&fromDate=bad")).status, 401);
    assert.equal((await call("/ops/imported-records/summary?recordType=campaign&fromDate=bad")).status, 401);
  });

  it("9 valid dates still succeed with no-store, and a valid request after a rejected one is unaffected", async () => {
    await call("/ops/imported-records?recordType=campaign&fromDate=bad", "ADMIN");
    const list = await call("/ops/imported-records?recordType=campaign&fromDate=2026-08-01&toDate=2026-09-30T23:59:59.999Z", "ADMIN");
    assert.equal(list.status, 200);
    assert.equal(list.cacheControl, "no-store");
    assert.equal(list.body.pagination.total, 1);
    assertNoLeak(list.text, "dated list");
    const summary = await call("/ops/imported-records/summary?recordType=campaign&fromDate=%202026-08-01%20&toDate=2026-09-30T23:59:59.999Z", "ADMIN");
    assert.equal(summary.status, 200);
    assert.equal(summary.cacheControl, "no-store");
    assert.equal(summary.body.data.importedRecords, 1);
    const blank = await call("/ops/imported-records/summary?recordType=campaign&fromDate=%20%20", "ADMIN");
    assert.equal(blank.status, 200);
    assert.equal(blank.body.data.importedRecords, 1);
  });
});

describe("imported-records: RETRYING mapper error is active through the public boundary", () => {
  const ID = "ent-coupon-retrying";
  const rowOf = (r) => r.body.data.find((row) => row.id === ID);

  it("1 unfiltered coupon list: hasMapperError true, ERROR / FAILED, and the RETRYING text never leaks", async () => {
    const r = await call("/ops/imported-records?recordType=coupon", "ADMIN");
    assert.equal(r.status, 200);
    const row = rowOf(r);
    assert.ok(row, "retrying row present");
    assert.equal(row.hasMapperError, true);
    assert.equal(row.mappingStatus, "ERROR");
    assert.equal(row.sourceStatus, "FAILED");
    assert.ok(!r.text.includes("RETRYING"), "raw mapper status must not appear in the list");
    assertNoLeak(r.text, "retrying list");
  });

  it("2-4 mappingStatus=ERROR and sourceStatus=FAILED return it; NEEDS_REVIEW and IMPORTED do not", async () => {
    for (const q of ["mappingStatus=ERROR", "preset=mapping_errors", "sourceStatus=FAILED"]) {
      const r = await call(`/ops/imported-records?recordType=coupon&${q}`, "ADMIN");
      assert.ok(rowOf(r), q);
      assertNoLeak(r.text, q);
    }
    for (const q of ["mappingStatus=NEEDS_REVIEW", "preset=needs_review", "sourceStatus=IMPORTED", "sourceStatus=PROCESSED"]) {
      const r = await call(`/ops/imported-records?recordType=coupon&${q}`, "ADMIN");
      assert.equal(rowOf(r), undefined, q);
    }
  });

  it("5 summary counts it and agrees with the list under the ERROR filter; a campaigns-only caller still never sees coupon errors", async () => {
    const s = await call("/ops/imported-records/summary?recordType=coupon&mappingStatus=ERROR", "ADMIN");
    const l = await call("/ops/imported-records?recordType=coupon&mappingStatus=ERROR", "ADMIN");
    assert.equal(s.status, 200);
    assert.equal(s.body.data.importedRecords, l.body.pagination.total);
    assert.equal(s.body.data.mappingErrors, 4);
    assertNoLeak(s.text, "retrying summary");
    assert.ok(!s.text.includes("RETRYING"));
    const tech = await call("/ops/imported-records/summary?recordType=campaign", "TECH");
    assert.equal(tech.body.data.mappingErrors, 1);
    assert.equal((await call(`/ops/imported-records/${ID}`, "TECH")).status, 403);
  });

  it("6 detail through the public projection: hasMapperError true, no mapper-error text, status or detail object (existing boundary contract)", async () => {
    const r = await call(`/ops/imported-records/${ID}`, "ADMIN");
    assert.equal(r.status, 200);
    assert.equal(r.body.data.hasMapperError, true);
    assert.equal(r.body.data.mappingStatus, "ERROR");
    assert.equal(r.body.data.sourceStatus, "FAILED");
    assert.ok(!r.text.includes("RETRYING"), "raw status is a service-level detail; the public detail does not expose it");
    assert.ok(!("mapping" in r.body.data));
    assertNoLeak(r.text, "retrying detail");
  });
});
