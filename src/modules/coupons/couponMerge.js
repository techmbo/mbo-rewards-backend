const COUPON_FIELD_KEYS = [
  "brandName",
  "campaignName",
  "categoryName",
  "couponCode",
  "couponLink",
  "codeType",
  "discountPercentage",
  "startDate",
  "expiryDate",
  "couponStatus",
  "campaignStatus",
  "networkSource",
];

export const CAMPAIGN_STATUS_ACTIVE = "Active";
export const CAMPAIGN_STATUS_PAUSED = "Paused";

export function normalizeCampaignStatus(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "paused" || normalized === "pause") return CAMPAIGN_STATUS_PAUSED;
  return CAMPAIGN_STATUS_ACTIVE;
}

export function isCampaignStatusAllottable(value) {
  return normalizeCampaignStatus(value) === CAMPAIGN_STATUS_ACTIVE;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function getCouponFieldKeys() {
  return [...COUPON_FIELD_KEYS];
}

function normalizeStoredCodeType(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (!normalized) return null;
  if (normalized === "both" || normalized.includes("both") || normalized === "code and link") return "both";
  if (/\blink\b/.test(normalized) && !/\bcode\b/.test(normalized) && !/\bcoupon\b/.test(normalized)) return "link";
  if (/\b(code|coupon|voucher)\b/.test(normalized) && !/\blink\b/.test(normalized)) return "code";
  if (/\blink\b/.test(normalized) && /\b(code|coupon)\b/.test(normalized)) return "both";
  if (normalized === "link") return "link";
  if (normalized === "code" || normalized === "coupon") return "code";
  return normalized;
}

export function extractCouponFieldsFromNormalized(normalizedData = {}) {
  const rawCode = normalizedData.code ?? null;
  const rawLink = normalizedData.link ?? null;
  const display = normalizedData.display_value ?? null;
  const codeType =
    normalizeStoredCodeType(normalizedData.code_type) ||
    (rawCode && rawLink && String(rawCode) !== String(rawLink)
      ? "both"
      : rawLink && !rawCode
        ? "link"
        : rawCode || display
          ? "code"
          : null);

  let couponCode = null;
  let couponLink = null;
  if (codeType === "link") {
    couponLink = rawLink || display || null;
  } else if (codeType === "both") {
    couponCode = rawCode || null;
    couponLink = rawLink || null;
  } else {
    couponCode = rawCode || display || null;
  }

  const custom = { ...asObject(normalizedData.custom) };
  delete custom.campaignStatus;

  return {
    brandName: normalizedData.brand_name ?? normalizedData.advertiser ?? null,
    campaignName: normalizedData.campaign_name ?? null,
    categoryName: normalizedData.category_name ?? null,
    couponCode,
    couponLink,
    codeType,
    discountPercentage: normalizedData.discount_percentage ?? normalizedData.discount ?? null,
    startDate: normalizedData.start_date ?? null,
    expiryDate: normalizedData.expiry ?? null,
    couponStatus: normalizedData.status ?? null,
    campaignStatus: normalizeCampaignStatus(
      normalizedData.campaign_status ?? normalizedData.custom?.campaignStatus ?? CAMPAIGN_STATUS_ACTIVE,
    ),
    networkSource: normalizedData.network_source ?? null,
    ...custom,
  };
}

export function buildNormalizedFromCouponFields(fields = {}, networkSource = "manual", fieldTypes = {}) {
  const custom = {};
  const known = new Set(COUPON_FIELD_KEYS);

  for (const [key, value] of Object.entries(fields)) {
    if (key === "couponTerms") continue;
    if (!known.has(key)) custom[key] = value;
  }

  const types = {};
  for (const [key, type] of Object.entries(asObject(fieldTypes))) {
    if (!known.has(key) && type) types[key] = String(type);
  }

  const codeType = normalizeStoredCodeType(fields.codeType) || "code";
  const couponCode = codeType === "link" ? null : fields.couponCode ?? null;
  const couponLink = codeType === "code" ? null : fields.couponLink ?? null;
  const discountPercentage = codeType === "link" ? null : fields.discountPercentage ?? null;
  const displayValue = couponCode || couponLink || null;
  const campaignStatus = normalizeCampaignStatus(fields.campaignStatus);

  return {
    brand_name: fields.brandName ?? null,
    advertiser: fields.brandName ?? null,
    campaign_name: fields.campaignName ?? null,
    category_name: fields.categoryName ?? null,
    code: couponCode,
    link: couponLink,
    display_value: displayValue,
    code_type: codeType,
    discount: discountPercentage,
    discount_percentage: discountPercentage,
    start_date: fields.startDate ?? null,
    expiry: fields.expiryDate ?? null,
    status: fields.couponStatus ?? null,
    campaign_status: campaignStatus,
    network_source: fields.networkSource ?? networkSource,
    custom: Object.keys(custom).length > 0 ? custom : undefined,
    field_types: Object.keys(types).length > 0 ? types : undefined,
  };
}

export function buildRawFromCouponFields(fields = {}, networkSource = "manual") {
  const known = new Set(COUPON_FIELD_KEYS);
  const extras = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "couponTerms") continue;
    if (!known.has(key)) extras[key] = value;
  }

  const codeType = normalizeStoredCodeType(fields.codeType) || "code";
  const couponCode = codeType === "link" ? null : fields.couponCode ?? null;
  const couponLink = codeType === "code" ? null : fields.couponLink ?? null;
  const discountPercentage = codeType === "link" ? null : fields.discountPercentage ?? null;
  const campaignStatus = normalizeCampaignStatus(fields.campaignStatus);

  return {
    companyName: fields.brandName ?? null,
    campaignName: fields.campaignName ?? null,
    campaign_name: fields.campaignName ?? null,
    categoryName: fields.categoryName ?? null,
    coupon: couponCode,
    code: couponCode,
    link: couponLink,
    type: codeType,
    discount: discountPercentage,
    discount_percentage: discountPercentage,
    activationDate: fields.startDate ?? null,
    start_date: fields.startDate ?? null,
    expiryDate: fields.expiryDate ?? null,
    expiry: fields.expiryDate ?? null,
    status: fields.couponStatus ?? null,
    campaign_status: campaignStatus,
    campaignStatus,
    network_source: networkSource,
    ...extras,
  };
}

