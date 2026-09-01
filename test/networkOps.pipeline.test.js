import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PIPELINE_STAGES,
  PipelineSkipError,
  PipelineStageError,
  ClientModelLeakError,
  runNetworkPipeline,
  ingestSourceRecord,
  toClientSafeMboModel,
  assertClientSafeMboModel,
} from "../src/modules/networkOps/pipeline/index.js";

function passthroughHandlers(overrides = {}) {
  const handlers = {};
  for (const stage of PIPELINE_STAGES) {
    handlers[stage] = async () => ({ summary: stage });
  }
  return { ...handlers, ...overrides };
}

describe("Network Operations runtime pipeline", () => {
  it("defines the required stages in contract order", () => {
    assert.deepEqual(PIPELINE_STAGES, [
      "FETCH_SOURCE",
      "STORE_RAW_PAYLOAD",
      "DETECT_SOURCE_SCHEMA",
      "APPLY_VERSIONED_MAPPING",
      "NORMALIZE_CANONICAL",
      "VALIDATE_MBO_STANDARD",
      "IDEMPOTENT_UPSERT",
      "RESOLVE_ATTRIBUTION",
      "APPLY_COMMERCIAL_RULES",
      "UPDATE_NETWORK_OPS",
      "RECONCILE_FINANCE",
      "EXPOSE_CLIENT_SAFE_MODEL",
    ]);
  });

  it("refuses to skip a stage by omitting its handler", async () => {
    const handlers = passthroughHandlers();
    delete handlers.STORE_RAW_PAYLOAD;
    await assert.rejects(
      () => runNetworkPipeline({ handlers, input: {} }),
      (error) => {
        assert.equal(error instanceof PipelineSkipError, true);
        assert.equal(error.stage, "STORE_RAW_PAYLOAD");
        assert.equal(error.reason, "handler_missing");
        return true;
      },
    );
  });

  it("refuses a handler that requests skip", async () => {
    const handlers = passthroughHandlers({
      APPLY_VERSIONED_MAPPING: async () => ({ skip: true, reason: "shortcut_to_client" }),
    });
    await assert.rejects(
      () => runNetworkPipeline({ handlers, input: {} }),
      (error) => {
        assert.equal(error instanceof PipelineSkipError, true);
        assert.equal(error.stage, "APPLY_VERSIONED_MAPPING");
        return true;
      },
    );
  });

  it("does not run later stages after a skip", async () => {
    const ran = [];
    const handlers = passthroughHandlers({
      STORE_RAW_PAYLOAD: async () => {
        ran.push("STORE_RAW_PAYLOAD");
        return { skip: true, reason: "no_raw" };
      },
      DETECT_SOURCE_SCHEMA: async () => {
        ran.push("DETECT_SOURCE_SCHEMA");
        return {};
      },
    });
    await assert.rejects(() => runNetworkPipeline({ handlers, input: {} }), PipelineSkipError);
    assert.deepEqual(ran, ["STORE_RAW_PAYLOAD"]);
  });

  it("completes every stage when handlers run in order", async () => {
    const ctx = await runNetworkPipeline({ handlers: passthroughHandlers(), input: {} });
    assert.deepEqual(ctx.completed, [...PIPELINE_STAGES]);
  });

  it("allows a stage to run as not-applicable without treating it as a skip", async () => {
    const ctx = await runNetworkPipeline({
      handlers: passthroughHandlers({
        RECONCILE_FINANCE: async () => ({ applicable: false, summary: "not_an_order" }),
      }),
      input: {},
    });
    assert.equal(ctx.completed.includes("RECONCILE_FINANCE"), true);
    assert.equal(ctx.evidence.RECONCILE_FINANCE.applicable, false);
  });

  it("rejects mapping a network response directly into the client model", () => {
    const source = { id: 10, name: "Nike", payouts: [{ value: 8 }] };
    assert.throws(
      () => toClientSafeMboModel(source, { entityType: "campaign", sourceResponse: source }),
      ClientModelLeakError,
    );
    assert.throws(
      () =>
        assertClientSafeMboModel(
          { campaignName: "Nike", rawPayload: source, supplierCampaignId: "10" },
          { sourceResponse: source },
        ),
      (error) => {
        assert.equal(error instanceof ClientModelLeakError, true);
        return true;
      },
    );
  });

  it("stores the full immutable raw payload before mapping and never exposes it to the client", async () => {
    const source = {
      id: 42,
      name: "Nike CPS",
      advertiser_name: "Nike",
      status: "active",
      extraNetworkOnlyField: { secret: "do-not-leak" },
    };
    let storedPayload = null;
    const result = await ingestSourceRecord(
      {
        networkSource: "boostiny",
        entityType: "campaign",
        externalId: "boostiny-campaign-42",
        sourceResponse: source,
      },
      {
        persistRawPayload: async ({ payload }) => {
          storedPayload = payload;
          return { record: { id: "rp-raw-1", payload }, created: true };
        },
      },
    );

    assert.equal(result.rawPayloadId, "rp-raw-1");
    assert.deepEqual(storedPayload, source);
    assert.ok(result.completed.indexOf("STORE_RAW_PAYLOAD") < result.completed.indexOf("APPLY_VERSIONED_MAPPING"));
    assert.ok(result.completed.indexOf("APPLY_VERSIONED_MAPPING") < result.completed.indexOf("EXPOSE_CLIENT_SAFE_MODEL"));
    assert.deepEqual(result.completed, [...PIPELINE_STAGES]);
    assert.equal(result.canonical.campaignName, "Nike CPS");
    assert.equal(result.canonical.supplierCampaignId, "42");
    assert.equal(result.clientModel.campaignName, "Nike CPS");
    assert.equal(result.clientModel.brandName, "Nike");
    assert.equal(result.clientModel.rawPayload, undefined);
    assert.equal(result.clientModel.supplierCampaignId, undefined);
    assert.equal(result.clientModel.extraNetworkOnlyField, undefined);
    assert.notEqual(result.clientModel, source);
    assert.equal(result.values.sourceResponse.extraNetworkOnlyField.secret, "do-not-leak");
  });

  it("fails ingest when the raw payload is not stored", async () => {
    await assert.rejects(
      () =>
        ingestSourceRecord(
          {
            networkSource: "boostiny",
            entityType: "campaign",
            externalId: "boostiny-campaign-1",
            sourceResponse: { id: 1, name: "A" },
          },
          {
            persistRawPayload: async () => ({ record: null, created: false, skipped: true }),
          },
        ),
      (error) => {
        assert.equal(error instanceof PipelineStageError, true);
        assert.equal(error.stage, "STORE_RAW_PAYLOAD");
        assert.equal(error.code, "RAW_PAYLOAD_REQUIRED");
        return true;
      },
    );
  });

  it("fails schema detection when the network shape is unknown", async () => {
    await assert.rejects(
      () =>
        ingestSourceRecord(
          {
            networkSource: "unknown_network",
            entityType: "campaign",
            externalId: "unknown-campaign-1",
            sourceResponse: { id: 1, name: "X" },
          },
          {
            persistRawPayload: async ({ payload }) => ({
              record: { id: "rp-1", payload },
              created: true,
            }),
          },
        ),
      (error) => {
        assert.equal(error instanceof PipelineStageError, true);
        assert.equal(error.stage, "DETECT_SOURCE_SCHEMA");
        assert.equal(error.code, "SOURCE_SCHEMA_UNKNOWN");
        return true;
      },
    );
  });
});
