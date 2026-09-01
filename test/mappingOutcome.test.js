import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FIELD_MAPPING_OUTCOME,
  isEngineeringDefect,
  normalizeFieldMappingOutcome,
  parseDeclaredOutcomeFromNotes,
  resolveFieldResultOutcome,
  resolveMapErrorOutcome,
  resolveObservedPathOutcome,
  resolveUnmappedPathOutcome,
} from "../src/modules/mapping/mappingOutcome.contract.js";
import { attachFieldMappingOutcomes } from "../src/modules/mapping/mappingOutcome.resolver.js";

describe("mapping outcome taxonomy (pointer 7)", () => {
  it("defines all contract outcomes without NOT_MAPPED", () => {
    const values = Object.values(FIELD_MAPPING_OUTCOME);
    assert.ok(values.includes("MAPPED"));
    assert.ok(values.includes("SOURCE_PRESENT_MAPPING_MISSING"));
    assert.ok(values.includes("SOURCE_ONLY"));
    assert.equal(values.includes("NOT_MAPPED"), false);
    assert.equal(values.length, 12);
  });

  it("classifies engineering defects", () => {
    assert.equal(isEngineeringDefect(FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING), true);
    assert.equal(isEngineeringDefect(FIELD_MAPPING_OUTCOME.SOURCE_ONLY), false);
    assert.equal(isEngineeringDefect(FIELD_MAPPING_OUTCOME.MAPPED), false);
  });

  it("resolves observed schema paths", () => {
    assert.equal(
      resolveObservedPathOutcome({ mboTarget: "campaignName" }),
      FIELD_MAPPING_OUTCOME.MAPPED,
    );
    assert.equal(
      resolveObservedPathOutcome({ mboTarget: null, sampleValue: "abc", required: true }),
      FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING,
    );
    assert.equal(
      resolveObservedPathOutcome({ mboTarget: null, sampleValue: "abc" }),
      FIELD_MAPPING_OUTCOME.SOURCE_ONLY,
    );
    assert.equal(
      resolveObservedPathOutcome({ mboTarget: null, sampleValue: null }),
      FIELD_MAPPING_OUTCOME.SOURCE_ONLY,
    );
  });

  it("parses declared outcomes from mapping notes", () => {
    assert.equal(
      parseDeclaredOutcomeFromNotes("verify live endpoint before use"),
      FIELD_MAPPING_OUTCOME.VERIFY_LIVE,
    );
    assert.equal(
      parseDeclaredOutcomeFromNotes("source only evidence field"),
      FIELD_MAPPING_OUTCOME.SOURCE_ONLY,
    );
    assert.equal(
      parseDeclaredOutcomeFromNotes("mbo derived from commission rules"),
      FIELD_MAPPING_OUTCOME.MBO_DERIVED,
    );
  });

  it("maps engine errors to outcomes", () => {
    assert.equal(
      resolveMapErrorOutcome({ code: "MAPPING_UNKNOWN_ENUM" }),
      FIELD_MAPPING_OUTCOME.TRANSFORM_FAILED,
    );
    assert.equal(
      resolveMapErrorOutcome({ code: "MAPPING_REQUIRED_FIELD_MISSING", sourceValue: null }),
      FIELD_MAPPING_OUTCOME.SOURCE_NULL,
    );
    assert.equal(
      resolveMapErrorOutcome({ code: "MAPPING_UNMAPPED_CRITICAL_FIELD", sourceValue: "x" }),
      FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING,
    );
  });

  it("resolves field results and unmapped paths", () => {
    assert.equal(
      resolveFieldResultOutcome({ success: true }),
      FIELD_MAPPING_OUTCOME.MAPPED,
    );
    assert.equal(
      resolveUnmappedPathOutcome("value", { critical: true }),
      FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING,
    );
    assert.equal(resolveUnmappedPathOutcome(null), FIELD_MAPPING_OUTCOME.SOURCE_NULL);
  });

  it("enriches map results with per-field outcomes", () => {
    const enriched = attachFieldMappingOutcomes(
      {
        success: false,
        fieldResults: [{ success: true, sourcePath: "id", targetField: "supplierConversionId" }],
        unmappedFields: ["extra"],
        errors: [
          {
            code: "MAPPING_UNMAPPED_CRITICAL_FIELD",
            sourcePath: "extra",
            sourceValue: "present",
          },
        ],
      },
      { id: 1, extra: "present" },
    );

    assert.equal(enriched.fieldResults[0].fieldMappingOutcome, FIELD_MAPPING_OUTCOME.MAPPED);
    assert.equal(
      enriched.unmappedOutcomes[0].fieldMappingOutcome,
      FIELD_MAPPING_OUTCOME.SOURCE_PRESENT_MAPPING_MISSING,
    );
    assert.ok(enriched.engineeringDefectCount >= 1);
  });

  it("rejects unknown outcome labels", () => {
    assert.equal(normalizeFieldMappingOutcome("NOT_MAPPED"), null);
    assert.equal(normalizeFieldMappingOutcome("mapped"), FIELD_MAPPING_OUTCOME.MAPPED);
  });
});
