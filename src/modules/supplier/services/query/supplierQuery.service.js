import { applySupplierAccess } from "../../../../auth/supplierDataAccess.js";
import { toSupplierDto } from "../../dto/supplier.dto.js";
import { SupplierRepository } from "../../repositories/supplier.repository.js";

export class SupplierQueryService {
  constructor(deps = {}) {
    this.supplierRepo = deps.supplierRepo ?? new SupplierRepository();
  }

  async list({ status } = {}, permissions = []) {
    const rows = await this.supplierRepo.findAll({ status });
    return rows.map((row) => applySupplierAccess(toSupplierDto(row), permissions));
  }
}
