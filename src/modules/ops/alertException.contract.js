/**
 * Pointer 21 — Alert / exception contract.
 * Maps operational conditions → type, severity, required action.
 */

import { CLIENT_PAYABLE_BLOCKING_PAIRS, RECONCILIATION_PAIR } from "../finance/reconciliationLogic.contract.js";

export const ALERT_CONDITION = Object.freeze({
  AUTHENTICATION_FAILURE: "AUTHENTICATION_FAILURE",
  RATE_LIMIT_EXHAUSTION: "RATE_LIMIT_EXHAUSTION",
  REQUIRED_MAPPING_MISSING: "REQUIRED_MAPPING_MISSING",
  UNKNOWN_SOURCE_STATUS: "UNKNOWN_SOURCE_STATUS",
  CAMPAIGN_BRAND_MAPPING_MISSING: "CAMPAIGN_BRAND_MAPPING_MISSING",
  ATTRIBUTION_AMBIGUOUS: "ATTRIBUTION_AMBIGUOUS",
  ATTRIBUTION_UNRESOLVED_ORPHAN: "ATTRIBUTION_UNRESOLVED_ORPHAN",
  DUPLICATE_PAYMENT_IMPORT: "DUPLICATE_PAYMENT_IMPORT",
  NETWORK_PAYMENT_MISMATCH: "NETWORK_PAYMENT_MISMATCH",
  CLIENT_PAYABLE_MISMATCH: "CLIENT_PAYABLE_MISMATCH",
});

export const ALERT_ACTION = Object.freeze({
  PAUSE_ACCOUNT_SYNC: "PAUSE_ACCOUNT_SYNC",
  THROTTLE_AND_PRESERVE_CHECKPOINT: "THROTTLE_AND_PRESERVE_CHECKPOINT",
  BLOCK_CLIENT_PAYABLE_RELEASE: "BLOCK_CLIENT_PAYABLE_RELEASE",
  BLOCK_DUPLICATE_POSTING: "BLOCK_DUPLICATE_POSTING",
  QUARANTINE_STATUS_UPDATE: "QUARANTINE_STATUS_UPDATE",
  OPS_REVIEW: "OPS_REVIEW",
  FINANCE_RECON_QUEUE: "FINANCE_RECON_QUEUE",
});

export const ALERT_SEVERITY = Object.freeze({
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
});

const BASE_SPECS = Object.freeze({
  [ALERT_CONDITION.AUTHENTICATION_FAILURE]: {
    type: "NETWORK_AUTH_FAILURE",
    severity: ALERT_SEVERITY.CRITICAL,
    requiredAction: ALERT_ACTION.PAUSE_ACCOUNT_SYNC,
  },
  [ALERT_CONDITION.RATE_LIMIT_EXHAUSTION]: {
    type: "NETWORK_ORDER_SYNC_FAILURE",
    severity: ALERT_SEVERITY.HIGH,
    requiredAction: ALERT_ACTION.THROTTLE_AND_PRESERVE_CHECKPOINT,
  },
  [ALERT_CONDITION.REQUIRED_MAPPING_MISSING]: {
    type: "MAPPING_REQUIRED_FIELD_MISSING",
    severity: ALERT_SEVERITY.HIGH,
    requiredAction: ALERT_ACTION.OPS_REVIEW,
  },
  [ALERT_CONDITION.UNKNOWN_SOURCE_STATUS]: {
    type: "MAPPING_UNKNOWN_ENUM",
    severity: ALERT_SEVERITY.HIGH,
    requiredAction: ALERT_ACTION.QUARANTINE_STATUS_UPDATE,
  },
  [ALERT_CONDITION.CAMPAIGN_BRAND_MAPPING_MISSING]: {
    type: "NETWORK_CAMPAIGN_SYNC_FAILURE",
    severity: ALERT_SEVERITY.MEDIUM,
    requiredAction: ALERT_ACTION.OPS_REVIEW,
  },
  [ALERT_CONDITION.ATTRIBUTION_AMBIGUOUS]: {
    type: "ATTRIBUTION_UNRESOLVED",
    severity: ALERT_SEVERITY.MEDIUM,
    requiredAction: ALERT_ACTION.OPS_REVIEW,
  },
  [ALERT_CONDITION.ATTRIBUTION_UNRESOLVED_ORPHAN]: {
    type: "ATTRIBUTION_UNRESOLVED",
    severity: ALERT_SEVERITY.HIGH,
    requiredAction: ALERT_ACTION.OPS_REVIEW,
  },
  [ALERT_CONDITION.DUPLICATE_PAYMENT_IMPORT]: {
    type: "DUPLICATE_FINANCIAL_RECOGNITION",
    severity: ALERT_SEVERITY.HIGH,
    requiredAction: ALERT_ACTION.BLOCK_DUPLICATE_POSTING,
  },
  [ALERT_CONDITION.NETWORK_PAYMENT_MISMATCH]: {
    type: "FINANCIAL_RECONCILIATION_MISMATCH",
    severity: ALERT_SEVERITY.HIGH,
    requiredAction: ALERT_ACTION.FINANCE_RECON_QUEUE,
  },
  [ALERT_CONDITION.CLIENT_PAYABLE_MISMATCH]: {
    type: "FINANCIAL_RECONCILIATION_MISMATCH",
    severity: ALERT_SEVERITY.CRITICAL,
    requiredAction: ALERT_ACTION.BLOCK_CLIENT_PAYABLE_RELEASE,
  },
});

