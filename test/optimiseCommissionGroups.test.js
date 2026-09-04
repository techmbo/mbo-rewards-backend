/**
 * Optimise detailed commission groups — GET /campaigns/{campaignId}/commission-groups
 * → RAW/SOURCE evidence → Optimise normalizer → SupplierCommissionRule[] / SupplierCommissionCondition[].
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.OPTIMISE_MIN_INTERVAL_MS = "0";
const { createOptimiseAdapter, extractCommissionGroupRows } = await import("../src/adapters/optimise.adapter.js");
const { createHttpClient } = await import("../src/core/httpClient.js");
const {
  OPTIMISE_VERIFY_LIVE_GATE,
  mapOptimiseCommissionGroupCandidates,
} = await import("../src/modules/commercial/optimiseCommissionGroup.mapper.js");
const { OptimiseCommissionGroupPersistenceService } = await import(
  "../src/modules/commercial/optimiseCommissionGroupPersistence.service.js"
);
const { SupplierCommissionRuleService } = await import(
  "../src/modules/commercial/services/supplierCommissionRule.service.js"
);
const { upsertCommissionRulesForPreparedCampaigns } = await import(
  "../src/modules/commercial/supplierCommissionRuleSync.service.js"
);
const {
  fetchOptimiseCommissionGroups,
  optimiseCommissionGroupSyncConfig,
  selectOptimiseCommissionGroupCampaigns,
} = await import("../src/jobs/optimiseCommissionGroupSync.js");
const { OPTIMISE_RESOURCE_ENDPOINTS, buildOptimiseSyncMetadata } = await import("../src/jobs/optimiseResourceSync.js");
const { OPTIMISE_RESOURCE_IDENTITY } = await import("../src/jobs/sourceObjectRuns.js");
const { getSourceObject } = await import("../src/modules/networkOps/sourceObjects.catalog.js");
const { matchSupplierCommissionRule } = await import("../src/modules/commercial/supplierCommissionMatcher.js");

const CONTEXT = {
  sourceCampaignId: "123",
  networkSource: "optimise_sea",
  sourceAccountLabel: "default",
  currency: "USD",
  fetchedAt: new Date("2026-09-03T10:00:00.000Z"),
};

function fakeHttpClient(handler) {
  const calls = [];
  const client = createHttpClient({
    baseURL: "https://public.api.optimisemedia.com/v1",
    apiKey: "key-1",
    headers: { apikey: "key-1", "x-agency-id": "42", "x-contact-id": "7" },
  });
  client.defaults.adapter = async (config) => {
    calls.push(config);
    const out = handler(config);
    if (out instanceof Error) throw out;
    return { data: out, status: 200, statusText: "OK", headers: {}, config };
  };
  return { client, calls };
}

function httpError(status, data = {}) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data, headers: {} };
  return error;
}

function createRuleDb() {
  const rows = [];
  let sequence = 0;
  const materializeConditions = (nested) => {
    if (!nested) return undefined;
    if (Array.isArray(nested.create)) return nested.create.map((row, index) => ({ id: `cond-${index + 1}`, ...row }));
    return [];
  };
  const model = {
    async findMany({ where }) {
      if (where.outcomeKey && typeof where.outcomeKey === "string") {
        return rows
          .filter(
            (row) =>
              row.supplier === where.supplier &&
              row.sourceAccountLabel === where.sourceAccountLabel &&
              row.outcomeKey === where.outcomeKey,
          )
          .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))
          .map((row) => ({ ...row, conditions: [...(row.conditions || [])] }));
      }
      // open detailed-rule lookup (one bounded query per account)
      return rows
        .filter(
          (row) =>
            (where.supplier == null || row.supplier === where.supplier) &&
            (where.sourceAccountLabel == null || row.sourceAccountLabel === where.sourceAccountLabel) &&
            (where.networkSource == null || row.networkSource === where.networkSource) &&
            (where.sourceObject == null || row.sourceObject === where.sourceObject) &&
            (!("effectiveUntil" in where) || row.effectiveUntil == where.effectiveUntil),
        )
        .map((row) => ({ outcomeKey: row.outcomeKey, metadata: row.metadata ?? null, supplierCampaign: null }));
    },
    async create({ data }) {
      sequence += 1;
      const row = { id: `rule-${sequence}`, createdAt: new Date(), ...data, conditions: materializeConditions(data.conditions) };
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }) {
      const index = rows.findIndex((row) => row.id === where.id);
      assert.notEqual(index, -1);
      const next = { ...rows[index], ...data };
      if (data.conditions) next.conditions = materializeConditions(data.conditions);
      rows[index] = next;
      return { ...next };
    },
    async updateMany({ where, data }) {
      let count = 0;
      for (const row of rows) {
        const matches =
          row.supplier === where.supplier &&
          row.sourceAccountLabel === where.sourceAccountLabel &&
          row.sourceObject === where.sourceObject &&
          row.effectiveUntil == null &&
          String(row.outcomeKey).startsWith(where.outcomeKey.startsWith) &&
          new Date(row.effectiveFrom) < where.effectiveFrom.lt;
        if (matches) {
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
      async findFirst({ where } = {}) {
        const id = where?.supplierCampaignId ?? "123";
        return {
          id: `sc-db-${id}`,
          supplierCampaignId: String(id),
          campaignName: "Zalora",
          merchantNameRaw: "Zalora",
          commissionCurrency: "USD",
          campaignSources: [{ id: `cs-db-${id}` }],
        };
      },
      async findMany() {
        return [];
      },
    },
    async $transaction(callback) {
      return callback({ supplierCommissionRule: model });
    },
  };
  return { rows, db };
}

function byCampaign(groups, { status = "SUCCESS", campaignId = "123", fetchedAt = CONTEXT.fetchedAt } = {}) {
  return new Map([[campaignId, { status, groups, currency: "USD", fetchedAt }]]);
}

describe("Optimise commission groups — A. adapter request", () => {
  it("requests GET /campaigns/{campaignId}/commission-groups with apikey / agency / contact context", async () => {
    const { client, calls } = fakeHttpClient(() => ({ response: [{ id: "G1", name: "Standard", commission: "10%" }] }));
    const adapter = createOptimiseAdapter({ apiKey: "key-1", agencyId: "42", contactId: "7", httpClient: client });

    const result = await adapter.fetchCommissionGroups(123);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "get");
    assert.equal(calls[0].url, "/campaigns/123/commission-groups");
    assert.equal(calls[0].headers.apikey, "key-1");
    assert.equal(calls[0].headers["x-agency-id"], "42");
    assert.equal(calls[0].headers["x-contact-id"], "7");
    assert.deepEqual(calls[0].params, { agencyId: "42", contactId: "7" });
    assert.equal(result.campaignId, "123");
    assert.equal(result.groups.length, 1);
    assert.equal(result.envelopeKind, "response");
    assert.ok(result.fetchedAt instanceof Date);
    assert.ok(adapter.getCapabilities().capabilities.includes("COMMISSION_GROUPS"));
  });

  it("propagates endpoint failure instead of fabricating an empty success", async () => {
    const { client } = fakeHttpClient(() => httpError(404, { message: "campaign not found" }));
    const adapter = createOptimiseAdapter({ apiKey: "key-1", agencyId: "42", contactId: "7", httpClient: client });
    await assert.rejects(() => adapter.fetchCommissionGroups("999"), (error) => error.response?.status === 404);
    await assert.rejects(() => adapter.fetchCommissionGroups(""), (error) => error.code === "optimise_commission_groups_invalid_campaign_id");
    await assert.rejects(() => adapter.fetchCommissionGroups("1/../x"), (error) => error.code === "optimise_commission_groups_invalid_campaign_id");
  });

  it("recognises the supported envelopes and rejects unknown ones", () => {
    assert.deepEqual(extractCommissionGroupRows([{ id: "G1" }]).groups, [{ id: "G1" }]);
    assert.equal(extractCommissionGroupRows({ data: [{ id: "G1" }] }).envelopeKind, "data");
    assert.equal(extractCommissionGroupRows({ commissionGroups: [{ id: "G1" }] }).envelopeKind, "commissionGroups");
    assert.equal(extractCommissionGroupRows({ payload: { data: [{ id: "G1" }] } }).envelopeKind, "payload.data");
    assert.equal(extractCommissionGroupRows({ data: { commissionGroups: [{ id: "G1" }] } }).envelopeKind, "data.commissionGroups");
    assert.equal(extractCommissionGroupRows({ id: "G1", name: "Single" }).envelopeKind, "single_object");
    assert.deepEqual(extractCommissionGroupRows(null).groups, []);
    assert.deepEqual(extractCommissionGroupRows([]).groups, []);
    assert.throws(
      () => extractCommissionGroupRows({ message: "Internal error", status: "error" }),
      (error) => error.code === "optimise_commission_groups_unrecognised_envelope",
    );
  });
});

describe("Optimise commission groups — resource registration", () => {
  it("registers a campaign-scoped resource, source-object identity and live catalog entry", () => {
    assert.equal(OPTIMISE_RESOURCE_ENDPOINTS.commissionGroups.path, "/campaigns/{campaignId}/commission-groups");
    assert.equal(OPTIMISE_RESOURCE_ENDPOINTS.commissionGroups.scope, "campaign");
    assert.equal(OPTIMISE_RESOURCE_IDENTITY.commissionGroups.sourceObject, "commission_groups");
    assert.equal(OPTIMISE_RESOURCE_IDENTITY.commissionGroups.endpoint, "GET /campaigns/{campaignId}/commission-groups");
    const catalog = getSourceObject("optimise_sea", "commission_groups");
    assert.equal(catalog?.live, true);
    assert.equal(catalog?.entityType, "commission_group");
  });

  it("sync metadata reports campaign counts and keeps failed campaign ids", () => {
    const metadata = buildOptimiseSyncMetadata(
      [
        {
          resource: "commissionGroups",
          endpoint: "GET /campaigns/{campaignId}/commission-groups",
          rows: [{ id: "G1" }, { id: "G2" }],
          error: null,
          campaignScope: {
            campaignsInspected: 5,
            campaignsSelected: 3,
            requestsAttempted: 3,
            requestsSucceeded: 2,
            requestsFailed: 1,
            groupsFetched: 2,
            failures: [{ campaignId: "777", httpStatus: 500, message: "boom" }],
          },
        },
      ],
      { region: "sea" },
      { refreshCampaigns: true, refreshCoupons: true },
    );
    const entry = metadata.resources.commissionGroups;
    assert.equal(entry.fetched, 2);
    assert.equal(entry.scope, "campaign");
    assert.equal(entry.success, false);
    assert.equal(entry.partial, true);
    assert.equal(entry.campaignScope.campaignsInspected, 5);
    assert.equal(entry.campaignScope.requestsAttempted, 3);
    assert.equal(entry.campaignScope.requestsSucceeded, 2);
    assert.equal(entry.campaignScope.requestsFailed, 1);
    assert.equal(entry.campaignScope.groupsFetched, 2);
    assert.deepEqual(metadata.failures[0].campaignIds, ["777"]);
  });

  it("selects applicable campaign ids safely (joined scope, dedupe, cap) and honours config", () => {
    const rows = [
      { id: 1, publishers: [{ campaignSubStatus: "approved" }] },
      { id: "1", publishers: [{ campaignSubStatus: "approved" }] },
      { id: 2, status: "notapplied" },
      { campaignId: "3/x", publishers: [{ campaignSubStatus: "approved" }] },
      { id: 4, publishers: [{ campaignSubStatus: "approved" }] },
      { id: 5, publishers: [{ campaignSubStatus: "approved" }] },
    ];
    const joined = selectOptimiseCommissionGroupCampaigns(rows, { scope: "joined", maxCampaigns: 2 });
    assert.deepEqual(joined.campaigns.map((c) => c.campaignId), ["1", "4"]);
    assert.equal(joined.campaignsInspected, 6);
    assert.equal(joined.skippedDuplicate, 1);
    assert.equal(joined.skippedNoId, 1);
    assert.equal(joined.skippedByScope, 1);
    assert.equal(joined.skippedByCap, 1);

    const all = selectOptimiseCommissionGroupCampaigns(rows, { scope: "all", maxCampaigns: 10 });
    assert.deepEqual(all.campaigns.map((c) => c.campaignId), ["1", "2", "4", "5"]);

    const config = optimiseCommissionGroupSyncConfig({ OPTIMISE_COMMISSION_GROUPS_ENABLED: "false", OPTIMISE_COMMISSION_GROUPS_SCOPE: "all", OPTIMISE_COMMISSION_GROUPS_MAX_CAMPAIGNS: "25" });
    assert.deepEqual(config, { enabled: false, scope: "all", maxCampaigns: 25 });
  });

  it("fetches sequentially through the adapter and preserves per-campaign failures", async () => {
    const order = [];
    let inFlight = 0;
    const adapter = {
      async fetchCommissionGroups(campaignId) {
        inFlight += 1;
        assert.equal(inFlight, 1, "requests must not overlap");
        order.push(campaignId);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        if (campaignId === "2") throw httpError(500, { message: "upstream down" });
        return { campaignId, groups: [{ id: `G${campaignId}`, commission: "5%" }], fetchedAt: new Date(), httpStatus: 200 };
      },
    };
    const result = await fetchOptimiseCommissionGroups({
      adapter,
      campaigns: [{ campaignId: "1" }, { campaignId: "2" }, { campaignId: "3" }],
    });
    assert.deepEqual(order, ["1", "2", "3"]);
    assert.equal(result.campaignScope.requestsAttempted, 3);
    assert.equal(result.campaignScope.requestsSucceeded, 2);
    assert.equal(result.campaignScope.requestsFailed, 1);
    assert.equal(result.campaignScope.groupsFetched, 2);
    assert.deepEqual(result.campaignScope.failures.map((f) => [f.campaignId, f.httpStatus, f.message]), [["2", 500, "upstream down"]]);
    assert.equal(result.byCampaign.get("2").status, "FAILED");
    assert.deepEqual(result.rows.map((r) => [r.campaignId, r.sourceCampaignId, r.record_source]), [["1", "1", "commission_group"], ["3", "3", "commission_group"]]);
  });
});

describe("Optimise commission groups — normalization", () => {
  it("B. one percentage group becomes one canonical rule with group lineage", () => {
    const rules = mapOptimiseCommissionGroupCandidates([{ id: "G1", name: "Standard", commission: "10%" }], CONTEXT);
    assert.equal(rules.length, 1);
    const [rule] = rules;
    assert.equal(rule.supplier, "OPTIMISE");
    assert.equal(rule.sourceCampaignId, "123");
    assert.equal(rule.sourceGroupId, "G1");
    assert.equal(rule.sourceGroupName, "Standard");
    assert.equal(rule.sourceRuleId, "G1");
    assert.equal(rule.sourceRuleName, "Standard");
    assert.equal(rule.supplierRuleType, "PERCENT");
    assert.equal(rule.basis, "PERCENT_OF_SALE");
    assert.equal(rule.ratePercent, 10);
    assert.equal(rule.fixedAmount, null);
    assert.equal(rule.commissionSequence, 1);
    assert.equal(rule.sourceObject, "commission_groups");
    assert.equal(rule.sourcePath, "commission-groups[0]");
    assert.equal(rule.mappingStatus, "VERIFIED");
    assert.equal(rule.metadata.financeReady, true);
    assert.deepEqual(rule.conditions, []);
    assert.equal(rule.rawRuleReference.commissionGroupId, "G1");
    assert.deepEqual(rule.rawRuleReference.group, { id: "G1", name: "Standard", commission: "10%" });
    assert.match(rule.outcomeKey, /^optimise::commission_groups::123::G1::base::slot:1::$/);
  });

  it("C. multiple groups become separate outcomes (Commission 1..N) with distinct identities", () => {
    const rules = mapOptimiseCommissionGroupCandidates(
      [
        { id: "G1", name: "Standard", commission: "10%" },
        { id: "G2", name: "Sale", commission: "5%" },
        { id: "G3", name: "Lead", commission: "USD 20", currency: "USD" },
      ],
      CONTEXT,
    );
    assert.equal(rules.length, 3);
    assert.deepEqual(rules.map((r) => r.commissionSequence), [1, 2, 3]);
    assert.deepEqual(rules.map((r) => r.sourceGroupId), ["G1", "G2", "G3"]);
    assert.deepEqual(rules.map((r) => [r.ratePercent, r.fixedAmount, r.currency]), [[10, null, null], [5, null, null], [null, 20, "USD"]]);
    assert.equal(new Set(rules.map((r) => r.outcomeKey)).size, 3);
    assert.ok(rules.every((r) => r.mappingStatus === "VERIFIED"));
  });

  it("D. a multi-band group yields one rule per band with band conditions and fail-closed status", () => {
    const rules = mapOptimiseCommissionGroupCandidates(
      [
        {
          id: "G7",
          name: "Volume tiers",
          bandType: "Sales",
          bands: [
            { from: 0, to: 10, commission: "5%" },
            { from: 11, to: 50, commission: "7%" },
            { from: 51, to: null, commission: "10%" },
          ],
        },
      ],
      CONTEXT,
    );
    assert.equal(rules.length, 3);
    assert.deepEqual(rules.map((r) => r.ratePercent), [5, 7, 10]);
    assert.ok(rules.every((r) => r.sourceGroupId === "G7"));
    assert.equal(new Set(rules.map((r) => r.outcomeKey)).size, 3);
    assert.deepEqual(rules.map((r) => r.couponOrTier), ["band:0-10", "band:11-50", "band:51-"]);
    assert.deepEqual(rules.map((r) => r.sourcePath), [
      "commission-groups[0].bands[0]",
      "commission-groups[0].bands[1]",
      "commission-groups[0].bands[2]",
    ]);
    for (const rule of rules) {
      const band = rule.conditions.find((c) => c.conditionType === "COMMISSION_TIER");
      assert.ok(band);
      assert.equal(band.operator, "SOURCE_RANGE");
      assert.equal(band.sourceConditionType, "OPTIMISE_BAND:Sales");
      assert.equal(band.metadata.matcherReady, false);
      assert.equal(band.metadata.semanticStatus, "VERIFY_LIVE");
      assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
      assert.equal(rule.metadata.semanticStatus, "VERIFY_LIVE");
      assert.ok(rule.metadata.reviewReasons.includes("band_selection_semantics_not_verified_live"));
      assert.ok(rule.conditions.some((c) => c.sourceConditionType === OPTIMISE_VERIFY_LIVE_GATE.sourceConditionType));
    }
    assert.deepEqual(rules[0].conditions.find((c) => c.conditionType === "COMMISSION_TIER").metadata.lowerBound, 0);
    assert.deepEqual(rules[1].conditions.find((c) => c.conditionType === "COMMISSION_TIER").metadata.upperBound, 50);
    // group-level commission is not turned into a fourth (average/first-band) rule
    assert.ok(!rules.some((r) => r.sourcePath === "commission-groups[0]"));
  });

  it("D2. band rules fail closed in the matcher instead of guessing or falling back to a broader rule", () => {
    const rules = mapOptimiseCommissionGroupCandidates(
      [
        { id: "G1", name: "Default", commission: "10%" },
        { id: "G7", bandType: "Sales", bands: [{ from: 0, to: 10, commission: "5%" }, { from: 11, commission: "7%" }] },
      ],
      CONTEXT,
    ).map((rule, index) => ({ ...rule, id: `r${index}` }));
    const result = matchSupplierCommissionRule({ rules, facts: { orderValue: 100, currency: "USD" } });
    assert.equal(result.status, "REVIEW_REQUIRED");
    assert.notEqual(result.matchedSupplierCommissionRuleId, "r0");
    assert.equal(result.expectedSupplierCommission, null);
  });

  it("E. explicit zero commission groups survive as real 0% / USD 0 rules", () => {
    const rules = mapOptimiseCommissionGroupCandidates(
      [
        { id: "G-EX", name: "Excluded Category", commission: "0%", conditions: [{ type: "category", value: "X" }] },
        { id: "G-ZERO-FIXED", name: "No payout market", commission: "USD 0", currency: "USD" },
        { id: "G-BASE", name: "Default", commission: "10%" },
      ],
      CONTEXT,
    );
    assert.equal(rules.length, 3);
    const excluded = rules.find((r) => r.sourceGroupId === "G-EX");
    assert.equal(excluded.ratePercent, 0);
    assert.equal(excluded.supplierRuleType, "PERCENT");
    assert.ok(excluded.conditions.some((c) => c.conditionType === "CATEGORY" && c.value === "X"));
    const zeroFixed = rules.find((r) => r.sourceGroupId === "G-ZERO-FIXED");
    assert.equal(zeroFixed.fixedAmount, 0);
    assert.equal(zeroFixed.currency, "USD");
    assert.equal(zeroFixed.mappingStatus, "VERIFIED");
  });

  it("does not turn blank or malformed group commissions into rules", () => {
    const rules = mapOptimiseCommissionGroupCandidates(
      [
        { id: "G-BLANK", commission: "" },
        { id: "G-NULL", commission: null },
        { id: "G-SPACE", commission: "   " },
        { id: "G-TEXT", commission: "see terms" },
      ],
      CONTEXT,
    );
    assert.equal(rules.length, 0);
  });

  it("F. group conditions become child SupplierCommissionCondition rows with raw lineage", () => {
    const rules = mapOptimiseCommissionGroupCandidates(
      [
        {
          id: "G-AE",
          name: "UAE new customers",
          commission: "12%",
          conditions: [
            { type: "country", value: "AE" },
            { type: "customer_type", value: "NEW" },
            { type: "basketMinimumSpend", value: "250", operator: "GTE" },
          ],
        },
      ],
      CONTEXT,
    );
    assert.equal(rules.length, 1);
    const [rule] = rules;
    const byType = Object.fromEntries(rule.conditions.map((c) => [c.conditionType + ":" + (c.sourceConditionType ?? ""), c]));
    assert.equal(byType["COUNTRY:country"].value, "AE");
    assert.equal(byType["CUSTOMER_TYPE:customer_type"].value, "NEW");
    const other = rule.conditions.find((c) => c.sourceConditionType === "basketMinimumSpend");
    assert.equal(other.conditionType, "OTHER_SOURCE_CONDITION");
    assert.equal(other.operator, "GTE");
    assert.equal(other.value, "250");
    assert.deepEqual(other.sourceConditionValue, { type: "basketMinimumSpend", value: "250", operator: "GTE" });
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(rule.metadata.semanticStatus, "VERIFY_LIVE");
    assert.ok(rule.metadata.reviewReasons.includes("unverified_condition_dimension"));
    assert.deepEqual(rule.rawRuleReference.conditions, [
      { type: "country", value: "AE" },
      { type: "customer_type", value: "NEW" },
      { type: "basketMinimumSpend", value: "250", operator: "GTE" },
    ]);
  });

  it("keeps a bare-number commission as percent but flags the unit for review", () => {
    const [rule] = mapOptimiseCommissionGroupCandidates([{ id: "G-N", commission: 8.5 }], CONTEXT);
    assert.equal(rule.ratePercent, 8.5);
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.ok(rule.metadata.reviewReasons.includes("commission_unit_not_explicit"));
  });

  it("splits an Optimise 'percent Or fixed' group commission into two outcomes under one group", () => {
    const rules = mapOptimiseCommissionGroupCandidates(
      [{ id: "G-OR", commission: { type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value", value: "8.20% Or $17.50" } }],
      CONTEXT,
    );
    assert.equal(rules.length, 2);
    assert.deepEqual(rules.map((r) => [r.sourceGroupId, r.outcomeSlot, r.ratePercent, r.fixedAmount]), [["G-OR", 1, 8.2, null], ["G-OR", 2, null, 17.5]]);
  });
});

describe("Optimise commission groups — persistence, precedence and versioning", () => {
  it("G. detailed group rules take precedence: campaign-summary commissionCost is not fanned out for that campaign", async () => {
    const writes = [];
    const deps = {
      prisma: { supplierCampaign: { findMany: async () => [] } },
      ruleService: { upsertNormalizedFact: async (input) => { writes.push(input); return { id: `w${writes.length}` }; } },
    };
    const preparedRecords = [
      { originalPayload: { id: 123, commissionCost: "10%", commissionGroup: [{ commission: "10%" }] } },
      { originalPayload: { id: 456, commissionCost: "7%" } },
    ];

    const withDetailed = await upsertCommissionRulesForPreparedCampaigns(
      { networkSource: "optimise_sea", preparedRecords, sourceAccountKey: "default", skipCampaignIds: new Set(["123"]) },
      deps,
    );
    assert.equal(withDetailed.skippedDetailedCampaigns, 1);
    assert.ok(writes.every((w) => w.metadata.sourceCampaignId === "456"));
    assert.ok(writes.length >= 1);

    writes.length = 0;
    const withoutDetailed = await upsertCommissionRulesForPreparedCampaigns(
      { networkSource: "optimise_sea", preparedRecords, sourceAccountKey: "default" },
      deps,
    );
    assert.equal(withoutDetailed.skippedDetailedCampaigns, 0);
    assert.ok(writes.some((w) => w.metadata.sourceCampaignId === "123"));
  });

  it("G2. persisting detailed rules closes open campaign-summary rules for the same campaign (history kept)", async () => {
    const { rows, db } = createRuleDb();
    rows.push({
      id: "summary-1",
      supplier: "OPTIMISE",
      sourceAccountLabel: "default",
      sourceObject: "campaigns",
      outcomeKey: "123::campaigns::commission::ANON_SOURCE_ENTRY_1::PERCENT::PERCENT_OF_SALE::::slot:1::",
      ratePercent: 10,
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
      effectiveUntil: null,
      conditions: [],
    });
    rows.push({
      id: "summary-other",
      supplier: "OPTIMISE",
      sourceAccountLabel: "default",
      sourceObject: "campaigns",
      outcomeKey: "456::campaigns::commission::ANON_SOURCE_ENTRY_1::PERCENT::PERCENT_OF_SALE::::slot:1::",
      ratePercent: 7,
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
      effectiveUntil: null,
      conditions: [],
    });
    const service = new OptimiseCommissionGroupPersistenceService({ prisma: db });

    const summary = await service.persistFetchedGroups({
      networkSource: "optimise_sea",
      sourceAccountLabel: "default",
      byCampaign: byCampaign([{ id: "G1", name: "Standard", commission: "10%" }]),
    });

    assert.equal(summary.rulesPersisted, 1);
    assert.equal(summary.supersededSummaryRules, 1);
    const closed = rows.find((r) => r.id === "summary-1");
    assert.equal(new Date(closed.effectiveUntil).toISOString(), CONTEXT.fetchedAt.toISOString());
    assert.equal(closed.ratePercent, 10, "historical economics untouched");
    assert.equal(rows.find((r) => r.id === "summary-other").effectiveUntil, null, "other campaigns untouched");
    const detailed = rows.find((r) => r.sourceObject === "commission_groups");
    assert.equal(detailed.supplierCampaignId, "sc-db-123");
    assert.equal(detailed.campaignSourceId, "cs-db-123");
    assert.equal(detailed.sourceGroupId, "G1");
    assert.equal(detailed.metadata.promotionGate, "PERSIST_ALL_MARK_UNVERIFIED");
  });

  it("H. re-syncing an identical commission-group payload is idempotent (no new version)", async () => {
    const { rows, db } = createRuleDb();
    const service = new OptimiseCommissionGroupPersistenceService({ prisma: db });
    const groups = [
      { id: "G1", name: "Standard", commission: "10%" },
      { id: "G2", name: "Excluded", commission: "0%" },
    ];

    const first = await service.persistFetchedGroups({ networkSource: "optimise_sea", byCampaign: byCampaign(groups) });
    const second = await service.persistFetchedGroups({
      networkSource: "optimise_sea",
      byCampaign: byCampaign(groups, { fetchedAt: new Date("2026-09-04T10:00:00.000Z") }),
    });

    assert.equal(first.rulesPersisted, 2);
    assert.equal(second.rulesPersisted, 2);
    assert.equal(rows.length, 2);
    assert.deepEqual(first.campaigns[0].ruleIds, second.campaigns[0].ruleIds);
    assert.ok(rows.every((r) => r.effectiveUntil == null));
    assert.equal(rows.find((r) => r.sourceGroupId === "G2").ratePercent, 0);
  });

  it("I. a rate change on the same group (10% → 12%) versions the same logical outcome", async () => {
    const { rows, db } = createRuleDb();
    const service = new OptimiseCommissionGroupPersistenceService({ prisma: db });

    await service.persistFetchedGroups({ networkSource: "optimise_sea", byCampaign: byCampaign([{ id: "G1", name: "Standard", commission: "10%" }]) });
    const changedAt = new Date("2026-09-10T00:00:00.000Z");
    await service.persistFetchedGroups({
      networkSource: "optimise_sea",
      byCampaign: byCampaign([{ id: "G1", name: "Standard", commission: "12%" }], { fetchedAt: changedAt }),
    });

    assert.equal(rows.length, 2);
    const [previous, successor] = rows;
    assert.equal(previous.outcomeKey, successor.outcomeKey, "same logical outcome identity");
    assert.equal(previous.ratePercent, 10);
    assert.equal(new Date(previous.effectiveUntil).toISOString(), changedAt.toISOString());
    assert.equal(successor.ratePercent, 12);
    assert.equal(successor.effectiveUntil, null);
    assert.equal(successor.sourceGroupId, "G1");
  });

  it("I2. 10% → 0% on the same group is a genuine economic version change", async () => {
    const { rows, db } = createRuleDb();
    const service = new OptimiseCommissionGroupPersistenceService({ prisma: db });
    await service.persistFetchedGroups({ networkSource: "optimise_sea", byCampaign: byCampaign([{ id: "G1", commission: "10%" }]) });
    await service.persistFetchedGroups({
      networkSource: "optimise_sea",
      byCampaign: byCampaign([{ id: "G1", commission: "0%" }], { fetchedAt: new Date("2026-09-10T00:00:00.000Z") }),
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ratePercent, 10);
    assert.notEqual(rows[0].effectiveUntil, null);
    assert.equal(rows[1].ratePercent, 0);
    assert.equal(rows[1].effectiveUntil, null);
  });

  it("J. a failed commission-groups fetch leaves existing rules untouched and creates no guessed rules", async () => {
    const { rows, db } = createRuleDb();
    const service = new OptimiseCommissionGroupPersistenceService({ prisma: db });
    await service.persistFetchedGroups({ networkSource: "optimise_sea", byCampaign: byCampaign([{ id: "G1", commission: "10%" }]) });
    const snapshot = JSON.stringify(rows);

    const summary = await service.persistFetchedGroups({
      networkSource: "optimise_sea",
      byCampaign: new Map([["123", { status: "FAILED", groups: [], error: { campaignId: "123", httpStatus: 503, message: "unavailable" } }]]),
    });

    assert.equal(summary.campaignsFailed, 1);
    assert.equal(summary.campaignsFetched, 0);
    assert.equal(summary.rulesPersisted, 0);
    assert.equal(summary.supersededSummaryRules, 0);
    assert.equal(JSON.stringify(rows), snapshot, "existing rules neither closed nor replaced");
    assert.equal(rows[0].effectiveUntil, null);
    assert.equal(service.planCandidates({ networkSource: "optimise_sea", byCampaign: summary.byCampaign ?? new Map() }).size, 0);
  });

  it("J2. a campaign whose fetch failed is not marked as detailed, so its summary fan-out still runs", () => {
    const service = new OptimiseCommissionGroupPersistenceService({ prisma: {} });
    const planned = service.planCandidates({
      networkSource: "optimise_sea",
      byCampaign: new Map([
        ["1", { status: "SUCCESS", groups: [{ id: "G1", commission: "10%" }] }],
        ["2", { status: "FAILED", groups: [] }],
        ["3", { status: "SUCCESS", groups: [] }],
      ]),
    });
    assert.deepEqual([...planned.keys()], ["1", "3"]);
    assert.equal(planned.get("1").length, 1);
    assert.equal(planned.get("3").length, 0);
  });
});

/**
 * Mirrors the Optimise sync order for one account:
 *   precedence lookup → campaign staging (summary fan-out with skip set) → detailed persistence.
 */
