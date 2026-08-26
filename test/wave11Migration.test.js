import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("wave1.1 migration", () => {
  it("adds trigram and composite indexes", () => {
    const sql = readFileSync(
      join(__dirname, "../prisma/migrations/20260710153000_wave1_1_performance_indexes/migration.sql"),
      "utf8",
    );

    assert.match(sql, /pg_trgm/);
    assert.match(sql, /campaignName_trgm/);
    assert.match(sql, /merchantNameRaw_trgm/);
    assert.match(sql, /supplier_campaignStatus_lastSyncedAt/);
    assert.match(sql, /couponEndDate/);
  });
});
