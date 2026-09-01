export function isBoostinyPaymentRow(row) {
  if (!row || typeof row !== "object") return false;
  if (row.report_type === "summary") return true;
  if (row.period_from && row.period_to && !row.campaign_id && !row.campaign_name) return true;
  return false;
}

export function isBoostinyConversionRow(row) {
  if (!row || typeof row !== "object") return false;
  if (isBoostinyPaymentRow(row)) return false;
  if (row.report_type === "link_performance") return true;
  return Boolean(
    row.campaign_id ||
      row.campaign_name ||
      row.campaign?.name ||
      row.date ||
      row.period_from,
  );
}

/**
 * § Boostiny performance: order_id present → may be order-level provisional;
 * order_id absent → aggregate only (never invent an individual order id).
 */
export function boostinyPerformanceGranularity(row) {
  const orderId = row?.order_id ?? row?.orderId ?? row?.OrderId ?? null;
  if (orderId != null && String(orderId).trim() !== "") {
    return { granularity: "ORDER_LEVEL", orderId: String(orderId).trim(), inventOrderId: false };
  }
  return { granularity: "AGGREGATE", orderId: null, inventOrderId: false };
}

export function enrichBoostinyPerformanceRows(rows, campaigns = []) {
  const nameById = new Map();
  for (const campaign of campaigns) {
    if (campaign?.id === undefined || campaign?.id === null) continue;
    nameById.set(String(campaign.id), campaign?.name ?? null);
  }

  return rows.map((row) => {
    const campaignId = row?.campaign_id ?? row?.campaign?.id;
    const campaignName =
      row?.campaign_name ??
      row?.campaign?.name ??
      (campaignId != null ? nameById.get(String(campaignId)) : null);

    if (!campaignName && campaignId == null) return row;

    return {
      ...row,
      campaign_id: campaignId ?? row?.campaign_id,
      campaign_name: campaignName ?? row?.campaign_name,
    };
  });
}

export function splitBoostinyPerformancePayload(performanceRows, performanceSummaries, campaigns = []) {
  const enrichedRows = enrichBoostinyPerformanceRows(performanceRows, campaigns);
  const conversions = enrichedRows.filter(isBoostinyConversionRow);
  const payments = [
    ...asArray(performanceSummaries).filter((row) => isBoostinyPaymentRow(row)),
    ...enrichedRows.filter(isBoostinyPaymentRow),
  ];

  return { conversions, payments };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