async function runOptimiseSync({ db, byCampaign, campaigns, fetchedAt = new Date("2026-09-03T10:00:00.000Z") }) {
  const persistence = new OptimiseCommissionGroupPersistenceService({ prisma: db });
  const ruleService = new SupplierCommissionRuleService({ prisma: db });
  const precedence = await persistence.resolveDetailedPrecedence({
    networkSource: "optimise_sea",
    sourceAccountLabel: "default",
    byCampaign,
  });
  const fanOut = await upsertCommissionRulesForPreparedCampaigns(
    {
      networkSource: "optimise_sea",
      sourceAccountKey: "default",
      preparedRecords: campaigns.map((raw) => ({ originalPayload: raw, sourceEvidenceAt: fetchedAt })),
      skipCampaignIds: precedence.protectedCampaignIds,
    },
    { prisma: db, ruleService },
  );
  const detailed = await persistence.persistFetchedGroups({
    networkSource: "optimise_sea",
    sourceAccountLabel: "default",
    byCampaign,
    fetchedAt,
    existingOpenDetailedCampaignIds: precedence.existingOpenDetailedCampaignIds,
  });
  return { precedence, fanOut, detailed };
}

const openRules = (rows, predicate = () => true) => rows.filter((r) => r.effectiveUntil == null && predicate(r));
const summaryRules = (rows, campaignId) => rows.filter((r) => r.sourceObject === "campaigns" && String(r.outcomeKey).startsWith(`${campaignId}::`));
const detailedRules = (rows, campaignId) => rows.filter((r) => r.sourceObject === "commission_groups" && String(r.outcomeKey).includes(`::${campaignId}::`));
const campaign123 = { id: 123, commissionCost: "8%", publishers: [{ campaignSubStatus: "approved" }] };
const groups123 = [
  { id: "G1", name: "Standard", commission: "5%" },
  { id: "G2", name: "Premium", commission: "10%" },
];
const success = (groups, fetchedAt = new Date("2026-09-03T10:00:00.000Z")) => ({ status: "SUCCESS", groups, currency: "USD", fetchedAt });
const failed503 = { status: "FAILED", groups: [], error: { httpStatus: 503, message: "Service Unavailable" } };

