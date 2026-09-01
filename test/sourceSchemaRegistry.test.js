import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { observeSourceFields } from "../src/field-system/fieldExtractor.js";
import { sanitizeSampleValue } from "../src/field-system/sampleSanitizer.js";
import { resolveSourceObjectKey } from "../src/field-system/resolveSourceObject.js";
import {
  buildSourceSchemaMappingIndex,
  lookupMboTarget,
  resolveMappingStatus,
} from "../src/field-system/sourceSchemaMappingIndex.js";

describe("source schema registry", () => {
  it("observes paths with type, nullable, and sanitized samples", () => {
    const fields = observeSourceFields({
      id: 42,
      name: "Summer Sale",
      tags: ["a", "b"],
      meta: { country: "AE" },
      apiKey: "secret-should-not-appear",
      paused: null,
    });

    const byPath = new Map(fields.map((f) => [f.fieldPath, f]));
    assert.equal(byPath.get("id").sourceType, "number");
    assert.equal(byPath.get("id").sampleValue, "42");
    assert.equal(byPath.get("name").sampleValue, "Summer Sale");
    assert.equal(byPath.get("tags").isArray, true);
    assert.equal(byPath.get("tags").sampleValue, "[2 items]");
    assert.equal(byPath.get("meta").isObject, true);
    assert.equal(byPath.get("meta.country").sampleValue, "AE");
    assert.equal(byPath.get("apiKey").sampleValue, "[redacted]");
    assert.equal(byPath.get("paused").nullable, true);
    assert.equal(byPath.get("paused").sampleValue, "null");
  });

  it("redacts sensitive path segments in samples", () => {
    assert.equal(sanitizeSampleValue("abc123", { fieldPath: "auth.accessToken" }), "[redacted]");
  });

  it("resolves source_object identity from evidence or entity type", () => {
    assert.equal(resolveSourceObjectKey({ sourceObject: "voucher_codes" }), "voucher_codes");
    assert.equal(resolveSourceObjectKey({ entityType: "campaign" }), "campaigns");
    assert.equal(resolveSourceObjectKey({ resourceKey: "conversions" }), "conversions");
  });

  it("maps observed paths to MBO targets from mapping definitions", () => {
    const index = buildSourceSchemaMappingIndex();
    assert.ok(index.size > 0);
    assert.equal(
      lookupMboTarget({
        network: "optimise_sea",
        sourceObject: "campaigns",
        sourcePath: "name",
      }),
      "campaignName",
    );
    assert.equal(
      lookupMboTarget({
        network: "optimise_sea",
        sourceObject: "campaigns",
        sourcePath: "unmappedField",
      }),
      null,
    );
    assert.equal(resolveMappingStatus("campaignName"), "MAPPED");
    assert.equal(resolveMappingStatus(null), "SOURCE_ONLY");
    assert.equal(resolveMappingStatus(null, { sampleValue: "x", required: true }), "SOURCE_PRESENT_MAPPING_MISSING");
  });
});
