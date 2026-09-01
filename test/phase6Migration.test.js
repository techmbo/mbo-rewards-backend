import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("phase6 migration", () => {
  it("creates audit and job tables", () => {
    const sql = readFileSync(
      join(__dirname, "../prisma/migrations/20260713160000_phase6_platform_ops/migration.sql"),
      "utf8",
    );
    assert.match(sql, /CREATE TABLE "audit_events"/);
    assert.match(sql, /CREATE TABLE "job_runs"/);
    assert.match(sql, /JobRunStatus/);
  });
});
