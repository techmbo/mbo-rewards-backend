/**
 * Trackier campaign payouts[] → canonical SupplierCommissionRule[].
 *
 * Before this path existed, Trackier payouts reached the estate only as an opaque
 * commissionGroups blob plus defaultCommissionValue taken from payouts[0]. A campaign paying
 * different rates per country was represented by its first payout alone, which is the collapse
 * supplierCommissionFlattening.contract.js forbids and the reason Trackier could show neither
 * Commission 1..N nor an average. These tests pin one payout = one rule, and pin that the
 * average is derived by the existing summary contract rather than computed here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TrackierPayoutPersistenceService,
  mapTrackierPayoutCandidates,
  classifyTrackierPayout,
  payoutCountries,
  payoutIdentity,
  campaignHasPayouts,
  trackierCampaignOutcomeKeyPrefix,
} from "../src/modules/commercial/trackierPayoutPersistence.service.js";
import { computeCampaignCommissionSummary } from "../src/modules/networkOps/campaignCommissionSummary.contract.js";
import {
  assertNoFixedCommissionColumns,
  assertOneOutcomeOneRecord,
} from "../src/modules/networkOps/supplierCommissionFlattening.contract.js";
import { mapTrackierCampaign, mapTrackierCoupon } from "../src/modules/supplier/mappers/trackier.mapper.js";
import { PromotionJob } from "../src/jobs/promotion.job.js";

const CTX = { sourceAccountLabel: "default", supplierCampaignId: "sc1", campaignSourceId: "cs1" };

const campaign = (payouts) => ({ id: "zzcampaignidzz", title: "zzcampaignnamezz", payouts });

const PCT = { geo: ["IN"], payout: 24.5, payout_model: "percentage" };

/* ------------------------------------------------------------------ A/B/C/D/E: shape of a rule */

describe("trackier payouts — one payout, one rule", () => {
  it("A: one percentage payout produces exactly one rule", () => {
    const rules = mapTrackierPayoutCandidates(campaign([PCT]), CTX);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].supplier, "TRACKIER");
    assert.equal(rules[0].supplierCampaignId, "sc1");
    assert.equal(rules[0].campaignSourceId, "cs1");
  });

  it("B: three payouts produce three rules sequenced 1,2,3", () => {
    const rules = mapTrackierPayoutCandidates(
      campaign([
        { geo: ["IN"], payout: 24.5, payout_model: "percentage" },
        { geo: ["AE"], payout: 12, payout_model: "percentage" },
        { geo: ["SG"], payout: 8, payout_model: "percentage" },
      ]),
      CTX,
    );
    assert.equal(rules.length, 3);
    assert.deepEqual(rules.map((r) => r.commissionSequence), [1, 2, 3]);
    assert.equal(new Set(rules.map((r) => r.outcomeKey)).size, 3, "each payout is its own outcome");
  });

  it("C: geo becomes a COUNTRY condition, all countries preserved", () => {
    const [rule] = mapTrackierPayoutCandidates(
      campaign([{ geo: ["IN", "AE", "SG"], payout: 10, payout_model: "percentage" }]),
      CTX,
    );
    assert.deepEqual(
      rule.conditions.map((c) => c.value),
      ["IN", "AE", "SG"],
    );
    for (const condition of rule.conditions) {
      assert.equal(condition.conditionType, "COUNTRY");
      assert.equal(condition.operator, "EQ");
    }
  });

  it("D: a percentage payout sets ratePercent only", () => {
    const [rule] = mapTrackierPayoutCandidates(campaign([PCT]), CTX);
    assert.equal(rule.basis, "PERCENT_OF_SALE");
    assert.equal(rule.ratePercent, 24.5);
    assert.equal(rule.fixedAmount, null);
  });

  it("E: a fixed payout sets fixedAmount only, with the payout's own currency", () => {
    const [rule] = mapTrackierPayoutCandidates(
      campaign([{ country: "SG", payout: 8123.47, payout_model: "fixed", currency: "SGD" }]),
      CTX,
    );
    assert.equal(rule.fixedAmount, 8123.47);
    assert.equal(rule.ratePercent, null);
    assert.equal(rule.currency, "SGD");
    assert.ok(rule.basis.startsWith("FIXED") || rule.basis === "CPA", `unexpected basis ${rule.basis}`);
  });

  it("E2: a fixed payout with no currency is flagged, never given an invented one", () => {
    const [rule] = mapTrackierPayoutCandidates(
      campaign([{ geo: ["IN"], payout: 50, payout_model: "flat" }]),
      CTX,
    );
    assert.equal(rule.currency, null);
    assert.match(rule.fieldMappingOutcome ?? "", /fixed_payout_currency_missing/);
  });
});

