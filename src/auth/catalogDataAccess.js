import { PERMISSIONS } from "./permissions.js";
import { toCampaignSourceDto, toCanonicalCampaignDto, toCatalogDetailDto } from "../modules/catalog/dto/catalog.dto.js";

function hasCommissionRead(permissions = []) {
  return permissions.includes(PERMISSIONS.COMMISSION_READ);
}

function maskSourceCommission(source, permissions) {
  const dto = toCampaignSourceDto(source);
  if (!dto) return dto;
  if (!hasCommissionRead(permissions)) {
    dto.grossCommission = undefined;
  }
  return dto;
}

export function applyCatalogSourceAccess(source, permissions = []) {
  return maskSourceCommission(source, permissions);
}

export function applyCatalogDetailAccess(record, selection, permissions = []) {
  const detail = toCatalogDetailDto(record, {
    primary: selection?.primary,
    secondary: selection?.secondary ?? [],
    inactive: selection?.inactive ?? [],
    recommendation: selection?.recommendation ?? null,
  });

  if (!detail) return null;

  if (!hasCommissionRead(permissions)) {
    detail.sources = detail.sources.map((source) => {
      const masked = { ...source };
      masked.grossCommission = undefined;
      return masked;
    });
    if (detail.routing?.primary) detail.routing.primary.grossCommission = undefined;
    detail.routing.secondary = detail.routing.secondary.map((s) => ({ ...s, grossCommission: undefined }));
    detail.routing.inactive = detail.routing.inactive.map((s) => ({ ...s, grossCommission: undefined }));
  }

  return detail;
}

export function applyCatalogSummaryAccess(record) {
  return toCanonicalCampaignDto(record);
}
