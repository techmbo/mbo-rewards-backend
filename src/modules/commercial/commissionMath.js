export function deriveMboCommission(grossCommission, clientCommission) {
  const gross = Number(grossCommission);
  const client = Number(clientCommission);
  if (Number.isNaN(gross) || Number.isNaN(client)) {
    throw new Error("Invalid commission values.");
  }
  return (gross - client).toFixed(4);
}

/**
 * Canonical client-share ratio of a ClientCommissionRule pair (e.g. gross=100, client=70 → 0.7).
 * Callers validate the pair first; this only expresses the arithmetic.
 */
export function clientShareRatio(ruleGross, ruleClient) {
  return Number(ruleClient) / Number(ruleGross);
}

/**
 * Canonical client amount for a ratio rule: amount × (ruleClient ÷ ruleGross), unrounded.
 *
 * Attribution (reporting/attributionMath.js) and the commercial engine
 * (commercial/clientCommercialCalculation.js) MUST both derive the client amount through this one
 * expression. Any algebraically equal variant such as amount × ((client ÷ gross) × 100) ÷ 100
 * carries a different floating-point error term and rounds the other way at exact 4dp half
 * boundaries (e.g. 1.5 × 33.33%: 0.49995 → 0.5000 vs 0.4999), which would make a conversion's
 * stored split disagree with its financial transaction by 0.0001.
 */
export function applyClientShareRatio(amount, ruleGross, ruleClient) {
  return Number(amount) * clientShareRatio(ruleGross, ruleClient);
}

export function periodsOverlap(startA, endA, startB, endB) {
  const aStart = new Date(startA).getTime();
  const aEnd = endA ? new Date(endA).getTime() : Number.POSITIVE_INFINITY;
  const bStart = new Date(startB).getTime();
  const bEnd = endB ? new Date(endB).getTime() : Number.POSITIVE_INFINITY;
  return aStart <= bEnd && bStart <= aEnd;
}
