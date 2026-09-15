/**
 * Boostiny commission canary — one account, one supplier campaign, dry run by default.
 * Fixtures are synthetic; no live values.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-value-only";
process.env.OAUTH_TOKEN_ENCRYPTION_KEY =
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef";
process.env.LOG_LEVEL = "silent";

const { CANARY_NETWORK, normalizeBoostinyCanaryOptions, resolveBoostinyCanary, selectCanaryCampaigns } = await import(
  "../src/modules/commercial/boostinyCommissionCanary.js"
);
const { BoostinyCommissionPersistenceService } = await import("../src/modules/commercial/boostinyCommissionPersistence.service.js");
const { SupplierCommissionRuleService } = await import("../src/modules/commercial/services/supplierCommissionRule.service.js");

const SYNC_SRC = readFileSync("src/jobs/sync.job.js", "utf8");
const CONTROLLER_SRC = readFileSync("src/controllers/sync.controller.js", "utf8");
const ROUTES_SRC = readFileSync("src/routes/index.js", "utf8");
const SCHEDULER_SRC = readFileSync("src/jobs/syncScheduler.js", "utf8");
const PERSIST_SRC = readFileSync("src/modules/commercial/boostinyCommissionPersistence.service.js", "utf8");
const CANARY_SRC = readFileSync("src/modules/commercial/boostinyCommissionCanary.js", "utf8");

/** Comments are prose; an assertion that matches one proves nothing about behaviour. */
function codeOf(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (char === "/" && next === "/") {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    out += char;
    i += 1;
  }
  return out;
}

function group(overrides = {}) {
  return { id: 9101, priority: 1, type: "sale-share", value: 4, conditions: [], capping: null, product_categories: [], coupons: [], ...overrides };
}
function payout(overrides = {}) {
  return { model: "cps", level: "campaign", is_global: true, start_date: "2026-01-01", end_date: null, groups: [group()], ...overrides };
}
function campaign(payouts, id = 7001) {
  return { id, name: "zzsyntheticcampaignzz", payouts };
}
const FETCHED = [campaign([payout({ groups: [group({ id: 1, value: 4 }), group({ id: 2, value: 2 })] })], 7001), campaign([payout({ groups: [group({ id: 1, value: 9 })] })], 7002), { id: 7003, name: "zzflatzz", payouts: [{ model: "cps", value: "8.5", currency: "USD" }] }];

/** Fake canonical store. `readOnly` makes every write throw, which is how a dry run is proven. */
function createRuleDb({ readOnly = false, supplierCampaign = { id: "sc-1", campaignName: "zzcampaignzz" } } = {}) {
  const rows = [];
  let sequence = 0;
  const writes = [];
  const refuse = (op) => {
    writes.push(op);
    if (readOnly) throw new Error(`write refused in dry run: ${op}`);
  };
  const materialize = (nested) => (Array.isArray(nested?.create) ? nested.create.map((row, i) => ({ id: `cond-${i + 1}`, ...row })) : []);
  const matchString = (actual, filter) => {
    if (filter == null) return true;
    if (typeof filter === "string") return actual === filter;
    if (filter.startsWith != null && !String(actual ?? "").startsWith(filter.startsWith)) return false;
    return true;
  };
  const model = {
    async findMany({ where }) {
      return rows
        .filter(
          (row) =>
            (where.supplier == null || row.supplier === where.supplier) &&
            (where.sourceAccountLabel == null || row.sourceAccountLabel === where.sourceAccountLabel) &&
            (where.sourceObject == null || row.sourceObject === where.sourceObject) &&
            matchString(row.sourcePath, where.sourcePath) &&
            matchString(row.outcomeKey, where.outcomeKey) &&
            (!("effectiveUntil" in where) || row.effectiveUntil == where.effectiveUntil) &&
            (where.effectiveFrom?.lt == null || new Date(row.effectiveFrom) < where.effectiveFrom.lt),
        )
        .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))
        .map((row) => ({ ...row, conditions: [...(row.conditions || [])] }));
    },
    async create({ data }) {
      refuse("create");
      sequence += 1;
      const row = { id: `rule-${sequence}`, createdAt: new Date(), ...data, conditions: materialize(data.conditions) };
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }) {
      refuse("update");
      const index = rows.findIndex((row) => row.id === where.id);
      assert.notEqual(index, -1);
      const next = { ...rows[index], ...data };
      if (data.conditions) next.conditions = materialize(data.conditions);
      rows[index] = next;
      return { ...next };
    },
    async updateMany({ where, data }) {
      refuse("updateMany");
      let count = 0;
      for (const row of rows) {
        if (
          row.supplier === where.supplier &&
          row.sourceAccountLabel === where.sourceAccountLabel &&
          row.sourceObject === where.sourceObject &&
          row.sourcePath === where.sourcePath &&
          row.effectiveUntil == null &&
          String(row.outcomeKey).startsWith(where.outcomeKey.startsWith) &&
          new Date(row.effectiveFrom) < where.effectiveFrom.lt
        ) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
  };
  const db = {
    supplierCommissionRule: model,
    supplierCampaign: {
      async findFirst({ where }) {
        if (!supplierCampaign) return null;
        return { ...supplierCampaign, supplierCampaignId: String(where.supplierCampaignId), campaignSources: [{ id: "cs-1" }] };
      },
    },
    async $transaction(callback) {
      refuse("$transaction");
      return callback({ supplierCommissionRule: model });
    },
  };
  return { rows, db, writes };
}

