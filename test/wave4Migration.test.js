import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("wave4 migration", () => {
  it("creates commercial foundation tables", () => {
    const sql = readFileSync(
      join(__dirname, "../prisma/migrations/20260713130000_wave4_commercial_foundation/migration.sql"),
      "utf8",
    );

    assert.match(sql, /CREATE TABLE "tracking_links"/);
    assert.match(sql, /CREATE TABLE "client_coupon_assignments"/);
    assert.match(sql, /CREATE TABLE "client_commission_rules"/);
    assert.match(sql, /tracking_links_subId_key/);
    assert.match(sql, /client_commission_rules_assignmentId_effectiveFrom_key/);
    assert.doesNotMatch(sql, /CREATE TABLE "clicks"/i);
    assert.doesNotMatch(sql, /CREATE TABLE "conversions"/i);
    assert.doesNotMatch(sql, /CREATE TABLE "daily_reports"/i);
  });
});