function valuesDiffer(left, right) {
  const a = left === undefined || left === null || left === "" ? null : String(left);
  const b = right === undefined || right === null || right === "" ? null : String(right);
  return a !== b;
}

export function mergeCouponSyncData({
  existingEntity,
  syncedNormalized,
  syncedRaw,
}) {
  const manualData = asObject(existingEntity?.manualData);
  const fieldPolicies = asObject(existingEntity?.fieldPolicies);
  const syncedFields = extractCouponFieldsFromNormalized(syncedNormalized);

  const mergedFields = { ...syncedFields };
  let hasSyncConflict = false;

  for (const [fieldKey, manualValue] of Object.entries(manualData)) {
    const policy = fieldPolicies[fieldKey] || "manual";
    const syncedValue = syncedFields[fieldKey];

    if (policy === "manual") {
      mergedFields[fieldKey] = manualValue;
      if (valuesDiffer(manualValue, syncedValue)) {
        hasSyncConflict = true;
      }
    }
  }

  const mergedNormalized = buildNormalizedFromCouponFields(
    mergedFields,
    syncedNormalized?.network_source || existingEntity?.networkSource,
    asObject(existingEntity?.normalizedData?.field_types),
  );

  return {
    normalizedData: mergedNormalized,
    rawData: syncedRaw,
    lastSyncedData: syncedNormalized,
    hasSyncConflict,
    manualData,
    fieldPolicies,
  };
}

export function applyManualCouponFields(entity, fields = {}, fieldPolicies = {}, fieldTypes = {}) {
  const manualData = { ...fields };
  const policies = { ...fieldPolicies };
  const existingTypes = asObject(entity?.normalizedData?.field_types);
  const types = { ...existingTypes, ...asObject(fieldTypes) };

  for (const key of Object.keys(manualData)) {
    if (!policies[key]) policies[key] = "manual";
  }

  // Drop types for removed custom keys
  const known = new Set(COUPON_FIELD_KEYS);
  for (const key of Object.keys(types)) {
    if (known.has(key)) {
      delete types[key];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(manualData, key)) {
      delete types[key];
    }
  }

  const normalizedData = buildNormalizedFromCouponFields(
    manualData,
    entity?.networkSource || "manual",
    types,
  );
  const rawData = buildRawFromCouponFields(manualData, entity?.networkSource || "manual");

  return {
    manualData,
    fieldPolicies: policies,
    fieldTypes: types,
    normalizedData,
    rawData,
    hasSyncConflict: false,
    lastSyncedData: entity?.lastSyncedData ?? null,
  };
}

export function formatCouponEntityForClient(entity, { includeMeta = false } = {}) {
  if (!entity || entity.entityType !== "coupon") return entity;

  const manualData = asObject(entity.manualData);
  const fieldPolicies = asObject(entity.fieldPolicies);
  const syncedFields = extractCouponFieldsFromNormalized(
    entity.lastSyncedData || entity.normalizedData,
  );
  const currentFields = extractCouponFieldsFromNormalized(entity.normalizedData);

  const displayFields = { ...currentFields };
  for (const [key, value] of Object.entries(manualData)) {
    if ((fieldPolicies[key] || "manual") === "manual") {
      displayFields[key] = value;
    }
  }
  displayFields.campaignStatus = normalizeCampaignStatus(
    displayFields.campaignStatus ?? manualData.campaignStatus ?? CAMPAIGN_STATUS_ACTIVE,
  );

  const displayNormalized = buildNormalizedFromCouponFields(
    displayFields,
    entity.networkSource,
  );

  const formatted = {
    ...entity,
    normalizedData: displayNormalized,
    eventDate: entity.eventDate,
  };

  if (includeMeta) {
    formatted.cmsMeta = {
      isManual: entity.isManual,
      manualData,
      fieldPolicies,
      fieldTypes: asObject(entity.normalizedData?.field_types),
      lastSyncedData: entity.lastSyncedData,
      hasSyncConflict: entity.hasSyncConflict,
      syncedFields,
      displayFields,
    };
  }

  return formatted;
}