function serviceFor(db, now = () => new Date("2026-09-15T12:00:00.000Z")) {
  return new BoostinyCommissionPersistenceService({ prisma: db, ruleService: new SupplierCommissionRuleService({ prisma: db }), now });
}
const openRows = (rows) => rows.filter((row) => row.effectiveUntil == null);
function seedUnrelated(rows) {
  rows.push(
    { id: "other-campaign-group", supplier: "BOOSTINY", sourceAccountLabel: "default", sourceObject: "campaigns", sourcePath: "payouts[0].groups[0]", outcomeKey: "boostiny::campaigns::7002::payout:fp:aaaaaaaaaaaaaaaa::group:1", effectiveFrom: new Date("2026-01-05"), effectiveUntil: null, conditions: [], metadata: {} },
    { id: "other-campaign-summary", supplier: "BOOSTINY", sourceAccountLabel: "default", sourceObject: "campaigns", sourcePath: "commission", outcomeKey: "7002::campaigns::commission::1::PERCENT::PERCENT_OF_SALE::::slot:1::", effectiveFrom: new Date("2026-01-05"), effectiveUntil: null, conditions: [], metadata: {} },
    { id: "selected-summary", supplier: "BOOSTINY", sourceAccountLabel: "default", sourceObject: "campaigns", sourcePath: "commission", outcomeKey: "7001::campaigns::commission::1::PERCENT::PERCENT_OF_SALE::::slot:1::", effectiveFrom: new Date("2026-01-05"), effectiveUntil: null, conditions: [], metadata: {} },
    { id: "selected-stale-group", supplier: "BOOSTINY", sourceAccountLabel: "default", sourceObject: "campaigns", sourcePath: "payouts[0].groups[5]", outcomeKey: "boostiny::campaigns::7001::payout:fp:bbbbbbbbbbbbbbbb::group:99", effectiveFrom: new Date("2026-01-05"), effectiveUntil: null, conditions: [], metadata: {} },
    { id: "other-account", supplier: "BOOSTINY", sourceAccountLabel: "second", sourceObject: "campaigns", sourcePath: "payouts[0].groups[0]", outcomeKey: "boostiny::campaigns::7001::payout:fp:cccccccccccccccc::group:1", effectiveFrom: new Date("2026-01-05"), effectiveUntil: null, conditions: [], metadata: {} },
    { id: "other-supplier", supplier: "OPTIMISE", sourceAccountLabel: "default", sourceObject: "campaigns", sourcePath: "commission", outcomeKey: "7001::campaigns::commission::x::PERCENT::PERCENT_OF_SALE::::slot:1::", effectiveFrom: new Date("2026-01-05"), effectiveUntil: null, conditions: [], metadata: {} },
  );
}
const UNRELATED_IDS = ["other-campaign-group", "other-campaign-summary", "other-account", "other-supplier"];

