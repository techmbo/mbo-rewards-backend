/**
 * Pointer 24 — Ops guide for AI-assisted network integration tasks.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AI_TASK_REQUIRED_INPUTS,
  CONTRACT_POINTER,
  NETWORK_PLUG_IN_LAYERS,
  fixtureBundleDir,
  loadAiIntegrationFixtureBundle,
} from "./aiAssistedDevelopment.contract.js";
import {
  NETWORK_INTEGRATION_OBJECT_SEQUENCE,
  resolveSequenceRank,
  resolveSequenceStage,
} from "./networkIntegrationSequence.js";
import { getSourceObject, listSourceObjectCatalog } from "./sourceObjects.catalog.js";
import { buildMappingVersionId } from "../mapping/mappingRegistry.contract.js";
import { buildNetworkOpsAiSystemInstructionGuide } from "./networkOpsAiSystemInstruction.contract.js";
import { buildEngineeringSourceOfTruthGuide } from "./engineeringSourceOfTruth.contract.js";
import { buildTwoAuthorityRuleGuide } from "./twoAuthorityRule.contract.js";
import { buildSyncResilienceGuide } from "./syncResilience.contract.js";
import { buildIdentifierCurrencyTimeGuide } from "./identifierCurrencyTime.contract.js";
import { buildManualChangeAuditControlGuide } from "./manualChangeAuditControl.contract.js";
import { buildCommercialCalculationSequencingGuide } from "./commercialCalculationSequencing.contract.js";
import { buildSecurityFixtureRulesGuide } from "./securityFixtureRules.contract.js";
import { buildAllNetworkDataInspectionLayerGuide } from "./allNetworkDataInspectionLayer.contract.js";
import { buildEngineeringBuildOrderGuide } from "./engineeringBuildOrder.contract.js";
import { buildOneNetworkAtATimeGuide } from "./oneNetworkAtATime.contract.js";
import { buildAiGoldenRuleGuide } from "./aiGoldenRule.contract.js";
import { buildSupplierCommissionFlatteningGuide } from "./supplierCommissionFlattening.contract.js";
import { buildSupplierCommissionConditionsGuide } from "./supplierCommissionConditions.contract.js";
import { buildCampaignCommissionSummaryGuide } from "./campaignCommissionSummary.contract.js";
import { buildSupplierCommissionOrderDetectionGuide } from "./supplierCommissionOrderDetection.contract.js";
import { buildExpectedVsActualSupplierCommissionGuide } from "./expectedVsActualSupplierCommission.contract.js";
import { buildClientCommissionDetectionGuide } from "./clientCommissionDetection.contract.js";
import { buildPayableEligibilitySeparationGuide } from "./payableEligibilitySeparation.contract.js";
import { buildCommissionHistoryRuleGuide } from "./commissionHistoryRule.contract.js";
import { SourceObjectDefinitionOfDoneService } from "./sourceObjectDefinitionOfDone.service.js";

const INPUT_LABELS = Object.freeze({
  targetContract: "Exact MBO target object/field contract",
  sourceFixture: "One real/sanitized source API fixture",
  mappingRows: "Approved mapping rows",
  expectedCanonical: "Expected canonical output",
  testCases: "Test cases",
});

export function buildTargetContractRef({
  network,
  sourceObject,
  mboTargetObject,
  mappingVersion = "1",
} = {}) {
  const net = String(network || "").toLowerCase();
  const obj = String(sourceObject || "").toLowerCase();
  const stage = resolveSequenceStage(obj);
  return {
    contractPointer: CONTRACT_POINTER,
    mboTargetObject: mboTargetObject || stage?.mboTargetObject || null,
    contractRef: "mboCanonicalObjects.contract.js",
    mappingRegistryRef: `network-mappings/${net}/${obj}.mapping.json`,
    mappingVersion: buildMappingVersionId(network, sourceObject, mappingVersion),
    sequenceRank: resolveSequenceRank(obj),
    sequenceStage: stage?.stage || null,
  };
}

export class AiIntegrationGuideService {
  constructor(deps = {}) {
    this.definitionOfDoneService = deps.definitionOfDoneService ?? new SourceObjectDefinitionOfDoneService();
  }
  getSystemInstructionGuide() {
    return {
      ...buildNetworkOpsAiSystemInstructionGuide(),
      sourceOfTruthHierarchy: buildEngineeringSourceOfTruthGuide(),
      twoAuthorityRule: buildTwoAuthorityRuleGuide(),
      syncResilienceRequirements: buildSyncResilienceGuide(),
      identifierCurrencyTimeRules: buildIdentifierCurrencyTimeGuide(),
      manualChangeAuditControl: buildManualChangeAuditControlGuide(),
      commercialCalculationSequencing: buildCommercialCalculationSequencingGuide(),
      securityFixtureRules: buildSecurityFixtureRulesGuide(),
      allNetworkDataInspectionLayer: buildAllNetworkDataInspectionLayerGuide(),
      engineeringBuildOrder: buildEngineeringBuildOrderGuide(),
      oneNetworkAtATimeDelivery: buildOneNetworkAtATimeGuide(),
      aiGoldenRule: buildAiGoldenRuleGuide(),
      supplierCommissionFlattening: buildSupplierCommissionFlatteningGuide(),
      supplierCommissionConditions: buildSupplierCommissionConditionsGuide(),
      campaignCommissionSummary: buildCampaignCommissionSummaryGuide(),
      supplierCommissionOrderDetection: buildSupplierCommissionOrderDetectionGuide(),
      expectedVsActualSupplierCommission: buildExpectedVsActualSupplierCommissionGuide(),
      clientCommissionDetection: buildClientCommissionDetectionGuide(),
      payableEligibilitySeparationPointer: 44,
      payableEligibilitySeparation: buildPayableEligibilitySeparationGuide(),
      commissionHistoryRulePointer: 45,
      commissionHistoryRule: buildCommissionHistoryRuleGuide(),
    };
  }

  getGlobalGuide() {
    const instruction = buildNetworkOpsAiSystemInstructionGuide();
    return {
      contractPointer: CONTRACT_POINTER,
      systemInstructionRef: instruction.systemInstructionRef,
      systemInstructionPointer: instruction.contractPointer,
      sourceOfTruthPointer: 27,
      sourceOfTruthHierarchy: buildEngineeringSourceOfTruthGuide(),
      twoAuthorityPointer: 28,
      twoAuthorityRule: buildTwoAuthorityRuleGuide(),
      syncResiliencePointer: 29,
      syncResilienceRequirements: buildSyncResilienceGuide(),
      identifierCurrencyTimePointer: 30,
      identifierCurrencyTimeRules: buildIdentifierCurrencyTimeGuide(),
      manualChangeAuditPointer: 31,
      manualChangeAuditControl: buildManualChangeAuditControlGuide(),
      commercialSequencingPointer: 32,
      commercialCalculationSequencing: buildCommercialCalculationSequencingGuide(),
      securityFixturePointer: 33,
      securityFixtureRules: buildSecurityFixtureRulesGuide(),
      allNetworkDataInspectionPointer: 34,
      allNetworkDataInspectionLayer: buildAllNetworkDataInspectionLayerGuide(),
      engineeringBuildOrderPointer: 35,
      engineeringBuildOrder: buildEngineeringBuildOrderGuide(),
      oneNetworkAtATimePointer: 36,
      oneNetworkAtATimeDelivery: buildOneNetworkAtATimeGuide(),
      aiGoldenRulePointer: 37,
      aiGoldenRule: buildAiGoldenRuleGuide(),
      supplierCommissionFlatteningPointer: 38,
      supplierCommissionFlattening: buildSupplierCommissionFlatteningGuide(),
      supplierCommissionConditionsPointer: 39,
      supplierCommissionConditions: buildSupplierCommissionConditionsGuide(),
      campaignCommissionSummaryPointer: 40,
      campaignCommissionSummary: buildCampaignCommissionSummaryGuide(),
      supplierCommissionOrderDetectionPointer: 41,
      supplierCommissionOrderDetection: buildSupplierCommissionOrderDetectionGuide(),
      expectedVsActualSupplierCommissionPointer: 42,
      expectedVsActualSupplierCommission: buildExpectedVsActualSupplierCommissionGuide(),
      clientCommissionDetectionPointer: 43,
      clientCommissionDetection: buildClientCommissionDetectionGuide(),
      payableEligibilitySeparationPointer: 44,
      payableEligibilitySeparation: buildPayableEligibilitySeparationGuide(),
      commissionHistoryRulePointer: 45,
      commissionHistoryRule: buildCommissionHistoryRuleGuide(),
      principle: "Use AI only as an implementation assistant. Architecture and canonical naming are fixed by MBO.",
      scopeRule:
        "Implement and validate one network + one source object at a time. Do not integrate all networks in one task.",
      requiredInputs: AI_TASK_REQUIRED_INPUTS.map((key) => ({
        key,
        label: INPUT_LABELS[key],
      })),
      recommendedSequence: [...NETWORK_INTEGRATION_OBJECT_SEQUENCE],
      plugInLayers: [...NETWORK_PLUG_IN_LAYERS],
      fixtureLayout: "platform_backend/test/fixtures/networks/{network}/{sourceObject}/",
      systemInstruction: instruction.systemInstruction,
      prohibitions: instruction.prohibitions,
      nonCollapsibleCanonicalObjects: instruction.nonCollapsibleCanonicalObjects,
      pipelineNarrative: instruction.pipelineNarrative,
      runtimePipelineStages: instruction.runtimePipelineStages,
      mappingOutcomeRules: instruction.mappingOutcomeRules,
    };
  }

  getNetworkGuide(network) {
    const family = String(network || "").toLowerCase();
    const catalog = listSourceObjectCatalog(family);
    const objects = catalog
      .map((entry) => ({
        ...entry,
        sequenceRank: entry.sequenceRank ?? resolveSequenceRank(entry.sourceObject, entry.entityType),
        sequenceStage: resolveSequenceStage(entry.sourceObject, entry.entityType),
        mappingFile: `platform_backend/src/network-mappings/${family}/${entry.sourceObject}.mapping.json`,
        mappingVersion: buildMappingVersionId(family, entry.sourceObject, "1"),
        hasFixtureBundle: existsSync(join(fixtureBundleDir(family, entry.sourceObject), "manifest.json")),
      }))
      .sort((a, b) => {
        const ra = a.sequenceRank ?? 99;
        const rb = b.sequenceRank ?? 99;
        if (ra !== rb) return ra - rb;
        return String(a.sourceObject).localeCompare(String(b.sourceObject));
      });

    return {
      ...this.getGlobalGuide(),
      network: family,
      sourceObjects: objects,
    };
  }

  getObjectGuide(network, sourceObject) {
    const family = String(network || "").toLowerCase();
    const obj = String(sourceObject || "").toLowerCase();
    const catalogEntry = getSourceObject(family, obj);
    if (!catalogEntry) {
      return null;
    }

    const targetContract = buildTargetContractRef({
      network: family,
      sourceObject: obj,
      mboTargetObject: resolveSequenceStage(obj, catalogEntry.entityType)?.mboTargetObject,
    });

    const dir = fixtureBundleDir(family, obj);
    const hasFixtureBundle = existsSync(join(dir, "manifest.json"));

    let exemplarBundle = null;
    if (hasFixtureBundle) {
      try {
        exemplarBundle = loadAiIntegrationFixtureBundle(family, obj);
      } catch {
        exemplarBundle = null;
      }
    }

    return {
      ...this.getGlobalGuide(),
      network: family,
      sourceObject: obj,
      catalogEntry,
      sequenceRank: catalogEntry.sequenceRank ?? resolveSequenceRank(obj, catalogEntry.entityType),
      sequenceStage: resolveSequenceStage(obj, catalogEntry.entityType),
      targetContract,
      sourceOfTruthHierarchy: buildEngineeringSourceOfTruthGuide({ network: family, sourceObject: obj }),
      twoAuthorityRule: buildTwoAuthorityRuleGuide({ network: family, sourceObject: obj }),
      syncResilienceRequirements: buildSyncResilienceGuide({ network: family, sourceObject: obj }),
      identifierCurrencyTimeRules: buildIdentifierCurrencyTimeGuide({ network: family, sourceObject: obj }),
      manualChangeAuditControl: buildManualChangeAuditControlGuide({ network: family, sourceObject: obj }),
      commercialCalculationSequencing: buildCommercialCalculationSequencingGuide({ network: family, sourceObject: obj }),
      securityFixtureRules: buildSecurityFixtureRulesGuide({ network: family, sourceObject: obj }),
      allNetworkDataInspectionLayer: buildAllNetworkDataInspectionLayerGuide({ network: family, sourceObject: obj }),
      engineeringBuildOrder: buildEngineeringBuildOrderGuide({ network: family, sourceObject: obj }),
      oneNetworkAtATimeDelivery: buildOneNetworkAtATimeGuide({ network: family, sourceObject: obj }),
      aiGoldenRule: buildAiGoldenRuleGuide({ network: family, sourceObject: obj }),
      supplierCommissionFlattening: buildSupplierCommissionFlatteningGuide({ network: family, sourceObject: obj }),
      supplierCommissionConditions: buildSupplierCommissionConditionsGuide({ network: family, sourceObject: obj }),
      campaignCommissionSummary: buildCampaignCommissionSummaryGuide({ network: family, sourceObject: obj }),
      supplierCommissionOrderDetection: buildSupplierCommissionOrderDetectionGuide({ network: family, sourceObject: obj }),
      expectedVsActualSupplierCommission: buildExpectedVsActualSupplierCommissionGuide({ network: family, sourceObject: obj }),
      clientCommissionDetection: buildClientCommissionDetectionGuide({ network: family, sourceObject: obj }),
      payableEligibilitySeparation: buildPayableEligibilitySeparationGuide({ network: family, sourceObject: obj }),
      commissionHistoryRule: buildCommissionHistoryRuleGuide({ network: family, sourceObject: obj }),
      definitionOfDone: this.definitionOfDoneService.evaluate(family, obj, {
        catalogEntry,
        bundle: exemplarBundle,
      }),
      checklist: AI_TASK_REQUIRED_INPUTS.map((key) => ({
        key,
        label: INPUT_LABELS[key],
        satisfied: Boolean(
          key === "targetContract" ? targetContract?.mboTargetObject : exemplarBundle?.[key],
        ),
      })),
      paths: {
        mappingFile: `platform_backend/src/network-mappings/${family}/${obj}.mapping.json`,
        fixtureDir: `platform_backend/test/fixtures/networks/${family}/${obj}/`,
        testTemplate: `platform_backend/test/p24.${family}.${obj}.integration.test.js`,
      },
      exemplarBundle: exemplarBundle
        ? {
            hasManifest: true,
            targetContract: exemplarBundle.targetContract,
            testCases: exemplarBundle.testCases,
          }
        : { hasManifest: false },
    };
  }
}
