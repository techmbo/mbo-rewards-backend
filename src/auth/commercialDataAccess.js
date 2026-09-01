import { PERMISSIONS } from "./permissions.js";
import {
  toCommissionRuleDto,
  toCouponAssignmentDto,
  toTrackingLinkDto,
} from "../modules/commercial/dto/commercial.dto.js";

function hasCommissionRead(permissions = []) {
  return permissions.includes(PERMISSIONS.COMMISSION_READ) || permissions.includes(PERMISSIONS.COMMISSION_MANAGE);
}

export function applyCommissionRuleAccess(record, permissions = []) {
  const dto = toCommissionRuleDto(record);
  if (!dto) return dto;
  if (!hasCommissionRead(permissions)) {
    dto.grossCommission = undefined;
    dto.clientCommission = undefined;
    dto.mboCommission = undefined;
  }
  return dto;
}

export function applyTrackingLinkAccess(record) {
  return toTrackingLinkDto(record);
}

export function applyCouponAssignmentAccess(record) {
  return toCouponAssignmentDto(record);
}
