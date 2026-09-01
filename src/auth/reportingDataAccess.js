import { PERMISSIONS } from "./permissions.js";
import { toConversionDto, toDailyReportDto } from "../modules/reporting/dto/reporting.dto.js";

function hasCommissionRead(permissions = []) {
  return permissions.includes(PERMISSIONS.COMMISSION_READ) || permissions.includes(PERMISSIONS.COMMISSION_MANAGE);
}

export function applyConversionAccess(record, permissions = []) {
  const dto = toConversionDto(record);
  if (!dto) return dto;
  if (!hasCommissionRead(permissions)) {
    dto.supplierCommission = undefined;
    dto.approvedCommission = undefined;
    dto.clientCommission = undefined;
    dto.mboCommission = undefined;
  }
  return dto;
}

export function applyDailyReportAccess(record, permissions = []) {
  const dto = record.dimensionKey ? record : toDailyReportDto(record);
  if (!dto) return dto;
  if (!hasCommissionRead(permissions)) {
    dto.grossCommission = undefined;
    dto.clientCommission = undefined;
    dto.mboCommission = undefined;
    dto.epc = undefined;
  }
  return dto;
}