describe("canary options are validated, admin-supplied, and dry by default", () => {
  it("requires a plain supplier campaign id and defaults to dry run", () => {
    assert.deepEqual(normalizeBoostinyCanaryOptions({ supplierCampaignId: 7001 }), { network: "boostiny", supplierCampaignId: "7001", dryRun: true });
    assert.deepEqual(normalizeBoostinyCanaryOptions({ supplierCampaignId: " 7001 ", dryRun: "false" }), { network: "boostiny", supplierCampaignId: "7001", dryRun: false });
    assert.equal(normalizeBoostinyCanaryOptions({ supplierCampaignId: "abc-1", dryRun: "true" }).dryRun, true);
    assert.ok(Object.isFrozen(normalizeBoostinyCanaryOptions({ supplierCampaignId: "1" })));
    assert.equal(CANARY_NETWORK, "boostiny");
  });

  it("rejects missing, malformed or path-shaped ids and unparseable dryRun with 400", () => {
    for (const bad of [{}, { supplierCampaignId: "" }, { supplierCampaignId: "7001/../x" }, { supplierCampaignId: "a b" }, { supplierCampaignId: "x".repeat(65) }, { supplierCampaignId: "7001", dryRun: "maybe" }]) {
      assert.throws(() => normalizeBoostinyCanaryOptions(bad), (error) => error.status === 400, JSON.stringify(bad));
    }
  });

  it("resolves only a Boostiny canary from the run options, dry unless told otherwise", () => {
    assert.equal(resolveBoostinyCanary({}), null);
    assert.equal(resolveBoostinyCanary({ canary: { network: "optimise_sea", supplierCampaignId: "1" } }), null);
    assert.equal(resolveBoostinyCanary({ canary: { network: "boostiny" } }), null);
    assert.deepEqual(resolveBoostinyCanary({ canary: { network: "boostiny", supplierCampaignId: "7001" } }), { network: "boostiny", supplierCampaignId: "7001", dryRun: true });
    assert.equal(resolveBoostinyCanary({ canary: { network: "boostiny", supplierCampaignId: "7001", dryRun: false } }).dryRun, false);
  });

  it("selects only the exactly matching fetched campaign; an unlisted id selects nothing", () => {
    assert.deepEqual(selectCanaryCampaigns(FETCHED, "7001").map((c) => c.id), [7001]);
    assert.deepEqual(selectCanaryCampaigns(FETCHED, 7002).map((c) => c.id), [7002]);
    assert.deepEqual(selectCanaryCampaigns(FETCHED, "700"), []);
    assert.deepEqual(selectCanaryCampaigns(FETCHED, "9999"), []);
    assert.deepEqual(selectCanaryCampaigns(FETCHED, ""), []);
    assert.deepEqual(selectCanaryCampaigns(null, "7001"), []);
    assert.ok(!codeOf(CANARY_SRC).includes("rawData") && !codeOf(CANARY_SRC).includes("JSON.parse"), "no injected payload path");
  });
});

