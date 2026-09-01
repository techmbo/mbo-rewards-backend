import { ok } from "../core/apiResponse.js";
import { applyAiIntegrationContract } from "../modules/networkOps/aiAssistedDevelopment.contract.js";
import { applyAiSystemInstructionContract } from "../modules/networkOps/networkOpsAiSystemInstruction.contract.js";
import { applySourceObjectDefinitionOfDoneContract } from "../modules/networkOps/sourceObjectDefinitionOfDone.contract.js";
import { applyEngineeringSourceOfTruthContract } from "../modules/networkOps/engineeringSourceOfTruth.contract.js";
import { applyTwoAuthorityRuleContract } from "../modules/networkOps/twoAuthorityRule.contract.js";
import { applySyncResilienceContract } from "../modules/networkOps/syncResilience.contract.js";
import { applyIdentifierCurrencyTimeContract } from "../modules/networkOps/identifierCurrencyTime.contract.js";
import { applyManualChangeAuditControlContract } from "../modules/networkOps/manualChangeAuditControl.contract.js";
import { applyCommercialCalculationSequencingContract } from "../modules/networkOps/commercialCalculationSequencing.contract.js";
import { applySecurityFixtureRulesContract } from "../modules/networkOps/securityFixtureRules.contract.js";
import { applyAllNetworkDataInspectionLayerContract } from "../modules/networkOps/allNetworkDataInspectionLayer.contract.js";
import { applyEngineeringBuildOrderContract } from "../modules/networkOps/engineeringBuildOrder.contract.js";
import { applyOneNetworkAtATimeContract } from "../modules/networkOps/oneNetworkAtATime.contract.js";
import { applyAiGoldenRuleContract } from "../modules/networkOps/aiGoldenRule.contract.js";
import { applySupplierCommissionFlatteningContract } from "../modules/networkOps/supplierCommissionFlattening.contract.js";
import { applySupplierCommissionConditionsContract } from "../modules/networkOps/supplierCommissionConditions.contract.js";
import { applyCampaignCommissionSummaryContract } from "../modules/networkOps/campaignCommissionSummary.contract.js";
import { applySupplierCommissionOrderDetectionContract } from "../modules/networkOps/supplierCommissionOrderDetection.contract.js";
import { applyExpectedVsActualSupplierCommissionContract } from "../modules/networkOps/expectedVsActualSupplierCommission.contract.js";
import { applyClientCommissionDetectionContract } from "../modules/networkOps/clientCommissionDetection.contract.js";
import { applyPayableEligibilitySeparationContract } from "../modules/networkOps/payableEligibilitySeparation.contract.js";
import { applyCommissionHistoryRuleContract } from "../modules/networkOps/commissionHistoryRule.contract.js";
import { AiIntegrationGuideService } from "../modules/networkOps/aiIntegrationGuide.service.js";

const service = new AiIntegrationGuideService();

function sendAiGuideJson(res, payload, { network, sourceObject } = {}) {
  const opts = { network, sourceObject };
  res.json(
    applyCommissionHistoryRuleContract(
      applyPayableEligibilitySeparationContract(
        applyClientCommissionDetectionContract(
        applyExpectedVsActualSupplierCommissionContract(
        applySupplierCommissionOrderDetectionContract(
          applyCampaignCommissionSummaryContract(
          applySupplierCommissionConditionsContract(
            applySupplierCommissionFlatteningContract(
              applyAiGoldenRuleContract(
                applyOneNetworkAtATimeContract(
                  applyEngineeringBuildOrderContract(
                    applyAllNetworkDataInspectionLayerContract(
                      applySecurityFixtureRulesContract(
                        applyCommercialCalculationSequencingContract(
                          applyManualChangeAuditControlContract(
                            applyIdentifierCurrencyTimeContract(
                              applySyncResilienceContract(
                                applyTwoAuthorityRuleContract(
                                  applyEngineeringSourceOfTruthContract(
                                    applySourceObjectDefinitionOfDoneContract(
                                      applyAiSystemInstructionContract(applyAiIntegrationContract(ok(payload), opts), opts),
                                      opts,
                                    ),
                                    opts,
                                  ),
                                  opts,
                                ),
                                opts,
                              ),
                              opts,
                            ),
                            opts,
                          ),
                          opts,
                        ),
                        opts,
                      ),
                      opts,
                    ),
                    opts,
                  ),
                  opts,
                ),
                opts,
              ),
              opts,
            ),
            opts,
          ),
          opts,
        ),
        opts,
      ),
      opts,
    ),
    opts,
  ),
  opts,
),
opts,
),
);
}

export async function aiIntegrationGuideHandler(req, res, next) {
  try {
    const network = req.query.network ? String(req.query.network) : null;
    const sourceObject = req.query.sourceObject ? String(req.query.sourceObject) : null;
    const instructionOnly = String(req.query.instruction || "") === "1";

    if (instructionOnly) {
      sendAiGuideJson(res, service.getSystemInstructionGuide(), { network, sourceObject });
      return;
    }

    let payload;
    if (network && sourceObject) {
      payload = service.getObjectGuide(network, sourceObject);
      if (!payload) {
        res.status(404).json({ ok: false, message: "Unknown network source object." });
        return;
      }
    } else if (network) {
      payload = service.getNetworkGuide(network);
    } else {
      payload = service.getGlobalGuide();
    }

    sendAiGuideJson(res, payload, { network, sourceObject });
  } catch (error) {
    next(error);
  }
}
