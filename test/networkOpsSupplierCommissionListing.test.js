/**
 * Network Operations — supplier commission listing (Commission 1...N).
 * Canonical SupplierCommissionRule rows are authoritative per campaign; campaigns without
 * persisted rules get projected rows from the ingestion fan-out. Display only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NetworkPortalService } from "../src/modules/networkPortal/networkPortal.service.js";
import {
  assembleSupplierCommissionRows,
  projectCampaignCommissionOutcomes,
  projectedMappingStatus,
} from "../src/modules/networkPortal/supplierCommissionListing.js";
import { toSupplierCommissionRuleDto } from "../src/modules/commercial/supplierCommissionRule.contract.js";

function campaign(overrides = {}) {
  // Persisted state mirrors the campaign mapper: commissionGroups column is populated from
  // the raw payload's commission bag, so the fallback scope predicate finds the campaign.
  const raw = overrides.rawPayload ?? {};
  const derivedGroups =
    overrides.commissionGroups !== undefined
      ? overrides.commissionGroups
      : raw.commissionGroups ?? raw.commission_groups ?? raw.commissionGroup ?? raw.payouts ?? null;
  const derivedDefault =
    overrides.defaultCommissionValue !== undefined
      ? overrides.defaultCommissionValue
      : raw.commission && typeof raw.commission === "object" && typeof raw.commission.value === "string"
        ? String(raw.commission.value).match(/-?\d+(\.\d+)?/)?.[0] ?? null
        : null;
  return {
    id: overrides.id ?? "sc-1",
    supplier: "OPTIMISE",
    supplierRegion: "SEA",
    sourceAccountLabel: "default",
    campaignName: overrides.campaignName ?? "Zalora",
    merchantNameRaw: overrides.merchantNameRaw ?? "Zalora",
    supplierCampaignId: overrides.supplierCampaignId ?? "123",
    countryCodes: overrides.countryCodes ?? [],
    categoryName: overrides.categoryName ?? null,
    defaultCommissionValue: derivedDefault,
    commissionUnit: null,
    commissionCurrency: null,
    currencyCode: "USD",
    commissionGroups: derivedGroups,
    rawPayload: {},
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
    ...(overrides.commissionGroups === undefined ? { commissionGroups: derivedGroups } : {}),
    ...(overrides.defaultCommissionValue === undefined ? { defaultCommissionValue: derivedDefault } : {}),
  };
}

function canonicalRule(overrides = {}) {
  return {
    id: overrides.id ?? "rule-1",
    supplier: "OPTIMISE",
    sourceAccountLabel: "default",
    supplierCampaignId: overrides.supplierCampaignId ?? "sc-A",
    campaignSourceId: null,
    supplierCampaign: overrides.supplierCampaign ?? campaign({ id: "sc-A", campaignName: "Alpha", merchantNameRaw: "Alpha", supplierCampaignId: "A1" }),
    campaignSource: null,
    sourceGroupId: overrides.sourceGroupId ?? "G1",
    sourceGroupName: overrides.sourceGroupName ?? "Standard",
    sourceRuleId: overrides.sourceRuleId ?? "G1",
    sourceRuleName: overrides.sourceRuleName ?? "Standard",
    outcomeKey: overrides.outcomeKey ?? "optimise::commission_groups::A1::G1::base::slot:1::",
    outcomeSlot: 1,
    commissionSequence: overrides.commissionSequence ?? null,
    supplierRuleType: "PERCENT",
    basis: "PERCENT_OF_SALE",
    ratePercent: overrides.ratePercent ?? 10,
    fixedAmount: overrides.fixedAmount ?? null,
    currency: overrides.currency ?? null,
    customerType: null,
    country: overrides.country ?? null,
    categoryProductGoal: null,
    couponOrTier: null,
    conditions: overrides.conditions ?? [],
    effectiveFrom: overrides.effectiveFrom ?? new Date("2026-08-01T00:00:00.000Z"),
    effectiveUntil: overrides.effectiveUntil ?? null,
    sourceObject: "commission_groups",
    sourcePath: "commission-groups[0]",
    mappingStatus: "VERIFIED",
    fieldMappingOutcome: "MAPPED",
    metadata: null,
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function fakeDb({ rules = [], campaigns = [] } = {}) {
  const calls = { ruleWhere: [], campaignWhere: [] };
  return {
    calls,
    db: {
      supplierCommissionRule: {
        async findMany({ where }) {
          calls.ruleWhere.push(where);
          return rules.filter((r) => !where?.supplier || r.supplier === where.supplier);
        },
      },
      supplierCampaign: {
        async findMany({ where }) {
          calls.campaignWhere.push(where);
          const excluded = new Set(where?.id?.notIn ?? []);
          return campaigns.filter(
            (c) =>
              !excluded.has(c.id) &&
              (!where?.supplier || c.supplier === where.supplier) &&
              (c.defaultCommissionValue != null || c.commissionGroups != null),
          );
        },
      },
    },
  };
}

const list = (setup, args = {}) => new NetworkPortalService({ prisma: fakeDb(setup).db }).listSupplierCommissionRules(args);

describe("Network Ops supplier commission listing — Commission 1...N projection", () => {
  it("A. one commission → one projected rule, Commission 1", async () => {
    const result = await list({ campaigns: [campaign({ defaultCommissionValue: "10", commissionUnit: "PERCENT" })] });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].commissionSequence, 1);
    assert.equal(result.items[0].displayLabel, "Commission 1");
    assert.equal(result.items[0].commissionValue, "10%");
    assert.equal(result.items[0].projected, true);
    assert.equal(result.items[0].sourcePath, "defaultCommissionValue");
    assert.equal(result.meta.projectedCampaigns, 1);
  });

  it("B. two commission groups → Commission 1 and Commission 2 with lineage and conditions", async () => {
    const result = await list({
      campaigns: [
        campaign({
          rawPayload: {
            id: "123",
            commissionGroups: [
              { id: "G-NEW", name: "New Customer", commission: "10%", customer_type: "NEW" },
              { id: "G-EXIST", name: "Existing Customer", commission: "5%", customer_type: "EXISTING" },
            ],
          },
        }),
      ],
    });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map((i) => i.commissionSequence), [1, 2]);
    assert.deepEqual(result.items.map((i) => [i.commissionValue, i.sourceGroupId, i.sourceGroupName, i.sourceRuleId]), [
      ["10%", null, null, "G-NEW"],
      ["5%", null, null, "G-EXIST"],
    ]);
    assert.deepEqual(result.items.map((i) => i.sourceRuleName), ["New Customer", "Existing Customer"]);
    assert.ok(result.items.every((i) => i.conditions.some((c) => c.conditionType === "CUSTOMER_TYPE")));
    assert.deepEqual(result.items.map((i) => i.customerType), ["NEW", "EXISTING"]);
    assert.ok(result.items.every((i) => i.outcomeKey && i.projected === true));
    assert.notEqual(result.items[0].outcomeKey, result.items[1].outcomeKey);
  });

  it("C. percent OR fixed → two distinct outcomes", async () => {
    const result = await list({
      campaigns: [
        campaign({
          rawPayload: {
            id: "123",
            commission: {
              type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value",
              value: "8% Or USD 20",
            },
          },
        }),
      ],
    });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map((i) => [i.commissionSequence, i.commissionValue, i.currency]), [[1, "8%", null], [2, "20", "USD"]]);
    assert.deepEqual(result.items.map((i) => i.outcomeSlot), [1, 2]);
  });

  it("D. explicit zero is not dropped", async () => {
    const result = await list({
      campaigns: [
        campaign({
          rawPayload: { id: "123", commissionGroups: [{ id: "EX", name: "Excluded Category", commission: "0%", category: "Excluded" }, { id: "STD", name: "Standard", commission: "10%" }] },
        }),
      ],
    });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map((i) => i.commissionValue).sort(), ["0%", "10%"]);
    assert.equal(result.items.find((i) => i.sourceRuleId === "EX").ratePercent, 0);
  });

  it("E. same rate with different conditions stays two rules", async () => {
    const result = await list({
      campaigns: [
        campaign({
          rawPayload: { id: "123", commissionGroups: [{ id: "N", commission: "10%", customer_type: "NEW" }, { id: "E", commission: "10%", customer_type: "EXISTING" }] },
        }),
      ],
    });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map((i) => i.commissionValue), ["10%", "10%"]);
    assert.notEqual(result.items[0].outcomeKey, result.items[1].outcomeKey);
  });

  it("F. canonical precedence: 3 persisted rules and campaign fallback data → exactly 3 canonical rows", async () => {
    const sc = campaign({ id: "sc-A", campaignName: "Alpha", merchantNameRaw: "Alpha", supplierCampaignId: "A1", defaultCommissionValue: "8", commissionUnit: "PERCENT", rawPayload: { id: "A1", commissionGroups: [{ commission: "8%" }] } });
    const rules = ["G1", "G2", "G3"].map((g, i) =>
      canonicalRule({ id: `rule-${g}`, supplierCampaign: sc, sourceGroupId: g, sourceRuleId: g, outcomeKey: `optimise::commission_groups::A1::${g}::base::slot:1::`, ratePercent: 5 + i }),
    );
    const result = await list({ rules, campaigns: [sc] });
    assert.equal(result.total, 3);
    assert.ok(result.items.every((i) => i.projected === false));
    assert.deepEqual(result.items.map((i) => i.commissionSequence), [1, 2, 3]);
    assert.deepEqual(result.items.map((i) => i.displayLabel), ["Commission 1", "Commission 2", "Commission 3"]);
    assert.equal(result.meta.projectedRules, 0);
  });

  it("G. hybrid: campaign A canonical, campaign B projected, campaign C canonical — nobody disappears", async () => {
    const scA = campaign({ id: "sc-A", campaignName: "Alpha", merchantNameRaw: "Alpha", supplierCampaignId: "A1" });
    const scB = campaign({ id: "sc-B", campaignName: "Bravo", merchantNameRaw: "Bravo", supplierCampaignId: "B1", rawPayload: { id: "B1", commissionGroups: [{ id: "B-G1", commission: "10%" }, { id: "B-G2", commission: "5%" }] } });
    const scC = campaign({ id: "sc-C", campaignName: "Charlie", merchantNameRaw: "Charlie", supplierCampaignId: "C1", defaultCommissionValue: "9", commissionUnit: "PERCENT" });
    const rules = [
      ...["G1", "G2", "G3"].map((g) => canonicalRule({ id: `A-${g}`, supplierCampaignId: "sc-A", supplierCampaign: scA, sourceGroupId: g, sourceRuleId: g, outcomeKey: `optimise::commission_groups::A1::${g}::base::slot:1::` })),
      canonicalRule({ id: "C-G1", supplierCampaignId: "sc-C", supplierCampaign: scC, outcomeKey: "optimise::commission_groups::C1::G1::base::slot:1::" }),
    ];
    const result = await list({ rules, campaigns: [scA, scB, scC] }, { take: 50 });
    assert.equal(result.total, 6);
    const byCampaign = (name) => result.items.filter((i) => i.campaignName === name);
    assert.deepEqual(byCampaign("Alpha").map((i) => [i.commissionSequence, i.projected]), [[1, false], [2, false], [3, false]]);
    assert.deepEqual(byCampaign("Bravo").map((i) => [i.commissionSequence, i.projected]), [[1, true], [2, true]]);
    assert.deepEqual(byCampaign("Charlie").map((i) => [i.commissionSequence, i.projected]), [[1, false]]);
    assert.equal(result.meta.canonicalCampaigns, 2);
    assert.equal(result.meta.projectedCampaigns, 1);
  });

  it("H. ambiguous source commission stays projected with REVIEW_REQUIRED / UNMAPPED, never MAPPED", async () => {
    const result = await list({
      campaigns: [
        campaign({ id: "sc-up", campaignName: "UpTo", supplierCampaignId: "U1", rawPayload: { id: "U1", commissionGroups: [{ id: "G", commission: "Up to 10%" }] } }),
        campaign({ id: "sc-bare", campaignName: "Bare", supplierCampaignId: "B2", rawPayload: { id: "B2", commissionGroups: [{ id: "G", value: 7 }] } }),
        campaign({ id: "sc-var", campaignName: "Variable", supplierCampaignId: "V1", rawPayload: { id: "V1", commissionGroups: [{ id: "G", commission: "Depends on category" }] } }),
        campaign({ id: "sc-ok", campaignName: "Clean", supplierCampaignId: "K1", rawPayload: { id: "K1", commissionGroups: [{ id: "G", commission: "10%" }] } }),
      ],
    });
    const byName = (n) => result.items.find((i) => i.campaignName === n);
    assert.equal(byName("UpTo").mappingStatus, "REVIEW_REQUIRED");
    assert.ok(byName("UpTo").reviewReasons.includes("up_to_ceiling_not_exact_rate"));
    assert.equal(byName("Bare").mappingStatus, "REVIEW_REQUIRED");
    assert.ok(byName("Bare").reviewReasons.includes("commission_unit_not_explicit"));
    assert.equal(byName("Variable").mappingStatus, "UNMAPPED");
    assert.equal(byName("Variable").commissionValue, null);
    assert.equal(byName("Variable").projected, true);
    assert.equal(byName("Clean").mappingStatus, "MAPPED");
    assert.ok(result.items.every((i) => i.projected));
  });

  it("I. pagination is deterministic with no duplicates or gaps across canonical + projected rows", async () => {
    const campaigns = [];
    const rules = [];
    for (let n = 0; n < 12; n += 1) {
      const id = `sc-${String(n).padStart(2, "0")}`;
      const base = { id, campaignName: `Camp ${String(n).padStart(2, "0")}`, merchantNameRaw: `Brand ${String(n).padStart(2, "0")}`, supplierCampaignId: `X${n}` };
      const sc = campaign(base);
      if (n % 2 === 0) {
        campaigns.push(campaign({ ...base, rawPayload: { id: `X${n}`, commissionGroups: [{ id: "a", commission: "1%" }, { id: "b", commission: "2%" }, { id: "c", commission: "3%" }] } }));
      } else {
        campaigns.push(sc);
        for (const g of ["G1", "G2"]) rules.push(canonicalRule({ id: `${id}-${g}`, supplierCampaignId: id, supplierCampaign: sc, sourceGroupId: g, sourceRuleId: g, outcomeKey: `optimise::commission_groups::X${n}::${g}::base::slot:1::` }));
      }
    }
    const expectedTotal = 6 * 3 + 6 * 2;
    const seen = [];
    let total = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await list({ rules, campaigns }, { skip: page * 7, take: 7 });
      if (total == null) total = result.total;
      assert.equal(result.total, total, "stable total across pages");
      if (!result.items.length) break;
      seen.push(...result.items.map((i) => i.id));
    }
    assert.equal(total, expectedTotal);
    assert.equal(seen.length, expectedTotal);
    assert.equal(new Set(seen).size, expectedTotal, "no duplicates between pages");
    const again = await list({ rules, campaigns }, { skip: 7, take: 7 });
    assert.deepEqual(again.items.map((i) => i.id), seen.slice(7, 14), "stable deterministic ordering");
  });

  it("J. canonical ratePercent = 0 renders commissionValue 0%", async () => {
    const sc = campaign({ id: "sc-A", supplierCampaignId: "A1" });
    const result = await list({ rules: [canonicalRule({ supplierCampaign: sc, ratePercent: 0 })], campaigns: [] });
    assert.equal(result.items[0].commissionValue, "0%");
    assert.equal(result.items[0].ratePercent, 0);
  });

  it("K. DTO exposes lineage, identity and conditions for canonical rows", async () => {
    const sc = campaign({ id: "sc-A", supplierCampaignId: "A1", countryCodes: ["AE", "SA"], categoryName: "Fashion" });
    const result = await list({
      rules: [canonicalRule({ supplierCampaign: sc, sourceGroupId: "G7", sourceGroupName: "Tiers", sourceRuleId: "G7", sourceRuleName: "Tiers", country: "AE", conditions: [{ id: "c1", conditionType: "COUNTRY", operator: "EQ", value: "AE", sourceConditionType: "country" }] })],
    });
    const [dto] = result.items;
    assert.equal(dto.sourceGroupId, "G7");
    assert.equal(dto.sourceGroupName, "Tiers");
    assert.equal(dto.sourceRuleId, "G7");
    assert.equal(dto.sourceRuleName, "Tiers");
    assert.equal(dto.outcomeKey, "optimise::commission_groups::A1::G1::base::slot:1::");
    assert.equal(dto.outcomeSlot, 1);
    assert.equal(dto.commissionSequence, 1);
    assert.equal(dto.sourceCampaignId, "A1");
    assert.deepEqual(dto.conditions.map((c) => [c.conditionType, c.operator, c.value]), [["COUNTRY", "EQ", "AE"]]);
    assert.equal(dto.country, "AE");
    assert.deepEqual(dto.campaignCountries, ["AE", "SA"]);
    assert.equal(dto.campaignCategory, "Fashion");
    assert.equal(dto.projected, false);
  });

  it("L. rule scope vs campaign context: no COUNTRY condition → rule.country null while campaignCountries is context", async () => {
    const sc = campaign({ id: "sc-A", supplierCampaignId: "A1", countryCodes: ["AE", "SA"], categoryName: "Fashion" });
    const result = await list({ rules: [canonicalRule({ supplierCampaign: sc })], campaigns: [] });
    const [dto] = result.items;
    assert.equal(dto.country, null);
    assert.equal(dto.categoryProductGoal, null);
    assert.deepEqual(dto.campaignCountries, ["AE", "SA"]);
    assert.equal(dto.campaignCategory, "Fashion");
    // direct DTO call: campaign metadata never leaks into rule scope
    const direct = toSupplierCommissionRuleDto({ id: "r", supplier: "OPTIMISE", ratePercent: 5, supplierCampaign: sc });
    assert.equal(direct.country, null);
    assert.equal(direct.categoryProductGoal, null);
  });

  it("search finds brand, supplier campaign id, source rule id, group name, rule country, customer type and value", async () => {
    const scA = campaign({ id: "sc-A", campaignName: "Alpha Store", merchantNameRaw: "Alpha", supplierCampaignId: "A1" });
    const scB = campaign({ id: "sc-B", campaignName: "Bravo", merchantNameRaw: "Bravo", supplierCampaignId: "B77", rawPayload: { id: "B77", commissionGroups: [{ id: "GRP-9", name: "VIP Tier", commission: "12%", customer_type: "VIP", country: "SA" }] } });
    const setup = { rules: [canonicalRule({ supplierCampaign: scA, sourceRuleId: "RULE-XYZ", sourceGroupName: "Season", country: "AE", ratePercent: 10 })], campaigns: [scA, scB] };
    const q = async (term) => (await list(setup, { q: term })).items.map((i) => i.campaignName);
    assert.deepEqual(await q("alpha"), ["Alpha Store"]);
    assert.deepEqual(await q("B77"), ["Bravo"]);
    assert.deepEqual(await q("RULE-XYZ"), ["Alpha Store"]);
    assert.deepEqual(await q("season"), ["Alpha Store"]);
    assert.deepEqual(await q("VIP Tier"), ["Bravo"]);
    assert.deepEqual(await q("SA"), ["Bravo"]);
    assert.deepEqual(await q("VIP"), ["Bravo"]);
    assert.deepEqual(await q("12%"), ["Bravo"]);
    assert.equal((await list(setup, { q: "nothing-here" })).total, 0);
  });

  it("network filter scopes both canonical and projected rows", async () => {
    const scA = campaign({ id: "sc-A", supplier: "OPTIMISE", supplierCampaignId: "A1" });
    const scT = campaign({ id: "sc-T", supplier: "TRACKIER", supplierCampaignId: "T1", defaultCommissionValue: "4", commissionUnit: "PERCENT" });
    const setup = { rules: [canonicalRule({ supplierCampaign: scA })], campaigns: [scA, scT] };
    assert.deepEqual((await list(setup, { network: "trackier" })).items.map((i) => i.networkSource), ["TRACKIER"]);
    assert.equal((await list(setup, { network: "optimise" })).total, 1);
    assert.equal((await list(setup)).total, 2);
  });

  it("historical versions share one display sequence; the current version is listed first", () => {
    const sc = campaign({ id: "sc-A", supplierCampaignId: "A1" });
    const key = "optimise::commission_groups::A1::G1::base::slot:1::";
    const { rows } = assembleSupplierCommissionRows({
      canonicalRules: [
        canonicalRule({ id: "old", supplierCampaign: sc, outcomeKey: key, ratePercent: 10, effectiveFrom: new Date("2026-07-01T00:00:00.000Z"), effectiveUntil: new Date("2026-08-01T00:00:00.000Z") }),
        canonicalRule({ id: "new", supplierCampaign: sc, outcomeKey: key, ratePercent: 12, effectiveFrom: new Date("2026-08-01T00:00:00.000Z") }),
        canonicalRule({ id: "g2", supplierCampaign: sc, outcomeKey: key.replace("G1", "G2"), sourceGroupId: "G2", ratePercent: 5 }),
      ],
    });
    assert.deepEqual(rows.map((r) => [r.id, r.displaySequence]), [["new", 1], ["old", 1], ["g2", 2]]);
  });

  it("projection reuses the ingestion fan-out (same outcome keys as the commission engine)", () => {
    const sc = campaign({ rawPayload: { id: "123", payouts: [{ id: "p1", model: "cps", value: 5 }, { id: "p2", model: "cpa", value: 10, currency: "AED" }] } });
    const rows = projectCampaignCommissionOutcomes(sc);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.projected && r.outcomeKey.startsWith("123::campaigns::commission::")));
    assert.deepEqual(rows.map((r) => [r.sourceRuleId, r.ratePercent, r.fixedAmount, r.currency]), [["p1", 5, null, null], ["p2", null, 10, "AED"]]);
    assert.equal(projectedMappingStatus({ ratePercent: 10, conditions: [{ conditionType: "COMMISSION_TIER" }], rawRuleReference: { commission: "10%" } }).mappingStatus, "REVIEW_REQUIRED");
  });
});
