import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("wave3 migration", () => {
  it("creates client distribution tables and indexes", () => {
    const sql = readFileSync(
      join(__dirname, "../prisma/migrations/20260713120000_wave3_client_distribution/migration.sql"),
      "utf8",
    );

    assert.match(sql, /CREATE TABLE "clients"/);
    assert.match(sql, /CREATE TABLE "client_brand_requests"/);
    assert.match(sql, /CREATE TABLE "client_campaign_assignments"/);
    assert.match(sql, /client_campaign_assignments_client_campaign_active_key/);
    assert.match(sql, /clients_name_trgm_idx/);
    assert.doesNotMatch(sql, /DROP TABLE "canonical_campaigns"/i);
    assert.doesNotMatch(sql, /supplier_campaigns/i);
  });
});

describe("wave3 prisma schema", () => {
  it("declares client distribution models", () => {
    const schema = readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8");

    assert.match(schema, /model Client \{/);
    assert.match(schema, /model ClientBrandRequest \{/);
    assert.match(schema, /model ClientCampaignAssignment \{/);
  });
});
