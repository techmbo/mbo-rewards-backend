/**
 * Pointer 19 — Reprocessing contract tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCanonicalDiff,
  canCloseReprocessException,
  pickCanonicalSnapshot,
  validateReprocessClose,
} from "../src/modules/networkOps/reprocessing.contract.js";

describe("Pointer 19 — reprocessing.contract", () => {
  it("builds before/after diff for changed canonical fields", () => {
    const diff = buildCanonicalDiff(
      { validationStatus: "VALIDATION_PENDING", orderValue: "100" },
      { validationStatus: "VALIDATION_APPROVED", orderValue: "100" },
      "conversion",
    );
    assert.equal(diff.changed, true);
    assert.equal(diff.changes.length, 1);
    assert.equal(diff.changes[0].field, "validationStatus");
  });

  it("snapshots conversion canonical fields", () => {
    const snap = pickCanonicalSnapshot(
      {
        id: "ord-1",
        validationStatus: "VALIDATION_APPROVED",
        orderValue: "50",
        currency: "USD",
      },
      "conversion",
    );
    assert.equal(snap.id, "ord-1");
    assert.equal(snap.validationStatus, "VALIDATION_APPROVED");
  });

  it("requires mapping, upsert, and reconciliation for validated close", () => {
    assert.equal(
      canCloseReprocessException({
        mappingOk: true,
        upsertOk: true,
        reconciliation: { ok: true, material: false },
      }),
      true,
    );
    assert.equal(
      validateReprocessClose({
        mappingOk: true,
        upsertOk: true,
        reconciliation: { ok: false, material: true },
      }).ok,
      false,
    );
    assert.equal(
      validateReprocessClose({ mappingOk: false, upsertOk: true }).reasons.includes("mapping_failed"),
      true,
    );
  });
});
