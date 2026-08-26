/**
 * Wave D + Epic 2 — finance-facing commission calculation.
 * Delegates to CommercialRuleEngine (single authoritative engine).
 * NEVER uses CampaignSource.grossCommission as financial truth.
 */

import {
  calculateCommercial,
  resolveActualSupplierCommission,
} from "../commercial/commercialRuleEngine.js";
import { grossCommissionForConversion } from "../reporting/attributionMath.js";

/**
 * @returns same shape as CommercialRuleEngine.calculateCommercial
 */
export function calculateCommission(args) {
  return calculateCommercial(args);
}

/** Net position helper across earn + adjustments (same currency). */
export function netFinancialPosition(transactions = []) {
  let supplier = 0;
  let client = 0;
  let margin = 0;
  for (const row of transactions) {
    supplier += Number(row.supplierReceivable || 0);
    client += Number(row.clientPayable || 0);
    margin += Number(row.mboMargin || 0);
  }
  return {
    supplierReceivable: supplier.toFixed(4),
    clientPayable: client.toFixed(4),
    mboMargin: margin.toFixed(4),
    reconciles: Math.abs(supplier - client - margin) <= 0.00015,
  };
}

export { grossCommissionForConversion, resolveActualSupplierCommission, calculateCommercial };
