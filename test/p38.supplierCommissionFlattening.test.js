/**
 * Pointer 38 — Supplier commission flattening and Commission 1...N display.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  NETWORK_SOURCE_GROUP_LABELS,
  POINTER_38_EXAMPLE_RULES,
  SUPPLIER_COMMISSION_FLATTENING_SUMMARY,
  applySupplierCommissionFlatteningContract,
  assertLineageMetadataPreserved,
  assertNoFixedCommissionColumns,
  assertOneOutcomeOneRecord,
  assignCommissionDisplaySequence,
  buildSupplierCommissionFlatteningGuide,
  formatCommissionDisplayLabel,
} from "../src/modules/networkOps/supplierCommissionFlattening.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 38 — supplierCommissionFlattening.contract", () => {
  it("declares contract pointer 38 and flattening rules", () => {
    assert.equal(CONTRACT_POINTER, 38);
    assert.match(SUPPLIER_COMMISSION_FLATTENING_SUMMARY.noHiddenRates, /Commission Group, Payout Group/);
    assert.match(SUPPLIER_COMMISSION_FLATTENING_SUMMARY.canonicalIdentifier, /mbo_commission_rule_id/i);
    assert.match(SUPPLIER_COMMISSION_FLATTENING_SUMMARY.oneOutcomeOneRecord, /one SupplierCommissionRule record/i);
    assert.ok(NETWORK_SOURCE_GROUP_LABELS.includes("Tariff"));
    assert.ok(NETWORK_SOURCE_GROUP_LABELS.includes("Action Term"));
  });

  it("assertNoFixedCommissionColumns rejects commission_1 style columns", () => {
    assert.doesNotThrow(() => assertNoFixedCommissionColumns({ columnNames: ["commissionDisplay", "ruleCount"] }));
    assert.throws(
      () => assertNoFixedCommissionColumns({ schemaFields: ["commission_1", "commission_2"] }),
      (err) => {
        assert.equal(err.code, "FIXED_COMMISSION_COLUMNS_FORBIDDEN");
        return true;
      },
    );
  });

  it("assertOneOutcomeOneRecord rejects hidden group merge and duplicate outcomes", () => {
    assert.doesNotThrow(() => assertOneOutcomeOneRecord({ rules: POINTER_38_EXAMPLE_RULES }));
    assert.throws(
      () => assertOneOutcomeOneRecord({ rules: [], mergedIntoGroup: true }),
      (err) => {
        assert.equal(err.code, "RATES_HIDDEN_IN_SOURCE_GROUP");
        return true;
      },
    );
    assert.throws(
      () =>
        assertOneOutcomeOneRecord({
          rules: [
            { ratePercent: 12, categoryProductGoal: "Shoes", country: "IN", customerType: "New" },
            { ratePercent: 12, categoryProductGoal: "Shoes", country: "IN", customerType: "New" },
          ],
        }),
      (err) => {
        assert.equal(err.code, "DUPLICATE_PAYABLE_OUTCOME");
        return true;
      },
    );
  });

  it("assignCommissionDisplaySequence assigns Commission 1...N with mbo_commission_rule_id", () => {
    const sequenced = assignCommissionDisplaySequence(
      POINTER_38_EXAMPLE_RULES.map((rule, index) => ({
        ...rule,
        id: `scr-${index + 1}`,
      })),
    );
    assert.equal(sequenced.length, 3);
    assert.equal(sequenced[0].displayLabel, "Commission 1");
    assert.equal(sequenced[2].displayLabel, "Commission 3");
    assert.equal(sequenced[0].mbo_commission_rule_id, "scr-1");
    assert.equal(sequenced[0].groupedPresentationRequired, false);
    assert.match(sequenced[0].displayLine, /Commission 1 = 12%/);
    assert.match(sequenced[0].displayLine, /Category Shoes/);
    assert.match(sequenced[1].displayLine, /Commission 2 = 8%/);
    assert.match(sequenced[2].displayLine, /Commission 3 = 6%/);
  });

  it("formatCommissionDisplayLabel matches pointer exemplar lines", () => {
    assert.equal(
      formatCommissionDisplayLabel(POINTER_38_EXAMPLE_RULES[0], { sequence: 1 }),
      "Commission 1 = 12% | Category Shoes | Country IN | Customer New",
    );
    assert.equal(
      formatCommissionDisplayLabel(POINTER_38_EXAMPLE_RULES[1], { sequence: 2 }),
      "Commission 2 = 8% | Category Shoes | Country IN | Customer Existing",
    );
    assert.equal(
      formatCommissionDisplayLabel(POINTER_38_EXAMPLE_RULES[2], { sequence: 3 }),
      "Commission 3 = 6% | Category Accessories | Country IN",
    );
  });

  it("assertLineageMetadataPreserved requires source_rule_id", () => {
    assert.doesNotThrow(() => assertLineageMetadataPreserved({ rule: POINTER_38_EXAMPLE_RULES[0] }));
    assert.throws(
      () => assertLineageMetadataPreserved({ rule: { ratePercent: 10 } }),
      (err) => {
        assert.equal(err.code, "SOURCE_RULE_ID_MISSING");
        return true;
      },
    );
  });

  it("buildSupplierCommissionFlatteningGuide includes scoped object refs and example", () => {
    const globalGuide = buildSupplierCommissionFlatteningGuide();
    assert.equal(globalGuide.contractPointer, 38);
    assert.equal(globalGuide.example.mboDisplay.length, 3);

    const objectGuide = buildSupplierCommissionFlatteningGuide({
      network: "optimise",
      sourceObject: "commission_rules",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.match(objectGuide.objectRefs.fanOut, /supplierCommissionRuleFanOut/);
  });

  it("applySupplierCommissionFlatteningContract stamps response meta", () => {
    const wrapped = applySupplierCommissionFlatteningContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.supplierCommissionFlatteningPointer, 38);
    assert.equal(wrapped.meta.supplierCommissionFlatteningNetwork, "optimise");
  });
});

describe("Pointer 38 — AI integration guide includes supplier commission flattening", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes supplierCommissionFlattening", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.supplierCommissionFlatteningPointer, 38);
    assert.equal(payload.supplierCommissionFlattening.contractPointer, 38);
    assert.equal(payload.supplierCommissionFlattening.example.mboDisplay.length, 3);
  });

  it("object guide includes scoped flattening refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.supplierCommissionFlattening.contractPointer, 38);
    assert.match(payload.supplierCommissionFlattening.objectRefs.fanOut, /supplierCommissionRuleFanOut/);
  });
});

describe("Pointer 38 — GET /ops/network/ai-integration-guide", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("returns 401 without auth for global guide", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/network/ai-integration-guide",
    });
    assert.equal(status, 401);
  });
});