describe("dry run — a plan with zero writes", () => {
  it("performs no create, update, updateMany or transaction, and reports aggregates only", async () => {
    const { rows, db, writes } = createRuleDb({ readOnly: true });
    seedUnrelated(rows);
    const plan = await serviceFor(db).planCampaigns({ campaigns: selectCanaryCampaigns(FETCHED, "7001") });
    assert.deepEqual(writes, []);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.campaignsSeen, 1);
    assert.equal(plan.campaignsWithPayoutGroups, 1);
    assert.equal(plan.candidates, 2);
    assert.equal(plan.wouldCreate, 2);
    assert.equal(plan.wouldReuse, 0);
    assert.equal(plan.wouldVersion, 0);
    assert.equal(plan.wouldCloseStale, 1, "the selected campaign's unlisted group");
    assert.equal(plan.wouldCloseSummary, 1, "the selected campaign's summary rule");
    assert.equal(plan.financeReady, 2);
    assert.equal(plan.reviewRequired, 0);
    assert.equal(plan.campaignsUnlinked, 0);
    assert.deepEqual(plan.persistErrors, []);
    const serialised = JSON.stringify(plan);
    for (const secret of ["zzsyntheticcampaignzz", "zzcampaignzz", "sale-share", "outcomeKey", "conditions", "payout", "\"value\"", "4", "2"]) {
      assert.ok(!serialised.includes(secret) || /^\d$/.test(secret), secret);
    }
    assert.ok(!Object.hasOwn(plan, "campaigns") && !Object.hasOwn(plan, "candidatesDetail"));
    assert.equal(openRows(rows).length, 6, "every seeded row is still open");
  });

  it("classifies reuse and versioning against the current store without touching it", async () => {
    const { db } = createRuleDb();
    await serviceFor(db).persistCampaigns({ campaigns: selectCanaryCampaigns(FETCHED, "7001") });
    const readOnly = createRuleDb({ readOnly: true });
    // Same store contents, but now every write throws.
    readOnly.rows.push(...(await db.supplierCommissionRule.findMany({ where: {} })));
    const same = await serviceFor(readOnly.db).planCampaigns({ campaigns: selectCanaryCampaigns(FETCHED, "7001") });
    assert.equal(same.wouldReuse, 2);
    assert.equal(same.wouldCreate + same.wouldVersion, 0);
    assert.equal(same.wouldCloseStale, 0, "the still-listed groups are active, not stale");
    assert.equal(same.wouldCloseSummary, 0);
    // One open group the supplier no longer lists → exactly that one would close, never the active ones.
    readOnly.rows.push({ id: "stale-now", supplier: "BOOSTINY", sourceAccountLabel: "default", sourceObject: "campaigns", sourcePath: "payouts[0].groups[7]", outcomeKey: "boostiny::campaigns::7001::payout:fp:dddddddddddddddd::group:77", effectiveFrom: new Date("2026-01-05"), effectiveUntil: null, conditions: [], metadata: {} });
    const oneStale = await serviceFor(readOnly.db).planCampaigns({ campaigns: selectCanaryCampaigns(FETCHED, "7001") });
    assert.equal(oneStale.wouldCloseStale, 1);
    assert.equal(oneStale.wouldReuse, 2);
    const changed = await serviceFor(readOnly.db).planCampaigns({ campaigns: [campaign([payout({ groups: [group({ id: 1, value: 5 }), group({ id: 2, value: 2 })] })], 7001)] });
    assert.equal(changed.wouldVersion, 1);
    assert.equal(changed.wouldReuse, 1);
    assert.deepEqual(readOnly.writes, []);
  });

  it("counts only summary rules the live closure would close: those effective before the evidence time", async () => {
    const { rows, db, writes } = createRuleDb({ readOnly: true });
    seedUnrelated(rows);
    // Same window as closeSupersededCampaignSummaryRules (effectiveFrom < closedAt): a summary rule
    // dated at/after the evidence time is not superseded by it and must not be counted.
    rows.push({ id: "selected-summary-later", supplier: "BOOSTINY", sourceAccountLabel: "default", sourceObject: "campaigns", sourcePath: "commission", outcomeKey: "7001::campaigns::commission::2::PERCENT::PERCENT_OF_SALE::::slot:2::", effectiveFrom: new Date("2026-09-15T12:00:00.000Z"), effectiveUntil: null, conditions: [], metadata: {} });
    const plan = await serviceFor(db).planCampaigns({ campaigns: selectCanaryCampaigns(FETCHED, "7001"), fetchedAt: new Date("2026-09-15T12:00:00.000Z") });
    assert.equal(plan.wouldCloseSummary, 1);
    assert.deepEqual(writes, []);
  });

  it("an unlisted campaign id plans nothing and writes nothing", async () => {
    const { db, writes } = createRuleDb({ readOnly: true });
    const plan = await serviceFor(db).planCampaigns({ campaigns: selectCanaryCampaigns(FETCHED, "9999") });
    assert.equal(plan.campaignsSeen, 0);
    assert.equal(plan.candidates, 0);
    assert.equal(plan.wouldCreate + plan.wouldCloseStale + plan.wouldCloseSummary, 0);
    assert.deepEqual(writes, []);
  });

  it("plans through read-only code: no rule-service call, no write verb", () => {
    const code = codeOf(PERSIST_SRC);
    const plan = code.split("async planCampaign(")[1].split("async planCampaigns(")[0];
    for (const forbidden of ["upsertNormalizedFact", "ruleService", ".update(", ".updateMany(", ".create(", "$transaction", "closeStalePayoutGroupRules(", "closeSupersededCampaignSummaryRules("]) {
      assert.ok(!plan.includes(forbidden), forbidden);
    }
    const plans = code.split("async planCampaigns(")[1].split("\n  }")[0];
    for (const forbidden of ["persistCampaign(", "upsertNormalizedFact", ".update(", ".create("]) assert.ok(!plans.includes(forbidden), forbidden);
  });
});

