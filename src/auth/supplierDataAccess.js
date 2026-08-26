import { PERMISSIONS } from "./permissions.js";
import { canViewCommission } from "./dataAccess.js";

export function canViewSupplierPayloads(permissions) {
  return permissions.includes(PERMISSIONS.SYSTEM_READ);
}

export function canViewInternalDiagnostics(permissions) {
  return permissions.includes(PERMISSIONS.SYSTEM_READ);
}

export function canViewEntityLineage(permissions) {
  return permissions.includes(PERMISSIONS.INTEGRATIONS_READ) || permissions.includes(PERMISSIONS.SYSTEM_READ);
}

const COMMISSION_FIELDS = [
  "defaultCommissionValue",
  "commissionUnit",
  "commissionCurrency",
  "commissionGroups",
  "pricingModel",
];

const INTERNAL_CAMPAIGN_FIELDS = [
  "entityId",
  "supplierRefId",
  "rawPayload",
  "normalizedPayload",
  "fieldPolicies",
  "adminOverrides",
  "mapperVersion",
];

const INTERNAL_COUPON_FIELDS = ["entityId", "rawPayload", "normalizedPayload", "mapperVersion"];

const INTERNAL_SUPPLIER_FIELDS = ["config"];

const INTERNAL_MAPPER_ERROR_FIELDS = ["stackTrace"];

export function applySupplierCampaignAccess(dto, permissions, { includePayloads = false } = {}) {
  if (!dto) return dto;

  const next = { ...dto };
  const showCommission = canViewCommission(permissions);
  const showPayloads = includePayloads && canViewSupplierPayloads(permissions);
  const showLineage = canViewEntityLineage(permissions);

  if (!showCommission) {
    for (const field of COMMISSION_FIELDS) {
      delete next[field];
    }
  }

  if (!showPayloads) {
    for (const field of ["rawPayload", "normalizedPayload"]) {
      delete next[field];
    }
  }

  if (!showLineage) {
    for (const field of INTERNAL_CAMPAIGN_FIELDS) {
      if (field === "rawPayload" || field === "normalizedPayload") continue;
      delete next[field];
    }
  } else if (!showPayloads) {
    for (const field of ["rawPayload", "normalizedPayload", "adminOverrides", "fieldPolicies"]) {
      delete next[field];
    }
  }

  return next;
}

export function applySupplierCouponAccess(dto, permissions, { includePayloads = false } = {}) {
  if (!dto) return dto;

  const next = { ...dto };
  const showPayloads = includePayloads && canViewSupplierPayloads(permissions);
  const showLineage = canViewEntityLineage(permissions);

  if (!showPayloads) {
    delete next.rawPayload;
    delete next.normalizedPayload;
  }

  if (!showLineage) {
    for (const field of INTERNAL_COUPON_FIELDS) {
      if (field === "rawPayload" || field === "normalizedPayload") continue;
      delete next[field];
    }
  }

  if (next.supplierCampaign) {
    next.supplierCampaign = applySupplierCampaignSummaryAccess(next.supplierCampaign, permissions);
  }

  return next;
}

export function applySupplierCampaignSummaryAccess(dto, permissions) {
  if (!dto) return dto;
  const next = { ...dto };
  const showCommission = canViewCommission(permissions);

  if (!showCommission) {
    for (const field of COMMISSION_FIELDS) {
      delete next[field];
    }
  }

  for (const field of [
    ...INTERNAL_CAMPAIGN_FIELDS,
    "rawPayload",
    "normalizedPayload",
    "fieldPolicies",
    "adminOverrides",
  ]) {
    delete next[field];
  }

  return next;
}

export function applySupplierAccess(dto, permissions) {
  if (!dto) return dto;
  const next = { ...dto };

  if (!canViewInternalDiagnostics(permissions)) {
    for (const field of INTERNAL_SUPPLIER_FIELDS) {
      delete next[field];
    }
  }

  return next;
}

export function applyMapperErrorAccess(dto, permissions) {
  if (!dto) return dto;
  const next = { ...dto };

  if (!canViewInternalDiagnostics(permissions)) {
    for (const field of INTERNAL_MAPPER_ERROR_FIELDS) {
      delete next[field];
    }
  }

  if (!canViewEntityLineage(permissions)) {
    delete next.entity;
  }

  return next;
}
