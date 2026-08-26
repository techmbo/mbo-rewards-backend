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
