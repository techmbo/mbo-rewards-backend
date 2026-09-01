import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("wave1 migration", () => {
  it("is additive and creates wave 1 tables only", () => {
    const sql = readFileSync(
      join(__dirname, "../prisma/migrations/20260710140000_wave1_supplier_foundation/migration.sql"),
      "utf8",
    );

    assert.match(sql, /CREATE TABLE "suppliers"/);
    assert.match(sql, /CREATE TABLE "supplier_campaigns"/);
    assert.match(sql, /CREATE TABLE "supplier_coupons"/);
    assert.match(sql, /CREATE TABLE "event_outbox"/);
    assert.match(sql, /CREATE TABLE "mapper_errors"/);
    assert.doesNotMatch(sql, /DROP TABLE "Entity"/i);
    assert.doesNotMatch(sql, /ALTER TABLE "Entity"/i);
  });

  it("defines partial unique indexes for supplier coupons", () => {
    const sql = readFileSync(
      join(__dirname, "../prisma/migrations/20260710140000_wave1_supplier_foundation/migration.sql"),
      "utf8",
    );

    assert.match(sql, /supplier_coupons_campaign_code_unique/);
    assert.match(sql, /supplier_coupons_campaign_link_unique/);
  });
});

describe("wave1 prisma schema", () => {
  it("declares wave 1 models without modifying phase 1 model names", () => {
    const schema = readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8");

    assert.match(schema, /model Supplier \{/);
    assert.match(schema, /model SupplierCampaign \{/);
    assert.match(schema, /model SupplierCoupon \{/);
    assert.match(schema, /model EventOutbox \{/);
    assert.match(schema, /model MapperError \{/);
    assert.match(schema, /model Entity \{/);
  });
});
