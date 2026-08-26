import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeCursor, decodeCursor, buildCursorWhere } from "../src/core/cursorPagination.js";

describe("cursorPagination", () => {
  it("round-trips cursor values", () => {
    const record = {
      id: "abc",
      lastSyncedAt: new Date("2026-01-15T10:00:00.000Z"),
    };

    const cursor = encodeCursor(record, ["lastSyncedAt", "id"]);
    const decoded = decodeCursor(cursor, ["lastSyncedAt", "id"]);

    assert.equal(decoded.id, "abc");
    assert.equal(decoded.lastSyncedAt.toISOString(), record.lastSyncedAt.toISOString());
  });

  it("builds descending cursor filter", () => {
    const cursor = {
      lastSyncedAt: new Date("2026-01-15T10:00:00.000Z"),
      id: "abc",
    };

    const where = buildCursorWhere(cursor, ["lastSyncedAt", "id"]);
    assert.ok(where.OR);
    assert.equal(where.OR.length, 2);
  });
});
