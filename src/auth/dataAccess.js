import { PERMISSIONS } from "./permissions.js";

const COMMISSION_METRIC_PATTERN = /commission|payout|revenue|order value|vat/i;

const COMMISSION_FIELD_PATTERN =
  /commission|payout|revenue|net_revenue|validatedCommission|netPayout|vatPayout/i;

export function canViewCommission(permissions) {
  return permissions.includes(PERMISSIONS.COMMISSION_READ);
}

export function canViewPayments(permissions) {
  return permissions.includes(PERMISSIONS.PAYMENTS_READ);
}

export function filterSummaryMetrics(metrics, permissions) {
  const showCommission = canViewCommission(permissions);
  const showPayments = canViewPayments(permissions);

  return (metrics || []).filter((metric) => {
    const label = String(metric?.label || "");
    if (!showCommission && COMMISSION_METRIC_PATTERN.test(label)) {
      return false;
    }
    if (!showPayments && /payment|payout/i.test(label)) {
      return false;
    }
    return true;
  });
}

function stripSensitiveFromObject(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripSensitiveFromObject(item, depth + 1));
  }

  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (COMMISSION_FIELD_PATTERN.test(key)) {
      continue;
    }
    next[key] = stripSensitiveFromObject(child, depth + 1);
  }
  return next;
}

export function sanitizeEntityRow(row, permissions) {
  if (!row || canViewCommission(permissions)) {
    return row;
  }

  const sanitized = { ...row };
  if ("commission" in sanitized) {
    delete sanitized.commission;
  }
  if ("revenue" in sanitized) {
    delete sanitized.revenue;
  }
  if (sanitized.normalizedData) {
    sanitized.normalizedData = stripSensitiveFromObject(sanitized.normalizedData);
  }
  if (sanitized.rawData) {
    sanitized.rawData = stripSensitiveFromObject(sanitized.rawData);
  }
  if (sanitized.lastSyncedData) {
    sanitized.lastSyncedData = stripSensitiveFromObject(sanitized.lastSyncedData);
  }
  if (sanitized.manualData) {
    sanitized.manualData = stripSensitiveFromObject(sanitized.manualData);
  }
  return sanitized;
}

export function sanitizeEntityRows(rows, permissions) {
  return (rows || []).map((row) => sanitizeEntityRow(row, permissions));
}
