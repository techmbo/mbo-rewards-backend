/**
 * Imported Records operational contract — truthful status from Entity + joins.
 * Never invent MAPPED without SupplierCampaign (and for campaigns, CampaignSource when merchant-linked).
 */

export const SOURCE_STATUS = {
  IMPORTED: "IMPORTED",
  PROCESSED: "PROCESSED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
};

export const MAPPING_STATUS = {
  MAPPED: "MAPPED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  ERROR: "ERROR",
  NOT_AVAILABLE: "NOT_AVAILABLE",
};

export const PIPELINE_STAGE_STATE = {
  COMPLETED: "COMPLETED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  BLOCKED: "BLOCKED",
  PENDING: "PENDING",
};

/** Record types the platform actually stores on Entity today. Product uses /ops/products. */
export const SUPPORTED_RECORD_TYPES = ["campaign", "coupon", "performance", "product"];

const SENSITIVE_KEY =
  /password|secret|token|api[_-]?key|authorization|access[_-]?key|refresh[_-]?token|credential|private[_-]?key/i;

export function stripSensitivePayload(value, depth = 0) {
  if (value == null || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => stripSensitivePayload(item, depth + 1));
  if (typeof value !== "object") return value;

  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    next[key] = stripSensitivePayload(child, depth + 1);
  }
  return next;
}

export function displayNetwork(networkSource) {
  if (!networkSource) return null;
  const key = String(networkSource).toLowerCase();
  if (key.startsWith("optimise")) return "Optimise";
  if (key === "trackier" || key === "vcommission") return "Trackier";
  if (key === "boostiny") return "Boostiny";
  if (key === "impact") return "Impact";
  if (key === "partnerize") return "Partnerize";
  if (key === "awin") return "Awin";
  if (key === "admitad") return "Admitad";
  if (key === "cj" || key === "commissionjunction") return "CJ";
  if (key === "rakuten") return "Rakuten";
  if (key === "manual") return "Manual";
  return networkSource;
}

export function recordTypeLabel(entityType) {
  if (!entityType) return null;
  const t = String(entityType).toLowerCase();
  if (t === "campaign") return "Campaign";
  if (t === "coupon") return "Coupon";
  if (t === "performance") return "Performance";
  if (t === "conversion") return "Conversion";
  return entityType;
}

/**
 * Derive source + mapping status from real joins (not MappingConfig fiction).
 */
const MAPPER_ISSUE_LABELS = {
  PROMOTION_FAILED: "Campaign promotion failed",
  PARENT_CAMPAIGN_NOT_FOUND: "Parent campaign missing",
  MAPPER_ERROR: "Mapper error",
};

