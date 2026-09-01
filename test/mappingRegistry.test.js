import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMappingVersionId,
  inferMboTargetObject,
  parseMappingVersionId,
  resolveLoaderMappingVersion,
} from "../src/modules/mapping/mappingRegistry.contract.js";
import {
  compileMappingRegistryFromFiles,
  dedupeCompiledRules,
} from "../src/modules/mapping/mappingRegistry.compiler.js";

describe("mapping registry", () => {
  it("builds stable version ids like OPT-CONV-1", () => {
    assert.equal(buildMappingVersionId("OPTIMISE", "conversions", "1"), "OPT-CONV-1");
    assert.equal(buildMappingVersionId("optimise", "campaigns", "1.3"), "OPT-CMP-1.3");
  });

  it("parses registry version ids back to loader inputs", () => {
    const parsed = parseMappingVersionId("OPT-CONV-1.3");
    assert.equal(parsed.supplier, "optimise");
    assert.equal(parsed.resourceKey, "conversions");
    assert.equal(parsed.definitionVersion, "1.3");
    assert.equal(resolveLoaderMappingVersion("OPT-CONV-1.3"), "1.3");
  });

  it("infers MBO target objects from resource and field names", () => {
    assert.equal(
      inferMboTargetObject("conversions", "defaultCommissionValue"),
      "SupplierCommissionRule",
    );
    assert.equal(inferMboTargetObject("campaigns", "campaignName"), "NetworkCampaign");
    assert.equal(
      inferMboTargetObject("conversions", "attribution.assignmentId"),
      "ClientCampaignAssignment",
    );
  });

  it("compiles mapping JSON files into registry rules with paths and transforms", () => {
    const rules = dedupeCompiledRules(compileMappingRegistryFromFiles());
    assert.ok(rules.length > 0);
    const optimiseConv = rules.find(
      (r) =>
        r.network === "OPTIMISE" &&
        r.sourceObject === "conversions" &&
        r.sourcePath === "conversionId" &&
        r.mappingStatus === "ACTIVE",
    );
    assert.ok(optimiseConv);
    assert.equal(optimiseConv.mboCanonicalField, "supplierConversionId");
    assert.equal(optimiseConv.transform, "COALESCE");
    assert.equal(optimiseConv.mappingVersion, "OPT-CONV-1");
    assert.equal(optimiseConv.mboTargetObject, "OrderConversion");
    assert.equal(optimiseConv.fieldMappingOutcome, "MAPPED");
  });

  it("expands COALESCE fallback paths into explicit registry rows", () => {
    const rules = dedupeCompiledRules(compileMappingRegistryFromFiles());
    const idRule = rules.find(
      (r) => r.network === "OPTIMISE" && r.sourceObject === "conversions" && r.sourcePath === "id",
    );
    assert.ok(idRule);
    assert.equal(idRule.mboCanonicalField, "supplierConversionId");
  });
});
