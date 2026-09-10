import { deriveMboCommission } from "../commercial/commissionMath.js";

export function isPayableConversionStatus(status) {
  const value = String(status || "").toUpperCase();
  return value === "APPROVED" || value === "PAID";
}

export function isRejectedConversionStatus(status) {
  return String(status || "").toUpperCase() === "REJECTED";
}

export function grossCommissionForConversion(conversion) {
  if (isRejectedConversionStatus(conversion.status)) {
    return 0;
  }
  if (isPayableConversionStatus(conversion.status)) {
    return conversion.approvedCommission ?? conversion.supplierCommission;
  }
  return conversion.supplierCommission;
}

/**
 * Ratio-based split (Wave A). FIXED/TIERED remain unimplemented.
 * Never fabricates client commission when rule is invalid.
 *
 * @returns {{ ok: true, clientCommission: string, mboCommission: string } | { ok: false, reason: string, clientCommission: null, mboCommission: null }}
 */
export function applyCommissionRuleToGross(grossAmount, rule) {
  if (!rule) {
    return {
      ok: false,
      reason: "missing_rule",
      clientCommission: null,
      mboCommission: null,
    };
  }

  const gross = Number(grossAmount);
  const ruleGross = Number(rule.grossCommission);
  const ruleClient = Number(rule.clientCommission);

  if (!Number.isFinite(gross)) {
    return {
      ok: false,
      reason: "invalid_gross",
      clientCommission: null,
      mboCommission: null,
    };
  }

  if (gross < 0) {
    return {
      ok: false,
      reason: "negative_gross",
      clientCommission: null,
      mboCommission: null,
    };
  }

  if (gross === 0) {
    return { ok: true, clientCommission: "0.0000", mboCommission: "0.0000" };
  }

  if (!Number.isFinite(ruleGross) || ruleGross <= 0) {
    return {
      ok: false,
      reason: "invalid_rule_gross",
      clientCommission: null,
      mboCommission: null,
    };
  }

  if (!Number.isFinite(ruleClient) || ruleClient < 0) {
    return {
      ok: false,
      reason: "invalid_rule_client",
      clientCommission: null,
      mboCommission: null,
    };
  }

  if (ruleClient > ruleGross) {
    return {
      ok: false,
      reason: "rule_client_exceeds_rule_gross",
      clientCommission: null,
      mboCommission: null,
    };
  }

  const ratio = ruleClient / ruleGross;
  const clientCommissionNum = gross * ratio;
  if (clientCommissionNum < 0) {
    return {
      ok: false,
      reason: "negative_client_commission",
      clientCommission: null,
      mboCommission: null,
    };
  }
  if (clientCommissionNum - gross > 1e-9) {
    return {
      ok: false,
      reason: "client_exceeds_supplier",
      clientCommission: null,
      mboCommission: null,
    };
  }

  const clientCommission = clientCommissionNum.toFixed(4);
  const mboCommission = deriveMboCommission(gross, clientCommission);
  return { ok: true, clientCommission, mboCommission };
}

export function computeConversionRate(conversions, clicks) {
  if (!clicks) return null;
  return Number((conversions / clicks).toFixed(6));
}

export function computeEpc(commission, clicks) {
  if (!clicks) return null;
  return Number((Number(commission) / clicks).toFixed(4));
}

export function toReportDate(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function dayBounds(reportDate) {
  const start = toReportDate(reportDate);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
  return { start, end };
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function invalidReportDate(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "invalid_report_date_range";
  return error;
}

/**
 * Canonical parser for a report date boundary supplied by a caller.
 *
 * Accepts, and only accepts:
 *   - a valid Date instance,
 *   - a date-only "YYYY-MM-DD" string, read as that UTC calendar day,
 *   - an ISO-8601 datetime string with an explicit offset or Z.
 * Anything else (invalid Date, impossible calendar date, locale or slash
 * formats, numbers, empty) throws a 400 instead of being silently coerced —
 * a wrong boundary here would delete the wrong DailyReport rows.
 *
 * @returns {Date} the instant the input denotes (not yet day-normalized)
 */
export function parseReportDateInput(value, label = "date") {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalidReportDate(`${label} is an invalid Date.`);
    return new Date(value.getTime());
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidReportDate(`${label} must be a Date, a YYYY-MM-DD string or an ISO-8601 datetime string.`);
  }
  const text = value.trim();
  const dateOnly = DATE_ONLY_PATTERN.exec(text);
  if (dateOnly) {
    const [, year, month, day] = dateOnly.map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    // Date.UTC silently rolls impossible dates (2026-02-30 → March 2); reject those.
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      throw invalidReportDate(`${label} "${text}" is not a valid calendar date.`);
    }
    return parsed;
  }
  if (ISO_DATETIME_PATTERN.test(text)) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) throw invalidReportDate(`${label} "${text}" is not a valid ISO-8601 datetime.`);
    return parsed;
  }
  throw invalidReportDate(`${label} "${text}" must be YYYY-MM-DD or an ISO-8601 datetime with an offset.`);
}

/**
 * Normalize a rebuild range to inclusive UTC calendar days: both ends become the
 * UTC midnight of the day they fall in (the DailyReport.reportDate grain), so a
 * delete filter and a day-by-day rebuild loop cover exactly the same rows.
 *
 * Missing or invalid input throws a 400. Inversion is checked on the ACTUAL
 * parsed instants, before day normalization: "2026-09-10T20:00Z" → "2026-09-10T01:00Z"
 * is a genuinely inverted range and is rejected even though both fall on the
 * same report day. All of this happens before any repository call can run.
 */
export function normalizeReportDateRange({ from, to } = {}) {
  if (from === undefined || from === null || to === undefined || to === null) {
    throw invalidReportDate("from and to are required for rebuild.");
  }
  const parsedFrom = parseReportDateInput(from, "from");
  const parsedTo = parseReportDateInput(to, "to");
  if (parsedFrom.getTime() > parsedTo.getTime()) {
    throw invalidReportDate(`from (${parsedFrom.toISOString()}) must not be after to (${parsedTo.toISOString()}).`);
  }
  const fromDay = toReportDate(parsedFrom);
  const toDay = toReportDate(parsedTo);
  return { from: fromDay, to: toDay };
}
