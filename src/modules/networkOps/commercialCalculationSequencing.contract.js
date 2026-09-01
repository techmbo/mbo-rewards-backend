/**
 * Pointer 32 — Commercial calculation sequencing.
 * Network adapters report source facts only; client commercial logic runs in MBO sequence.
 */
import { ATTRIBUTION_PRIORITY } from "../reporting/attributionLogic.contract.js";
import { SYNC_OBS_STATUS } from "./syncObservability.contract.js";

export const CONTRACT_POINTER = 32;

export const COMMERCIAL_SEQUENCING_SUMMARY = Object.freeze({
  adapterBoundary:
    "Network adapters report source facts only. Client commercial logic must not live inside adapters.",
  attributionGate:
    "Do not calculate client commission before attribution is resolved. Unknown or ambiguous attribution must become REVIEW_REQUIRED.",
  perRecordFailureRule:
    "A failure on one record must not stop the entire sync. Preserve the affected record, create the correct exception/status, continue processing valid records, and quarantine only the affected record when required.",
});

/** Required commercial calculation sequence — order is mandatory. */
export const COMMERCIAL_CALCULATION_SEQUENCE = Object.freeze([
  {
    rank: 1,
    key: "conversion_order",
    label: "Conversion/Order",
    stage: "IDEMPOTENT_UPSERT",
    enforcedBy: ["order/orderIngestion.service.js", "networkOps/pipeline/ingestSourceRecord.js"],
  },
  {
    rank: 2,
    key: "mbo_campaign",
    label: "MBO Campaign",
    stage: "NORMALIZE_CANONICAL",
    enforcedBy: ["ops/campaignNormalization.service.js", "mapping/mboCanonicalObjects.contract.js"],
  },
  {
    rank: 3,
    key: "attribution",
    label: "Attribution",
    stage: "RESOLVE_ATTRIBUTION",
    enforcedBy: ["reporting/services/attribution.service.js", "reporting/attributionLogic.contract.js"],
  },
  {
    rank: 4,
    key: "client_campaign_assignment",
    label: "Client Campaign Assignment",
    stage: "RESOLVE_ATTRIBUTION",
    enforcedBy: ["client/services/clientAssignment.service.js", "client/repositories/clientCampaignAssignment.repository.js"],
  },
  {
    rank: 5,
    key: "client_commercial_rule",
    label: "Applicable Client Commercial Rule",
    stage: "APPLY_COMMERCIAL_RULES",
    enforcedBy: ["commercial/commercialRuleEngine.js", "commercial/supplierCommissionRuleSync.service.js"],
  },
  {
    rank: 6,
    key: "client_commission",
    label: "Client Commission",
    stage: "APPLY_COMMERCIAL_RULES",
    enforcedBy: ["commercial/commercialRuleEngine.js", "reporting/attributionMath.js"],
  },
  {
    rank: 7,
    key: "mbo_commission_margin",
    label: "MBO Commission/Margin",
    stage: "APPLY_COMMERCIAL_RULES",
    enforcedBy: ["finance/financialTransaction.service.js", "finance/commissionCalculation.service.js"],
  },
]);

export const COMMERCIAL_SEQUENCE_STEP_KEYS = Object.freeze(
  COMMERCIAL_CALCULATION_SEQUENCE.map((step) => step.key),
);

export const ATTRIBUTION_UNRESOLVED_STATUSES = Object.freeze([
  "REVIEW_REQUIRED",
  "PENDING",
  "ORPHAN",
  "UNATTRIBUTED",
]);

export const PER_RECORD_FAILURE_HANDLING = Object.freeze({
  stopEntireSync: false,
  preserveAffectedRecord: true,
  createExceptionOrStatus: true,
  continueValidRecords: true,
  quarantineScope: "affected_record_only",
  partialSyncStatus: SYNC_OBS_STATUS.PARTIAL,
});

