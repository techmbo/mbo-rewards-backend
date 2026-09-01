function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function decimalToString(value) {
  return value?.toString?.() ?? value ?? null;
}

export function toClickDto(record) {
  if (!record) return null;
  const assignment = record.clientAssignment || null;
  const client = assignment?.client || null;
  const campaign = assignment?.canonicalCampaign || null;
  const merchant = campaign?.merchant || null;
  const trackingLink = record.trackingLink || null;
  const source = record.campaignSource || trackingLink?.campaignSource || null;
  const supplierCampaign = source?.supplierCampaign || null;

  const campaignName =
    campaign?.displayName ||
    supplierCampaign?.campaignName ||
    null;
  const brandName =
    merchant?.displayName ||
    supplierCampaign?.merchantNameRaw ||
    null;
  const trackingLabel =
    trackingLink?.slug ||
    (trackingLink?.mboTrackingUrl
      ? String(trackingLink.mboTrackingUrl).replace(/^https?:\/\//, "")
      : null);

  return {
    id: record.id,
    trackingLinkId: record.trackingLinkId,
    campaignSourceId: record.campaignSourceId,
    clientAssignmentId: record.clientAssignmentId,
    subId: record.subId,
    ipHash: record.ipHash,
    userAgentHash: record.userAgentHash,
    country: record.country,
    device: record.device,
    referrer: record.referrer,
    clickedAt: toIso(record.clickedAt),
    metadata: record.metadata ?? null,
    // Human-readable enrichment (existing relations only — never invent)
    clientName: client?.name || null,
    clientId: client?.id || assignment?.clientId || null,
    campaignName,
    brandName,
    supplier: supplierCampaign?.supplier || null,
    trackingLinkSlug: trackingLink?.slug || null,
    trackingLinkUrl: trackingLink?.mboTrackingUrl || null,
    trackingLinkLabel: trackingLabel,
  };
}

export function toConversionDto(record) {
  if (!record) return null;
  const meta = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
  return {
    id: record.id,
    clickId: record.clickId,
    orderId: record.orderId ?? null,
    supplier: record.supplier,
    networkSource: meta.networkSource ?? null,
    supplierConversionId: record.supplierConversionId,
    sourceAccountLabel: record.sourceAccountLabel,
    trackingLinkId: record.trackingLinkId,
    campaignSourceId: record.campaignSourceId,
    clientAssignmentId: record.clientAssignmentId,
    commissionRuleId: record.commissionRuleId,
    subId: record.subId,
    supplierCommission: decimalToString(record.supplierCommission),
    approvedCommission: decimalToString(record.approvedCommission),
    clientCommission: decimalToString(record.clientCommission),
    mboCommission: decimalToString(record.mboCommission),
    orderValue: meta.orderValue != null ? decimalToString(meta.orderValue) : null,
    currency: record.currency,
    status: record.status,
    attributionStatus: record.attributionStatus,
    conversionDate: toIso(record.conversionDate),
    approvedDate: toIso(record.approvedDate),
    couponCode: meta.couponCode ?? null,
    issueReason:
      meta.attributionRejection?.reason ??
      meta.commissionUnresolvedReason ??
      (record.attributionStatus === "ORPHAN" ? "unattributed" : null),
    // Do not expose full raw metadata / payloads to clients via this DTO shape.
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export function toDailyReportDto(record) {
  if (!record) return null;
  return {
    id: record.id,
    reportDate: toIso(record.reportDate)?.slice(0, 10),
    clientId: record.clientId,
    merchantId: record.merchantId,
    canonicalCampaignId: record.canonicalCampaignId,
    campaignSourceId: record.campaignSourceId,
    country: record.country,
    currency: record.currency,
    clickCount: record.clickCount,
    conversionCount: record.conversionCount,
    approvedConversionCount: record.approvedConversionCount,
    grossCommission: decimalToString(record.grossCommission),
    clientCommission: decimalToString(record.clientCommission),
    mboCommission: decimalToString(record.mboCommission),
    conversionRate: decimalToString(record.conversionRate),
    epc: decimalToString(record.epc),
    ctr: decimalToString(record.ctr),
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export function toAggregatedReportDto({ dimensionKey, dimensionId, totals, meta = {} }) {
  const clicks = totals.clickCount == null ? null : Number(totals.clickCount);
  const conversions = totals.conversionCount == null ? null : Number(totals.conversionCount);
  const gross =
    totals.grossCommission == null || totals.grossCommission === ""
      ? null
      : Number(totals.grossCommission);

  // CVR = conversions / clicks (ratio). Frontend formats as %. Never NaN/Infinity; never invent 0%.
  let conversionRate = null;
  if (clicks != null && clicks > 0 && conversions != null && Number.isFinite(conversions)) {
    conversionRate = Number((conversions / clicks).toFixed(6));
  }

  // EPC: prefer explicit; else grossCommission / linkClicks. Never use client commission.
  let epc = null;
  if (totals.epc != null && totals.epc !== "" && Number.isFinite(Number(totals.epc))) {
    epc = Number(Number(totals.epc).toFixed(4));
  } else if (clicks != null && clicks > 0 && gross != null && Number.isFinite(gross)) {
    epc = Number((gross / clicks).toFixed(4));
  }

  return {
    dimensionKey,
    dimensionId,
    campaignName: meta.campaignName ?? null,
    brandName: meta.brandName ?? null,
    clientName: meta.clientName ?? null,
    clientEmail: meta.clientEmail ?? null,
    clientSlug: meta.clientSlug ?? null,
    campaignSourceId: meta.campaignSourceId ?? null,
    canonicalCampaignId: meta.canonicalCampaignId ?? null,
    supplier: meta.supplier ?? null,
    currency: meta.currency ?? null,
    clickCount: clicks != null && Number.isFinite(clicks) ? clicks : null,
    networkClickCount:
      totals.networkClickCount == null || !Number.isFinite(Number(totals.networkClickCount))
        ? null
        : Number(totals.networkClickCount),
    conversionCount: conversions != null && Number.isFinite(conversions) ? conversions : null,
    approvedConversionCount:
      totals.approvedConversionCount == null
        ? null
        : Number(totals.approvedConversionCount),
    grossCommission: decimalToString(totals.grossCommission),
    confirmedCommission: decimalToString(totals.confirmedCommission),
    clientCommission: decimalToString(totals.clientCommission),
    mboCommission: decimalToString(totals.mboCommission),
    conversionRate,
    epc,
  };
}