describe("live canary — only the selected campaign is written", () => {
  it("persists the selected campaign's rules, closes only its stale and summary rules, and touches nothing else", async () => {
    const { rows, db } = createRuleDb();
    seedUnrelated(rows);
    const before = Object.fromEntries(rows.map((row) => [row.id, JSON.stringify(row)]));
    const summary = await serviceFor(db).persistCampaigns({ campaigns: selectCanaryCampaigns(FETCHED, "7001") });
    assert.equal(summary.campaignsSeen, 1);
    assert.equal(summary.rulesPersisted, 2);
    assert.equal(summary.supersededSummaryRules, 1);
    assert.equal(summary.staleRulesClosed, 1);
    assert.deepEqual(summary.persistErrors, []);
    const created = rows.filter((row) => row.id.startsWith("rule-"));
    assert.equal(created.length, 2);
    assert.ok(created.every((row) => row.outcomeKey.startsWith("boostiny::campaigns::7001::")));
    assert.ok(rows.find((row) => row.id === "selected-summary").effectiveUntil, "the selected campaign's summary rule is closed");
    assert.ok(rows.find((row) => row.id === "selected-stale-group").effectiveUntil, "the selected campaign's unlisted group is closed");
    for (const id of UNRELATED_IDS) assert.equal(JSON.stringify(rows.find((row) => row.id === id)), before[id], `${id} untouched`);
  });

  it("an unlisted campaign id writes nothing at all", async () => {
    const { rows, db, writes } = createRuleDb();
    seedUnrelated(rows);
    const summary = await serviceFor(db).persistCampaigns({ campaigns: selectCanaryCampaigns(FETCHED, "9999") });
    assert.equal(summary.campaignsSeen, 0);
    assert.equal(summary.rulesPersisted + summary.supersededSummaryRules + summary.staleRulesClosed, 0);
    assert.deepEqual(writes, []);
    assert.equal(openRows(rows).length, 6);
  });

  it("the account is the persistence's own scope: another account's rows are never read into a closure", async () => {
    const { rows, db } = createRuleDb();
    seedUnrelated(rows);
    await serviceFor(db).persistCampaigns({ sourceAccountLabel: "default", campaigns: selectCanaryCampaigns(FETCHED, "7001") });
    assert.equal(rows.find((row) => row.id === "other-account").effectiveUntil, null);
    assert.ok(rows.filter((row) => row.id.startsWith("rule-")).every((row) => row.sourceAccountLabel === "default"));
  });
});