describe("Optimise commission groups — detailed-rule precedence survives failed syncs (P0)", () => {
  it("successful detailed sync followed by a 503 keeps G1/G2 open and never reactivates the 8% summary rule", async () => {
    const { rows, db } = createRuleDb();

    // Sync 1: campaign summary 8%, detailed groups G1 5% / G2 10%
    const sync1 = await runOptimiseSync({ db, byCampaign: new Map([["123", success(groups123)]]), campaigns: [campaign123] });
    assert.equal(sync1.fanOut.skippedDetailedCampaigns, 1, "summary fan-out suppressed for detailed campaign");
    assert.equal(sync1.detailed.rulesPersisted, 2);
    assert.deepEqual(openRules(detailedRules(rows, "123")).map((r) => [r.sourceGroupId, r.ratePercent]).sort(), [["G1", 5], ["G2", 10]]);
    assert.equal(summaryRules(rows, "123").length, 0, "no summary rule was created");
    const snapshot = JSON.stringify(detailedRules(rows, "123"));

    // Sync 2: campaign list succeeds, commission-groups for 123 fails with 503
    const sync2 = await runOptimiseSync({
      db,
      byCampaign: new Map([["123", failed503]]),
      campaigns: [campaign123],
      fetchedAt: new Date("2026-09-04T10:00:00.000Z"),
    });

    assert.deepEqual([...sync2.precedence.existingOpenDetailedCampaignIds], ["123"]);
    assert.deepEqual([...sync2.precedence.protectedCampaignIds], ["123"]);
    assert.deepEqual(sync2.precedence.retryRequiredCampaignIds, ["123"]);
    assert.equal(sync2.fanOut.skippedDetailedCampaigns, 1, "summary fan-out still suppressed");
    assert.equal(sync2.detailed.campaignsFailed, 1);
    assert.deepEqual(sync2.detailed.campaignsDetailRetryRequired, ["123"]);
    assert.equal(openRules(detailedRules(rows, "123")).length, 2, "G1 and G2 remain open");
    assert.equal(openRules(summaryRules(rows, "123")).length, 0, "NO open 8% campaign-summary rule");
    assert.equal(summaryRules(rows, "123").length, 0);
    assert.equal(JSON.stringify(detailedRules(rows, "123")), snapshot, "detailed rules untouched: not closed, not versioned, economics unchanged");
  });

  it("partial failure: 123 refreshes from current data, previously detailed 456 keeps its rules with no summary reactivation", async () => {
    const { rows, db } = createRuleDb();
    const campaign456 = { id: 456, commissionCost: "6%", publishers: [{ campaignSubStatus: "approved" }] };
    await runOptimiseSync({
      db,
      byCampaign: new Map([
        ["123", success(groups123)],
        ["456", success([{ id: "H1", name: "Base", commission: "7%" }])],
      ]),
      campaigns: [campaign123, campaign456],
    });
    const snapshot456 = JSON.stringify(detailedRules(rows, "456"));

    const sync2 = await runOptimiseSync({
      db,
      byCampaign: new Map([
        ["123", success([{ id: "G1", name: "Standard", commission: "6%" }, { id: "G2", name: "Premium", commission: "10%" }], new Date("2026-09-05T00:00:00.000Z"))],
        ["456", failed503],
      ]),
      campaigns: [campaign123, campaign456],
      fetchedAt: new Date("2026-09-05T00:00:00.000Z"),
    });

    assert.deepEqual([...sync2.precedence.protectedCampaignIds].sort(), ["123", "456"]);
    assert.deepEqual(sync2.precedence.retryRequiredCampaignIds, ["456"]);
    assert.deepEqual(sync2.detailed.campaignsDetailRetryRequired, ["456"]);
    assert.equal(sync2.fanOut.skippedDetailedCampaigns, 2);
    // 123 uses current detailed data: G1 versioned 5% -> 6%, G2 unchanged
    const g1 = detailedRules(rows, "123").filter((r) => r.sourceGroupId === "G1");
    assert.equal(g1.length, 2);
    assert.equal(openRules(g1)[0].ratePercent, 6);
    assert.equal(openRules(detailedRules(rows, "123")).length, 2);
    // 456 retains previous detailed data, no summary economics
    assert.equal(JSON.stringify(detailedRules(rows, "456")), snapshot456);
    assert.equal(summaryRules(rows, "456").length, 0);
    assert.equal(summaryRules(rows, "123").length, 0);
  });

  it("first-ever failure: a campaign with no detailed history keeps the existing campaign-level fallback", async () => {
    const { rows, db } = createRuleDb();
    const campaign789 = { id: 789, commissionCost: "9%", publishers: [{ campaignSubStatus: "approved" }] };

    const sync = await runOptimiseSync({ db, byCampaign: new Map([["789", failed503]]), campaigns: [campaign789] });

    assert.deepEqual(sync.precedence.firstEverFailureCampaignIds, ["789"]);
    assert.deepEqual(sync.precedence.retryRequiredCampaignIds, []);
    assert.equal(sync.precedence.protectedCampaignIds.size, 0);
    assert.equal(sync.fanOut.skippedDetailedCampaigns, 0);
    assert.equal(sync.fanOut.upserted, 1, "campaign-level summary fallback still fans out");
    assert.equal(openRules(summaryRules(rows, "789"))[0].ratePercent, 9);
    assert.equal(detailedRules(rows, "789").length, 0, "no detailed rules are pretended to exist");
    assert.deepEqual(sync.detailed.campaignsDetailRetryRequired, []);
  });

  it("successful empty response for a previously detailed campaign fails closed (rules kept, VERIFY_LIVE recorded)", async () => {
    const { rows, db } = createRuleDb();
    await runOptimiseSync({ db, byCampaign: new Map([["123", success(groups123)]]), campaigns: [campaign123] });
    const snapshot = JSON.stringify(detailedRules(rows, "123"));

    const sync2 = await runOptimiseSync({
      db,
      byCampaign: new Map([["123", success([], new Date("2026-09-06T00:00:00.000Z"))]]),
      campaigns: [campaign123],
      fetchedAt: new Date("2026-09-06T00:00:00.000Z"),
    });

    assert.deepEqual(sync2.precedence.emptyWithOpenRulesCampaignIds, ["123"]);
    assert.ok(sync2.precedence.protectedCampaignIds.has("123"));
    assert.equal(sync2.fanOut.skippedDetailedCampaigns, 1);
    assert.deepEqual(sync2.detailed.campaignsEmptyResponseVerifyLive, ["123"]);
    assert.equal(sync2.detailed.campaigns[0].status, "EMPTY_RESPONSE_VERIFY_LIVE");
    assert.equal(sync2.detailed.rulesPersisted, 0);
    assert.equal(JSON.stringify(detailedRules(rows, "123")), snapshot, "open detailed rules untouched");
    assert.equal(summaryRules(rows, "123").length, 0, "no duplicate summary economics");
  });

  it("empty response for a campaign with no detailed history keeps the campaign-level fallback", async () => {
    const { rows, db } = createRuleDb();
    const sync = await runOptimiseSync({ db, byCampaign: new Map([["123", success([])]]), campaigns: [campaign123] });
    assert.deepEqual(sync.precedence.emptyWithOpenRulesCampaignIds, []);
    assert.equal(sync.fanOut.upserted, 1);
    assert.equal(openRules(summaryRules(rows, "123")).length, 1);
  });

  it("disabled or skipped detailed fetch still respects existing open detailed rules", async () => {
    const { rows, db } = createRuleDb();
    await runOptimiseSync({ db, byCampaign: new Map([["123", success(groups123)]]), campaigns: [campaign123] });

    // OPTIMISE_COMMISSION_GROUPS_ENABLED=false / source object skipped → no byCampaign at all
    const sync2 = await runOptimiseSync({ db, byCampaign: new Map(), campaigns: [campaign123], fetchedAt: new Date("2026-09-07T00:00:00.000Z") });

    assert.deepEqual([...sync2.precedence.protectedCampaignIds], ["123"]);
    assert.equal(sync2.fanOut.skippedDetailedCampaigns, 1);
    assert.equal(summaryRules(rows, "123").length, 0, "campaign refresh did not create a summary rule over open detailed rules");
    assert.equal(openRules(detailedRules(rows, "123")).length, 2);
  });

  it("loadOpenDetailedCampaignIds is one bounded account-scoped query and ignores closed rules and other accounts", async () => {
    const { rows, db } = createRuleDb();
    const base = { supplier: "OPTIMISE", sourceObject: "commission_groups", effectiveFrom: new Date("2026-08-01T00:00:00.000Z"), conditions: [] };
    rows.push({ ...base, id: "a", sourceAccountLabel: "default", networkSource: "optimise_sea", outcomeKey: "optimise::commission_groups::111::G1::base::slot:1::", effectiveUntil: null });
    rows.push({ ...base, id: "b", sourceAccountLabel: "default", networkSource: "optimise_sea", outcomeKey: "optimise::commission_groups::222::G1::base::slot:1::", effectiveUntil: new Date("2026-08-15T00:00:00.000Z") });
    rows.push({ ...base, id: "c", sourceAccountLabel: "other-account", networkSource: "optimise_sea", outcomeKey: "optimise::commission_groups::333::G1::base::slot:1::", effectiveUntil: null });
    rows.push({ ...base, id: "d", sourceAccountLabel: "default", networkSource: "optimise_mena", outcomeKey: "optimise::commission_groups::444::G1::base::slot:1::", effectiveUntil: null });
    rows.push({ ...base, id: "e", sourceAccountLabel: "default", networkSource: "optimise_sea", sourceObject: "campaigns", outcomeKey: "555::campaigns::commission::x", effectiveUntil: null });
    let queries = 0;
    const original = db.supplierCommissionRule.findMany;
    db.supplierCommissionRule.findMany = async (args) => { queries += 1; return original(args); };

    const service = new OptimiseCommissionGroupPersistenceService({ prisma: db });
    const ids = await service.loadOpenDetailedCampaignIds({ networkSource: "optimise_sea", sourceAccountLabel: "default" });

    assert.deepEqual([...ids], ["111"]);
    assert.equal(queries, 1);
  });
});

