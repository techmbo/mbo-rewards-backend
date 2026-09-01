import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("wave2b migration", () => {
  it("creates catalog routing tables and indexes", () => {
    const sql = readFileSync(
      join(__dirname, "../prisma/migrations/20260713110000_wave2b_catalog_intelligence/migration.sql"),
      "utf8",
    );

    assert.match(sql, /CREATE TABLE "canonical_campaigns"/);
    assert.match(sql, /CREATE TABLE "campaign_sources"/);
    assert.match(sql, /campaign_sources_canonicalCampaignId_supplierCampaignId_key/);
    assert.match(sql, /canonical_campaigns_displayName_trgm_idx/);
    assert.doesNotMatch(sql, /canonicalCampaignId.*supplier_campaigns/i);
    assert.doesNotMatch(sql, /DROP TABLE "supplier_campaigns"/i);
  });
});

describe("wave2b prisma schema", () => {
  it("declares catalog routing models", () => {
    const schema = readFileSync(join(__dirname, "../prisma/schema.prisma"), "utf8");

    assert.match(schema, /model CanonicalCampaign \{/);
    assert.match(schema, /model CampaignSource \{/);
    assert.doesNotMatch(schema, /canonicalCampaignId.*SupplierCampaign/);
  });
});