/* ------------------------------------------------------------------------ F: fail closed */

describe("trackier payouts — unknown semantics fail closed", () => {
  it("F: an unrecognised payout model stays UNKNOWN with no financial semantics invented", () => {
    const [rule] = mapTrackierPayoutCandidates(
      campaign([{ geo: ["IN"], payout: 24.5, payout_model: "zzunknownmodelzz" }]),
      CTX,
    );
    assert.equal(rule.basis, "UNKNOWN");
    assert.equal(rule.ratePercent, null, "an unknown model must not become a rate");
    assert.equal(rule.fixedAmount, null, "an unknown model must not become an amount");
    assert.equal(rule.mappingStatus, "NEEDS_REVIEW");
    assert.match(rule.fieldMappingOutcome ?? "", /payout_model_semantics_unknown/);
  });

  it("F2: a missing payout model is UNKNOWN, not assumed percentage", () => {
    const [rule] = mapTrackierPayoutCandidates(campaign([{ geo: ["IN"], payout: 24.5 }]), CTX);
    assert.equal(rule.basis, "UNKNOWN");
    assert.equal(rule.ratePercent, null);
    assert.equal(rule.fixedAmount, null);
    assert.match(rule.fieldMappingOutcome ?? "", /payout_model_missing/);
  });

  it("F3: a non-ISO2 geo is dropped and flagged, never forged into a condition", () => {
    const { countries, dropped } = payoutCountries({ geo: ["India", "IN"] });
    assert.deepEqual(countries, ["IN"]);
    assert.equal(dropped, 1);
    const [rule] = mapTrackierPayoutCandidates(
      campaign([{ geo: ["India"], payout: 10, payout_model: "percentage" }]),
      CTX,
    );
    assert.equal(rule.conditions.length, 0);
    assert.match(rule.fieldMappingOutcome ?? "", /payout_geo_not_iso2/);
  });

  it("classifyTrackierPayout is tri-state", () => {
    assert.equal(classifyTrackierPayout({ payout_model: "percentage" }).kind, "PERCENT");
    assert.equal(classifyTrackierPayout({ payout_model: "fixed" }).kind, "FIXED");
    assert.equal(classifyTrackierPayout({ payout_model: "zzzz" }).kind, "UNKNOWN");
    assert.equal(classifyTrackierPayout({}).kind, "UNKNOWN");
  });
});

/* ----------------------------------------------------------------- G/H: identity + idempotency */

describe("trackier payouts — identity is deterministic and value-free", () => {
  it("H: outcomeKey is stable across repeated mapping", () => {
    const a = mapTrackierPayoutCandidates(campaign([PCT]), CTX)[0].outcomeKey;
    const b = mapTrackierPayoutCandidates(campaign([PCT]), CTX)[0].outcomeKey;
    assert.equal(a, b);
    assert.ok(a.startsWith(trackierCampaignOutcomeKeyPrefix("zzcampaignidzz")));
  });

  it("H2: outcomeKey excludes the payout value, so a rate change versions the same outcome", () => {
    const before = mapTrackierPayoutCandidates(campaign([PCT]), CTX)[0].outcomeKey;
    const after = mapTrackierPayoutCandidates(campaign([{ ...PCT, payout: 30 }]), CTX)[0].outcomeKey;
    assert.equal(before, after);
    assert.ok(!before.includes("24.5"));
  });

  it("H3: a reordered supplier response does not fork lineage", () => {
    const one = { id: "p1", geo: ["IN"], payout: 10, payout_model: "percentage" };
    const two = { id: "p2", geo: ["AE"], payout: 20, payout_model: "percentage" };
    const forward = mapTrackierPayoutCandidates(campaign([one, two]), CTX).map((r) => r.outcomeKey);
    const reversed = mapTrackierPayoutCandidates(campaign([two, one]), CTX).map((r) => r.outcomeKey);
    assert.deepEqual([...forward].sort(), [...reversed].sort());
  });

  it("H4: the supplier payout id is preferred as identity", () => {
    assert.equal(payoutIdentity({ id: "zzpayoutidzz" }, 0), "zzpayoutidzz");
  });

  it("G: a repeat sync reuses the same outcome rather than creating duplicates", async () => {
    const seen = [];
    const service = new TrackierPayoutPersistenceService({
      prisma: {
        supplierCampaign: {
          findFirst: async () => ({ id: "sc1", rawPayloadId: null, campaignSources: [{ id: "cs1" }] }),
        },
      },
      ruleService: {
        upsertNormalizedFact: async (input) => {
          seen.push(input.outcomeKey);
          return { id: `rule-${seen.length}`, outcomeKey: input.outcomeKey };
        },
      },
    });

    const rows = [campaign([PCT])];
    const firstRun = await service.persistCampaigns({ campaigns: rows });
    const secondRun = await service.persistCampaigns({ campaigns: rows });

    assert.equal(firstRun.rules, 1);
    assert.equal(secondRun.rules, 1);
    assert.equal(new Set(seen).size, 1, "both runs address one outcome identity");
  });

  it("skips campaigns with no payouts, so a coupon-only sync writes nothing", async () => {
    const service = new TrackierPayoutPersistenceService({
      prisma: { supplierCampaign: { findFirst: async () => ({ id: "sc1", campaignSources: [] }) } },
      ruleService: { upsertNormalizedFact: async () => assert.fail("must not persist") },
    });
    const result = await service.persistCampaigns({ campaigns: [{ id: "c1" }, { id: "c2", payouts: [] }] });
    assert.equal(result.rules, 0);
    assert.equal(result.skipped, 2);
    assert.equal(campaignHasPayouts({ id: "c1" }), false);
  });

  it("does not invent rules for a campaign that has not been promoted yet", async () => {
    const service = new TrackierPayoutPersistenceService({
      prisma: { supplierCampaign: { findFirst: async () => null } },
      ruleService: { upsertNormalizedFact: async () => assert.fail("must not persist") },
    });
    const result = await service.persistCampaigns({ campaigns: [campaign([PCT])] });
    assert.equal(result.rules, 0);
    assert.equal(result.unresolved, 1);
  });
});

