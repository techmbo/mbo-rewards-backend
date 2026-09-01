import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SourceSelectionService } from "../src/modules/catalog/services/sourceSelection.service.js";

describe("SourceSelectionService", () => {
  const service = new SourceSelectionService();

  it("selects primary, secondary, and inactive sources", () => {
    const sources = [
      {
        id: "s1",
        isPrimary: true,
        priority: 10,
        isActive: true,
        status: "PREFERRED",
        relationshipStatus: "JOINED",
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "s2",
        isPrimary: false,
        priority: 20,
        isActive: true,
        status: "ACTIVE",
        relationshipStatus: "JOINED",
        createdAt: new Date("2026-01-02"),
      },
      {
        id: "s3",
        isPrimary: false,
        priority: 5,
        isActive: true,
        status: "LINKED",
        relationshipStatus: "NOT_JOINED",
        createdAt: new Date("2026-01-03"),
      },
    ];

    const result = service.select(sources);

    assert.equal(result.primary?.id, "s1");
    assert.equal(result.secondary.length, 1);
    assert.equal(result.secondary[0].id, "s2");
    assert.equal(result.inactive.length, 1);
    assert.equal(result.inactive[0].id, "s3");
    assert.equal(result.recommendation, null);
  });

  it("detects multiple primary conflicts", () => {
    const conflicts = service.detectConflicts([
      { id: "a", isPrimary: true, isActive: true, relationshipStatus: "JOINED" },
      { id: "b", isPrimary: true, isActive: true, relationshipStatus: "JOINED" },
    ]);

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].code, "MULTIPLE_PRIMARY");
  });
});
