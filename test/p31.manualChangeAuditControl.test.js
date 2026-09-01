/**
 * Pointer 31 — Manual change and audit-control rules.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  IMMUTABLE_RAW_EVIDENCE_FIELDS,
  MANUAL_CHANGE_AUDIT_SUMMARY,
  MANUAL_CHANGE_CATEGORIES,
  ManualChangeAuditControlError,
  REQUIRED_AUDIT_ENTRY_FIELDS,
  applyManualChangeAuditControlContract,
  assertManualChangeAudited,
  assertMappingVersionedChange,
  assertRawEvidenceImmutable,
  buildManualChangeAuditControlGuide,
} from "../src/modules/networkOps/manualChangeAuditControl.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 31 — manualChangeAuditControl.contract", () => {
  it("declares contract pointer 31 and six manual change categories", () => {
    assert.equal(CONTRACT_POINTER, 31);
    assert.equal(MANUAL_CHANGE_CATEGORIES.length, 6);
    assert.match(MANUAL_CHANGE_AUDIT_SUMMARY.auditRule, /actor, timestamp, object, field, old value, new value and reason/);
    assert.match(MANUAL_CHANGE_AUDIT_SUMMARY.immutableRawRule, /never rewrite immutable raw source evidence/);
    assert.match(MANUAL_CHANGE_AUDIT_SUMMARY.mappingVersionRule, /Create a new version and reprocess affected preserved raw records/);
    assert.deepEqual(REQUIRED_AUDIT_ENTRY_FIELDS, [
      "actor",
      "timestamp",
      "object",
      "field",
      "oldValue",
      "newValue",
      "reason",
    ]);
  });

  it("assertManualChangeAudited requires complete audit entries for manual changes", () => {
    assert.throws(
      () =>
        assertManualChangeAudited({
          category: "mapping_status",
          manual: true,
        }),
      (err) => {
        assert.equal(err.code, "AUDIT_ENTRY_MISSING");
        return true;
      },
    );
    assert.throws(
      () =>
        assertManualChangeAudited({
          category: "exception_resolution",
          manual: true,
          auditEntry: {
            actorId: "user-1",
            createdAt: "2026-08-01T12:00:00.000Z",
            aggregateType: "exception_case",
            before: "OPEN",
            after: "RESOLVED",
          },
        }),
      (err) => {
        assert.equal(err.code, "AUDIT_ENTRY_INCOMPLETE");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertManualChangeAudited({
        category: "attribution",
        manual: true,
        auditEntry: {
          actorId: "user-1",
          createdAt: "2026-08-01T12:00:00.000Z",
          aggregateType: "conversion",
          metadata: { field: "attributionLinkId" },
          before: "link-a",
          after: "link-b",
          reason: "Ops correction after client ticket #123",
        },
      }),
    );
  });

  it("assertRawEvidenceImmutable forbids rewriting raw payload evidence", () => {
    assert.throws(
      () =>
        assertRawEvidenceImmutable({
          action: "rewrite_raw_payload",
        }),
      (err) => {
        assert.equal(err.code, "IMMUTABLE_RAW_REWRITE_FORBIDDEN");
        return true;
      },
    );
    assert.throws(
      () =>
        assertRawEvidenceImmutable({
          action: "update_record",
          targetFields: ["payloadHash"],
        }),
      (err) => {
        assert.equal(err.code, "IMMUTABLE_RAW_FIELD_MUTATION");
        return true;
      },
    );
    assert.ok(IMMUTABLE_RAW_EVIDENCE_FIELDS.includes("payload"));
  });

  it("assertMappingVersionedChange forbids in-place edits and requires reprocess", () => {
    assert.throws(
      () =>
        assertMappingVersionedChange({
          previousVersion: "1",
          nextVersion: "1",
          mappingAlreadyUsed: true,
          editedInPlace: true,
        }),
      (err) => {
        assert.equal(err.code, "MAPPING_IN_PLACE_EDIT_FORBIDDEN");
        return true;
      },
    );
    assert.throws(
      () =>
        assertMappingVersionedChange({
          previousVersion: "1",
          nextVersion: "2",
          mappingAlreadyUsed: true,
          reprocessPlanned: false,
        }),
      (err) => {
        assert.equal(err.code, "MAPPING_REPROCESS_REQUIRED");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertMappingVersionedChange({
        previousVersion: "1",
        nextVersion: "2",
        mappingAlreadyUsed: true,
        reprocessPlanned: true,
      }),
    );
  });

  it("buildManualChangeAuditControlGuide includes scoped object refs", () => {
    const globalGuide = buildManualChangeAuditControlGuide();
    assert.equal(globalGuide.contractPointer, 31);
    assert.equal(globalGuide.manualChangeCategories.length, 6);

    const objectGuide = buildManualChangeAuditControlGuide({ network: "optimise", sourceObject: "campaigns" });
    assert.match(objectGuide.objectRefs.mappingRegistry, /optimise\/campaigns\.mapping\.json/);
    assert.equal(objectGuide.objectRefs.reprocessEndpoint, "/ops/imported-records/reprocess");
  });

  it("applyManualChangeAuditControlContract stamps response meta", () => {
    const wrapped = applyManualChangeAuditControlContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.manualChangeAuditPointer, 31);
    assert.equal(wrapped.meta.manualChangeAuditNetwork, "optimise");
  });
});

describe("Pointer 31 — AI integration guide includes manual change audit control", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes manualChangeAuditControl", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.manualChangeAuditPointer, 31);
    assert.equal(payload.manualChangeAuditControl.contractPointer, 31);
    assert.equal(payload.manualChangeAuditControl.requiredAuditEntryFields.length, 7);
  });

  it("object guide includes scoped manual change audit refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.manualChangeAuditControl.contractPointer, 31);
    assert.match(payload.manualChangeAuditControl.objectRefs.mappingVersionPattern, /campaigns/);
  });
});

describe("Pointer 31 — GET /ops/network/ai-integration-guide", () => {
  /** @type {{ baseUrl: string, close: () => Promise<void> } | null} */
  let server = null;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    if (server) await server.close();
  });

  it("returns 401 without auth for global guide", async () => {
    const { status } = await apiRequest(server.baseUrl, {
      path: "/ops/network/ai-integration-guide",
    });
    assert.equal(status, 401);
  });
});