export class CommercialCalculationSequencingError extends Error {
  constructor(message, { code = "COMMERCIAL_SEQUENCING_VIOLATION", details = null } = {}) {
    super(message);
    this.name = "CommercialCalculationSequencingError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

function stepIndex(key) {
  return COMMERCIAL_SEQUENCE_STEP_KEYS.indexOf(String(key || ""));
}

/**
 * Assert commercial steps execute in required order.
 */
export function assertCommercialSequenceOrder({ completedSteps = [] } = {}) {
  const steps = Array.isArray(completedSteps) ? completedSteps : [];
  let lastRank = 0;
  for (const key of steps) {
    const idx = stepIndex(key);
    if (idx < 0) {
      throw new CommercialCalculationSequencingError(`Unknown commercial sequence step: ${key}`, {
        code: "UNKNOWN_COMMERCIAL_STEP",
        details: { key, completedSteps: steps },
      });
    }
    const rank = COMMERCIAL_CALCULATION_SEQUENCE[idx].rank;
    if (rank < lastRank) {
      throw new CommercialCalculationSequencingError(
        `Commercial step out of order: ${key} cannot run before prior sequence stages.`,
        {
          code: "COMMERCIAL_SEQUENCE_OUT_OF_ORDER",
          details: { key, rank, lastRank, completedSteps: steps },
        },
      );
    }
    lastRank = rank;
  }
  return true;
}

/**
 * Assert client commission is not calculated before attribution is resolved.
 */
export function assertAttributionBeforeCommission({
  attributionStatus = null,
  attributionResolved = null,
  commissionCalculated = false,
  inAdapter = false,
} = {}) {
  if (inAdapter) {
    throw new CommercialCalculationSequencingError(
      "Client commercial logic must not live inside network adapters.",
      {
        code: "COMMERCIAL_LOGIC_IN_ADAPTER",
        details: { attributionStatus, commissionCalculated },
      },
    );
  }

  const status = String(attributionStatus || "").toUpperCase();
  const unresolved =
    attributionResolved === false ||
    ATTRIBUTION_UNRESOLVED_STATUSES.includes(status) ||
    status === "REVIEW_REQUIRED";

  if (commissionCalculated && unresolved) {
    throw new CommercialCalculationSequencingError(
      "Do not calculate client commission before attribution is resolved.",
      {
        code: "COMMISSION_BEFORE_ATTRIBUTION",
        details: { attributionStatus: status, commissionCalculated },
      },
    );
  }

  if (
    (status === "AMBIGUOUS" || status === "UNKNOWN") &&
    status !== "REVIEW_REQUIRED" &&
    commissionCalculated
  ) {
    throw new CommercialCalculationSequencingError(
      "Unknown or ambiguous attribution must become REVIEW_REQUIRED before commission.",
      {
        code: "AMBIGUOUS_ATTRIBUTION_NOT_REVIEW_REQUIRED",
        details: { attributionStatus: status },
      },
    );
  }

  return true;
}

/**
 * Assert ambiguous attribution is routed to REVIEW_REQUIRED.
 */
export function assertAmbiguousAttributionReviewRequired({ attributionStatus, ambiguous = false } = {}) {
  if (ambiguous && String(attributionStatus || "").toUpperCase() !== "REVIEW_REQUIRED") {
    throw new CommercialCalculationSequencingError(
      "Unknown or ambiguous attribution must become REVIEW_REQUIRED.",
      {
        code: "AMBIGUOUS_ATTRIBUTION_NOT_REVIEW_REQUIRED",
        details: { attributionStatus, ambiguous },
      },
    );
  }
  return true;
}

/**
 * Assert one record failure does not abort the entire sync batch.
 */
export function assertPerRecordFailureIsolation({
  recordFailed = false,
  syncAborted = false,
  recordPreserved = true,
  exceptionCreated = true,
  validRecordsContinued = true,
  quarantinedScope = "none",
} = {}) {
  if (recordFailed && syncAborted) {
    throw new CommercialCalculationSequencingError(
      "A failure on one record must not stop the entire sync.",
      {
        code: "SYNC_ABORTED_ON_SINGLE_RECORD",
        details: { recordFailed, syncAborted },
      },
    );
  }

  if (recordFailed && !recordPreserved) {
    throw new CommercialCalculationSequencingError(
      "Affected records must be preserved when commercial processing fails.",
      {
        code: "AFFECTED_RECORD_NOT_PRESERVED",
        details: { recordFailed, recordPreserved },
      },
    );
  }

  if (recordFailed && !exceptionCreated) {
    throw new CommercialCalculationSequencingError(
      "Affected records must create the correct exception/status on failure.",
      {
        code: "EXCEPTION_NOT_CREATED",
        details: { recordFailed, exceptionCreated },
      },
    );
  }

  if (recordFailed && !validRecordsContinued) {
    throw new CommercialCalculationSequencingError(
      "Valid records must continue processing when one record fails.",
      {
        code: "VALID_RECORDS_NOT_CONTINUED",
        details: { recordFailed, validRecordsContinued },
      },
    );
  }

  if (recordFailed && quarantinedScope === "entire_sync") {
    throw new CommercialCalculationSequencingError(
      "Quarantine only the affected record — not the entire sync.",
      {
        code: "OVERBROAD_QUARANTINE",
        details: { quarantinedScope },
      },
    );
  }

  return true;
}

export function buildCommercialCalculationSequencingGuide({ network = null, sourceObject = null } = {}) {
  const guide = {
    contractPointer: CONTRACT_POINTER,
    summary: { ...COMMERCIAL_SEQUENCING_SUMMARY },
    sequence: COMMERCIAL_CALCULATION_SEQUENCE.map((step) => ({ ...step })),
    attributionPriority: { ...ATTRIBUTION_PRIORITY },
    attributionUnresolvedStatuses: [...ATTRIBUTION_UNRESOLVED_STATUSES],
    perRecordFailureHandling: { ...PER_RECORD_FAILURE_HANDLING },
    runtimeRefs: Object.freeze({
      ingestPipeline: "networkOps/pipeline/ingestSourceRecord.js",
      attributionService: "reporting/services/attribution.service.js",
      commercialEngine: "commercial/commercialRuleEngine.js",
      sourceObjectSync: "networkOps/sourceObjectSync.service.js",
    }),
  };

  if (network && sourceObject) {
    guide.objectRefs = Object.freeze({
      ingestPipeline: "networkOps/pipeline/ingestSourceRecord.js",
      attributionContract: "reporting/attributionLogic.contract.js",
      commercialEngine: "commercial/commercialRuleEngine.js",
      network: String(network).toLowerCase(),
      sourceObject: String(sourceObject).toLowerCase(),
    });
  }

  return guide;
}

export function applyCommercialCalculationSequencingContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    commercialSequencingPointer: CONTRACT_POINTER,
    commercialSequencingNetwork: network || null,
    commercialSequencingSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}