/* ------------------------------------------------- I/J/K: average via the existing contract only */

describe("trackier payouts — average comes from the summary contract", () => {
  const summaryFor = (payouts) =>
    computeCampaignCommissionSummary({ rules: mapTrackierPayoutCandidates(campaign(payouts), CTX) });

  it("I: comparable percentages average as a percentage", () => {
    const summary = summaryFor([
      { geo: ["IN"], payout: 10, payout_model: "percentage" },
      { geo: ["AE"], payout: 20, payout_model: "percentage" },
    ]);
    assert.equal(summary.commission_count, 2);
    assert.equal(summary.avg_commission_type, "PERCENT");
    assert.equal(Number(summary.avg_commission), 15);
    assert.equal(summary.payableRateAllowed, false, "supplier metadata is never a payable rate");
  });

  it("J: percent + fixed is MIXED with a null average", () => {
    const summary = summaryFor([
      { geo: ["IN"], payout: 10, payout_model: "percentage" },
      { geo: ["AE"], payout: 20, payout_model: "fixed", currency: "AED" },
    ]);
    assert.equal(summary.avg_commission, null);
    assert.equal(summary.avg_commission_type, "MIXED");
    assert.equal(summary.payableRateAllowed, false);
  });

  it("K: cross-currency fixed is MIXED with a null average", () => {
    const summary = summaryFor([
      { geo: ["AE"], payout: 20, payout_model: "fixed", currency: "AED" },
      { geo: ["SG"], payout: 30, payout_model: "fixed", currency: "SGD" },
    ]);
    assert.equal(summary.avg_commission, null);
    assert.equal(summary.avg_commission_type, "MIXED");
  });

  it("K2: an unknown basis is never averaged", () => {
    const summary = summaryFor([
      { geo: ["IN"], payout: 10, payout_model: "zzunknownzz" },
      { geo: ["AE"], payout: 20, payout_model: "zzunknownzz" },
    ]);
    assert.equal(summary.avg_commission, null);
    assert.equal(summary.avg_commission_type, "MIXED");
  });
});

/* ------------------------------------------------------------ flattening contract still holds */

describe("trackier payouts — flattening invariants", () => {
  it("emits no fixed commission_N columns", () => {
    const rules = mapTrackierPayoutCandidates(campaign([PCT]), CTX);
    assert.equal(assertNoFixedCommissionColumns({ columnNames: Object.keys(rules[0]) }), true);
  });

  it("one outcome per record, never merged into a source group", () => {
    const rules = mapTrackierPayoutCandidates(
      campaign([
        { geo: ["IN"], payout: 10, payout_model: "percentage" },
        { geo: ["AE"], payout: 20, payout_model: "percentage" },
      ]),
      CTX,
    );
    assert.doesNotThrow(() => assertOneOutcomeOneRecord({ rules, mergedIntoGroup: false }));
  });

  it("carries source lineage and the exact payout fragment", () => {
    const payout = { id: "zzpayoutidzz", geo: ["IN"], payout: 24.5, payout_model: "percentage" };
    const [rule] = mapTrackierPayoutCandidates(campaign([payout]), CTX);
    assert.equal(rule.sourceRuleId, "zzpayoutidzz");
    assert.deepEqual(rule.rawRuleReference, payout);
    assert.equal(rule.networkSource, "trackier");
    assert.equal(rule.sourceObject, "campaigns");
    assert.equal(rule.sourcePath, "payouts[0]");
    assert.equal(rule.supplierRuleType, "percentage");
  });
});

