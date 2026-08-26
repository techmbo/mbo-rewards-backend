import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("wave5 migration", () => {
  it("creates attribution and reporting tables", () => {
    const sql = readFileSync(
      join(__dirname, "../prisma/migrations/20260713140000_wave5_attribution_reporting/migration.sql"),
      "utf8",
    );

    assert.match(sql, /CREATE TABLE "clicks"/);
    assert.match(sql, /CREATE TABLE "conversions"/);
    assert.match(sql, /CREATE TABLE "daily_reports"/);
    assert.match(sql, /daily_reports_dimension_key/);
    assert.match(sql, /conversions_supplier_supplierConversionId_sourceAccountLabel_key/);
    assert.match(sql, /clicks_clickedAt_brin_idx/);
    assert.match(sql, /conversions_conversionDate_brin_idx/);
  });
});

describe("wave5 prisma schema", () => {
  it("declares attribution and reporting models", () => {
    const schema = readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8");

    assert.match(schema, /model Click \{/);
    assert.match(schema, /model Conversion \{/);
    assert.match(schema, /model DailyReport \{/);
    assert.match(schema, /enum ConversionStatus/);
    assert.match(schema, /enum AttributionStatus/);
  });
});