function formatMapperIssue(openMapperError) {
  const code = openMapperError.errorCode || "MAPPER_ERROR";
  if (MAPPER_ISSUE_LABELS[code]) return MAPPER_ISSUE_LABELS[code];
  return code.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export function deriveImportedRecordStatuses({
  entityType,
  supplierCampaign = null,
  campaignSource = null,
  openMapperError = null,
  coupon = null,
}) {
  if (openMapperError) {
    return {
      sourceStatus: SOURCE_STATUS.FAILED,
      mappingStatus: MAPPING_STATUS.ERROR,
      issue: formatMapperIssue(openMapperError),
      issueCode: openMapperError.errorCode || "MAPPER_ERROR",
    };
  }

  const type = String(entityType || "").toLowerCase();

  if (type === "performance") {
    return {
      sourceStatus: SOURCE_STATUS.IMPORTED,
      mappingStatus: MAPPING_STATUS.NOT_AVAILABLE,
      issue: "Performance rows are imported; campaign normalization does not promote this type.",
      issueCode: "RECORD_TYPE_NOT_PROMOTED",
    };
  }

  if (type === "coupon") {
    if (coupon?.id) {
      return {
        sourceStatus: SOURCE_STATUS.PROCESSED,
        mappingStatus: MAPPING_STATUS.MAPPED,
        issue: null,
        issueCode: null,
      };
    }
    return {
      sourceStatus: SOURCE_STATUS.IMPORTED,
      mappingStatus: MAPPING_STATUS.NEEDS_REVIEW,
      issue: "Coupon not yet promoted to SupplierCoupon",
      issueCode: "COUPON_NOT_PROMOTED",
    };
  }

  // campaign
  if (!supplierCampaign?.id) {
    return {
      sourceStatus: SOURCE_STATUS.IMPORTED,
      mappingStatus: MAPPING_STATUS.NEEDS_REVIEW,
      issue: "Campaign not yet promoted to SupplierCampaign",
      issueCode: "CAMPAIGN_NOT_PROMOTED",
    };
  }

  if (!supplierCampaign.merchantId) {
    const reason = !supplierCampaign.merchantNameRaw
      ? "Missing merchant identifier on imported record"
      : null;
    return {
      sourceStatus: SOURCE_STATUS.PROCESSED,
      mappingStatus: MAPPING_STATUS.NEEDS_REVIEW,
      issue: reason,
      issueCode: !supplierCampaign.merchantNameRaw ? "MISSING_MERCHANT_IDENTIFIER" : null,
    };
  }

  if (!campaignSource?.id) {
    return {
      sourceStatus: SOURCE_STATUS.PROCESSED,
      mappingStatus: MAPPING_STATUS.NEEDS_REVIEW,
      issue: "Merchant linked but CampaignSource not created",
      issueCode: "CAMPAIGN_SOURCE_MISSING",
    };
  }

  return {
    sourceStatus: SOURCE_STATUS.PROCESSED,
    mappingStatus: MAPPING_STATUS.MAPPED,
    issue: null,
    issueCode: null,
  };
}

export function buildPipelineStages({
  entityType,
  supplierCampaign = null,
  campaignSource = null,
  merchant = null,
  openMapperError = null,
  statuses,
}) {
  const type = String(entityType || "").toLowerCase();
  const stages = [
    {
      key: "imported",
      label: "Imported",
      state: openMapperError ? PIPELINE_STAGE_STATE.BLOCKED : PIPELINE_STAGE_STATE.COMPLETED,
    },
  ];

  if (type === "performance") {
    stages.push(
      {
        key: "identified",
        label: "Identified",
        state: PIPELINE_STAGE_STATE.PENDING,
      },
      {
        key: "normalized",
        label: "Normalized",
        state: PIPELINE_STAGE_STATE.BLOCKED,
        detail: "Not promoted for this record type",
      },
      {
        key: "linked",
        label: "Linked",
        state: PIPELINE_STAGE_STATE.PENDING,
      },
      {
        key: "available",
        label: "Available",
        state: PIPELINE_STAGE_STATE.PENDING,
      },
    );
    return stages;
  }

  const brandState = merchant?.id
    ? PIPELINE_STAGE_STATE.COMPLETED
    : supplierCampaign?.merchantNameRaw
      ? PIPELINE_STAGE_STATE.NEEDS_REVIEW
      : supplierCampaign
        ? PIPELINE_STAGE_STATE.BLOCKED
        : PIPELINE_STAGE_STATE.PENDING;

  stages.push({
    key: "identified",
    label: "Brand identified",
    state: brandState,
    detail: merchant?.displayName || supplierCampaign?.merchantNameRaw || null,
  });

  const normalizedState = supplierCampaign?.id
    ? PIPELINE_STAGE_STATE.COMPLETED
    : openMapperError
      ? PIPELINE_STAGE_STATE.BLOCKED
      : PIPELINE_STAGE_STATE.NEEDS_REVIEW;

  stages.push({
    key: "normalized",
    label: "Normalized",
    state: normalizedState,
    detail: supplierCampaign?.id ? "SupplierCampaign created" : statuses?.issue || null,
  });

  const linkedState = campaignSource?.id
    ? PIPELINE_STAGE_STATE.COMPLETED
    : supplierCampaign?.merchantId
      ? PIPELINE_STAGE_STATE.NEEDS_REVIEW
      : PIPELINE_STAGE_STATE.PENDING;

  stages.push({
    key: "linked",
    label: "Campaign source",
    state: linkedState,
    detail: campaignSource?.id ? "CampaignSource created" : null,
  });

  stages.push({
    key: "available",
    label: "Available in Campaign Management",
    state: campaignSource?.id ? PIPELINE_STAGE_STATE.COMPLETED : PIPELINE_STAGE_STATE.PENDING,
  });

  return stages;
}