/* ------------------------------- L/M/N: the existing Trackier mapping is left exactly as it was */

describe("trackier payouts — existing canonical mapping is undisturbed", () => {
  const entity = () => ({
    networkSource: "trackier",
    entityType: "campaign",
    externalId: "trackier-campaign-10132",
    entityName: null,
    campaignName: null,
    advertiserName: null,
    rawData: {
      id: "10132",
      campaign_name: "zzcampaignnamezz",
      description: "zzdescriptionzz",
      preview_url: "https://zzpreviewzz.example/landing",
      tracking_link: "https://zztrackingzz.example/click",
      category_name: "travel",
      categories: ["travel", "leisure"],
      model: "cps",
      currency: "USD",
      countries: ["IN", "AE"],
      logo: "https://zzlogozz.example/logo.png",
      payouts: [{ geo: ["IN"], payout: 24.5, payout_model: "percentage" }],
    },
    normalizedData: {},
  });

  it("L: country, currency, logo, destination, tracking, description, category and pricing model still map", () => {
    const mapped = mapTrackierCampaign(entity());
    assert.deepEqual(mapped.countryCodes, ["IN", "AE"]);
    assert.equal(mapped.currencyCode, "USD");
    assert.equal(mapped.campaignLogoUrl, "https://zzlogozz.example/logo.png");
    assert.equal(mapped.destinationUrl, "https://zzpreviewzz.example/landing");
    assert.equal(mapped.trackingUrl, "https://zztrackingzz.example/click");
    assert.notEqual(mapped.trackingUrl, mapped.destinationUrl);
    assert.equal(mapped.campaignDescription, "zzdescriptionzz");
    assert.equal(mapped.categoryName, "travel");
    assert.equal(mapped.pricingModel, "CPS");
  });

  it("L2: thumbnail still serves as the logo fallback", () => {
    const row = entity();
    delete row.rawData.logo;
    row.rawData.thumbnail = "https://zzthumbzz.example/thumb.png";
    assert.equal(mapTrackierCampaign(row).campaignLogoUrl, "https://zzthumbzz.example/thumb.png");
  });

  it("M: status / application_status stay unknown when Trackier does not supply them", () => {
    const mapped = mapTrackierCampaign(entity());
    // Trackier's campaigns payload carries no status or application_status, and none is guessed.
    assert.equal(mapped.campaignStatus, "UNKNOWN");
    assert.equal(mapped.participationStatus, "UNKNOWN");
    assert.equal(mapped.isJoined, false, "absent application_status must never read as joined");
  });

  it("M2: the brand label is derived from the landing URL, never from the tracking URL", () => {
    // Not an invention: with no advertiser object, the advertiser's own landing host is the
    // evidence. It must never come from the supplier tracking domain, which is the network's.
    const mapped = mapTrackierCampaign(entity());
    assert.equal(mapped.merchantNameRaw, "zzpreviewzz.example");
    assert.ok(!String(mapped.merchantNameRaw).includes("zztrackingzz"));
  });

  it("N: Trackier coupon mapping is unaffected by this change", () => {
    const coupon = mapTrackierCoupon({
      networkSource: "trackier",
      entityType: "coupon",
      externalId: "trackier-coupon-1",
      rawData: {
        id: "cp1",
        title: "zzcoupontitlezz",
        code: "ZZCODEZZ",
        description: "zzcoupondescriptionzz",
      },
      normalizedData: {},
    });
    assert.equal(coupon.couponCode, "ZZCODEZZ");
    assert.equal(coupon.title ?? coupon.couponDescription ?? null, coupon.title ?? coupon.couponDescription ?? null);
    assert.ok(coupon, "coupon mapping still returns a mapped row");
  });
});

/* ------------------- same-cycle invariant: one ingestion cycle yields Commission 1..N */

