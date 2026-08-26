import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("wave2 migration", () => {
  it("creates merchant intelligence tables and indexes", () => {
    const sql = readFileSync(
      join(__dirname, "../prisma/migrations/20260710160000_wave2_merchant_intelligence/migration.sql"),
      "utf8",
    );

    assert.match(sql, /CREATE TABLE "merchants"/);
    assert.match(sql, /CREATE TABLE "merchant_aliases"/);
    assert.match(sql, /CREATE TABLE "merchant_reviews"/);
    assert.match(sql, /merchants_displayName_trgm_idx/);
    assert.match(sql, /merchant_aliases_aliasValue_trgm_idx/);
    assert.match(sql, /supplier_campaigns_merchantId_fkey/);
    assert.match(sql, /"matchedAt"/);
    assert.match(sql, /"matchConfidence"/);
    assert.doesNotMatch(sql, /DROP TABLE "supplier_campaigns"/i);
  });
});

describe("wave2a prisma schema", () => {
  it("declares merchant intelligence models", () => {
    const schema = readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8");

    assert.match(schema, /model Merchant \{/);
    assert.match(schema, /model MerchantAlias \{/);
    assert.match(schema, /model MerchantReview \{/);
    assert.match(schema, /matchedAt/);
    assert.match(schema, /matchConfidence/);
  });
});
