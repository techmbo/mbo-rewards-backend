import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyCommissionFactWindow,
  listCampaignCommissionFacts,
  parseCommissionText,
  averageCommissionFacts,
  explicitNumber,
  summarizeCommissionFacts,
} from "../src/modules/ops/campaignCommissions.js";
import { buildNetworkCampaignFields } from "../src/modules/ops/importedRecords.service.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");

describe("network ops campaign commissions", () => {
  it("splits Optimise percent-or-currency strings into both commissions", () => {
    assert.deepEqual(
      parseCommissionText("8.20% Or $17.50").map((f) => f.display),
      ["8.2%", "USD 17.5"],
    );
    assert.deepEqual(
      parseCommissionText("Up to 5.40% Or Rp80000.00").map((f) => f.display),
      ["Up to 5.4%", "IDR 80000"],
    );
    assert.deepEqual(
      parseCommissionText("2.50% Or $1.20").map((f) => f.display),
      ["2.5%", "USD 1.2"],
    );
    assert.deepEqual(
      parseCommissionText("0.49% Or S$4.95").map((f) => f.display),
      ["0.49%", "SGD 4.95"],
    );
  });

  it("reads Optimise { type, value } as every percent and currency amount", () => {
    const { facts, display } = listCampaignCommissionFacts({
      raw: {
        commission: {
          type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value",
          value: "8.20% Or $17.50",
        },
      },
      at: NOW,
    });
    assert.equal(display, "8.2% · USD 17.5");
    assert.equal(facts.length, 2);
    assert.equal(facts[0].kind, "PERCENT");
    assert.equal(facts[1].kind, "FIXED");
    assert.equal(JSON.stringify(facts).includes("[object Object]"), false);
  });

  it("expands every Boostiny payout group on one campaign", () => {
    const { facts, display } = listCampaignCommissionFacts({
      groups: [
        {
          model: "cps",
          groups: [
            { id: 74018, type: "sale-share", value: 2.5, priority: 2 },
            { id: 74017, type: "sale-share", value: 5, priority: 1 },
          ],
        },
      ],
      at: NOW,
    });
    assert.ok(display.includes("2.5%"));
    assert.ok(display.includes("5%"));
    assert.equal(facts.length, 2);
  });

  it("expands every Optimise commissionGroup on one campaign", () => {
    const { facts, display } = listCampaignCommissionFacts({
      raw: {
        commissionGroup: {
          0: { commission: "8.20% Or $17.50" },
          1: { commission: "2.50% Or $1.20" },
        },
      },
      at: NOW,
    });
    assert.ok(display.includes("8.2%"));
    assert.ok(display.includes("USD 17.5"));
    assert.ok(display.includes("2.5%"));
    assert.ok(display.includes("USD 1.2"));
    assert.equal(facts.length, 4);
  });

  it("reads a group whose commission field is a nested { type, value } object", () => {
    const { facts, display } = listCampaignCommissionFacts({
      groups: [
        {
          commission: {
            type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value",
            value: "Up to 5.40% Or Rp80000.00",
          },
        },
      ],
      at: NOW,
    });
    assert.equal(display, "Up to 5.4% · IDR 80000");
    assert.equal(facts.length, 2);
  });

  it("unions stored groups with raw payouts instead of stopping at the first bag", () => {
    const { facts } = listCampaignCommissionFacts({
      groups: [{ performance_value: "6.75", performance_model: "percentage" }],
      raw: {
        payouts: [{ model: "cpa", value: 10, currency: "AED" }],
      },
      at: NOW,
    });
    assert.equal(facts.some((f) => f.kind === "PERCENT" && f.value === 6.75), true);
    assert.equal(facts.some((f) => f.kind === "FIXED" && f.value === 10), true);
  });

  it("excludes expired and future commissions from current display and average", () => {
    const result = listCampaignCommissionFacts({
      groups: [
        { value: 10, model: "percentage", effectiveFrom: "2026-01-01", effectiveUntil: "2026-08-01" },
        { value: 20, model: "percentage", effectiveFrom: "2026-08-01" },
        { value: 30, model: "percentage", effectiveFrom: "2026-10-01" },
      ],
      defaultValue: 99,
      commissionUnit: "PERCENT",
      at: NOW,
    });

    assert.deepEqual(result.facts.map((fact) => fact.value), [20]);
    assert.equal(result.display, "20%");
    assert.equal(result.averageDisplay, "20%");
    assert.equal(result.allFacts.length, 3);
    assert.deepEqual(result.excludedFacts.map((fact) => fact.windowStatus).sort(), ["EXPIRED", "FUTURE"]);
  });

  it("does not revive campaign default when every supplier rule is outside the current window", () => {
    const result = listCampaignCommissionFacts({
      groups: [
        { value: 10, model: "percentage", effectiveUntil: "2026-08-01" },
        { value: 30, model: "percentage", effectiveFrom: "2026-10-01" },
      ],
      defaultValue: 99,
      commissionUnit: "PERCENT",
      at: NOW,
    });

    assert.equal(result.facts.length, 0);
    assert.equal(result.display, null);
    assert.equal(result.averageDisplay, null);
    assert.equal(result.allFacts.length, 2);
  });

  it("fails closed on invalid commission windows", () => {
    const result = listCampaignCommissionFacts({
      groups: [{ value: 15, model: "percentage", effectiveFrom: "not-a-date" }],
      at: NOW,
    });

    assert.equal(result.facts.length, 0);
    assert.equal(result.windowReviewRequired, true);
    assert.equal(result.excludedFacts[0].windowStatus, "REVIEW_REQUIRED");
    assert.equal(
      classifyCommissionFactWindow(
        { effectiveFrom: "2026-09-10", effectiveUntil: "2026-09-01" },
        { at: NOW },
      ),
      "REVIEW_REQUIRED",
    );
  });

  it("treats effectiveUntil as an exclusive boundary", () => {
    assert.equal(
      classifyCommissionFactWindow(
        { effectiveFrom: "2026-08-01T00:00:00Z", effectiveUntil: NOW.toISOString() },
        { at: NOW },
      ),
      "EXPIRED",
    );
  });

  it("projects both commissions onto an imported Optimise campaign row", () => {
    const fields = buildNetworkCampaignFields({
      entity: {
        entityType: "campaign",
        networkSource: "optimise_sea",
        rawData: {
          commission: {
            type: "Percentage - Individual Transaction Value Or Fixed Cost - Individual Transaction Value",
            value: "8.20% Or $17.50",
          },
        },
        rawPayloads: [],
        mapperErrors: [],
      },
      supplierCampaign: {
        campaignName: "Zalora",
        commissionUnit: "PERCENT",
        defaultCommissionValue: 8.2,
        campaignSources: [{ id: "cs-1", relationshipStatus: "JOINED", supportsLink: true }],
      },
      campaignSource: { id: "cs-1", relationshipStatus: "JOINED", supportsLink: true },
      merchant: null,
      statuses: { mappingStatus: "MAPPED" },
    });
    assert.equal(fields.commissionFactsDisplay, "8.2% · USD 17.5");
    assert.equal(fields.commissionDisplay, "Up to 8.2% · 2 rules");
    assert.equal(fields.commissionAverageDisplay, "MIXED");
    assert.equal(fields.commissions.length, 2);
    assert.equal(typeof fields.commissionDisplay, "string");
  });

  it("averages only comparable commission facts", () => {
    assert.equal(
      averageCommissionFacts([
        { kind: "PERCENT", value: 0.85, display: "0.85%" },
        { kind: "PERCENT", value: 4.25, display: "4.25%" },
      ]),
      "2.55%",
    );
    assert.equal(
      averageCommissionFacts([
        { kind: "PERCENT", value: 0.49, display: "0.49%" },
        { kind: "FIXED", value: 4.95, currency: "SGD", display: "SGD 4.95" },
      ]),
      "MIXED",
    );
    assert.equal(
      averageCommissionFacts([
        { kind: "PERCENT", value: 5.6, display: "5.6%" },
        { kind: "PERCENT", value: 5.6, display: "5.6%" },
      ]),
      "5.6%",
    );
  });

  describe("explicit zero commission is a real fact, blank is missing", () => {
    it("explicitNumber keeps explicit zero and rejects blank or malformed input", () => {
      assert.equal(explicitNumber(0), 0);
      assert.equal(explicitNumber("0"), 0);
      assert.equal(explicitNumber("0.0"), 0);
      assert.equal(explicitNumber("0.00"), 0);
      assert.equal(explicitNumber(12.5), 12.5);
      assert.equal(explicitNumber(null), null);
      assert.equal(explicitNumber(undefined), null);
      assert.equal(explicitNumber(""), null);
      assert.equal(explicitNumber("   "), null);
      assert.equal(explicitNumber("abc"), null);
      assert.equal(explicitNumber("n/a"), null);
      assert.equal(explicitNumber(true), null);
      assert.equal(explicitNumber(NaN), null);
      assert.equal(explicitNumber({}), null);
    });

    it("parses 0% as a valid zero percentage commission fact", () => {
      const facts = parseCommissionText("0%");
      assert.equal(facts.length, 1);
      assert.equal(facts[0].kind, "PERCENT");
      assert.equal(facts[0].value, 0);
      assert.equal(facts[0].display, "0%");
      assert.deepEqual(
        parseCommissionText("0% Or $17.50").map((f) => [f.kind, f.value]),
        [["PERCENT", 0], ["FIXED", 17.5]],
      );
    });

    it("parses an explicit fixed zero with currency as a valid fixed commission fact", () => {
      const facts = parseCommissionText("USD 0");
      assert.equal(facts.length, 1);
      assert.equal(facts[0].kind, "FIXED");
      assert.equal(facts[0].value, 0);
      assert.equal(facts[0].currency, "USD");
      assert.equal(facts[0].display, "USD 0");
    });

    it("does not create commission facts from blank or missing text", () => {
      assert.deepEqual(parseCommissionText(null), []);
      assert.deepEqual(parseCommissionText(undefined), []);
      assert.deepEqual(parseCommissionText(""), []);
      assert.deepEqual(parseCommissionText("   "), []);
      assert.deepEqual(parseCommissionText("see terms"), []);
    });

    for (const input of [0, "0", "0.0", "0%"]) {
      it(`keeps structured zero percentage input ${JSON.stringify(input)} where context is percentage`, () => {
        const { facts, display } = listCampaignCommissionFacts({
          groups: [{ value: input, model: "percentage" }],
          commissionUnit: "PERCENT",
          at: NOW,
        });
        assert.equal(facts.length, 1);
        assert.equal(facts[0].kind, "PERCENT");
        assert.equal(facts[0].value, 0);
        assert.equal(facts[0].basis, "PERCENT_OF_SALE");
        assert.equal(display, "0%");
      });
    }

    it("keeps a structured fixed zero payout with currency and basis", () => {
      const { facts } = listCampaignCommissionFacts({
        groups: [{ model: "cpa", value: 0, currency: "USD" }],
        at: NOW,
      });
      assert.equal(facts.length, 1);
      assert.equal(facts[0].kind, "FIXED");
      assert.equal(facts[0].value, 0);
      assert.equal(facts[0].currency, "USD");
      assert.equal(facts[0].basis, "CPA");
      assert.equal(facts[0].display, "USD 0");
    });

    it("keeps supplied zero on explicit rate / percentage / amount / fixed fields", () => {
      const percentKeyed = listCampaignCommissionFacts({
        groups: [{ percentage: 0, category: "Excluded" }],
        at: NOW,
      });
      assert.deepEqual(percentKeyed.facts.map((f) => [f.kind, f.value]), [["PERCENT", 0]]);

      const rateKeyed = listCampaignCommissionFacts({
        groups: [{ rate: "0", model: "revshare" }],
        at: NOW,
      });
      assert.deepEqual(rateKeyed.facts.map((f) => [f.kind, f.value]), [["PERCENT", 0]]);

      const fixedKeyed = listCampaignCommissionFacts({
        groups: [{ fixed_amount: 0, currency: "AED" }],
        at: NOW,
      });
      assert.deepEqual(fixedKeyed.facts.map((f) => [f.kind, f.value, f.currency]), [["FIXED", 0, "AED"]]);

      const amountKeyed = listCampaignCommissionFacts({
        groups: [{ amount: 0, model: "cpa", currency: "USD" }],
        at: NOW,
      });
      assert.deepEqual(amountKeyed.facts.map((f) => [f.kind, f.value]), [["FIXED", 0]]);
    });

    it("keeps a specific zero rule next to the campaign default instead of discarding it", () => {
      const { facts } = listCampaignCommissionFacts({
        groups: [
          { id: "default", value: 10, model: "percentage" },
          { id: "category-x", value: 0, model: "percentage", category: "X" },
        ],
        at: NOW,
      });
      assert.deepEqual(facts.map((f) => f.value).sort(), [0, 10]);
    });

    for (const input of [null, undefined, "", "   "]) {
      it(`does not create a commission fact for missing structured input ${JSON.stringify(input)}`, () => {
        const result = listCampaignCommissionFacts({
          groups: [{ value: input, model: "percentage" }],
          commissionUnit: "PERCENT",
          at: NOW,
        });
        assert.equal(result.facts.length, 0);
        assert.equal(result.display, null);
        assert.equal(result.averageDisplay, null);
      });
    }

    it("does not convert malformed non-numeric input into zero", () => {
      const result = listCampaignCommissionFacts({
        groups: [
          { value: "n/a", model: "percentage" },
          { value: "abc", model: "cpa", currency: "USD" },
          { value: true, model: "percentage" },
          { value: {}, model: "percentage" },
        ],
        commissionUnit: "PERCENT",
        at: NOW,
      });
      assert.equal(result.facts.length, 0);
      assert.equal(result.display, null);
    });

    it("does not treat a blank campaign default as a zero commission", () => {
      for (const defaultValue of [null, undefined, "", "   "]) {
        const result = listCampaignCommissionFacts({
          defaultValue,
          commissionUnit: "PERCENT",
          at: NOW,
        });
        assert.equal(result.facts.length, 0, `defaultValue=${JSON.stringify(defaultValue)}`);
      }
    });

    it("keeps an explicit zero campaign default when the supplier supplied it", () => {
      const result = listCampaignCommissionFacts({ defaultValue: 0, commissionUnit: "PERCENT", at: NOW });
      assert.deepEqual(result.facts.map((f) => [f.kind, f.value]), [["PERCENT", 0]]);
    });

    it("includes explicit zero in Avg / Min / Max percentage summaries", () => {
      const facts = [
        { kind: "PERCENT", value: 0, display: "0%" },
        { kind: "PERCENT", value: 10, display: "10%" },
      ];
      assert.equal(averageCommissionFacts(facts), "5%");
      const summary = summarizeCommissionFacts(facts);
      assert.equal(summary.kind, "PERCENT");
      assert.equal(summary.average, 5);
      assert.equal(summary.min, 0);
      assert.equal(summary.max, 10);
      assert.equal(summary.averageDisplay, "5%");
      assert.equal(summary.minDisplay, "0%");
      assert.equal(summary.maxDisplay, "10%");
    });

    it("includes explicit zero in Avg / Min / Max for compatible fixed facts", () => {
      const facts = [
        { kind: "FIXED", value: 0, currency: "USD", basis: "FIXED_PER_ORDER", display: "USD 0" },
        { kind: "FIXED", value: 10, currency: "USD", basis: "FIXED_PER_ORDER", display: "USD 10" },
      ];
      assert.equal(averageCommissionFacts(facts), "USD 5");
      const summary = summarizeCommissionFacts(facts);
      assert.equal(summary.kind, "FIXED");
      assert.equal(summary.average, 5);
      assert.equal(summary.min, 0);
      assert.equal(summary.max, 10);
      assert.equal(summary.averageDisplay, "USD 5");
      assert.equal(summary.minDisplay, "USD 0");
      assert.equal(summary.maxDisplay, "USD 10");
      assert.equal(summary.basis, "FIXED_PER_ORDER");
    });

    it("summarizes a single zero fact as 0 rather than nothing", () => {
      assert.equal(averageCommissionFacts([{ kind: "PERCENT", value: 0, display: "0%" }]), "0%");
    });

    it("keeps MIXED behaviour unchanged when zero facts are involved", () => {
      assert.equal(
        averageCommissionFacts([
          { kind: "PERCENT", value: 0, display: "0%" },
          { kind: "FIXED", value: 10, currency: "USD", display: "USD 10" },
        ]),
        "MIXED",
      );
      assert.equal(
        averageCommissionFacts([
          { kind: "FIXED", value: 0, currency: "USD", basis: "CPA", display: "USD 0" },
          { kind: "FIXED", value: 10, currency: "EUR", basis: "CPA", display: "EUR 10" },
        ]),
        "MIXED",
      );
      assert.equal(
        averageCommissionFacts([
          { kind: "FIXED", value: 0, currency: "USD", basis: "CPA", display: "USD 0" },
          { kind: "FIXED", value: 10, currency: "USD", basis: "FIXED_PER_ITEM", display: "USD 10" },
        ]),
        "MIXED",
      );
      assert.equal(summarizeCommissionFacts([]).averageDisplay, null);
      assert.equal(averageCommissionFacts([{ kind: "PERCENT", value: "", display: "" }]), null);
    });
  });
});