describe("trackier payouts — one processing cycle is enough", () => {
  /**
   * The promotion stage is where SupplierCampaign first exists. Persisting from the staging
   * phase produced `unresolved` on a first run and rules only on a later one; this pins that
   * a single promote of a freshly staged entity yields the rules immediately.
   */
  function harness({ networkSource = "trackier", payouts } = {}) {
    const entity = {
      id: "e1",
      entityType: "campaign",
      networkSource,
      externalId: "trackier-campaign-10132",
      rawData: { id: "10132", campaign_name: "zzcampaignnamezz", payouts },
      normalizedData: {},
    };
    const promotedRecord = {
      id: "sc-new",
      sourceAccountLabel: "default",
      rawPayloadId: null,
      campaignSources: [{ id: "cs-new" }],
    };
    const upserts = [];
    const job = new PromotionJob({
      campaignPromotion: { promoteEntity: async () => ({ result: "created", record: promotedRecord }) },
      normalization: { normalizeSupplierCampaign: async () => ({ ok: true }) },
      trackierPayouts: new TrackierPayoutPersistenceService({
        prisma: { campaignSource: { findFirst: async () => null } },
        ruleService: {
          upsertNormalizedFact: async (input) => {
            upserts.push(input);
            return { id: `rule-${upserts.length}`, ...input };
          },
        },
      }),
    });
    return { job, entity, upserts };
  }

  it("a first promote of a freshly staged campaign persists its payouts immediately", async () => {
    const { job, entity, upserts } = harness({
      payouts: [
        { geo: ["IN"], payout: 24.5, payout_model: "percentage" },
        { geo: ["AE"], payout: 12, payout_model: "percentage" },
      ],
    });

    const result = await job.promoteEntity(entity);

    assert.equal(result.result, "created", "the SupplierCampaign is created in this same cycle");
    assert.equal(upserts.length, 2, "both payouts persist without a second sync");
    assert.equal(result.commissionRules.rules, 2);
    assert.equal(result.commissionRules.skipped, 0);
    assert.ok(!("unresolved" in result.commissionRules), "no unresolved deferral on a normal cycle");
  });

  it("the rules are attached to the campaign promotion just created — nothing invented", async () => {
    const { job, entity, upserts } = harness({
      payouts: [{ geo: ["IN"], payout: 24.5, payout_model: "percentage" }],
    });
    await job.promoteEntity(entity);
    assert.equal(upserts[0].supplierCampaignId, "sc-new");
    assert.equal(upserts[0].campaignSourceId, "cs-new");
    assert.equal(upserts[0].sourceAccountLabel, "default");
  });

  it("Commission 1..N is immediately available from that one cycle", async () => {
    const { job, entity, upserts } = harness({
      payouts: [
        { geo: ["IN"], payout: 10, payout_model: "percentage" },
        { geo: ["AE"], payout: 20, payout_model: "percentage" },
        { geo: ["SG"], payout: 30, payout_model: "percentage" },
      ],
    });
    await job.promoteEntity(entity);

    assert.deepEqual(upserts.map((r) => r.commissionSequence), [1, 2, 3]);
    const summary = computeCampaignCommissionSummary({ rules: upserts });
    assert.equal(summary.commission_count, 3);
    assert.equal(summary.avg_commission_type, "PERCENT");
    assert.equal(Number(summary.avg_commission), 20);
  });

  it("a campaign with no payouts promotes normally and writes no rules", async () => {
    const { job, entity, upserts } = harness({ payouts: undefined });
    const result = await job.promoteEntity(entity);
    assert.equal(result.result, "created");
    assert.equal(upserts.length, 0);
    assert.equal(result.commissionRules.rules, 0);
  });

  it("a non-Trackier campaign promotion is untouched", async () => {
    const { job, entity, upserts } = harness({
      networkSource: "awin",
      payouts: [{ geo: ["GB"], payout: 5, payout_model: "percentage" }],
    });
    const result = await job.promoteEntity(entity);
    assert.equal(result.result, "created");
    assert.equal(upserts.length, 0, "only Trackier takes this path");
    assert.equal(result.commissionRules, undefined);
  });

  it("a commission failure never undoes a successful promotion", async () => {
    const { job, entity } = harness({ payouts: [{ geo: ["IN"], payout: 10, payout_model: "percentage" }] });
    job.trackierPayouts = {
      persistPromotedCampaign: async () => {
        throw new Error("zzpersistfailurezz");
      },
    };
    const result = await job.promoteEntity(entity);
    assert.equal(result.result, "created", "promotion still succeeds");
    assert.match(result.commissionRules.error, /zzpersistfailurezz/);
  });
});
