/**
 * Pointer 24 exemplar — Optimise campaigns (one network + one source object).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapPayload } from "../src/modules/mapping/engine.js";
import {
  compileMappingRegistryFromFiles,
  dedupeCompiledRules,
} from "../src/modules/mapping/mappingRegistry.compiler.js";
import { assertClientSafeMboModel, toClientSafeMboModel } from "../src/modules/networkOps/pipeline/clientSafe.js";
import { loadAiIntegrationFixtureBundle } from "../src/modules/networkOps/aiAssistedDevelopment.contract.js";
import { MAPPING_RULE_STATUS } from "../src/modules/mapping/mappingRegistry.contract.js";

describe("Pointer 24 exemplar — optimise/campaigns", () => {
  const bundle = loadAiIntegrationFixtureBundle("optimise", "campaigns");

  it("maps sanitized source fixture to expected canonical output", () => {
    const result = mapPayload({
      supplier: "OPTIMISE",
      resourceKey: "campaigns",
      payload: bundle.sourceFixture,
    });
    assert.equal(result.success, true);

    for (const [key, expected] of Object.entries(bundle.expectedCanonical)) {
      if (key === "mboTargetObject") continue;
      assert.deepEqual(
        result.normalizedData[key],
        expected,
        `canonical field ${key}`,
      );
    }
  });

  it("approved mapping rows compile into active registry rules", () => {
    const rules = dedupeCompiledRules(compileMappingRegistryFromFiles());
    const required = bundle.mappingRows.fields.filter((f) => f.required);
    for (const field of required) {
      const primaryPath = field.sources?.[0];
      const rule = rules.find(
        (r) =>
          r.network === "OPTIMISE" &&
          r.sourceObject === "campaigns" &&
          r.sourcePath === primaryPath &&
          r.mappingStatus === MAPPING_RULE_STATUS.ACTIVE,
      );
      assert.ok(rule, `missing registry rule for ${primaryPath} → ${field.targetField}`);
      assert.equal(rule.mboCanonicalField, field.targetField);
    }
  });

  it("pipeline client model projection is client-safe when exposed", () => {
    const result = mapPayload({
      supplier: "OPTIMISE",
      resourceKey: "campaigns",
      payload: bundle.sourceFixture,
    });
    const clientModel = toClientSafeMboModel(result.normalizedData, {
      entityType: "campaign",
      sourceResponse: bundle.sourceFixture,
    });
    assert.doesNotThrow(() =>
      assertClientSafeMboModel(clientModel, {
        sourceResponse: bundle.sourceFixture,
      }),
    );
    assert.equal(clientModel.campaignName, "Travel Deals Q1");
    assert.equal(clientModel.supplierCampaignId, undefined);
  });

  it("fixture bundle declares MBO target contract", () => {
    assert.equal(bundle.targetContract.mboTargetObject, "NetworkCampaign");
    assert.equal(bundle.targetContract.mappingVersion, "OPT-CMP-1");
    assert.equal(bundle.targetContract.sequenceStage, "campaigns");
  });
});
