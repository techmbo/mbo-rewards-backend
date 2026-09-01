/**
 * Pointer 34 — All Network Data view is not a new schema.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  CONTRACT_POINTER,
  FORBIDDEN_INSPECTION_ACTIONS,
  INSPECTION_LAYER_SUMMARY,
  AllNetworkDataInspectionLayerError,
  applyAllNetworkDataInspectionLayerContract,
  assertExtraFieldsRemainSourceOnly,
  assertNoSchemaMutationFromInspectionView,
  assertViewOnlyColumnSelection,
  buildAllNetworkDataInspectionLayerGuide,
  classifyInspectionColumnKeys,
} from "../src/modules/networkOps/allNetworkDataInspectionLayer.contract.js";
import { VIEW_MODE } from "../src/modules/ops/allNetworkData.contract.js";
import { FIELD_MAPPING_OUTCOME } from "../src/modules/mapping/mappingOutcome.contract.js";
import { AiIntegrationGuideService } from "../src/modules/networkOps/aiIntegrationGuide.service.js";
import { apiRequest, startTestServer } from "./helpers/httpClient.js";

describe("Pointer 34 — allNetworkDataInspectionLayer.contract", () => {
  it("declares contract pointer 34 and inspection-layer rules", () => {
    assert.equal(CONTRACT_POINTER, 34);
    assert.match(INSPECTION_LAYER_SUMMARY.layerRole, /inspection layer only/i);
    assert.match(INSPECTION_LAYER_SUMMARY.viewNotSchema, /changes the view, not the canonical model/i);
    assert.match(INSPECTION_LAYER_SUMMARY.sourceOnlyRetention, /SOURCE_ONLY/);
    assert.match(INSPECTION_LAYER_SUMMARY.promotionGate, /canonical-governance process/i);
    assert.ok(FORBIDDEN_INSPECTION_ACTIONS.includes("auto_promote_source_field"));
    assert.ok(FORBIDDEN_INSPECTION_ACTIONS.includes("mutate_canonical_model"));
  });

  it("assertViewOnlyColumnSelection rejects canonical or mapping mutation from view", () => {
    assert.doesNotThrow(() =>
      assertViewOnlyColumnSelection({
        viewMode: VIEW_MODE.CUSTOM,
        selectedKeys: ["brand", "source:networkProprietaryField"],
      }),
    );
    assert.throws(
      () =>
        assertViewOnlyColumnSelection({
          viewMode: VIEW_MODE.ALL_COLUMNS,
          selectedKeys: ["source:extraField"],
          canonicalMutated: true,
        }),
      (err) => {
        assert.equal(err.code, "CANONICAL_MODEL_MUTATED_FROM_VIEW");
        return true;
      },
    );
    assert.throws(
      () =>
        assertViewOnlyColumnSelection({
          viewMode: VIEW_MODE.CUSTOM,
          mappingPromoted: true,
        }),
      (err) => {
        assert.equal(err.code, "MAPPING_PROMOTED_FROM_VIEW");
        return true;
      },
    );
  });

  it("assertExtraFieldsRemainSourceOnly rejects promoted outcomes", () => {
    assert.doesNotThrow(() =>
      assertExtraFieldsRemainSourceOnly({
        fieldKeys: ["source:extraField", "source:anotherField"],
        mappingOutcomes: {
          "source:extraField": FIELD_MAPPING_OUTCOME.SOURCE_ONLY,
        },
      }),
    );
    assert.throws(
      () =>
        assertExtraFieldsRemainSourceOnly({
          fieldKeys: ["source:extraField"],
          mappingOutcomes: {
            "source:extraField": FIELD_MAPPING_OUTCOME.MAPPED,
          },
        }),
      (err) => {
        assert.equal(err.code, "EXTRA_FIELD_NOT_SOURCE_ONLY");
        return true;
      },
    );
  });

  it("assertNoSchemaMutationFromInspectionView rejects schema creation and auto-promotion", () => {
    assert.doesNotThrow(() =>
      assertNoSchemaMutationFromInspectionView({
        action: "select_custom_columns",
        mutatesCanonicalModel: false,
      }),
    );
    assert.throws(
      () =>
        assertNoSchemaMutationFromInspectionView({
          action: "select_custom_columns",
          autoPromotesSourceField: true,
        }),
      (err) => {
        assert.equal(err.code, "AUTO_PROMOTION_FROM_INSPECTION_VIEW");
        return true;
      },
    );
    assert.throws(
      () =>
        assertNoSchemaMutationFromInspectionView({
          action: "save_view",
          persistsViewAsSchema: true,
        }),
      (err) => {
        assert.equal(err.code, "VIEW_PERSISTED_AS_SCHEMA");
        return true;
      },
    );
  });

  it("classifyInspectionColumnKeys separates canonical and source-only keys", () => {
    const result = classifyInspectionColumnKeys([
      "brand",
      "campaign",
      "source:networkProprietaryField",
    ]);
    assert.deepEqual(result.canonicalKeys, ["brand", "campaign"]);
    assert.deepEqual(result.sourceOnlyKeys, ["source:networkProprietaryField"]);
    assert.equal(result.extraFieldOutcome, FIELD_MAPPING_OUTCOME.SOURCE_ONLY);
    assert.equal(result.mutatesCanonicalModel, false);
  });

  it("buildAllNetworkDataInspectionLayerGuide includes scoped object refs", () => {
    const globalGuide = buildAllNetworkDataInspectionLayerGuide();
    assert.equal(globalGuide.contractPointer, 34);
    assert.equal(globalGuide.pointer22CrossRef.contractPointer, 22);

    const objectGuide = buildAllNetworkDataInspectionLayerGuide({
      network: "optimise",
      sourceObject: "campaigns",
    });
    assert.equal(objectGuide.objectRefs.network, "optimise");
    assert.match(objectGuide.objectRefs.allNetworkDataPage, /AllNetworkDataPage\.jsx/);
  });

  it("applyAllNetworkDataInspectionLayerContract stamps response meta", () => {
    const wrapped = applyAllNetworkDataInspectionLayerContract(
      { ok: true, data: {} },
      { network: "optimise", sourceObject: "campaigns" },
    );
    assert.equal(wrapped.meta.allNetworkDataInspectionPointer, 34);
    assert.equal(wrapped.meta.allNetworkDataInspectionNetwork, "optimise");
  });
});

describe("Pointer 34 — AI integration guide includes all network data inspection layer", () => {
  const guide = new AiIntegrationGuideService();

  it("global guide exposes allNetworkDataInspectionLayer", () => {
    const payload = guide.getGlobalGuide();
    assert.equal(payload.allNetworkDataInspectionPointer, 34);
    assert.equal(payload.allNetworkDataInspectionLayer.contractPointer, 34);
    assert.match(
      payload.allNetworkDataInspectionLayer.summary.viewNotSchema,
      /changes the view, not the canonical model/i,
    );
  });

  it("object guide includes scoped inspection-layer refs", () => {
    const payload = guide.getObjectGuide("optimise", "campaigns");
    assert.equal(payload.allNetworkDataInspectionLayer.contractPointer, 34);
    assert.match(payload.allNetworkDataInspectionLayer.objectRefs.columnCatalog, /allNetworkData\.contract\.js/);
  });
});

describe("Pointer 34 — GET /ops/network/ai-integration-guide", () => {
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
