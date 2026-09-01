/**
 * Pointer 29 — Sync resilience requirements.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  APPROVED_LIFECYCLE_MARKERS,
  CONTRACT_POINTER,
  SYNC_RESILIENCE_REQUIREMENTS,
  SYNC_RESILIENCE_SUMMARY,
  SYNC_SUCCESS_CRITERIA,
  SyncResilienceError,
  applySyncResilienceContract,
  assertHistoricalRetentionCompliance,
  assertSyncSuccessCriteria,
  buildSyncResilienceGuide,
} from "../src/modules/networkOps/syncResilience.contract.js";
import { SYNC_OBS_STATUS } from "../src/modules/networkOps/syncObservability.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 29 — syncResilience.contract", () => {
  it("declares contract pointer 29 and eleven resilience requirements", () => {
    assert.equal(CONTRACT_POINTER, 29);
    assert.equal(SYNC_RESILIENCE_REQUIREMENTS.length, 11);
    assert.equal(SYNC_RESILIENCE_REQUIREMENTS[0].key, "pagination");
    assert.equal(SYNC_RESILIENCE_REQUIREMENTS.at(-1).key, "deleted_expired_stale_records");
    assert.match(SYNC_RESILIENCE_SUMMARY.successDefinition, /HTTP response does not prove a complete sync/i);
    assert.match(SYNC_RESILIENCE_SUMMARY.historicalRetentionRule, /Do not delete historical facts/i);
  });

  it("defines success criteria and approved lifecycle markers", () => {
    assert.equal(SYNC_SUCCESS_CRITERIA.httpResponseAloneInsufficient, true);
    assert.equal(SYNC_SUCCESS_CRITERIA.requiresCheckpointSafelyAdvanced, true);
    assert.deepEqual(APPROVED_LIFECYCLE_MARKERS, ["stale", "ended", "unavailable", "superseded"]);
  });

  it("assertSyncSuccessCriteria rejects HTTP 200 without complete pages", () => {
    assert.throws(
      () =>
        assertSyncSuccessCriteria({
          httpStatus: 200,
          allPagesProcessed: false,
          checkpointSafelyAdvanced: false,
        }),
      (err) => {
        assert.equal(err instanceof SyncResilienceError, true);
        assert.equal(err.code, "HTTP_SUCCESS_INCOMPLETE_SYNC");
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertSyncSuccessCriteria({
        allPagesProcessed: true,
        checkpointSafelyAdvanced: true,
        terminalStatus: SYNC_OBS_STATUS.SUCCESS,
      }),
    );
  });

  it("assertSyncSuccessCriteria rejects SUCCESS without checkpoint advance", () => {
    assert.throws(
      () =>
        assertSyncSuccessCriteria({
          allPagesProcessed: true,
          checkpointSafelyAdvanced: false,
          terminalStatus: SYNC_OBS_STATUS.SUCCESS,
        }),
      (err) => {
        assert.equal(err.code, "CHECKPOINT_NOT_ADVANCED");
        return true;
      },
    );
  });

  it("assertHistoricalRetentionCompliance forbids hard deletes", () => {
    assert.throws(
      () =>
        assertHistoricalRetentionCompliance({
          action: "hard_delete_historical_fact",
        }),
      (err) => {
        assert.equal(err.code, "HISTORICAL_FACT_DELETION_FORBIDDEN");
        return true;
      },
    );
  });

  it("assertHistoricalRetentionCompliance requires approved rule for lifecycle markers", () => {
    assert.doesNotThrow(() =>
      assertHistoricalRetentionCompliance({
        action: "mark_stale",
        lifecycleMarker: "stale",
        approvedRule: "campaign.not_seen_in_sync_for_30d",
      }),
    );
    assert.throws(
      () =>
        assertHistoricalRetentionCompliance({
          action: "mark_stale",
          lifecycleMarker: "stale",
        }),
      (err) => {
        assert.equal(err.code, "LIFECYCLE_MARKER_WITHOUT_APPROVED_RULE");
        return true;
      },
    );
  });

  it("buildSyncResilienceGuide includes scoped object refs", () => {
    const globalGuide = buildSyncResilienceGuide();
    assert.equal(globalGuide.contractPointer, 29);
    assert.equal(globalGuide.requirements.length, 11);

    const objectGuide = buildSyncResilienceGuide({ network: "optimise", sourceObject: "campaigns" });
    assert.match(objectGuide.objectRefs.catalogEntry, /optimise\/campaigns/);
  });

  it("applySyncResilienceContract stamps response meta", () => {
    const wrapped = applySyncResilienceContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.syncResiliencePointer, 29);
    assert.equal(wrapped.meta.syncResilienceNetwork, "optimise");
  });
});

describe("Pointer 29 — AI integration guide includes sync resilience", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes syncResilienceRequirements", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.syncResiliencePointer, 29);
    assert.equal(payload.syncResilienceRequirements.contractPointer, 29);
    assert.equal(payload.syncResilienceRequirements.requirements.length, 11);
  });

  it("object guide includes scoped sync resilience refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.syncResilienceRequirements.contractPointer, 29);
    assert.match(payload.syncResilienceRequirements.objectRefs.catalogEntry, /campaigns/);
  });
});

describe("Pointer 29 — GET /ops/network/ai-integration-guide", () => {
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