describe("Optimise commission groups — anonymous group identity (P1)", () => {
  const run1 = [
    { name: "New customers", commission: "10%" },
    { name: "Existing customers", commission: "5%" },
  ];
  const run2 = [run1[1], run1[0]];

  it("never uses array position: reordering anonymous groups keeps the same logical outcomeKeys", () => {
    const first = mapOptimiseCommissionGroupCandidates(run1, CONTEXT);
    const second = mapOptimiseCommissionGroupCandidates(run2, CONTEXT);
    const keysByName = (rules) => Object.fromEntries(rules.map((r) => [r.sourceGroupName, r.outcomeKey]));
    assert.deepEqual(keysByName(first), keysByName(second));
    assert.ok(first.every((r) => !/ANON_GROUP_\d/.test(r.outcomeKey)), "no positional ANON_GROUP_n identity");
    assert.ok(first.every((r) => r.sourceGroupId === null && r.sourceRuleId === null), "no manufactured supplier ids");
    assert.ok(first.every((r) => r.metadata.identityStrategy === "ANONYMOUS_SEMANTIC_FINGERPRINT"));
    assert.ok(first.every((r) => r.metadata.reviewReasons.includes("supplier_group_id_missing")));
    assert.ok(first.every((r) => r.mappingStatus === "REVIEW_REQUIRED" && r.metadata.financeReady === false));
    // key order inside the source object does not change identity either
    const reordered = mapOptimiseCommissionGroupCandidates([{ commission: "10%", name: "New customers" }], CONTEXT);
    assert.equal(reordered[0].outcomeKey, keysByName(first)["New customers"]);
  });

  it("reordered anonymous groups do not create new historical versions on re-sync", async () => {
    const { rows, db } = createRuleDb();
    const service = new OptimiseCommissionGroupPersistenceService({ prisma: db });
    await service.persistFetchedGroups({ networkSource: "optimise_sea", byCampaign: byCampaign(run1) });
    await service.persistFetchedGroups({ networkSource: "optimise_sea", byCampaign: byCampaign(run2, { fetchedAt: new Date("2026-09-08T00:00:00.000Z") }) });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.effectiveUntil == null));
  });

  it("anonymous but semantically identifiable rule 10% → 12% versions the same logical outcome", async () => {
    const { rows, db } = createRuleDb();
    const service = new OptimiseCommissionGroupPersistenceService({ prisma: db });
    await service.persistFetchedGroups({ networkSource: "optimise_sea", byCampaign: byCampaign([{ name: "New customers", commission: "10%" }]) });
    const changedAt = new Date("2026-09-09T00:00:00.000Z");
    await service.persistFetchedGroups({ networkSource: "optimise_sea", byCampaign: byCampaign([{ name: "New customers", commission: "12%" }], { fetchedAt: changedAt }) });

    assert.equal(rows.length, 2);
    assert.equal(rows[0].outcomeKey, rows[1].outcomeKey);
    assert.equal(rows[0].ratePercent, 10);
    assert.equal(new Date(rows[0].effectiveUntil).toISOString(), changedAt.toISOString());
    assert.equal(rows[1].ratePercent, 12);
    assert.equal(rows[1].effectiveUntil, null);
  });

  it("anonymous group with no stable semantics is REVIEW_REQUIRED, not finance-ready, evidence retained", () => {
    const [rule] = mapOptimiseCommissionGroupCandidates([{ commission: "10%" }], CONTEXT);
    assert.equal(rule.mappingStatus, "REVIEW_REQUIRED");
    assert.equal(rule.metadata.financeReady, false);
    assert.equal(rule.metadata.identityStrategy, "ANONYMOUS_INSUFFICIENT");
    assert.equal(rule.metadata.identitySufficient, false);
    assert.ok(rule.metadata.reviewReasons.includes("supplier_group_id_missing"));
    assert.ok(rule.metadata.reviewReasons.includes("anonymous_group_identity_insufficient"));
    assert.ok(rule.outcomeKey.includes("::ANON_UNIDENTIFIED:"));
    assert.deepEqual(rule.rawRuleReference.group, { commission: "10%" });
    assert.ok(rule.conditions.some((c) => c.sourceConditionType === OPTIMISE_VERIFY_LIVE_GATE.sourceConditionType));
  });

  it("supplier-provided ids remain the lineage and identity", () => {
    const [rule] = mapOptimiseCommissionGroupCandidates([{ id: "G9", name: "Named", commission: "10%" }], CONTEXT);
    assert.equal(rule.sourceGroupId, "G9");
    assert.equal(rule.sourceRuleId, "G9");
    assert.equal(rule.metadata.identityStrategy, "SUPPLIER_ID");
    assert.ok(rule.outcomeKey.includes("::G9::"));
  });
});