describe("sync wiring — Boostiny only, before any commission write, never scheduled", () => {
  const code = codeOf(SYNC_SRC);
  const boostiny = code.split("async function syncBoostinyAccount")[1].split("async function syncBoostiny()")[0];

  it("reads the canary from the per-run options inside the Boostiny account sync only", () => {
    assert.match(boostiny, /const canary = resolveBoostinyCanary\(getSyncOptions\(\)\);/);
    assert.equal((code.match(/resolveBoostinyCanary\(/g) ?? []).length, 1);
    for (const other of ["async function syncOptimiseRegion", "async function syncTrackierAccount", "async function syncAll("]) {
      const section = code.split(other)[1]?.split("\nasync function ")[0] ?? "";
      assert.ok(!section.includes("canary"), other);
    }
    assert.ok(!codeOf(SCHEDULER_SRC).includes("canary"), "the scheduler never sets a canary");
  });

  it("forces campaigns only, always fetches them, and filters the fetched set before staging", () => {
    assert.match(boostiny, /const requested = canary \? "campaigns" : requestedSourceObject\(\);/);
    assert.match(boostiny, /const refreshCampaigns = canary \? true : shouldRefreshCampaigns\(/);
    assert.match(boostiny, /const refreshCoupons = canary \? false : shouldRefreshCoupons\(/);
    const filterAt = boostiny.indexOf("campaigns = selectCanaryCampaigns(campaigns, canary.supplierCampaignId);");
    assert.ok(filterAt > boostiny.indexOf("execute: () => adapter.fetchCampaigns(undefined, stats)"), "after the supplier fetch");
    assert.ok(filterAt < boostiny.indexOf("upsertManyRawEntities({\n      networkSource: \"boostiny\",\n      entityType: \"campaign\""), "before campaign staging");
    assert.ok(filterAt < boostiny.indexOf("persistCampaigns({"), "before commission persistence");
    assert.ok(filterAt < boostiny.indexOf("planCampaigns({"), "before the dry-run plan");
  });

  it("a dry run plans instead of staging or persisting, and a canary never records an account sync", () => {
    const dry = boostiny.split("if (canary?.dryRun) {")[1].split("} else if (refreshCampaigns")[0];
    assert.match(dry, /planCampaigns\(\{/);
    for (const write of ["upsertManyRawEntities", "persistCampaigns", "commissionRuleSkipCampaignIds"]) assert.ok(!dry.includes(write), write);
    assert.match(boostiny, /if \(!canary\) await markAccountSyncSuccess\("boostiny", accountLabel, \{/);
    assert.match(boostiny, /canary: canaryReport,/);
    const report = boostiny.split("canaryReport = {")[1].split("};")[0];
    for (const key of ["mode:", "campaignsFetched:", "campaignMatched:", "campaignsSelected:"]) assert.ok(report.includes(key), key);
    for (const leak of ["name", "payout", "supplierCampaignId"]) assert.ok(!report.includes(leak), leak);
  });

  it("the ordinary and scheduled paths are unchanged when no canary is set", () => {
    assert.match(boostiny, /commissionRuleSkipCampaignIds: \[\.\.\.payoutGroupCampaignIds\],/);
    assert.match(boostiny, /\} else if \(refreshCampaigns && includeSourceObject\(requested, "campaigns"\)\) \{/);
    assert.match(code, /const boostiny = await syncBoostiny\(\);/);
    assert.match(codeOf(SCHEDULER_SRC), /syncAll\(\{/);
  });
});

describe("admin-only entrypoint", () => {
  const routes = codeOf(ROUTES_SRC);
  const controller = codeOf(CONTROLLER_SRC);

  it("is a POST guarded by authentication, the ADMIN role and the sync permission, and is audited", () => {
    const route = routes.split('"/sync/boostiny/:accountLabel/canary"')[1].split(");")[0];
    assert.match(routes, /router\.post\(\s*"\/sync\/boostiny\/:accountLabel\/canary"/);
    for (const guard of ["authenticate,", "requireAdminRole,", "requirePermission(PERMISSIONS.SYNC_TRIGGER),", 'auditAction("sync.boostiny.canary"', "triggerBoostinyCanarySync,"]) {
      assert.ok(route.includes(guard), guard);
    }
    assert.ok(!routes.includes('router.get(\n  "/sync/boostiny/'), "no GET, no public route");
    assert.ok(routes.indexOf('"/sync/boostiny/:accountLabel/canary"') < routes.indexOf('"/sync/:platform/:accountLabel"'), "registered before the generic platform route");
  });

  it("runs the ordinary account sync restricted to campaigns, no promotion, dry run by default", () => {
    const handler = controller.split("export async function triggerBoostinyCanarySync")[1].split("\nexport ")[0];
    assert.match(handler, /normalizeBoostinyCanaryOptions\(\{/);
    // Both option sources: JSON body first, query string as fallback — for the id and for dryRun.
    assert.match(handler, /supplierCampaignId: req\.body\?\.supplierCampaignId \?\? req\.query\?\.supplierCampaignId,/);
    assert.match(handler, /dryRun: req\.body\?\.dryRun \?\? req\.query\?\.dryRun,/);
    assert.match(handler, /syncPlatformAccount\("boostiny", accountLabel, \{\s*fastSync: false,\s*promoteAfter: false,\s*sourceObject: "campaigns",\s*canary,\s*\}\)/);
    assert.match(handler, /return res\.status\(error\.status \?\? 400\)\.json\(\{ ok: false, message: error\.message \}\);/);
    assert.match(handler, /startBackgroundSync\(/);
    for (const forbidden of ["rawData", "req.body?.campaigns", "req.body?.payouts", "prisma"]) assert.ok(!handler.includes(forbidden), forbidden);
  });
});