export function resolveAlertSpec({ condition = null, reconciliationPair = null } = {}) {
  if (condition && BASE_SPECS[condition]) {
    return { ...BASE_SPECS[condition], condition };
  }
  if (reconciliationPair) {
    if (CLIENT_PAYABLE_BLOCKING_PAIRS.has(reconciliationPair)) {
      if (reconciliationPair === RECONCILIATION_PAIR.MBO_RECEIPT_VS_CLIENT_PAYABLE) {
        return resolveAlertSpec({ condition: ALERT_CONDITION.CLIENT_PAYABLE_MISMATCH });
      }
      if (
        reconciliationPair === RECONCILIATION_PAIR.NETWORK_PAYMENT_VS_MBO_RECEIPT ||
        reconciliationPair === RECONCILIATION_PAIR.NETWORK_INVOICE_VS_NETWORK_PAYMENT
      ) {
        return resolveAlertSpec({ condition: ALERT_CONDITION.NETWORK_PAYMENT_MISMATCH });
      }
    }
    return resolveAlertSpec({ condition: ALERT_CONDITION.NETWORK_PAYMENT_MISMATCH });
  }
  return null;
}

export function applyAlertContract(input = {}) {
  const spec = resolveAlertSpec({
    condition: input.condition ?? input.metadata?.alertCondition ?? null,
    reconciliationPair: input.reconciliationPair ?? input.metadata?.reconciliationPair ?? null,
  });
  if (!spec) return input;

  return {
    ...input,
    type: input.type ?? spec.type,
    severity: input.severity ?? spec.severity,
    metadata: {
      ...(input.metadata || {}),
      alertCondition: spec.condition,
      requiredAction: spec.requiredAction,
      contractPointer: 21,
    },
  };
}

export function isAuthenticationSyncError(error) {
  const status = error?.response?.status;
  if (status === 401) return true;
  if (status === 403) {
    const body = JSON.stringify(error?.response?.data || "").toUpperCase();
    return /INVALID.*API.*KEY|UNAUTHORIZED|AUTHENTICATION|ACCESS_DENIED|CANNOT_ACCESS/i.test(body);
  }
  const message = String(error?.message || "").toUpperCase();
  return /UNAUTHORIZED|INVALID.*API.*KEY|AUTHENTICATION FAILED/i.test(message);
}

export function isRateLimitExhaustion(error, { minAttempts = 2 } = {}) {
  const status = error?.response?.status;
  const attempts = Number(error?.syncAttemptCount || 0);
  if (status === 429 && attempts >= minAttempts) return true;
  if (error?.rateLimitTelemetry && attempts >= minAttempts) return true;
  return false;
}

export function mapMappingErrorToCondition(errorCode) {
  const code = String(errorCode || "").toUpperCase();
  if (code === "MAPPING_REQUIRED_FIELD_MISSING" || code === "MAPPING_UNMAPPED_CRITICAL_FIELD") {
    return ALERT_CONDITION.REQUIRED_MAPPING_MISSING;
  }
  if (code === "MAPPING_UNKNOWN_ENUM") return ALERT_CONDITION.UNKNOWN_SOURCE_STATUS;
  return null;
}

export function toExceptionDto(row) {
  if (!row) return null;
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    ...row,
    requiredAction: meta.requiredAction ?? null,
    alertCondition: meta.alertCondition ?? null,
  };
}
